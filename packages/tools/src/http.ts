// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type ToolSpecSynthesizerOptions, registerToolSpecSynthesizer } from './spec-registry.js';
import type { HttpAuthSpec, HttpRequestBodySpec, HttpToolSpec, ToolContext } from './types.js';

/**
 * First-party synthesizer for `HttpToolSpec` (kind: 'http').
 *
 * `defineTool({spec: {kind: 'http', ...}})` produces a runtime
 * `Tool` whose handler is auto-generated to perform the outbound
 * HTTP call. The registered tool dispatches, validates, and travels
 * identically to a hand-written in-process tool — kernel, invoke
 * pipeline, and MCP discovery treat it as a normal `Tool`. The
 * declarative `spec` field on the manifest is preserved for
 * middleware and for JSON export / cross-process registration.
 *
 * Behavior at invoke time:
 *
 *   1. Input JSON-Schema validation runs (via the standard invoke
 *      pipeline); handler receives a validated input.
 *   2. `urlTemplate` placeholders are substituted from input keys.
 *      Missing key → throw. Substituted keys are still available in
 *      the request body (unless `requestBody.kind === 'input-passthrough'`
 *      with different semantics documented below).
 *   3. `authorization` is resolved via `ctx.resolveSecret(secretRef)`.
 *      If the tool declares authorization but `ctx.resolveSecret` is
 *      undefined, the handler throws a clear error rather than
 *      silently dropping the credential.
 *   4. Static headers are added as-is.
 *   5. Request body is built per `requestBody.kind`:
 *        - `'json-input'` (default when `requestBody` absent for
 *          POST/PUT/PATCH): JSON-serialize the tool's input MINUS
 *          keys already consumed by `urlTemplate`.
 *        - `'input-passthrough'`: JSON-serialize the entire input
 *          without removing URL-consumed keys.
 *        - `'text'`: substitute `{param}` placeholders in `template`
 *          from input; send as `Content-Type: text/plain`.
 *   6. `fetch()` with an AbortController that inherits from
 *      `ctx.abortSignal` and adds a `timeoutMs` deadline (default
 *      30_000). Aborts propagate as `handler-error`.
 *   7. Status is checked against `successStatus` (default 200-299).
 *      Failures throw with the response body as the message.
 *   8. Response body is parsed as JSON (default) or returned as
 *      text. Output JSON-Schema validation runs in the invoke
 *      pipeline; handler doesn't validate.
 */
function buildHttpHandler(
  spec: HttpToolSpec,
  toolId: string,
  options: ToolSpecSynthesizerOptions = {},
): (input: unknown, ctx: ToolContext) => Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  return async (input, ctx) => {
    const inputObj = coerceInputToObject(input, toolId);
    const { url, consumedKeys } = substituteUrl(spec.urlTemplate, inputObj, toolId);

    const headers: Record<string, string> = {};
    for (const h of spec.headers ?? []) {
      headers[h.name] = substituteTemplate(h.value, inputObj);
    }

    if (spec.authorization !== undefined) {
      applyAuth(
        headers,
        spec.authorization,
        ctx,
        toolId,
        await resolveAuthSecret(spec.authorization, ctx, toolId),
      );
    }

    const { body, contentType } = buildBody(spec, inputObj, consumedKeys);
    if (body !== undefined && contentType !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = contentType;
    }

    const timeoutMs = spec.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(new Error(`http-tool "${toolId}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    // Chain the caller's abort signal into ours — if the run is
    // cancelled mid-flight, the outbound request cancels too.
    const upstreamAbort = (): void => controller.abort(ctx.abortSignal.reason);
    if (ctx.abortSignal.aborted) {
      clearTimeout(timeoutHandle);
      throw ctx.abortSignal.reason ?? new Error('aborted');
    }
    ctx.abortSignal.addEventListener('abort', upstreamAbort, { once: true });

    let response: Response;
    try {
      response = await doFetch(url, {
        method: spec.method,
        headers,
        ...(body !== undefined && { body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
      ctx.abortSignal.removeEventListener('abort', upstreamAbort);
    }

    const successMin = spec.successStatus?.min ?? 200;
    const successMax = spec.successStatus?.max ?? 299;
    if (response.status < successMin || response.status > successMax) {
      const text = await safeText(response);
      throw new Error(
        `http-tool "${toolId}" got status ${response.status} ${response.statusText || ''} — ${text.slice(0, 512)}`,
      );
    }

    const parseJson = spec.parseJson ?? true;
    if (!parseJson) {
      return await response.text();
    }
    const rawText = await response.text();
    if (rawText.length === 0) return null;
    try {
      return JSON.parse(rawText);
    } catch (cause) {
      throw new Error(
        `http-tool "${toolId}" response was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };
}

// Register at module load. Framework barrel imports this module
// (`packages/tools/src/index.ts`) so any consumer that pulls in
// `@kindgi/tools` gets the 'http' kind registered automatically.
registerToolSpecSynthesizer('http', buildHttpHandler);

function coerceInputToObject(input: unknown, toolId: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      `http-tool "${toolId}" requires an object input for URL substitution; got ${typeof input}`,
    );
  }
  return input as Record<string, unknown>;
}

/**
 * Substitute `{name}` placeholders in `template` with values from
 * `input`. Returns the substituted URL plus the set of keys that
 * were consumed (used by `buildBody` to strip them from a
 * `json-input` body).
 *
 * URL-safe encoding: values are `encodeURIComponent`'d. Numeric,
 * boolean, and string primitives are coerced via `String()`; nested
 * objects or arrays throw.
 */
function substituteUrl(
  template: string,
  input: Record<string, unknown>,
  toolId: string,
): { readonly url: string; readonly consumedKeys: ReadonlySet<string> } {
  const consumed = new Set<string>();
  const url = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!(key in input)) {
      throw new Error(
        `http-tool "${toolId}" urlTemplate references "{${key}}" but input has no such key`,
      );
    }
    const value = input[key];
    if (
      value === null ||
      value === undefined ||
      typeof value === 'object' ||
      typeof value === 'function' ||
      typeof value === 'symbol'
    ) {
      throw new Error(
        `http-tool "${toolId}" urlTemplate key "{${key}}" must be a primitive; got ${typeof value}`,
      );
    }
    consumed.add(key);
    return encodeURIComponent(String(value));
  });
  return { url, consumedKeys: consumed };
}

/**
 * Substitute `{name}` placeholders in a plain string (used for
 * header values + `text` body templates). Unlike `substituteUrl`,
 * this does NOT URL-encode values — headers/text bodies want raw
 * strings. Missing keys throw.
 */
function substituteTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!(key in input)) return `{${key}}`; // preserve if not in input (may be literal braces)
    const value = input[key];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

async function resolveAuthSecret(
  auth: HttpAuthSpec,
  ctx: ToolContext,
  toolId: string,
): Promise<string> {
  if (ctx.resolveSecret === undefined) {
    throw new Error(
      `http-tool "${toolId}" declares authorization but ToolContext.resolveSecret is not wired. The dispatch site must populate resolveSecret from the deployment's SecretBinding.`,
    );
  }
  return ctx.resolveSecret(auth.secretRef);
}

function applyAuth(
  headers: Record<string, string>,
  auth: HttpAuthSpec,
  _ctx: ToolContext,
  _toolId: string,
  resolvedSecret: string,
): void {
  switch (auth.kind) {
    case 'bearer':
      headers.Authorization = `Bearer ${resolvedSecret}`;
      return;
    case 'header':
      headers[auth.headerName] = resolvedSecret;
      return;
  }
}

function buildBody(
  spec: HttpToolSpec,
  input: Record<string, unknown>,
  consumedKeys: ReadonlySet<string>,
): { body: string | undefined; contentType: string | undefined } {
  // Methods that don't carry a body by convention.
  if (spec.method === 'GET' && spec.requestBody === undefined) {
    return { body: undefined, contentType: undefined };
  }
  const kind: HttpRequestBodySpec['kind'] = spec.requestBody?.kind ?? 'json-input';
  if (kind === 'json-input') {
    const remaining: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (!consumedKeys.has(k)) remaining[k] = v;
    }
    // Empty remaining input → still send an empty body so servers
    // can distinguish "no body" from "empty body". For POST-with-only-
    // URL-params the caller can explicitly configure `input-passthrough`
    // or a `text` body if the server expects that shape.
    if (Object.keys(remaining).length === 0) {
      return { body: '', contentType: undefined };
    }
    return { body: JSON.stringify(remaining), contentType: 'application/json' };
  }
  if (kind === 'input-passthrough') {
    return { body: JSON.stringify(input), contentType: 'application/json' };
  }
  // kind === 'text'
  const template = (spec.requestBody as { kind: 'text'; template: string }).template;
  return { body: substituteTemplate(template, input), contentType: 'text/plain' };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}

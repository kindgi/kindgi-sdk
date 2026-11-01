// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { bearerValueProblem, headerValueProblem } from '@kindgi/types';

import { ConnectionRejectedError } from './connections.js';
import { type ToolSpecSynthesizerOptions, registerToolSpecSynthesizer } from './spec-registry.js';
import type { HttpAuthSpec, HttpRequestBodySpec, HttpToolSpec, ToolContext } from './types.js';

/** What a synthesized handler reads of a response body when the runtime sets no cap. */
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** The most of a failed call's body read for its error message (which keeps 512 characters). */
const ERROR_BODY_BYTES = 2048;

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
 *      silently dropping the credential. A `connection` authorization
 *      reads `ctx.connections[connection]`'s access token instead, and
 *      throws the same way when the call has none.
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
 *      30_000). The deadline and the signal cover reading the body
 *      too. Aborts propagate as `handler-error`.
 *   7. Status is checked against `successStatus` (default 200-299).
 *      Failures throw with the response body as the message; a 401 to
 *      a `connection` authorization throws `ConnectionRejectedError`,
 *      so the runtime renews the token and runs the call again.
 *   8. Response body is parsed as JSON (default) or returned as
 *      text. It's read up to `maxResponseBytes` (default 10 MiB);
 *      a longer body fails the call. Output JSON-Schema validation
 *      runs in the invoke pipeline; handler doesn't validate.
 */
function buildHttpHandler(
  spec: HttpToolSpec,
  toolId: string,
  options: ToolSpecSynthesizerOptions = {},
): (input: unknown, ctx: ToolContext) => Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new RangeError(
      `http-tool "${toolId}": maxResponseBytes must be a positive whole number of bytes; got ${String(maxResponseBytes)}`,
    );
  }
  return async (input, ctx) => {
    const inputObj = coerceInputToObject(input, toolId);
    const { url, consumedKeys } = substituteUrl(spec.urlTemplate, inputObj, toolId);

    const headers: Record<string, string> = {};
    for (const h of spec.headers ?? []) {
      const value = substituteTemplate(h.value, inputObj);
      const problem = headerValueProblem(value);
      if (problem !== undefined) {
        throw new Error(
          `http-tool "${toolId}": the header "${h.name}", filled from its input, has ${problem}, which a header can't carry`,
        );
      }
      headers[h.name] = value;
    }

    if (spec.authorization !== undefined) {
      applyAuth(
        headers,
        spec.authorization,
        ctx,
        toolId,
        await resolveAuthValue(spec.authorization, ctx, toolId),
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

    // The deadline and the caller's signal stay on until the body is
    // read: a server that answers fast and then trickles its body
    // would otherwise hold the call open past both.
    try {
      const response = await doFetch(url, {
        method: spec.method,
        headers,
        ...(body !== undefined && { body }),
        signal: controller.signal,
      });
      return await readResponse(response, spec, toolId, maxResponseBytes, controller.signal);
    } finally {
      clearTimeout(timeoutHandle);
      ctx.abortSignal.removeEventListener('abort', upstreamAbort);
    }
  };
}

/**
 * A status outside `successStatus`, with the body's start. A 401 to a
 * `connection` authorization is the app refusing the connection's token.
 */
function statusFailure(
  response: Response,
  spec: HttpToolSpec,
  toolId: string,
  text: string,
): Error {
  const message = `http-tool "${toolId}" got status ${response.status} ${response.statusText || ''} — ${text.slice(0, 512)}`;
  if (response.status === 401 && spec.authorization?.kind === 'connection') {
    return new ConnectionRejectedError(spec.authorization.connection, message);
  }
  return new Error(message);
}

/** Steps 7 and 8: the status, then the body, read while `signal` holds. */
async function readResponse(
  response: Response,
  spec: HttpToolSpec,
  toolId: string,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const successMin = spec.successStatus?.min ?? 200;
  const successMax = spec.successStatus?.max ?? 299;
  if (response.status < successMin || response.status > successMax) {
    throw statusFailure(response, spec, toolId, await safeText(response, signal));
  }

  const read = await readBodyText(response, maxResponseBytes, signal);
  if (read.truncated) {
    throw new Error(
      `http-tool "${toolId}": the response body is longer than ${maxResponseBytes} bytes, the most this tool reads`,
    );
  }
  const parseJson = spec.parseJson ?? true;
  if (!parseJson) {
    return read.text;
  }
  if (read.text.length === 0) return null;
  try {
    return JSON.parse(read.text);
  } catch (cause) {
    throw new Error(
      `http-tool "${toolId}" response was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
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
 * strings. A name the input lacks is kept as written, braces and all.
 */
function substituteTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!(key in input)) return `{${key}}`; // preserve if not in input (may be literal braces)
    const value = input[key];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

async function resolveAuthValue(
  auth: HttpAuthSpec,
  ctx: ToolContext,
  toolId: string,
): Promise<string> {
  if (auth.kind === 'connection') {
    const connection = ctx.connections?.[auth.connection];
    if (connection === undefined) {
      throw new Error(
        `http-tool "${toolId}" sends the connection "${auth.connection}", which this call doesn't have. The dispatch site must resolve the tool's needsSpec.connections into ToolContext.connections.`,
      );
    }
    return connection.accessToken;
  }
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
  toolId: string,
  resolvedSecret: string,
): void {
  // Checked by the header's name before fetch, whose own error would quote
  // the secret into the call's failure message, and so into the run. As it's
  // sent: after `Bearer `, a leading line break is an inner one.
  const problem =
    auth.kind === 'header'
      ? headerValueProblem(resolvedSecret)
      : bearerValueProblem(resolvedSecret);
  if (problem !== undefined) {
    if (auth.kind === 'connection') {
      throw new Error(
        `http-tool "${toolId}": the access token of its connection "${auth.connection}" has ${problem}, which a header can't carry`,
      );
    }
    const header = auth.kind === 'bearer' ? 'Authorization' : auth.headerName;
    throw new Error(
      `http-tool "${toolId}": its secret ${auth.secretRef.envName}/${auth.secretRef.name} for the header "${header}" has ${problem}, which a header can't carry: store the secret without it`,
    );
  }
  switch (auth.kind) {
    case 'bearer':
    case 'connection':
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

/**
 * Reads a response body as UTF-8 text, as `response.text()` does, but
 * at most `maxBytes` of it, and only while `signal` holds. Past
 * `maxBytes` it cancels the body and returns what it read, marked
 * truncated. When `signal` aborts it cancels the body and throws the
 * signal's reason, whatever the `fetch` in use does with the signal.
 */
async function readBodyText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (response.body === null) {
    if (signal.aborted) throw signal.reason;
    return { text: '', truncated: false };
  }
  const reader = response.body.getReader();
  const cancel = (): void => {
    reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      // A cancel ends a pending read as done, and some fetches error the
      // body instead: either way, an aborted signal's reason is the error.
      const chunk = await reader.read().catch((cause: unknown) => {
        throw signal.aborted ? signal.reason : cause;
      });
      if (signal.aborted) throw signal.reason;
      if (chunk.done) return { text: text + decoder.decode(), truncated: false };
      const room = maxBytes - bytes;
      if (chunk.value.byteLength > room) {
        text += decoder.decode(chunk.value.subarray(0, room), { stream: true });
        reader.cancel().catch(() => undefined);
        return { text, truncated: true };
      }
      bytes += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** A failed call's body for its error message; a body that can't be read says so. */
async function safeText(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return (await readBodyText(response, ERROR_BODY_BYTES, signal)).text;
  } catch (cause) {
    // Past the deadline or cancelled, the call fails as that.
    if (signal.aborted) throw cause;
    return '<no body>';
  }
}

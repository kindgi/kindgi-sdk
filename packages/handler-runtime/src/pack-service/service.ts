// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack service: an HTTP server that runs a pack's code — its tool
 * handlers and guardrail checks — for a Kindgi runtime, speaking pack
 * protocol v2 (`../protocol.ts`).
 *
 * Long-lived and warm: modules are imported once (at `prewarm`) and
 * reused across calls, and calls run concurrently up to a cap. Handler
 * console output goes to the process's own stdout/stderr and can never
 * corrupt a response.
 *
 * Routes:
 *   - `POST /v1/invoke` (token)  — body: a `PackRequest`; 200 with a `PackResponse`
 *   - `GET  /v1/info`   (token)  — the pack's identity, protocol, tools and checks,
 *                                  and the required env names it lacks (`missingEnv`)
 *   - `GET  /healthz`            — the process is up
 *   - `GET  /readyz`             — prewarmed, not draining, and (under the
 *                                  `strict` env check) every required env name set
 *
 * Non-2xx statuses are transport-level only: 401 (token), 404, 405, 413
 * (body too large), 415 (not JSON), 503 with `Retry-After` (not ready,
 * draining or at the concurrency cap), and 500 if the service itself
 * fails while handling a call.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import type { HandlerError } from '../handler-runner.js';
import { runCheck, runHandler } from '../handler-runner.js';
import type { Index, IndexedGuardrail, IndexedTool } from '../kindgi-index.js';
import { type PackEnvCheck, missingPackEnv } from '../pack-env.js';
import {
  type CheckInvokeMessage,
  PACK_HEADERS,
  PACK_PROTOCOL_VERSION,
  type PackErrorCode,
  type PackErrorMessage,
  type PackResponse,
  type ToolInvokeMessage,
  packError,
  parsePackRequest,
} from '../protocol.js';

export interface PackServiceOptions {
  /** The pack's `index.json`, as built. */
  readonly index: Index;
  /** Where an index entry's `modulePath` lives on this host (absolute path). */
  readonly resolveModule: (modulePath: string) => string;
  /** Callers must send it in the `kindgi-pack-token` header. */
  readonly token: string;
  /** Concurrent calls before the service answers 503. Default 32. */
  readonly maxConcurrency?: number;
  /** Largest accepted request body. Default 10 MiB. */
  readonly maxBodyBytes?: number;
  /** Deadline when a call sends no `kindgi-timeout-ms`. Default 120 s. */
  readonly defaultTimeoutMs?: number;
  readonly logger?: (event: PackServiceLogEvent) => void;
  /**
   * The process environment the index's `env.required` names are checked
   * against, once, at creation. Default `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * `strict` (default): with a required name missing, the service isn't
   * ready (`/readyz` and calls answer 503 naming it). `warn`: it serves,
   * and reports the names in the log and `/v1/info`.
   */
  readonly envCheck?: PackEnvCheck;
  /** Test seam: how a module is loaded from its absolute path. */
  readonly importModule?: (absolutePath: string) => Promise<unknown>;
}

export type PackServiceLogEvent =
  | {
      readonly kind: 'call';
      readonly target: 'tool' | 'check';
      readonly id: string;
      readonly durationMs: number;
      readonly outcome: 'ok' | PackErrorCode;
    }
  | {
      /** A handler ignored its abort signal and finished after its call ended. */
      readonly kind: 'handler-finished-late';
      readonly target: 'tool' | 'check';
      readonly id: string;
      readonly afterMs: number;
    }
  | {
      /** Required env names the process doesn't have, logged once at startup. */
      readonly kind: 'missing-env';
      readonly check: PackEnvCheck;
      readonly names: readonly string[];
    };

export interface PackService {
  readonly handle: (req: IncomingMessage, res: ServerResponse) => void;
  /** Import every tool and check module; returns the ones that failed. */
  prewarm(): Promise<readonly PackErrorMessage[]>;
  /** Stop accepting calls (readyz → 503) and wait for in-flight ones, up to `graceMs`. */
  drain(graceMs: number): Promise<void>;
  inFlight(): number;
  ready(): boolean;
}

const DEFAULT_MAX_CONCURRENCY = 32;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export function createPackService(options: PackServiceOptions): PackService {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger ?? (() => undefined);
  const importModule =
    options.importModule ?? ((p: string) => import(pathToFileURL(p).href) as Promise<unknown>);
  const expectedToken = Buffer.from(options.token);

  // Every version of a tool the pack holds, side by side: one agent version
  // may pin tool@1 while another pins tool@2 (keyed by id and version).
  const tools = new Map<string, IndexedTool>(
    options.index.tools.map((t) => [toolKey(t.id, t.version), t]),
  );
  const versionsOf = new Map<string, IndexedTool[]>();
  for (const t of options.index.tools) {
    versionsOf.set(t.id, [...(versionsOf.get(t.id) ?? []), t]);
  }
  const checks = new Map<string, IndexedGuardrail>(
    options.index.guardrails.map((g) => [g.checkId ?? g.id, g]),
  );

  let inFlight = 0;
  let ready = false;
  let draining = false;

  const envCheck = options.envCheck ?? 'strict';
  const missingEnv = missingPackEnv(options.index.env, options.env ?? process.env);
  if (missingEnv.length > 0) logger({ kind: 'missing-env', check: envCheck, names: missingEnv });

  /** Why the service can't take calls now, or `undefined` when it can. */
  function notReady(): Reply | undefined {
    if (draining) return unavailable('draining');
    if (envCheck === 'strict' && missingEnv.length > 0) {
      return unavailable('missing env', { missingEnv });
    }
    if (!ready) return unavailable('not ready');
    return undefined;
  }

  function authorized(req: IncomingMessage): boolean {
    const got = req.headers[PACK_HEADERS.token];
    if (typeof got !== 'string') return false;
    const buf = Buffer.from(got);
    return buf.length === expectedToken.length && timingSafeEqual(buf, expectedToken);
  }

  async function prewarm(): Promise<readonly PackErrorMessage[]> {
    const failures: PackErrorMessage[] = [];
    const targets = [
      ...[...tools.values()].map((t) => ({ id: t.id, modulePath: t.modulePath, check: false })),
      ...[...checks.entries()].map(([id, g]) => ({
        id,
        modulePath: g.checkModulePath,
        check: true,
      })),
    ];
    for (const target of targets) {
      try {
        await importModule(options.resolveModule(target.modulePath));
      } catch (cause) {
        failures.push(
          packError('handler-import-failed', `${target.id}: ${describe(cause)}`, {
            ...(target.check ? { checkId: target.id } : { toolId: target.id }),
          }),
        );
      }
    }
    ready = failures.length === 0;
    return failures;
  }

  async function drain(graceMs: number): Promise<void> {
    draining = true;
    const deadline = Date.now() + graceMs;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function info(): Record<string, unknown> {
    return {
      protocol: PACK_PROTOCOL_VERSION,
      packId: options.index.packId,
      packVersion: options.index.packVersion,
      artifactVersion: options.index.artifactVersion,
      tools: [...tools.values()].map((t) => ({
        id: t.id,
        ...(t.version && { version: t.version }),
      })),
      checks: [...checks.keys()],
      missingEnv,
    };
  }

  /**
   * The tool version a call asks for: that version, or, when it names
   * none, the tool's only version in the pack.
   */
  function toolFor(
    ref: ToolInvokeMessage['tool'],
  ): { readonly tool: IndexedTool } | { readonly refused: PackResponse } {
    const versions = versionsOf.get(ref.id) ?? [];
    if (versions.length === 0) {
      return {
        refused: packError('tool-not-in-pack', `This pack has no tool "${ref.id}"`, {
          toolId: ref.id,
        }),
      };
    }
    const have = versions.map((t) => t.version ?? 'unversioned').join(', ');
    const tool =
      ref.version === undefined
        ? versions.length === 1
          ? versions[0]
          : undefined
        : tools.get(toolKey(ref.id, ref.version));
    if (tool !== undefined) return { tool };
    return {
      refused: packError(
        'tool-version-mismatch',
        ref.version === undefined
          ? `Tool "${ref.id}" has several versions in this pack (${have}); the caller named none`
          : `Tool "${ref.id}" is ${have} in this pack; the caller asked for ${ref.version}`,
        { toolId: ref.id },
      ),
    };
  }

  function callTool(message: ToolInvokeMessage, signal: AbortSignal): Promise<PackResponse> {
    const found = toolFor(message.tool);
    if ('refused' in found) return Promise.resolve(found.refused);
    const { tool } = found;
    return runHandler({
      tool: {
        id: tool.id,
        modulePath: options.resolveModule(tool.modulePath),
        inputSchema: tool.input,
        outputSchema: tool.output,
      },
      input: message.input,
      ctx: { ...message.ctx, abortSignal: signal },
      importHandler: (p) => importModule(p) as never,
    }).then((r) =>
      r.kind === 'ok'
        ? { v: PACK_PROTOCOL_VERSION, kind: 'result', output: r.value }
        : fromHandlerError(r.error, { toolId: tool.id }),
    );
  }

  function callCheck(message: CheckInvokeMessage, signal: AbortSignal): Promise<PackResponse> {
    const guardrail = checks.get(message.check.id);
    if (guardrail === undefined) {
      return Promise.resolve(
        packError('check-not-in-pack', `This pack has no check "${message.check.id}"`, {
          checkId: message.check.id,
        }),
      );
    }
    return runCheck({
      check: {
        id: message.check.id,
        modulePath: options.resolveModule(guardrail.checkModulePath),
        ...(guardrail.configSchema !== undefined && { configSchema: guardrail.configSchema }),
      },
      config: message.config,
      trace: message.trace,
      abortSignal: signal,
      importCheck: (p) => importModule(p) as never,
    }).then((r) =>
      r.kind === 'ok'
        ? { v: PACK_PROTOCOL_VERSION, kind: 'check-result', result: r.value }
        : fromHandlerError(r.error, { checkId: message.check.id }),
    );
  }

  /** Why a call can't be taken right now, if it can't. */
  function refuseInvoke(req: IncomingMessage): Reply | undefined {
    const unready = notReady();
    if (unready !== undefined) return unready;
    if (inFlight >= maxConcurrency) return unavailable('overloaded');
    if (!(req.headers['content-type'] ?? '').includes('application/json')) {
      return { status: 415, body: { error: 'Content-Type must be application/json' } };
    }
    return undefined;
  }

  async function invoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refused = refuseInvoke(req);
    if (refused !== undefined) {
      reply(res, refused);
      return;
    }
    inFlight += 1;
    const started = Date.now();
    try {
      const body = await readBody(req, maxBodyBytes);
      const response = body === undefined ? undefined : await dispatch(req, res, body);
      if (res.writableEnded || res.destroyed) return;
      reply(
        res,
        response === undefined
          ? { status: 413, body: { error: 'Request body too large' } }
          : {
              status: 200,
              body: response,
              headers: {
                [PACK_HEADERS.durationMs]: String(Date.now() - started),
                [PACK_HEADERS.artifactVersion]: options.index.artifactVersion,
              },
            },
      );
    } finally {
      inFlight -= 1;
    }
  }

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ): Promise<PackResponse> {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return packError('malformed-message', 'Request body is not valid JSON');
    }
    const parsed = parsePackRequest(json);
    if (parsed.kind === 'err') return parsed.error;
    const message = parsed.value;
    const target = message.kind === 'invoke' ? 'tool' : 'check';
    const id = message.kind === 'invoke' ? message.tool.id : message.check.id;

    const controller = new AbortController();
    const timeoutMs = parseTimeout(req.headers[PACK_HEADERS.timeoutMs]) ?? defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort('deadline-exceeded'), timeoutMs);
    // The caller gave up (closed the connection) before we answered.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort('cancelled');
    });

    const started = Date.now();
    const work =
      message.kind === 'invoke'
        ? callTool(message, controller.signal)
        : callCheck(message, controller.signal);
    const outcome = await Promise.race([work, aborted(controller.signal, id, target)]);
    clearTimeout(timer);
    if (controller.signal.aborted) {
      void work.then(() =>
        logger({ kind: 'handler-finished-late', target, id, afterMs: Date.now() - started }),
      );
    }
    logger({
      kind: 'call',
      target,
      id,
      durationMs: Date.now() - started,
      outcome: outcome.kind === 'error' ? outcome.code : 'ok',
    });
    return outcome;
  }

  /** The transport-level answer for a request before any route runs, if any. */
  function refuseRequest(req: IncomingMessage, route: Route | undefined): Reply | undefined {
    if (route === undefined) return { status: 404, body: { error: `No route ${req.url ?? '/'}` } };
    if (req.method !== route.method) return { status: 405, body: { error: `Use ${route.method}` } };
    if (route.auth && !authorized(req)) return { status: 401, body: { error: 'Bad pack token' } };
    return undefined;
  }

  function probe(name: Route['name']): Reply {
    if (name === 'healthz') return { status: 200, body: { status: 'ok' } };
    if (name === 'readyz') return notReady() ?? { status: 200, body: { status: 'ready' } };
    return { status: 200, body: info() };
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const route = ROUTES[(req.url ?? '/').split('?')[0] ?? ''];
    const refused = refuseRequest(req, route);
    if (refused !== undefined || route === undefined) {
      reply(res, refused ?? { status: 404, body: {} });
      return;
    }
    if (route.name !== 'invoke') {
      reply(res, probe(route.name));
      return;
    }
    void invoke(req, res).catch((cause) => {
      if (!res.writableEnded) reply(res, { status: 500, body: { error: describe(cause) } });
    });
  }

  return {
    handle,
    prewarm,
    drain,
    inFlight: () => inFlight,
    ready: () => notReady() === undefined,
  };
}

interface Route {
  readonly name: 'invoke' | 'info' | 'healthz' | 'readyz';
  readonly method: 'GET' | 'POST';
  readonly auth: boolean;
}

const ROUTES: Readonly<Record<string, Route>> = {
  '/v1/invoke': { name: 'invoke', method: 'POST', auth: true },
  '/v1/info': { name: 'info', method: 'GET', auth: true },
  '/healthz': { name: 'healthz', method: 'GET', auth: false },
  '/readyz': { name: 'readyz', method: 'GET', auth: false },
};

function aborted(
  signal: AbortSignal,
  id: string,
  target: 'tool' | 'check',
): Promise<PackErrorMessage> {
  return new Promise((resolve) => {
    const settle = (): void => {
      const reason = signal.reason === 'deadline-exceeded' ? 'deadline-exceeded' : 'cancelled';
      const message =
        reason === 'deadline-exceeded' ? `${id} passed its deadline` : `${id} was cancelled`;
      resolve(packError(reason, message, target === 'tool' ? { toolId: id } : { checkId: id }));
    };
    if (signal.aborted) settle();
    else signal.addEventListener('abort', settle, { once: true });
  });
}

function fromHandlerError(
  error: HandlerError,
  ids: { readonly toolId?: string; readonly checkId?: string },
): PackErrorMessage {
  return packError(error.code as PackErrorCode, error.message, {
    ...ids,
    ...(error.cause !== undefined && { cause: error.cause }),
    ...(error.issues !== undefined && { issues: error.issues }),
  });
}

function parseTimeout(raw: string | string[] | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const ms = Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : undefined;
}

/** The body as text, or `undefined` once it exceeds `limit` (the rest is drained). */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function unavailable(reason: string, details?: Readonly<Record<string, unknown>>): Reply {
  return { status: 503, body: { error: reason, ...details }, headers: { 'retry-after': '1' } };
}

function reply(res: ServerResponse, r: Reply): void {
  sendJson(res, r.status, r.body, r.headers);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A tool's key in the pack: its id and version (an unversioned tool, by id alone). */
function toolKey(id: string, version: string | undefined): string {
  return version === undefined ? id : `${id}@${version}`;
}

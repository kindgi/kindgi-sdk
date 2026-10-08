// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack service as a local child process behind a stable front — how
 * a development loop runs pack code: the same entrypoint and protocol as
 * a deployment, on loopback, with a token only this process knows.
 *
 * The front is one HTTP listener for the supervisor's whole life: a fixed
 * address, the session token. It forwards `POST /v1/invoke` and
 * `GET /v1/info` to whichever child is serving and answers 503 while none
 * is — a caller retries those, since the call provably did not run.
 * `/healthz` answers 200 while the front listens; `/readyz` 200 only while
 * a child serves. So a caller holds one URL and one token however often
 * the code changes.
 *
 * `start(indexPath)` boots a child on that index (loopback, any port).
 * Once the child listens (it prewarms every module first), new calls go to
 * it; the previous child finishes its in-flight calls (SIGTERM drains) and
 * stops. If a child fails to boot, the previous one keeps serving. A child
 * that exits on its own is restarted on the same index.
 *
 * The child's environment is exactly `env()` plus the token and `PORT=0`
 * — nothing of this process's own environment reaches pack code.
 *
 * Forwarding has two parts. The relay ({@link PackRelay}) takes a request
 * body and the call's options — deadline, run and request ids, a cancel
 * signal — and calls the serving child. The HTTP listener maps headers and
 * a closed connection onto those options. Another listener (one that
 * receives calls over a connection the pack side opened) can reuse the
 * relay unchanged.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';

import type { Result } from '@kindgi/types';

import { PACK_HEADERS } from '../protocol.js';
import { PACK_SERVICE_DRAIN_MS } from './main.js';

export interface PackServiceSupervisorOptions {
  /**
   * The pack-service process as an argv — the program, then its arguments.
   * The supervisor appends `--index`, `--module-root` and `--host`. Any pack
   * service with that process contract works (`pack-protocol.schema.json`):
   *
   *   - Node: `[process.execPath, '--enable-source-maps', <@kindgi/handler-runtime/pack-service-main>]`
   *   - Python: `[<the pack's python>, '-m', 'kindgi.pack', 'serve']`
   *   - Java: `['sh', <kindgi-pack-java>, '-cp', <classpath> (or `@<argfile>`), 'com.kindgi.pack.Main', 'serve']`
   */
  readonly command: readonly [string, ...string[]];
  /** Where the index's module paths resolve — the pack directory. */
  readonly moduleRoot: string;
  /** The child's whole environment, read at every start. */
  readonly env: () => Promise<Readonly<Record<string, string>>>;
  /** Where the front listens. Default `127.0.0.1`. */
  readonly host?: string;
  /** The front's port. Default `0`: any free port, fixed while the front listens. */
  readonly port?: number;
  /**
   * The token callers of the front send. Default: a new random one for
   * each supervisor. Pass the previous supervisor's (with its `port`) so
   * a caller started with both, such as a runtime running from source
   * for `kindgi dev --runtime-url`, keeps reaching the front across
   * restarts. At least 32 URL-safe base64 characters.
   */
  readonly token?: string;
  /** Each line pack code writes; the service's own JSON log lines arrive as `onEvent`. */
  readonly onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
  readonly onEvent?: (event: PackServiceSupervisorEvent) => void;
  /** How long a child may take to listen. Default 60 000 ms. */
  readonly bootTimeoutMs?: number;
  /**
   * How long a stopping child may drain before it is killed. Default: the
   * child's own drain (`PACK_SERVICE_DRAIN_MS`) plus 2 s, so a call the
   * child would still finish is never cut off by the kill.
   */
  readonly stopGraceMs?: number;
  /** Restarts after a child exits on its own, before giving up. Default 3. */
  readonly maxRestarts?: number;
  /** Wait before such a restart. Default 500 ms. */
  readonly restartDelayMs?: number;
  /** Largest request body the front accepts. Default 10 MiB (the pack service's own limit). */
  readonly maxBodyBytes?: number;
  /** Test seam: run `fn` on the event loop's next turn (`setImmediate`). */
  readonly nextTurn?: (fn: () => void) => void;
}

/**
 * What a terminal sends its whole foreground process group: Ctrl+C and a
 * hangup. A child killed by one shares it with its owner, who is very
 * likely stopping too.
 */
const GROUP_SIGNALS: ReadonlySet<string> = new Set(['SIGINT', 'SIGHUP']);

export type PackServiceSupervisorEvent =
  | { readonly kind: 'started'; readonly port: number; readonly indexPath: string }
  | { readonly kind: 'boot-failed'; readonly problems: readonly string[] }
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'restarting'; readonly attempt: number }
  | { readonly kind: 'gave-up'; readonly attempts: number }
  /** One of the service's own JSON log lines (a call, draining, …). */
  | { readonly kind: 'log'; readonly event: Readonly<Record<string, unknown>> };

export interface BootFailure {
  readonly problems: readonly string[];
}

/** One call to forward: a request body and the call's options. */
export interface PackRelayCall {
  readonly route: 'invoke' | 'info';
  /** The protocol v2 request (JSON text) for `invoke`; absent for `info`. */
  readonly body?: string;
  /** Cancels the call: the child sees its connection close. */
  readonly signal?: AbortSignal;
  /** The call's deadline, passed on to the child. */
  readonly timeoutMs?: number;
  readonly runId?: string;
  readonly requestId?: string;
  /** The caller's protocol version (`kindgi-protocol`), passed on as is. */
  readonly protocol?: string;
  /** The caller's W3C trace context (`traceparent`), passed on as is, so the child's records carry its trace. */
  readonly traceparent?: string;
}

/**
 * What became of a forwarded call:
 *   - `answer` — the child answered (any status, passed through as is);
 *   - `unavailable` — not delivered (no child serving, or the connection
 *     was refused), so it provably did not run and may be retried;
 *   - `failed` — delivered, but no answer came back (the child died
 *     mid-call); it may have run, so it must not be retried;
 *   - `cancelled` — the caller cancelled it.
 */
export type PackRelayOutcome =
  | {
      readonly kind: 'answer';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'cancelled' };

/** Forwards calls to the serving child. */
export interface PackRelay {
  /** Whether a child is serving. */
  readonly serving: () => boolean;
  forward(call: PackRelayCall): Promise<PackRelayOutcome>;
}

export interface PackServiceSupervisor {
  /** The token callers send (`kindgi-pack-token`); the children use it too. */
  readonly token: string;
  /** Forwards one call to the serving child; the front's HTTP listener uses it. */
  readonly relay: PackRelay;
  /** Open the front. Idempotent: later calls return the same address. */
  listen(): Promise<{ readonly url: string; readonly port: number }>;
  /**
   * Boot a child on `indexPath` and switch calls to it once it listens.
   * On failure the previous child, if any, keeps serving.
   */
  start(indexPath: string): Promise<Result<{ readonly port: number }, BootFailure>>;
  /** Stop the serving child; the front then answers 503. */
  stop(): Promise<void>;
  /**
   * The supervisor is closing (its owner is shutting down): from now on a
   * child that exits is expected, not restarted, and no new child starts.
   * `close()` does this too; calling it the moment a shutdown begins keeps
   * a child that dies first (a terminal's Ctrl+C signals the whole process
   * group) from being restarted while the owner shuts down.
   */
  beginClose(): void;
  /** Stop the serving child and close the front. */
  close(): Promise<void>;
}

interface Child {
  readonly process: ChildProcess;
  readonly port: number;
  readonly indexPath: string;
  /** Set once this child is being stopped on purpose. */
  retiring: boolean;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_BOOT_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_GRACE_MS = PACK_SERVICE_DRAIN_MS + 2_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_DELAY_MS = 500;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
/** A token a caller supplies: as long as a generated one (24 bytes, base64url). */
const PACK_SERVICE_TOKEN = /^[A-Za-z0-9_-]{32,}$/;
/** Headers of a child's answer that the front passes on. */
const ANSWER_HEADERS = [
  'content-type',
  'retry-after',
  PACK_HEADERS.artifactVersion,
  PACK_HEADERS.durationMs,
] as const;

export function createPackServiceSupervisor(
  options: PackServiceSupervisorOptions,
): PackServiceSupervisor {
  if (options.token !== undefined && !PACK_SERVICE_TOKEN.test(options.token)) {
    throw new Error('A pack service token is at least 32 URL-safe base64 characters.');
  }
  const token = options.token ?? randomBytes(24).toString('base64url');
  const expectedToken = Buffer.from(token);
  const emit = (event: PackServiceSupervisorEvent): void => options.onEvent?.(event);
  const nextTurn =
    options.nextTurn ??
    ((fn: () => void): void => {
      setImmediate(fn);
    });
  let serving: Child | undefined;
  let stopped = false;
  /** Closing for good (`beginClose`): nothing restarts or starts again. */
  let shuttingDown = false;
  let restarts = 0;
  let front: { readonly server: Server; readonly url: string; readonly port: number } | undefined;

  async function boot(indexPath: string): Promise<Result<Child, BootFailure>> {
    // JSON whatever the pack's env says: this process reads the child's records.
    const env = {
      ...(await options.env()),
      KINDGI_PACK_SERVICE_TOKEN: token,
      PORT: '0',
      KINDGI_LOG_FORMAT: 'json',
    };
    const [program, ...args] = options.command;
    const child = spawn(
      program,
      [...args, '--index', indexPath, '--module-root', options.moduleRoot, '--host', DEFAULT_HOST],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    pipeLines(child.stdout, (line) => options.onLog?.(line, 'stdout'));
    return listening(child, indexPath);
  }

  /** Resolves once the child listens, or with why it never will. */
  function listening(child: ChildProcess, indexPath: string): Promise<Result<Child, BootFailure>> {
    const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const problems: string[] = [];
      // A promise settles once; later calls (an exit after listening) are no-ops.
      const done = (outcome: Result<Child, BootFailure>): void => {
        clearTimeout(timer);
        resolve(outcome);
      };
      const fail = (reasons: readonly string[]): void =>
        done({ kind: 'err', error: { problems: reasons } });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail([`The pack service did not listen within ${bootTimeoutMs} ms`]);
      }, bootTimeoutMs);

      pipeLines(child.stderr, (line) => {
        const event = serviceEvent(line);
        if (event === undefined) {
          options.onLog?.(line, 'stderr');
        } else if (event.kind === 'listening' && typeof event.port === 'number') {
          done({
            kind: 'ok',
            value: { process: child, port: event.port, indexPath, retiring: false },
          });
        } else if (event.kind === 'boot-failed' || event.kind === 'config-invalid') {
          problems.push(...problemsOf(event));
        } else {
          emit({ kind: 'log', event });
        }
      });
      child.once('error', (cause) => fail([cause.message]));
      child.once('exit', (code, signal) =>
        fail(
          problems.length > 0
            ? problems
            : [`The pack service exited (${signal ?? code}) before listening`],
        ),
      );
    });
  }

  /** A serving child that exits on its own is restarted on the same index. */
  function watch(child: Child): void {
    child.process.once('exit', (code, signal) => {
      const crashed = (): void => {
        if (child.retiring || stopped || shuttingDown) return;
        emit({ kind: 'exited', code, signal });
        if (serving === child) serving = undefined;
        void recover(child.indexPath);
      };
      // Killed by the terminal's Ctrl+C or hangup: its owner got the same
      // signal and may not have handled it yet (under load the child's
      // exit can come first). Give its stop (`beginClose`) two turns of
      // the event loop before calling this a crash.
      if (signal !== null && GROUP_SIGNALS.has(signal)) nextTurn(() => nextTurn(crashed));
      else crashed();
    });
  }

  async function recover(indexPath: string): Promise<void> {
    while (
      !stopped &&
      !shuttingDown &&
      serving === undefined &&
      restarts < (options.maxRestarts ?? DEFAULT_MAX_RESTARTS)
    ) {
      restarts += 1;
      emit({ kind: 'restarting', attempt: restarts });
      await new Promise((r) => setTimeout(r, options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS));
      if (stopped || shuttingDown || serving !== undefined) return;
      const booted = await start(indexPath);
      if (booted.kind === 'ok') return;
    }
    if (!stopped && !shuttingDown && serving === undefined) {
      emit({ kind: 'gave-up', attempts: restarts });
    }
  }

  async function retire(child: Child | undefined): Promise<void> {
    if (child === undefined) return;
    child.retiring = true;
    if (child.process.exitCode !== null || child.process.signalCode !== null) return;
    const exited = new Promise<void>((done) => child.process.once('exit', () => done()));
    child.process.kill('SIGTERM');
    const grace = setTimeout(
      () => child.process.kill('SIGKILL'),
      options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    );
    await exited;
    clearTimeout(grace);
  }

  async function start(indexPath: string): Promise<Result<{ readonly port: number }, BootFailure>> {
    if (shuttingDown) {
      return { kind: 'err', error: { problems: ['The pack service is closing'] } };
    }
    stopped = false;
    const booted = await boot(indexPath);
    if (booted.kind === 'err') {
      emit({ kind: 'boot-failed', problems: booted.error.problems });
      return booted;
    }
    const previous = serving;
    serving = booted.value;
    restarts = 0;
    watch(booted.value);
    emit({ kind: 'started', port: booted.value.port, indexPath });
    await retire(previous);
    return { kind: 'ok', value: { port: booted.value.port } };
  }

  async function stop(): Promise<void> {
    stopped = true;
    const child = serving;
    serving = undefined;
    await retire(child);
  }

  const relay: PackRelay = {
    serving: () => serving !== undefined,
    forward: (call) => forwardToChild(serving?.port, token, call),
  };

  function authorized(req: IncomingMessage): boolean {
    const got = req.headers[PACK_HEADERS.token];
    if (typeof got !== 'string') return false;
    const buf = Buffer.from(got);
    return buf.length === expectedToken.length && timingSafeEqual(buf, expectedToken);
  }

  /** The HTTP listener: maps a request onto a relay call and the outcome onto a response. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admitted = admit(req);
    if (typeof admitted !== 'string') {
      return sendJson(res, admitted.status, admitted.body, admitted.headers);
    }
    const body =
      admitted === 'invoke'
        ? await readBody(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
        : undefined;
    if (admitted === 'invoke' && body === undefined) {
      return sendJson(res, 413, { error: 'Request body too large' });
    }
    // The caller gave up (closed the connection) before the answer: cancel the call.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const outcome = await relay.forward(relayCall(req, admitted, body, controller.signal));
    if (!res.writableEnded && !res.destroyed) writeOutcome(res, outcome);
  }

  /**
   * The relay route for a request, or the front's own answer: an unknown
   * route, a wrong method, a probe, a bad token.
   */
  function admit(req: IncomingMessage): Reply | 'invoke' | 'info' {
    const route = FRONT_ROUTES[(req.url ?? '/').split('?')[0] ?? ''];
    if (route === undefined) return { status: 404, body: { error: `No route ${req.url ?? '/'}` } };
    if (req.method !== route.method) return { status: 405, body: { error: `Use ${route.method}` } };
    if (route.name === 'healthz' || route.name === 'readyz') return probe(route.name);
    if (!authorized(req)) return { status: 401, body: { error: 'Bad pack token' } };
    return route.name;
  }

  /** `/healthz`: the front listens. `/readyz`: a child serves. Neither needs the token. */
  function probe(name: 'healthz' | 'readyz'): Reply {
    if (name === 'healthz') return { status: 200, body: { status: 'ok' } };
    return relay.serving()
      ? { status: 200, body: { status: 'ready' } }
      : { status: 503, body: { error: 'no pack service' }, headers: RETRY_AFTER };
  }

  return {
    token,
    relay,
    async listen() {
      if (front !== undefined) return { url: front.url, port: front.port };
      const host = options.host ?? DEFAULT_HOST;
      const server = createServer((req, res) => {
        void handle(req, res).catch((cause) => {
          if (!res.headersSent) sendJson(res, 500, { error: describe(cause) });
          else res.destroy();
        });
      });
      await new Promise<void>((ready, failed) => {
        server.once('error', failed);
        server.listen(options.port ?? 0, host, () => {
          server.off('error', failed);
          ready();
        });
      });
      const port = (server.address() as AddressInfo).port;
      front = { server, port, url: `http://${host.includes(':') ? `[${host}]` : host}:${port}` };
      return { url: front.url, port };
    },
    start,
    stop,
    beginClose() {
      shuttingDown = true;
    },
    async close() {
      shuttingDown = true;
      await stop();
      const closing = front;
      front = undefined;
      if (closing !== undefined) {
        // No child serves any more; drop idle keep-alives and callers that went away.
        const closed = new Promise<void>((done) => closing.server.close(() => done()));
        closing.server.closeAllConnections();
        await closed;
      }
    },
  };
}

/** Call the serving child on `port` with the session token. */
async function forwardToChild(
  port: number | undefined,
  token: string,
  call: PackRelayCall,
): Promise<PackRelayOutcome> {
  if (port === undefined) return { kind: 'unavailable', reason: 'no pack service' };
  if (call.signal?.aborted) return { kind: 'cancelled' };
  let response: Response;
  try {
    response = await fetch(`http://${DEFAULT_HOST}:${port}/v1/${call.route}`, {
      method: call.route === 'invoke' ? 'POST' : 'GET',
      headers: childHeaders(token, call),
      ...(call.body !== undefined && { body: call.body }),
      ...(call.signal !== undefined && { signal: call.signal }),
    });
  } catch (cause) {
    if (call.signal?.aborted) return { kind: 'cancelled' };
    return refused(cause)
      ? { kind: 'unavailable', reason: 'the pack service refused the connection' }
      : { kind: 'failed', reason: `the pack service did not answer: ${describe(cause)}` };
  }
  return answerFrom(response, call.signal);
}

function childHeaders(token: string, call: PackRelayCall): Record<string, string> {
  return {
    [PACK_HEADERS.token]: token,
    ...(call.body !== undefined && { 'content-type': 'application/json' }),
    ...(call.timeoutMs !== undefined && { [PACK_HEADERS.timeoutMs]: String(call.timeoutMs) }),
    ...(call.runId !== undefined && { [PACK_HEADERS.runId]: call.runId }),
    ...(call.requestId !== undefined && { [PACK_HEADERS.requestId]: call.requestId }),
    ...(call.protocol !== undefined && { [PACK_HEADERS.protocol]: call.protocol }),
    ...(call.traceparent !== undefined && { [PACK_HEADERS.traceparent]: call.traceparent }),
  };
}

async function answerFrom(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<PackRelayOutcome> {
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    if (signal?.aborted) return { kind: 'cancelled' };
    return { kind: 'failed', reason: `the pack service's answer broke off: ${describe(cause)}` };
  }
  const headers: Record<string, string> = {};
  for (const name of ANSWER_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { kind: 'answer', status: response.status, headers, body };
}

/** The relay call for a front request. */
function relayCall(
  req: IncomingMessage,
  route: 'invoke' | 'info',
  body: string | undefined,
  signal: AbortSignal,
): PackRelayCall {
  const timeoutMs = Number(header(req, PACK_HEADERS.timeoutMs));
  const runId = header(req, PACK_HEADERS.runId);
  const requestId = header(req, PACK_HEADERS.requestId);
  const protocol = header(req, PACK_HEADERS.protocol);
  const traceparent = header(req, PACK_HEADERS.traceparent);
  return {
    route,
    signal,
    ...(body !== undefined && { body }),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 && { timeoutMs }),
    ...(runId !== undefined && { runId }),
    ...(requestId !== undefined && { requestId }),
    ...(protocol !== undefined && { protocol }),
    ...(traceparent !== undefined && { traceparent }),
  };
}

function writeOutcome(res: ServerResponse, outcome: PackRelayOutcome): void {
  switch (outcome.kind) {
    case 'answer':
      res.writeHead(outcome.status, {
        ...outcome.headers,
        'content-length': Buffer.byteLength(outcome.body),
      });
      res.end(outcome.body);
      return;
    case 'unavailable':
      sendJson(res, 503, { error: outcome.reason }, RETRY_AFTER);
      return;
    case 'failed':
      sendJson(res, 502, { error: outcome.reason });
      return;
    case 'cancelled':
      res.destroy();
      return;
  }
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const RETRY_AFTER: Readonly<Record<string, string>> = { 'retry-after': '1' };

interface FrontRoute {
  readonly name: 'invoke' | 'info' | 'healthz' | 'readyz';
  readonly method: 'GET' | 'POST';
}

const FRONT_ROUTES: Readonly<Record<string, FrontRoute>> = {
  '/v1/invoke': { name: 'invoke', method: 'POST' },
  '/v1/info': { name: 'info', method: 'GET' },
  '/healthz': { name: 'healthz', method: 'GET' },
  '/readyz': { name: 'readyz', method: 'GET' },
};

/** A connection that never reached a listener: the call did not run. */
function refused(cause: unknown): boolean {
  const code = (cause as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return code === 'ECONNREFUSED';
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The request body, or `undefined` past `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

function pipeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (stream !== null) createInterface({ input: stream }).on('line', onLine);
}

function problemsOf(event: Readonly<Record<string, unknown>>): readonly string[] {
  return Array.isArray(event.problems) ? event.problems.map(String) : [];
}

/** What a pack service from before records wrote as bare `{"kind": …}` lines. */
const LEGACY_EVENTS: ReadonlySet<string> = new Set([
  'listening',
  'boot-failed',
  'config-invalid',
  'missing-env',
  'draining',
  'stopped',
  'call',
  'handler-finished-late',
]);

/**
 * One of the service's own log lines, as an event with a `kind`:
 *
 *   - a record (`@kindgi/log`: `time`, `level`, `subsystem`, `message`).
 *     The service's own, subsystem `pack`, carry their event as `event`
 *     (`listening`, `call`, …), which becomes `kind`. Any other record, an
 *     author's `ctx.log` (`pack.tool`) say, comes back with `kind: 'record'`,
 *     to show, never to act on;
 *   - a bare `{"kind": …}` line from a pack service from before records,
 *     for the events it wrote. Any other JSON line is the pack's own
 *     output, shown as it is.
 */
export function serviceEvent(
  line: string,
): (Record<string, unknown> & { readonly kind: string }) | undefined {
  if (!line.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (isRecord(fields)) {
    const own = fields.subsystem === 'pack' && typeof fields.event === 'string';
    return { ...fields, kind: own ? (fields.event as string) : 'record' };
  }
  return typeof fields.kind === 'string' && LEGACY_EVENTS.has(fields.kind)
    ? (fields as Record<string, unknown> & { readonly kind: string })
    : undefined;
}

function isRecord(fields: Record<string, unknown>): boolean {
  return (
    typeof fields.time === 'string' &&
    typeof fields.level === 'string' &&
    typeof fields.subsystem === 'string' &&
    typeof fields.message === 'string'
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

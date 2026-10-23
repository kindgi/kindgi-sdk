// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { ConnectionRejectedError, type ToolContext } from '@kindgi/tools';

import type { AppEntry, AppRateLimit } from './types.js';

/** One call to an app's API, made with a connection the tool declared. */
export interface AppCall {
  /** The app's entry: its rate limits pace the call. */
  readonly entry: AppEntry;
  /** The tool's name for the connection: its `needsSpec.connections` key. */
  readonly connection: string;
  /** The calling tool's id: what the entry's rate limits charge for it (`costs`). */
  readonly toolId: string;
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as given, but for any `Authorization`: the connection's token goes there. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Tries of one call when the app says it's busy, the first included. */
const MAX_TRIES = 3;
/** The first wait when the app gives no time; it doubles each try. */
const BACKOFF_MS = 1_000;
/** The longest wait between tries: an app that asks for longer gets its answer back. */
const MAX_WAIT_MS = 30_000;
/** Rate-limit buckets kept in this process, so a long-lived one doesn't grow without end. */
const MAX_BUCKETS = 10_000;

interface Bucket {
  units: number;
  atMs: number;
  /** When the bucket is full again if nothing takes from it: it can be dropped then. */
  fullAtMs: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Calls an app's API with the connection the tool declared as
 * `call.connection`, sending its token as `Authorization: Bearer`.
 *
 * - **Pacing:** each of the entry's `rateLimits` is a bucket per connection
 *   in this process, holding `units` and refilled over `perSeconds`. The
 *   call takes `costs[toolId]` (1 when not listed) from each before it goes
 *   out, waiting until there's enough.
 * - **Busy:** a 429, a 403 that says the rate limit is spent, or a 503 to a
 *   GET is tried again, up to 3 tries in all, after the app's `Retry-After`
 *   (or GitHub's `x-ratelimit-reset`), else after 1 s, then 2 s. A wait the
 *   app asks for past 30 s isn't waited out: the answer goes back to the
 *   tool. A 503 to anything but a GET isn't tried again: the app may have
 *   done it.
 * - **Refused:** a 401 throws `ConnectionRejectedError`, so the runtime renews
 *   the token once and runs the call again.
 * - **Never:** the token is in no error this throws, and nothing is logged.
 *
 * Every wait ends when the call's `abortSignal` fires. Any other answer is
 * the tool's to read.
 */
export async function appFetch(
  ctx: Pick<ToolContext, 'connections' | 'abortSignal'>,
  call: AppCall,
): Promise<Response> {
  const connection = ctx.connections?.[call.connection];
  if (connection === undefined) {
    throw new Error(
      `This call has no connection "${call.connection}": the tool declares it in needsSpec.connections.`,
    );
  }
  if (connection.app !== call.entry.id) {
    throw new Error(
      `The connection "${call.connection}" is to ${connection.appName}, not ${call.entry.name}.`,
    );
  }
  const method = call.method ?? 'GET';
  for (let attempt = 1; ; attempt++) {
    await take(call.entry, connection.connectionId, call.toolId, ctx.abortSignal);
    const res = await fetch(call.url, {
      method,
      headers: withToken(call.headers, connection.accessToken),
      ...(call.body !== undefined && { body: call.body }),
      signal: ctx.abortSignal,
    });
    if (res.status === 401) {
      await res.body?.cancel();
      throw new ConnectionRejectedError(
        call.connection,
        `${call.entry.name} refused the connection's token.`,
      );
    }
    if (attempt >= MAX_TRIES || !busy(res, method)) return res;
    const waitMs = retryAfterMs(res) ?? BACKOFF_MS * 2 ** (attempt - 1);
    if (waitMs > MAX_WAIT_MS) return res;
    await res.body?.cancel();
    await sleep(waitMs, ctx.abortSignal);
  }
}

/**
 * The call's headers with the connection's token as the only `Authorization`:
 * a caller's own, in any case, would be sent joined to it.
 */
function withToken(
  headers: Readonly<Record<string, string>> | undefined,
  token: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {}))
    if (name.toLowerCase() !== 'authorization') out[name] = value;
  out.authorization = `Bearer ${token}`;
  return out;
}

/** The app asks for the call again later, and nothing was done. */
function busy(res: Response, method: string): boolean {
  if (res.status === 429) return true;
  if (res.status === 503) return method === 'GET';
  // GitHub answers a spent rate limit with a 403 that says so in its headers.
  return (
    res.status === 403 &&
    (res.headers.has('retry-after') || res.headers.get('x-ratelimit-remaining') === '0')
  );
}

/** How long the app asks to wait: `Retry-After` (seconds or a date), else GitHub's reset time. */
function retryAfterMs(res: Response): number | undefined {
  const after = res.headers.get('retry-after');
  if (after !== null) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now());
  }
  return undefined;
}

/** Takes the call's cost from each of the entry's buckets for this connection, waiting as needed. */
async function take(
  entry: AppEntry,
  connectionId: string,
  toolId: string,
  signal: AbortSignal,
): Promise<void> {
  for (const [i, limit] of (entry.rateLimits ?? []).entries()) {
    // A call that costs more than the bucket holds could never go: it takes a full bucket.
    const cost = Math.min(limit.costs?.[toolId] ?? 1, limit.units);
    const key = `${entry.id}\u0000${connectionId}\u0000${i}`;
    for (;;) {
      const b = refilled(key, limit, Date.now());
      if (b.units >= cost) {
        b.units -= cost;
        b.fullAtMs = b.atMs + msFor(limit.units - b.units, limit);
        break;
      }
      await sleep(Math.ceil(msFor(cost - b.units, limit)), signal);
    }
  }
}

function msFor(units: number, limit: AppRateLimit): number {
  return (units * limit.perSeconds * 1000) / limit.units;
}

function refilled(key: string, limit: AppRateLimit, nowMs: number): Bucket {
  const b = buckets.get(key);
  if (b !== undefined) {
    b.units = Math.min(
      limit.units,
      b.units + ((nowMs - b.atMs) * limit.units) / (limit.perSeconds * 1000),
    );
    b.atMs = nowMs;
    return b;
  }
  if (buckets.size >= MAX_BUCKETS) prune(nowMs);
  const fresh: Bucket = { units: limit.units, atMs: nowMs, fullAtMs: nowMs };
  buckets.set(key, fresh);
  return fresh;
}

/** Drops buckets that are full again (as good as new), else the oldest. */
function prune(nowMs: number): void {
  for (const [key, b] of buckets) if (b.fullAtMs <= nowMs) buckets.delete(key);
  for (const key of buckets.keys()) {
    if (buckets.size < MAX_BUCKETS) break;
    buckets.delete(key);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

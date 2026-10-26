// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The call behind `appFetch` (`./app-fetch.ts`, which says what it does),
 * for callers with no tool context too: the mail functions call with the
 * token and `fetch` a runtime gives them. Not a package subpath. Every
 * caller in this process shares its rate-limit buckets, so a mailbox's
 * poll and its tools draw on one quota.
 */

import { ConnectionRejectedError } from '@kindgi/tools';

import type { AppCall } from './app-fetch.js';
import type { MailCall } from './mail.js';
import type { AppEntry, AppRateLimit } from './types.js';

/** Whose call it is, and how it goes out. */
export interface AppCaller {
  /** The tool's name for the connection, which a 401's `ConnectionRejectedError` names. */
  readonly connection: string;
  /** Its rate-limit buckets are this connection's. */
  readonly connectionId: string;
  /** Sent as `Authorization: Bearer`, and in no error. */
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly abortSignal?: AbortSignal;
}

/**
 * The app answered with a status other than OK and other than a 401
 * (`ConnectionRejectedError`): its status, its reason code when it gives
 * one, and a message in the app's own words, for a tool's model. The mail
 * calls throw it as a `MailCallError`, without the words (`mailCalls`).
 */
export class AppRefused extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
  }
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
 * How a call goes out: a tool's `appFetch` with its context, or
 * `appRequest` with a mail call's token. Both pace by the entry's rate
 * limits.
 */
export type AppSend = (call: AppCall) => Promise<Response>;

/** A mail function's calls: with the token, `fetch` and signal it was given. */
export function mailSend(mail: MailCall): AppSend {
  const caller: AppCaller = {
    connection: 'mail',
    connectionId: mail.connectionId,
    token: mail.token,
    fetch: mail.fetch,
    ...(mail.abortSignal !== undefined && { abortSignal: mail.abortSignal }),
  };
  return (call) => appRequest(caller, call);
}

/** `call` as `caller`: paced, tried again while the app is busy, a 401 thrown (see `appFetch`). */
export async function appRequest(caller: AppCaller, call: AppCall): Promise<Response> {
  // Called on its own, not as the caller's method.
  const send = caller.fetch;
  const method = call.method ?? 'GET';
  for (let attempt = 1; ; attempt++) {
    await take(call.entry, caller.connectionId, call.toolId, caller.abortSignal);
    const res = await send(call.url, {
      method,
      headers: withToken(call.headers, caller.token),
      ...(call.body !== undefined && { body: call.body }),
      ...(caller.abortSignal !== undefined && { signal: caller.abortSignal }),
    });
    if (res.status === 401) {
      await res.body?.cancel();
      throw new ConnectionRejectedError(
        caller.connection,
        `${call.entry.name} refused the connection's token.`,
      );
    }
    if (attempt >= MAX_TRIES || !(await busy(res, method))) return res;
    const waitMs = retryAfterMs(res) ?? BACKOFF_MS * 2 ** (attempt - 1);
    if (waitMs > MAX_WAIT_MS) return res;
    await res.body?.cancel();
    await sleep(waitMs, caller.abortSignal);
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
async function busy(res: Response, method: string): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status === 503) return method === 'GET';
  if (res.status !== 403) return false;
  // GitHub answers a spent rate limit with a 403 that says so in its headers.
  if (res.headers.has('retry-after') || res.headers.get('x-ratelimit-remaining') === '0')
    return true;
  // Google says so in the 403's body, read from a copy so that any other 403 reaches the tool unread.
  const body = await res
    .clone()
    .text()
    .catch(() => '');
  return googleRateLimited(body);
}

/** Google's 403 reasons for a rate limit that waiting ends (a daily quota isn't one). */
const GOOGLE_RATE_LIMITS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

function googleRateLimited(body: string): boolean {
  try {
    const errors = (JSON.parse(body) as { error?: { errors?: unknown } } | null)?.error?.errors;
    return (
      Array.isArray(errors) &&
      errors.some((e: { reason?: unknown } | null) => {
        const reason = e?.reason;
        return typeof reason === 'string' && GOOGLE_RATE_LIMITS.has(reason);
      })
    );
  } catch {
    return false;
  }
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
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const [i, limit] of (entry.rateLimits ?? []).entries()) {
    // A call that costs more than the bucket holds could never go: it takes a full bucket.
    const cost = Math.min(limit.costs?.[toolId] ?? 1, limit.units);
    if (cost === 0) continue;
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

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, ms);
      return;
    }
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

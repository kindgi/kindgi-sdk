// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Waiting out the server's rate limits, for the commands that publish
 * (`kindgi deploy`, `flows publish`, `agents publish`, `blocks publish`).
 *
 * The server answers its rate limits with `429 rate-limit-exceeded`. A
 * `429` with a `Retry-After` means "not now": nothing was stored, so the
 * command waits that long and sends the same request again, saying so on
 * stderr, one line per wait. Through the client, that's any `rate-limited`
 * error with `retryAfterSeconds` (the client maps every `429` to it);
 * `kindgi deploy` also checks the code. A refusal without a wait, and
 * every other error, comes back as it is.
 *
 * The waiting adds up, on the clock, to at most `RATE_LIMIT_WAIT_CAP_MS`
 * per call; each of these commands makes one such call. When the next
 * wait would take it past that, or Ctrl+C stops a wait, the last refusal
 * comes back, and the command fails with it as it would have without
 * waiting.
 */

import { extractKindgiError } from './errors.js';

/** The most a command waits on the server's rate limits, all its waits together. */
export const RATE_LIMIT_WAIT_CAP_MS = 10 * 60 * 1000;

/** A refusal the server says to wait out: how long, and the limit it named. */
export interface RateLimitRefusal {
  /** The `Retry-After`, in seconds. */
  readonly retryAfterSeconds: number;
  /** Which limit refused it (the wire's `details.limit`), when the server named one. */
  readonly limit?: string;
}

/** The waiting's sleep, clock and output: tests inject them; production leaves them out. */
export interface RateLimitWaitSeam {
  /** Wait `ms`, or until `signal` aborts. Default: a timer. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The clock the waiting is measured on, in milliseconds. Default: `performance.now()`. */
  readonly now?: () => number;
  /** Where each wait's line goes. Default: stderr, as it happens. */
  readonly write?: (line: string) => void;
}

/** What a command passes: its seam, and its stop signal (Ctrl+C), which ends a wait. */
export interface RateLimitWaitContext {
  readonly rateLimitWaits?: RateLimitWaitSeam | undefined;
  readonly stopSignal?: AbortSignal | undefined;
}

/**
 * Send, and send again after each refusal `refusalOf` finds in the answer,
 * once its wait is over. The answer that isn't such a refusal, or the
 * refusal the waiting stopped at, is returned.
 */
export async function sendWaitingOutRateLimits<T>(
  ctx: RateLimitWaitContext,
  send: () => Promise<T>,
  refusalOf: (answer: T) => RateLimitRefusal | undefined,
): Promise<T> {
  const sleep = ctx.rateLimitWaits?.sleep ?? sleepFor;
  const now = ctx.rateLimitWaits?.now ?? (() => performance.now());
  const write =
    ctx.rateLimitWaits?.write ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const signal = ctx.stopSignal;
  const stopped = (): boolean => signal?.aborted === true;
  let waitedMs = 0;
  for (;;) {
    const answer = await send();
    const refusal = refusalOf(answer);
    if (refusal === undefined || stopped()) return answer;
    // Whole seconds, at least one: a `Retry-After: 0` can't make it send in a loop.
    const seconds = Math.max(1, Math.ceil(refusal.retryAfterSeconds));
    if (waitedMs + seconds * 1000 > RATE_LIMIT_WAIT_CAP_MS) return answer;
    write(waitLine(refusal.limit, seconds));
    const start = now();
    await sleep(seconds * 1000, signal);
    waitedMs += now() - start;
    if (stopped()) return answer;
  }
}

/**
 * A client call, made again after each `rate-limited` error that says how
 * long to wait (`retryAfterSeconds`). Any other error, or the refusal the
 * waiting stopped at, is thrown as the call threw it.
 */
export async function callWaitingOutRateLimits<T>(
  ctx: RateLimitWaitContext,
  call: () => Promise<T>,
): Promise<T> {
  const outcome = await sendWaitingOutRateLimits(
    ctx,
    async (): Promise<{ readonly value: T } | { readonly thrown: unknown }> => {
      try {
        return { value: await call() };
      } catch (thrown) {
        return { thrown };
      }
    },
    (answer) => ('thrown' in answer ? clientRefusal(answer.thrown) : undefined),
  );
  if ('thrown' in outcome) throw outcome.thrown;
  return outcome.value;
}

/** A client error the server says to wait out: `rate-limited` (any `429`), with `retryAfterSeconds`. */
export function clientRefusal(thrown: unknown): RateLimitRefusal | undefined {
  const error = extractKindgiError(thrown);
  if (error?.code !== 'rate-limited' || !isWait(error.retryAfterSeconds)) return undefined;
  return {
    retryAfterSeconds: error.retryAfterSeconds,
    ...(error.limit !== undefined && { limit: error.limit }),
  };
}

/** A `Retry-After` the command can wait: a finite number of seconds, not below zero. */
export function isWait(seconds: number | undefined): seconds is number {
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0;
}

/** The line a wait prints: the limit, when the server named one, and the seconds. */
export function waitLine(limit: string | undefined, seconds: number): string {
  const what = limit !== undefined ? `${limit} limit` : 'rate limit';
  return `The server's ${what} is reached: sending it again in ${seconds}s.\n`;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

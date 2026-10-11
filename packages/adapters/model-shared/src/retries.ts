// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Our retry policy around one send that makes one HTTP attempt: retryable failures (408, 409,
 * 429, 5xx, no response) are retried up to `attempts` in all, waiting what the vendor asks
 * (`retry-after-ms`, `retry-after`) or backing off exponentially with jitter. A vendor asking
 * for more than 60 s ends the call at once, its wait in the message. An abort, in flight or
 * during a wait, rejects with the caller's reason. Library-free: the engine says what a
 * failure looks like (`describe`).
 */

import type { FailedResponse } from './errors.js';

/** A failure as the policy needs it. */
export interface RetryableFailure extends FailedResponse {
  readonly retryable: boolean;
  /** Attempts in all for this failure, when fewer than the policy's (an unreadable answer: 2). */
  readonly maxAttempts?: number;
  /** Response headers, for `retry-after(-ms)`. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

/** `F`: the engine's own description of a failure, handed back to `toError` as `describe` made it. */
export interface RetryPolicy<F extends RetryableFailure = RetryableFailure> {
  /** HTTP attempts in all. */
  readonly attempts: number;
  readonly signal?: AbortSignal;
  /** What a thrown error was. */
  readonly describe: (error: unknown) => F;
  /** The error to throw once the policy gives up. */
  readonly toError: (failure: F, error: unknown) => Error;
}

export async function withRetries<T, F extends RetryableFailure = RetryableFailure>(
  send: () => PromiseLike<T>,
  policy: RetryPolicy<F>,
): Promise<T> {
  const { signal } = policy;
  // A call, not a narrowed property: the signal can abort during any await.
  const stopped = () => signal?.aborted === true;
  for (let attempt = 1; ; attempt += 1) {
    // Stopped before this attempt (already, or during the wait): no attempt at all.
    if (stopped()) throw signal?.reason;
    try {
      return await send();
    } catch (error) {
      // Stopped by the caller: its reason, whether the abort landed in flight or between
      // attempts.
      if (stopped()) throw signal?.reason ?? error;
      if ((error as Error)?.name === 'AbortError') throw error;
      const failure = policy.describe(error);
      const attempts = Math.min(policy.attempts, failure.maxAttempts ?? policy.attempts);
      if (!failure.retryable || attempt >= attempts) throw policy.toError(failure, error);
      // A vendor that asks for longer than we wait: give up now, saying how long it asked,
      // rather than retry early into a limit it named.
      const asked = vendorWaitMs(failure.headers ?? {});
      if (asked !== undefined && asked > MAX_VENDOR_WAIT_MS) {
        const words = `${failure.words} (the vendor asks to wait ${Math.ceil(asked / 1000)} s)`;
        throw policy.toError({ ...failure, words }, error);
      }
      await sleep(backoffMs(failure.headers ?? {}, attempt), signal);
    }
  }
}

/** The longest wait a vendor may ask for that's still worth a retry within the call. */
export const MAX_VENDOR_WAIT_MS = 60_000;

/** What the vendor asked to wait (`retry-after-ms`, else `retry-after` in seconds), when it did. */
export function vendorWaitMs(
  headers: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const ms = Number(headers['retry-after-ms']);
  if (headers['retry-after-ms'] !== undefined && Number.isFinite(ms) && ms >= 0) return ms;
  const s = Number(headers['retry-after']);
  if (headers['retry-after'] !== undefined && Number.isFinite(s) && s >= 0) return s * 1000;
  return undefined;
}

/** What the vendor asked for, else exponential with jitter: 1–2 s, 2–4 s, … */
export function backoffMs(
  headers: Readonly<Record<string, string | undefined>>,
  attempt: number,
): number {
  const asked = vendorWaitMs(headers);
  if (asked !== undefined && asked <= MAX_VENDOR_WAIT_MS) return asked;
  return 1000 * 2 ** (attempt - 1) * (1 + Math.random());
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    // The listener goes when the wait ends, so a run-long signal doesn't gather one per wait.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

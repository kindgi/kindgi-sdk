// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Our retry policy around one send that makes one HTTP attempt: retryable failures (408, 409,
 * 429, 5xx, no response) are retried up to `attempts` in all, waiting what the vendor asks
 * (`retry-after-ms`, `retry-after`, up to 60 s) or backing off exponentially with jitter. An
 * abort, in flight or during a wait, rejects with the caller's reason. Library-free: the
 * engine says what a failure looks like (`describe`).
 */

import type { FailedResponse } from './errors.js';

/** A failure as the policy needs it. */
export interface RetryableFailure extends FailedResponse {
  readonly retryable: boolean;
  /** Response headers, for `retry-after(-ms)`. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

export interface RetryPolicy {
  /** HTTP attempts in all. */
  readonly attempts: number;
  readonly signal?: AbortSignal;
  /** What a thrown error was. */
  readonly describe: (error: unknown) => RetryableFailure;
  /** The error to throw once the policy gives up. */
  readonly toError: (failure: RetryableFailure, error: unknown) => Error;
}

export async function withRetries<T>(send: () => PromiseLike<T>, policy: RetryPolicy): Promise<T> {
  const { signal } = policy;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      // Stopped by the caller: its reason, whether the abort landed in flight or between
      // attempts.
      if (signal?.aborted === true) throw signal.reason ?? error;
      if ((error as Error)?.name === 'AbortError') throw error;
      const failure = policy.describe(error);
      if (!failure.retryable || attempt >= policy.attempts) throw policy.toError(failure, error);
      await sleep(backoffMs(failure.headers ?? {}, attempt), signal);
    }
  }
}

/** What the vendor asked for, else exponential with jitter: 1–2 s, 2–4 s, … */
export function backoffMs(
  headers: Readonly<Record<string, string | undefined>>,
  attempt: number,
): number {
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0 && ms <= 60_000) return ms;
  const s = Number(headers['retry-after']);
  if (Number.isFinite(s) && s >= 0 && s <= 60) return s * 1000;
  return 1000 * 2 ** (attempt - 1) * (1 + Math.random());
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

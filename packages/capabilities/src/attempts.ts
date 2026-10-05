// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Counts each model call's HTTP attempts, retries included, without
 * taking over the vendor SDK's retry policy (its `Retry-After` handling,
 * its backoff). An adapter gives its SDK client `fetch`, and runs each
 * call inside `count`: every request the SDK sends for that call, the
 * first and each retry, goes through `fetch` and is counted for it.
 * Calls running at the same time are counted apart.
 *
 * A call that throws throws its own error, unchanged (callers may check
 * its type or status); the attempts it took are `attemptsOf(error)`.
 *
 * Node only (`AsyncLocalStorage`): it's the `@kindgi/capabilities/attempts`
 * entry, apart from the package's runtime-neutral main entry.
 */
export interface AttemptCounter {
  /** The `fetch` the SDK client sends with: counts, then sends with `inner`. */
  readonly fetch: typeof globalThis.fetch;
  /** Run one call; its result, and the HTTP attempts it took. */
  count<T>(call: () => PromiseLike<T>): Promise<{ readonly value: T; readonly attempts: number }>;
}

/** The attempts of counted calls that threw, by their error (`attemptsOf`). */
const failedAttempts = new WeakMap<object, number>();

/**
 * An `AttemptCounter` over `inner`. Without one, it sends with the global
 * `fetch` as it is at each request, so a `fetch` patched after the
 * provider was built (a test's mock, a tracer) still sees the requests.
 */
export function createAttemptCounter(inner?: typeof globalThis.fetch): AttemptCounter {
  const calls = new AsyncLocalStorage<{ attempts: number }>();
  return {
    fetch: (input, init) => {
      const call = calls.getStore();
      if (call !== undefined) call.attempts += 1;
      return (inner ?? globalThis.fetch)(input, init);
    },
    async count(call) {
      const state = { attempts: 0 };
      try {
        // Awaited inside the store: an SDK's promise can be lazy (OpenAI's
        // `APIPromise` sends, and retries a body that stalls, only when
        // it's awaited), and those requests are this call's too.
        const value = await calls.run(state, async () => await call());
        return { value, attempts: state.attempts };
      } catch (error) {
        if (typeof error === 'object' && error !== null && state.attempts > 0) {
          failedAttempts.set(error, state.attempts);
        }
        throw error;
      }
    },
  };
}

/**
 * The HTTP attempts a counted call took before it threw `error`;
 * `undefined` when it wasn't counted, or sent nothing.
 */
export function attemptsOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null ? failedAttempts.get(error) : undefined;
}

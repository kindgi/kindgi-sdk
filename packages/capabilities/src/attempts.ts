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
 */
export interface AttemptCounter {
  /** The `fetch` the SDK client sends with: counts, then sends with `inner`. */
  readonly fetch: typeof globalThis.fetch;
  /** Run one call; its result, and the HTTP attempts it took. */
  count<T>(call: () => Promise<T>): Promise<{ readonly value: T; readonly attempts: number }>;
}

/** An `AttemptCounter` over `inner` (default: the global `fetch`). */
export function createAttemptCounter(
  inner: typeof globalThis.fetch = globalThis.fetch,
): AttemptCounter {
  const calls = new AsyncLocalStorage<{ attempts: number }>();
  return {
    fetch: (input, init) => {
      const call = calls.getStore();
      if (call !== undefined) call.attempts += 1;
      return inner(input, init);
    },
    async count(call) {
      const state = { attempts: 0 };
      const value = await calls.run(state, call);
      return { value, attempts: state.attempts };
    },
  };
}

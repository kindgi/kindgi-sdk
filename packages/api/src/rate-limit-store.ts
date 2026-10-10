// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Counts for a rate limit, in a window per key. `take` is one atomic step,
 * so a window's first `limit` callers get through however they arrive.
 *
 * The default (`createInMemoryRateLimitStore`) counts in this process: with
 * several instances, each counts on its own, so N instances let N × `limit`
 * through. A deployment with several instances passes one they share (the
 * Kindgi runtime's counts in Postgres).
 */
export interface RateLimitStore {
  /**
   * One from `key`'s window: allowed while the window holds fewer than
   * `limit`. A window opens at its key's first take and lasts `windowMs`;
   * once it ends, the next take opens a new one. Refused: how long until
   * the window ends.
   */
  take(input: RateLimitTakeInput): Promise<RateLimitTake>;
}

export interface RateLimitTakeInput {
  /** The client, namespaced by its caller (e.g. `sign-in-options:<client>`). */
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

export type RateLimitTake =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Until the window ends (a `Retry-After`). */
      readonly retryAfterMs: number;
    };

/** The most keys the in-memory store tracks before it drops ended windows. */
const MAX_TRACKED_KEYS = 10_000;

/** Counts in this process: one instance's own (see `RateLimitStore`). */
export function createInMemoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const windows = new Map<string, { start: number; count: number; windowMs: number }>();

  function prune(at: number): void {
    for (const [k, w] of windows) {
      if (at - w.start >= w.windowMs) windows.delete(k);
    }
    // Still full: every key is mid-window. Drop the oldest half rather than
    // grow without bound.
    if (windows.size >= MAX_TRACKED_KEYS) {
      const keys = [...windows.keys()].slice(0, Math.floor(MAX_TRACKED_KEYS / 2));
      for (const k of keys) windows.delete(k);
    }
  }

  return {
    async take({ key, limit, windowMs }) {
      const at = now();
      const open = windows.get(key);
      if (open === undefined || at - open.start >= open.windowMs) {
        if (windows.size >= MAX_TRACKED_KEYS) prune(at);
        windows.set(key, { start: at, count: 1, windowMs });
        return { allowed: true };
      }
      if (open.count >= limit) {
        return { allowed: false, retryAfterMs: open.start + open.windowMs - at };
      }
      open.count += 1;
      return { allowed: true };
    },
  };
}

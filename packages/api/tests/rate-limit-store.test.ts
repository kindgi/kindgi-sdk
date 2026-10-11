// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `createInMemoryRateLimitStore`: a window per key, opened by its first
 * take and lasting `windowMs`; the first `limit` takes get through, then
 * the rest are refused with the time left, until the window ends.
 */

import { describe, expect, test } from 'vitest';

import { createInMemoryRateLimitStore } from '../src/index.js';

describe('the in-memory rate-limit store', () => {
  test('the first `limit` takes get through; then refused until the window ends', async () => {
    let now = 1_000_000;
    const store = createInMemoryRateLimitStore(() => now);
    const take = () => store.take({ key: 'k', limit: 2, windowMs: 60_000 });
    expect(await take()).toEqual({ allowed: true });
    now += 10_000;
    expect(await take()).toEqual({ allowed: true });
    now += 5_000;
    expect(await take()).toEqual({ allowed: false, retryAfterMs: 45_000 });
    now = 1_000_000 + 60_000;
    expect(await take()).toEqual({ allowed: true });
  });

  test('each key has its own window', async () => {
    const store = createInMemoryRateLimitStore(() => 0);
    expect(await store.take({ key: 'a', limit: 1, windowMs: 1_000 })).toEqual({ allowed: true });
    expect((await store.take({ key: 'a', limit: 1, windowMs: 1_000 })).allowed).toBe(false);
    expect(await store.take({ key: 'b', limit: 1, windowMs: 1_000 })).toEqual({ allowed: true });
  });
});

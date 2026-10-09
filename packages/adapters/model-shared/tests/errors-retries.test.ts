// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The library-free parts: what a failure is, and how long to wait before the next attempt. */

import { describe, expect, test } from 'vitest';

import { ModelProviderError, backoffMs, kindOf, modelProviderError } from '../src/index.js';

describe('kindOf', () => {
  test.each([
    [{ words: 'socket hang up' }, 'network'],
    [{ status: 401, words: '{}' }, 'auth'],
    [{ status: 403, words: '{}' }, 'auth'],
    [{ status: 429, words: '{}' }, 'rate-limited'],
    [{ status: 502, words: '{}' }, 'unavailable'],
    [
      { status: 400, words: '{"message":"Input is too long for requested model."}' },
      'context-too-long',
    ],
    [{ status: 400, words: '{"code":"content_filter"}' }, 'content-filter'],
    [
      { status: 400, words: 'The response was filtered due to the content management policy.' },
      'content-filter',
    ],
    [{ status: 422, words: '{"message":"bad field"}' }, 'invalid-request'],
  ] as const)('%j → %s', (failure, kind) => {
    expect(kindOf(failure)).toBe(kind);
  });
});

test('modelProviderError: the status, then the vendor’s words; the cause kept', () => {
  const cause = new Error('raw');
  const err = modelProviderError({ status: 401, words: '{"message":"invalid key"}' }, cause);
  expect(err).toBeInstanceOf(ModelProviderError);
  expect(err).toMatchObject({
    kind: 'auth',
    status: 401,
    message: '401 {"message":"invalid key"}',
  });
  expect(err.cause).toBe(cause);
  expect(modelProviderError({ words: 'fetch failed' }, cause).message).toBe('fetch failed');
});

describe('backoffMs', () => {
  test('the vendor’s retry-after-ms, then retry-after in seconds, each up to 60 s', () => {
    expect(backoffMs({ 'retry-after-ms': '250' }, 1)).toBe(250);
    expect(backoffMs({ 'retry-after': '3' }, 1)).toBe(3000);
    expect(backoffMs({ 'retry-after-ms': '0' }, 1)).toBe(0);
  });

  test('past 60 s, or none: exponential with jitter (1–2 s, then 2–4 s)', () => {
    for (const headers of [{}, { 'retry-after': '600' }, { 'retry-after-ms': '90000' }]) {
      const first = backoffMs(headers, 1);
      expect(first).toBeGreaterThanOrEqual(1000);
      expect(first).toBeLessThan(2000);
      const second = backoffMs(headers, 2);
      expect(second).toBeGreaterThanOrEqual(2000);
      expect(second).toBeLessThan(4000);
    }
  });
});

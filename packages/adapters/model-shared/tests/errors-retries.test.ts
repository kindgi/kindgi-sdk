// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The library-free parts: what a failure is, and how long to wait before the next attempt. */

import { describe, expect, test, vi } from 'vitest';

import {
  ModelProviderError,
  type RetryableFailure,
  backoffMs,
  kindOf,
  modelProviderError,
  vendorWaitMs,
  withRetries,
} from '../src/index.js';

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
    // A vendor timing out isn't a context that's too long (Bedrock's ModelTimeoutException).
    [{ status: 408, words: 'The request took too long to process' }, 'unavailable'],
    [{ status: 413, words: '{"message":"Prompt is too long"}' }, 'context-too-long'],
    // The words decide only for 400, 413 and 422.
    [{ status: 404, words: '{"message":"no model exceeds this name"}' }, 'invalid-request'],
    // A conflict the vendor says to retry; Bedrock's ModelErrorException.
    [{ status: 409, words: '{}' }, 'unavailable'],
    [{ status: 424, words: '{"message":"The model failed"}' }, 'unavailable'],
    // The vendors' words for a prompt too long, and not every mention of context.
    [
      { status: 400, words: "This model's maximum context length is 128000 tokens." },
      'context-too-long',
    ],
    [{ status: 400, words: '{"code":"context_length_exceeded"}' }, 'context-too-long'],
    [
      {
        status: 400,
        words: 'The input token count (1200000) exceeds the maximum number of tokens allowed.',
      },
      'context-too-long',
    ],
    [{ status: 400, words: "Invalid value for 'context': expected an object." }, 'invalid-request'],
    [{ status: 400, words: 'max_tokens exceeds the limit for this model' }, 'invalid-request'],
    // The engine's own kind, where no status says it.
    [{ kind: 'unavailable', words: 'Invalid JSON response' }, 'unavailable'],
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

test('vendorWaitMs: retry-after-ms first, then retry-after in seconds; none, or not a number', () => {
  expect(vendorWaitMs({ 'retry-after-ms': '250', 'retry-after': '9' })).toBe(250);
  expect(vendorWaitMs({ 'retry-after': '120' })).toBe(120_000);
  expect(vendorWaitMs({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })).toBeUndefined();
  expect(vendorWaitMs({})).toBeUndefined();
});

describe('withRetries', () => {
  const failing = (failure: RetryableFailure) => {
    const send = vi.fn(async () => {
      throw new Error('failed');
    });
    const policy = {
      attempts: 3,
      describe: () => failure,
      toError: (f: RetryableFailure) => new Error(f.words),
    };
    return { send, policy };
  };

  test('a vendor asking for more than 60 s: no retry, the wait it asked in the message', async () => {
    const { send, policy } = failing({
      status: 429,
      words: 'slow down',
      retryable: true,
      headers: { 'retry-after': '120' },
    });
    await expect(withRetries(send, policy)).rejects.toThrow(
      'slow down (the vendor asks to wait 120 s)',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("a failure's own cap: fewer attempts than the policy's", async () => {
    const { send, policy } = failing({
      kind: 'unavailable',
      words: 'unreadable',
      retryable: true,
      maxAttempts: 2,
      headers: { 'retry-after-ms': '0' },
    });
    await expect(withRetries(send, policy)).rejects.toThrow('unreadable');
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('each wait takes its abort listener away when it ends', async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('503');
        return 'ok';
      },
      {
        attempts: 3,
        signal: controller.signal,
        describe: () => ({
          status: 503,
          words: '503',
          retryable: true,
          headers: { 'retry-after-ms': '0' },
        }),
        toError: (f) => new Error(f.words),
      },
    );
    expect(result).toBe('ok');
    expect(added).toHaveBeenCalledTimes(2);
    expect(removed.mock.calls).toEqual(
      added.mock.calls.map(([type, listener]) => [type, listener]),
    );
  });
});

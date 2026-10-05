// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { attemptsOf, createAttemptCounter } from '../src/attempts.js';

/** A `fetch` that fails the first `failures` requests of each call it's told about. */
function flakyFetch(failuresByUrl: Map<string, number>): typeof globalThis.fetch {
  return async (input) => {
    const url = String(input);
    const left = failuresByUrl.get(url) ?? 0;
    if (left > 0) {
      failuresByUrl.set(url, left - 1);
      return new Response('overloaded', { status: 529 });
    }
    return new Response('ok', { status: 200 });
  };
}

/** What an SDK does: retry while the answer is retryable, waiting between tries. */
async function sdkCall(fetch: typeof globalThis.fetch, url: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url);
    if (response.status !== 529 || attempt === 3) return response.text();
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('createAttemptCounter', () => {
  test("counts each call's attempts, retries included, apart from calls running at the same time", async () => {
    const counter = createAttemptCounter(
      flakyFetch(
        new Map([
          ['https://vendor.test/a', 2],
          ['https://vendor.test/b', 0],
        ]),
      ),
    );
    const [a, b] = await Promise.all([
      counter.count(() => sdkCall(counter.fetch, 'https://vendor.test/a')),
      counter.count(() => sdkCall(counter.fetch, 'https://vendor.test/b')),
    ]);
    expect(a).toEqual({ value: 'ok', attempts: 3 });
    expect(b).toEqual({ value: 'ok', attempts: 1 });
  });

  test('a lazy call (it sends when awaited, and retries from there) is counted whole', async () => {
    // OpenAI's `APIPromise` shape: nothing is sent until `then`, and a
    // body that stalls is retried from inside that step.
    const counter = createAttemptCounter(flakyFetch(new Map([['https://vendor.test/lazy', 1]])));
    const lazy = (): PromiseLike<string> => ({
      // biome-ignore lint/suspicious/noThenProperty: a thenable is the point
      then(onFulfilled, onRejected) {
        return sdkCall(counter.fetch, 'https://vendor.test/lazy').then(onFulfilled, onRejected);
      },
    });
    expect(await counter.count(lazy)).toEqual({ value: 'ok', attempts: 2 });
  });

  test('a call that throws keeps its own error; its attempts are attemptsOf(error)', async () => {
    const counter = createAttemptCounter(flakyFetch(new Map([['https://vendor.test/down', 99]])));
    const overloaded = new Error('overloaded');
    const failing = async () => {
      if ((await sdkCall(counter.fetch, 'https://vendor.test/down')) === 'overloaded') {
        throw overloaded;
      }
    };
    const thrown = await counter.count(failing).catch((error: unknown) => error);
    expect(thrown).toBe(overloaded);
    expect(attemptsOf(thrown)).toBe(4);
    expect(attemptsOf(new Error('never counted'))).toBeUndefined();
    expect(attemptsOf('a string')).toBeUndefined();
  });

  test('without an inner fetch, it sends with the global fetch as it is at each request', async () => {
    const counter = createAttemptCounter();
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('patched later', { status: 200 });
    try {
      const counted = await counter.count(async () =>
        (await counter.fetch('https://vendor.test/late')).text(),
      );
      expect(counted).toEqual({ value: 'patched later', attempts: 1 });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a request outside a counted call is sent, and counted nowhere', async () => {
    const counter = createAttemptCounter(flakyFetch(new Map()));
    expect(await (await counter.fetch('https://vendor.test/c')).text()).toBe('ok');
  });
});

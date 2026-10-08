// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The SDK's own retry, with the real `@google/genai` client: it retries
 * only when the provider gives it `retryOptions`. The Developer API
 * client (an API key) sends through the global `fetch`, replaced here by
 * a fixture, so no network is needed. The SDK's backoff waits run at
 * once, on real timers: fake ones would lose the call's context, and its
 * attempts with it.
 */

import { attemptsOf } from '@kindgi/capabilities/attempts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type GeminiProviderOptions, createGeminiProvider } from '../src/index.js';

const METADATA: GeminiProviderOptions['metadata'] = {
  id: 'gemini-api',
  region: 'unspecified',
  models: [
    {
      name: 'gemini-3.8-flash',
      contextWindow: 1_048_576,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.00075, completionUsdPer1kTokens: 0.00375 },
    },
  ],
};

const ANSWER = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
  modelVersion: 'gemini-3.8-flash-001',
};

const unavailable = () =>
  Response.json(
    { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } },
    { status: 503 },
  );

let statuses: number[] = [];
const original = globalThis.fetch;

/**
 * Answers each request with the next status in `sequence`; 200 is the
 * answer, 0 a failed connection. An aborted request throws, as `fetch` does.
 */
function serve(...sequence: number[]): void {
  statuses = [];
  globalThis.fetch = async (_input, init) => {
    init?.signal?.throwIfAborted();
    const status = sequence[statuses.length] ?? 200;
    statuses.push(status);
    if (status === 0) throw new TypeError('fetch failed');
    if (status === 200) return Response.json(ANSWER);
    if (status === 503) return unavailable();
    return Response.json({ error: { code: status, message: 'refused' } }, { status });
  };
}

const call = (abortSignal?: AbortSignal) =>
  createGeminiProvider({ metadata: METADATA, apiKey: () => 'test-key' }).invoke({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hi' }],
    ...(abortSignal !== undefined && { abortSignal }),
  });

/** The backoff delays the SDK asked for, in ms. */
let delays: number[] = [];
/** Runs as each backoff starts. */
let onBackoff: (() => void) | undefined;
beforeEach(() => {
  delays = [];
  onBackoff = undefined;
  const later = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms?: number) => {
    if (ms === undefined || ms < 1_000) return later(run, ms);
    delays.push(ms);
    onBackoff?.();
    return later(run, 0);
  }) as typeof globalThis.setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = original;
});

describe('createGeminiProvider: the SDK retries transient failures', () => {
  test('a 503, then the answer: the call succeeds, and both attempts are counted', async () => {
    serve(503, 200);
    const result = await call();
    expect(statuses).toEqual([503, 200]);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    expect(result.message.content).toBe('done');
    expect(result.attempts).toBe(2);
    expect(result.servedModel).toBe('gemini-3.8-flash-001');
  });

  test('a 503 on every attempt: three attempts, then the 503 is thrown', async () => {
    serve(503, 503, 503, 503, 503);
    const thrown = await call().catch((error: unknown) => error);
    expect(statuses).toEqual([503, 503, 503]);
    expect(delays).toHaveLength(2);
    expect((thrown as { status?: number }).status).toBe(503);
    expect(attemptsOf(thrown)).toBe(3);
  });

  test('a 400 is not retried', async () => {
    serve(400, 200);
    const thrown = await call().catch((error: unknown) => error);
    expect(statuses).toEqual([400]);
    expect(delays).toEqual([]);
    expect((thrown as { status?: number }).status).toBe(400);
    expect(attemptsOf(thrown)).toBe(1);
  });

  test('a failed connection is not retried (the SDK retries statuses only)', async () => {
    serve(0, 200);
    const thrown = await call().catch((error: unknown) => error);
    expect(statuses).toEqual([0]);
    expect(delays).toEqual([]);
    expect((thrown as Error).message).toBe('fetch failed');
  });

  test('a call aborted as a 503 comes back throws the 503, without backing off', async () => {
    serve(503, 200);
    const controller = new AbortController();
    const answer = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await answer(input, init);
      controller.abort();
      return response;
    };
    const thrown = await call(controller.signal).catch((error: unknown) => error);
    expect(statuses).toEqual([503]);
    expect(delays).toEqual([]);
    expect((thrown as { status?: number }).status).toBe(503);
  });

  test('a call aborted while the SDK backs off sends nothing more', async () => {
    serve(503, 200);
    const controller = new AbortController();
    onBackoff = () => controller.abort();
    const thrown = await call(controller.signal).catch((error: unknown) => error);
    expect(statuses).toEqual([503]);
    expect(delays).toHaveLength(1);
    expect((thrown as Error).name).toBe('AbortError');
  });
});

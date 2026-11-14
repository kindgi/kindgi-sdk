// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A failed call is the shared typed error (`ModelProviderError`): its kind
 * from the status and the vendor's words (the response's body), its
 * message the SDK's own, byte for byte, and the SDK's `ApiError` its
 * `cause`. A failed connection is `network`, the SDK's `fetch failed` then
 * what its causes add; an abort is what the SDK threw. With the real
 * `@google/genai` client (an API key sends through the global `fetch`,
 * replaced here by a fixture). The adapter's retries of a 429 or a 5xx back
 * off at once.
 */

import { ApiError, GoogleGenAI } from '@google/genai';
import { ModelProviderError } from '@kindgi/adapter-model-shared';
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

const call = (abortSignal?: AbortSignal) =>
  createGeminiProvider({ metadata: METADATA, apiKey: () => 'test-key' }).invoke({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hi' }],
    ...(abortSignal !== undefined && { abortSignal }),
  });

/** What the SDK itself throws for the same response. */
const sdkCall = () =>
  new GoogleGenAI({ apiKey: 'test-key' }).models.generateContent({
    model: 'gemini-3.8-flash',
    contents: 'hi',
  });

const original = globalThis.fetch;
beforeEach(() => {
  const later = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms?: number) =>
    later(run, ms === undefined || ms < 1_000 ? ms : 0)) as typeof globalThis.setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = original;
});

/** Every request is answered `status`, with `body` as JSON, or no body. */
function serve(status: number, body?: unknown): void {
  globalThis.fetch = async (_input, init) => {
    init?.signal?.throwIfAborted();
    return body === undefined ? new Response(null, { status }) : Response.json(body, { status });
  };
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

const google = (code: number, status: string, message: string) => ({
  error: { code, message, status },
});

describe('a response that refuses the call', () => {
  test.each([
    [
      400,
      google(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.'),
      'invalid-request',
    ],
    [
      400,
      google(
        400,
        'INVALID_ARGUMENT',
        'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      ),
      'context-too-long',
    ],
    [
      400,
      google(400, 'INVALID_ARGUMENT', 'Request payload size exceeds the limit: 20971520 bytes.'),
      'invalid-request',
    ],
    [401, google(401, 'UNAUTHENTICATED', 'API key not valid.'), 'auth'],
    [403, google(403, 'PERMISSION_DENIED', 'Permission denied.'), 'auth'],
    [404, google(404, 'NOT_FOUND', 'models/gemini-retired is not found.'), 'invalid-request'],
    [429, google(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted.'), 'rate-limited'],
    [500, google(500, 'INTERNAL', 'An internal error has occurred.'), 'unavailable'],
    [503, google(503, 'UNAVAILABLE', 'The model is overloaded.'), 'unavailable'],
  ])('%i: `%s`', async (status, body, kind) => {
    serve(status, body);
    const sdk = await thrown(sdkCall());
    const error = await thrown(call());
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ kind, status, message: sdk.message });
    expect(error.cause).toBeInstanceOf(ApiError);
  });

  test('no body: the same message as the SDK’s', async () => {
    serve(500);
    const sdk = await thrown(sdkCall());
    const error = await thrown(call());
    expect(error.message).toBe(sdk.message);
  });
});

describe('a call with no response', () => {
  /** Every request fails as `fetch` does when nothing comes back: with `error`. */
  function fail(error: Error): void {
    globalThis.fetch = async () => {
      throw error;
    };
  }

  const refused = (address: string) =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });

  test('a failed connection is `network`: the SDK’s words, then why', async () => {
    // Node tries every address a host has; refused at all of them, it throws an AggregateError
    // with an empty message, and `fetch` rejects with `fetch failed`, that as its cause.
    const failed = new TypeError('fetch failed', {
      cause: Object.assign(new AggregateError([refused('::1:443'), refused('127.0.0.1:443')], ''), {
        code: 'ECONNREFUSED',
      }),
    });
    fail(failed);
    // The SDK throws the fetch's error as it is: it says only `fetch failed`.
    expect(await thrown(sdkCall())).toBe(failed);
    const error = await thrown(call());
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({
      kind: 'network',
      status: undefined,
      message:
        'fetch failed; caused by AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:443, connect ECONNREFUSED 127.0.0.1:443',
    });
    expect(error.cause).toBe(failed);
  });

  test('a failed connection with nothing below it: the SDK’s words alone', async () => {
    fail(new TypeError('fetch failed'));
    const error = await thrown(call());
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ kind: 'network', status: undefined, message: 'fetch failed' });
  });

  test('a host the runtime’s egress rules refuse: `network`, in the refusal’s own words', async () => {
    const egress = Object.assign(
      new Error('egress refused: 169.254.169.254 is link-local, which this deployment forbids'),
      { code: 'EKINDGIEGRESS' },
    );
    fail(new TypeError('fetch failed', { cause: egress }));
    const error = await thrown(call());
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ kind: 'network', status: undefined, message: egress.message });
  });

  test('a TypeError that is no failed connection (a bug) is what the SDK threw, unchanged', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'headers')");
    fail(bug);
    expect(await thrown(call())).toBe(bug);
  });

  test('an abort is what the SDK threw, unchanged', async () => {
    serve(200, {});
    const aborted = new AbortController();
    aborted.abort();
    const error = await thrown(call(aborted.signal));
    expect(error).not.toBeInstanceOf(ModelProviderError);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  test('a connection that fails as the call is aborted is what the SDK threw, unchanged', async () => {
    const aborted = new AbortController();
    const failed = new TypeError('fetch failed');
    globalThis.fetch = async () => {
      aborted.abort();
      throw failed;
    };
    expect(await thrown(call(aborted.signal))).toBe(failed);
  });
});

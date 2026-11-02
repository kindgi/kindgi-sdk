// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A failed call is the shared typed error (`ModelProviderError`): its kind
 * from the status and the vendor's words, its message the SDK's own, byte
 * for byte, and the SDK's error its `cause`. An abort is the SDK's abort,
 * as it was. With the real SDK, against a fetch fixture.
 */

import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { ModelProviderError } from '@kindgi/adapter-model-shared';
import { afterEach, describe, expect, test } from 'vitest';

import { createAnthropicProvider } from '../src/index.js';

const BASE_URL = 'https://api.anthropic.test';
const model = {
  name: 'claude-haiku-4-5',
  contextWindow: 200_000,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0.001, completionUsdPer1kTokens: 0.005 },
} as const;
const provider = () =>
  createAnthropicProvider({
    apiKey: 'test-key',
    baseURL: BASE_URL,
    metadata: { id: 'acme-claude', region: 'us-east-1', models: [model] },
    clientOptions: { maxRetries: 0 },
  });
const call = (abortSignal?: AbortSignal) =>
  provider().invoke({
    model: model.name,
    messages: [{ role: 'user', content: 'hi' }],
    ...(abortSignal !== undefined && { abortSignal }),
  });

/** What the SDK itself throws for the same response. */
const sdkCall = () =>
  new Anthropic({ apiKey: 'test-key', baseURL: BASE_URL, maxRetries: 0 }).messages.create({
    model: model.name,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  });

const original = globalThis.fetch;
afterEach(() => {
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

const vendor = (type: string, message: string) => ({ type: 'error', error: { type, message } });

describe('a response that refuses the call', () => {
  test.each([
    [
      400,
      vendor('invalid_request_error', 'max_tokens: 999999 > 64000, the most this model writes'),
      'invalid-request',
    ],
    [
      400,
      vendor('invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum'),
      'context-too-long',
    ],
    [401, vendor('authentication_error', 'invalid x-api-key'), 'auth'],
    [403, vendor('permission_error', 'Your API key does not have permission'), 'auth'],
    [404, vendor('not_found_error', 'model: claude-retired-1'), 'invalid-request'],
    [413, vendor('request_too_large', 'Request exceeds the maximum size'), 'invalid-request'],
    [
      429,
      vendor('rate_limit_error', 'Number of requests has exceeded your rate limit'),
      'rate-limited',
    ],
    [500, vendor('api_error', 'Internal server error'), 'unavailable'],
    [529, vendor('overloaded_error', 'Overloaded'), 'unavailable'],
  ])('%i: `%s`', async (status, body, kind) => {
    serve(status, body);
    const sdk = await thrown(sdkCall());
    const error = await thrown(call());
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ kind, status, message: sdk.message });
    expect(error.cause).toBeInstanceOf(APIError);
  });

  test('no body: the same words, `400 status code (no body)`', async () => {
    serve(400);
    const error = await thrown(call());
    expect(error).toMatchObject({
      kind: 'invalid-request',
      status: 400,
      message: '400 status code (no body)',
    });
    expect(error.message).toBe((await thrown(sdkCall())).message);
  });
});

describe('a call with no response', () => {
  test('a failed connection is `network`, in the SDK’s words', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const sdk = await thrown(sdkCall());
    const error = await thrown(call());
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ kind: 'network', status: undefined, message: sdk.message });
    expect(error.cause).toBeInstanceOf(APIConnectionError);
  });

  test('an abort is the SDK’s own abort, unchanged', async () => {
    serve(200, {});
    const aborted = new AbortController();
    aborted.abort();
    const error = await thrown(call(aborted.signal));
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect(error).not.toBeInstanceOf(ModelProviderError);
  });
});

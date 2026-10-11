// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { BASE_URLS, createOpenAICompatEmbeddingProvider } from '../src/index.js';

/** A fetch that answers `/embeddings` with vectors of `dims`, recording each request. */
function endpoint(dims: number | (() => number)) {
  const requests: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      auth: headers.get('authorization'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const n = typeof dims === 'function' ? dims() : dims;
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [
          { object: 'embedding', index: 0, embedding: Array.from({ length: n }, (_, i) => i / n) },
        ],
        model: 'nomic-embed-text',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe('createOpenAICompatEmbeddingProvider', () => {
  test('posts the text to <baseURL>/embeddings and returns the vector', async () => {
    const { fetch, requests } = endpoint(4);
    const provider = createOpenAICompatEmbeddingProvider({
      baseURL: BASE_URLS.OLLAMA_LOCAL,
      model: 'nomic-embed-text',
      clientOptions: { fetch, maxRetries: 0 },
    });
    const vector = await provider.embed('refund policy');
    expect(Array.from(vector)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(requests[0]).toMatchObject({
      url: `${BASE_URLS.OLLAMA_LOCAL}/embeddings`,
      body: { model: 'nomic-embed-text', input: 'refund policy', encoding_format: 'float' },
    });
    expect(provider.describe()).toMatchObject({ model: 'nomic-embed-text' });
  });

  test('probe() learns the dimensions; before it, dimensions() says to call it', async () => {
    const provider = createOpenAICompatEmbeddingProvider({
      baseURL: 'http://tei.internal/v1',
      model: 'bge-small',
      clientOptions: { fetch: endpoint(384).fetch, maxRetries: 0 },
    });
    expect(() => provider.dimensions()).toThrow(/call probe\(\) first/);
    expect(await provider.probe()).toBe(384);
    expect(provider.dimensions()).toBe(384);
  });

  test('a vector of another length than the known dimensions is refused', async () => {
    let n = 8;
    const provider = createOpenAICompatEmbeddingProvider({
      baseURL: 'http://tei.internal/v1',
      model: 'bge-small',
      clientOptions: { fetch: endpoint(() => n).fetch, maxRetries: 0 },
    });
    await provider.probe();
    n = 16;
    await expect(provider.embed('x')).rejects.toThrow(/16-dimension vector, expected 8/);
  });

  test('no key sends a placeholder; a resolver is asked each time, so a rotated key is used', async () => {
    const { fetch, requests } = endpoint(2);
    const none = createOpenAICompatEmbeddingProvider({
      baseURL: BASE_URLS.OLLAMA_LOCAL,
      model: 'nomic-embed-text',
      clientOptions: { fetch, maxRetries: 0 },
    });
    await none.embed('a');
    expect(requests[0]?.auth).toBe('Bearer unused');

    let key = 'k-1';
    const rotating = createOpenAICompatEmbeddingProvider({
      baseURL: BASE_URLS.OPENAI,
      model: 'text-embedding-3-small',
      apiKey: () => key,
      clientOptions: { fetch, maxRetries: 0 },
    });
    await rotating.embed('a');
    key = 'k-2';
    await rotating.embed('b');
    expect(requests.slice(1).map((r) => r.auth)).toEqual(['Bearer k-1', 'Bearer k-2']);
  });
});

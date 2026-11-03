// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One client per key: calls whose keys take turns (a run in each of two
 * projects, each project with a key of its own) each reuse their own
 * client, and each sends its own key. The SDK's client is counted as it's
 * built, so a single slot (a client built on every turn) shows.
 */

import { describe, expect, test, vi } from 'vitest';

const built = vi.hoisted(() => [] as string[]);
vi.mock('openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('openai')>();
  class Counted extends real.default {
    constructor(options: ConstructorParameters<typeof real.default>[0]) {
      super(options);
      built.push(String(options?.apiKey));
    }
  }
  return { ...real, default: Counted };
});

import {
  createOpenAICompatEmbeddingProvider,
  createOpenAICompatModelProvider,
} from '../src/index.js';

const metadata = {
  id: 'acme-llm',
  region: 'us-east-1',
  models: [
    {
      name: 'gpt-test',
      contextWindow: 8192,
      features: ['tool-use' as const],
      cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
    },
  ],
};

/** An endpoint that records each request's key and answers a chat completion or an embedding. */
function endpoint() {
  const sent: (string | null)[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('authorization'));
    const body = String(url).endsWith('/embeddings')
      ? {
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          model: 'acme-embed',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }
      : {
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-test',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const TURNS = ['key-a', 'key-b', 'key-a', 'key-b'];

describe('keys taking turns', () => {
  test('a model provider builds one client per key, and each call sends its own', async () => {
    built.length = 0;
    const { sent, fetch } = endpoint();
    const keys = [...TURNS];
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: async () => keys.shift() ?? 'key-x',
      metadata,
      clientOptions: { fetch, maxRetries: 0 },
    });
    for (const _ of TURNS) {
      await provider.invoke({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
    }
    expect(sent).toEqual(TURNS.map((k) => `Bearer ${k}`));
    expect(built).toEqual(['key-a', 'key-b']);
  });

  test('an embedding provider the same', async () => {
    built.length = 0;
    const { sent, fetch } = endpoint();
    const keys = [...TURNS];
    const provider = createOpenAICompatEmbeddingProvider({
      baseURL: 'http://llm.test/v1',
      model: 'acme-embed',
      apiKey: () => keys.shift() ?? 'key-x',
      clientOptions: { fetch, maxRetries: 0 },
    });
    for (const _ of TURNS) await provider.embed('text');
    expect(sent).toEqual(TURNS.map((k) => `Bearer ${k}`));
    expect(built).toEqual(['key-a', 'key-b']);
  });
});

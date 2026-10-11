// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Nothing of the server's environment goes out with a provider's calls, to
 * whatever base URL the provider names. Left to itself the OpenAI SDK reads
 * `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` (sent as headers) and
 * `OPENAI_ADMIN_KEY`. With them set to canaries, the requests the chat and
 * the embeddings providers send carry none of them.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  createOpenAICompatEmbeddingProvider,
  createOpenAICompatModelProvider,
} from '../src/index.js';

const SERVER_ENV = {
  OPENAI_ORG_ID: 'canary-server-org',
  OPENAI_PROJECT_ID: 'canary-server-project',
  OPENAI_ADMIN_KEY: 'canary-server-admin-key',
} as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [name, value] of Object.entries(SERVER_ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
afterEach(() => {
  for (const name of Object.keys(SERVER_ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const BASE = 'https://llm.acme.example/v1';
const model = {
  name: 'acme-model',
  contextWindow: 8192,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
} as const;

/** A fetch that records each request and answers 400, so the call ends there. */
function capture() {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify({ error: { message: 'stub' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

/** No header of the server's: no organization or project, the provider's own key only. */
function expectNothingOfTheServers(
  sent: readonly { url: string; headers: Record<string, string> }[],
): void {
  expect(sent.length).toBeGreaterThan(0);
  for (const request of sent) {
    expect(request.url.startsWith(BASE)).toBe(true);
    expect(request.headers['openai-organization']).toBeUndefined();
    expect(request.headers['openai-project']).toBeUndefined();
    expect(request.headers.authorization).toBe('Bearer acme-tenant-key');
  }
  expect(JSON.stringify(sent)).not.toContain('canary');
}

describe("the server's environment stays out of a provider's calls", () => {
  for (const api of ['chat-completions', 'responses'] as const) {
    test(`chat (${api})`, async () => {
      const { sent, fetch } = capture();
      const provider = createOpenAICompatModelProvider({
        baseURL: BASE,
        apiKey: 'acme-tenant-key',
        metadata: { id: 'acme-compat', region: 'local', models: [model] },
        api,
        clientOptions: { fetch, maxRetries: 0 },
      });
      await provider
        .invoke({ model: model.name, messages: [{ role: 'user', content: 'hi' }] })
        .catch(() => undefined);
      expectNothingOfTheServers(sent);
    });
  }

  test('embeddings', async () => {
    const { sent, fetch } = capture();
    const provider = createOpenAICompatEmbeddingProvider({
      baseURL: BASE,
      model: 'acme-embed',
      apiKey: 'acme-tenant-key',
      clientOptions: { fetch, maxRetries: 0 },
    });
    await provider.embed('refund policy').catch(() => undefined);
    expectNothingOfTheServers(sent);
  });
});

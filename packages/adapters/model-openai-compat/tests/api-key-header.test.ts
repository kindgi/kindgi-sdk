// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A key fetch can't send in a header (a line break inside it, pasted with the
 * next line) is refused by the provider's name before the SDK sends it:
 * fetch's own error quotes `Bearer <key>`, into the call's failure and the
 * logs. With the real SDK and fetch, against a port nothing listens on, for
 * chat completions, the Responses API and embeddings.
 */

import { describe, expect, test } from 'vitest';

import {
  createOpenAICompatEmbeddingProvider,
  createOpenAICompatModelProvider,
} from '../src/index.js';

const CANARY = 'canary-SECRET-one\nline-two';
const NOWHERE = 'http://127.0.0.1:9/v1';
const model = {
  name: 'acme-model',
  contextWindow: 8192,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
} as const;
const call = { model: model.name, messages: [{ role: 'user' as const, content: 'hi' }] };

/** The error, as a log or a run would keep it: message, stack and causes. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const parts: string[] = [];
    for (let c: unknown = e; c instanceof Error; c = c.cause) parts.push(c.message, c.stack ?? '');
    return parts.join('\n');
  }
  throw new Error('the call did not fail');
}

describe("an API key fetch can't send", () => {
  test.each(['chat-completions', 'responses'] as const)(
    '%s: a line break inside is refused by the provider, never quoted',
    async (api) => {
      const provider = createOpenAICompatModelProvider({
        baseURL: NOWHERE,
        apiKey: async () => CANARY,
        metadata: { id: 'acme-compat', region: 'local', models: [model] },
        api,
        clientOptions: { maxRetries: 0 },
      });
      const text = await failure(provider.invoke(call));
      expect(text).toContain(
        '@kindgi/adapter-model-openai-compat: provider "acme-compat": its API key has a line break, which a header can\'t carry: store the secret without it',
      );
      expect(text).not.toContain('canary');
    },
  );

  test('embeddings: the same, before a client is built', async () => {
    const provider = createOpenAICompatEmbeddingProvider({
      baseURL: NOWHERE,
      model: 'nomic-embed-text',
      apiKey: CANARY,
      clientOptions: { maxRetries: 0 },
    });
    const text = await failure(provider.embed('refund policy'));
    expect(text).toContain(
      `@kindgi/adapter-model-openai-compat: embeddings at ${NOWHERE}: the API key has a line break, which a header can't carry: store the secret without it`,
    );
    expect(text).not.toContain('canary');
  });
});

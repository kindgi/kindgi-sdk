// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A key fetch can't send in a header (a line break inside it, pasted with the
 * next line) is refused by the provider's name before the SDK sends it:
 * fetch's own error quotes the key, into the call's failure and the logs. With
 * the real SDK and fetch: the check comes before any request.
 */

import { describe, expect, test } from 'vitest';

import { createGeminiProvider } from '../src/index.js';

const CANARY = 'canary-SECRET-one\nline-two';
const model = {
  name: 'gemini-3.8-flash',
  contextWindow: 1_048_576,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0.00075, completionUsdPer1kTokens: 0.00375 },
} as const;

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
  test('a line break inside: refused by the provider, never quoted', async () => {
    const provider = createGeminiProvider({
      apiKey: async () => CANARY,
      metadata: { id: 'acme-gemini', region: 'unspecified', models: [model] },
    });
    const text = await failure(
      provider.invoke({ model: model.name, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(text).toContain(
      '@kindgi/adapter-model-gemini: provider "acme-gemini": its API key has a line break, which a header can\'t carry: store the secret without it',
    );
    expect(text).not.toContain('canary');
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A key fetch can't send in a header (a line break inside it, pasted with the
 * next line) is refused by the provider's name before the SDK sends it:
 * fetch's own error quotes the key, into the call's failure and the logs. With
 * the real SDK and fetch, against a port nothing listens on.
 */

import { describe, expect, test } from 'vitest';

import { createAnthropicProvider } from '../src/index.js';

const CANARY = 'canary-SECRET-one\nline-two';
const model = {
  name: 'claude-sonnet-4-6',
  contextWindow: 200_000,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
} as const;
const provider = (apiKey: string | (() => Promise<string>)) =>
  createAnthropicProvider({
    apiKey,
    baseURL: 'http://127.0.0.1:9',
    metadata: { id: 'acme-claude', region: 'us-east-1', models: [model] },
    clientOptions: { maxRetries: 0 },
  });
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
  test('a line break inside: refused by the provider, never quoted, for a key and a key resolver', async () => {
    for (const key of [CANARY, async () => CANARY]) {
      const text = await failure(provider(key).invoke(call));
      expect(text).toContain(
        '@kindgi/adapter-model-anthropic: provider "acme-claude": its API key has a line break, which a header can\'t carry: store the secret without it',
      );
      expect(text).not.toContain('canary');
    }
  });

  test('checked on every call, before a client is reused: a key rotated to a bad one is refused', async () => {
    const keys = ['sk-good', CANARY];
    const p = provider(async () => keys.shift() ?? 'sk-good');
    // The first call gets past the check (it fails to connect: nothing listens).
    expect(await failure(p.invoke(call))).not.toContain("which a header can't carry");
    const text = await failure(p.invoke(call));
    expect(text).toContain("its API key has a line break, which a header can't carry");
    expect(text).not.toContain('canary');
  });
});

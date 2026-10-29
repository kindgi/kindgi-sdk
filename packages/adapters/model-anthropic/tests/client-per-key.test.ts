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
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  class Counted extends real.default {
    constructor(options: ConstructorParameters<typeof real.default>[0]) {
      super(options);
      built.push(String(options?.apiKey));
    }
  }
  return { ...real, default: Counted };
});

import { createAnthropicProvider } from '../src/index.js';

const model = {
  name: 'claude-sonnet-4-6',
  contextWindow: 200_000,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
} as const;

/** An endpoint that records each request's key and answers a message. */
function endpoint() {
  const sent: (string | null)[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('x-api-key'));
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: model.name,
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const TURNS = ['key-a', 'key-b', 'key-a', 'key-b'];

describe('keys taking turns', () => {
  test('one client per key, and each call sends its own', async () => {
    const { sent, fetch } = endpoint();
    const keys = [...TURNS];
    const provider = createAnthropicProvider({
      apiKey: async () => keys.shift() ?? 'key-x',
      baseURL: 'http://llm.test',
      metadata: { id: 'acme-claude', region: 'us-east-1', models: [model] },
      clientOptions: { fetch, maxRetries: 0 },
    });
    for (const _ of TURNS) {
      await provider.invoke({ model: model.name, messages: [{ role: 'user', content: 'hi' }] });
    }
    expect(sent).toEqual(TURNS);
    expect(built).toEqual(['key-a', 'key-b']);
  });
});

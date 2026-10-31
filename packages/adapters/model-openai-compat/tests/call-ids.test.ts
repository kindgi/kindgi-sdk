// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Each call of a reply has an id of its own: the agent loop records what
 * it decided for a call by its id. A compatible server may send none, an
 * empty one or a repeated one, so the adapter makes one, and it goes back
 * to the server with the call and with its result.
 */

import { describe, expect, test } from 'vitest';

import { createOpenAICompatModelProvider } from '../src/index.js';

function answering(toolCalls: readonly Record<string, unknown>[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion',
        created: 0,
        model: 'llama3.1',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: toolCalls },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  const provider = createOpenAICompatModelProvider({
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'unused',
    clientOptions: { fetch, maxRetries: 0 },
    metadata: {
      id: 'ollama',
      region: 'local',
      models: [
        {
          name: 'llama3.1',
          contextWindow: 128000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
        },
      ],
    },
  });
  return { provider, bodies };
}

const lookup = (id?: string) => ({
  ...(id !== undefined && { id }),
  type: 'function',
  function: { name: 'acme__lookup', arguments: '{}' },
});
const tools = [{ name: 'acme.lookup', description: 'lookup', inputSchema: { type: 'object' } }];

describe('the openai-compat adapter gives each call of a reply an id of its own', () => {
  test('a repeated, an empty and a missing id are made anew; each goes back with its call and its result', async () => {
    const { provider, bodies } = answering([
      lookup('call_1'),
      lookup('call_1'),
      lookup(''),
      lookup(),
    ]);
    const first = await provider.invoke({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'look' }],
      tools,
    });
    const ids = first.message.toolCalls?.map((c) => c.id) ?? [];
    expect(ids[0]).toBe('call_1');
    expect(ids.slice(1).every((id) => id.startsWith('call-'))).toBe(true);
    expect(new Set(ids).size).toBe(4);

    await provider.invoke({
      model: 'llama3.1',
      messages: [
        { role: 'user', content: 'look' },
        first.message,
        ...ids.map((id) => ({ role: 'tool' as const, toolCallId: id, content: '{}' })),
      ],
      tools,
    });
    const sent = bodies[1]?.messages as {
      readonly role: string;
      readonly tool_calls?: readonly { readonly id: string }[];
      readonly tool_call_id?: string;
    }[];
    expect(sent.find((m) => m.role === 'assistant')?.tool_calls?.map((c) => c.id)).toEqual(ids);
    expect(sent.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(ids);
  });

  test("a reply's own distinct ids are kept", async () => {
    const { provider } = answering([lookup('call_1'), lookup('call_2')]);
    const result = await provider.invoke({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'look' }],
      tools,
    });
    expect(result.message.toolCalls?.map((c) => c.id)).toEqual(['call_1', 'call_2']);
  });
});

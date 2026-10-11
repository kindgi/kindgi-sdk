// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * T311: the system prompt names the call's tools as they're sent
 * (`demo__echo`), so a model told to call `demo.echo` calls a name it
 * was given. The user's words and the caller's own messages keep the id.
 */

import { describe, expect, test } from 'vitest';

import type { ModelCallInput } from '@kindgi/capabilities';

import { createOpenAICompatModelProvider } from '../src/index.js';

function capturing() {
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
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
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

describe('the openai-compat adapter names declared tools as sent', () => {
  test("in the system prompt only; the user's words and the caller's trail keep the ids", async () => {
    const { provider, bodies } = capturing();
    const system = 'Call `demo.echo` with the message. Never demo.echoes or other.echo.';
    const input: ModelCallInput = {
      model: 'llama3.1',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Use demo.echo please' },
      ],
      tools: [
        { name: 'demo.echo', description: 'Echo back a message.', inputSchema: { type: 'object' } },
      ],
    };
    await provider.invoke(input);
    const messages = bodies[0]?.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'Call `demo__echo` with the message. Never demo.echoes or other.echo.',
    });
    expect(messages[1]).toEqual({ role: 'user', content: 'Use demo.echo please' });
    expect((bodies[0]?.tools as { function: { name: string } }[])[0]?.function.name).toBe(
      'demo__echo',
    );
    expect(input.messages[0]?.content).toBe(system);
  });

  test('without tools, the system prompt is sent as written', async () => {
    const { provider, bodies } = capturing();
    await provider.invoke({
      model: 'llama3.1',
      messages: [
        { role: 'system', content: 'Mention demo.echo.' },
        { role: 'user', content: 'Hi' },
      ],
    });
    expect((bodies[0]?.messages as { content: string }[])[0]?.content).toBe('Mention demo.echo.');
  });
});

describe('the openai-compat adapter gives a call back its tool id', () => {
  function answering(toolName: string) {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'c-1',
          object: 'chat.completion',
          created: 0,
          model: 'llama3.1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: toolName, arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
    return createOpenAICompatModelProvider({
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
  }
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });

  test("a tool id holding `__` (an MCP server's own name) comes back as the id", async () => {
    const result = await answering('drupal__tool_api__list_content').invoke({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'list the articles' }],
      tools: [tool('drupal.tool_api__list_content')],
    });
    expect(result.message.toolCalls?.map((c) => c.name)).toEqual(['drupal.tool_api__list_content']);
  });

  test('two tools sent under one name are refused before the call, naming both', async () => {
    await expect(
      answering('acme__lookup__order').invoke({
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [tool('acme.lookup__order'), tool('acme.lookup.order')],
      }),
    ).rejects.toThrow(
      'tools "acme.lookup__order" and "acme.lookup.order" have the same name for the model',
    );
  });
});

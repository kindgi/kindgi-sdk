// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelCallInput } from '@kindgi/capabilities';

import {
  DEV_ECHO_MODEL_NAME,
  DEV_ECHO_PROVIDER_ID,
  DEV_ECHO_PROVIDER_METADATA,
  createDevEchoProvider,
} from '../src/index.js';

const AGENT_INSTRUCTIONS = 'You are the dev-echo agent.';

function baseInput(messages: ModelCallInput['messages']): ModelCallInput {
  return {
    model: DEV_ECHO_MODEL_NAME,
    messages,
    instructions: AGENT_INSTRUCTIONS,
    tools: [
      {
        name: 'demo.echo',
        description: 'Echoes back the caller message.',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
    ],
  } as unknown as ModelCallInput;
}

describe('createDevEchoProvider', () => {
  test('metadata exposes the framework-stable dev-echo id + zero cost', () => {
    const provider = createDevEchoProvider();
    expect(provider.metadata.id).toBe(DEV_ECHO_PROVIDER_ID);
    expect(provider.metadata.id).toBe(DEV_ECHO_PROVIDER_METADATA.id);
    const singleModel = provider.metadata.models[0];
    expect(singleModel?.name).toBe(DEV_ECHO_MODEL_NAME);
    expect(singleModel?.features).toContain('tool-use');
    expect(singleModel?.cost.promptUsdPer1kTokens).toBe(0);
    expect(singleModel?.cost.completionUsdPer1kTokens).toBe(0);
    expect(provider.metadata.description).toMatch(/dev/i);
    // A fallback: registering a real model takes over without removing dev-echo.
    expect(provider.metadata.fallback).toBe(true);
  });

  test('a chat-only call (no tools) answers with the last user message', async () => {
    const provider = createDevEchoProvider();
    const result = await provider.invoke({
      ...baseInput([{ role: 'user', content: '{"remedy":["reinstatement"]}' }]),
      tools: undefined,
    } as unknown as ModelCallInput);
    expect(result.finishReason).toBe('stop');
    expect(result.message).toEqual({ role: 'assistant', content: '{"remedy":["reinstatement"]}' });
  });

  test('first invocation (no tool result yet) asks the runtime to call demo.echo', async () => {
    const provider = createDevEchoProvider();
    const result = await provider.invoke(baseInput([{ role: 'user', content: 'Hello, Kindgi!' }]));
    expect(result.finishReason).toBe('tool-use');
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('');
    expect(result.message.toolCalls).toHaveLength(1);
    const call = result.message.toolCalls?.[0];
    expect(call?.name).toBe('demo.echo');
    expect(call?.arguments).toEqual({ message: 'Hello, Kindgi!' });
    expect(result.costUsd).toBe(0);
    expect(result.provider.id).toBe(DEV_ECHO_PROVIDER_ID);
  });

  test('second invocation (tool result in trail) emits `Tool responded: ...` final text', async () => {
    const provider = createDevEchoProvider();
    const result = await provider.invoke(
      baseInput([
        { role: 'user', content: 'Say something.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'x', name: 'demo.echo', arguments: { message: 'Say something.' } }],
        },
        { role: 'tool', content: 'Say something. (echoed)' } as never,
      ]),
    );
    expect(result.finishReason).toBe('stop');
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('Tool responded: Say something. (echoed)');
    expect(result.message.toolCalls).toBeUndefined();
    expect(result.costUsd).toBe(0);
  });
});

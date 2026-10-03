// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Live validation for the Anthropic adapter. Gated on
 * `ANTHROPIC_API_KEY` — the test skips (not fails) when the key is
 * absent so CI runs remain green without paid credentials.
 *
 * Purpose: confirm the framework's translation layer + cost
 * accounting produce a well-formed request that Anthropic
 * actually answers. Mocks can't tell us that; only a real
 * round-trip can. Per the "manual validation catches real bugs"
 * memory: every primitive with external deps needs at least one
 * live run.
 */

import { describe, expect, test } from 'vitest';

import type { ModelCallInput } from '@kindgi/capabilities';

import { type AnthropicProviderOptions, createAnthropicProvider } from '../src/index.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const gated = apiKey === undefined || apiKey.length === 0;

// Real-price defaults for Claude Opus 4.7 as of 2026-04-29 pricing —
// `$5.00 / 1M input`, `$25.00 / 1M output`. Kept caller-side per the
// adapter's "metadata is caller-supplied" convention.
const OPUS_4_7_METADATA: AnthropicProviderOptions['metadata'] = {
  id: 'anthropic-live',
  region: 'us-east-1',
  models: [
    {
      name: 'claude-opus-4-7',
      contextWindow: 200_000,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.005, completionUsdPer1kTokens: 0.025 },
    },
  ],
};

describe.skipIf(gated)('createAnthropicProvider — live turn against Anthropic', () => {
  test('text-only user message → non-empty assistant reply + accurate usage/cost', async () => {
    const provider = createAnthropicProvider({
      apiKey: apiKey as string,
      metadata: OPUS_4_7_METADATA,
    });

    const input: ModelCallInput = {
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'user',
          content: 'Respond with exactly the three characters "ok!" and nothing else.',
        },
      ],
      maxOutputTokens: 32,
    };
    const result = await provider.invoke(input);

    expect(result.finishReason).toBe('stop');
    expect(result.message.role).toBe('assistant');
    expect(result.message.content.length).toBeGreaterThan(0);
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.provider.id).toBe('anthropic-live');
    expect(result.provider.model).toBe('claude-opus-4-7');
  }, 60_000);

  test('tool-use loop — assistant requests demo.echo, framework returns tool_result, model finalizes', async () => {
    const provider = createAnthropicProvider({
      apiKey: apiKey as string,
      metadata: OPUS_4_7_METADATA,
    });

    // Turn 1: user asks the model to echo a specific phrase via a
    // tool. Model should emit a `tool_use` block.
    const turn1Input: ModelCallInput = {
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'user',
          content:
            'Use the demo.echo tool to echo the exact string "hello-live-test". Only after the tool responds should you reply to the user.',
        },
      ],
      tools: [
        {
          name: 'demo.echo',
          description: 'Echo the provided message back verbatim.',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
      ],
      maxOutputTokens: 256,
    };
    const turn1 = await provider.invoke(turn1Input);
    expect(turn1.finishReason).toBe('tool-use');
    expect(turn1.message.toolCalls).toBeDefined();
    expect(turn1.message.toolCalls?.length).toBeGreaterThanOrEqual(1);
    const call = turn1.message.toolCalls?.[0];
    expect(call?.name).toBe('demo.echo');

    // Turn 2: return the tool result and let the model finalize.
    const turn2Input: ModelCallInput = {
      model: 'claude-opus-4-7',
      messages: [
        ...turn1Input.messages,
        turn1.message,
        {
          role: 'tool',
          content: 'hello-live-test',
          toolCallId: call?.id ?? '',
        },
      ],
      tools: turn1Input.tools as NonNullable<typeof turn1Input.tools>,
      maxOutputTokens: 128,
    };
    const turn2 = await provider.invoke(turn2Input);
    expect(turn2.finishReason).toBe('stop');
    expect(turn2.message.role).toBe('assistant');
    expect(turn2.message.content.length).toBeGreaterThan(0);
  }, 60_000);
});

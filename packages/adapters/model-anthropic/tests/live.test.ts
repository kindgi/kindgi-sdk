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

import type { ModelCallInput, ModelMessage, ModelToolDefinition } from '@kindgi/capabilities';

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

/**
 * Claude's thinking through a tool loop, against the real API. Each test
 * prints one line (`thinking-live …`) with what it measured, for the record.
 * They import only `createAnthropicProvider`, so they also run against an
 * older adapter's source, for a before/after.
 */
describe.skipIf(gated)('createAnthropicProvider — live: thinking through a tool loop', () => {
  const claude = (name: string, completionUsdPer1kTokens: number) => ({
    name,
    contextWindow: 1_000_000,
    features: ['tool-use' as const],
    cost: { promptUsdPer1kTokens: completionUsdPer1kTokens / 5, completionUsdPer1kTokens },
  });
  const provider = createAnthropicProvider({
    apiKey: apiKey as string,
    metadata: {
      id: 'anthropic-live',
      region: 'us-east-1',
      models: [claude('claude-opus-5-5', 0.02), claude('claude-sonnet-5-5', 0.01)],
    },
  });

  /** The answer's thinking, as carried in its first call (`anth1.`); none at an older adapter. */
  const carried = (message: ModelMessage) => {
    const signature = message.toolCalls?.[0]?.signature;
    if (signature === undefined || !signature.startsWith('anth1.')) return undefined;
    const { blocks } = JSON.parse(
      Buffer.from(signature.slice('anth1.'.length), 'base64url').toString('utf8'),
    ) as { blocks: { type: string }[] };
    return {
      thinking: blocks.filter((b) => b.type === 'thinking').length,
      redacted: blocks.filter((b) => b.type === 'redacted_thinking').length,
    };
  };

  const ORDERS: ModelToolDefinition = {
    name: 'acme.orders.lookup',
    description: "Look an order up by its number: its customer's id and its weight in kg.",
    inputSchema: { type: 'object', properties: { order: { type: 'string' } }, required: ['order'] },
  };
  const CUSTOMERS: ModelToolDefinition = {
    name: 'acme.customers.lookup',
    description: 'Look a customer up by id: their shipping tier.',
    inputSchema: {
      type: 'object',
      properties: { customer: { type: 'string' } },
      required: ['customer'],
    },
  };
  const SHIPPING: ModelToolDefinition = {
    name: 'acme.shipping.quote',
    description: 'Quote shipping for a tier and a weight in kg: its price in USD and days.',
    inputSchema: {
      type: 'object',
      properties: { tier: { type: 'string' }, weightKg: { type: 'number' } },
      required: ['tier', 'weightKg'],
    },
  };
  const results: Record<string, (args: Readonly<Record<string, unknown>>) => unknown> = {
    'acme.orders.lookup': (a) =>
      a.order === 'A-1042' ? { customer: 'C-7', weightKg: 3 } : { error: 'no such order' },
    'acme.customers.lookup': (a) =>
      a.customer === 'C-7' ? { tier: 'gold' } : { error: 'no such customer' },
    'acme.shipping.quote': (a) =>
      a.tier === 'gold' && a.weightKg === 3
        ? { priceUsd: 4.5, days: 2 }
        : { error: 'no quote for that tier and weight' },
  };

  /** Runs a tool loop to its answer, as the agent loop does, and measures it. */
  async function loop(model: string, question: string, tools: readonly ModelToolDefinition[]) {
    const startedAt = Date.now();
    const messages: ModelMessage[] = [{ role: 'user', content: question }];
    const steps: unknown[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    for (let step = 1; step <= 8; step += 1) {
      const result = await provider.invoke({ model, messages, tools, maxOutputTokens: 16_000 });
      promptTokens += result.usage.promptTokens;
      completionTokens += result.usage.completionTokens;
      steps.push({
        finish: result.finishReason,
        calls: result.message.toolCalls?.map((c) => c.name) ?? [],
        carried: carried(result.message) ?? null,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      });
      messages.push(result.message);
      if (result.finishReason !== 'tool-use') {
        return {
          model,
          ms: Date.now() - startedAt,
          promptTokens,
          completionTokens,
          steps,
          finish: result.finishReason,
          answer: result.message.content,
          first: messages[1] as ModelMessage,
        };
      }
      for (const call of result.message.toolCalls ?? []) {
        const run = results[call.name];
        messages.push({
          role: 'tool',
          content: JSON.stringify(
            run === undefined ? { error: 'no such tool' } : run(call.arguments),
          ),
          toolCallId: call.id,
        });
      }
    }
    throw new Error(`${model}: no answer in 8 steps`);
  }

  test('L1: Claude Opus 5.5 (always thinks) and Sonnet 5.5 (no thinking field): what comes back, and Anthropic takes it back', async () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      const run = await loop(model, 'What tier is customer C-7? Use the tool.', [CUSTOMERS]);
      console.log(`thinking-live L1 ${JSON.stringify({ ...run, first: undefined })}`);
      expect(run.finish).toBe('stop');
      expect(run.answer.toLowerCase()).toContain('gold');
      if (model === 'claude-opus-5-5') {
        const kept = carried(run.first);
        expect((kept?.thinking ?? 0) + (kept?.redacted ?? 0)).toBeGreaterThan(0);
      }
    }
  }, 180_000);

  test('L2: a three-step task on Claude Sonnet 5.5: time, tokens and answer', async () => {
    const run = await loop(
      'claude-sonnet-5-5',
      'How much will shipping order A-1042 cost, and how many days will it take? Use the tools.',
      [ORDERS, CUSTOMERS, SHIPPING],
    );
    console.log(`thinking-live L2 ${JSON.stringify({ ...run, first: undefined })}`);
    expect(run.finish).toBe('stop');
    expect(run.answer).toMatch(/4\.50?/);
    expect(run.answer).toMatch(/\b2\b/);
  }, 300_000);
});

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

import type {
  ModelCallInput,
  ModelCallResult,
  ModelMessage,
  ModelToolDefinition,
} from '@kindgi/capabilities';

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
 * Claude's thinking through a tool loop, against the real API. The question
 * asks for a sum before the tool call, so the model has something to think
 * about first. Each step records the thinking blocks Anthropic's API sent
 * back (counted in the response, before the adapter reads it) and the ones
 * the adapter kept in the first call's signature. Each test prints one line
 * (`thinking-live …`) with what it measured, for the record, whether it
 * passes or not. They import only `createAnthropicProvider`, so L2 also runs
 * against an older adapter's source for a before/after; L1 needs this one.
 */
describe.skipIf(gated)('createAnthropicProvider — live: thinking through a tool loop', () => {
  const claude = (name: string, completionUsdPer1kTokens: number) => ({
    name,
    contextWindow: 1_000_000,
    features: ['tool-use' as const],
    cost: { promptUsdPer1kTokens: completionUsdPer1kTokens / 5, completionUsdPer1kTokens },
  });

  interface Thinking {
    readonly thinking: number;
    readonly redacted: number;
  }
  const count = (blocks: readonly { readonly type: string }[]): Thinking => ({
    thinking: blocks.filter((b) => b.type === 'thinking').length,
    redacted: blocks.filter((b) => b.type === 'redacted_thinking').length,
  });

  /** Each answer's thinking, as Anthropic's API sent it, in call order. */
  const returned: Thinking[] = [];
  const countingFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const body = (await response
      .clone()
      .json()
      .catch(() => undefined)) as { content?: unknown } | undefined;
    if (Array.isArray(body?.content)) returned.push(count(body.content));
    return response;
  };
  const provider = createAnthropicProvider({
    apiKey: apiKey as string,
    metadata: {
      id: 'anthropic-live',
      region: 'us-east-1',
      models: [claude('claude-opus-5-5', 0.02), claude('claude-sonnet-5-5', 0.01)],
    },
    clientOptions: { fetch: countingFetch },
  });

  /** The answer's thinking, as kept in its first call (`anth1.`); none at an older adapter. */
  const carried = (message: ModelMessage): Thinking | null => {
    const signature = message.toolCalls?.[0]?.signature;
    if (signature === undefined || !signature.startsWith('anth1.')) return null;
    const { blocks } = JSON.parse(
      Buffer.from(signature.slice('anth1.'.length), 'base64url').toString('utf8'),
    ) as { blocks: { type: string }[] };
    return count(blocks);
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

  // 3 × 17.35 + 2 × 4.20 + 129.99 = 190.44; with gold shipping for 3 kg, 194.94.
  const ITEMS = 'Order A-1042 holds 3 items at $17.35, 2 at $4.20 and 1 at $129.99.';

  interface Step {
    readonly finish: string;
    readonly calls: readonly string[];
    readonly returned: Thinking | null;
    readonly carried: Thinking | null;
    readonly signatureChars: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
  }
  interface Run {
    readonly model: string;
    ms: number;
    promptTokens: number;
    completionTokens: number;
    readonly steps: Step[];
    finish?: string;
    answer?: string;
  }

  /** One step's record: what Anthropic sent, what the adapter kept, what it took. */
  const stepOf = (result: ModelCallResult, sent: Thinking | null): Step => ({
    finish: result.finishReason,
    calls: result.message.toolCalls?.map((c) => c.name) ?? [],
    returned: sent,
    carried: carried(result.message),
    signatureChars: result.message.toolCalls?.[0]?.signature?.length ?? 0,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
  });

  /** The results of an answer's tool calls, as the agent loop sends them back. */
  const toolResults = (message: ModelMessage): ModelMessage[] =>
    (message.toolCalls ?? []).map((call) => {
      const tool = results[call.name];
      return {
        role: 'tool',
        content: JSON.stringify(
          tool === undefined ? { error: 'no such tool' } : tool(call.arguments),
        ),
        toolCallId: call.id,
      };
    });

  /**
   * Runs a tool loop to its answer, as the agent loop does, recording each
   * step into `run` as it goes. `onFirstCall` checks the first step that
   * calls a tool before any later call is made.
   */
  async function loop(
    run: Run,
    question: string,
    tools: readonly ModelToolDefinition[],
    onFirstCall?: (step: Step) => void,
  ): Promise<void> {
    const startedAt = Date.now();
    const messages: ModelMessage[] = [{ role: 'user', content: question }];
    for (let n = 1; n <= 8; n += 1) {
      const before = returned.length;
      const result = await provider.invoke({
        model: run.model,
        messages,
        tools,
        maxOutputTokens: 16_000,
      });
      run.ms = Date.now() - startedAt;
      run.promptTokens += result.usage.promptTokens;
      run.completionTokens += result.usage.completionTokens;
      const step = stepOf(result, returned.length > before ? (returned.at(-1) ?? null) : null);
      run.steps.push(step);
      messages.push(result.message);
      if (result.finishReason !== 'tool-use') {
        run.finish = result.finishReason;
        run.answer = result.message.content;
        return;
      }
      if (run.steps.filter((s) => s.calls.length > 0).length === 1) onFirstCall?.(step);
      messages.push(...toolResults(result.message));
    }
    throw new Error(`${run.model}: no answer in 8 steps`);
  }

  const newRun = (model: string): Run => ({
    model,
    ms: 0,
    promptTokens: 0,
    completionTokens: 0,
    steps: [],
  });

  test.each([
    ['claude-opus-5-5', 'always'],
    ['claude-sonnet-5-5', 'adaptive'],
  ])(
    'L1: %s (%s in the presets) thinks before its tool call, the adapter keeps it, and Anthropic takes it back',
    async (model) => {
      const run = newRun(model);
      try {
        await loop(
          run,
          `${ITEMS} First work out the order total carefully, then look the order up, then tell me its customer and total.`,
          [ORDERS],
          (step) => {
            const thought = (step.returned?.thinking ?? 0) + (step.returned?.redacted ?? 0);
            expect(
              thought,
              `${model} sent no thinking with its first tool call: ${JSON.stringify(step)}`,
            ).toBeGreaterThan(0);
            expect(
              step.carried,
              `the adapter didn't keep ${model}'s thinking: ${JSON.stringify(step)}`,
            ).toEqual(step.returned);
          },
        );
      } finally {
        // biome-ignore lint/suspicious/noConsoleLog: the line is the live run's record
        console.log(`thinking-live L1 ${JSON.stringify(run)}`);
      }
      expect(
        run.steps.some((s) => s.calls.length > 0),
        `${model} called no tool`,
      ).toBe(true);
      expect(run.finish).toBe('stop');
      expect(run.answer).toContain('190.44');
      expect(run.answer).toContain('C-7');
    },
    180_000,
  );

  test('L2: a three-step task on Claude Sonnet 5.5: thinking, time, tokens and answer', async () => {
    const run = newRun('claude-sonnet-5-5');
    try {
      await loop(
        run,
        `${ITEMS} First work out its total carefully. Then find what shipping it costs and how many days it takes, and tell me the total with shipping and the days.`,
        [ORDERS, CUSTOMERS, SHIPPING],
      );
    } finally {
      // biome-ignore lint/suspicious/noConsoleLog: the line is the live run's record
      console.log(`thinking-live L2 ${JSON.stringify(run)}`);
    }
    expect(run.finish).toBe('stop');
    expect(run.answer).toContain('194.94');
    expect(run.answer).toMatch(/\b2\b/);
  }, 300_000);
});

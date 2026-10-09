// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The wrapper against a fake AI SDK model (no network): the model sends each attempt through
 * the `fetch` it's given, as the real providers do, so attempts are counted the same way. The
 * live cases (on Azure, and on the big three for reference) are the T354 spike's.
 */

import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
} from '@ai-sdk/provider';
import type { ModelInfo, ProviderMetadata } from '@kindgi/capabilities';
import { attemptsOf } from '@kindgi/capabilities/attempts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createAiSdkModelProvider } from '../src/ai-sdk/index.js';
import { ModelProviderError } from '../src/index.js';

const MODEL: ModelInfo = {
  name: 'acme-large',
  contextWindow: 100_000,
  features: ['tool-use', 'structured-output'],
  cost: { promptUsdPer1kTokens: 0.002, completionUsdPer1kTokens: 0.01 },
  thinking: { mode: 'adaptive', lowest: 'low' },
  sampling: false,
} as ModelInfo;
const { thinking: _thinking, ...noThinking } = MODEL;
const OTHER: ModelInfo = { ...noThinking, name: 'acme-small', sampling: true } as ModelInfo;
const METADATA = { id: 'acme', region: 'unspecified', models: [MODEL, OTHER] } as ProviderMetadata;

/** One planned answer per HTTP attempt: a status that fails, or content that answers. */
type Step =
  | { status: number; body?: string; headers?: Record<string, string> }
  | { content: LanguageModelV4Content[] };

function fakeModel(plan: Step[], seen: LanguageModelV4CallOptions[]) {
  let i = 0;
  return (name: string, fetch: typeof globalThis.fetch): LanguageModelV4 =>
    ({
      specificationVersion: 'v4',
      provider: 'acme',
      modelId: name,
      supportedUrls: {},
      async doGenerate(options: LanguageModelV4CallOptions) {
        seen.push(options);
        const step = plan[Math.min(i, plan.length - 1)] as Step;
        i += 1;
        // Every attempt goes through the fetch it was given (counted).
        await fetch('https://llm.example.invalid/v1/generate', { method: 'POST' });
        if ('status' in step) {
          throw new APICallError({
            message: `HTTP ${step.status}`,
            url: 'https://llm.example.invalid/v1/generate',
            requestBodyValues: {},
            statusCode: step.status,
            responseHeaders: { 'retry-after-ms': '0', ...step.headers },
            responseBody: step.body ?? '{"message":"nope"}',
            isRetryable:
              step.status === 408 ||
              step.status === 409 ||
              step.status === 429 ||
              step.status >= 500,
          });
        }
        return {
          content: step.content,
          finishReason: {
            unified: step.content.some((c) => c.type === 'tool-call') ? 'tool-calls' : 'stop',
            raw: 'x',
          },
          usage: {
            inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: 0 },
            outputTokens: { total: 30, text: 22, reasoning: 8 },
            raw: { input_tokens: 120 },
          },
          warnings: [],
          response: {
            id: 'resp-1',
            modelId: `${name}-2026-09-29`,
            headers: { 'x-request-id': 'req-42' },
          },
        };
      },
      async doStream() {
        throw new Error('not used');
      },
    }) as unknown as LanguageModelV4;
}

function provider(plan: Step[], seen: LanguageModelV4CallOptions[] = []) {
  return createAiSdkModelProvider({
    metadata: METADATA,
    languageModel: fakeModel(plan, seen),
    providerOptions: () => ({ acme: { store: false } }),
    cost: (model, usage) =>
      (usage.promptTokens / 1000) * model.cost.promptUsdPer1kTokens +
      (usage.completionTokens / 1000) * model.cost.completionUsdPer1kTokens,
  });
}

const ANSWER: Step = { content: [{ type: 'text', text: 'Shipped.' }] };
const ask = {
  model: 'acme-large',
  messages: [{ role: 'user' as const, content: 'Where is A-1?' }],
};

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a call', () => {
  test('text, usage onto our counters, our cost, the served model, the request id, the raw usage', async () => {
    const r = await provider([ANSWER]).invoke(ask);
    expect(r.message).toEqual({ role: 'assistant', content: 'Shipped.' });
    expect(r.finishReason).toBe('stop');
    expect(r.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reasoningTokens: 8,
    });
    expect(r.costUsd).toBeCloseTo(0.12 * 0.002 + 0.03 * 0.01, 10);
    expect(r).toMatchObject({
      provider: { id: 'acme', model: 'acme-large' },
      servedModel: 'acme-large-2026-09-29',
      providerRequestId: 'req-42',
      attempts: 1,
      rawUsage: { input_tokens: 120 },
    });
  });

  test('tools go out with dots as `__` and come back as our names; parallel calls; the provider options', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const r = await provider(
      [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'acme__lookup',
              input: '{"id":"A-1"}',
            },
            {
              type: 'tool-call',
              toolCallId: 'c2',
              toolName: 'acme__lookup',
              input: '{"id":"A-2"}',
            },
          ],
        },
      ],
      seen,
    ).invoke({
      ...ask,
      tools: [
        { name: 'acme.lookup', description: 'Look an order up.', inputSchema: { type: 'object' } },
      ],
    });
    expect(seen[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'acme__lookup',
        description: 'Look an order up.',
        inputSchema: { type: 'object' },
      },
    ]);
    expect(seen[0]?.providerOptions).toEqual({ acme: { store: false } });
    expect(r.finishReason).toBe('tool-use');
    expect(r.message.toolCalls?.map((c) => [c.name, c.arguments])).toEqual([
      ['acme.lookup', { id: 'A-1' }],
      ['acme.lookup', { id: 'A-2' }],
    ]);
  });

  test('structured output is asked for natively, with its schema and name', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    await provider([ANSWER], seen).invoke({
      ...ask,
      structuredOutput: { name: 'order', schema: { type: 'object' } },
    } as never);
    expect(seen[0]?.responseFormat).toEqual({
      type: 'json',
      schema: { type: 'object' },
      name: 'order',
    });
  });

  test('a temperature the model refuses is dropped, with our warning; a model that takes one gets it', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const p = provider([ANSWER], seen);
    const refused = await p.invoke({ ...ask, temperature: 0.2 } as never);
    expect(seen[0]?.temperature).toBeUndefined();
    expect(refused.warnings?.map((w) => w.code)).toContain('sampling-unsupported');
    await p.invoke({ ...ask, model: 'acme-small', temperature: 0.2 } as never);
    expect(seen[1]?.temperature).toBe(0.2);
  });

  test('lowest thinking is the portable reasoning level', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    await provider([ANSWER], seen).invoke({ ...ask, thinking: 'lowest' } as never);
    expect(seen[0]?.reasoning).toBe('low');
  });

  test('traceparent is a header only when the call has one', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const p = provider([ANSWER], seen);
    await p.invoke({
      ...ask,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    await p.invoke(ask);
    expect(seen[0]?.headers).toEqual({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    expect(seen[1]?.headers).toBeUndefined();
  });

  test('a model the provider has no entry for is an invalid request, before any HTTP', async () => {
    const err = await provider([ANSWER])
      .invoke({ ...ask, model: 'acme-huge' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toMatchObject({ kind: 'invalid-request', status: undefined });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('the reasoning state across a pause (A5)', () => {
  const reasoningAnswer: Step = {
    content: [
      {
        type: 'reasoning',
        text: 'Look it up first.',
        providerMetadata: { acme: { signature: 'sig-1' } },
      },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'acme__lookup',
        input: '{"id":"A-1"}',
        providerMetadata: { acme: { itemId: 'fc_1' } },
      },
    ],
  };

  test('it rides in the first tool call’s signature, survives JSON, and goes back on the next call', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const p = provider([reasoningAnswer, ANSWER], seen);
    const tools = [{ name: 'acme.lookup', description: 'd', inputSchema: { type: 'object' } }];
    const first = await p.invoke({ ...ask, tools });
    const signature = first.message.toolCalls?.[0]?.signature ?? '';
    expect(signature.startsWith('aisdk1.')).toBe(true);
    // As a durable run stores it, then a restarted process reads it back.
    const trail = JSON.parse(
      JSON.stringify([
        ...ask.messages,
        first.message,
        { role: 'tool', toolCallId: 'c1', content: '{"status":"shipped"}' },
      ]),
    );
    await p.invoke({ model: 'acme-large', messages: trail, tools });
    const assistant = seen[1]?.prompt.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      {
        type: 'reasoning',
        text: 'Look it up first.',
        providerOptions: { acme: { signature: 'sig-1' } },
      },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'acme__lookup',
        input: { id: 'A-1' },
        providerOptions: { acme: { itemId: 'fc_1' } },
      },
    ]);
    const tool = seen[1]?.prompt.find((m) => m.role === 'tool');
    expect(tool?.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'acme__lookup',
        output: { type: 'text', value: '{"status":"shipped"}' },
      },
    ]);
  });

  test('another model’s state isn’t sent: the turn goes on without it', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const p = provider([reasoningAnswer, ANSWER], seen);
    const tools = [{ name: 'acme.lookup', description: 'd', inputSchema: { type: 'object' } }];
    const first = await p.invoke({ ...ask, tools });
    await p.invoke({
      model: 'acme-small',
      messages: [...ask.messages, first.message, { role: 'tool', toolCallId: 'c1', content: '{}' }],
      tools,
    });
    const assistant = seen[1]?.prompt.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'acme__lookup', input: { id: 'A-1' } },
    ]);
  });
});

describe('errors and retries', () => {
  test.each([
    [400, '{"message":"bad"}', 'invalid-request'],
    [401, '{"message":"invalid key"}', 'auth'],
    [403, '{"message":"denied"}', 'auth'],
    [400, '{"message":"Input is too long for requested model."}', 'context-too-long'],
    [
      400,
      '{"message":"The response was filtered due to the content management policy."}',
      'content-filter',
    ],
  ] as const)(
    '%i %s → %s, one attempt, the vendor’s words after the status',
    async (status, body, kind) => {
      const err = await provider([{ status, body }])
        .invoke(ask)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelProviderError);
      expect(err).toMatchObject({ kind, status, message: `${status} ${body}` });
      expect(attemptsOf(err)).toBe(1);
    },
  );

  test.each([
    [429, 'rate-limited'],
    [503, 'unavailable'],
  ] as const)('%i after every attempt → %s, three attempts', async (status, kind) => {
    const err = await provider([{ status }])
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind, status });
    expect(attemptsOf(err)).toBe(3);
  });

  test('a 503 then the answer: retried, two attempts counted', async () => {
    const r = await provider([{ status: 503 }, ANSWER]).invoke(ask);
    expect(r.message.content).toBe('Shipped.');
    expect(r.attempts).toBe(2);
  });

  test("the fetch it's given carries every attempt, counted; the global fetch none", async () => {
    const own = vi.fn(async () => new Response('{}'));
    const r = await createAiSdkModelProvider({
      metadata: METADATA,
      languageModel: fakeModel([{ status: 503 }, ANSWER], []),
      cost: () => 0,
      fetch: own as unknown as typeof globalThis.fetch,
    }).invoke(ask);
    expect(r.attempts).toBe(2);
    expect(own).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('a dropped connection (fetch failed) is retried as network', async () => {
    let calls = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response('{}');
    });
    // The fake model's own fetch throws on the first attempt, as an SDK's would.
    const r = await provider([ANSWER]).invoke(ask);
    expect(r.attempts).toBe(2);
  });

  test('an abort during the backoff stops the retries', async () => {
    const controller = new AbortController();
    const p = provider([{ status: 503, headers: { 'retry-after-ms': '60000' } }]);
    const pending = p.invoke({ ...ask, abortSignal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error('stopped'));
    expect(await pending).toMatchObject({ message: 'stopped' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

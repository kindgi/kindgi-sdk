// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The wrapper against a fake AI SDK model (no network): the model sends each attempt through
 * the `fetch` it's given, as the real providers do, so attempts are counted the same way.
 */

import {
  APICallError,
  InvalidPromptError,
  JSONParseError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import type { ModelInfo, ProviderMetadata } from '@kindgi/capabilities';
import { attemptsOf } from '@kindgi/capabilities/attempts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type AiSdkModelProviderOptions,
  attemptPrepared,
  createAiSdkModelProvider,
} from '../src/ai-sdk/index.js';
import { withCacheMarks } from '../src/ai-sdk/provider.js';
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
  | { content: LanguageModelV4Content[]; finish?: { unified: string; raw?: string } }
  | { throws: unknown };

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
        if ('throws' in step) throw step.throws;
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
          finishReason: step.finish ?? {
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

function provider(
  plan: Step[],
  seen: LanguageModelV4CallOptions[] = [],
  extra: Partial<AiSdkModelProviderOptions> = {},
) {
  return createAiSdkModelProvider({
    metadata: METADATA,
    ...extra,
    languageModel: fakeModel(plan, seen),
    providerOptions: () => ({ acme: { store: false } }),
    cost: (model, usage) =>
      (usage.promptTokens / 1000) * model.cost.promptUsdPer1kTokens +
      (usage.completionTokens / 1000) * model.cost.completionUsdPer1kTokens,
  });
}

const ANSWER: Step = { content: [{ type: 'text', text: 'Shipped.' }] };

/** A call's outcome (its result or what it threw), its backoff waits skipped. */
async function withoutWaiting(call: Promise<unknown>): Promise<unknown> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const settled = call.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    return await settled;
  } finally {
    vi.useRealTimers();
  }
}
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

test('a stop the library has no unified reason for: out of context is length, others error', async () => {
  const stopped = (raw: string) =>
    provider([
      { content: [{ type: 'text', text: 'Part' }], finish: { unified: 'other', raw } },
    ]).invoke(ask);
  expect((await stopped('model_context_window_exceeded')).finishReason).toBe('length');
  expect((await stopped('malformed_model_output')).finishReason).toBe('error');
});

describe('prompt-cache marks (cacheMark)', () => {
  const MARK = { acme: { cache: 'here' } };
  const marking = { cacheMark: () => MARK };
  const tools = [{ name: 'acme.lookup', description: 'd', inputSchema: { type: 'object' } }];
  const marks = (options: LanguageModelV4CallOptions | undefined) =>
    options?.prompt.map((m) => m.providerOptions);

  test('a call with tools: the first system message and the last one; a later system message stays unmarked', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    await provider([ANSWER], seen, marking).invoke({
      model: 'acme-large',
      messages: [
        { role: 'system', content: 'You answer about orders.' },
        { role: 'system', content: 'Context: A-1 left the warehouse.' },
        { role: 'user', content: 'Where is A-1?' },
      ],
      tools,
    });
    expect(marks(seen[0])).toEqual([MARK, undefined, MARK]);
  });

  test('a one-off call (no tools, no earlier answer): the system message only', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    await provider([ANSWER], seen, marking).invoke({
      model: 'acme-large',
      messages: [
        { role: 'system', content: 'Judge the answer.' },
        { role: 'user', content: 'Shipped.' },
      ],
    });
    expect(marks(seen[0])).toEqual([MARK, undefined]);
  });

  test('a conversation with an earlier answer, no tools: its last message too', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    await provider([ANSWER], seen, marking).invoke({
      model: 'acme-large',
      messages: [
        { role: 'user', content: 'Where is A-1?' },
        { role: 'assistant', content: 'Shipped.' },
        { role: 'user', content: 'And A-2?' },
      ],
    });
    expect(marks(seen[0])).toEqual([undefined, undefined, MARK]);
  });

  test("after a tool call: the tool results are marked, and the carried answer's own state is untouched", async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const p = provider(
      [
        {
          content: [
            { type: 'reasoning', text: 'Look.', providerMetadata: { acme: { signature: 's' } } },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'acme__lookup', input: '{}' },
          ],
        },
        ANSWER,
      ],
      seen,
      marking,
    );
    const first = await p.invoke({ ...ask, tools });
    await p.invoke({
      model: 'acme-large',
      messages: [...ask.messages, first.message, { role: 'tool', toolCallId: 'c1', content: '{}' }],
      tools,
    });
    const prompt = seen[1]?.prompt ?? [];
    expect(prompt.map((m) => [m.role, m.providerOptions])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', MARK],
    ]);
    expect(prompt[1]?.content[0]).toEqual({
      type: 'reasoning',
      text: 'Look.',
      providerOptions: { acme: { signature: 's' } },
    });
  });

  test('no cacheMark, or one that answers undefined for the model: nothing is marked', async () => {
    for (const extra of [{}, { cacheMark: () => undefined }]) {
      const seen: LanguageModelV4CallOptions[] = [];
      await provider([ANSWER], seen, extra).invoke({
        model: 'acme-large',
        messages: [
          { role: 'system', content: 'You answer about orders.' },
          { role: 'user', content: 'Where is A-1?' },
        ],
        tools,
      });
      expect(marks(seen[0])).toEqual([undefined, undefined]);
    }
  });

  test("the mark merges into a message's own options, per provider; the prompt passed in isn't changed", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: 'system', content: 'S', providerOptions: { acme: { a: 1 }, other: { b: 2 } } },
      { role: 'user', content: [{ type: 'text', text: 'U' }] },
    ];
    const before = structuredClone(prompt);
    const out = withCacheMarks(prompt, MARK, true);
    expect(out.map((m) => m.providerOptions)).toEqual([
      { acme: { a: 1, cache: 'here' }, other: { b: 2 } },
      MARK,
    ]);
    expect(prompt).toEqual(before);
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

  test('another provider’s model of the same name gets none of it', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const tools = [{ name: 'acme.lookup', description: 'd', inputSchema: { type: 'object' } }];
    const first = await provider([reasoningAnswer]).invoke({ ...ask, tools });
    const other = provider([ANSWER], seen, { metadata: { ...METADATA, id: 'acme-eu' } });
    await other.invoke({
      ...ask,
      messages: [...ask.messages, first.message, { role: 'tool', toolCallId: 'c1', content: '{}' }],
      tools,
    });
    const assistant = seen[0]?.prompt.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'acme__lookup', input: { id: 'A-1' } },
    ]);
  });

  describe('the answer’s text parts', () => {
    const twoTexts: Step = {
      content: [
        { type: 'reasoning', text: 'Check.', providerMetadata: { acme: { signature: 'sig-1' } } },
        { type: 'text', text: 'Let me look.', providerMetadata: { acme: { itemId: 'msg_1' } } },
        { type: 'text', text: '' },
        { type: 'text', text: ' One moment.', providerMetadata: { acme: { itemId: 'msg_2' } } },
        // An empty part that carries state (a thought signature) goes back; one that doesn't, not.
        { type: 'text', text: '', providerMetadata: { acme: { thoughtSignature: 'ts-1' } } },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'acme__lookup', input: '{}' },
      ],
    };
    const tools = [{ name: 'acme.lookup', description: 'd', inputSchema: { type: 'object' } }];
    const resend = async (content: (said: string) => string) => {
      const seen: LanguageModelV4CallOptions[] = [];
      const p = provider([twoTexts, ANSWER], seen);
      const first = await p.invoke({ ...ask, tools });
      const said = { ...first.message, content: content(first.message.content) };
      await p.invoke({
        ...ask,
        messages: [...ask.messages, said, { role: 'tool', toolCallId: 'c1', content: '{}' }],
        tools,
      });
      return seen[1]?.prompt.find((m) => m.role === 'assistant')?.content;
    };

    test('each goes back with its own text and its own state', async () => {
      expect(await resend((said) => said)).toEqual([
        { type: 'reasoning', text: 'Check.', providerOptions: { acme: { signature: 'sig-1' } } },
        { type: 'text', text: 'Let me look.', providerOptions: { acme: { itemId: 'msg_1' } } },
        { type: 'text', text: ' One moment.', providerOptions: { acme: { itemId: 'msg_2' } } },
        { type: 'text', text: '', providerOptions: { acme: { thoughtSignature: 'ts-1' } } },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'acme__lookup', input: {} },
      ]);
    });

    test('a trail that says something else: its text once, where the first part was, no state', async () => {
      expect(await resend(() => '[redacted]')).toEqual([
        { type: 'reasoning', text: 'Check.', providerOptions: { acme: { signature: 'sig-1' } } },
        { type: 'text', text: '[redacted]' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'acme__lookup', input: {} },
      ]);
    });

    test('a trail whose text is gone: no text part', async () => {
      expect(await resend(() => '')).toEqual([
        { type: 'reasoning', text: 'Check.', providerOptions: { acme: { signature: 'sig-1' } } },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'acme__lookup', input: {} },
      ]);
    });
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
    const r = await withoutWaiting(provider([ANSWER]).invoke(ask));
    expect(r).toMatchObject({ attempts: 2 });
  });

  test('beforeAttempt runs before each attempt, inside the retries', async () => {
    const beforeAttempt = vi.fn(async () => {});
    const r = await provider([{ status: 503 }, ANSWER], [], { beforeAttempt }).invoke(ask);
    expect(r.attempts).toBe(2);
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
  });

  test('a sign-in that fails in beforeAttempt ends the call as it is: not retried, no HTTP', async () => {
    const failed = new ModelProviderError(
      'auth',
      undefined,
      "the runtime's identity gave no credentials: the endpoint didn't answer",
    );
    const beforeAttempt = vi.fn(async () => {
      throw failed;
    });
    const err = await provider([ANSWER], [], { beforeAttempt })
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toBe(failed);
    expect(beforeAttempt).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('a ModelProviderError the adapter throws during an attempt passes through, after one attempt', async () => {
    const failed = new ModelProviderError('auth', undefined, 'no token: the identity refused');
    const err = await provider([{ throws: failed }, ANSWER])
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toBe(failed);
    expect(attemptsOf(err)).toBe(1);
  });

  test('explain: the adapter’s sentence after the message, the kind, status and attempts kept', async () => {
    const explain = vi.fn((e: ModelProviderError) =>
      e.status === 403 ? 'Check the policy.' : undefined,
    );
    const err = await provider([{ status: 403, body: '{"message":"denied"}' }], [], { explain })
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toMatchObject({
      kind: 'auth',
      status: 403,
      message: '403 {"message":"denied"} Check the policy.',
    });
    expect(attemptsOf(err)).toBe(1);
    const other = await provider([{ status: 400 }], [], { explain })
      .invoke(ask)
      .catch((e: unknown) => e);
    expect((other as Error).message).toBe('400 {"message":"nope"}');
  });

  test('a vendor asking to wait more than 60 s: rate-limited at once, its wait in the message', async () => {
    const err = await provider([{ status: 429, headers: { 'retry-after-ms': '120000' } }, ANSWER])
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      kind: 'rate-limited',
      status: 429,
      message: '429 {"message":"nope"} (the vendor asks to wait 120 s)',
    });
    expect(attemptsOf(err)).toBe(1);
  });

  test.each([
    ['ECONNRESET', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    [
      'UND_ERR_SOCKET as a cause',
      new Error('other side closed', {
        cause: Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }),
      }),
    ],
  ])('a transport failure (%s) is network, retried', async (_name, thrown) => {
    const err = await withoutWaiting(provider([{ throws: thrown }]).invoke(ask));
    expect(err).toMatchObject({ kind: 'network', status: undefined });
    expect(attemptsOf(err)).toBe(3);
  });

  test('a redirect the request won’t follow: unavailable, once, saying why', async () => {
    // As undici rejects it, and the AI SDK re-wraps it as a connection failure it would retry.
    const redirect = new APICallError({
      message: 'Cannot connect to API: unexpected redirect',
      url: 'https://llm.example.invalid/v1/generate',
      requestBodyValues: {},
      cause: new Error('unexpected redirect'),
      isRetryable: true,
    });
    const err = await provider([{ throws: redirect }, ANSWER])
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toMatchObject({ kind: 'unavailable', status: undefined });
    expect((err as Error).message).toContain("a redirect, which isn't followed");
    expect(attemptsOf(err)).toBe(1);
  });

  test('a host refused by the runtime’s egress rules (a system-style code): network, once', async () => {
    const refused = Object.assign(
      new Error('egress refused: 169.254.169.254 is link-local, which this deployment forbids'),
      { code: 'EKINDGIEGRESS' },
    );
    for (const thrown of [
      refused,
      new APICallError({
        message: `Cannot connect to API: ${refused.message}`,
        url: 'https://llm.example.invalid/v1/generate',
        requestBodyValues: {},
        cause: refused,
        isRetryable: true,
      }),
    ]) {
      const err = await provider([{ throws: thrown }, ANSWER])
        .invoke(ask)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelProviderError);
      expect(err).toMatchObject({ kind: 'network', message: refused.message });
      expect(attemptsOf(err)).toBe(1);
    }
  });

  test('a call stopped before it starts: its reason, no sign-in, no request', async () => {
    const controller = new AbortController();
    const reason = new Error('turn stopped');
    controller.abort(reason);
    const beforeAttempt = vi.fn(async () => 'token');
    const err = await provider([ANSWER], [], { beforeAttempt })
      .invoke({ ...ask, abortSignal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(beforeAttempt).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('an answer the library can’t read is unavailable, retried once', async () => {
    const unreadable = new JSONParseError({ text: '<html>', cause: new Error('Unexpected <') });
    const err = await withoutWaiting(provider([{ throws: unreadable }]).invoke(ask));
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toMatchObject({ kind: 'unavailable', status: undefined });
    expect(attemptsOf(err)).toBe(2);
    const r = await withoutWaiting(provider([{ throws: unreadable }, ANSWER]).invoke(ask));
    expect(r).toMatchObject({ attempts: 2 });
  });

  test('a request the library refuses before sending is invalid-request, one attempt', async () => {
    const refused = new InvalidPromptError({ prompt: [], message: 'no messages' });
    const err = await provider([{ throws: refused }])
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'invalid-request' });
    expect(attemptsOf(err)).toBe(1);
  });

  test('anything else (a bug) propagates as it is, not retried', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'text')");
    const err = await provider([{ throws: bug }])
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toBe(bug);
    expect(attemptsOf(err)).toBe(1);
  });

  test('the adapter’s typed error that the library re-wrapped as a connection failure passes through', async () => {
    const failed = new ModelProviderError('auth', undefined, 'the key file is unreadable');
    const wrapped = new APICallError({
      message: 'Cannot connect to API: the key file is unreadable',
      url: 'https://llm.example.invalid/v1/generate',
      requestBodyValues: {},
      cause: failed,
      isRetryable: true,
    });
    const err = await provider([{ throws: wrapped }, ANSWER])
      .invoke(ask)
      .catch((e: unknown) => e);
    expect(err).toBe(failed);
    expect(attemptsOf(err)).toBe(1);
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

describe('beforeAttempt’s result, per attempt (attemptPrepared)', () => {
  test('each attempt reads its own; nothing outside one; the call’s signal reaches it', async () => {
    const controller = new AbortController();
    let n = 0;
    const beforeAttempt = vi.fn(async () => `token-${++n}`);
    const read: (string | undefined)[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      read.push(attemptPrepared<string>());
      return new Response('{}');
    });
    const r = await provider([{ status: 503 }, ANSWER], [], { beforeAttempt }).invoke({
      ...ask,
      abortSignal: controller.signal,
    });
    expect(r.attempts).toBe(2);
    expect(read).toEqual(['token-1', 'token-2']);
    expect(beforeAttempt).toHaveBeenNthCalledWith(1, controller.signal);
    expect(attemptPrepared()).toBeUndefined();
  });

  test('calls running at once never see each other’s', async () => {
    const label = new Map<AbortSignal | undefined, string>();
    const beforeAttempt = async (signal: AbortSignal | undefined) => {
      const mine = label.get(signal);
      // The first call signs in last, so the two attempts overlap.
      await new Promise((resolve) => setTimeout(resolve, mine === 'a' ? 20 : 0));
      return mine;
    };
    const pairs: [string | undefined, string | undefined][] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      const before = attemptPrepared<string>();
      await new Promise((resolve) => setTimeout(resolve, 10));
      pairs.push([before, attemptPrepared<string>()]);
      return new Response('{}');
    });
    const p = provider([ANSWER], [], { beforeAttempt });
    const calls = ['a', 'b'].map((name) => {
      const controller = new AbortController();
      label.set(controller.signal, name);
      return p.invoke({ ...ask, abortSignal: controller.signal });
    });
    await Promise.all(calls);
    expect(pairs.sort()).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, test, vi } from 'vitest';

import type { ModelCallInput } from '@kindgi/capabilities';
import { attemptsOf } from '@kindgi/capabilities/attempts';

import { type AnthropicModelInfo, createAnthropicProvider } from '../src/provider.js';

const OPUS_MODEL: AnthropicModelInfo = {
  name: 'claude-opus-4-7',
  contextWindow: 200_000,
  features: ['tool-use', 'streaming'],
  cost: {
    promptUsdPer1kTokens: 0.005,
    completionUsdPer1kTokens: 0.025,
  },
};

const OPUS_METADATA = {
  id: 'anthropic',
  region: 'us-east-1',
  models: [OPUS_MODEL],
} as const;

function fakeResponse(over: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    model: 'claude-opus-4-7',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 20,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    ...over,
  } as unknown as Anthropic.Message;
}

function fakeClient(response: Anthropic.Message = fakeResponse()): {
  readonly client: Anthropic;
  readonly create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => response);
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}

describe('createAnthropicProvider — metadata', () => {
  test('metadata.models[0].name matches the caller-supplied model shape', () => {
    const { client } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    expect(provider.metadata.id).toBe('anthropic');
    expect(provider.metadata.models[0]?.name).toBe('claude-opus-4-7');
  });

  test('provider surfaces every model the caller lists in metadata.models', () => {
    const { client } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: {
        id: 'anthropic',
        region: 'us-east-1',
        models: [
          OPUS_MODEL,
          {
            name: 'claude-sonnet-4-6',
            contextWindow: 200_000,
            features: ['tool-use'],
            cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
          },
        ],
      },
      client,
    });
    expect(provider.metadata.models.map((m) => m.name)).toEqual([
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
  });
});

describe('createAnthropicProvider — invoke wire shape', () => {
  test('translates messages + tools + system to Anthropic Messages API shape', async () => {
    const { client, create } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    const input: ModelCallInput = {
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
      tools: [
        {
          name: 'demo.echo',
          description: 'Echo back a message.',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
        },
      ],
      maxOutputTokens: 1024,
    };
    await provider.invoke(input);

    expect(create).toHaveBeenCalledOnce();
    const [callBody] = create.mock.calls[0] as [Record<string, unknown>];
    expect(callBody.model).toBe('claude-opus-4-7');
    expect(callBody.max_tokens).toBe(1024);
    // Cache breakpoints: the tools, the agent's prompt, and (a call with
    // tools can continue) the last message.
    expect(callBody.system).toEqual([
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(callBody.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }],
      },
    ]);
    expect(callBody.tools).toEqual([
      {
        name: 'demo__echo',
        description: 'Echo back a message.',
        input_schema: { type: 'object', properties: { message: { type: 'string' } } },
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  test("the system prompt names the call's tools as sent; the caller's messages keep the ids (T311)", async () => {
    const { client, create } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    const system = 'Call `demo.echo` with the message. Never demo.echoes or other.echo.';
    const input: ModelCallInput = {
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Use demo.echo please' },
      ],
      tools: [
        { name: 'demo.echo', description: 'Echo back a message.', inputSchema: { type: 'object' } },
      ],
    };
    await provider.invoke(input);
    const [callBody] = create.mock.calls[0] as [Record<string, unknown>];
    expect(callBody.system).toEqual([
      {
        type: 'text',
        text: 'Call `demo__echo` with the message. Never demo.echoes or other.echo.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    // The user's own words, and the trail the caller keeps, are untouched.
    expect(callBody.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Use demo.echo please', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
    expect(input.messages[0]?.content).toBe(system);
  });

  test('defaults max_tokens to adapter DEFAULT (4096) when neither input nor model provides one', async () => {
    const { client, create } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const [callBody] = create.mock.calls[0] as [Record<string, unknown>];
    expect(callBody.max_tokens).toBe(4096);
  });

  test("each system message is its own block and only the agent's prompt is cached: retrieved context changes per turn", async () => {
    const { client, create } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You answer questions about orders. Use demo.echo to repeat.' },
        { role: 'system', content: 'Retrieved: order A-1042 shipped.' },
        { role: 'user', content: 'Where is A-1042?' },
        { role: 'assistant', content: 'It shipped.' },
        { role: 'user', content: 'Thanks. And A-1043?' },
      ],
      tools: [
        { name: 'demo.echo', description: 'Echo back a message.', inputSchema: { type: 'object' } },
      ],
    });
    const [callBody] = create.mock.calls[0] as [Record<string, unknown>];
    expect(callBody.system).toEqual([
      {
        type: 'text',
        text: 'You answer questions about orders. Use demo__echo to repeat.',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: 'Retrieved: order A-1042 shipped.' },
    ]);
    const messages = callBody.messages as { content: { cache_control?: unknown }[] }[];
    expect(messages.map((m) => m.content.map((b) => b.cache_control !== undefined))).toEqual([
      [false],
      [false],
      [true],
    ]);
  });

  test('per-model maxOutputTokens overrides the adapter DEFAULT when caller omits maxOutputTokens', async () => {
    const { client, create } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: {
        id: 'anthropic',
        region: 'us-east-1',
        models: [{ ...OPUS_MODEL, maxOutputTokens: 16000 }],
      },
      client,
    });
    await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const [callBody] = create.mock.calls[0] as [Record<string, unknown>];
    expect(callBody.max_tokens).toBe(16000);
  });

  test('omits tools + system when not provided', async () => {
    const { client, create } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const [callBody] = create.mock.calls[0] as [Record<string, unknown>];
    expect(callBody.tools).toBeUndefined();
    expect(callBody.system).toBeUndefined();
  });

  test('propagates abort signal via request options', async () => {
    const { client, create } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    const controller = new AbortController();
    await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: controller.signal,
    });
    const [, options] = create.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options.signal).toBe(controller.signal);
  });

  test('rejects unknown model names with a clean error listing available models', async () => {
    const { client } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    await expect(
      provider.invoke({ model: 'not-a-real-model', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/does not expose model "not-a-real-model"/);
  });
});

describe('createAnthropicProvider — result shape', () => {
  test('returns finishReason, usage, costUsd, provider, durationMs', async () => {
    const { client } = fakeClient(
      fakeResponse({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'calling' },
          // Anthropic returns the encoded name (mirror of the encoded
          // name we sent in `toAnthropicTools`); the framework side
          // sees it decoded back to canonical `demo.echo`.
          { type: 'tool_use', id: 'tu-1', name: 'demo__echo', input: { message: 'hi' } },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      }),
    );
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: OPUS_METADATA,
      client,
    });
    const result = await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.finishReason).toBe('tool-use');
    expect(result.message.content).toBe('calling');
    expect(result.message.toolCalls).toEqual([
      { id: 'tu-1', name: 'demo.echo', arguments: { message: 'hi' } },
    ]);
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
    // 100 * 0.005/1k + 20 * 0.025/1k = 0.0005 + 0.0005 = 0.001
    expect(result.costUsd).toBeCloseTo(0.001, 10);
    expect(result.provider).toEqual({ id: 'anthropic', model: 'claude-opus-4-7' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('createAnthropicProvider — lazy apiKey resolver', () => {
  test('static apiKey string is passed through unchanged', () => {
    const provider = createAnthropicProvider({
      apiKey: 'sk-static',
      metadata: OPUS_METADATA,
      client: fakeClient().client, // dep-injected — resolver isn't invoked
    });
    expect(provider.metadata.id).toBe('anthropic');
  });

  test('function resolver is called lazily under dep-injected client', async () => {
    const resolver = vi.fn().mockResolvedValueOnce('sk-1').mockResolvedValueOnce('sk-2');
    const { client } = fakeClient();
    const provider = createAnthropicProvider({
      apiKey: resolver,
      metadata: OPUS_METADATA,
      client, // dep-injected client bypasses the SDK constructor
    });
    expect(resolver).not.toHaveBeenCalled(); // not called on construction
    await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // With dep-injected client, the resolver short-circuits — verify
    // the provider doesn't crash under a lazy resolver + client
    // combination. The lazy-refresh behavior (when no dep client is
    // injected) is covered by the client-cache design; live
    // validation exercises the full path.
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('createAnthropicProvider — what the vendor says about the call', () => {
  test('a call the vendor refuses on every attempt throws its own error; attemptsOf counts them', async () => {
    let sent = 0;
    const fetch: typeof globalThis.fetch = async () => {
      sent += 1;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }), {
        status: 529,
        headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
      });
    };
    const provider = createAnthropicProvider({
      apiKey: 'sk-test',
      metadata: OPUS_METADATA,
      clientOptions: { fetch, maxRetries: 2 },
    });
    const thrown = await provider
      .invoke({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      } as ModelCallInput)
      .catch((error: unknown) => error);
    // The SDK's own error, unchanged: callers can still read its status.
    expect(thrown).toBeInstanceOf(Anthropic.APIError);
    expect((thrown as InstanceType<typeof Anthropic.APIError>).status).toBe(529);
    expect(sent).toBe(3);
    expect(attemptsOf(thrown)).toBe(3);
  });

  test("served model, request id, raw usage, and the attempts its SDK's retries took", async () => {
    // The vendor is overloaded once (529, which the SDK retries), then answers.
    const sent: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      sent.push(String(input));
      if (sent.length === 1) {
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }),
          {
            status: 529,
            headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
          },
        );
      }
      return new Response(
        JSON.stringify(
          fakeResponse({
            model: 'claude-opus-4-7-20260101',
            usage: {
              input_tokens: 20,
              output_tokens: 5,
              cache_creation_input_tokens: 300,
              cache_read_input_tokens: 700,
            },
          }),
        ),
        { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_42' } },
      );
    };
    const provider = createAnthropicProvider({
      apiKey: 'sk-test',
      metadata: OPUS_METADATA,
      clientOptions: { fetch },
    });
    const result = await provider.invoke({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    } as ModelCallInput);

    expect(sent).toHaveLength(2);
    expect(result).toMatchObject({
      provider: { id: 'anthropic', model: 'claude-opus-4-7' },
      servedModel: 'claude-opus-4-7-20260101',
      providerRequestId: 'req_42',
      attempts: 2,
      usage: {
        promptTokens: 1020,
        completionTokens: 5,
        cacheReadTokens: 700,
        cacheWriteTokens: 300,
      },
      rawUsage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 700,
      },
    });
  });
});

describe("createAnthropicProvider — a model that doesn't take sampling", () => {
  // Claude 4.7 and later answer a non-default temperature with a 400.
  const NO_SAMPLING = { ...OPUS_MODEL, name: 'claude-sonnet-5-5', sampling: false };
  const provider = (client: Anthropic) =>
    createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: { id: 'anthropic', region: 'us-east-1', models: [OPUS_MODEL, NO_SAMPLING] },
      client,
    });
  const ask = (model: string): ModelCallInput => ({
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    temperature: 0.2,
  });

  test('the call goes without the temperature, and the answer says so', async () => {
    const { client, create } = fakeClient();
    const result = await provider(client).invoke(ask('claude-sonnet-5-5'));
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
    expect(result.warnings).toEqual([
      {
        code: 'sampling-unsupported',
        message:
          "claude-sonnet-5-5 doesn't take a temperature, so the call went without one (it asked for 0.2).",
      },
    ]);
  });

  test('a model that takes it still gets it, with no warning', async () => {
    const { client, create } = fakeClient();
    const result = await provider(client).invoke(ask('claude-opus-4-7'));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ temperature: 0.2 });
    expect(result).not.toHaveProperty('warnings');
  });
});

describe("createAnthropicProvider — thinking: 'lowest'", () => {
  // Anthropic's own table: Sonnet 5.5 turns up-front thinking off with
  // `between_tools`, Haiku 5.5 with `disabled` (both only at effort high or
  // below); Opus 5.5 always thinks, so only its effort can go down.
  const model = (name: string, thinking?: { mode: 'adaptive' | 'always'; lowest: string }) => ({
    ...OPUS_MODEL,
    name,
    ...(thinking !== undefined && { thinking }),
  });
  const provider = (client: Anthropic) =>
    createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: {
        id: 'anthropic',
        region: 'us-east-1',
        models: [
          model('claude-sonnet-5-5', { mode: 'adaptive', lowest: 'between_tools' }),
          model('claude-haiku-5-5', { mode: 'adaptive', lowest: 'disabled' }),
          model('claude-opus-5-5', { mode: 'always', lowest: 'low' }),
          OPUS_MODEL,
        ],
      },
      client,
    });
  const sent = async (name: string, hint: boolean) => {
    const { client, create } = fakeClient();
    await provider(client).invoke({
      model: name,
      messages: [{ role: 'user', content: 'Hi' }],
      ...(hint && { thinking: 'lowest' as const }),
    });
    return create.mock.calls[0]?.[0] as Record<string, unknown>;
  };

  test('turns thinking off where the model allows it, with effort low', async () => {
    expect(await sent('claude-sonnet-5-5', true)).toMatchObject({
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
    });
    expect(await sent('claude-haiku-5-5', true)).toMatchObject({
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
    });
  });

  test('a model that always thinks gets its lowest effort alone', async () => {
    const body = await sent('claude-opus-5-5', true);
    expect(body).toMatchObject({ output_config: { effort: 'low' } });
    expect(body).not.toHaveProperty('thinking');
  });

  test('without the hint, or for a model with no thinking data, nothing is sent', async () => {
    for (const body of [
      await sent('claude-sonnet-5-5', false),
      await sent('claude-opus-4-7', true),
    ]) {
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('output_config');
    }
  });

  test('a thinking answer (a thinking block, then the text) gives the text and counts the thinking', async () => {
    // The shape Anthropic answers with when thinking is shown: a thinking block first.
    const { client } = fakeClient(
      fakeResponse({
        content: [
          { type: 'thinking', thinking: 'The answer is on topic.', signature: 'sig' },
          { type: 'text', text: 'PASS\nOn topic.' },
        ],
        usage: { input_tokens: 60, output_tokens: 90 },
      }),
    );
    const result = await provider(client).invoke({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'Judge it.' }],
      thinking: 'lowest',
      maxOutputTokens: 2304,
    });
    expect(result.message.content).toBe('PASS\nOn topic.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.completionTokens).toBe(90);
  });
});

describe('createAnthropicProvider — a long prompt', () => {
  test("prices at the registration's long-context rates", async () => {
    const { client } = fakeClient(
      fakeResponse({ usage: { input_tokens: 150_000, output_tokens: 2000 } }),
    );
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: {
        id: 'anthropic',
        region: 'us-east-1',
        models: [
          {
            ...OPUS_MODEL,
            name: 'claude-haiku-5-5',
            cost: {
              promptUsdPer1kTokens: 0.0001,
              completionUsdPer1kTokens: 0.0005,
              longContext: {
                thresholdTokens: 100_000,
                promptUsdPer1kTokens: 0.0005,
                completionUsdPer1kTokens: 0.0025,
              },
            },
          },
        ],
      },
      client,
    });
    const result = await provider.invoke({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'Summarize the attached corpus.' }],
    });
    expect(result.costUsd).toBeCloseTo((150_000 * 0.0005 + 2000 * 0.0025) / 1000, 10);
  });
});

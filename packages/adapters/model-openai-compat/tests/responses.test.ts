// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Responses API path: which registrations take it, what it sends
 * (`store: false`, the conversation as input items, flat function tools,
 * `text.format`), how it reads the answer, and the output a reasoning
 * model's tool calls carry to the next call (`ModelToolCall.signature`).
 */

import { describe, expect, test } from 'vitest';

import type { ModelCallInput, ModelMessage, ProviderMetadata } from '@kindgi/capabilities';

import {
  BASE_URLS,
  EXTRA_BODY_RESERVED_RESPONSES,
  OPENAI_COMPAT_ADAPTER_ID,
  createOpenAICompatModelProvider,
  defaultOpenAICompatApi,
  openAICompatAdapterFactory,
  openAICompatApi,
} from '../src/index.js';

const metadata: ProviderMetadata = {
  id: 'openai',
  region: 'unspecified',
  models: ['gpt-6.1-sol', 'gpt-6-luna'].map((name) => ({
    name,
    contextWindow: 1050000,
    features: ['tool-use', 'parallel-tool-use', 'structured-output'] as const,
    cost: { promptUsdPer1kTokens: 0.002, completionUsdPer1kTokens: 0.01 },
  })),
};

const USAGE = {
  input_tokens: 30,
  input_tokens_details: { cached_tokens: 10, cache_write_tokens: 4 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 8 },
  total_tokens: 50,
};

/** A Responses API answer around `output`, as `POST /v1/responses` returns it. */
function response(output: unknown[], fields: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: 'gpt-6.1-sol-2026-09-01',
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    store: false,
    usage: USAGE,
    ...fields,
  };
}

const textMessage = (text: string, phase?: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
  ...(phase !== undefined && { phase }),
});

const reasoningItem = (id = 'rs_1', encrypted: string | null = 'gAAAA-encrypted-1') => ({
  type: 'reasoning',
  id,
  summary: [],
  encrypted_content: encrypted,
});

const functionCallItem = (n: number, args = `{"orderId":"A-${n}"}`) => ({
  type: 'function_call',
  id: `fc_${n}`,
  call_id: `call_${n}`,
  name: 'acme__lookup_order',
  arguments: args,
  status: 'completed',
});

interface Seen {
  readonly url: string;
  readonly traceparent: string | null;
  readonly body: Record<string, unknown>;
}

/** A fake endpoint: records each request, answers with the next body. */
function fakeEndpoint(...answers: unknown[]): { seen: Seen[]; fetch: typeof fetch } {
  const seen: Seen[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    seen.push({
      url: String(url),
      traceparent: new Headers(init?.headers).get('traceparent'),
      body: JSON.parse(String(init?.body)),
    });
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': `req_${seen.length}` },
    });
  };
  return { seen, fetch: fake as typeof fetch };
}

/** An OpenAI registration, as the runtime's factory builds it. */
function openai(endpoint: { fetch: typeof fetch }, config: Record<string, string> = {}) {
  return openAICompatAdapterFactory({
    metadata,
    config: { baseURL: BASE_URLS.OPENAI, ...config },
    fetch: endpoint.fetch,
  });
}

const ask = (content = 'hello', model = 'gpt-6.1-sol'): ModelCallInput => ({
  model,
  messages: [{ role: 'user', content }],
});

describe('which API a registration speaks', () => {
  test('api.openai.com speaks Responses unless adapter_config.api says otherwise', async () => {
    const endpoint = fakeEndpoint(response([textMessage('hi')]));
    await openai(endpoint).invoke(ask());
    expect(endpoint.seen.map((s) => s.url)).toEqual(['https://api.openai.com/v1/responses']);

    const chat = fakeEndpoint({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-6.1-sol',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    });
    await openai(chat, { api: 'chat-completions' }).invoke(ask());
    expect(chat.seen.map((s) => s.url)).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  test('another endpoint speaks Chat Completions unless adapter_config.api says responses', async () => {
    const endpoint = fakeEndpoint(response([textMessage('hi')]));
    await openAICompatAdapterFactory({
      metadata,
      config: { baseURL: 'http://llm.test/v1', api: 'responses' },
      fetch: endpoint.fetch,
    }).invoke(ask());
    expect(endpoint.seen.map((s) => s.url)).toEqual(['http://llm.test/v1/responses']);
  });

  test('the default goes by the base URL host', () => {
    expect(defaultOpenAICompatApi(BASE_URLS.OPENAI)).toBe('responses');
    expect(defaultOpenAICompatApi('https://api.openai.com')).toBe('responses');
    expect(defaultOpenAICompatApi('https://eu.api.openai.com/v1')).toBe('responses');
    expect(defaultOpenAICompatApi('https://acmeapi.openai.com/v1')).toBe('chat-completions');
    expect(defaultOpenAICompatApi('https://api.openai.com.acme.test/v1')).toBe('chat-completions');
    expect(defaultOpenAICompatApi('https://acme.test/api.openai.com/v1')).toBe('chat-completions');
    expect(defaultOpenAICompatApi(BASE_URLS.GROQ)).toBe('chat-completions');
    expect(defaultOpenAICompatApi(BASE_URLS.OLLAMA_LOCAL)).toBe('chat-completions');
    expect(defaultOpenAICompatApi('not a url')).toBe('chat-completions');
    expect(openAICompatApi({ metadata, config: { baseURL: BASE_URLS.OPENROUTER } })).toBe(
      'chat-completions',
    );
  });

  test('refuses an API it does not speak, naming the key', () => {
    for (const api of ['completions', 'Responses', '']) {
      expect(() =>
        openAICompatAdapterFactory({ metadata, config: { baseURL: BASE_URLS.OPENAI, api } }),
      ).toThrow(
        `${OPENAI_COMPAT_ADAPTER_ID}: provider "openai": adapter_config.api must be one of responses, chat-completions.`,
      );
    }
    expect(() =>
      createOpenAICompatModelProvider({
        baseURL: BASE_URLS.OPENAI,
        apiKey: 'k',
        metadata,
        api: 'assistants' as never,
      }),
    ).toThrow('api must be one of responses, chat-completions');
  });
});

describe('what the Responses path sends', () => {
  test('a plain call: model, input, store: false, and nothing else', async () => {
    const endpoint = fakeEndpoint(response([textMessage('hi')]));
    await openai(endpoint).invoke(ask());
    const body = endpoint.seen[0]?.body ?? {};
    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'store', 'stream']);
    expect(body).toEqual({
      model: 'gpt-6.1-sol',
      input: [{ role: 'user', content: 'hello' }],
      store: false,
      stream: false,
    });
  });

  test('flat function tools (encoded names, strict off), json_schema output, temperature, max_output_tokens', async () => {
    const endpoint = fakeEndpoint(response([textMessage('{"answer":"ok"}')]));
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    await openai(endpoint).invoke({
      ...ask(),
      tools: [
        {
          name: 'acme.lookup_order',
          description: 'Look up an order',
          inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
        },
      ],
      structuredOutput: { name: 'answer', schema },
      temperature: 0.2,
      maxOutputTokens: 64,
    });
    expect(endpoint.seen[0]?.body).toMatchObject({
      tools: [
        {
          type: 'function',
          name: 'acme__lookup_order',
          description: 'Look up an order',
          parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
          strict: false,
        },
      ],
      text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } },
      temperature: 0.2,
      max_output_tokens: 64,
      store: false,
    });
  });

  test('the conversation as input items: system as developer, tool calls and their outputs', async () => {
    const endpoint = fakeEndpoint(response([textMessage('done')]));
    const messages: ModelMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Where is A-1?' },
      {
        role: 'assistant',
        content: 'Looking it up.',
        toolCalls: [{ id: 'call_1', name: 'acme.lookup_order', arguments: { orderId: 'A-1' } }],
      },
      { role: 'tool', content: '{"status":"shipped"}', toolCallId: 'call_1' },
      { role: 'assistant', content: 'It shipped.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Thanks' },
    ];
    await openai(endpoint).invoke({ model: 'gpt-6.1-sol', messages });
    expect(endpoint.seen[0]?.body.input).toEqual([
      { role: 'developer', content: 'Be brief.' },
      { role: 'user', content: 'Where is A-1?' },
      { role: 'assistant', content: 'Looking it up.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-1"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"status":"shipped"}' },
      { role: 'assistant', content: 'It shipped.' },
      { role: 'user', content: 'Thanks' },
    ]);
  });

  test("extraBody is merged; the fields this path sets are refused, other APIs' fields are not", async () => {
    const endpoint = fakeEndpoint(response([textMessage('hi')]));
    await openai(endpoint, {
      'extraBody.reasoning.effort': 'low',
      'extraBody.messages': 'not this API’s field',
    }).invoke(ask());
    expect(endpoint.seen[0]?.body).toMatchObject({
      reasoning: { effort: 'low' },
      messages: 'not this API’s field',
      store: false,
    });

    expect(EXTRA_BODY_RESERVED_RESPONSES).toContain('store');
    expect(() => openai(endpoint, { 'extraBody.store': 'true' })).toThrow(
      `${OPENAI_COMPAT_ADAPTER_ID}: provider "openai": adapter_config extraBody can't set store: the adapter sets it`,
    );
    expect(() => openai(endpoint, { 'extraBody.input': 'x', 'extraBody.text': 'y' })).toThrow(
      "extraBody can't set input, text: the adapter sets them",
    );
    // Chat Completions takes `store`; it's the Responses path that sets it.
    expect(() =>
      openai(endpoint, { api: 'chat-completions', 'extraBody.store': 'true' }),
    ).not.toThrow();
    expect(() =>
      createOpenAICompatModelProvider({
        baseURL: BASE_URLS.OPENAI,
        apiKey: 'k',
        metadata,
        extraBody: { max_output_tokens: 1 },
      }),
    ).toThrow("extraBody can't set max_output_tokens");
  });

  test('a call with a traceparent sends it as a header, never in the body; without, none', async () => {
    const endpoint = fakeEndpoint(response([textMessage('hi')]));
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await openai(endpoint).invoke({ ...ask(), traceparent });
    await openai(endpoint).invoke(ask());
    expect(endpoint.seen.map((s) => s.traceparent)).toEqual([traceparent, null]);
    expect(JSON.stringify(endpoint.seen[0]?.body)).not.toContain('traceparent');
  });

  test("the turn's abort signal reaches the request", async () => {
    const endpoint = fakeEndpoint(response([textMessage('hi')]));
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      openai(endpoint).invoke({ ...ask(), abortSignal: aborted.signal }),
    ).rejects.toThrow();
    expect(endpoint.seen).toEqual([]);
  });
});

describe('how the Responses path reads the answer', () => {
  test('text, usage with its cached, cache-write and reasoning parts, served model, request id, attempts', async () => {
    const endpoint = fakeEndpoint(
      response([reasoningItem(), textMessage('Hello', 'final_answer')]),
    );
    const result = await openai(endpoint).invoke(ask());
    expect(result).toMatchObject({
      message: { role: 'assistant', content: 'Hello' },
      finishReason: 'stop',
      usage: {
        promptTokens: 30,
        completionTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 4,
        reasoningTokens: 8,
      },
      rawUsage: USAGE,
      provider: { id: 'openai', model: 'gpt-6.1-sol' },
      servedModel: 'gpt-6.1-sol-2026-09-01',
      providerRequestId: 'req_1',
      attempts: 1,
    });
    expect(result.message.toolCalls).toBeUndefined();
    expect(result.costUsd).toBeCloseTo((30 / 1000) * 0.002 + (20 / 1000) * 0.01, 12);
    expect(result.warnings).toBeUndefined();
  });

  test('tool calls: decoded names, parsed arguments ({} when they do not parse)', async () => {
    const endpoint = fakeEndpoint(
      response([functionCallItem(1), functionCallItem(2, '{not json')]),
    );
    const result = await openai(endpoint).invoke(ask());
    expect(result.finishReason).toBe('tool-use');
    expect(result.message).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'acme.lookup_order', arguments: { orderId: 'A-1' } },
        { id: 'call_2', name: 'acme.lookup_order', arguments: {} },
      ],
    });
  });

  test("a refusal is the answer's text when there's no other text", async () => {
    const endpoint = fakeEndpoint(
      response([
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: "I can't help with that." }],
        },
      ]),
    );
    const result = await openai(endpoint).invoke(ask());
    expect(result.message.content).toBe("I can't help with that.");
  });

  test('incomplete: the output limit is length, the content filter is content-filter', async () => {
    const cut = (reason: string) =>
      response([textMessage('Hel')], { status: 'incomplete', incomplete_details: { reason } });
    const length = await openai(fakeEndpoint(cut('max_output_tokens'))).invoke(ask());
    expect(length.finishReason).toBe('length');
    expect(length.message.content).toBe('Hel');
    const filtered = await openai(fakeEndpoint(cut('content_filter'))).invoke(ask());
    expect(filtered.finishReason).toBe('content-filter');
  });

  test("a failed or unfinished response throws, naming OpenAI's error", async () => {
    const failed = response([], {
      status: 'failed',
      error: { code: 'server_error', message: 'The model had an error.' },
    });
    await expect(openai(fakeEndpoint(failed)).invoke(ask())).rejects.toThrow(
      `${OPENAI_COMPAT_ADAPTER_ID}: provider "openai": the response failed (server_error: The model had an error.).`,
    );
    await expect(
      openai(fakeEndpoint(response([], { status: 'cancelled' }))).invoke(ask()),
    ).rejects.toThrow('the response ended "cancelled" (status "cancelled").');
  });
});

describe('what a reasoning model carries between its tool calls', () => {
  /** Two parallel calls after reasoning and a commentary message. */
  const toolTurn = response([
    reasoningItem('rs_1', 'gAAAA-encrypted-1'),
    textMessage('Checking both orders.', 'commentary'),
    functionCallItem(1),
    functionCallItem(2),
  ]);

  /** The turn's answer, its tool results, and the next call's input. */
  async function continued(nextModel: string, answer = toolTurn) {
    const endpoint = fakeEndpoint(answer, response([textMessage('Both shipped.')]));
    const provider = openai(endpoint);
    const first = await provider.invoke(ask('Where are A-1 and A-2?'));
    const history: ModelMessage[] = [
      { role: 'user', content: 'Where are A-1 and A-2?' },
      first.message,
      { role: 'tool', content: '{"status":"shipped"}', toolCallId: 'call_1' },
      { role: 'tool', content: '{"status":"shipped"}', toolCallId: 'call_2' },
    ];
    await provider.invoke({ model: nextModel, messages: history });
    return { first, input: endpoint.seen[1]?.body.input as unknown[] };
  }

  const outputs = [
    { type: 'function_call_output', call_id: 'call_1', output: '{"status":"shipped"}' },
    { type: 'function_call_output', call_id: 'call_2', output: '{"status":"shipped"}' },
  ];

  test('the same model gets its reasoning, message and calls back, in order, linked by their ids', async () => {
    const { first, input } = await continued('gpt-6.1-sol');
    const [one, two] = first.message.toolCalls ?? [];
    expect(one?.signature).toMatch(/^oair1\.[A-Za-z0-9_-]+$/);
    expect(two?.signature).toBeUndefined();
    expect(first.message.content).toBe('Checking both orders.');
    expect(input).toEqual([
      { role: 'user', content: 'Where are A-1 and A-2?' },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA-encrypted-1' },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Checking both orders.', annotations: [] }],
        phase: 'commentary',
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-1"}',
        id: 'fc_1',
      },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-2"}',
        id: 'fc_2',
      },
      ...outputs,
    ]);
  });

  test('another model gets the turn without it: no reasoning, no ids, no phase', async () => {
    const { input } = await continued('gpt-6-luna');
    expect(input).toEqual([
      { role: 'user', content: 'Where are A-1 and A-2?' },
      { role: 'assistant', content: 'Checking both orders.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-1"}',
      },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-2"}',
      },
      ...outputs,
    ]);
  });

  test("a signature that isn't this adapter's, or no longer matches the turn's calls, is ignored", async () => {
    const plain = [
      { role: 'assistant', content: 'Checking.' },
      { type: 'function_call', call_id: 'call_1', name: 'acme__lookup_order', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ];
    const { first } = await continued('gpt-6.1-sol');
    const ours = first.message.toolCalls?.[0]?.signature ?? '';
    const decoded = JSON.parse(Buffer.from(ours.slice('oair1.'.length), 'base64url').toString());
    const reencode = (value: unknown) =>
      `oair1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    for (const signature of [
      'CiQBjz1rX-gemini-thought-signature==',
      'oair1.%%%',
      'oair1.e30', // {}
      ours, // names two calls; the turn below has one
      reencode({ ...decoded, items: [{ type: 'reasoning', id: 'rs_1', summary: [] }] }),
      reencode({ ...decoded, items: [{ type: 'mystery', id: 'x' }] }),
    ]) {
      const endpoint = fakeEndpoint(response([textMessage('ok')]));
      await openai(endpoint).invoke({
        model: 'gpt-6.1-sol',
        messages: [
          {
            role: 'assistant',
            content: 'Checking.',
            toolCalls: [{ id: 'call_1', name: 'acme.lookup_order', arguments: {}, signature }],
          },
          { role: 'tool', content: 'ok', toolCallId: 'call_1' },
        ],
      });
      expect(endpoint.seen[0]?.body.input).toEqual(plain);
    }
  });

  test('nothing is carried without reasoning or a phase, or when it could not go back as it came', async () => {
    const unsigned = async (output: unknown[]) => {
      const result = await openai(fakeEndpoint(response(output))).invoke(ask());
      return result.message.toolCalls?.map((c) => c.signature);
    };
    // Nothing to carry.
    expect(await unsigned([textMessage('Checking.'), functionCallItem(1)])).toEqual([undefined]);
    // A reasoning item without its encrypted content.
    expect(await unsigned([reasoningItem('rs_1', null), functionCallItem(1)])).toEqual([undefined]);
    // Two messages: the turn keeps one text.
    expect(
      await unsigned([
        reasoningItem(),
        textMessage('One.', 'commentary'),
        { ...textMessage('Two.', 'commentary'), id: 'msg_2' },
        functionCallItem(1),
      ]),
    ).toEqual([undefined]);
    // A call without its item id.
    const { id: _id, ...noId } = functionCallItem(1);
    expect(await unsigned([reasoningItem(), noId])).toEqual([undefined]);
    // An answer without tool calls carries nothing: a final answer's phase isn't carried.
    const final = await openai(
      fakeEndpoint(response([reasoningItem(), textMessage('Done.', 'final_answer')])),
    ).invoke(ask());
    expect(final.message).toEqual({ role: 'assistant', content: 'Done.' });
  });

  test("a phase without reasoning goes back on the message, and the calls' ids don't", async () => {
    const { first, input } = await continued(
      'gpt-6.1-sol',
      response([
        textMessage('Checking both orders.', 'commentary'),
        functionCallItem(1),
        functionCallItem(2),
      ]),
    );
    expect(first.message.toolCalls?.[0]?.signature).toMatch(/^oair1\./);
    expect(input).toEqual([
      { role: 'user', content: 'Where are A-1 and A-2?' },
      { role: 'assistant', content: 'Checking both orders.', phase: 'commentary' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-1"}',
      },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-2"}',
      },
      ...outputs,
    ]);
  });

  test("reasoning with calls and no message: the empty text isn't sent", async () => {
    const { input } = await continued(
      'gpt-6.1-sol',
      response([reasoningItem(), functionCallItem(1), functionCallItem(2)]),
    );
    expect(input.slice(1, 4)).toEqual([
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA-encrypted-1' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-1"}',
        id: 'fc_1',
      },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'acme__lookup_order',
        arguments: '{"orderId":"A-2"}',
        id: 'fc_2',
      },
    ]);
  });

  test("a carried message whose turn now has no text isn't sent", async () => {
    const endpoint = fakeEndpoint(toolTurn, response([textMessage('ok')]));
    const provider = openai(endpoint);
    const first = await provider.invoke(ask());
    await provider.invoke({
      model: 'gpt-6.1-sol',
      messages: [
        { ...first.message, content: '' },
        { role: 'tool', content: 'ok', toolCallId: 'call_1' },
        { role: 'tool', content: 'ok', toolCallId: 'call_2' },
      ],
    });
    const input = endpoint.seen[1]?.body.input as { type?: string }[];
    expect(input.map((item) => item.type)).toEqual([
      'reasoning',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
    ]);
  });
});

describe('the Responses path follows the model data', () => {
  const thinkingModels: ProviderMetadata = {
    id: 'openai',
    region: 'unspecified',
    models: [
      {
        name: 'gpt-6.1-sol',
        contextWindow: 1050000,
        features: ['tool-use'],
        cost: { promptUsdPer1kTokens: 0.002, completionUsdPer1kTokens: 0.01 },
        sampling: false,
        thinking: { mode: 'adaptive', lowest: 'low' },
      },
    ],
  };
  const provider = (endpoint: { fetch: typeof fetch }, config: Record<string, string> = {}) =>
    openAICompatAdapterFactory({
      metadata: thinkingModels,
      config: { baseURL: BASE_URLS.OPENAI, ...config },
      fetch: endpoint.fetch,
    });

  test("a temperature the model doesn't take isn't sent, and the answer says so", async () => {
    const endpoint = fakeEndpoint(response([textMessage('ok')]));
    const result = await provider(endpoint).invoke({ ...ask(), temperature: 0.2 });
    expect(endpoint.seen[0]?.body).not.toHaveProperty('temperature');
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'sampling-unsupported' })]);
  });

  test("thinking 'lowest' sends the model's lowest effort, keeping a registration's other reasoning fields", async () => {
    const endpoint = fakeEndpoint(response([textMessage('PASS')]));
    await provider(endpoint).invoke({ ...ask(), thinking: 'lowest' });
    await provider(endpoint).invoke(ask());
    await provider(endpoint, { 'extraBody.reasoning.summary': 'auto' }).invoke({
      ...ask(),
      thinking: 'lowest',
    });
    expect(endpoint.seen.map((s) => s.body.reasoning)).toEqual([
      { effort: 'low' },
      undefined,
      { summary: 'auto', effort: 'low' },
    ]);
  });

  test('the developer message names the tools as they are sent', async () => {
    const endpoint = fakeEndpoint(response([textMessage('ok')]));
    await provider(endpoint).invoke({
      model: 'gpt-6.1-sol',
      messages: [
        { role: 'system', content: 'Use acme.lookup_order to find orders.' },
        { role: 'user', content: 'Where is A-1?' },
      ],
      tools: [
        {
          name: 'acme.lookup_order',
          description: 'Look up an order',
          inputSchema: { type: 'object' },
        },
      ],
    });
    expect((endpoint.seen[0]?.body.input as unknown[])[0]).toEqual({
      role: 'developer',
      content: 'Use acme__lookup_order to find orders.',
    });
  });
});

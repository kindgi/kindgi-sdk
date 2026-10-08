// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The runtime's factory (`adapter_config.baseURL` and `extraBody`, the key
 * from `secret_ref`) and what `invoke` sends: the key the resolver returns
 * on each call, the endpoint, the extra body fields, the turn's abort signal.
 */

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, test } from 'vitest';

import type { ProviderMetadata } from '@kindgi/capabilities';

import {
  BASE_URLS,
  OPENAI_COMPAT_ADAPTER_ID,
  createOpenAICompatModelProvider,
  openAICompatAdapterFactory,
  openAICompatBaseUrl,
  openAICompatExtraBody,
} from '../src/index.js';

const metadata: ProviderMetadata = {
  id: 'openai',
  region: 'unspecified',
  models: [
    {
      name: 'gpt-test',
      contextWindow: 128000,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.001, completionUsdPer1kTokens: 0.002 },
    },
  ],
};

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

interface Seen {
  readonly url: string;
  readonly authorization: string | null;
  readonly traceparent: string | null;
  readonly body: {
    readonly messages?: unknown;
    readonly temperature?: unknown;
    readonly [field: string]: unknown;
  };
}

/** A fake endpoint: records each request, answers with one completion. */
function fakeEndpoint(): { readonly seen: Seen[]; readonly fetch: typeof fetch } {
  const seen: Seen[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    seen.push({
      url: String(url),
      authorization: new Headers(init?.headers).get('authorization'),
      traceparent: new Headers(init?.headers).get('traceparent'),
      body: JSON.parse(String(init?.body)) as Seen['body'],
    });
    return new Response(JSON.stringify(COMPLETION), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { seen, fetch: fake as typeof fetch };
}

const call = { model: 'gpt-test', messages: [{ role: 'user' as const, content: 'hello' }] };

describe('openAICompatAdapterFactory', () => {
  test('takes the endpoint from adapter_config.baseURL', () => {
    const provider = openAICompatAdapterFactory({
      metadata,
      config: { baseURL: 'http://localhost:11434/v1' },
    });
    expect(provider.metadata).toBe(metadata);
    expect(openAICompatBaseUrl({ metadata, config: { baseURL: BASE_URLS.OPENAI } })).toBe(
      BASE_URLS.OPENAI,
    );
  });

  test('refuses a registration without an http(s) baseURL, naming the setting', () => {
    for (const config of [
      undefined,
      {},
      { baseURL: '' },
      { baseURL: 'api.openai.com/v1' },
      { baseURL: 42 },
    ]) {
      expect(() => openAICompatAdapterFactory({ metadata, ...(config && { config }) })).toThrow(
        `${OPENAI_COMPAT_ADAPTER_ID}: provider "openai": needs adapter_config.baseURL, an http(s) URL`,
      );
    }
  });
});

describe("the runtime's fetch", () => {
  test("the factory sends through AdapterFactoryInput.fetch: the runtime decides which hosts a registration's base URL may reach", async () => {
    const endpoint = fakeEndpoint();
    const provider = openAICompatAdapterFactory({
      metadata,
      config: { baseURL: 'http://llm.test/v1' },
      fetch: endpoint.fetch,
    });
    const result = await provider.invoke(call);
    expect(result.message.content).toBe('hi');
    expect(endpoint.seen.map((s) => s.url)).toEqual(['http://llm.test/v1/chat/completions']);
  });
});

describe('invoke', () => {
  test('sends to the endpoint with the key the resolver returns on each call', async () => {
    const endpoint = fakeEndpoint();
    const keys = ['key-1', 'key-1', 'key-2'];
    let calls = 0;
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: async () => keys[calls++] ?? 'key-x',
      metadata,
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    for (let i = 0; i < 3; i++) {
      const result = await provider.invoke(call);
      expect(result.message.content).toBe('hi');
    }
    expect(calls).toBe(3);
    expect(endpoint.seen.map((s) => s.authorization)).toEqual([
      'Bearer key-1',
      'Bearer key-1',
      'Bearer key-2', // rotated: the next call uses the new key
    ]);
    expect(endpoint.seen.every((s) => s.url === 'http://llm.test/v1/chat/completions')).toBe(true);
  });

  test('a static key still works', async () => {
    const endpoint = fakeEndpoint();
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: 'unused',
      metadata,
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    await provider.invoke(call);
    expect(endpoint.seen[0]?.authorization).toBe('Bearer unused');
  });

  test('a call with a traceparent sends it as a header, never in the body; without, none', async () => {
    const endpoint = fakeEndpoint();
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: 'k',
      metadata,
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await provider.invoke({ ...call, traceparent });
    await provider.invoke(call);
    expect(endpoint.seen.map((s) => s.traceparent)).toEqual([traceparent, null]);
    expect(JSON.stringify(endpoint.seen[0]?.body)).not.toContain('traceparent');
  });

  test("the turn's abort signal reaches the request", async () => {
    const endpoint = fakeEndpoint();
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: 'k',
      metadata,
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(provider.invoke({ ...call, abortSignal: aborted.signal })).rejects.toThrow();
    expect(endpoint.seen).toEqual([]);
  });
});

const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };
const NO_THINKING_KEY = 'extraBody.chat_template_kwargs.enable_thinking';

describe('extraBody', () => {
  test('is merged into every request', async () => {
    const endpoint = fakeEndpoint();
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: 'k',
      metadata,
      extraBody: NO_THINKING,
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    await provider.invoke({ ...call, temperature: 0.2 });
    await provider.invoke(call);
    expect(endpoint.seen).toHaveLength(2);
    for (const { body } of endpoint.seen) {
      expect(body).toMatchObject({ ...NO_THINKING, model: 'gpt-test', stream: false });
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    }
    expect(endpoint.seen[0]?.body.temperature).toBe(0.2);
  });

  test('without it, the request carries only what the adapter sets', async () => {
    const endpoint = fakeEndpoint();
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: 'k',
      metadata,
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    await provider.invoke(call);
    expect(Object.keys(endpoint.seen[0]?.body ?? {}).sort()).toEqual([
      'messages',
      'model',
      'stream',
    ]);
  });

  test('refuses the fields the adapter sets', () => {
    expect(() =>
      createOpenAICompatModelProvider({
        baseURL: BASE_URLS.VLLM_LOCAL,
        apiKey: 'k',
        metadata,
        extraBody: { messages: [] },
      }),
    ).toThrow(`provider "openai": extraBody can't set messages: the adapter sets it`);
  });
});

describe('adapter_config extraBody.* keys', () => {
  const read = (config: Record<string, string | number | boolean>) =>
    openAICompatExtraBody({ metadata, config });

  test('dots nest; other keys are left alone', () => {
    expect(read({ baseURL: BASE_URLS.VLLM_LOCAL })).toBe(undefined);
    expect(
      read({
        baseURL: BASE_URLS.VLLM_LOCAL,
        [NO_THINKING_KEY]: false,
        'extraBody.chat_template_kwargs.preserve_thinking': false,
        'extraBody.top_k': 20,
        'extraBody.reasoning_effort': 'low',
      }),
    ).toEqual({
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: false },
      top_k: 20,
      reasoning_effort: 'low',
    });
  });

  test("the factory's provider sends them", async () => {
    const endpoint = fakeEndpoint();
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: 'k',
      metadata,
      extraBody: read({ [NO_THINKING_KEY]: false }) ?? {},
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    await provider.invoke(call);
    expect(endpoint.seen[0]?.body).toMatchObject(NO_THINKING);
    expect(
      openAICompatAdapterFactory({
        metadata,
        config: { baseURL: BASE_URLS.VLLM_LOCAL, [NO_THINKING_KEY]: false },
      }).metadata,
    ).toBe(metadata);
  });

  test('refuses what it cannot send, naming the key', () => {
    const refused: [Record<string, string | number | boolean>, string][] = [
      [{ extraBody: '{"top_k":20}' }, 'adapter_config takes extra request fields one per key'],
      [{ 'extraBody.': 1 }, 'adapter_config "extraBody." isn\'t a field path'],
      [{ 'extraBody.a..b': 1 }, 'adapter_config "extraBody.a..b" isn\'t a field path'],
      [{ 'extraBody.__proto__.polluted': true }, "isn't a field path"],
      [{ 'extraBody.constructor': 1 }, "isn't a field path"],
      [
        { 'extraBody.a': 1, 'extraBody.a.b': 2 },
        'adapter_config "extraBody.a.b" nests under a field another key sets',
      ],
      [
        { 'extraBody.a.b': 2, 'extraBody.a': 1 },
        'adapter_config "extraBody.a" collides with another key',
      ],
      [
        { 'extraBody.model': 'x', 'extraBody.stream': true },
        "adapter_config extraBody can't set model, stream: the adapter sets them",
      ],
    ];
    for (const [config, says] of refused) {
      expect(() => read(config)).toThrow(`${OPENAI_COMPAT_ADAPTER_ID}: provider "openai": `);
      expect(() => read(config)).toThrow(says);
      expect(() =>
        openAICompatAdapterFactory({
          metadata,
          config: { baseURL: BASE_URLS.VLLM_LOCAL, ...config },
        }),
      ).toThrow(says);
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});

describe('what the endpoint says about the call', () => {
  test("served model, request id, cached and reasoning tokens, raw usage, and the attempts its SDK's retries took", async () => {
    let requests = 0;
    const flaky = (async () => {
      requests += 1;
      if (requests === 1) {
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
        });
      }
      return new Response(
        JSON.stringify({
          ...COMPLETION,
          model: 'gpt-test-2026-01-01',
          usage: {
            prompt_tokens: 30,
            completion_tokens: 20,
            total_tokens: 50,
            prompt_tokens_details: { cached_tokens: 10 },
            completion_tokens_details: { reasoning_tokens: 8 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_7' } },
      );
    }) as typeof fetch;
    const provider = openAICompatAdapterFactory({
      metadata,
      config: { baseURL: 'http://llm.test/v1' },
      fetch: flaky,
    });
    const result = await provider.invoke(call);
    expect(requests).toBe(2);
    expect(result).toMatchObject({
      servedModel: 'gpt-test-2026-01-01',
      providerRequestId: 'req_7',
      attempts: 2,
      usage: { promptTokens: 30, completionTokens: 20, cacheReadTokens: 10, reasoningTokens: 8 },
      rawUsage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 8 },
      },
    });
  });

  test('a part the endpoint reports as 0 is kept as 0; one it leaves out is absent', async () => {
    const answering = (usage: Record<string, unknown>) =>
      (async () =>
        new Response(JSON.stringify({ ...COMPLETION, usage }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
    const reported = await openAICompatAdapterFactory({
      metadata,
      config: { baseURL: 'http://llm.test/v1' },
      fetch: answering({
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      }),
    }).invoke(call);
    expect(reported.usage).toEqual({
      promptTokens: 30,
      completionTokens: 20,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    });
    const unreported = await openAICompatAdapterFactory({
      metadata,
      config: { baseURL: 'http://llm.test/v1' },
      fetch: answering({ prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }),
    }).invoke(call);
    expect(unreported.usage).toEqual({ promptTokens: 30, completionTokens: 20 });
  });

  test('a body that stalls past the timeout is retried by the SDK, and both attempts are counted', async () => {
    // The real SDK over real HTTP: the first answer sends its headers and
    // part of its body, then stalls; the SDK times the body out and
    // retries from inside its lazy promise.
    let requests = 0;
    const server: Server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `req_${requests}` });
      if (requests === 1) {
        res.write('{"id":');
        return;
      }
      res.end(JSON.stringify(COMPLETION));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const provider = createOpenAICompatModelProvider({
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-test',
        metadata,
        clientOptions: { timeout: 300, maxRetries: 2 },
      });
      const result = await provider.invoke(call);
      expect(requests).toBe(2);
      expect(result.attempts).toBe(2);
      expect(result.providerRequestId).toBe('req_2');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("a model that doesn't take sampling", () => {
  // OpenAI's GPT-6 models: remove temperature at any reasoning effort but `none`.
  const noSampling: ProviderMetadata = {
    ...metadata,
    models: [
      ...metadata.models,
      { ...metadata.models[0], name: 'gpt-reasoning', sampling: false } as never,
    ],
  };

  test('the call goes without the temperature, and the answer says so; others still get it', async () => {
    const endpoint = fakeEndpoint();
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: 'k',
      metadata: noSampling,
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    const without = await provider.invoke({ ...call, model: 'gpt-reasoning', temperature: 0.2 });
    const withIt = await provider.invoke({ ...call, temperature: 0.2 });
    expect(endpoint.seen[0]?.body).not.toHaveProperty('temperature');
    expect(without.warnings).toEqual([
      {
        code: 'sampling-unsupported',
        message:
          "gpt-reasoning doesn't take a temperature, so the call went without one (it asked for 0.2).",
      },
    ]);
    expect(endpoint.seen[1]?.body.temperature).toBe(0.2);
    expect(withIt).not.toHaveProperty('warnings');
  });
});

describe("thinking: 'lowest'", () => {
  test("sends the model's lowest reasoning effort; nothing without the hint or the data", async () => {
    const endpoint = fakeEndpoint();
    const provider = createOpenAICompatModelProvider({
      baseURL: 'http://llm.test/v1',
      apiKey: 'k',
      metadata: {
        ...metadata,
        models: [
          ...metadata.models,
          {
            ...metadata.models[0],
            name: 'gpt-reasoning',
            thinking: { mode: 'adaptive', lowest: 'low' },
          } as never,
        ],
      },
      clientOptions: { fetch: endpoint.fetch, maxRetries: 0 },
    });
    await provider.invoke({ ...call, model: 'gpt-reasoning', thinking: 'lowest' });
    await provider.invoke({ ...call, model: 'gpt-reasoning' });
    await provider.invoke({ ...call, thinking: 'lowest' });
    expect(endpoint.seen[0]?.body.reasoning_effort).toBe('low');
    expect(endpoint.seen[1]?.body).not.toHaveProperty('reasoning_effort');
    expect(endpoint.seen[2]?.body).not.toHaveProperty('reasoning_effort');
  });
});

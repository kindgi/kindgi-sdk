// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Azure OpenAI adapter, without Azure: each registration problem `checkConfig` reports, and
 * what the factory's provider sends (captured at the fetch the runtime hands it): the endpoint,
 * the deployment, `store: false`, and how it signs in.
 */

import { ModelProviderError } from '@kindgi/adapter-model-shared';
import type { AdapterFactoryInput, ProviderMetadata } from '@kindgi/capabilities';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  AZURE_OPENAI_SCOPE,
  IDENTITY_TIMEOUT_MS,
  azureOpenAIAdapterFactory,
  azureOpenAICheckConfig,
} from '../src/index.js';

const METADATA = {
  id: 'azure-acme',
  region: 'canadacentral',
  models: [
    {
      name: 'gpt-6.1-sol',
      contextWindow: 1_050_000,
      features: ['tool-use', 'structured-output'],
      sampling: false,
      cost: {
        promptUsdPer1kTokens: 0.002,
        completionUsdPer1kTokens: 0.01,
        cachedPromptMultiplier: 0.05,
      },
    },
    {
      name: 'gpt-6-luna',
      contextWindow: 400_000,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.0004, completionUsdPer1kTokens: 0.0016 },
    },
  ],
} as unknown as ProviderMetadata;
const DEPLOYMENTS = 'gpt-6.1-sol=gpt-6-1-sol, gpt-6-luna=luna-prod';
const GOOD = { resourceName: 'acme-res', deployments: DEPLOYMENTS };

const check = (config: Record<string, string>, hasSecretRef = true) =>
  azureOpenAICheckConfig({ metadata: METADATA, config, hasSecretRef });

describe('checkConfig', () => {
  test('a resource, deployments for every model, and a key: nothing wrong', () => {
    expect(check(GOOD)).toEqual([]);
    expect(check({ ...GOOD, auth: 'entra' }, false)).toEqual([]);
    expect(
      check({
        baseURL: 'https://gw.acme.example/openai/v1',
        deployments: DEPLOYMENTS,
        api: 'chat-completions',
      }),
    ).toEqual([]);
  });

  test.each([
    [
      { deployments: DEPLOYMENTS },
      '/adapter_config/resourceName',
      'needs adapter_config.resourceName',
    ],
    [{ ...GOOD, baseURL: 'https://x.example' }, '/adapter_config/baseURL', 'exclude each other'],
    [
      { ...GOOD, resourceName: 'acme.res' },
      '/adapter_config/resourceName',
      'must be the Azure OpenAI resource name',
    ],
    [
      { baseURL: 'http://plain.example', deployments: DEPLOYMENTS },
      '/adapter_config/baseURL',
      'https URL',
    ],
    [
      { ...GOOD, api: 'completions' },
      '/adapter_config/api',
      'must be one of responses, chat-completions',
    ],
    [{ ...GOOD, auth: 'oauth' }, '/adapter_config/auth', 'must be one of api-key, entra'],
    [{ ...GOOD, deployment: 'x' }, '/adapter_config/deployment', "isn't an Azure OpenAI setting"],
    [
      { resourceName: 'acme-res' },
      '/adapter_config/deployments',
      'needs adapter_config.deployments',
    ],
    [
      { ...GOOD, deployments: 'gpt-6.1-sol' },
      '/adapter_config/deployments',
      'each entry is model=deployment',
    ],
    [
      { ...GOOD, deployments: `${DEPLOYMENTS},gpt-9=x` },
      '/adapter_config/deployments',
      "names gpt-9, which this registration doesn't list",
    ],
    [
      { ...GOOD, deployments: 'gpt-6.1-sol=sol prod,gpt-6-luna=luna' },
      '/adapter_config/deployments',
      "a deployment name can't hold spaces",
    ],
    [
      { ...GOOD, deployments: 'gpt-6.1-sol=gpt-6-1-sol' },
      '/adapter_config/deployments',
      'no deployment for gpt-6-luna',
    ],
    [
      { ...GOOD, deployments: 'gpt-6.1-sol=,gpt-6-luna=luna' },
      '/adapter_config/deployments',
      'each entry is model=deployment',
    ],
    [
      { ...GOOD, deployments: 'gpt-6.1-sol=a,gpt-6.1-sol=b,gpt-6-luna=c' },
      '/adapter_config/deployments',
      'names gpt-6.1-sol twice',
    ],
    // The portal's endpoint, without the v1 path, would 404.
    [
      { baseURL: 'https://acme-res.openai.azure.com/', deployments: DEPLOYMENTS },
      '/adapter_config/baseURL',
      'must end in /openai/v1',
    ],
    [
      { baseURL: 'https://user:pw@gw.acme.example/v1', deployments: DEPLOYMENTS },
      '/adapter_config/baseURL',
      "can't hold credentials",
    ],
    [
      { baseURL: 'https://gw.acme.example/v1?api-key=k', deployments: DEPLOYMENTS },
      '/adapter_config/baseURL',
      "can't hold a query or a fragment",
    ],
    [
      { baseURL: 'https://gw.acme.example/v1#here', deployments: DEPLOYMENTS },
      '/adapter_config/baseURL',
      "can't hold a query or a fragment",
    ],
  ] as const)('%j → %s', (config, path, words) => {
    const problems = check(config as Record<string, string>);
    expect(problems.map((p) => p.path)).toContain(path);
    expect(problems.find((p) => p.path === path)?.message).toContain(words);
  });

  test('Entra on a runtime that has no Azure identity: refused when it registers, naming the setting', () => {
    const entra = { ...GOOD, auth: 'entra' };
    const on = (azure: boolean) =>
      azureOpenAICheckConfig({
        metadata: METADATA,
        config: entra,
        hasSecretRef: false,
        identities: { azure, aws: false },
      });
    expect(on(true)).toEqual([]);
    expect(on(false)).toEqual([
      { path: '/adapter_config/auth', message: expect.stringContaining('KINDGI_AZURE_CLIENT_ID') },
    ]);
    // A key needs no identity.
    expect(
      azureOpenAICheckConfig({
        metadata: METADATA,
        config: GOOD,
        hasSecretRef: true,
        identities: { azure: false, aws: false },
      }),
    ).toEqual([]);
  });

  test("Entra: the runtime's token goes only to an Azure OpenAI host; any other is refused, named", () => {
    const entra = (baseURL: string) =>
      check({ baseURL, deployments: DEPLOYMENTS, auth: 'entra' }, false);
    for (const host of [
      'collector.example',
      // A look-alike: the Azure name as a subdomain of another host.
      'acme.openai.azure.com.collector.example',
      'openai.azure.com',
    ]) {
      expect(entra(`https://${host}/openai/v1`)).toEqual([
        {
          path: '/adapter_config/baseURL',
          message: expect.stringContaining(
            `goes only to an Azure OpenAI host (*.openai.azure.com, *.cognitiveservices.azure.com, *.services.ai.azure.com, *.openai.azure.us, *.cognitiveservices.azure.us); ${host} isn't one. A custom endpoint takes auth = api-key.`,
          ),
        },
      ]);
    }
    for (const ok of [
      'https://acme.openai.azure.com/openai/v1',
      'https://acme.cognitiveservices.azure.com/openai/v1/',
      'https://acme.services.ai.azure.com/openai/v1',
      'https://acme.openai.azure.us/openai/v1',
      'https://acme.cognitiveservices.azure.us/openai/v1',
    ]) {
      expect(entra(ok)).toEqual([]);
    }
    // A gateway is a key's: any host and path.
    expect(check({ baseURL: 'https://gw.acme.example/llm', deployments: DEPLOYMENTS })).toEqual([]);
  });

  test('a deployment named like its model, dots included, as Azure makes them: taken', () => {
    expect(
      check({ ...GOOD, deployments: 'gpt-6.1-sol=gpt-6.1-sol, gpt-6-luna=gpt-6-luna' }),
    ).toEqual([]);
  });

  test('a key needs secret_ref; Entra must not have one', () => {
    expect(check(GOOD, false)).toEqual([
      {
        path: '/secret_ref',
        message: expect.stringContaining("needs secret_ref: the resource's API key"),
      },
    ]);
    expect(check({ ...GOOD, auth: 'entra' }, true)).toEqual([
      { path: '/secret_ref', message: expect.stringContaining('remove secret_ref') },
    ]);
  });
});

/** What a request carried, as the runtime's fetch saw it. */
interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

const RESPONSES_BODY = {
  id: 'resp_1',
  object: 'response',
  created_at: 1_791_500_000,
  status: 'completed',
  model: 'gpt-6.1-sol',
  output: [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Shipped.', annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 40,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 45,
  },
};
const CHAT_BODY = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 1_791_500_000,
  model: 'gpt-6-luna',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Shipped.' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
};

function capturingFetch(sent: Sent[], status = 200, body: unknown = RESPONSES_BODY): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-az-1',
        'retry-after-ms': '0',
      },
    });
  }) as typeof fetch;
}

const ask = (model = 'gpt-6.1-sol') => ({
  model,
  messages: [{ role: 'user' as const, content: 'Where is A-1?' }],
});

function build(config: Record<string, string>, extra: Partial<AdapterFactoryInput>) {
  return azureOpenAIAdapterFactory({ metadata: METADATA, config, ...extra });
}

// Bait: the provider must never read these.
beforeEach(() => {
  vi.stubEnv('AZURE_API_KEY', 'env-key-must-not-be-sent');
  vi.stubEnv('AZURE_RESOURCE_NAME', 'env-resource-must-not-be-used');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('what the provider sends', () => {
  test('a key: the v1 Responses endpoint, the deployment, store false, the key as api-key, read for every call', async () => {
    const sent: Sent[] = [];
    const keys = ['key-one', 'key-two'];
    const provider = build(GOOD, {
      fetch: capturingFetch(sent),
      resolveApiKey: async () => keys.shift() as string,
    });
    const r = await provider.invoke(ask());
    await provider.invoke(ask());
    expect(sent[0]?.url).toBe(
      'https://acme-res.openai.azure.com/openai/v1/responses?api-version=v1',
    );
    expect(sent[0]?.body).toMatchObject({ model: 'gpt-6-1-sol', store: false });
    expect(sent[0]?.headers.get('api-key')).toBe('key-one');
    expect(sent[1]?.headers.get('api-key')).toBe('key-two');
    expect(sent[0]?.headers.get('authorization')).toBeNull();
    expect(r).toMatchObject({
      message: { role: 'assistant', content: 'Shipped.' },
      provider: { id: 'azure-acme', model: 'gpt-6.1-sol' },
      providerRequestId: 'req-az-1',
      attempts: 1,
    });
    expect(r.costUsd).toBeCloseTo((40 * 0.002 + 5 * 0.01) / 1000, 12);
  });

  test("Entra: a bearer from the runtime's identity for every request, for the Azure OpenAI scope; no api-key", async () => {
    const sent: Sent[] = [];
    const getToken = vi.fn(async () => ({ token: `token-${getToken.mock.calls.length}` }));
    const provider = build(
      { ...GOOD, auth: 'entra' },
      {
        fetch: capturingFetch(sent),
        identities: { azure: { getToken } },
      },
    );
    await provider.invoke(ask());
    await provider.invoke(ask());
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledWith(AZURE_OPENAI_SCOPE);
    expect(sent.map((s) => s.headers.get('authorization'))).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
    expect(sent.map((s) => s.headers.get('api-key'))).toEqual([null, null]);
  });

  test('Chat Completions, on a custom endpoint, with the deployment as the model', async () => {
    const sent: Sent[] = [];
    const provider = build(
      {
        baseURL: 'https://gw.acme.example/openai/v1',
        deployments: DEPLOYMENTS,
        api: 'chat-completions',
      },
      { fetch: capturingFetch(sent, 200, CHAT_BODY), resolveApiKey: async () => 'k' },
    );
    const r = await provider.invoke(ask('gpt-6-luna'));
    expect(sent[0]?.url).toBe('https://gw.acme.example/openai/v1/chat/completions');
    expect(sent[0]?.body).toMatchObject({ model: 'luna-prod' });
    expect(sent[0]?.body.store).toBeUndefined();
    expect(r.message.content).toBe('Shipped.');
  });

  test('a 401 is a typed auth error, one attempt', async () => {
    const provider = build(GOOD, {
      fetch: capturingFetch([], 401, {
        error: { code: '401', message: 'Access denied due to invalid subscription key.' },
      }),
      resolveApiKey: async () => 'wrong',
    });
    const err = await provider.invoke(ask()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toMatchObject({ kind: 'auth', status: 401 });
    expect((err as Error).message).toContain('invalid subscription key');
  });
});

/** A fetch that answers each request in turn from `answers` (the last one repeats). */
function answering(
  sent: Sent[],
  answers: readonly { status: number; body: unknown; headers?: Record<string, string> }[],
): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const a = answers[Math.min(i, answers.length - 1)] as (typeof answers)[number];
    i += 1;
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json', ...a.headers },
    });
  }) as typeof fetch;
}

describe('whether a model reasons is the registration’s, never the deployment name’s', () => {
  // gpt-6.1-sol reasons (sampling false) on a deployment whose name says nothing; gpt-6-luna
  // doesn't, on a deployment whose name the library would take for a reasoning model's.
  const NAMES = { ...GOOD, deployments: 'gpt-6.1-sol=sol-prod, gpt-6-luna=gpt-6-luna-x' };
  const sentFor = async (api: string, model: string, body: unknown) => {
    const sent: Sent[] = [];
    const provider = build(
      { ...NAMES, api },
      { fetch: capturingFetch(sent, 200, body), resolveApiKey: async () => 'k' },
    );
    await provider.invoke({ ...ask(model), maxOutputTokens: 500 });
    return sent[0]?.body as Record<string, unknown>;
  };

  test('Responses: a reasoning model keeps its reasoning between turns; another sends none', async () => {
    const sol = await sentFor('responses', 'gpt-6.1-sol', RESPONSES_BODY);
    expect(sol.include).toEqual(['reasoning.encrypted_content']);
    const luna = await sentFor('responses', 'gpt-6-luna', RESPONSES_BODY);
    expect(luna.include).toBeUndefined();
  });

  test('Chat Completions: a reasoning model gets max_completion_tokens; another max_tokens', async () => {
    const sol = await sentFor('chat-completions', 'gpt-6.1-sol', CHAT_BODY);
    expect(sol).toMatchObject({ model: 'sol-prod', max_completion_tokens: 500 });
    expect(sol.max_tokens).toBeUndefined();
    const luna = await sentFor('chat-completions', 'gpt-6-luna', CHAT_BODY);
    expect(luna).toMatchObject({ model: 'gpt-6-luna-x', max_tokens: 500 });
    expect(luna.max_completion_tokens).toBeUndefined();
  });
});

describe('Entra by cloud', () => {
  test('Azure Government: the token is for its scope, and the request goes to its host', async () => {
    const sent: Sent[] = [];
    const getToken = vi.fn(async () => ({ token: 'gov-token' }));
    const provider = build(
      {
        baseURL: 'https://acme.openai.azure.us/openai/v1',
        deployments: DEPLOYMENTS,
        auth: 'entra',
      },
      { fetch: capturingFetch(sent), identities: { azure: { getToken } } },
    );
    await provider.invoke(ask());
    expect(getToken).toHaveBeenCalledWith('https://cognitiveservices.azure.us/.default');
    // A v1 base URL needs no api-version (the library adds one only to an unversioned path).
    expect(sent[0]?.url).toBe('https://acme.openai.azure.us/openai/v1/responses');
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer gov-token');
  });

  test('the factory refuses a host that isn’t Azure’s too, before any token is asked for', () => {
    const getToken = vi.fn(async () => ({ token: 't' }));
    expect(() =>
      build(
        { baseURL: 'https://collector.example/openai/v1', deployments: DEPLOYMENTS, auth: 'entra' },
        { fetch: capturingFetch([]), identities: { azure: { getToken } } },
      ),
    ).toThrow("collector.example isn't one");
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe('a failed sign-in is auth, once, never retried', () => {
  const entraWith = (getToken: () => Promise<{ token: string } | null>, sent: Sent[]) =>
    build(
      { ...GOOD, auth: 'entra' },
      { fetch: capturingFetch(sent), identities: { azure: { getToken } } },
    );

  test('the identity throws: auth, with the hint, no request sent', async () => {
    const sent: Sent[] = [];
    const getToken = vi.fn(async () => {
      throw new Error('no managed identity endpoint');
    });
    const err = await entraWith(getToken, sent)
      .invoke(ask())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toMatchObject({ kind: 'auth' });
    expect((err as Error).message).toContain('no managed identity endpoint');
    expect((err as Error).message).toContain('KINDGI_AZURE_CLIENT_ID');
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  test('the identity returns nothing: auth', async () => {
    const err = await entraWith(async () => null, [])
      .invoke(ask())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'auth' });
    expect((err as Error).message).toContain('returned no token');
  });

  test('the identity hangs: auth after the bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const getToken = vi.fn(() => new Promise<never>(() => {}));
      const pending = entraWith(getToken, [])
        .invoke(ask())
        .catch((e: unknown) => e);
      // The token is asked for a few awaits in; only then does the bound start.
      while (getToken.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(IDENTITY_TIMEOUT_MS);
      const err = await pending;
      expect(err).toMatchObject({ kind: 'auth' });
      expect((err as Error).message).toContain('no answer in 10 s');
    } finally {
      vi.useRealTimers();
    }
  });

  test('the key can’t be read, or is empty: auth, no request sent', async () => {
    for (const resolveApiKey of [
      async () => {
        throw new Error('secret store unreachable');
      },
      async () => '',
    ]) {
      const sent: Sent[] = [];
      const read = vi.fn(resolveApiKey);
      const err = await build(GOOD, { fetch: capturingFetch(sent), resolveApiKey: read })
        .invoke(ask())
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'auth' });
      expect(read).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([]);
    }
  });
});

describe('more of what it sends', () => {
  test('with no AZURE_API_KEY in the environment at all, a key still works (never read from there)', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('AZURE_API_KEY', undefined);
    const sent: Sent[] = [];
    await build(GOOD, { fetch: capturingFetch(sent), resolveApiKey: async () => 'k' }).invoke(
      ask(),
    );
    expect(sent[0]?.headers.get('api-key')).toBe('k');
  });

  test('a tool call, then its result on the next call', async () => {
    const sent: Sent[] = [];
    const call = {
      ...RESPONSES_BODY,
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'acme__lookup_order',
          arguments: '{"orderId":"A-1"}',
          status: 'completed',
        },
      ],
    };
    const provider = build(GOOD, {
      fetch: answering(sent, [
        { status: 200, body: call },
        { status: 200, body: RESPONSES_BODY },
      ]),
      resolveApiKey: async () => 'k',
    });
    const tools = [
      {
        name: 'acme.lookup_order',
        description: 'Look up an order.',
        inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
      },
    ];
    const first = await provider.invoke({ ...ask(), tools });
    expect(first.finishReason).toBe('tool-use');
    expect(first.message.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call_1',
        name: 'acme.lookup_order',
        arguments: { orderId: 'A-1' },
      }),
    ]);
    const second = await provider.invoke({
      ...ask(),
      tools,
      messages: [
        ...ask().messages,
        first.message,
        { role: 'tool', toolCallId: 'call_1', content: '{"status":"shipped"}' },
      ],
    });
    expect(second.message.content).toBe('Shipped.');
    expect(sent[1]?.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
      ]),
    );
  });

  test('a 429 with retry-after-ms, then the answer: two attempts', async () => {
    const sent: Sent[] = [];
    const r = await build(GOOD, {
      fetch: answering(sent, [
        {
          status: 429,
          body: { error: { message: 'slow down' } },
          headers: { 'retry-after-ms': '0' },
        },
        { status: 200, body: RESPONSES_BODY },
      ]),
      resolveApiKey: async () => 'k',
    }).invoke(ask());
    expect(r.attempts).toBe(2);
    expect(sent).toHaveLength(2);
  });

  test("a 400 from Azure's content filter is content-filter, one attempt", async () => {
    const err = await build(GOOD, {
      fetch: capturingFetch([], 400, {
        error: {
          code: 'content_filter',
          message:
            'The response was filtered due to the prompt triggering Azure OpenAI content management policy.',
        },
      }),
      resolveApiKey: async () => 'k',
    })
      .invoke(ask())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'content-filter', status: 400 });
  });
});

describe('the factory refuses', () => {
  test("Entra without the runtime's Azure identity: the check's own words", () => {
    expect(() => build({ ...GOOD, auth: 'entra' }, {})).toThrow(
      '@kindgi/adapter-model-azure-openai: provider "azure-acme": adapter_config.auth = entra needs the runtime\'s Azure identity',
    );
  });

  test('a registration checkConfig refuses, with its first problem', () => {
    expect(() => build({ resourceName: 'acme-res' }, { resolveApiKey: async () => 'k' })).toThrow(
      '@kindgi/adapter-model-azure-openai: provider "azure-acme": needs adapter_config.deployments',
    );
  });
});

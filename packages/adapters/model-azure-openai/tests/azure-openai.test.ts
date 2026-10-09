// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Azure OpenAI adapter, without Azure: each registration problem `checkConfig` reports, and
 * what the factory's provider sends (captured at the fetch the runtime hands it): the endpoint,
 * the deployment, `store: false`, and how it signs in. The live run is the T354 evaluation's
 * (every case passed on Azure under Entra) and the adapter's own, in LIVE-TESTS.
 */

import { ModelProviderError } from '@kindgi/adapter-model-shared';
import type { AdapterFactoryInput, ProviderMetadata } from '@kindgi/capabilities';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  AZURE_OPENAI_SCOPE,
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

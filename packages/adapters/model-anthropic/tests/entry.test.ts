// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The entry a runtime registers: the factory needs a `secret_ref`, and the
 * static check run when a provider registers says the same thing. Its one
 * `adapter_config` key, `baseURL`, sends the calls to a gateway or a proxy.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import { type ProviderMetadata, adapterConfigKeyProblems } from '@kindgi/capabilities';

import { ANTHROPIC_ADAPTER_ID, anthropicAdapterEntry, anthropicCheckConfig } from '../src/index.js';

const metadata: ProviderMetadata = {
  id: 'acme-claude',
  region: 'unspecified',
  models: [
    {
      name: 'claude-sonnet-5-5',
      contextWindow: 1000000,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.002, completionUsdPer1kTokens: 0.01 },
    },
  ],
};

const GATEWAY = 'https://gateway.example.com/api/v1/gateway/anthropic';
const NOT_HTTPS =
  'adapter_config.baseURL must be an https URL of a gateway or a proxy that serves the Anthropic API, or an http one on this machine (localhost, 127.0.0.1, [::1], host.docker.internal, host.containers.internal).';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Where the provider's call goes, and the key it sends: fetch answers a 400, which isn't retried. */
async function firstRequest(
  config?: Record<string, string>,
): Promise<{ url: string; key: string | null }> {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'stub' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const provider = anthropicAdapterEntry.factory({
    metadata,
    ...(config !== undefined ? { config } : {}),
    resolveApiKey: async () => 'sk-provider-key',
  });
  await expect(
    provider.invoke({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }),
  ).rejects.toThrow();
  const [url, init] = fetch.mock.calls[0] as unknown as [string | URL | Request, RequestInit?];
  return {
    url: url instanceof Request ? url.url : String(url),
    key: new Headers(url instanceof Request ? url.headers : init?.headers).get('x-api-key'),
  };
}

describe('anthropicAdapterEntry', () => {
  test('with a secret_ref: no problems, and the factory builds the provider', () => {
    expect(anthropicCheckConfig({ metadata, hasSecretRef: true })).toEqual([]);
    const provider = anthropicAdapterEntry.factory({
      metadata,
      resolveApiKey: async () => 'unused',
    });
    expect(provider.metadata.id).toBe('acme-claude');
  });

  test('without one: the check names secret_ref, and the factory throws the same message', () => {
    const problems = anthropicCheckConfig({ metadata, hasSecretRef: false });
    expect(problems).toEqual([
      {
        path: '/secret_ref',
        message: 'needs secret_ref: its Anthropic API key.',
      },
    ]);
    expect(() => anthropicAdapterEntry.factory({ metadata })).toThrow(
      `${ANTHROPIC_ADAPTER_ID}: provider "acme-claude": needs secret_ref: its Anthropic API key.`,
    );
  });

  test("it takes baseURL: any other adapter_config key is the registration's to refuse", () => {
    expect(adapterConfigKeyProblems(anthropicAdapterEntry, { baseURL: GATEWAY })).toEqual([]);
    expect(adapterConfigKeyProblems(anthropicAdapterEntry, { baseUrl: GATEWAY })).toEqual([
      {
        path: '/adapter_config/baseUrl',
        message: "adapter_config.baseUrl isn't a setting of this adapter: it takes baseURL.",
      },
    ]);
    expect(adapterConfigKeyProblems(anthropicAdapterEntry, {})).toEqual([]);
  });

  test("without baseURL: its calls go to Anthropic's API, with the provider's key", async () => {
    expect(await firstRequest()).toEqual({
      url: 'https://api.anthropic.com/v1/messages',
      key: 'sk-provider-key',
    });
  });

  test("with baseURL: its calls go there, under the gateway's own path, with the same key", async () => {
    expect(
      anthropicCheckConfig({ metadata, hasSecretRef: true, config: { baseURL: GATEWAY } }),
    ).toEqual([]);
    expect(await firstRequest({ baseURL: GATEWAY })).toEqual({
      url: `${GATEWAY}/v1/messages`,
      key: 'sk-provider-key',
    });
    expect((await firstRequest({ baseURL: `${GATEWAY}/` })).url).toBe(`${GATEWAY}/v1/messages`);
  });

  test.each([
    'http://localhost:8787/api/v1/gateway/anthropic',
    'http://127.0.0.1:8787/api/v1/gateway/anthropic',
    'http://[::1]:8787/api/v1/gateway/anthropic',
    'http://host.docker.internal:8787/api/v1/gateway/anthropic',
    'http://host.containers.internal:8787/api/v1/gateway/anthropic',
  ])('an http baseURL on this machine, %s, is taken: a gateway run locally', async (baseURL) => {
    expect(anthropicCheckConfig({ metadata, hasSecretRef: true, config: { baseURL } })).toEqual([]);
    expect(await firstRequest({ baseURL })).toEqual({
      url: `${baseURL}/v1/messages`,
      key: 'sk-provider-key',
    });
  });

  test.each([
    ['http://gateway.example.com/anthropic', NOT_HTTPS],
    ['http://192.168.1.20:8787/anthropic', NOT_HTTPS],
    ['gateway.example.com', NOT_HTTPS],
    [
      'https://user:pass@gateway.example.com',
      "adapter_config.baseURL can't hold credentials: the key goes in secret_ref, never in the URL.",
    ],
    [
      'https://gateway.example.com/anthropic?key=x',
      "adapter_config.baseURL can't hold a query or a fragment.",
    ],
    [
      'https://gateway.example.com/anthropic#x',
      "adapter_config.baseURL can't hold a query or a fragment.",
    ],
  ])(
    'a baseURL of %s is refused: by the check, and by the factory with the same message',
    (baseURL, message) => {
      const config = { baseURL };
      expect(anthropicCheckConfig({ metadata, hasSecretRef: true, config })).toEqual([
        { path: '/adapter_config/baseURL', message },
      ]);
      expect(() =>
        anthropicAdapterEntry.factory({ metadata, config, resolveApiKey: async () => 'unused' }),
      ).toThrow(`${ANTHROPIC_ADAPTER_ID}: provider "acme-claude": ${message}`);
    },
  );

  test('a baseURL that is not a string is refused', () => {
    expect(
      anthropicCheckConfig({ metadata, hasSecretRef: true, config: { baseURL: 443 } }),
    ).toEqual([
      {
        path: '/adapter_config/baseURL',
        message: NOT_HTTPS,
      },
    ]);
  });

  test('without a secret_ref and with a bad baseURL: the check reports both', () => {
    expect(
      anthropicCheckConfig({ metadata, hasSecretRef: false, config: { baseURL: 'http://x' } }).map(
        (problem) => problem.path,
      ),
    ).toEqual(['/secret_ref', '/adapter_config/baseURL']);
  });

  test('the entry carries the check', () => {
    expect(anthropicAdapterEntry).toMatchObject({
      adapterId: ANTHROPIC_ADAPTER_ID,
      capabilityKind: 'llm-inference',
      checkConfig: anthropicCheckConfig,
      configKeys: ['baseURL'],
    });
  });
});

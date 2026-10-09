// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Amazon Bedrock adapter, without AWS: each registration problem `checkConfig` reports, and
 * what the factory's provider sends (captured at the fetch the runtime hands it): the endpoint,
 * the model, and how it signs in. The live run is the adapter's own, in LIVE-TESTS, once the
 * account's Bedrock quotas allow it.
 */

import { ModelProviderError } from '@kindgi/adapter-model-shared';
import type { AdapterFactoryInput, ProviderMetadata } from '@kindgi/capabilities';
import { attemptsOf } from '@kindgi/capabilities/attempts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { bedrockAdapterFactory, bedrockCheckConfig, bedrockRuntimeEndpoint } from '../src/index.js';

const NOVA = 'us.amazon.nova-pro-v1:0';
const metadata = (region = 'us-east-2') =>
  ({
    id: 'bedrock-acme',
    region,
    models: [
      {
        name: NOVA,
        contextWindow: 300_000,
        features: ['tool-use', 'structured-output'],
        cost: { promptUsdPer1kTokens: 0.0008, completionUsdPer1kTokens: 0.0032 },
      },
    ],
  }) as unknown as ProviderMetadata;

const check = (config: Record<string, string>, hasSecretRef = false, region = 'us-east-2') =>
  bedrockCheckConfig({ metadata: metadata(region), config, hasSecretRef });

describe('checkConfig', () => {
  test("a region and the runtime's identity, or a key: nothing wrong", () => {
    expect(check({})).toEqual([]);
    expect(check({ auth: 'aws-identity' })).toEqual([]);
    expect(check({ auth: 'api-key' }, true)).toEqual([]);
    expect(
      check({ baseURL: 'https://vpce-1.bedrock-runtime.us-east-2.vpce.amazonaws.com' }),
    ).toEqual([]);
    expect(check({}, false, 'us-gov-west-1')).toEqual([]);
    expect(check({}, false, 'eusc-de-east-1')).toEqual([]);
  });

  test.each([
    [{}, false, 'global', '/metadata/region', 'must be the AWS region Bedrock runs in'],
    [{}, false, 'unspecified', '/metadata/region', 'Got "unspecified"'],
    [{}, false, 'US-EAST-2', '/metadata/region', 'e.g. us-east-2'],
    [
      { region: 'us-east-2' },
      false,
      'us-east-2',
      '/adapter_config/region',
      'the region is metadata.region',
    ],
    [
      { baseURL: 'http://bedrock.example' },
      false,
      'us-east-2',
      '/adapter_config/baseURL',
      'https URL',
    ],
    [
      { auth: 'sigv4' },
      false,
      'us-east-2',
      '/adapter_config/auth',
      'must be one of aws-identity, api-key',
    ],
    [
      { auth: 'api-key' },
      false,
      'us-east-2',
      '/secret_ref',
      'needs secret_ref: the Bedrock API key',
    ],
    [{}, true, 'us-east-2', '/secret_ref', 'remove secret_ref, or set auth = api-key'],
  ] as const)('%j (secret %s, region %s) → %s', (config, secret, region, path, words) => {
    const problems = check(config as Record<string, string>, secret, region);
    expect(problems.map((p) => p.path)).toContain(path);
    expect(problems.find((p) => p.path === path)?.message).toContain(words);
  });

  test("the runtime's identity on a runtime that has none: refused when it registers, naming the setting", () => {
    const on = (aws: boolean, config: Record<string, string> = {}, secret = false) =>
      bedrockCheckConfig({
        metadata: metadata(),
        config,
        hasSecretRef: secret,
        identities: { azure: false, aws },
      });
    expect(on(true)).toEqual([]);
    expect(on(false)).toEqual([
      { path: '/adapter_config/auth', message: expect.stringContaining('KINDGI_AWS_IDENTITY') },
    ]);
    // A Bedrock API key needs no identity.
    expect(on(false, { auth: 'api-key' }, true)).toEqual([]);
  });

  test("each partition's own endpoint", () => {
    expect(bedrockRuntimeEndpoint('us-east-2')).toBe(
      'https://bedrock-runtime.us-east-2.amazonaws.com',
    );
    expect(bedrockRuntimeEndpoint('cn-north-1')).toBe(
      'https://bedrock-runtime.cn-north-1.amazonaws.com.cn',
    );
    expect(bedrockRuntimeEndpoint('eusc-de-east-1')).toBe(
      'https://bedrock-runtime.eusc-de-east-1.amazonaws.eu',
    );
  });
});

/** What a request carried, as the runtime's fetch saw it. */
interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

const CONVERSE_BODY = {
  output: { message: { role: 'assistant', content: [{ text: 'Shipped.' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 },
  metrics: { latencyMs: 120 },
};

function capturingFetch(sent: Sent[], status = 200, body: unknown = CONVERSE_BODY): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'req-br-1' },
    });
  }) as typeof fetch;
}

const ask = () => ({
  model: NOVA,
  messages: [{ role: 'user' as const, content: 'Where is A-1?' }],
});

const build = (
  config: Record<string, string>,
  extra: Partial<AdapterFactoryInput>,
  region = 'us-east-2',
) => bedrockAdapterFactory({ metadata: metadata(region), config, ...extra });

/** A refreshing credential provider, as the runtime's AWS identity is: new session each call. */
function identity() {
  let n = 0;
  return vi.fn(async () => {
    n += 1;
    return {
      accessKeyId: `ASIATESTKEY${n}`,
      secretAccessKey: 'test-secret',
      sessionToken: `session-${n}`,
    };
  });
}

// Bait: the provider must never read any of these.
beforeEach(() => {
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'env-bearer-must-not-be-sent');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAENVMUSTNOTBEUSED');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret-must-not-be-used');
  vi.stubEnv('AWS_SESSION_TOKEN', 'env-session-must-not-be-used');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  vi.stubEnv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'https://env-endpoint.example');
  vi.stubEnv('AWS_ENDPOINT_URL', 'https://env-endpoint-generic.example');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('what the provider sends', () => {
  test("the runtime's identity: Converse at the region's endpoint, SigV4 with credentials asked for every request", async () => {
    const sent: Sent[] = [];
    const aws = identity();
    const provider = build({}, { fetch: capturingFetch(sent), identities: { aws } });
    const r = await provider.invoke(ask());
    await provider.invoke(ask());
    expect(sent[0]?.url).toBe(
      'https://bedrock-runtime.us-east-2.amazonaws.com/model/us.amazon.nova-pro-v1%3A0/converse',
    );
    expect(aws).toHaveBeenCalledTimes(2);
    const authorization = sent.map((s) => s.headers.get('authorization') ?? '');
    expect(authorization[0]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIATESTKEY1\/\d{8}\/us-east-2\/bedrock\/aws4_request/,
    );
    expect(authorization[1]).toMatch(/Credential=ASIATESTKEY2\//);
    expect(sent.map((s) => s.headers.get('x-amz-security-token'))).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(sent[0]?.body).toMatchObject({ messages: [{ role: 'user' }] });
    expect(r).toMatchObject({
      message: { role: 'assistant', content: 'Shipped.' },
      provider: { id: 'bedrock-acme', model: NOVA },
      providerRequestId: 'req-br-1',
      attempts: 1,
    });
    expect(r.costUsd).toBeCloseTo((40 * 0.0008 + 5 * 0.0032) / 1000, 12);
  });

  test('a Bedrock API key: the bearer token, read for every request; nothing signed', async () => {
    const sent: Sent[] = [];
    const keys = ['bedrock-key-one', 'bedrock-key-two'];
    const provider = build(
      { auth: 'api-key' },
      { fetch: capturingFetch(sent), resolveApiKey: async () => keys.shift() as string },
    );
    await provider.invoke(ask());
    await provider.invoke(ask());
    expect(sent.map((s) => s.headers.get('authorization'))).toEqual([
      'Bearer bedrock-key-one',
      'Bearer bedrock-key-two',
    ]);
    expect(sent.map((s) => s.headers.get('x-amz-date'))).toEqual([null, null]);
    expect(sent[0]?.url).toMatch(/^https:\/\/bedrock-runtime\.us-east-2\.amazonaws\.com\//);
  });

  test("the registration's own endpoint, and another partition's", async () => {
    const vpce: Sent[] = [];
    await build(
      { baseURL: 'https://vpce-1.bedrock-runtime.us-east-2.vpce.amazonaws.com' },
      { fetch: capturingFetch(vpce), identities: { aws: identity() } },
    ).invoke(ask());
    expect(vpce[0]?.url).toMatch(
      /^https:\/\/vpce-1\.bedrock-runtime\.us-east-2\.vpce\.amazonaws\.com\/model\//,
    );

    const china: Sent[] = [];
    await build(
      {},
      { fetch: capturingFetch(china), identities: { aws: identity() } },
      'cn-north-1',
    ).invoke(ask());
    expect(china[0]?.url).toMatch(/^https:\/\/bedrock-runtime\.cn-north-1\.amazonaws\.com\.cn\//);
    expect(china[0]?.headers.get('authorization')).toMatch(/\/cn-north-1\/bedrock\/aws4_request/);
  });

  test('an access-denied 403 is a typed auth error, one attempt', async () => {
    const provider = build(
      {},
      {
        fetch: capturingFetch([], 403, {
          message: 'User is not authorized to perform: bedrock:InvokeModel',
        }),
        identities: { aws: identity() },
      },
    );
    const err = await provider.invoke(ask()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toMatchObject({ kind: 'auth', status: 403 });
    expect((err as Error).message).toContain('bedrock:InvokeModel');
    expect(attemptsOf(err)).toBe(1);
  });
});

describe('the factory refuses', () => {
  test("the runtime's identity when the runtime has none: the check's own words", () => {
    expect(() => build({}, {})).toThrow(
      '@kindgi/adapter-model-bedrock: provider "bedrock-acme": adapter_config.auth = aws-identity (the default) needs the runtime\'s AWS identity',
    );
  });

  test('a registration checkConfig refuses, with its first problem', () => {
    expect(() => build({}, { identities: { aws: identity() } }, 'global')).toThrow(
      '@kindgi/adapter-model-bedrock: provider "bedrock-acme": metadata.region must be the AWS region Bedrock runs in',
    );
  });
});

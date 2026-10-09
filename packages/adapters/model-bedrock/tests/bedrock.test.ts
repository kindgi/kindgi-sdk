// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Amazon Bedrock adapter, without AWS: each registration problem `checkConfig` reports, and
 * what the factory's provider sends (captured at the fetch the runtime hands it): the endpoint,
 * the model, and how it signs in.
 */

import { ModelProviderError } from '@kindgi/adapter-model-shared';
import type { AdapterFactoryInput, ProviderMetadata } from '@kindgi/capabilities';
import { attemptsOf } from '@kindgi/capabilities/attempts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  IDENTITY_TIMEOUT_MS,
  NOVA_THINKING_REMOVED,
  bedrockAdapterFactory,
  bedrockCheckConfig,
  bedrockRuntimeEndpoint,
} from '../src/index.js';

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

  test("the runtime's AWS credentials go only to Bedrock's runtime in the region; any other host is refused, named", () => {
    const refused = (baseURL: string, region = 'us-east-2') => {
      const host = new URL(baseURL).hostname;
      expect(check({ baseURL }, false, region)).toEqual([
        {
          path: '/adapter_config/baseURL',
          message: expect.stringContaining(`go only to Bedrock's runtime in ${region}`),
        },
      ]);
      expect(check({ baseURL }, false, region)[0]?.message).toContain(`${host} isn't one`);
    };
    refused('https://collector.example');
    // A look-alike, another region, another service, another partition's suffix.
    refused('https://bedrock-runtime.us-east-2.amazonaws.com.collector.example');
    refused('https://bedrock-runtime.us-west-2.amazonaws.com');
    refused('https://bedrock.us-east-2.amazonaws.com');
    refused('https://bedrock-runtime.us-east-2.amazonaws.com.cn');
    refused('https://evil.bedrock-runtime.us-east-2.vpce.amazonaws.com');
    for (const [baseURL, region] of [
      ['https://bedrock-runtime.us-east-2.amazonaws.com', 'us-east-2'],
      ['https://bedrock-runtime-fips.us-east-2.amazonaws.com/', 'us-east-2'],
      [
        'https://vpce-0a1b2c3d4e5f-abcdefgh.bedrock-runtime.us-east-2.vpce.amazonaws.com',
        'us-east-2',
      ],
      [
        'https://vpce-0a1b2c3d-us-east-2a.bedrock-runtime.us-east-2.vpce.amazonaws.com',
        'us-east-2',
      ],
      ['https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com', 'us-gov-west-1'],
      ['https://bedrock-runtime.cn-north-1.amazonaws.com.cn', 'cn-north-1'],
    ] as const) {
      expect(check({ baseURL }, false, region)).toEqual([]);
    }
    // A Bedrock API key goes where its own registration says: a gateway, any path.
    expect(check({ auth: 'api-key', baseURL: 'https://gw.acme.example/bedrock' }, true)).toEqual(
      [],
    );
  });

  test.each([
    ['https://user:pw@gw.acme.example', "can't hold credentials"],
    ['https://gw.acme.example/?key=k', "can't hold a query or a fragment"],
    ['https://gw.acme.example/#here', "can't hold a query or a fragment"],
  ])('a baseURL %s → %s', (baseURL, words) => {
    expect(check({ auth: 'api-key', baseURL }, true)[0]?.message).toContain(words);
  });

  test("Bedrock's own host takes no path: the adapter adds the API's", () => {
    expect(
      check({ baseURL: 'https://bedrock-runtime.us-east-2.amazonaws.com/v1' })[0]?.message,
    ).toContain("is an endpoint's root");
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

describe('a failed sign-in is auth, once, never retried', () => {
  test('the identity throws: auth, naming KINDGI_AWS_IDENTITY, asked once, nothing sent', async () => {
    const sent: Sent[] = [];
    const aws = vi.fn(async () => {
      throw new Error('AccessDenied: not authorized to perform sts:AssumeRole');
    });
    const err = await build({}, { fetch: capturingFetch(sent), identities: { aws } })
      .invoke(ask())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toMatchObject({ kind: 'auth' });
    expect((err as Error).message).toContain('sts:AssumeRole');
    expect((err as Error).message).toContain('KINDGI_AWS_IDENTITY');
    expect(aws).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  test('the identity returns no key: auth', async () => {
    const aws = vi.fn(async () => ({ accessKeyId: '', secretAccessKey: '' }));
    const err = await build({}, { fetch: capturingFetch([]), identities: { aws } })
      .invoke(ask())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'auth' });
    expect((err as Error).message).toContain('returned no credentials');
  });

  test('the identity hangs: auth after the bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const aws = vi.fn(() => new Promise<never>(() => {}));
      const pending = build({}, { fetch: capturingFetch([]), identities: { aws } })
        .invoke(ask())
        .catch((e: unknown) => e);
      while (aws.mock.calls.length === 0) {
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

  test('the key can’t be read, or is empty or blank: auth, nothing sent', async () => {
    for (const resolveApiKey of [
      async () => {
        throw new Error('secret store unreachable');
      },
      // A store that's down: the library would take this cause for a dropped connection.
      async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      },
      async () => '',
      async () => ' \n',
    ]) {
      const sent: Sent[] = [];
      const read = vi.fn(resolveApiKey);
      const err = await build(
        { auth: 'api-key' },
        { fetch: capturingFetch(sent), resolveApiKey: read },
      )
        .invoke(ask())
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'auth' });
      expect(read).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([]);
    }
  });
});

describe('each attempt signs in for itself', () => {
  test('calls at once: one ask of the identity each, each request signed with its own', async () => {
    const sent: Sent[] = [];
    const aws = identity();
    const provider = build({}, { fetch: capturingFetch(sent), identities: { aws } });
    await Promise.all(Array.from({ length: 20 }, () => provider.invoke(ask())));
    expect(aws).toHaveBeenCalledTimes(20);
    const keys = sent.map(
      (s) => /Credential=(ASIATESTKEY\d+)\//.exec(s.headers.get('authorization') ?? '')?.[1],
    );
    expect(new Set(keys).size).toBe(20);
    // Each request's session token is its own credentials'.
    for (const s of sent) {
      const n = /ASIATESTKEY(\d+)/.exec(s.headers.get('authorization') ?? '')?.[1];
      expect(s.headers.get('x-amz-security-token')).toBe(`session-${n}`);
    }
  });

  test('an abort while the identity is asked ends the call at once, its reason', async () => {
    // No timer fires here: only the abort can end the wait for an identity that never answers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const controller = new AbortController();
      const aws = vi.fn(() => new Promise<never>(() => {}));
      const pending = build({}, { fetch: capturingFetch([]), identities: { aws } })
        .invoke({ ...ask(), abortSignal: controller.signal })
        .catch((e: unknown) => e);
      while (aws.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const reason = new Error('turn stopped');
      controller.abort(reason);
      expect(await pending).toBe(reason);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a key with whitespace around it is sent without', async () => {
    const sent: Sent[] = [];
    await build(
      { auth: 'api-key' },
      { fetch: capturingFetch(sent), resolveApiKey: async () => 'bedrock-key\n' },
    ).invoke(ask());
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer bedrock-key');
  });

  test.each([
    ['aws-identity', {}, { identities: { aws: identity() } }],
    ['api-key', { auth: 'api-key' }, { resolveApiKey: async () => 'k' }],
  ] as const)('%s: no request follows a redirect', async (_auth, config, extra) => {
    const redirects: RequestInit['redirect'][] = [];
    const fetch = capturingFetch([]);
    await build(config, {
      ...extra,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        redirects.push(init?.redirect);
        return fetch(input, init);
      }) as typeof globalThis.fetch,
    }).invoke(ask());
    expect(redirects).toEqual(['error']);
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
      headers: { 'content-type': 'application/json', 'x-amzn-requestid': `req-${i}`, ...a.headers },
    });
  }) as typeof fetch;
}

describe('more of what it sends', () => {
  test('a 429, then the answer: each attempt signed with fresh credentials', async () => {
    const sent: Sent[] = [];
    const aws = identity();
    const r = await build(
      {},
      {
        fetch: answering(sent, [
          {
            status: 429,
            body: { message: 'Too many requests' },
            headers: { 'retry-after-ms': '0' },
          },
          { status: 200, body: CONVERSE_BODY },
        ]),
        identities: { aws },
      },
    ).invoke(ask());
    expect(r.attempts).toBe(2);
    expect(aws).toHaveBeenCalledTimes(2);
    expect(sent.map((s) => s.headers.get('x-amz-security-token'))).toEqual([
      'session-1',
      'session-2',
    ]);
  });

  test('a 403 (expired token): auth after one attempt, with what to check', async () => {
    const err = await build(
      {},
      {
        fetch: capturingFetch([], 403, {
          message: 'The security token included in the request is expired',
        }),
        identities: { aws: identity() },
      },
    )
      .invoke(ask())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'auth', status: 403 });
    expect(attemptsOf(err)).toBe(1);
    const message = (err as Error).message;
    expect(message).toContain('is expired');
    expect(message).toContain("the runtime's identity's policy lacks bedrock:InvokeModel");
    expect(message).toContain('access to the model in us-east-2');
  });

  test('a 403 with a Bedrock API key: what to check is the key’s', async () => {
    const err = await build(
      { auth: 'api-key' },
      {
        fetch: capturingFetch([], 403, { message: 'Authentication failed' }),
        resolveApiKey: async () => 'k',
      },
    )
      .invoke(ask())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'auth', status: 403 });
    const message = (err as Error).message;
    expect(message).toContain('the IAM user the API key belongs to lacks bedrock:InvokeModel');
    expect(message).toContain('the key has expired or been revoked');
    expect(message).not.toContain('identity');
  });

  test('a 408 (the model timed out) is unavailable, retried, never context-too-long', async () => {
    const err = await build(
      {},
      {
        fetch: answering(
          [],
          [
            {
              status: 408,
              body: { message: 'The request took too long to process.' },
              headers: { 'retry-after-ms': '0', 'x-amzn-errortype': 'ModelTimeoutException' },
            },
          ],
        ),
        identities: { aws: identity() },
      },
    )
      .invoke(ask())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unavailable', status: 408 });
    expect(attemptsOf(err)).toBe(3);
  });

  test('a tool call, then its result on the next call (toolResult with its toolUseId)', async () => {
    const sent: Sent[] = [];
    const toolUse = {
      ...CONVERSE_BODY,
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: { toolUseId: 'tu-1', name: 'acme__lookup_order', input: { orderId: 'A-1' } },
            },
          ],
        },
      },
      stopReason: 'tool_use',
    };
    const provider = build(
      {},
      {
        fetch: answering(sent, [
          { status: 200, body: toolUse },
          { status: 200, body: CONVERSE_BODY },
        ]),
        identities: { aws: identity() },
      },
    );
    const tools = [
      {
        name: 'acme.lookup_order',
        description: 'Look up an order.',
        inputSchema: { type: 'object' },
      },
    ];
    const first = await provider.invoke({ ...ask(), tools });
    expect(first.finishReason).toBe('tool-use');
    await provider.invoke({
      ...ask(),
      tools,
      messages: [
        ...ask().messages,
        first.message,
        { role: 'tool', toolCallId: 'tu-1', content: '{"status":"shipped"}' },
      ],
    });
    const messages = sent[1]?.body.messages as {
      role: string;
      content: Record<string, unknown>[];
    }[];
    expect(messages.flatMap((m) => m.content)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolResult: expect.objectContaining({ toolUseId: 'tu-1' }) }),
      ]),
    );
  });

  test('out of context (model_context_window_exceeded) is length', async () => {
    const r = await build(
      {},
      {
        fetch: capturingFetch([], 200, {
          ...CONVERSE_BODY,
          stopReason: 'model_context_window_exceeded',
        }),
        identities: { aws: identity() },
      },
    ).invoke(ask());
    expect(r.finishReason).toBe('length');
  });
});

describe('the factory refuses', () => {
  test("a host other than Bedrock's runtime for the runtime's identity, before asking it", () => {
    const aws = identity();
    expect(() =>
      build(
        { baseURL: 'https://collector.example' },
        { fetch: capturingFetch([]), identities: { aws } },
      ),
    ).toThrow("collector.example isn't one");
    expect(aws).not.toHaveBeenCalled();
  });

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

describe("Nova's chain of thought, written into its answer", () => {
  /** A Converse answer whose text is `text` (and a tool call, when given). */
  const answer = (text: string, toolUse?: object) => ({
    ...CONVERSE_BODY,
    output: {
      message: { role: 'assistant', content: [{ text }, ...(toolUse ? [{ toolUse }] : [])] },
    },
    stopReason: toolUse ? 'tool_use' : 'end_turn',
  });
  const nova = (text: string, toolUse?: object) =>
    build(
      {},
      { fetch: capturingFetch([], 200, answer(text, toolUse)), identities: { aws: identity() } },
    );

  test('a leading <thinking> block: taken out of the answer, with a warning', async () => {
    const r = await nova('<thinking> The tool says shipped. </thinking>\n\n"Hello, Ada!"').invoke(
      ask(),
    );
    expect(r.message.content).toBe('"Hello, Ada!"');
    expect(r.warnings).toContainEqual({
      code: NOVA_THINKING_REMOVED,
      message: expect.stringContaining('wrote its reasoning into the answer'),
    });
  });

  test('a tool-use turn whose text is only the block: no text, the tool call kept', async () => {
    const r = await nova('<thinking>Look up the order.</thinking>', {
      toolUseId: 't1',
      name: 'acme__lookup_order',
      input: { orderId: 'A-1042' },
    }).invoke({
      ...ask(),
      tools: [{ name: 'acme.lookup_order', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(r.message.content).toBe('');
    expect(r.message.toolCalls?.map((c) => c.name)).toEqual(['acme.lookup_order']);
  });

  test.each([
    ['absent', 'Shipped.'],
    ['mid-text', 'Shipped. <thinking>a note</thinking> Done.'],
    ['unclosed', '<thinking>still thinking… Shipped.'],
  ])('%s: the answer as it came, no warning', async (_, text) => {
    const r = await nova(text).invoke(ask());
    expect(r.message.content).toBe(text);
    expect(r.warnings?.some((w) => w.code === NOVA_THINKING_REMOVED) ?? false).toBe(false);
  });

  test('another vendor on Bedrock: left alone', async () => {
    const llama = 'us.meta.llama4-maverick-17b-instruct-v1:0';
    const provider = bedrockAdapterFactory({
      metadata: {
        ...metadata(),
        models: [{ ...metadata().models[0], name: llama }],
      } as unknown as ProviderMetadata,
      config: {},
      fetch: capturingFetch([], 200, answer('<thinking>x</thinking> Shipped.')),
      identities: { aws: identity() },
    });
    const r = await provider.invoke({ ...ask(), model: llama });
    expect(r.message.content).toBe('<thinking>x</thinking> Shipped.');
  });
});

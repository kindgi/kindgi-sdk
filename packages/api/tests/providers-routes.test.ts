// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProviderMetadata } from '@kindgi/capabilities';
import type { Cursor, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  CapabilityDescriptor,
  ProviderRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Providers route tests. The registry is caller-plugged;
 * these tests back it with an in-memory `Map`-based adapter. Full CRUD
 * plus the `capabilitiesFor` sub-resource.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'providers-token-abc';

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

interface ProviderSpecOverrides {
  readonly id?: string;
  readonly model?: string;
  readonly region?: string;
  readonly contextWindow?: number;
  readonly features?: readonly string[];
  readonly cost?: { promptUsdPer1kTokens: number; completionUsdPer1kTokens: number };
  readonly p95LatencyMs?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly capabilityKind?: string;
}

function providerSpec(overrides: ProviderSpecOverrides = {}): ProviderMetadata {
  const modelName = overrides.model ?? 'claude-opus-4-7';
  return {
    id: overrides.id ?? 'anthropic:claude-opus-4-7',
    region: overrides.region ?? 'us-east-1',
    models: [
      {
        name: modelName,
        contextWindow: overrides.contextWindow ?? 200_000,
        features: (overrides.features ?? ['tool-use', 'streaming', 'structured-output']) as never,
        cost: overrides.cost ?? {
          promptUsdPer1kTokens: 0.015,
          completionUsdPer1kTokens: 0.075,
        },
        ...(overrides.p95LatencyMs !== undefined && { p95LatencyMs: overrides.p95LatencyMs }),
      },
    ],
    ...(overrides.attributes !== undefined && { attributes: overrides.attributes as never }),
    ...(overrides.description !== undefined && { description: overrides.description }),
    ...(overrides.capabilityKind !== undefined && {
      capabilityKind: overrides.capabilityKind as never,
    }),
  };
}

function descriptorFor(feature: string): CapabilityDescriptor {
  return {
    id: `feature:${feature}`,
    feature,
    description: `Framework built-in feature "${feature}".`,
    kind: 'llm-inference',
  };
}

function makeInMemoryBinding(): ProviderRegistryBinding & {
  readonly registered: Parameters<ProviderRegistryBinding['register']>[0][];
} {
  const store = new Map<string, ProviderMetadata>();
  const registered: Parameters<ProviderRegistryBinding['register']>[0][] = [];

  function paginate(
    rows: readonly ProviderMetadata[],
    limit: number,
    cursor: Cursor | undefined,
  ): { data: readonly ProviderMetadata[]; nextCursor?: Cursor } {
    let startAt = 0;
    if (cursor !== undefined) {
      const cur = cursor as unknown as string;
      startAt = rows.findIndex((row) => row.id > cur);
      if (startAt < 0) startAt = rows.length;
    }
    const slice = rows.slice(startAt, startAt + limit);
    const last = slice[slice.length - 1];
    const hasMore = startAt + slice.length < rows.length;
    return {
      data: slice,
      ...(hasMore && last !== undefined && { nextCursor: last.id as unknown as Cursor }),
    };
  }

  return {
    registered,
    async list({ limit, cursor, featureFilter }) {
      const sorted = [...store.values()].sort((a, b) => a.id.localeCompare(b.id));
      const filtered =
        featureFilter === undefined
          ? sorted
          : sorted.filter((m) =>
              m.models.some((mi) => (mi.features as readonly string[]).includes(featureFilter)),
            );
      return paginate(filtered, limit, cursor);
    },
    async get({ providerId }) {
      return store.get(providerId) ?? null;
    },
    async register(input) {
      registered.push(input);
      const { metadata } = input;
      if (store.has(metadata.id)) {
        return { kind: 'already-registered', providerId: metadata.id };
      }
      store.set(metadata.id, metadata);
      return { kind: 'ok', providerId: metadata.id };
    },
    async unregister({ providerId }) {
      return { unregistered: store.delete(providerId) };
    },
    async capabilitiesFor({ providerId }) {
      const m = store.get(providerId);
      if (m === undefined) return null;
      return m.models.flatMap((mi) => mi.features.map(descriptorFor));
    },
    async resolveForRuntime() {
      // Stub — the in-memory binding used in these HTTP-route tests
      // doesn't persist adapterId / secretRef. Runtime bridge
      // behavior is exercised by the Postgres provider-registry
      // integration tests, not here.
      return [];
    },
  };
}

const TEST_ADAPTER_ID = '@kindgi/adapter-model-anthropic';

function registerBody(over: ProviderSpecOverrides = {}): string {
  return JSON.stringify({
    metadata: providerSpec(over),
    adapter_id: TEST_ADAPTER_ID,
  });
}

function makeApp() {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    providerRegistry: binding,
  });
  return { app, binding };
}

describe('API — providers list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('feature filter returns only matching providers', async () => {
    const { app, binding } = makeApp();
    await binding.register({
      tenantId,
      metadata: providerSpec({
        id: 'anthropic:opus',
        features: ['tool-use', 'thinking'],
      }),
      adapterId: TEST_ADAPTER_ID,
    });
    await binding.register({
      tenantId,
      metadata: providerSpec({
        id: 'openai:gpt-4o',
        features: ['tool-use', 'vision'],
      }),
      adapterId: TEST_ADAPTER_ID,
    });
    await binding.register({
      tenantId,
      metadata: providerSpec({
        id: 'zulu:no-tools',
        features: ['streaming'],
      }),
      adapterId: TEST_ADAPTER_ID,
    });

    const res = await app.request('/v1/providers?feature=tool-use', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((p) => p.id).sort();
    expect(ids).toEqual(['anthropic:opus', 'openai:gpt-4o']);
  });
});

describe('API — providers register + get', () => {
  test('register + get roundtrip', async () => {
    const { app } = makeApp();
    const register = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: registerBody(),
    });
    expect(register.status).toBe(201);
    const registered = (await register.json()) as { providerId: string };
    expect(registered.providerId).toBe('anthropic:claude-opus-4-7');

    const get = await app.request('/v1/providers/anthropic:claude-opus-4-7', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    // ProviderMetadata reshape: flat model fields are now nested under models[].
    const body = (await get.json()) as {
      id: string;
      region: string;
      models: readonly {
        name: string;
        contextWindow: number;
        features: readonly string[];
        cost: { promptUsdPer1kTokens: number; completionUsdPer1kTokens: number };
      }[];
    };
    expect(body.id).toBe('anthropic:claude-opus-4-7');
    expect(body.region).toBe('us-east-1');
    expect(body.models).toHaveLength(1);
    const m = body.models[0];
    expect(m?.name).toBe('claude-opus-4-7');
    expect(m?.contextWindow).toBe(200_000);
    expect(m?.features).toEqual(['tool-use', 'streaming', 'structured-output']);
    expect(m?.cost.promptUsdPer1kTokens).toBe(0.015);
  });

  test("adapter_config reaches the binding as the adapter's settings, and get never returns it", async () => {
    const { app, binding } = makeApp();
    const register = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: providerSpec({ id: 'gemini-vertex', region: 'global' }),
        adapter_id: '@kindgi/adapter-model-gemini',
        adapter_config: { project: 'acme-dev', retries: 2, preview: true },
      }),
    });
    expect(register.status).toBe(201);
    expect(binding.registered.at(-1)).toMatchObject({
      adapterId: '@kindgi/adapter-model-gemini',
      adapterConfig: { project: 'acme-dev', retries: 2, preview: true },
    });

    const get = await app.request('/v1/providers/gemini-vertex', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await get.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('adapter_config');
    expect(body).not.toHaveProperty('adapterConfig');
  });

  test.each([
    ['an array', ['project']],
    ['a nested value', { project: { id: 'x' } }],
    ['a string', 'project=x'],
  ])('adapter_config that is %s → 400 bad-input', async (_label, adapterConfig) => {
    const { app, binding } = makeApp();
    const res = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: providerSpec(),
        adapter_id: TEST_ADAPTER_ID,
        adapter_config: adapterConfig,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-input');
    expect(binding.registered).toEqual([]);
  });

  test('register twice same id with no idempotency key → 409', async () => {
    const { app } = makeApp();
    const first = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: registerBody(),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: registerBody(),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('provider-already-registered');
  });

  test('idempotency-key retry replays original 201', async () => {
    const { app } = makeApp();
    const key = randomUUID();
    const first = await app.request('/v1/providers', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: registerBody(),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/providers', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: registerBody(),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const body = (await second.json()) as { providerId: string };
    expect(body.providerId).toBe('anthropic:claude-opus-4-7');
  });

  test('fallback round-trips through register + get', async () => {
    const { app } = makeApp();
    const register = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: { ...providerSpec({ id: 'dev-echo' }), fallback: true },
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(register.status).toBe(201);
    const get = await app.request('/v1/providers/dev-echo', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await get.json()) as { fallback?: boolean }).fallback).toBe(true);
  });

  test('labels round-trip through register + get + list', async () => {
    const { app } = makeApp();
    const labels = { 'kindgi.com/managed-by': 'kindgi-dev:acme.pack', team: 'search' };
    const register = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: { ...providerSpec(), labels },
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(register.status).toBe(201);
    const get = await app.request('/v1/providers/anthropic:claude-opus-4-7', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await get.json()) as { labels?: unknown }).labels).toEqual(labels);
    const list = await app.request('/v1/providers', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const page = (await list.json()) as { data: { labels?: unknown }[] };
    expect(page.data[0]?.labels).toEqual(labels);
  });

  test('labels out of bounds → 400 invalid-provider, reason invalid-labels', async () => {
    const { app } = makeApp();
    for (const labels of [
      { Team: 'search' },
      { team: 1 },
      { team: 'x'.repeat(257) },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])),
      ['team'],
    ]) {
      const res = await app.request('/v1/providers', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          metadata: { ...providerSpec(), labels },
          adapter_id: TEST_ADAPTER_ID,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe('invalid-provider');
      expect(body.error.details?.reason).toBe('invalid-labels');
      expect(body.error.message).toContain('labels');
    }
  });

  test('defaultModel round-trips through register + get; a name it lacks → 400 unknown-default-model', async () => {
    const { app } = makeApp();
    const spec = providerSpec({ id: 'with-default' });
    const name = spec.models[0]?.name as string;
    const register = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: { ...spec, defaultModel: name },
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(register.status).toBe(201);
    const get = await app.request('/v1/providers/with-default', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await get.json()) as { defaultModel?: string }).defaultModel).toBe(name);
    const bad = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: { ...providerSpec({ id: 'bad-default' }), defaultModel: 'not-one-of-them' },
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe('unknown-default-model');
  });

  test("a model's sampling round-trips through register + get; a non-boolean → 400 invalid-sampling", async () => {
    const { app } = makeApp();
    const spec = providerSpec({ id: 'no-sampling' });
    const models = spec.models.map((m, i) => (i === 0 ? { ...m, sampling: false } : m));
    const register = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { ...spec, models }, adapter_id: TEST_ADAPTER_ID }),
    });
    expect(register.status).toBe(201);
    const get = await app.request('/v1/providers/no-sampling', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const got = (await get.json()) as { models: { sampling?: boolean }[] };
    expect(got.models[0]?.sampling).toBe(false);
    expect(got.models.slice(1).every((m) => m.sampling === undefined)).toBe(true);
    const bad = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          ...providerSpec({ id: 'bad-sampling' }),
          models: spec.models.map((m) => ({ ...m, sampling: 'off' })),
        },
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe('invalid-sampling');
  });

  test("a model's thinking round-trips through register + get; a bad one → 400 invalid-thinking", async () => {
    const { app } = makeApp();
    const spec = providerSpec({ id: 'thinks' });
    const thinking = { mode: 'adaptive', lowest: 'low' };
    const models = spec.models.map((m, i) => (i === 0 ? { ...m, thinking } : m));
    const register = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { ...spec, models }, adapter_id: TEST_ADAPTER_ID }),
    });
    expect(register.status).toBe(201);
    const get = await app.request('/v1/providers/thinks', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(
      ((await get.json()) as { models: { thinking?: unknown }[] }).models[0]?.thinking,
    ).toEqual(thinking);
    const bad = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          ...providerSpec({ id: 'bad-thinking' }),
          models: spec.models.map((m) => ({ ...m, thinking: { mode: 'off' } })),
        },
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe('invalid-thinking');
  });

  test("a model's cost keeps its adapter's rates through register + get; a bad one → 400 invalid-cost", async () => {
    const { app } = makeApp();
    const spec = providerSpec({ id: 'rated' });
    const cost = {
      promptUsdPer1kTokens: 0.0001,
      completionUsdPer1kTokens: 0.0005,
      promptCacheReadMultiplier: 0.1,
      longContext: {
        thresholdTokens: 100000,
        promptUsdPer1kTokens: 0.0005,
        completionUsdPer1kTokens: 0.0025,
      },
    };
    const models = spec.models.map((m, i) => (i === 0 ? { ...m, cost } : m));
    const register = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { ...spec, models }, adapter_id: TEST_ADAPTER_ID }),
    });
    expect(register.status).toBe(201);
    const get = await app.request('/v1/providers/rated', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await get.json()) as { models: { cost: unknown }[] }).models[0]?.cost).toEqual(cost);
    for (const bad of [
      { ...cost, longContext: { thresholdTokens: -1 } },
      { ...cost, longContext: {} },
      { ...cost, promptCacheReadMultiplier: 'cheap' },
      { ...cost, tiers: [0.1] },
      { ...cost, longContext: { nested: { deeper: 1 } } },
    ]) {
      const res = await app.request('/v1/providers', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          metadata: {
            ...providerSpec({ id: 'bad-rates' }),
            models: spec.models.map((m) => ({ ...m, cost: bad })),
          },
          adapter_id: TEST_ADAPTER_ID,
        }),
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      const body = (await res.json()) as { error: { details?: { reason?: string } } };
      expect(body.error.details?.reason).toBe('invalid-cost');
    }
  });

  test('validation failure (non-boolean fallback) → 400 invalid-provider', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: { ...providerSpec(), fallback: 'yes' },
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('invalid-provider');
    expect(body.error.details?.reason).toBe('invalid-fallback');
  });

  test('validation failure (invalid feature) → 400 invalid-provider', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: providerSpec({ features: ['tool-use', 'not-a-real-feature'] }),
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('invalid-provider');
    expect(body.error.details?.reason).toBe('unknown-feature');
  });

  test('validation failure (missing id) → 400 invalid-provider', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: { ...providerSpec(), id: '' },
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('invalid-provider');
    expect(body.error.details?.reason).toBe('empty-id');
  });

  test('validation failure (negative cost) → 400 invalid-provider', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: providerSpec({
          cost: { promptUsdPer1kTokens: -0.001, completionUsdPer1kTokens: 0.01 },
        }),
        adapter_id: TEST_ADAPTER_ID,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('invalid-provider');
    expect(body.error.details?.reason).toBe('invalid-cost');
  });

  test('a region that is not one DNS label → 400 invalid-region (an adapter may build a host from it)', async () => {
    const { app } = makeApp();
    for (const region of [
      'evil.example/x?',
      'us-central1.evil.example',
      'US-EAST-1',
      '169.254.169.254',
    ]) {
      const res = await app.request('/v1/providers', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: providerSpec({ region }), adapter_id: TEST_ADAPTER_ID }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe('invalid-provider');
      expect(body.error.details?.reason).toBe('invalid-region');
    }
  });

  test('non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('unknown id → 404 provider-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers/nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('provider-not-found');
  });
});

describe('API — providers unregister', () => {
  test('unregister known provider → 200 unregistered: true, then get 404', async () => {
    const { app, binding } = makeApp();
    await binding.register({ tenantId, metadata: providerSpec(), adapterId: TEST_ADAPTER_ID });
    const res = await app.request('/v1/providers/anthropic:claude-opus-4-7/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providerId: string; unregistered: boolean };
    expect(body.providerId).toBe('anthropic:claude-opus-4-7');
    expect(body.unregistered).toBe(true);

    const get = await app.request('/v1/providers/anthropic:claude-opus-4-7', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  test('unregister unknown provider → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers/nope/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — providers capabilities sub-resource', () => {
  test('known provider → list of descriptors', async () => {
    const { app, binding } = makeApp();
    await binding.register({
      tenantId,
      metadata: providerSpec({ id: 'p1', features: ['tool-use', 'vision'] }),
      adapterId: TEST_ADAPTER_ID,
    });
    const res = await app.request('/v1/providers/p1/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; feature: string }> };
    const features = body.data.map((d) => d.feature).sort();
    expect(features).toEqual(['tool-use', 'vision']);
  });

  test('unknown provider → 404 provider-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/providers/nope/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('provider-not-found');
  });
});

describe('API — providers surface unmounted when no binding supplied', () => {
  test('no `providerRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/providers', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { FEATURES } from '@kindgi/capabilities';
import type { Cursor, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  CapabilityDescriptor,
  CapabilityRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Capabilities route tests. The registry is caller-plugged
 * and read-only over HTTP — these tests use an in-memory
 * `Map`-backed adapter seeded with the closed `FEATURES` enum from
 * `@kindgi/capabilities`.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'capabilities-token-abc';

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

function makeBinding(descriptors: readonly CapabilityDescriptor[]): CapabilityRegistryBinding {
  const store = new Map<string, CapabilityDescriptor>();
  for (const d of descriptors) store.set(d.id, d);

  function paginate(
    rows: readonly CapabilityDescriptor[],
    limit: number,
    cursor: Cursor | undefined,
  ): { data: readonly CapabilityDescriptor[]; nextCursor?: Cursor } {
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
    async list({ limit, cursor, featureFilter }) {
      const sorted = [...store.values()].sort((a, b) => a.id.localeCompare(b.id));
      const filtered =
        featureFilter === undefined
          ? sorted
          : sorted.filter((d) => String(d.feature).startsWith(featureFilter));
      return paginate(filtered, limit, cursor);
    },
    async get({ capabilityId }) {
      return store.get(capabilityId) ?? null;
    },
  };
}

function catalogFromFeatures(): CapabilityDescriptor[] {
  return FEATURES.map((f) => ({
    id: `feature:${f}`,
    feature: f,
    description: `Framework built-in feature "${f}".`,
    kind: 'llm-inference' as const,
  }));
}

function makeApp(descriptors: readonly CapabilityDescriptor[] = catalogFromFeatures()) {
  const binding = makeBinding(descriptors);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    capabilityRegistry: binding,
  });
  return { app, binding };
}

describe('API — capabilities list', () => {
  test('empty binding → empty list', async () => {
    const { app } = makeApp([]);
    const res = await app.request('/v1/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('seeded with FEATURES → returns descriptor per feature', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/capabilities?limit=100', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; feature: string }>;
    };
    expect(body.data).toHaveLength(FEATURES.length);
    const features = body.data.map((d) => d.feature).sort();
    expect(features).toEqual([...FEATURES].sort());
  });

  test('feature prefix filter narrows the page', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/capabilities?feature=audio', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ feature: string }> };
    const features = body.data.map((d) => d.feature).sort();
    expect(features).toEqual(['audio-input', 'audio-output']);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app } = makeApp();
    const first = await app.request('/v1/capabilities?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/capabilities?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: Array<{ id: string }> };
    expect(secondBody.data).toHaveLength(2);
    // Second page should not repeat first page.
    const firstIds = new Set(firstBody.data.map((d) => d.id));
    for (const d of secondBody.data) expect(firstIds.has(d.id)).toBe(false);
  });
});

describe('API — the providers with each feature', () => {
  test("a descriptor's providers reach the wire; absent stays absent", async () => {
    const { app } = makeApp([
      {
        id: 'feature:vision',
        feature: 'vision',
        description: 'Reads images in its input.',
        providers: [{ providerId: 'acme-openai', models: ['gpt-acme'] }],
      },
      { id: 'feature:batch', feature: 'batch', description: 'Batch.' },
    ]);
    const res = await app.request('/v1/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data.find((d) => d.id === 'feature:vision')?.providers).toEqual([
      { providerId: 'acme-openai', models: ['gpt-acme'] },
    ]);
    expect(body.data.find((d) => d.id === 'feature:batch')).not.toHaveProperty('providers');
  });
});

describe('API — capabilities get', () => {
  test('get roundtrip returns descriptor', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/capabilities/feature:tool-use', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      feature: string;
      description: string;
      kind?: string;
    };
    expect(body.id).toBe('feature:tool-use');
    expect(body.feature).toBe('tool-use');
    expect(body.kind).toBe('llm-inference');
  });

  test('unknown id → 404 capability-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/capabilities/feature:nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('capability-not-found');
  });
});

describe('API — capabilities surface unmounted when no binding supplied', () => {
  test('no `capabilityRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/capabilities', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

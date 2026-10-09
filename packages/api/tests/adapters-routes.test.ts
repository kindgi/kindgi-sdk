// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AdapterInfo,
  AdapterRegistryBinding,
  AdapterTestOutcome,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Adapters route tests. The registry is caller-plugged;
 * these tests back it with an in-memory `Map`-based adapter that also
 * records probe invocations. Read + test only over HTTP — mirrors the
 * settled shape for the admin plane.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'adapters-token-abc';

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

function adapter(overrides: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    adapterId: overrides.adapterId ?? 'sandbox-primary',
    kind: overrides.kind ?? 'sandbox',
    name: overrides.name ?? '@acme/adapter-sandbox-inprocess',
    version: overrides.version ?? '0.0.0',
    capabilities: overrides.capabilities ?? ['context-isolated'],
    status: overrides.status ?? 'active',
    ...(overrides.config !== undefined && { config: overrides.config }),
    ...(overrides.statusReason !== undefined && { statusReason: overrides.statusReason }),
  };
}

interface TestHooks {
  /** Returned when the binding's `test(...)` is called for the given id. */
  probe?: (adapterId: string, input?: Readonly<Record<string, unknown>>) => AdapterTestOutcome;
}

function makeInMemoryBinding(
  seed: readonly AdapterInfo[] = [],
  hooks: TestHooks = {},
): AdapterRegistryBinding {
  const store = new Map<string, AdapterInfo>();
  for (const a of seed) store.set(a.adapterId, a);

  return {
    async list({ limit, cursor, filter }) {
      const sorted = [...store.values()].sort((a, b) => a.adapterId.localeCompare(b.adapterId));
      const filtered = sorted.filter((a) => {
        if (filter?.kind !== undefined && a.kind !== filter.kind) return false;
        if (filter?.status !== undefined && a.status !== filter.status) return false;
        return true;
      });
      let startAt = 0;
      if (cursor !== undefined) {
        const cur = cursor as unknown as string;
        startAt = filtered.findIndex((row) => row.adapterId > cur);
        if (startAt < 0) startAt = filtered.length;
      }
      const slice = filtered.slice(startAt, startAt + limit);
      const last = slice[slice.length - 1];
      const hasMore = startAt + slice.length < filtered.length;
      return {
        data: slice,
        ...(hasMore && last !== undefined && { nextCursor: last.adapterId as unknown as Cursor }),
      };
    },
    async get({ adapterId }) {
      return store.get(adapterId) ?? null;
    },
    async test({ adapterId, input }) {
      if (!store.has(adapterId)) return null;
      if (hooks.probe !== undefined) return hooks.probe(adapterId, input);
      return { ok: true, latencyMs: 5, probe: { defaulted: true } };
    },
  };
}

function makeApp(seed: readonly AdapterInfo[] = [], hooks: TestHooks = {}) {
  const binding = makeInMemoryBinding(seed, hooks);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    adapterRegistry: binding,
  });
  return { app, binding };
}

describe('API — adapters list', () => {
  test('empty registry → empty list, hasMore=false', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/adapters', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('mixed-kind seed round-trips shape (config passes through redacted)', async () => {
    const { app } = makeApp([
      adapter({
        adapterId: 'blob-primary',
        kind: 'blob',
        name: '@acme/adapter-blob-fs',
        capabilities: ['multipart-upload'],
        config: { rootDir: '/var/blobs' },
      }),
      adapter({
        adapterId: 'embedding-local',
        kind: 'embedding',
        name: '@acme/adapter-embedding-local',
        capabilities: ['dim:384'],
      }),
    ]);
    const res = await app.request('/v1/adapters', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        adapterId: string;
        kind: string;
        name: string;
        capabilities: string[];
        status: string;
        config?: Record<string, unknown>;
      }>;
    };
    const ids = body.data.map((a) => a.adapterId).sort();
    expect(ids).toEqual(['blob-primary', 'embedding-local']);
    const blob = body.data.find((a) => a.adapterId === 'blob-primary');
    expect(blob?.kind).toBe('blob');
    expect(blob?.name).toBe('@acme/adapter-blob-fs');
    expect(blob?.capabilities).toEqual(['multipart-upload']);
    expect(blob?.config).toEqual({ rootDir: '/var/blobs' });
    const emb = body.data.find((a) => a.adapterId === 'embedding-local');
    expect(emb?.kind).toBe('embedding');
    expect(emb?.config).toBeUndefined();
  });

  test('kind filter narrows to matching adapters', async () => {
    const { app } = makeApp([
      adapter({ adapterId: 'a-sandbox', kind: 'sandbox' }),
      adapter({ adapterId: 'b-model', kind: 'model' }),
      adapter({ adapterId: 'c-blob', kind: 'blob' }),
    ]);
    const res = await app.request('/v1/adapters?kind=model', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ adapterId: string; kind: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.adapterId).toBe('b-model');
    expect(body.data[0]?.kind).toBe('model');
  });

  test('status filter narrows to matching adapters', async () => {
    const { app } = makeApp([
      adapter({ adapterId: 'a', status: 'active' }),
      adapter({ adapterId: 'b', status: 'degraded', statusReason: 'slow' }),
      adapter({ adapterId: 'c', status: 'error', statusReason: 'auth missing' }),
    ]);
    const res = await app.request('/v1/adapters?status=degraded', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ adapterId: string; status: string; statusReason?: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.adapterId).toBe('b');
    expect(body.data[0]?.status).toBe('degraded');
    expect(body.data[0]?.statusReason).toBe('slow');
  });

  test('unknown kind → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/adapters?kind=not-a-kind', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toMatch(/kind/);
  });

  test('unknown status → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/adapters?status=purgatory', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toMatch(/status/);
  });

  test('cursor pagination walks the set without dupes', async () => {
    const seed: AdapterInfo[] = [];
    for (let i = 0; i < 5; i += 1) {
      seed.push(adapter({ adapterId: `a-${i.toString().padStart(2, '0')}` }));
    }
    const { app } = makeApp(seed);
    const p1 = await app.request('/v1/adapters?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const b1 = (await p1.json()) as {
      data: Array<{ adapterId: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(b1.data).toHaveLength(2);
    expect(b1.hasMore).toBe(true);
    const p2 = await app.request(
      `/v1/adapters?limit=2&cursor=${encodeURIComponent(b1.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const b2 = (await p2.json()) as {
      data: Array<{ adapterId: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(b2.data).toHaveLength(2);
    expect(b2.hasMore).toBe(true);
    const p3 = await app.request(
      `/v1/adapters?limit=2&cursor=${encodeURIComponent(b2.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const b3 = (await p3.json()) as {
      data: Array<{ adapterId: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(b3.data).toHaveLength(1);
    expect(b3.hasMore).toBe(false);
    expect(b3.nextCursor).toBeUndefined();
    const seen = new Set([...b1.data, ...b2.data, ...b3.data].map((a) => a.adapterId));
    expect(seen.size).toBe(5);
  });
});

describe('API — adapters get', () => {
  test('known id → 200 with serialized adapter', async () => {
    const { app } = makeApp([
      adapter({
        adapterId: 'model-openai',
        kind: 'model-provider',
        name: '@kindgi/adapter-model-openai-compat',
        capabilities: ['tool-use', 'streaming'],
        config: { region: 'us-east-1' },
      }),
    ]);
    const res = await app.request('/v1/adapters/model-openai', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      adapterId: string;
      kind: string;
      capabilities: string[];
      config: Record<string, unknown>;
    };
    expect(body.adapterId).toBe('model-openai');
    expect(body.kind).toBe('model-provider');
    expect(body.capabilities).toEqual(['tool-use', 'streaming']);
    expect(body.config).toEqual({ region: 'us-east-1' });
  });

  test('unknown id → 404 adapter-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/adapters/nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { adapterId: string } };
    };
    expect(body.error.code).toBe('adapter-not-found');
    expect(body.error.details?.adapterId).toBe('nope');
  });
});

describe('API — adapters test (smoke probe)', () => {
  test('happy path returns 200 with ok:true and latencyMs > 0', async () => {
    const { app } = makeApp([adapter({ adapterId: 'sandbox-primary', kind: 'sandbox' })], {
      probe: () => ({ ok: true, latencyMs: 12, probe: { result: 2, expected: 2 } }),
    });
    const res = await app.request('/v1/adapters/sandbox-primary/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      latencyMs: number;
      probe: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.latencyMs).toBeGreaterThan(0);
    expect(body.probe).toEqual({ result: 2, expected: 2 });
  });

  test('probe failure returns 200 with ok:false + probe payload', async () => {
    const { app } = makeApp([adapter({ adapterId: 'sandbox-primary', kind: 'sandbox' })], {
      probe: () => ({
        ok: false,
        latencyMs: 42,
        probe: { error: 'unexpected result', got: 3, expected: 2 },
      }),
    });
    const res = await app.request('/v1/adapters/sandbox-primary/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      probe: { error?: string; got?: number; expected?: number };
    };
    expect(body.ok).toBe(false);
    expect(body.probe.error).toBe('unexpected result');
    expect(body.probe.got).toBe(3);
    expect(body.probe.expected).toBe(2);
  });

  test('optional body forwards to binding as `input`', async () => {
    let capturedInput: Readonly<Record<string, unknown>> | undefined;
    const { app } = makeApp([adapter({ adapterId: 'model-openai', kind: 'model-provider' })], {
      probe: (_id, input) => {
        capturedInput = input;
        return { ok: true, latencyMs: 1, probe: { echoed: input ?? null } };
      },
    });
    const res = await app.request('/v1/adapters/model-openai/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello world', maxTokens: 3 }),
    });
    expect(res.status).toBe(200);
    expect(capturedInput).toEqual({ prompt: 'hello world', maxTokens: 3 });
  });

  test('empty body → binding sees no input (default probe path)', async () => {
    let inputSeen: Readonly<Record<string, unknown>> | undefined | 'sentinel' = 'sentinel';
    const { app } = makeApp([adapter({ adapterId: 'a', kind: 'sandbox' })], {
      probe: (_id, input) => {
        inputSeen = input;
        return { ok: true, latencyMs: 1, probe: {} };
      },
    });
    const res = await app.request('/v1/adapters/a/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(inputSeen).toBeUndefined();
  });

  test('non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp([adapter({ adapterId: 'a', kind: 'sandbox' })]);
    const res = await app.request('/v1/adapters/a/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('non-object JSON body → 400 bad-input', async () => {
    const { app } = makeApp([adapter({ adapterId: 'a', kind: 'sandbox' })]);
    const res = await app.request('/v1/adapters/a/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('unknown adapter id → 404 adapter-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/adapters/nope/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('adapter-not-found');
  });

  test('idempotency-key retry replays original probe outcome', async () => {
    let calls = 0;
    const { app } = makeApp([adapter({ adapterId: 'a', kind: 'sandbox' })], {
      probe: () => {
        calls += 1;
        return { ok: true, latencyMs: 7 + calls, probe: { attempt: calls } };
      },
    });
    const key = randomUUID();
    const first = await app.request('/v1/adapters/a/test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ note: 'first' }),
    });
    expect(first.status).toBe(200);
    const b1 = (await first.json()) as { probe: { attempt: number }; latencyMs: number };

    const second = await app.request('/v1/adapters/a/test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ note: 'first' }),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const b2 = (await second.json()) as { probe: { attempt: number }; latencyMs: number };
    // Second call must NOT re-run the probe — replay is byte-identical.
    expect(b2.probe.attempt).toBe(b1.probe.attempt);
    expect(b2.latencyMs).toBe(b1.latencyMs);
    expect(calls).toBe(1);
  });

  test('idempotency-key reused with a different body → 409', async () => {
    const { app } = makeApp([adapter({ adapterId: 'a', kind: 'sandbox' })], {
      probe: () => ({ ok: true, latencyMs: 3, probe: {} }),
    });
    const key = randomUUID();
    const first = await app.request('/v1/adapters/a/test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ variant: 'A' }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/v1/adapters/a/test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ variant: 'B' }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency-key-body-mismatch');
  });
});

describe('API — adapters surface unmounted when no binding supplied', () => {
  test('no `adapterRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/adapters', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('no binding → /v1/adapters/anything/test also 404', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/adapters/nope/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

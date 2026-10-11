// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { policyScope } from '@kindgi/policy-contract';
import type { Cursor, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  Policy,
  PolicyKind,
  PolicyRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Policies route tests. The registry is caller-plugged;
 * these tests back it with an in-memory `Map`-based adapter — same
 * pattern as `flows-routes.test.ts`. Full versioned CRUD, kind filter,
 * name prefix filter, idempotency-key replay, validation, and
 * unmounted-route 404 behavior.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'policies-token-abc';

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

function makeInMemoryBinding(): PolicyRegistryBinding {
  // Legacy handle kept so `void store` below doesn't complain.
  const store = new Map<string, Map<string, Policy>>();

  function paginate<T>(
    rows: readonly T[],
    keyOf: (row: T) => string,
    limit: number,
    cursor: Cursor | undefined,
  ): { data: readonly T[]; nextCursor?: Cursor } {
    let startAt = 0;
    if (cursor !== undefined) {
      const cur = cursor as unknown as string;
      startAt = rows.findIndex((row) => keyOf(row) > cur);
      if (startAt < 0) startAt = rows.length;
    }
    const slice = rows.slice(startAt, startAt + limit);
    const last = slice[slice.length - 1];
    const hasMore = startAt + slice.length < rows.length;
    return {
      data: slice,
      ...(hasMore && last !== undefined && { nextCursor: keyOf(last) as unknown as Cursor }),
    };
  }

  function semverKey(v: string): string {
    const parts = v.split('.');
    return parts.map((p) => p.padStart(6, '0')).join('.');
  }

  // Tombstone-aware inner row so the mock mirrors the real postgres
  // store: `unregister` sets a timestamp, `reinstate` clears it. Enables
  // routing tests for the `includeTombstoned` flag introduced in VT.b.
  interface Row {
    readonly policy: Policy;
    unregisteredAt: string | null;
  }
  function activeVersions(versions: Map<string, Row>): Row[] {
    return [...versions.values()].filter((r) => r.unregisteredAt === null);
  }
  function latestActive(versions: Map<string, Row>): Policy | null {
    const active = activeVersions(versions).sort((a, b) =>
      semverKey(a.policy.version) < semverKey(b.policy.version) ? 1 : -1,
    );
    const [top] = active;
    return top === undefined ? null : top.policy;
  }

  const rowStore = new Map<string, Map<string, Row>>();
  // T236: one policy per scope (`policyScope`; a retention policy's
  // domain), as `PolicyRegistryBinding.publish` / `reinstateVersion`
  // document it: the id's other versions keep their scope, and no other
  // id's active policy of the kind holds it.
  function scopeConflict(policy: Policy) {
    const scope = policyScope(policy);
    if (scope === undefined) return undefined;
    const base = { policyId: policy.id, version: policy.version, policyKind: policy.kind, scope };
    for (const row of rowStore.get(policy.id)?.values() ?? []) {
      if (row.policy.version === policy.version) continue;
      const previousScope = policyScope(row.policy);
      if (previousScope !== undefined && previousScope !== scope) {
        return { kind: 'scope-changed' as const, ...base, previousScope };
      }
    }
    for (const [id, versions] of rowStore) {
      if (id === policy.id) continue;
      const latest = latestActive(versions);
      if (latest !== null && latest.kind === policy.kind && policyScope(latest) === scope) {
        return { kind: 'scope-taken' as const, ...base, heldBy: id };
      }
    }
    return undefined;
  }
  // Bridge existing test helper that references `store` — expose the same
  // policy set through the tombstone-aware Map.
  void store;

  return {
    async list({ limit, cursor, policyKind, nameFilter }) {
      const latestPerId: Policy[] = [];
      for (const [id, versions] of [...rowStore.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (nameFilter !== undefined && !id.startsWith(nameFilter)) continue;
        const latest = latestActive(versions);
        if (latest === null) continue;
        if (policyKind !== undefined && latest.kind !== policyKind) continue;
        latestPerId.push(latest);
      }
      return paginate(latestPerId, (p) => p.id, limit, cursor);
    },
    async get({ policyId }) {
      const versions = rowStore.get(policyId);
      if (versions === undefined) return null;
      return latestActive(versions);
    },
    async getVersion({ policyId, version }) {
      const versions = rowStore.get(policyId);
      if (versions === undefined) return null;
      const row = versions.get(version);
      if (row === undefined || row.unregisteredAt !== null) return null;
      return row.policy;
    },
    async headExists({ policyId }) {
      return rowStore.has(policyId);
    },
    async listVersions({ policyId, limit, cursor, includeTombstoned }) {
      const versions = rowStore.get(policyId);
      if (versions === undefined) return { data: [] };
      const entries = [...versions.values()].filter(
        (r) => includeTombstoned === true || r.unregisteredAt === null,
      );
      entries.sort((a, b) => (semverKey(a.policy.version) < semverKey(b.policy.version) ? -1 : 1));
      const rows = entries.map((r) =>
        r.unregisteredAt !== null ? { ...r.policy, unregisteredAt: r.unregisteredAt } : r.policy,
      );
      return paginate(rows, (p) => p.version, limit, cursor);
    },
    async publish({ policy }) {
      const existing = rowStore.get(policy.id)?.get(policy.version);
      if (existing !== undefined && existing.unregisteredAt === null) {
        return { kind: 'already-registered', policyId: policy.id, version: policy.version };
      }
      const conflict = scopeConflict(policy);
      if (conflict !== undefined) return conflict;
      let versions = rowStore.get(policy.id);
      if (versions === undefined) {
        versions = new Map();
        rowStore.set(policy.id, versions);
      }
      versions.set(policy.version, { policy, unregisteredAt: null });
      return { kind: 'ok', policyId: policy.id, version: policy.version };
    },
    async unregister({ policyId, version }) {
      const versions = rowStore.get(policyId);
      if (versions === undefined) return { unregistered: false };
      const row = versions.get(version);
      if (row === undefined || row.unregisteredAt !== null) {
        return { unregistered: false };
      }
      row.unregisteredAt = new Date().toISOString();
      return { unregistered: true };
    },
    async reinstateVersion({ policyId, version }) {
      const versions = rowStore.get(policyId);
      if (versions === undefined) return { kind: 'not-found', policyId, version };
      const row = versions.get(version);
      if (row === undefined) return { kind: 'not-found', policyId, version };
      const wasTombstoned = row.unregisteredAt !== null;
      if (wasTombstoned) {
        const conflict = scopeConflict(row.policy);
        if (conflict !== undefined) return conflict;
      }
      row.unregisteredAt = null;
      return { kind: 'ok', policyId, version, wasTombstoned };
    },
  };
}

function policySpec(
  overrides: {
    id?: string;
    version?: string;
    kind?: PolicyKind;
    spec?: Record<string, unknown>;
    description?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'acme.model-routing',
    version: overrides.version ?? '1.0.0',
    kind: overrides.kind ?? 'model-routing',
    ...(overrides.description !== undefined && { description: overrides.description }),
    spec:
      overrides.spec ??
      ({
        allow: ['anthropic:claude-opus-4-7'],
        deny: [],
        maxCostPerCallUsd: 1.0,
      } as Record<string, unknown>),
  };
}

function makeApp() {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    policyRegistry: binding,
  });
  return { app, binding };
}

async function seed(binding: PolicyRegistryBinding, body: Record<string, unknown>) {
  const policy: Policy = {
    id: body.id as string,
    tenantId,
    version: body.version as string,
    kind: body.kind as PolicyKind,
    ...(body.description !== undefined && { description: body.description as string }),
    spec: (body.spec ?? {}) as Readonly<Record<string, unknown>>,
  };
  await binding.publish({ tenantId, policy });
}

describe('API — policies list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('kind filter narrows to a single policy kind', async () => {
    const { app, binding } = makeApp();
    await seed(binding, policySpec({ id: 'a.routing', kind: 'model-routing' }));
    await seed(
      binding,
      policySpec({
        id: 'b.access',
        kind: 'access-control',
        spec: { rules: [], defaults: { onNoMatch: 'deny' } },
      }),
    );
    await seed(
      binding,
      policySpec({ id: 'c.retention', kind: 'retention', spec: { ttlDays: 90 } }),
    );

    const res = await app.request('/v1/policies?kind=access-control', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; kind: string }> };
    expect(body.data.map((p) => p.id)).toEqual(['b.access']);
    expect(body.data[0]?.kind).toBe('access-control');
  });

  test('name prefix filter', async () => {
    const { app, binding } = makeApp();
    for (const id of ['acme.routing', 'acme.retention', 'globex.routing']) {
      await seed(binding, policySpec({ id, kind: 'model-routing' }));
    }
    const res = await app.request('/v1/policies?name=acme', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((p) => p.id).sort()).toEqual(['acme.retention', 'acme.routing']);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app, binding } = makeApp();
    for (const id of ['a.1', 'a.2', 'a.3', 'a.4', 'a.5']) {
      await seed(binding, policySpec({ id }));
    }
    const first = await app.request('/v1/policies?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data.map((p) => p.id)).toEqual(['a.1', 'a.2']);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/policies?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const secondBody = (await second.json()) as { data: Array<{ id: string }>; hasMore: boolean };
    expect(secondBody.data.map((p) => p.id)).toEqual(['a.3', 'a.4']);
    expect(secondBody.hasMore).toBe(true);
  });

  test('unknown kind → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies?kind=not-a-real-kind', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });
});

describe('API — policies publish + get', () => {
  test('publish + get roundtrip (model-routing)', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(policySpec()),
    });
    expect(publish.status).toBe(201);
    const published = (await publish.json()) as { policyId: string; version: string };
    expect(published.policyId).toBe('acme.model-routing');
    expect(published.version).toBe('1.0.0');

    const get = await app.request('/v1/policies/acme.model-routing', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      id: string;
      tenantId: string;
      version: string;
      kind: string;
      spec: Record<string, unknown>;
    };
    expect(body.id).toBe('acme.model-routing');
    expect(body.version).toBe('1.0.0');
    expect(body.kind).toBe('model-routing');
    expect(body.tenantId).toBe(tenantId as unknown as string);
    expect(body.spec).toEqual({
      allow: ['anthropic:claude-opus-4-7'],
      deny: [],
      maxCostPerCallUsd: 1.0,
    });
  });

  test.each(['access-control', 'adapter-allowlist', 'rate-limit', 'compliance'] as const)(
    'publish a %s policy, a kind no runtime consumer applies → 400 kind-not-applied, nothing stored',
    async (kind) => {
      const { app } = makeApp();
      const publish = await app.request('/v1/policies', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(policySpec({ id: 'acme.unapplied', kind, spec: {} })),
      });
      expect(publish.status).toBe(400);
      const body = (await publish.json()) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };
      expect(body.error.code).toBe('kind-not-applied');
      expect(body.error.message).toContain(`doesn't apply "${kind}" policies yet`);
      expect(body.error.details).toEqual({
        kind,
        appliedKinds: ['model-routing', 'retention', 'tool-errors', 'hitl'],
      });
      const get = await app.request('/v1/policies/acme.unapplied', {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.status).toBe(404);
    },
  );

  test('validation failure (missing kind) → 400 validation-failed with issues', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'acme.broken',
        version: '1.0.0',
        spec: {},
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues?.some((i) => i.path === 'kind')).toBe(true);
  });

  test('validation failure (unknown kind) → 400 validation-failed', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...policySpec(), kind: 'not-a-real-kind' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation-failed');
  });

  test('validation failure (bad semver) → 400 validation-failed', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...policySpec(), version: 'latest' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues?.some((i) => i.path === 'version')).toBe(true);
  });

  test('validation failure (spec not an object) → 400 validation-failed', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...policySpec(), spec: 'not an object' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues?.some((i) => i.path === 'spec')).toBe(true);
  });

  test("validation failure (spec breaks its kind's contract) → 400, issues pathed under spec", async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        policySpec({
          id: 'acme.approvals',
          kind: 'hitl',
          spec: { maxTimeoutMs: 0, tools: { 'acme.pay': 'sometimes' } },
        }),
      ),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { issues?: Array<{ path: string; message: string }> };
      };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.message).toBe(
      'policy.spec/maxTimeoutMs must be a positive integer (milliseconds)',
    );
    expect(body.error.details?.issues?.map((i) => i.path)).toEqual([
      'spec/maxTimeoutMs',
      'spec/tools/acme.pay',
    ]);
  });

  test("a spec that keeps its kind's contract publishes", async () => {
    const { app } = makeApp();
    const spec = { minReviewerRole: 'senior', tools: { 'acme.pay': 'always_ask' } };
    const res = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(policySpec({ id: 'acme.approvals', kind: 'hitl', spec })),
    });
    expect(res.status).toBe(201);
  });

  test('validation failure (cross-tenant tenantId) → 400 validation-failed', async () => {
    const { app } = makeApp();
    const otherTenant = randomUUID();
    const res = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...policySpec(), tenantId: otherTenant }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues?.some((i) => i.path === 'tenantId')).toBe(true);
  });

  test('non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('publish twice same (id, version) with no idempotency key → 409', async () => {
    const { app } = makeApp();
    const first = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(policySpec()),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/policies', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(policySpec()),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('policy-already-registered');
  });

  test('idempotency-key retry replays original 201', async () => {
    const { app } = makeApp();
    const key = randomUUID();
    const first = await app.request('/v1/policies', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(policySpec()),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/policies', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(policySpec()),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const body = (await second.json()) as { policyId: string; version: string };
    expect(body.policyId).toBe('acme.model-routing');
    expect(body.version).toBe('1.0.0');
  });

  test('unknown policyId → 404 policy-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies/nope.missing', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('policy-not-found');
  });
});

describe('API — policies versions', () => {
  test('list versions returns each semver, sorted asc', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      await seed(binding, policySpec({ version: v }));
    }
    const res = await app.request('/v1/policies/acme.model-routing/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ version: string }> };
    expect(body.data.map((p) => p.version)).toEqual(['1.0.0', '1.1.0', '2.0.0']);
  });

  test('list versions of unknown id → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies/nope/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('list versions defaults to active-only (tombstoned rows hidden)', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      await seed(binding, policySpec({ version: v }));
    }
    await binding.unregister({
      tenantId,
      policyId: 'acme.model-routing',
      version: '1.1.0',
    });
    const res = await app.request('/v1/policies/acme.model-routing/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ version: string; unregisteredAt?: string }>;
    };
    expect(body.data.map((p) => p.version)).toEqual(['1.0.0', '2.0.0']);
    expect(body.data.every((r) => r.unregisteredAt === undefined)).toBe(true);
  });

  test('list versions with ?includeTombstoned=true surfaces tombstoned rows with unregisteredAt', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      await seed(binding, policySpec({ version: v }));
    }
    await binding.unregister({
      tenantId,
      policyId: 'acme.model-routing',
      version: '1.1.0',
    });
    const res = await app.request(
      '/v1/policies/acme.model-routing/versions?includeTombstoned=true',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ version: string; unregisteredAt?: string }>;
    };
    expect(body.data.map((p) => p.version).sort()).toEqual(['1.0.0', '1.1.0', '2.0.0']);
    const tomb = body.data.find((r) => r.version === '1.1.0');
    expect(typeof tomb?.unregisteredAt).toBe('string');
    expect(Number.isFinite(Date.parse(tomb?.unregisteredAt ?? ''))).toBe(true);
    // Active rows still don't carry the field.
    expect(body.data.find((r) => r.version === '1.0.0')?.unregisteredAt).toBeUndefined();
  });

  test('policy-gone state: list versions defaults to [], flag returns tombstoned history', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '2.0.0']) {
      await seed(binding, policySpec({ version: v }));
    }
    await binding.unregister({
      tenantId,
      policyId: 'acme.model-routing',
      version: '1.0.0',
    });
    await binding.unregister({
      tenantId,
      policyId: 'acme.model-routing',
      version: '2.0.0',
    });

    // headExists still returns true → 200 with empty page.
    const defaultRes = await app.request('/v1/policies/acme.model-routing/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as { data: Array<{ version: string }> };
    expect(defaultBody.data).toEqual([]);

    // Flag surfaces both tombstoned rows.
    const fullRes = await app.request(
      '/v1/policies/acme.model-routing/versions?includeTombstoned=true',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(fullRes.status).toBe(200);
    const fullBody = (await fullRes.json()) as {
      data: Array<{ version: string; unregisteredAt?: string }>;
    };
    expect(fullBody.data.map((p) => p.version).sort()).toEqual(['1.0.0', '2.0.0']);
    expect(fullBody.data.every((r) => typeof r.unregisteredAt === 'string')).toBe(true);
  });

  test('get specific version', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '2.0.0']) {
      await seed(binding, policySpec({ version: v }));
    }
    const res = await app.request('/v1/policies/acme.model-routing/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; version: string };
    expect(body.id).toBe('acme.model-routing');
    expect(body.version).toBe('1.0.0');
  });

  test('get unknown version → 404', async () => {
    const { app, binding } = makeApp();
    await seed(binding, policySpec({ version: '1.0.0' }));
    const res = await app.request('/v1/policies/acme.model-routing/versions/9.9.9', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — policies unregister', () => {
  test('unregister known version → 200 unregistered: true', async () => {
    const { app, binding } = makeApp();
    await seed(binding, policySpec({ version: '1.0.0' }));
    const res = await app.request('/v1/policies/acme.model-routing/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      policyId: string;
      version: string;
      unregistered: boolean;
    };
    expect(body.policyId).toBe('acme.model-routing');
    expect(body.version).toBe('1.0.0');
    expect(body.unregistered).toBe(true);

    const get = await app.request('/v1/policies/acme.model-routing/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  test('unregister unknown version → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/policies/nope.missing/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — policies surface unmounted when no binding supplied', () => {
  test('no `policyRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/policies', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — policies: retention specs, one policy per domain (T236)', () => {
  const retention = (id: string, doc: Record<string, unknown>, version = '1.0.0') =>
    policySpec({
      id,
      version,
      kind: 'retention',
      spec: { v: 1, doc: { graceSeconds: 86_400, mode: 'purge', ...doc } },
    });

  async function post(
    app: ReturnType<typeof makeApp>['app'],
    path: string,
    body?: Record<string, unknown>,
  ) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        error?: { code: string; message: string; details?: Record<string, unknown> };
      },
    };
  }

  test('an unknown domain is refused with 400, naming it', async () => {
    const { app } = makeApp();
    const { status, body } = await post(
      app,
      '/v1/policies',
      retention('acme.keep-blocks', { domain: 'blocks' }),
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('validation-failed');
    expect(body.error?.message).toContain('policy.spec/doc/domain must be one of: org, agent,');
    expect(body.error?.message).toContain('(got "blocks")');
  });

  test("mode archive is refused with 400: it isn't implemented", async () => {
    const { app } = makeApp();
    const { status, body } = await post(
      app,
      '/v1/policies',
      retention('acme.archive', { domain: 'run', mode: 'archive' }),
    );
    expect(status).toBe(400);
    expect(body.error?.message).toBe('policy.spec/doc/mode can\'t be "archive" yet: use "purge"');
  });

  test('a second policy for a covered domain is refused with 409, naming the first', async () => {
    const { app } = makeApp();
    expect(
      (await post(app, '/v1/policies', retention('acme.keep-providers', { domain: 'provider' })))
        .status,
    ).toBe(201);
    const { status, body } = await post(
      app,
      '/v1/policies',
      retention('acme.keep-providers-long', { domain: 'provider', graceSeconds: 2_592_000 }),
    );
    expect(status).toBe(409);
    expect(body.error?.code).toBe('policy-scope-taken');
    expect(body.error?.message).toBe(
      'Retention domain "provider" is already covered by policy "acme.keep-providers": a tenant has one retention policy per domain, and one for "*". Publish a new version of "acme.keep-providers" instead, or unregister it first.',
    );
    expect(body.error?.details).toMatchObject({
      policyId: 'acme.keep-providers-long',
      policyKind: 'retention',
      scope: 'provider',
      heldBy: 'acme.keep-providers',
    });
  });

  test('a new version of the policy that covers the domain is fine', async () => {
    const { app } = makeApp();
    await post(app, '/v1/policies', retention('acme.keep-providers', { domain: 'provider' }));
    const { status } = await post(
      app,
      '/v1/policies',
      retention('acme.keep-providers', { domain: 'provider', graceSeconds: 0 }, '1.0.1'),
    );
    expect(status).toBe(201);
  });

  test("a new version can't move a policy to another domain (409 policy-scope-changed)", async () => {
    const { app } = makeApp();
    await post(app, '/v1/policies', retention('acme.keep', { domain: 'tool' }));
    const { status, body } = await post(
      app,
      '/v1/policies',
      retention('acme.keep', { domain: 'agent' }, '2.0.0'),
    );
    expect(status).toBe(409);
    expect(body.error?.code).toBe('policy-scope-changed');
    expect(body.error?.message).toContain('covers retention domain "tool"');
    expect(body.error?.details).toMatchObject({ scope: 'agent', previousScope: 'tool' });
  });

  test('the * default is a scope of its own: one, beside the domain policies', async () => {
    const { app } = makeApp();
    expect(
      (await post(app, '/v1/policies', retention('acme.default', { domain: '*' }))).status,
    ).toBe(201);
    expect(
      (await post(app, '/v1/policies', retention('acme.runs', { domain: 'run' }))).status,
    ).toBe(201);
    const second = await post(app, '/v1/policies', retention('acme.default-2', { domain: '*' }));
    expect(second.status).toBe(409);
    expect(second.body.error?.details).toMatchObject({ scope: '*', heldBy: 'acme.default' });
  });

  test('reinstating a retired policy whose domain another now covers is refused', async () => {
    const { app } = makeApp();
    await post(app, '/v1/policies', retention('acme.a', { domain: 'secret' }));
    await post(app, '/v1/policies/acme.a/versions/1.0.0/unregister');
    expect(
      (await post(app, '/v1/policies', retention('acme.b', { domain: 'secret' }))).status,
    ).toBe(201);
    const { status, body } = await post(app, '/v1/policies/acme.a/versions/1.0.0/reinstate');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('policy-scope-taken');
    expect(body.error?.message).toBe(
      'Retention domain "secret" is now covered by policy "acme.b", so reinstating "acme.a" 1.0.0 would make two: a tenant has one retention policy per domain, and one for "*". Unregister "acme.b" first.',
    );
  });

  test('kinds without a scope keep any number of policies', async () => {
    const { app } = makeApp();
    for (const id of ['acme.hitl-a', 'acme.hitl-b']) {
      const { status } = await post(
        app,
        '/v1/policies',
        policySpec({ id, kind: 'hitl', spec: { minReviewerRole: 'senior' } }),
      );
      expect(status).toBe(201);
    }
  });
});

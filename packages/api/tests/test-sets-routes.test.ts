// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  TestSet,
  TestSetKind,
  TestSetRegistryBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Eval-test set route tests. The registry is caller-plugged;
 * these tests back it with an in-memory `Map`-based adapter — same
 * pattern as `policies-routes.test.ts`. Full versioned CRUD, kind
 * filter, name prefix filter, idempotency-key replay, validation, and
 * unmounted-route 404 behavior.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'test-sets-token-abc';

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

/**
 * Captures the last `projectId` seen by publish so tests can assert
 * threading from the POST route → binding.
 */
let lastPublishedProjectId: ProjectId | undefined;

function makeInMemoryBinding(): TestSetRegistryBinding {
  const store = new Map<string, Map<string, TestSet>>(); // testSetId -> version -> TestSet

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

  function latestVersion(versions: Map<string, TestSet>): TestSet | null {
    const sorted = [...versions.entries()].sort(([a], [b]) =>
      semverKey(a) < semverKey(b) ? 1 : -1,
    );
    const [top] = sorted;
    return top === undefined ? null : top[1];
  }

  return {
    async list({ limit, cursor, evalKind, nameFilter }) {
      const latestPerId: TestSet[] = [];
      for (const [id, versions] of [...store.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (nameFilter !== undefined && !id.startsWith(nameFilter)) continue;
        const latest = latestVersion(versions);
        if (latest === null) continue;
        if (evalKind !== undefined && latest.kind !== evalKind) continue;
        latestPerId.push(latest);
      }
      return paginate(latestPerId, (s) => s.id, limit, cursor);
    },
    async get({ testSetId }) {
      const versions = store.get(testSetId);
      if (versions === undefined) return null;
      return latestVersion(versions);
    },
    async getVersion({ testSetId, version }) {
      const versions = store.get(testSetId);
      if (versions === undefined) return null;
      return versions.get(version) ?? null;
    },
    async headExists({ testSetId }) {
      return store.has(testSetId);
    },
    async listVersions({ testSetId, limit, cursor }) {
      const versions = store.get(testSetId);
      if (versions === undefined) return { data: [] };
      const sorted = [...versions.values()].sort((a, b) =>
        semverKey(a.version) < semverKey(b.version) ? -1 : 1,
      );
      return paginate(sorted, (s) => s.version, limit, cursor);
    },
    async publish({ testSet, projectId }) {
      lastPublishedProjectId = projectId;
      let versions = store.get(testSet.id);
      if (versions === undefined) {
        versions = new Map();
        store.set(testSet.id, versions);
      }
      if (versions.has(testSet.version)) {
        return { kind: 'already-registered', testSetId: testSet.id, version: testSet.version };
      }
      versions.set(testSet.version, testSet);
      return { kind: 'ok', testSetId: testSet.id, version: testSet.version };
    },
    async unregister({ testSetId, version }) {
      const versions = store.get(testSetId);
      if (versions === undefined) return { unregistered: false };
      const removed = versions.delete(version);
      if (versions.size === 0) store.delete(testSetId);
      return { unregistered: removed };
    },
    async reinstateVersion({ testSetId, version }) {
      return { kind: 'not-found', testSetId, version };
    },
  };
}

function testSetSpec(
  overrides: {
    id?: string;
    version?: string;
    kind?: TestSetKind;
    spec?: Record<string, unknown>;
    description?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'acme.drafting-accuracy',
    version: overrides.version ?? '1.0.0',
    kind: overrides.kind ?? 'accuracy',
    ...(overrides.description !== undefined && { description: overrides.description }),
    spec:
      overrides.spec ??
      ({
        cases: [
          {
            input: 'draft a contract clause about NDA scope',
            expectedOutput: 'clause covering scope, term, remedies',
          },
          { input: 'summarize deposition in 200 words', expectedOutput: '200-word summary' },
        ],
        grader: { adapterId: 'eval-judge-ajv' },
      } as Record<string, unknown>),
  };
}

/**
 * Build a POST /v1/test-sets body. `projectId` is REQUIRED (content-scope
 * anchor) — the fixture supplies a stable uuid by default
 * so happy-path tests read cleanly.
 */
function testSetPostBody(
  overrides: {
    id?: string;
    version?: string;
    kind?: TestSetKind;
    spec?: Record<string, unknown>;
    description?: string;
    projectId?: string;
  } = {},
): Record<string, unknown> {
  const { projectId, ...specOverrides } = overrides;
  return {
    ...testSetSpec(specOverrides),
    projectId: projectId ?? randomUUID(),
  };
}

function makeApp() {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    testSetRegistry: binding,
  });
  return { app, binding };
}

async function seed(binding: TestSetRegistryBinding, body: Record<string, unknown>) {
  const testSet: TestSet = {
    id: body.id as string,
    tenantId,
    version: body.version as string,
    kind: body.kind as TestSetKind,
    ...(body.description !== undefined && { description: body.description as string }),
    spec: (body.spec ?? {}) as Readonly<Record<string, unknown>>,
  };
  await binding.publish({
    tenantId,
    projectId: randomUUID() as ProjectId,
    testSet,
    enqueueTuples: () => [],
  });
}

describe('API — test-sets list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-sets', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('kind filter narrows to a single eval kind', async () => {
    const { app, binding } = makeApp();
    await seed(binding, testSetSpec({ id: 'a.accuracy', kind: 'accuracy' }));
    await seed(
      binding,
      testSetSpec({
        id: 'b.pairwise',
        kind: 'pairwise',
        spec: {
          prompts: ['hello'],
          variantA: { agentId: 'agent-a', version: '1.0.0' },
          variantB: { agentId: 'agent-b', version: '1.0.0' },
        },
      }),
    );
    await seed(
      binding,
      testSetSpec({
        id: 'c.human-review',
        kind: 'human-review',
        spec: { rubric: ['clarity', 'accuracy'], reviewerRole: 'reviewer:senior' },
      }),
    );

    const res = await app.request('/v1/test-sets?kind=pairwise', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; kind: string }> };
    expect(body.data.map((s) => s.id)).toEqual(['b.pairwise']);
    expect(body.data[0]?.kind).toBe('pairwise');
  });

  test('name prefix filter', async () => {
    const { app, binding } = makeApp();
    for (const id of ['acme.accuracy', 'acme.regression', 'globex.accuracy']) {
      await seed(binding, testSetSpec({ id, kind: 'accuracy' }));
    }
    const res = await app.request('/v1/test-sets?name=acme', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((s) => s.id).sort()).toEqual(['acme.accuracy', 'acme.regression']);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app, binding } = makeApp();
    for (const id of ['a.1', 'a.2', 'a.3', 'a.4', 'a.5']) {
      await seed(binding, testSetSpec({ id }));
    }
    const first = await app.request('/v1/test-sets?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data.map((s) => s.id)).toEqual(['a.1', 'a.2']);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/test-sets?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const secondBody = (await second.json()) as { data: Array<{ id: string }>; hasMore: boolean };
    expect(secondBody.data.map((s) => s.id)).toEqual(['a.3', 'a.4']);
    expect(secondBody.hasMore).toBe(true);
  });

  test('unknown kind → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-sets?kind=not-a-real-kind', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });
});

describe('API — test-sets publish + get', () => {
  test('publish + get roundtrip (accuracy)', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(testSetPostBody()),
    });
    expect(publish.status).toBe(201);
    const published = (await publish.json()) as { testSetId: string; version: string };
    expect(published.testSetId).toBe('acme.drafting-accuracy');
    expect(published.version).toBe('1.0.0');

    const get = await app.request('/v1/test-sets/acme.drafting-accuracy', {
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
    expect(body.id).toBe('acme.drafting-accuracy');
    expect(body.version).toBe('1.0.0');
    expect(body.kind).toBe('accuracy');
    expect(body.tenantId).toBe(tenantId as unknown as string);
    expect(body.spec).toEqual({
      cases: [
        {
          input: 'draft a contract clause about NDA scope',
          expectedOutput: 'clause covering scope, term, remedies',
        },
        { input: 'summarize deposition in 200 words', expectedOutput: '200-word summary' },
      ],
      grader: { adapterId: 'eval-judge-ajv' },
    });
  });

  test('publish human-review test set carries rubric through spec verbatim', async () => {
    const { app } = makeApp();
    const rubric = [
      { id: 'clarity', description: 'Is the answer clear?', weight: 0.5 },
      { id: 'accuracy', description: 'Is the answer factually correct?', weight: 0.5 },
    ];
    const publish = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        testSetPostBody({
          id: 'acme.human-review',
          kind: 'human-review',
          spec: { rubric, reviewerRole: 'reviewer:senior' },
        }),
      ),
    });
    expect(publish.status).toBe(201);

    const get = await app.request('/v1/test-sets/acme.human-review', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      spec: { rubric: unknown[]; reviewerRole: string };
    };
    expect(body.spec.rubric).toEqual(rubric);
    expect(body.spec.reviewerRole).toBe('reviewer:senior');
  });

  test('validation failure (missing kind) → 400 validation-failed with issues', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: randomUUID(),
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
    const res = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...testSetPostBody(), kind: 'not-a-real-kind' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation-failed');
  });

  test('validation failure (bad semver) → 400 validation-failed', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...testSetPostBody(), version: 'latest' }),
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
    const res = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...testSetPostBody(), spec: 'not an object' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues?.some((i) => i.path === 'spec')).toBe(true);
  });

  test('validation failure (cross-tenant tenantId) → 400 validation-failed', async () => {
    const { app } = makeApp();
    const otherTenant = randomUUID();
    const res = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...testSetPostBody(), tenantId: otherTenant }),
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
    const res = await app.request('/v1/test-sets', {
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
    // No idempotency-key header — both bodies use fresh projectIds and
    // still collide because the id+version is what makes them dupes.
    const first = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(testSetPostBody()),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(testSetPostBody()),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('test-set-already-registered');
  });

  test('idempotency-key retry replays original 201', async () => {
    const { app } = makeApp();
    const key = randomUUID();
    // Stable projectId across both POSTs — the idempotency middleware
    // hashes the body and rejects a replay with a different body as
    // `idempotency-key-body-mismatch`.
    const stableBody = testSetPostBody({ projectId: randomUUID() });
    const first = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableBody),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableBody),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const body = (await second.json()) as { testSetId: string; version: string };
    expect(body.testSetId).toBe('acme.drafting-accuracy');
    expect(body.version).toBe('1.0.0');
  });

  test('unknown testSetId → 404 test-set-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-sets/nope.missing', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('test-set-not-found');
  });

  // ------------------ projectId on POST ------------------

  test('POST /v1/test-sets threads projectId to the binding', async () => {
    const { app } = makeApp();
    lastPublishedProjectId = undefined;
    const projectId = randomUUID();
    const res = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(testSetPostBody({ projectId })),
    });
    expect(res.status).toBe(201);
    expect(lastPublishedProjectId as unknown as string).toBe(projectId);
  });

  test('POST /v1/test-sets without projectId → 400 bad-input', async () => {
    const { app } = makeApp();
    // Build a body without projectId (the testSetPostBody fixture always adds one).
    const { projectId: _pid, ...bodyWithoutProjectId } = testSetPostBody();
    const res = await app.request('/v1/test-sets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(bodyWithoutProjectId),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toContain('projectId');
  });
});

describe('API — test-sets versions', () => {
  test('list versions returns each semver, sorted asc', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      await seed(binding, testSetSpec({ version: v }));
    }
    const res = await app.request('/v1/test-sets/acme.drafting-accuracy/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ version: string }> };
    expect(body.data.map((s) => s.version)).toEqual(['1.0.0', '1.1.0', '2.0.0']);
  });

  test('list versions of unknown id → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-sets/nope/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('get specific version', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '2.0.0']) {
      await seed(binding, testSetSpec({ version: v }));
    }
    const res = await app.request('/v1/test-sets/acme.drafting-accuracy/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; version: string };
    expect(body.id).toBe('acme.drafting-accuracy');
    expect(body.version).toBe('1.0.0');
  });

  test('get unknown version → 404', async () => {
    const { app, binding } = makeApp();
    await seed(binding, testSetSpec({ version: '1.0.0' }));
    const res = await app.request('/v1/test-sets/acme.drafting-accuracy/versions/9.9.9', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — test-sets unregister', () => {
  test('unregister known version → 200 unregistered: true', async () => {
    const { app, binding } = makeApp();
    await seed(binding, testSetSpec({ version: '1.0.0' }));
    const res = await app.request(
      '/v1/test-sets/acme.drafting-accuracy/versions/1.0.0/unregister',
      { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      testSetId: string;
      version: string;
      unregistered: boolean;
    };
    expect(body.testSetId).toBe('acme.drafting-accuracy');
    expect(body.version).toBe('1.0.0');
    expect(body.unregistered).toBe(true);

    const get = await app.request('/v1/test-sets/acme.drafting-accuracy/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  test('unregister unknown version → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-sets/nope.missing/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — test-sets surface unmounted when no binding supplied', () => {
  test('no `testSetRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/test-sets', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — test-sets scope filter', () => {
  function makeSpy() {
    const inner = makeInMemoryBinding();
    let lastListInput: Parameters<TestSetRegistryBinding['list']>[0] | null = null;
    const spy: TestSetRegistryBinding = {
      ...inner,
      async list(input) {
        lastListInput = input;
        return inner.list(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      testSetRegistry: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/test-sets?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/test-sets?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/test-sets', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/test-sets?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});

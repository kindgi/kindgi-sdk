// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  EvalKind,
  EvalSuite,
  EvalSuiteRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Eval-suite route tests. The registry is caller-plugged;
 * these tests back it with an in-memory `Map`-based adapter — same
 * pattern as `policies-routes.test.ts`. Full versioned CRUD, kind
 * filter, name prefix filter, idempotency-key replay, validation, and
 * unmounted-route 404 behavior.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'eval-suites-token-abc';

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

function makeInMemoryBinding(): EvalSuiteRegistryBinding {
  const store = new Map<string, Map<string, EvalSuite>>(); // suiteId -> version -> EvalSuite

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

  function latestVersion(versions: Map<string, EvalSuite>): EvalSuite | null {
    const sorted = [...versions.entries()].sort(([a], [b]) =>
      semverKey(a) < semverKey(b) ? 1 : -1,
    );
    const [top] = sorted;
    return top === undefined ? null : top[1];
  }

  return {
    async list({ limit, cursor, evalKind, nameFilter }) {
      const latestPerId: EvalSuite[] = [];
      for (const [id, versions] of [...store.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (nameFilter !== undefined && !id.startsWith(nameFilter)) continue;
        const latest = latestVersion(versions);
        if (latest === null) continue;
        if (evalKind !== undefined && latest.kind !== evalKind) continue;
        latestPerId.push(latest);
      }
      return paginate(latestPerId, (s) => s.id, limit, cursor);
    },
    async get({ suiteId }) {
      const versions = store.get(suiteId);
      if (versions === undefined) return null;
      return latestVersion(versions);
    },
    async getVersion({ suiteId, version }) {
      const versions = store.get(suiteId);
      if (versions === undefined) return null;
      return versions.get(version) ?? null;
    },
    async headExists({ suiteId }) {
      return store.has(suiteId);
    },
    async listVersions({ suiteId, limit, cursor }) {
      const versions = store.get(suiteId);
      if (versions === undefined) return { data: [] };
      const sorted = [...versions.values()].sort((a, b) =>
        semverKey(a.version) < semverKey(b.version) ? -1 : 1,
      );
      return paginate(sorted, (s) => s.version, limit, cursor);
    },
    async publish({ suite, projectId }) {
      lastPublishedProjectId = projectId;
      let versions = store.get(suite.id);
      if (versions === undefined) {
        versions = new Map();
        store.set(suite.id, versions);
      }
      if (versions.has(suite.version)) {
        return { kind: 'already-registered', suiteId: suite.id, version: suite.version };
      }
      versions.set(suite.version, suite);
      return { kind: 'ok', suiteId: suite.id, version: suite.version };
    },
    async unregister({ suiteId, version }) {
      const versions = store.get(suiteId);
      if (versions === undefined) return { unregistered: false };
      const removed = versions.delete(version);
      if (versions.size === 0) store.delete(suiteId);
      return { unregistered: removed };
    },
    async reinstateVersion({ suiteId, version }) {
      return { kind: 'not-found', suiteId, version };
    },
  };
}

function evalSuiteSpec(
  overrides: {
    id?: string;
    version?: string;
    kind?: EvalKind;
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
 * Build a POST /v1/eval-suites body. `projectId` is REQUIRED (content-scope
 * anchor) — the fixture supplies a stable uuid by default
 * so happy-path tests read cleanly.
 */
function evalSuitePostBody(
  overrides: {
    id?: string;
    version?: string;
    kind?: EvalKind;
    spec?: Record<string, unknown>;
    description?: string;
    projectId?: string;
  } = {},
): Record<string, unknown> {
  const { projectId, ...specOverrides } = overrides;
  return {
    ...evalSuiteSpec(specOverrides),
    projectId: projectId ?? randomUUID(),
  };
}

function makeApp() {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    evalSuiteRegistry: binding,
  });
  return { app, binding };
}

async function seed(binding: EvalSuiteRegistryBinding, body: Record<string, unknown>) {
  const suite: EvalSuite = {
    id: body.id as string,
    tenantId,
    version: body.version as string,
    kind: body.kind as EvalKind,
    ...(body.description !== undefined && { description: body.description as string }),
    spec: (body.spec ?? {}) as Readonly<Record<string, unknown>>,
  };
  await binding.publish({
    tenantId,
    projectId: randomUUID() as ProjectId,
    suite,
    enqueueTuples: () => [],
  });
}

describe('API — eval-suites list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-suites', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('kind filter narrows to a single eval kind', async () => {
    const { app, binding } = makeApp();
    await seed(binding, evalSuiteSpec({ id: 'a.accuracy', kind: 'accuracy' }));
    await seed(
      binding,
      evalSuiteSpec({
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
      evalSuiteSpec({
        id: 'c.human-review',
        kind: 'human-review',
        spec: { rubric: ['clarity', 'accuracy'], reviewerRole: 'reviewer:senior' },
      }),
    );

    const res = await app.request('/v1/eval-suites?kind=pairwise', {
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
      await seed(binding, evalSuiteSpec({ id, kind: 'accuracy' }));
    }
    const res = await app.request('/v1/eval-suites?name=acme', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((s) => s.id).sort()).toEqual(['acme.accuracy', 'acme.regression']);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app, binding } = makeApp();
    for (const id of ['a.1', 'a.2', 'a.3', 'a.4', 'a.5']) {
      await seed(binding, evalSuiteSpec({ id }));
    }
    const first = await app.request('/v1/eval-suites?limit=2', {
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
      `/v1/eval-suites?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const secondBody = (await second.json()) as { data: Array<{ id: string }>; hasMore: boolean };
    expect(secondBody.data.map((s) => s.id)).toEqual(['a.3', 'a.4']);
    expect(secondBody.hasMore).toBe(true);
  });

  test('unknown kind → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-suites?kind=not-a-real-kind', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });
});

describe('API — eval-suites publish + get', () => {
  test('publish + get roundtrip (accuracy)', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(evalSuitePostBody()),
    });
    expect(publish.status).toBe(201);
    const published = (await publish.json()) as { suiteId: string; version: string };
    expect(published.suiteId).toBe('acme.drafting-accuracy');
    expect(published.version).toBe('1.0.0');

    const get = await app.request('/v1/eval-suites/acme.drafting-accuracy', {
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

  test('publish human-review suite carries rubric through spec verbatim', async () => {
    const { app } = makeApp();
    const rubric = [
      { id: 'clarity', description: 'Is the answer clear?', weight: 0.5 },
      { id: 'accuracy', description: 'Is the answer factually correct?', weight: 0.5 },
    ];
    const publish = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        evalSuitePostBody({
          id: 'acme.human-review',
          kind: 'human-review',
          spec: { rubric, reviewerRole: 'reviewer:senior' },
        }),
      ),
    });
    expect(publish.status).toBe(201);

    const get = await app.request('/v1/eval-suites/acme.human-review', {
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
    const res = await app.request('/v1/eval-suites', {
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
    const res = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...evalSuitePostBody(), kind: 'not-a-real-kind' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation-failed');
  });

  test('validation failure (bad semver) → 400 validation-failed', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...evalSuitePostBody(), version: 'latest' }),
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
    const res = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...evalSuitePostBody(), spec: 'not an object' }),
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
    const res = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...evalSuitePostBody(), tenantId: otherTenant }),
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
    const res = await app.request('/v1/eval-suites', {
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
    const first = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(evalSuitePostBody()),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(evalSuitePostBody()),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('eval-suite-already-registered');
  });

  test('idempotency-key retry replays original 201', async () => {
    const { app } = makeApp();
    const key = randomUUID();
    // Stable projectId across both POSTs — the idempotency middleware
    // hashes the body and rejects a replay with a different body as
    // `idempotency-key-body-mismatch`.
    const stableBody = evalSuitePostBody({ projectId: randomUUID() });
    const first = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableBody),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/eval-suites', {
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
    const body = (await second.json()) as { suiteId: string; version: string };
    expect(body.suiteId).toBe('acme.drafting-accuracy');
    expect(body.version).toBe('1.0.0');
  });

  test('unknown suiteId → 404 eval-suite-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-suites/nope.missing', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('eval-suite-not-found');
  });

  // ------------------ projectId on POST ------------------

  test('POST /v1/eval-suites threads projectId to the binding', async () => {
    const { app } = makeApp();
    lastPublishedProjectId = undefined;
    const projectId = randomUUID();
    const res = await app.request('/v1/eval-suites', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(evalSuitePostBody({ projectId })),
    });
    expect(res.status).toBe(201);
    expect(lastPublishedProjectId as unknown as string).toBe(projectId);
  });

  test('POST /v1/eval-suites without projectId → 400 bad-input', async () => {
    const { app } = makeApp();
    // Build a body without projectId (the evalSuitePostBody fixture always adds one).
    const { projectId: _pid, ...bodyWithoutProjectId } = evalSuitePostBody();
    const res = await app.request('/v1/eval-suites', {
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

describe('API — eval-suites versions', () => {
  test('list versions returns each semver, sorted asc', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      await seed(binding, evalSuiteSpec({ version: v }));
    }
    const res = await app.request('/v1/eval-suites/acme.drafting-accuracy/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ version: string }> };
    expect(body.data.map((s) => s.version)).toEqual(['1.0.0', '1.1.0', '2.0.0']);
  });

  test('list versions of unknown id → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-suites/nope/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('get specific version', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '2.0.0']) {
      await seed(binding, evalSuiteSpec({ version: v }));
    }
    const res = await app.request('/v1/eval-suites/acme.drafting-accuracy/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; version: string };
    expect(body.id).toBe('acme.drafting-accuracy');
    expect(body.version).toBe('1.0.0');
  });

  test('get unknown version → 404', async () => {
    const { app, binding } = makeApp();
    await seed(binding, evalSuiteSpec({ version: '1.0.0' }));
    const res = await app.request('/v1/eval-suites/acme.drafting-accuracy/versions/9.9.9', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — eval-suites unregister', () => {
  test('unregister known version → 200 unregistered: true', async () => {
    const { app, binding } = makeApp();
    await seed(binding, evalSuiteSpec({ version: '1.0.0' }));
    const res = await app.request(
      '/v1/eval-suites/acme.drafting-accuracy/versions/1.0.0/unregister',
      { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suiteId: string;
      version: string;
      unregistered: boolean;
    };
    expect(body.suiteId).toBe('acme.drafting-accuracy');
    expect(body.version).toBe('1.0.0');
    expect(body.unregistered).toBe(true);

    const get = await app.request('/v1/eval-suites/acme.drafting-accuracy/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  test('unregister unknown version → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-suites/nope.missing/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — eval-suites surface unmounted when no binding supplied', () => {
  test('no `evalSuiteRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/eval-suites', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — eval-suites scope filter', () => {
  function makeSpy() {
    const inner = makeInMemoryBinding();
    let lastListInput: Parameters<EvalSuiteRegistryBinding['list']>[0] | null = null;
    const spy: EvalSuiteRegistryBinding = {
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
      evalSuiteRegistry: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/eval-suites?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/eval-suites?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/eval-suites', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/eval-suites?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});

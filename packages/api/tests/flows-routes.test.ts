// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Flow } from '@kindgi/flow';
import type { Cursor, FlowId, ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { FlowRegistryBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * Flows route tests. Mirrors the agents-routes suite
 * 1:1 — same shape, same assertions, translated for the flows
 * resource. `FlowRegistryBinding` is caller-plugged, so these tests
 * back it with an in-memory `Map`-based adapter. No DB access.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'flows-token-abc';

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
 * In-memory `Map`-backed `FlowRegistryBinding`. Stores `(flowId,
 * version) → Flow` pairs. Cursor is the last `id@version` string of
 * the returned page. Captures the last `projectId` seen by publish so
 * tests can assert threading from the POST route → binding.
 */
let lastPublishedProjectId: ProjectId | undefined;

function makeInMemoryBinding(): FlowRegistryBinding {
  const store = new Map<string, Map<string, Flow>>(); // flowId -> version -> Flow

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
    // Left-pad numeric segments to sort correctly (lexicographic).
    // Handles simple `X.Y.Z` semvers used in tests. Anything more
    // exotic sorts by the raw string — good enough for the test
    // registry.
    const parts = v.split('.');
    return parts.map((p) => p.padStart(6, '0')).join('.');
  }

  function latestVersion(versions: Map<string, Flow>): Flow | null {
    const sorted = [...versions.entries()].sort(([a], [b]) =>
      semverKey(a) < semverKey(b) ? 1 : -1,
    );
    const [top] = sorted;
    return top === undefined ? null : top[1];
  }

  return {
    async list({ limit, cursor, nameFilter }) {
      const latestPerId: Flow[] = [];
      for (const [id, versions] of [...store.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (nameFilter !== undefined && !id.startsWith(nameFilter)) continue;
        const latest = latestVersion(versions);
        if (latest !== null) latestPerId.push(latest);
      }
      return paginate(latestPerId, (g) => g.id as unknown as string, limit, cursor);
    },
    async get({ flowId }) {
      const versions = store.get(flowId as unknown as string);
      if (versions === undefined) return null;
      return latestVersion(versions);
    },
    async getVersion({ flowId, version }) {
      const versions = store.get(flowId as unknown as string);
      if (versions === undefined) return null;
      return versions.get(version) ?? null;
    },
    async headExists({ flowId }) {
      return store.has(flowId as unknown as string);
    },
    async listVersions({ flowId, limit, cursor }) {
      const versions = store.get(flowId as unknown as string);
      if (versions === undefined) return { data: [] };
      const sorted = [...versions.values()].sort((a, b) =>
        semverKey(a.version) < semverKey(b.version) ? -1 : 1,
      );
      return paginate(sorted, (g) => g.version, limit, cursor);
    },
    async publish({ flow, projectId }) {
      lastPublishedProjectId = projectId;
      const idStr = flow.id as unknown as string;
      let versions = store.get(idStr);
      if (versions === undefined) {
        versions = new Map();
        store.set(idStr, versions);
      }
      if (versions.has(flow.version)) {
        return { kind: 'already-registered', flowId: flow.id, version: flow.version };
      }
      versions.set(flow.version, flow);
      return { kind: 'ok', flowId: flow.id, version: flow.version };
    },
    async unregister({ flowId, version }) {
      const idStr = flowId as unknown as string;
      const versions = store.get(idStr);
      if (versions === undefined) return { unregistered: false };
      const removed = versions.delete(version);
      if (versions.size === 0) store.delete(idStr);
      return { unregistered: removed };
    },
    async reinstateVersion({ flowId, version }) {
      return { kind: 'not-found', flowId, version };
    },
  };
}

function flowSpec(overrides: { id?: string; version?: string } = {}): Flow {
  return {
    id: (overrides.id ?? 'ingest.contract-pdf') as FlowId,
    version: overrides.version ?? '1.0.0',
    nodes: [
      { id: 'extract', kind: 'tool', ref: 'inline' },
      { id: 'classify', kind: 'tool', ref: 'inline' },
      { id: 'store', kind: 'tool', ref: 'inline' },
    ],
    edges: [
      { id: 'e0' as never, from: '$start', to: 'extract' as never },
      { id: 'e1' as never, from: 'extract' as never, to: 'classify' as never },
      { id: 'e2' as never, from: 'classify' as never, to: 'store' as never },
      { id: 'e3' as never, from: 'store' as never, to: '$end' },
    ],
  } as unknown as Flow;
}

/**
 * Build a POST /v1/flows body. `projectId` is REQUIRED (content-scope
 * anchor) — the fixture supplies a stable uuid by default
 * so happy-path tests read cleanly.
 */
function flowPostBody(
  overrides: {
    id?: string;
    version?: string;
    projectId?: string;
  } = {},
): Record<string, unknown> {
  return {
    ...(flowSpec({
      ...(overrides.id !== undefined && { id: overrides.id }),
      ...(overrides.version !== undefined && { version: overrides.version }),
    }) as unknown as Record<string, unknown>),
    projectId: overrides.projectId ?? randomUUID(),
  };
}

/**
 * Flow carrying a `foreach` loop node — proves `loadFlow` is doing
 * real work at the wire, not just JSON-shape checks. If the wire
 * accepts this and rejects a bad loop, the loader is running.
 */
function loopyFlowSpec(): Flow {
  return {
    id: 'ingest.batch-retrieve' as FlowId,
    version: '1.0.0',
    nodes: [
      {
        id: 'batch-retrieve',
        kind: 'loop',
        loopKind: 'foreach',
        iterateOver: { path: 'runInput.items' },
        maxIterations: 100,
        outputSchema: { type: 'object' },
        body: {
          nodes: [{ id: 'retrieve-one', kind: 'tool', ref: 'inline' }],
          edges: [
            { id: 'body-e0' as never, from: '$loop-start', to: 'retrieve-one' as never },
            { id: 'body-e1' as never, from: 'retrieve-one' as never, to: '$loop-end' },
          ],
        },
      },
    ],
    edges: [
      { id: 'e0' as never, from: '$start', to: 'batch-retrieve' as never },
      { id: 'e1' as never, from: 'batch-retrieve' as never, to: '$end' },
    ],
  } as unknown as Flow;
}

function makeApp() {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    flowRegistry: binding,
  });
  return { app, binding };
}

describe('API — flows list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/flows', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('prefix name filter', async () => {
    const { app, binding } = makeApp();
    for (const id of ['ingest.a', 'ingest.b', 'export.c']) {
      await binding.publish({
        tenantId,
        projectId: randomUUID() as ProjectId,
        flow: flowSpec({ id }),
        enqueueTuples: () => [],
      });
    }
    const res = await app.request('/v1/flows?name=ingest', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((g) => g.id).sort();
    expect(ids).toEqual(['ingest.a', 'ingest.b']);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app, binding } = makeApp();
    for (const id of ['a.1', 'a.2', 'a.3', 'a.4', 'a.5']) {
      await binding.publish({
        tenantId,
        projectId: randomUUID() as ProjectId,
        flow: flowSpec({ id }),
        enqueueTuples: () => [],
      });
    }
    const first = await app.request('/v1/flows?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data.map((g) => g.id)).toEqual(['a.1', 'a.2']);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/flows?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const secondBody = (await second.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(secondBody.data.map((g) => g.id)).toEqual(['a.3', 'a.4']);
    expect(secondBody.hasMore).toBe(true);
  });
});

describe('API — flows get', () => {
  test('publish + get roundtrip', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/flows', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(flowPostBody()),
    });
    expect(publish.status).toBe(201);
    const published = (await publish.json()) as { flowId: string; version: string };
    expect(published.flowId).toBe('ingest.contract-pdf');
    expect(published.version).toBe('1.0.0');

    const get = await app.request('/v1/flows/ingest.contract-pdf', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      id: string;
      version: string;
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string }>;
    };
    expect(body.id).toBe('ingest.contract-pdf');
    expect(body.version).toBe('1.0.0');
    expect(body.nodes.map((n) => n.id)).toEqual(['extract', 'classify', 'store']);
    expect(body.edges).toHaveLength(4);
  });

  test('publish + get roundtrip for a flow with a foreach loop node', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/flows', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(loopyFlowSpec() as unknown as Record<string, unknown>),
        projectId: randomUUID(),
      }),
    });
    expect(publish.status).toBe(201);
    const get = await app.request('/v1/flows/ingest.batch-retrieve', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      nodes: Array<{ id: string; kind: string; loopKind?: string }>;
    };
    expect(body.nodes[0]?.kind).toBe('loop');
    expect(body.nodes[0]?.loopKind).toBe('foreach');
  });

  test('unknown id → 404 flow-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/flows/nope.missing', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('flow-not-found');
  });
});

describe('API — flows publish', () => {
  test('validation failure → 400 validation-failed with issues', async () => {
    const { app } = makeApp();
    // A flow with a cycle: `a → b → a`. Loader will surface
    // `cycle-detected`; the route flattens it to
    // `validation-failed` + issues.
    const res = await app.request('/v1/flows', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: randomUUID(),
        id: 'bad.cycle',
        version: '1.0.0',
        nodes: [
          { id: 'a', kind: 'tool', ref: 'inline' },
          { id: 'b', kind: 'tool', ref: 'inline' },
        ],
        edges: [
          { id: 'e0', from: '$start', to: 'a' },
          { id: 'e1', from: 'a', to: 'b' },
          { id: 'e2', from: 'b', to: 'a' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: unknown[] } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues).toBeTruthy();
  });

  test('non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/flows', {
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
    const first = await app.request('/v1/flows', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(flowPostBody()),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/flows', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(flowPostBody()),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('flow-already-registered');
  });

  // ------------------ projectId on POST ------------------

  test('POST /v1/flows threads projectId to the binding', async () => {
    const { app } = makeApp();
    lastPublishedProjectId = undefined;
    const projectId = randomUUID();
    const res = await app.request('/v1/flows', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(flowPostBody({ projectId })),
    });
    expect(res.status).toBe(201);
    expect(lastPublishedProjectId as unknown as string).toBe(projectId);
  });

  test('POST /v1/flows without projectId → 400 bad-input', async () => {
    const { app } = makeApp();
    // Build a body without projectId (the flowPostBody fixture always adds one).
    const { projectId: _pid, ...bodyWithoutProjectId } = flowPostBody();
    const res = await app.request('/v1/flows', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(bodyWithoutProjectId),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toContain('projectId');
  });

  test('idempotency-key retry replays original 201 response', async () => {
    const { app } = makeApp();
    const key = randomUUID();
    // Stable projectId across both POSTs — the idempotency middleware
    // hashes the body and rejects a replay with a different body as
    // `idempotency-key-body-mismatch`.
    const stableBody = flowPostBody({ projectId: randomUUID() });
    const first = await app.request('/v1/flows', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableBody),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/flows', {
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
    const body = (await second.json()) as { flowId: string; version: string };
    expect(body.flowId).toBe('ingest.contract-pdf');
    expect(body.version).toBe('1.0.0');
  });
});

describe('API — flows versions', () => {
  test('list versions returns each semver, sorted asc', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      await binding.publish({
        tenantId,
        projectId: randomUUID() as ProjectId,
        flow: flowSpec({ version: v }),
        enqueueTuples: () => [],
      });
    }
    const res = await app.request('/v1/flows/ingest.contract-pdf/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ version: string }> };
    expect(body.data.map((g) => g.version)).toEqual(['1.0.0', '1.1.0', '2.0.0']);
  });

  test('list versions of unknown id → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/flows/nope/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('get specific version', async () => {
    const { app, binding } = makeApp();
    for (const v of ['1.0.0', '2.0.0']) {
      await binding.publish({
        tenantId,
        projectId: randomUUID() as ProjectId,
        flow: flowSpec({ version: v }),
        enqueueTuples: () => [],
      });
    }
    const res = await app.request('/v1/flows/ingest.contract-pdf/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; version: string };
    expect(body.id).toBe('ingest.contract-pdf');
    expect(body.version).toBe('1.0.0');
  });

  test('get unknown version → 404', async () => {
    const { app, binding } = makeApp();
    await binding.publish({
      tenantId,
      projectId: randomUUID() as ProjectId,
      flow: flowSpec({ version: '1.0.0' }),
      enqueueTuples: () => [],
    });
    const res = await app.request('/v1/flows/ingest.contract-pdf/versions/9.9.9', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — flows unregister', () => {
  test('unregister known version → 200 unregistered: true', async () => {
    const { app, binding } = makeApp();
    await binding.publish({
      tenantId,
      projectId: randomUUID() as ProjectId,
      flow: flowSpec({ version: '1.0.0' }),
      enqueueTuples: () => [],
    });
    const res = await app.request('/v1/flows/ingest.contract-pdf/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      flowId: string;
      version: string;
      unregistered: boolean;
    };
    expect(body.flowId).toBe('ingest.contract-pdf');
    expect(body.version).toBe('1.0.0');
    expect(body.unregistered).toBe(true);

    // Post-unregister get → 404.
    const get = await app.request('/v1/flows/ingest.contract-pdf/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  test('unregister unknown version → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/flows/nope.missing/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — flows surface unmounted when no binding supplied', () => {
  test('no `flowRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/flows', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — flows scope filter', () => {
  function makeSpy() {
    const inner = makeInMemoryBinding();
    let lastListInput: Parameters<FlowRegistryBinding['list']>[0] | null = null;
    const spy: FlowRegistryBinding = {
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
      flowRegistry: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/flows?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/flows?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/flows', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
    expect(getLastInput()?.inherit).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/flows?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});

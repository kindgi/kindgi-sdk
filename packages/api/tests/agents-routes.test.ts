// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AgentRegistry } from '@kindgi/agents';
import { createAgentRegistry, defineAgent } from '@kindgi/agents';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { AgentRegistryBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';
import { inMemoryMemory } from './support/in-memory-memory.js';

/**
 * Agents route tests.
 *
 * The `AgentRegistryBinding` is caller-plugged, so these tests use the
 * built-in in-memory `@kindgi/agents.AgentRegistry` wrapped inside a
 * small adapter. No DB access — the routes only talk to the binding.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'agents-token-abc';

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
 * Wraps `createAgentRegistry()` behind the caller-plugged binding
 * shape. Uses `id@version` compound cursors — opaque to the client.
 * The mock captures the last `projectId` seen by publish so tests can
 * assert threading from the POST route → binding.
 */
let lastPublishedProjectId: ProjectId | undefined;

function bindingFromRegistry(registry: AgentRegistry): AgentRegistryBinding {
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
  return {
    async list({ limit, cursor, nameFilter }) {
      const seenIds = new Set<string>();
      const latestPerId = [] as ReturnType<typeof registry.list>[number][];
      for (const a of [...registry.list()].sort((x, y) => x.id.localeCompare(y.id))) {
        if (seenIds.has(a.id as unknown as string)) continue;
        const latest = registry.getLatest(a.id);
        if (latest.kind === 'ok') {
          seenIds.add(a.id as unknown as string);
          latestPerId.push(latest.value);
        }
      }
      const filtered =
        nameFilter === undefined
          ? latestPerId
          : latestPerId.filter((a) => (a.id as unknown as string).startsWith(nameFilter));
      return paginate(filtered, (a) => a.id as unknown as string, limit, cursor);
    },
    async get({ agentId }) {
      const got = registry.getLatest(agentId);
      return got.kind === 'ok' ? got.value : null;
    },
    async getVersion({ agentId, version }) {
      const got = registry.get(agentId, version as unknown as string);
      return got.kind === 'ok' ? got.value : null;
    },
    async headExists({ agentId }) {
      return registry.getLatest(agentId).kind === 'ok' || registry.listVersions(agentId).length > 0;
    },
    async listVersions({ agentId, limit, cursor }) {
      const versions = registry.listVersions(agentId);
      return paginate(versions, (a) => a.version as unknown as string, limit, cursor);
    },
    async publish({ agent, projectId }) {
      lastPublishedProjectId = projectId;
      const outcome = registry.register(agent);
      if (outcome.kind === 'err') {
        return { kind: 'already-registered', agentId: agent.id, version: agent.version };
      }
      return { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    async unregister({ agentId, version }) {
      const outcome = registry.unregister(agentId, version as unknown as string);
      return { unregistered: outcome.kind === 'ok' };
    },
    async reinstateVersion({ agentId, version }) {
      return { kind: 'not-found', agentId, version };
    },
  };
}

/**
 * Build a POST /v1/agents body. `projectId` is REQUIRED (content-scope
 * anchor) — the fixture supplies a stable uuid by default
 * so happy-path tests read cleanly. The `defineAgent`-shaped spec
 * used elsewhere in the file is agnostic to projectId.
 */
function agentSpec(
  overrides: {
    id?: string;
    version?: string;
    name?: string;
    projectId?: string;
  } = {},
) {
  return {
    id: overrides.id ?? 'acme.drafting',
    version: overrides.version ?? '1.0.0',
    name: overrides.name ?? 'Drafting Agent',
    instructions: 'Draft the document from the provided facts.',
    capabilities: [{ needs: [{ feature: 'structured-output' as const }] }],
    tools: [{ id: 'citations.lookup', version: '1.0.0' }],
    retrieval: [{ types: ['prior-draft'], scope: 'same-conversation' as const }],
    guardrails: ['no-fabricated-quotes'],
    projectId: overrides.projectId ?? randomUUID(),
  };
}

function makeApp() {
  const registry = createAgentRegistry();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    agentRegistry: bindingFromRegistry(registry),
  });
  return { app, registry };
}

describe('API — agents list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/agents', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('prefix name filter', async () => {
    const { app, registry } = makeApp();
    for (const id of ['acme.a', 'acme.b', 'globex.c']) {
      const d = defineAgent(agentSpec({ id }));
      if (d.kind === 'err') throw new Error(d.error.message);
      registry.register(d.value);
    }
    const res = await app.request('/v1/agents?name=acme', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((a) => a.id).sort();
    expect(ids).toEqual(['acme.a', 'acme.b']);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app, registry } = makeApp();
    for (const id of ['a.1', 'a.2', 'a.3', 'a.4', 'a.5']) {
      const d = defineAgent(agentSpec({ id }));
      if (d.kind === 'err') throw new Error(d.error.message);
      registry.register(d.value);
    }
    const first = await app.request('/v1/agents?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data.map((a) => a.id)).toEqual(['a.1', 'a.2']);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/agents?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const secondBody = (await second.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(secondBody.data.map((a) => a.id)).toEqual(['a.3', 'a.4']);
    expect(secondBody.hasMore).toBe(true);
  });
});

describe('API — agents get', () => {
  test('publish + get roundtrip', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(agentSpec()),
    });
    expect(publish.status).toBe(201);
    const published = (await publish.json()) as { agentId: string; version: string };
    expect(published.agentId).toBe('acme.drafting');
    expect(published.version).toBe('1.0.0');

    const get = await app.request('/v1/agents/acme.drafting', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { id: string; version: string; name: string };
    expect(body.id).toBe('acme.drafting');
    expect(body.version).toBe('1.0.0');
    expect(body.name).toBe('Drafting Agent');
  });

  test('unknown id → 404 agent-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/agents/nope.missing', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('agent-not-found');
  });
});

describe('API — agents publish', () => {
  test('validation failure → 400 validation-failed', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: randomUUID(),
        id: '',
        version: 'not-a-semver',
        name: '',
        instructions: '',
        capabilities: [],
        tools: [],
        retrieval: [],
        guardrails: [],
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
    const res = await app.request('/v1/agents', {
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
    const first = await app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(agentSpec()),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(agentSpec()),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('agent-already-registered');
  });

  // ------------------ projectId on POST ------------------

  test('POST /v1/agents threads projectId to the binding', async () => {
    const { app } = makeApp();
    lastPublishedProjectId = undefined;
    const projectId = randomUUID();
    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(agentSpec({ projectId })),
    });
    expect(res.status).toBe(201);
    expect(lastPublishedProjectId as unknown as string).toBe(projectId);
  });

  test('POST /v1/agents without projectId → 400 bad-input', async () => {
    const { app } = makeApp();
    // Build a body without projectId (the agentSpec fixture always adds one).
    const { projectId: _pid, ...bodyWithoutProjectId } = agentSpec();
    const res = await app.request('/v1/agents', {
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
    const stableSpec = agentSpec({ projectId: randomUUID() });
    const first = await app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableSpec),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableSpec),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const body = (await second.json()) as { agentId: string; version: string };
    expect(body.agentId).toBe('acme.drafting');
    expect(body.version).toBe('1.0.0');
  });
});

describe('API — agents versions', () => {
  test('list versions returns each semver, sorted asc', async () => {
    const { app, registry } = makeApp();
    for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
      const d = defineAgent(agentSpec({ version: v }));
      if (d.kind === 'err') throw new Error(d.error.message);
      registry.register(d.value);
    }
    const res = await app.request('/v1/agents/acme.drafting/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ version: string }> };
    expect(body.data.map((a) => a.version)).toEqual(['1.0.0', '1.1.0', '2.0.0']);
  });

  test('list versions of unknown id → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/agents/nope/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('get specific version', async () => {
    const { app, registry } = makeApp();
    for (const v of ['1.0.0', '2.0.0']) {
      const d = defineAgent(agentSpec({ version: v }));
      if (d.kind === 'err') throw new Error(d.error.message);
      registry.register(d.value);
    }
    const res = await app.request('/v1/agents/acme.drafting/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; version: string };
    expect(body.id).toBe('acme.drafting');
    expect(body.version).toBe('1.0.0');
  });

  test('get unknown version → 404', async () => {
    const { app, registry } = makeApp();
    const d = defineAgent(agentSpec({ version: '1.0.0' }));
    if (d.kind === 'err') throw new Error(d.error.message);
    registry.register(d.value);
    const res = await app.request('/v1/agents/acme.drafting/versions/9.9.9', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — agents unregister', () => {
  test('unregister known version → 200 unregistered: true', async () => {
    const { app, registry } = makeApp();
    const d = defineAgent(agentSpec({ version: '1.0.0' }));
    if (d.kind === 'err') throw new Error(d.error.message);
    registry.register(d.value);
    const res = await app.request('/v1/agents/acme.drafting/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentId: string;
      version: string;
      unregistered: boolean;
    };
    expect(body.agentId).toBe('acme.drafting');
    expect(body.version).toBe('1.0.0');
    expect(body.unregistered).toBe(true);

    // Post-unregister get → 404.
    const get = await app.request('/v1/agents/acme.drafting/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  test('unregister unknown version → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/agents/nope.missing/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — agents surface unmounted when no binding supplied', () => {
  test('no `agentRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/agents', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Hono returns 404 (with its own body) for unmounted paths after
    // auth succeeds — the point is that no handler ran.
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — agents scope filter', () => {
  function makeSpy() {
    const registry = createAgentRegistry();
    const inner = bindingFromRegistry(registry);
    let lastListInput: Parameters<AgentRegistryBinding['list']>[0] | null = null;
    const spy: AgentRegistryBinding = {
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
      agentRegistry: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/agents?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const input = getLastInput();
    expect(input).not.toBeNull();
    expect(input?.scope).toEqual({ kind: 'project', tenantId, projectId });
    expect(input?.inherit).toBeUndefined();
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/agents?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const input = getLastInput();
    expect(input?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/agents', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const input = getLastInput();
    expect(input?.scope).toBeUndefined();
    expect(input?.inherit).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/agents?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});

describe('API — publishing an agent that searches memory by meaning', () => {
  function appWithMemory(semanticSearch: boolean | undefined) {
    const registry = createAgentRegistry();
    const memory = inMemoryMemory().binding;
    return createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      agentRegistry: bindingFromRegistry(registry),
      memory: { ...memory, ...(semanticSearch !== undefined && { semanticSearch }) },
    });
  }

  async function publish(app: ReturnType<typeof appWithMemory>, body: unknown) {
    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  const searching = {
    ...agentSpec({ id: 'acme.searching' }),
    retrieval: [
      { types: ['acme.note'], scope: 'tenant' as const, mode: 'semantic' as const },
      { types: ['acme.note'], scope: 'same-user' as const, mode: 'both' as const },
      { types: ['acme.note'], scope: 'tenant' as const, mode: 'keyword' as const },
    ],
  };

  test('without embeddings, each such intent is warned about at publish', async () => {
    const res = await publish(appWithMemory(false), searching);
    expect(res.status).toBe(201);
    expect(res.body.warnings).toHaveLength(2);
    expect(res.body.warnings[0]).toMatchObject({ code: 'semantic-unavailable' });
    expect(res.body.warnings[0].message).toContain('Retrieval intent 0');
    expect(res.body.warnings[1].message).toContain('Retrieval intent 1');
    expect(res.body.warnings[1].message).toContain('keyword');
  });

  test('with embeddings, or when the deployment does not say, no warnings', async () => {
    expect((await publish(appWithMemory(true), searching)).body.warnings).toBeUndefined();
    expect((await publish(appWithMemory(undefined), searching)).body.warnings).toBeUndefined();
  });

  test('an agent that remembers, on a deployment that cannot store it, is warned about', async () => {
    const registry = createAgentRegistry();
    const app = (agentRemember: boolean | undefined) =>
      createApp({
        ...createStubAppBindings(),
        resolveToken,
        runHandler,
        agentRegistry: bindingFromRegistry(registry),
        memory: {
          ...inMemoryMemory().binding,
          ...(agentRemember !== undefined && { agentRemember }),
        },
      });
    const remembering = (id: string) => ({
      ...agentSpec({ id }),
      memory: { remember: { types: ['acme.preference'], scope: 'same-user' } },
    });
    const off = await publish(app(false), remembering('acme.remembers-off'));
    expect(off.status).toBe(201);
    expect(off.body.warnings).toEqual([expect.objectContaining({ code: 'remember-unavailable' })]);
    expect(
      (await publish(app(true), remembering('acme.remembers-on'))).body.warnings,
    ).toBeUndefined();
    expect(
      (await publish(app(undefined), remembering('acme.remembers-unknown'))).body.warnings,
    ).toBeUndefined();
  });

  test("an agent's remember declaration is kept and read back; the built-in id is reserved", async () => {
    const app = appWithMemory(true);
    const declared = { types: ['acme.preference'], scope: 'same-user', keepDays: 14 };
    expect(
      (
        await publish(app, {
          ...agentSpec({ id: 'acme.remembers' }),
          memory: { remember: declared },
        })
      ).status,
    ).toBe(201);
    const res = await app.request('/v1/agents/acme.remembers/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await res.json()) as { memory?: unknown }).memory).toEqual({ remember: declared });
    const reserved = await publish(app, {
      ...agentSpec({ id: 'acme.reserved' }),
      tools: [{ id: 'kindgi.memory.remember', version: '1.0.0' }],
      memory: { remember: declared },
    });
    expect(reserved.status).toBe(400);
    expect(JSON.stringify(reserved.body)).toContain('built-in remember tool');
  });

  test("an agent's memory policy is kept and read back", async () => {
    const app = appWithMemory(true);
    const published = await publish(app, {
      ...agentSpec({ id: 'acme.policies' }),
      memory: { instructionTypes: ['acme.policy'] },
    });
    expect(published.status).toBe(201);
    const res = await app.request('/v1/agents/acme.policies/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await res.json()) as { memory?: unknown }).memory).toEqual({
      instructionTypes: ['acme.policy'],
    });
  });
});

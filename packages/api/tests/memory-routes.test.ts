// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Fact, MemoryScope, Retention } from '@kindgi/memory';
import type { Cursor, FactId, ProjectId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  MemoryBinding,
  MemoryRetrieveIntent,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Memory route tests.
 *
 * The `MemoryBinding` is caller-plugged, so these tests use a small
 * in-memory adapter. No DB access — the routes only talk to the
 * binding. A boolean knob controls whether the adapter's "embedding
 * registry" is present; the semantic-mode tests exercise both paths.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'memory-token-abc';

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

interface StoredFact extends Fact {
  readonly _superseded?: boolean;
}

/** In-memory `MemoryBinding` adapter. Deterministic cursors on `createdAt`. */
function makeInMemoryBinding(options: { readonly hasEmbeddings?: boolean } = {}): MemoryBinding {
  const hasEmbeddings = options.hasEmbeddings ?? false;
  const store = new Map<string, StoredFact>();
  let seq = 0;

  function scopeMatches(actual: MemoryScope, wanted: Partial<MemoryScope>): boolean {
    const a = actual as unknown as Readonly<Record<string, unknown>>;
    for (const [k, v] of Object.entries(wanted)) {
      if (v === undefined) continue;
      if (a[k] !== v) return false;
    }
    return true;
  }

  function paginate(
    rows: readonly StoredFact[],
    limit: number,
    cursor: Cursor | undefined,
  ): { data: readonly Fact[]; nextCursor?: Cursor } {
    let startAt = 0;
    if (cursor !== undefined) {
      const cur = cursor as unknown as string;
      startAt = rows.findIndex((r) => (r.id as unknown as string) > cur);
      if (startAt < 0) startAt = rows.length;
    }
    const slice = rows.slice(startAt, startAt + limit);
    const last = slice[slice.length - 1];
    const hasMore = startAt + slice.length < rows.length;
    return {
      data: slice,
      ...(hasMore &&
        last !== undefined && {
          nextCursor: last.id as unknown as string as unknown as Cursor,
        }),
    };
  }

  return {
    async listFacts({ limit, cursor, type, scope }) {
      const all = [...store.values()]
        .filter((f) => !f._superseded)
        .filter((f) => (type === undefined ? true : f.type === type))
        .filter((f) => (scope === undefined ? true : scopeMatches(f.scope, scope)))
        .sort((a, b) => (a.id as unknown as string).localeCompare(b.id as unknown as string));
      return paginate(all, limit, cursor);
    },
    async getFact({ factId }) {
      const f = store.get(factId as unknown as string);
      return f ?? null;
    },
    async writeFact(input) {
      if (input.type === 'semantic-only' && !hasEmbeddings) {
        return {
          kind: 'embedding-unavailable',
          message:
            'Type "semantic-only" declares semantic indexing but no embedding registry is bound',
        };
      }
      seq += 1;
      const idString = `fact-${String(seq).padStart(4, '0')}`;
      const now = new Date().toISOString() as Timestamp;
      const fact: StoredFact = {
        id: idString as FactId,
        type: input.type,
        scope: input.scope,
        version: 1,
        createdAt: now,
        content: input.content,
        ...(input.retention !== undefined && { retention: input.retention }),
        ...(input.contentHash !== undefined && { contentHash: input.contentHash }),
      };
      store.set(idString, fact);
      return { kind: 'ok', fact };
    },
    async supersedeFact({ factId }) {
      const existing = store.get(factId as unknown as string);
      if (existing === undefined) return { superseded: false };
      // Idempotent — no-op if already superseded.
      store.set(factId as unknown as string, { ...existing, _superseded: true });
      return { superseded: true };
    },
    async retrieve({ intent }) {
      if ((intent.mode === 'semantic' || intent.mode === 'both') && !hasEmbeddings) {
        return {
          kind: 'embedding-unavailable',
          message: 'Semantic retrieval requires an embedding registry',
        };
      }
      const rows = [...store.values()].filter((f) => !f._superseded);
      const typed = intent.type === undefined ? rows : rows.filter((f) => f.type === intent.type);
      const scoped =
        intent.scope === undefined
          ? typed
          : typed.filter((f) => scopeMatches(f.scope, intent.scope as Partial<MemoryScope>));

      if (intent.mode === 'list') {
        const limited = scoped.slice(0, intent.limit ?? scoped.length);
        return { kind: 'ok', results: limited.map((fact) => ({ fact })) };
      }

      const query = intent.query ?? '';
      const matches = scoped
        .map((fact) => {
          const haystack =
            typeof fact.content === 'string' ? fact.content : JSON.stringify(fact.content);
          const score = haystack.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
          return { fact, score };
        })
        .filter((h) => h.score > 0)
        .slice(0, intent.limit ?? scoped.length);
      return { kind: 'ok', results: matches };
    },
  };
}

function makeApp(bindingOptions: { readonly hasEmbeddings?: boolean } = {}) {
  const binding = makeInMemoryBinding(bindingOptions);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    memory: binding,
  });
  return { app, binding };
}

function scopeFor(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return { tenantId, ...overrides };
}

function writeBody(
  overrides: {
    type?: string;
    content?: unknown;
    scope?: Partial<MemoryScope>;
    retention?: Retention;
  } = {},
) {
  return {
    type: overrides.type ?? 'note',
    scope: scopeFor(overrides.scope),
    content: overrides.content ?? { text: 'hello world' },
    ...(overrides.retention !== undefined && { retention: overrides.retention }),
  };
}

describe('API — memory list facts', () => {
  test('empty store → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/facts', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('write + get roundtrip', async () => {
    const { app } = makeApp();
    const write = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(writeBody()),
    });
    expect(write.status).toBe(201);
    const wrote = (await write.json()) as { id: string; type: string; content: unknown };
    expect(wrote.type).toBe('note');
    expect(wrote.content).toEqual({ text: 'hello world' });

    const get = await app.request(`/v1/memory/facts/${wrote.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { id: string; type: string };
    expect(body.id).toBe(wrote.id);
    expect(body.type).toBe('note');
  });

  test('type filter narrows results', async () => {
    const { app } = makeApp();
    for (const type of ['note', 'note', 'summary']) {
      await app.request('/v1/memory/facts', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(writeBody({ type })),
      });
    }
    const res = await app.request('/v1/memory/facts?type=note', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ type: string }> };
    expect(body.data.length).toBe(2);
    for (const row of body.data) expect(row.type).toBe('note');
  });

  test('scope filter narrows results', async () => {
    const { app } = makeApp();
    const projectA = randomUUID() as ProjectId;
    const projectB = randomUUID() as ProjectId;
    for (const projectId of [projectA, projectA, projectB]) {
      await app.request('/v1/memory/facts', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(writeBody({ scope: { projectId } })),
      });
    }
    const scopeParam = encodeURIComponent(JSON.stringify({ projectId: projectA }));
    const res = await app.request(`/v1/memory/facts?scope=${scopeParam}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ scope: { projectId: string } }> };
    expect(body.data.length).toBe(2);
    for (const row of body.data) expect(row.scope.projectId).toBe(projectA as unknown as string);
  });

  test('malformed scope query → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/facts?scope=not-json', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 5; i += 1) {
      await app.request('/v1/memory/facts', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(writeBody({ content: { i } })),
      });
    }
    const first = await app.request('/v1/memory/facts?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data.length).toBe(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/memory/facts?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const secondBody = (await second.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(secondBody.data.length).toBe(2);
    expect(secondBody.hasMore).toBe(true);
    const firstIds = new Set(firstBody.data.map((r) => r.id));
    for (const row of secondBody.data) expect(firstIds.has(row.id)).toBe(false);
  });
});

describe('API — memory get fact', () => {
  test('unknown id → 404 fact-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/facts/fact-does-not-exist', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('fact-not-found');
  });
});

describe('API — memory write fact', () => {
  test('non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('missing type → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: scopeFor(), content: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('semantic-indexed type without embedding binding → 400 bad-input', async () => {
    const { app } = makeApp({ hasEmbeddings: false });
    const res = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(writeBody({ type: 'semantic-only' })),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toMatch(/embedding/i);
  });
});

describe('API — memory supersede fact', () => {
  test('supersede known fact → 200 { superseded: true }', async () => {
    const { app } = makeApp();
    const write = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(writeBody()),
    });
    const wrote = (await write.json()) as { id: string };

    const res = await app.request(`/v1/memory/facts/${wrote.id}/supersede`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { factId: string; superseded: boolean };
    expect(body.factId).toBe(wrote.id);
    expect(body.superseded).toBe(true);
  });

  test('supersede twice on same id is idempotent — both return 200 { superseded: true }', async () => {
    const { app } = makeApp();
    const write = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(writeBody()),
    });
    const wrote = (await write.json()) as { id: string };

    const first = await app.request(`/v1/memory/facts/${wrote.id}/supersede`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/v1/memory/facts/${wrote.id}/supersede`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { superseded: boolean };
    expect(body.superseded).toBe(true);
  });

  test('supersede unknown id → 404 fact-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/facts/fact-nope/supersede', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('fact-not-found');
  });
});

describe('API — memory retrieve', () => {
  test('keyword retrieval end-to-end — write + retrieve', async () => {
    const { app } = makeApp();
    for (const text of ['indemnity clause', 'liability cap', 'notice period']) {
      await app.request('/v1/memory/facts', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(writeBody({ content: { text } })),
      });
    }
    const intent: MemoryRetrieveIntent = { mode: 'keyword', query: 'indemnity' };
    const res = await app.request('/v1/memory/retrieve', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ fact: { content: { text: string } }; score?: number }>;
    };
    expect(body.results.length).toBe(1);
    expect(body.results[0]?.fact.content.text).toBe('indemnity clause');
    expect(body.results[0]?.score).toBe(1);
  });

  test('list mode returns unranked facts (no score)', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 3; i += 1) {
      await app.request('/v1/memory/facts', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(writeBody({ content: { i } })),
      });
    }
    const intent: MemoryRetrieveIntent = { mode: 'list', limit: 2 };
    const res = await app.request('/v1/memory/retrieve', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ fact: unknown; score?: number }>;
    };
    expect(body.results.length).toBe(2);
    expect(body.results[0]?.score).toBeUndefined();
  });

  test('semantic mode without embedding binding → 400 bad-input', async () => {
    const { app } = makeApp({ hasEmbeddings: false });
    await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(writeBody({ content: { text: 'anything' } })),
    });
    const intent: MemoryRetrieveIntent = { mode: 'semantic', query: 'anything' };
    const res = await app.request('/v1/memory/retrieve', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toMatch(/embedding|semantic/i);
  });

  test('semantic mode with embedding binding present → 200 results', async () => {
    const { app } = makeApp({ hasEmbeddings: true });
    await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(writeBody({ content: { text: 'indemnity clause' } })),
    });
    const intent: MemoryRetrieveIntent = { mode: 'semantic', query: 'indemnity' };
    const res = await app.request('/v1/memory/retrieve', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ score?: number }> };
    expect(body.results.length).toBe(1);
  });

  test('missing query on keyword mode → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/retrieve', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'keyword' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('unknown mode → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/retrieve', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'lolwhat', query: 'x' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });
});

describe('API — memory surface unmounted when no binding supplied', () => {
  test('no `memory` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/memory/facts', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — memory scope filter', () => {
  function makeSpy() {
    const inner = makeInMemoryBinding();
    let lastListInput: Parameters<MemoryBinding['listFacts']>[0] | null = null;
    const spy: MemoryBinding = {
      ...inner,
      async listFacts(input) {
        lastListInput = input;
        return inner.listFacts(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      memory: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives platformScope=project', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/memory/facts?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.platformScope).toEqual({
      kind: 'project',
      tenantId,
      projectId,
    });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives platformScope=org', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/memory/facts?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.platformScope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives platformScope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/memory/facts', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.platformScope).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/memory/facts?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});

describe('API — memory never crosses tenants', () => {
  const otherTenant = randomUUID();

  function makeGuardedApp() {
    const inner = makeInMemoryBinding();
    const calls = { listFacts: 0, writeFact: 0, retrieve: 0 };
    const binding: MemoryBinding = {
      ...inner,
      async listFacts(input) {
        calls.listFacts += 1;
        return inner.listFacts(input);
      },
      async writeFact(input) {
        calls.writeFact += 1;
        return inner.writeFact(input);
      },
      async retrieve(input) {
        calls.retrieve += 1;
        return inner.retrieve(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      memory: binding,
    });
    return { app, calls };
  }

  async function errorOf(res: Response): Promise<{ status: number; code: string | undefined }> {
    const body = (await res.json()) as { error?: { code?: string } };
    return { status: res.status, code: body.error?.code };
  }

  test("POST /facts with another tenant's scope → 400 scope-mismatch, nothing written", async () => {
    const { app, calls } = makeGuardedApp();
    const res = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...writeBody(), scope: { tenantId: otherTenant } }),
    });
    expect(await errorOf(res)).toEqual({ status: 400, code: 'scope-mismatch' });
    expect(calls.writeFact).toBe(0);
  });

  test("POST /retrieve with another tenant's scope → 400 scope-mismatch", async () => {
    const { app, calls } = makeGuardedApp();
    const res = await app.request('/v1/memory/retrieve', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'list', scope: { tenantId: otherTenant } }),
    });
    expect(await errorOf(res)).toEqual({ status: 400, code: 'scope-mismatch' });
    expect(calls.retrieve).toBe(0);
  });

  test('GET /facts?scope= naming another tenant → 400 scope-mismatch', async () => {
    const { app, calls } = makeGuardedApp();
    const scope = encodeURIComponent(JSON.stringify({ tenantId: otherTenant }));
    const res = await app.request(`/v1/memory/facts?scope=${scope}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await errorOf(res)).toEqual({ status: 400, code: 'scope-mismatch' });
    expect(calls.listFacts).toBe(0);
  });

  test("the caller's own tenant in scope is accepted", async () => {
    const { app, calls } = makeGuardedApp();
    const res = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(writeBody()),
    });
    expect(res.status).toBe(201);
    expect(calls.writeFact).toBe(1);
  });
});

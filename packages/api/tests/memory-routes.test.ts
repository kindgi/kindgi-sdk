// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { MemoryScope, Retention } from '@kindgi/memory';
import type { ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  MemoryBinding,
  MemoryRetrieveIntent,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { inMemoryMemory } from './support/in-memory-memory.js';

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

function makeInMemoryBinding(options: { readonly hasEmbeddings?: boolean } = {}): MemoryBinding {
  return inMemoryMemory(options).binding;
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

describe('API — memory supersede, delete, verify and history', () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const json = { ...auth, 'content-type': 'application/json' };
  async function written(app: ReturnType<typeof makeApp>['app']) {
    const res = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(writeBody({ content: 'Support hours are 9 to 5.' })),
    });
    return (await res.json()) as { id: string; version: number };
  }

  test('supersede writes the next revision under the same id; reads see only it, history sees both', async () => {
    const { app } = makeApp();
    const v1 = await written(app);
    const res = await app.request(`/v1/memory/facts/${v1.id}/supersede`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ content: 'Support hours are 8 to 6.', expectVersion: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: v1.id,
      version: 2,
      supersedes: v1.id,
      content: 'Support hours are 8 to 6.',
    });
    const listed = (await (await app.request('/v1/memory/facts', { headers: auth })).json()) as {
      data: { id: string; content: string }[];
    };
    expect(listed.data.map((f) => f.content)).toEqual(['Support hours are 8 to 6.']);
    const got = await (await app.request(`/v1/memory/facts/${v1.id}`, { headers: auth })).json();
    expect(got).toMatchObject({ version: 2 });
    const old = await (
      await app.request(`/v1/memory/facts/${v1.id}?version=1`, { headers: auth })
    ).json();
    expect(old).toMatchObject({ version: 1, invalidationReason: 'superseded' });
    const history = (await (
      await app.request(`/v1/memory/facts/${v1.id}/revisions`, { headers: auth })
    ).json()) as { data: { version: number }[] };
    expect(history.data.map((r) => r.version)).toEqual([2, 1]);
  });

  test('a stale expectVersion: 409 fact-changed with the current revision; no content: 400', async () => {
    const { app } = makeApp();
    const v1 = await written(app);
    const supersede = (body: unknown) =>
      app.request(`/v1/memory/facts/${v1.id}/supersede`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await supersede({ content: 'b', expectVersion: 1 })).status).toBe(200);
    const stale = await supersede({ content: 'c', expectVersion: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'fact-changed', details: { currentVersion: 2 } },
    });
    expect((await supersede({ expectVersion: 2 })).status).toBe(400);
  });

  test('delete tombstones it: gone from reads, kept in history; deleting again is 404', async () => {
    const { app } = makeApp();
    const v1 = await written(app);
    const del = await app.request(`/v1/memory/facts/${v1.id}`, { method: 'DELETE', headers: auth });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ id: v1.id, invalidationReason: 'deleted' });
    expect((await app.request(`/v1/memory/facts/${v1.id}`, { headers: auth })).status).toBe(404);
    const history = (await (
      await app.request(`/v1/memory/facts/${v1.id}/revisions`, { headers: auth })
    ).json()) as { data: unknown[] };
    expect(history.data).toHaveLength(1);
    expect(
      (await app.request(`/v1/memory/facts/${v1.id}`, { method: 'DELETE', headers: auth })).status,
    ).toBe(404);
  });

  test('legal hold refuses a supersede and a delete: 409 legal-hold', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(writeBody({ retention: { legalHold: true } })),
    });
    const held = (await res.json()) as { id: string };
    const del = await app.request(`/v1/memory/facts/${held.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: { code: string } }).error.code).toBe('legal-hold');
  });

  test('verify writes a revision marked verified, by the caller', async () => {
    const { app } = makeApp();
    const v1 = await written(app);
    const res = await app.request(`/v1/memory/facts/${v1.id}/verify`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: v1.id, version: 2, trust: 'verified' });
  });

  test('unknown id: 404 for supersede, delete and verify', async () => {
    const { app } = makeApp();
    for (const [method, path, body] of [
      ['POST', '/v1/memory/facts/fact-nope/supersede', { content: 'x' }],
      ['DELETE', '/v1/memory/facts/fact-nope', undefined],
      ['POST', '/v1/memory/facts/fact-nope/verify', undefined],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: json,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      expect(res.status, path).toBe(404);
    }
  });

  test('a binding without delete, verify or history: 501 memory-operation-unsupported', async () => {
    const { deleteFact: _d, verifyFact: _v, listRevisions: _l, ...partial } = makeInMemoryBinding();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      memory: partial,
    });
    for (const [method, path] of [
      ['DELETE', '/v1/memory/facts/f-1'],
      ['POST', '/v1/memory/facts/f-1/verify'],
      ['GET', '/v1/memory/facts/f-1/revisions'],
    ] as const) {
      const res = await app.request(path, { method, headers: auth });
      expect(res.status, path).toBe(501);
    }
  });

  test('a write records who asserted it, and takes subjects and validity times', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        ...writeBody({ scope: { projectId: randomUUID() as ProjectId, participantId: 'p-7' } }),
        subjects: [{ kind: 'participant', id: 'p-7' }],
        validFrom: '2026-10-01T00:00:00Z',
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      trust: 'asserted',
      attributedTo: { kind: expect.any(String) },
      subjects: [{ kind: 'participant', id: 'p-7' }],
      validFrom: '2026-10-01T00:00:00.000Z',
    });
    const noProject = await app.request('/v1/memory/facts', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(writeBody({ scope: { participantId: 'p-7' } })),
    });
    expect(noProject.status).toBe(400);
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

  test('semantic mode without embeddings → 422 semantic-unavailable (never an empty success)', async () => {
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
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('semantic-unavailable');
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

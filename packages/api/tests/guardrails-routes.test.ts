// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Guardrail, guardrailConfigProblems } from '@kindgi/guardrails';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  GuardrailConfigCheck,
  GuardrailRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Guardrails route tests.
 *
 * The `GuardrailRegistryBinding` is caller-plugged, so these tests use
 * a small in-memory adapter. No DB access — the routes only talk to
 * the binding.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'guardrails-token-abc';

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
 * In-memory `Map`-backed binding. Stores `(guardrailId → Guardrail)` per
 * tenant. Captures the last `projectId` seen by register so tests can
 * assert threading from the POST route → binding.
 */
let lastRegisteredProjectId: ProjectId | undefined;

function makeInMemoryBinding(): GuardrailRegistryBinding {
  const store = new Map<string, Map<string, Guardrail>>();
  function tenant(id: TenantId): Map<string, Guardrail> {
    const key = id as unknown as string;
    let m = store.get(key);
    if (m === undefined) {
      m = new Map();
      store.set(key, m);
    }
    return m;
  }
  function paginate(
    rows: readonly Guardrail[],
    limit: number,
    cursor: Cursor | undefined,
  ): { data: readonly Guardrail[]; nextCursor?: Cursor } {
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
        last !== undefined && { nextCursor: last.id as unknown as string as unknown as Cursor }),
    };
  }
  return {
    async list({ tenantId: t, limit, cursor, nameFilter }) {
      const all = [...tenant(t).values()].sort((a, b) =>
        (a.id as unknown as string).localeCompare(b.id as unknown as string),
      );
      const filtered =
        nameFilter === undefined
          ? all
          : all.filter((i) => (i.id as unknown as string).startsWith(nameFilter));
      return paginate(filtered, limit, cursor);
    },
    async get({ tenantId: t, guardrailId }) {
      return tenant(t).get(guardrailId as unknown as string) ?? null;
    },
    async register({ tenantId: t, projectId, guardrail }) {
      lastRegisteredProjectId = projectId;
      const m = tenant(t);
      const key = guardrail.id as unknown as string;
      if (m.has(key)) return { kind: 'already-registered', guardrailId: guardrail.id };
      m.set(key, guardrail);
      return { kind: 'ok', guardrailId: guardrail.id };
    },
    async unregister({ tenantId: t, guardrailId }) {
      const removed = tenant(t).delete(guardrailId as unknown as string);
      return { unregistered: removed };
    },
  };
}

function guardrailBody(overrides: { id?: string } = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'acme.no-fabricated-quotes',
    kind: 'zero-llm',
    check: 'must-cite',
    action: { 'on-violation': 'halt' },
  };
}

/**
 * Build a POST /v1/guardrails body. `projectId` is REQUIRED (content-scope
 * anchor) — the fixture supplies a stable uuid by default
 * so happy-path tests read cleanly.
 */
function guardrailPostBody(
  overrides: {
    id?: string;
    projectId?: string;
  } = {},
): Record<string, unknown> {
  return {
    ...guardrailBody(overrides.id !== undefined ? { id: overrides.id } : {}),
    projectId: overrides.projectId ?? randomUUID(),
  };
}

function makeApp(options: { checkGuardrailConfig?: GuardrailConfigCheck } = {}) {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    guardrailRegistry: binding,
    ...(options.checkGuardrailConfig !== undefined && {
      checkGuardrailConfig: options.checkGuardrailConfig,
    }),
  });
  return { app, binding };
}

describe('API — guardrails list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/guardrails', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('prefix name filter', async () => {
    const { app, binding } = makeApp();
    for (const id of ['acme.a', 'acme.b', 'globex.c']) {
      await binding.register({
        tenantId,
        projectId: randomUUID() as ProjectId,
        guardrail: guardrailBody({ id }) as unknown as Guardrail,
        enqueueTuples: () => [],
      });
    }
    const res = await app.request('/v1/guardrails?name=acme', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((a) => a.id).sort();
    expect(ids).toEqual(['acme.a', 'acme.b']);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app, binding } = makeApp();
    for (const id of ['a.1', 'a.2', 'a.3', 'a.4', 'a.5']) {
      await binding.register({
        tenantId,
        projectId: randomUUID() as ProjectId,
        guardrail: guardrailBody({ id }) as unknown as Guardrail,
        enqueueTuples: () => [],
      });
    }
    const first = await app.request('/v1/guardrails?limit=2', {
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
      `/v1/guardrails?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
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

describe('API — guardrails get', () => {
  test('register + get roundtrip', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(guardrailPostBody()),
    });
    expect(publish.status).toBe(201);
    const registered = (await publish.json()) as { guardrailId: string };
    expect(registered.guardrailId).toBe('acme.no-fabricated-quotes');

    const get = await app.request('/v1/guardrails/acme.no-fabricated-quotes', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { id: string; kind: string };
    expect(body.id).toBe('acme.no-fabricated-quotes');
    expect(body.kind).toBe('zero-llm');
  });

  test('unknown id → 404 guardrail-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/guardrails/nope.missing', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('guardrail-not-found');
  });
});

describe('API — guardrails register', () => {
  test('validation failure → 400 validation-failed', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: randomUUID(),
        id: '',
        kind: 'not-a-real-kind',
        action: {},
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: unknown[] } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues).toBeTruthy();
  });

  test('a spec without `check` → 400 validation-failed (guardrail schema 1.1.0)', async () => {
    const { app } = makeApp();
    const { check: _check, ...withoutCheck } = guardrailPostBody();
    const res = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(withoutCheck),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation-failed');
  });

  test('register accepts the runtime extensions the guardrail schema declares', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...guardrailPostBody(),
        sandbox: 'strict',
        limits: { memMB: 256, cpuMs: 1000 },
        network: { kind: 'allowlist', hosts: ['api.example.com'] },
      }),
    });
    expect(publish.status).toBe(201);
  });

  test('non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('register twice same id with no idempotency key → 409', async () => {
    const { app } = makeApp();
    // No idempotency-key header — both bodies use fresh projectIds and
    // still collide because the id is what makes them dupes.
    const first = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(guardrailPostBody()),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(guardrailPostBody()),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('guardrail-already-registered');
  });

  test('idempotency-key retry replays original 201 response', async () => {
    const { app } = makeApp();
    const key = randomUUID();
    // Stable projectId across both POSTs — the idempotency middleware
    // hashes the body and rejects a replay with a different body as
    // `idempotency-key-body-mismatch`.
    const stableBody = guardrailPostBody({ projectId: randomUUID() });
    const first = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableBody),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/guardrails', {
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
    const body = (await second.json()) as { guardrailId: string };
    expect(body.guardrailId).toBe('acme.no-fabricated-quotes');
  });

  // ------------------ projectId on POST ------------------

  test('POST /v1/guardrails threads projectId to the binding', async () => {
    const { app } = makeApp();
    lastRegisteredProjectId = undefined;
    const projectId = randomUUID();
    const res = await app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(guardrailPostBody({ projectId })),
    });
    expect(res.status).toBe(201);
    expect(lastRegisteredProjectId as unknown as string).toBe(projectId);
  });

  test('POST /v1/guardrails without projectId → 400 bad-input', async () => {
    const { app } = makeApp();
    // Build a body without projectId (the guardrailPostBody fixture always adds one).
    const { projectId: _pid, ...bodyWithoutProjectId } = guardrailPostBody();
    const res = await app.request('/v1/guardrails', {
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

describe("API — guardrails register: the config against its check's configSchema (T338)", () => {
  const SCHEMA = {
    type: 'object',
    properties: { maxChars: { type: 'integer', exclusiveMinimum: 0 } },
  };
  // As a runtime wires it: the schema of the check the guardrail names.
  const checkGuardrailConfig: GuardrailConfigCheck = async ({ guardrail }) =>
    guardrail.check === 'my-pack.checks.answer-length'
      ? guardrailConfigProblems({ configSchema: SCHEMA, config: guardrail.config })
      : [];
  const post = (app: ReturnType<typeof makeApp>['app'], body: Record<string, unknown>) =>
    app.request('/v1/guardrails', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...guardrailPostBody(), ...body }),
    });

  test('a config the check refuses → 422 guardrail-config-invalid, details.issues, nothing registered', async () => {
    const { app, binding } = makeApp({ checkGuardrailConfig });
    const res = await post(app, {
      id: 'acme.strict-length',
      check: 'my-pack.checks.answer-length',
      config: { maxChars: -5 },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { issues: unknown[] } };
    };
    const message =
      'Guardrail "acme.strict-length" doesn\'t fit check "my-pack.checks.answer-length": config.maxChars must be > 0.';
    expect(body.error.code).toBe('guardrail-config-invalid');
    expect(body.error.message).toBe(message);
    expect(body.error.details.issues).toEqual([
      { path: '/config/maxChars', message: 'config.maxChars must be > 0.' },
    ]);
    expect(
      (await binding.list({ tenantId, limit: 10 })).data.map((g) => g.id as unknown as string),
    ).toEqual([]);
  });

  test('a config that fits → 201', async () => {
    const { app } = makeApp({ checkGuardrailConfig });
    const res = await post(app, {
      id: 'acme.strict-length',
      check: 'my-pack.checks.answer-length',
      config: { maxChars: 60 },
    });
    expect(res.status).toBe(201);
  });

  test('a check with nothing to check against → 201', async () => {
    const { app } = makeApp({ checkGuardrailConfig });
    expect((await post(app, { config: { anything: true } })).status).toBe(201);
  });

  test('without the hook: no check, 201 as before', async () => {
    const { app } = makeApp();
    const res = await post(app, {
      check: 'my-pack.checks.answer-length',
      config: { maxChars: -5 },
    });
    expect(res.status).toBe(201);
  });

  test('a spec validation failure still answers 400 before the config is checked', async () => {
    let called = false;
    const { app } = makeApp({
      checkGuardrailConfig: async () => {
        called = true;
        return [];
      },
    });
    const res = await post(app, { kind: '' });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe('API — guardrails unregister', () => {
  test('unregister known id → 200 unregistered: true', async () => {
    const { app, binding } = makeApp();
    await binding.register({
      tenantId,
      projectId: randomUUID() as ProjectId,
      guardrail: guardrailBody() as unknown as Guardrail,
      enqueueTuples: () => [],
    });
    const res = await app.request('/v1/guardrails/acme.no-fabricated-quotes/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { guardrailId: string; unregistered: boolean };
    expect(body.guardrailId).toBe('acme.no-fabricated-quotes');
    expect(body.unregistered).toBe(true);

    const get = await app.request('/v1/guardrails/acme.no-fabricated-quotes', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  test('unregister unknown id → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/guardrails/nope.missing/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — guardrails surface unmounted when no binding supplied', () => {
  test('no `guardrailRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/guardrails', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — guardrails scope filter', () => {
  function makeSpy() {
    const inner = makeInMemoryBinding();
    let lastListInput: Parameters<GuardrailRegistryBinding['list']>[0] | null = null;
    const spy: GuardrailRegistryBinding = {
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
      guardrailRegistry: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/guardrails?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/guardrails?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/guardrails', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/guardrails?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});

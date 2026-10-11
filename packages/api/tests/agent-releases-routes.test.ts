// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { createAgentRegistry, defineAgent } from '@kindgi/agents';
import { ref } from '@kindgi/authz';
import type { Cursor, LiveScope, Semver, TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  AgentReleaseBindings,
  LiveResolution,
  LiveResolveInput,
  Promotion,
  PromotionError,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import { agentsRouter } from '../src/routes/agents.js';
import type { AppEnv } from '../src/types.js';

/**
 * Live versions and promotions routes (evals step 4). The bindings are
 * fakes that record their inputs and return what each test sets up; the
 * routes only parse, call the binding and serialize.
 */

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const TOKEN = 'releases-token';
const PROJECT = randomUUID();
const ORG = randomUUID();
const AGENT = 'acme.drafting';

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId } : null;

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
};

const auth = { authorization: `Bearer ${TOKEN}` };
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function promotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: randomUUID(),
    agentId: AGENT,
    scope: { kind: 'tenant' },
    action: 'promote',
    fromVersion: null,
    toVersion: '1.1.0' as Semver,
    requestedBy: { kind: 'user', id: userId as unknown as string },
    createdAt: '2026-10-05T12:00:00.000Z' as Timestamp,
    ...overrides,
  };
}

type Outcome = { kind: 'ok'; value: Promotion } | { kind: 'err'; error: PromotionError };

/** Fakes that record each call; tests set what they return. */
function fakeReleases() {
  const calls: { method: string; input: unknown }[] = [];
  const state: {
    resolved: LiveResolution | null;
    outcome: Outcome;
    page: { data: readonly Promotion[]; nextCursor?: Cursor };
    found: Promotion | null;
  } = {
    resolved: null,
    outcome: { kind: 'ok', value: promotion() },
    page: { data: [] },
    found: null,
  };
  const record = (method: string, input: unknown) => calls.push({ method, input });
  const bindings: AgentReleaseBindings = {
    live: {
      resolve: async (input: LiveResolveInput) => {
        record('resolve', input);
        return state.resolved;
      },
      list: async (input) => {
        record('live.list', input);
        return [
          {
            agentId: AGENT,
            scope: { kind: 'project', projectId: PROJECT } as LiveScope,
            version: '1.1.0' as Semver,
            promotionId: 'p-1',
            setAt: '2026-10-05T12:00:00.000Z' as Timestamp,
          },
        ];
      },
    },
    promotions: {
      promote: async (input) => {
        record('promote', input);
        return state.outcome;
      },
      rollback: async (input) => {
        record('rollback', input);
        return state.outcome;
      },
      unpin: async (input) => {
        record('unpin', input);
        return state.outcome;
      },
      list: async (input) => {
        record('promotions.list', input);
        return state.page;
      },
      get: async (_tenant, promotionId) => {
        record('promotions.get', promotionId);
        return state.found;
      },
    },
  };
  return { bindings, calls, state };
}

function registryWith(versions: readonly string[]): AgentRegistryBinding {
  const registry = createAgentRegistry();
  for (const version of versions) {
    const d = defineAgent({
      id: AGENT,
      version,
      name: 'Drafting',
      instructions: 'Draft the document.',
      capabilities: [{ needs: [{ feature: 'structured-output' as const }] }],
      tools: [],
      retrieval: [],
      guardrails: [],
    });
    if (d.kind === 'err') throw new Error(d.error.message);
    registry.register(d.value);
  }
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  return {
    get: async ({ agentId }) => {
      const got = registry.getLatest(agentId);
      return got.kind === 'ok' ? got.value : null;
    },
    list: unused,
    getVersion: async ({ agentId, version }) => {
      const got = registry.get(agentId, version as unknown as string);
      return got.kind === 'ok' ? got.value : null;
    },
    headExists: unused,
    listVersions: unused,
    publish: unused,
    unregister: async () => ({ unregistered: false }),
    reinstateVersion: unused,
  };
}

function makeApp(versions: readonly string[] = ['1.0.0', '1.1.0']) {
  const fake = fakeReleases();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    agentRegistry: registryWith(versions),
    agentReleases: fake.bindings,
  });
  return { app, ...fake };
}

describe('GET /v1/agents/:agentId/live', () => {
  test('a pin on the way up → that version, via live, with its scope', async () => {
    const { app, calls, state } = makeApp();
    state.resolved = {
      version: '1.0.0' as Semver,
      scope: {
        kind: 'segment',
        projectId: PROJECT as never,
        path: [{ key: 'plan', value: 'pro' }],
      },
    };
    const res = await app.request(
      `/v1/agents/${AGENT}/live?projectId=${PROJECT}&segment=region:eu&segment=plan:pro`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agentId: AGENT,
      version: '1.0.0',
      via: 'live',
      liveScope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'plan', value: 'pro' }] },
    });
    expect(calls).toEqual([
      {
        method: 'resolve',
        input: {
          tenantId,
          agentId: AGENT,
          projectId: PROJECT,
          segments: [
            { key: 'region', value: 'eu' },
            { key: 'plan', value: 'pro' },
          ],
        },
      },
    ]);
  });

  test('nothing pinned → the latest registered version, via latest', async () => {
    const { app } = makeApp();
    const res = await app.request(`/v1/agents/${AGENT}/live`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: AGENT, version: '1.1.0', via: 'latest' });
  });

  test('nothing pinned and no such agent → 404', async () => {
    const { app } = makeApp([]);
    const res = await app.request(`/v1/agents/${AGENT}/live`, { headers: auth });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('agent-not-found');
  });

  test.each([
    ['a malformed project id', '?projectId=nope'],
    ['a segment without a project', '?segment=plan:pro'],
    ['a segment without a value', `?projectId=${PROJECT}&segment=plan`],
    ['a repeated segment key', `?projectId=${PROJECT}&segment=plan:a&segment=plan:b`],
  ])('%s → 400', async (_name, query) => {
    const { app, calls } = makeApp();
    const res = await app.request(`/v1/agents/${AGENT}/live${query}`, { headers: auth });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('GET /v1/agents/:agentId/live-versions', () => {
  test('lists every pin with its scope on the wire', async () => {
    const { app } = makeApp();
    const res = await app.request(`/v1/agents/${AGENT}/live-versions`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        {
          agentId: AGENT,
          scope: { kind: 'project', projectId: PROJECT },
          version: '1.1.0',
          promotionId: 'p-1',
          setAt: '2026-10-05T12:00:00.000Z',
        },
      ],
    });
  });
});

describe('POST /v1/agents/:agentId/promotions', () => {
  test('promotes for a scope, as the request’s user → 201', async () => {
    const { app, calls, state } = makeApp();
    const made = promotion({ scope: { kind: 'org', orgId: ORG as never }, reason: 'eval passed' });
    state.outcome = { kind: 'ok', value: made };
    const res = await app.request(
      `/v1/agents/${AGENT}/promotions`,
      post({
        version: '1.1.0',
        scope: { kind: 'org', orgId: ORG },
        reason: 'eval passed',
        evalRunId: 'run-7',
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: made.id,
      agentId: AGENT,
      scope: { kind: 'org', orgId: ORG },
      action: 'promote',
      fromVersion: null,
      toVersion: '1.1.0',
      requestedBy: { kind: 'user', id: userId },
      reason: 'eval passed',
      createdAt: '2026-10-05T12:00:00.000Z',
    });
    expect(calls).toEqual([
      {
        method: 'promote',
        input: {
          tenantId,
          agentId: AGENT,
          version: '1.1.0',
          scope: { kind: 'org', orgId: ORG },
          requestedBy: { kind: 'user', id: userId },
          reason: 'eval passed',
          evalRunId: 'run-7',
        },
      },
    ]);
  });

  test.each([
    ['no version', { scope: { kind: 'tenant' } }],
    ['no scope', { version: '1.1.0' }],
    ['an unknown scope kind', { version: '1.1.0', scope: { kind: 'team' } }],
    [
      'a project scope without a UUID',
      { version: '1.1.0', scope: { kind: 'project', projectId: 'p' } },
    ],
    [
      'a segment scope with an empty path',
      { version: '1.1.0', scope: { kind: 'segment', projectId: PROJECT, path: [] } },
    ],
    ['a blank reason', { version: '1.1.0', scope: { kind: 'tenant' }, reason: '  ' }],
  ])('%s → 400, binding not called', async (_name, body) => {
    const { app, calls } = makeApp();
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, post(body));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('a version that is not registered → 404', async () => {
    const { app, state } = makeApp();
    state.outcome = {
      kind: 'err',
      error: { code: 'agent-version-not-found', message: 'no 9.9.9' },
    };
    const res = await app.request(
      `/v1/agents/${AGENT}/promotions`,
      post({ version: '9.9.9', scope: { kind: 'tenant' } }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'agent-version-not-found',
    );
  });
});

describe('GET /v1/agents/:agentId/promotions', () => {
  test('a cursor the binding didn’t issue: 400 bad-input, before the list is read', async () => {
    const fake = fakeReleases();
    const releases: AgentReleaseBindings = {
      ...fake.bindings,
      promotions: {
        ...fake.bindings.promotions,
        issuedCursor: (list, cursor) => list === 'promotions' && cursor === ('c-1' as Cursor),
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      agentRegistry: registryWith(['1.0.0']),
      agentReleases: releases,
    });
    const refused = await app.request(`/v1/agents/${AGENT}/promotions?cursor=made-up`, {
      headers: auth,
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('bad-input');
    expect(fake.calls).toEqual([]);
    const next = await app.request(`/v1/agents/${AGENT}/promotions?cursor=c-1`, { headers: auth });
    expect(next.status).toBe(200);
    expect(fake.calls.map((c) => c.method)).toEqual(['promotions.list']);
  });

  test('pages, newest first as the binding returns them', async () => {
    const { app, calls, state } = makeApp();
    const a = promotion();
    state.page = { data: [a], nextCursor: 'c-2' as Cursor };
    const res = await app.request(`/v1/agents/${AGENT}/promotions?limit=1&cursor=c-1`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string }[];
      hasMore: boolean;
      nextCursor: string;
    };
    expect(body.data.map((p) => p.id)).toEqual([a.id]);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe('c-2');
    expect(calls).toEqual([
      { method: 'promotions.list', input: { tenantId, agentId: AGENT, limit: 1, cursor: 'c-1' } },
    ]);
  });

  test('narrows to a segment scope', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(
      `/v1/agents/${AGENT}/promotions?scopeKind=segment&scopeId=${PROJECT}&segment=plan:pro`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect((calls[0]?.input as { scope: unknown }).scope).toEqual({
      kind: 'segment',
      projectId: PROJECT,
      path: [{ key: 'plan', value: 'pro' }],
    });
  });

  test.each([
    ['scopeId without scopeKind', `?scopeId=${PROJECT}`],
    ['an unknown scopeKind', `?scopeKind=team&scopeId=${PROJECT}`],
    ['a project scope without an id', '?scopeKind=project'],
    ['a segment scope without a path', `?scopeKind=segment&scopeId=${PROJECT}`],
  ])('%s → 400', async (_name, query) => {
    const { app, calls } = makeApp();
    const res = await app.request(`/v1/agents/${AGENT}/promotions${query}`, { headers: auth });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('GET /v1/agents/:agentId/promotions/:promotionId', () => {
  test('found → 200', async () => {
    const { app, state } = makeApp();
    state.found = promotion();
    const res = await app.request(`/v1/agents/${AGENT}/promotions/${state.found.id}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(state.found.id);
  });

  test('another agent’s promotion → 404', async () => {
    const { app, state } = makeApp();
    state.found = promotion({ agentId: 'acme.other' });
    const res = await app.request(`/v1/agents/${AGENT}/promotions/${state.found.id}`, {
      headers: auth,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'promotion-not-found',
    );
  });
});

describe('POST /v1/agents/:agentId/live/rollback and /live/unpin', () => {
  test('rollback passes toVersion and reason → 200', async () => {
    const { app, calls, state } = makeApp();
    state.outcome = {
      kind: 'ok',
      value: promotion({
        action: 'rollback',
        fromVersion: '1.1.0' as Semver,
        toVersion: '1.0.0' as Semver,
      }),
    };
    const res = await app.request(
      `/v1/agents/${AGENT}/live/rollback`,
      post({
        scope: { kind: 'project', projectId: PROJECT },
        toVersion: '1.0.0',
        reason: 'regression',
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe('rollback');
    expect(calls[0]).toEqual({
      method: 'rollback',
      input: {
        tenantId,
        agentId: AGENT,
        scope: { kind: 'project', projectId: PROJECT },
        requestedBy: { kind: 'user', id: userId },
        toVersion: '1.0.0',
        reason: 'regression',
      },
    });
  });

  test('nothing to roll back → 409', async () => {
    const { app, state } = makeApp();
    state.outcome = { kind: 'err', error: { code: 'nothing-to-roll-back', message: 'none' } };
    const res = await app.request(
      `/v1/agents/${AGENT}/live/rollback`,
      post({ scope: { kind: 'tenant' } }),
    );
    expect(res.status).toBe(409);
  });

  test('a blank toVersion → 400', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(
      `/v1/agents/${AGENT}/live/rollback`,
      post({ scope: { kind: 'tenant' }, toVersion: '' }),
    );
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('unpin a scope with no pin of its own → 409', async () => {
    const { app, calls, state } = makeApp();
    state.outcome = { kind: 'err', error: { code: 'not-pinned', message: 'no pin' } };
    const res = await app.request(
      `/v1/agents/${AGENT}/live/unpin`,
      post({ scope: { kind: 'org', orgId: ORG } }),
    );
    expect(res.status).toBe(409);
    expect(calls.map((c) => c.method)).toEqual(['unpin']);
  });
});

describe('without agentReleases, the routes are not mounted', () => {
  test('GET /live → 404', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      agentRegistry: registryWith(['1.0.0']),
    });
    const res = await app.request(`/v1/agents/${AGENT}/live`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe('authorization: changing what is live needs promote; reading needs read', () => {
  function recordingAuthorizer(checked: string[]): Authorizer {
    return {
      authorize: (action, getResource) => async (c, next) => {
        const r = await getResource(c);
        checked.push(`${action} ${r.type}:${r.id}`);
        return next();
      },
      can: async () => false,
      check: async () => {
        throw new Error('unused');
      },
      filterByCan: async () => [],
    };
  }

  function mounted(checked: string[]) {
    const fake = fakeReleases();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-releases' as never);
      return next();
    });
    app.route(
      '/',
      agentsRouter(
        registryWith(['1.0.0']),
        recordingAuthorizer(checked),
        undefined,
        undefined,
        fake.bindings,
      ),
    );
    return app;
  }

  const agent = ref('agent', AGENT);
  const on = `${agent.type}:${agent.id}`;

  test.each([
    ['POST', '/promotions', { version: '1.0.0', scope: { kind: 'tenant' } }, 'promote'],
    ['POST', '/live/rollback', { scope: { kind: 'tenant' } }, 'promote'],
    ['POST', '/live/unpin', { scope: { kind: 'tenant' } }, 'promote'],
    ['POST', '/promotions/check', { version: '1.0.0', scope: { kind: 'tenant' } }, 'read'],
    ['GET', '/gate-policy?scopeKind=tenant', undefined, 'read'],
    ['GET', '/live', undefined, 'read'],
    ['GET', '/live-versions', undefined, 'read'],
    ['GET', '/promotions', undefined, 'read'],
  ])('%s %s → %s on the agent', async (method, path, body, action) => {
    const checked: string[] = [];
    await mounted(checked).request(`/${AGENT}${path}`, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    expect(checked).toEqual([`${action} ${on}`]);
  });

  test('unregistering a version still needs admin', async () => {
    const checked: string[] = [];
    await mounted(checked).request(`/${AGENT}/versions/1.0.0/unregister`, { method: 'POST' });
    expect(checked).toEqual([`admin ${on}`]);
  });
});

describe('POST /v1/agents/:agentId/versions/:version/unregister, a live version', () => {
  function appWhoseUnregister(outcome: { unregistered: boolean; live?: readonly LiveScope[] }) {
    return createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      agentRegistry: { ...registryWith(['1.0.0']), unregister: async () => outcome },
      agentReleases: fakeReleases().bindings,
    });
  }

  test('refused with 409 agent-version-live, naming the scopes it serves', async () => {
    const app = appWhoseUnregister({
      unregistered: false,
      live: [
        { kind: 'tenant' },
        { kind: 'segment', projectId: PROJECT as never, path: [{ key: 'plan', value: 'pro' }] },
      ],
    });
    const res = await app.request(`/v1/agents/${AGENT}/versions/1.0.0/unregister`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe('agent-version-live');
    expect(body.error.message).toContain('roll back, unpin, or promote another version');
    expect(body.error.details).toEqual({
      agentId: AGENT,
      version: '1.0.0',
      scopes: [
        { kind: 'tenant' },
        { kind: 'segment', projectId: PROJECT, path: [{ key: 'plan', value: 'pro' }] },
      ],
    });
  });

  test('a registry that knows no live versions: 404 as before', async () => {
    const res = await appWhoseUnregister({ unregistered: false }).request(
      `/v1/agents/${AGENT}/versions/1.0.0/unregister`,
      { method: 'POST', headers: auth },
    );
    expect(res.status).toBe(404);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { createAgentRegistry, defineAgent } from '@kindgi/agents';
import { ref } from '@kindgi/authz';
import type { AgentPinScope, Cursor, Semver, TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinResolution,
  AgentPinResolveInput,
  AgentRegistryBinding,
  LatestBinding,
  Pin,
  PinError,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import type { RegistryReadOnly } from '../src/registry-read-only.js';
import { agentsRouter } from '../src/routes/agents.js';
import type { AppEnv } from '../src/types.js';
import { highestAsLatest, noLatest } from './support/latest.js';

/**
 * Agent pin routes. The bindings are
 * fakes that record their inputs and return what each test sets up; the
 * routes only parse, call the binding and serialize.
 */

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const TOKEN = 'pins-token';
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

function pin(overrides: Partial<Pin> = {}): Pin {
  return {
    id: randomUUID(),
    agentId: AGENT,
    scope: { kind: 'tenant' },
    action: 'pin',
    fromVersion: null,
    toVersion: '1.1.0' as Semver,
    requestedBy: { kind: 'user', id: userId as unknown as string },
    createdAt: '2026-10-05T12:00:00.000Z' as Timestamp,
    ...overrides,
  };
}

type Outcome = { kind: 'ok'; value: Pin } | { kind: 'err'; error: PinError };

/** Fakes that record each call; tests set what they return. */
function fakePins() {
  const calls: { method: string; input: unknown }[] = [];
  const state: {
    resolved: AgentPinResolution | null;
    outcome: Outcome;
    page: { data: readonly Pin[]; nextCursor?: Cursor };
    found: Pin | null;
  } = {
    resolved: null,
    outcome: { kind: 'ok', value: pin() },
    page: { data: [] },
    found: null,
  };
  const record = (method: string, input: unknown) => calls.push({ method, input });
  const bindings: AgentPinBindings = {
    pinned: {
      resolve: async (input: AgentPinResolveInput) => {
        record('resolve', input);
        return state.resolved;
      },
      list: async (input) => {
        record('pinned.list', input);
        return [
          {
            agentId: AGENT,
            scope: { kind: 'project', projectId: PROJECT } as AgentPinScope,
            version: '1.1.0' as Semver,
            changeId: 'p-1',
            setAt: '2026-10-05T12:00:00.000Z' as Timestamp,
          },
        ];
      },
    },
    latest: noLatest,
    changes: {
      pin: async (input) => {
        record('pin', input);
        return state.outcome;
      },
      unpin: async (input) => {
        record('unpin', input);
        return state.outcome;
      },
      list: async (input) => {
        record('pin-history.list', input);
        return state.page;
      },
      get: async (_tenant, changeId) => {
        record('pin-history.get', changeId);
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
    markLatest: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
    reinstateVersion: unused,
  };
}

function makeApp(
  versions: readonly string[] = ['1.0.0', '1.1.0'],
  readOnly?: RegistryReadOnly,
  /** Latest; absent: the highest version. */
  latest?: LatestBinding,
) {
  const fake = fakePins();
  const registry = registryWith(versions);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    agentRegistry: { ...registry, ...(readOnly !== undefined && { readOnly }) },
    agentPins: { ...fake.bindings, latest: latest ?? highestAsLatest(registry) },
  });
  return { app, ...fake };
}

describe('GET /v1/agents/:agentId/pinned', () => {
  test('a pin on the way up → that version, via pinned, with its scope', async () => {
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
      `/v1/agents/${AGENT}/pinned?projectId=${PROJECT}&segment=region:eu&segment=plan:pro`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agentId: AGENT,
      version: '1.0.0',
      via: 'pinned',
      pinnedScope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'plan', value: 'pro' }] },
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

  test('nothing pinned → Latest (here the highest), via latest', async () => {
    const { app } = makeApp();
    const res = await app.request(`/v1/agents/${AGENT}/pinned`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: AGENT, version: '1.1.0', via: 'latest' });
  });

  // 1.1.0 is the highest; a deploy into PROJECT shipped 1.0.0 after it, so
  // 1.0.0 is Latest there. Another project has no Latest.
  const deployedOlder: LatestBinding = {
    latest: async ({ projectId }) =>
      projectId === PROJECT
        ? { version: '1.0.0' as Semver, since: '2026-10-20T09:00:00.000Z', deploymentId: 'dep-1' }
        : null,
    byProject: async () => [],
  };

  test("nothing pinned → the project's Latest, not the highest version", async () => {
    const { app } = makeApp(['1.0.0', '1.1.0'], undefined, deployedOlder);
    const res = await app.request(`/v1/agents/${AGENT}/pinned?projectId=${PROJECT}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: AGENT, version: '1.0.0', via: 'latest' });
  });

  test('nothing pinned and no Latest in the project → 404, saying no version runs there', async () => {
    const { app } = makeApp(['1.0.0', '1.1.0'], undefined, deployedOlder);
    const res = await app.request(`/v1/agents/${AGENT}/pinned?projectId=${randomUUID()}`, {
      headers: auth,
    });
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('agent-not-found');
    expect(error.message).toContain('runs in this scope');
  });

  test('nothing pinned and no such agent → 404', async () => {
    const { app } = makeApp([]);
    const res = await app.request(`/v1/agents/${AGENT}/pinned`, { headers: auth });
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
    const res = await app.request(`/v1/agents/${AGENT}/pinned${query}`, { headers: auth });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('GET /v1/agents/:agentId/pinned-versions', () => {
  test('lists every pin with its scope on the wire', async () => {
    const { app } = makeApp();
    const res = await app.request(`/v1/agents/${AGENT}/pinned-versions`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        {
          agentId: AGENT,
          scope: { kind: 'project', projectId: PROJECT },
          version: '1.1.0',
          changeId: 'p-1',
          setAt: '2026-10-05T12:00:00.000Z',
        },
      ],
    });
  });
});

describe('POST /v1/agents/:agentId/pinned/pin', () => {
  test('pins for a scope, as the request’s user → 201', async () => {
    const { app, calls, state } = makeApp();
    const made = pin({ scope: { kind: 'org', orgId: ORG as never }, reason: 'eval passed' });
    state.outcome = { kind: 'ok', value: made };
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({
        version: '1.1.0',
        scope: { kind: 'org', orgId: ORG },
        reason: 'eval passed',
        testRunId: 'run-7',
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: made.id,
      agentId: AGENT,
      scope: { kind: 'org', orgId: ORG },
      action: 'pin',
      fromVersion: null,
      toVersion: '1.1.0',
      requestedBy: { kind: 'user', id: userId },
      reason: 'eval passed',
      createdAt: '2026-10-05T12:00:00.000Z',
    });
    expect(calls).toEqual([
      {
        method: 'pin',
        input: {
          tenantId,
          agentId: AGENT,
          version: '1.1.0',
          scope: { kind: 'org', orgId: ORG },
          requestedBy: { kind: 'user', id: userId },
          reason: 'eval passed',
          testRunId: 'run-7',
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
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, post(body));
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
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '9.9.9', scope: { kind: 'tenant' } }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'agent-version-not-found',
    );
  });
});

describe('GET /v1/agents/:agentId/pin-history', () => {
  test('a cursor the binding didn’t issue: 400 bad-input, before the list is read', async () => {
    const fake = fakePins();
    const pins: AgentPinBindings = {
      ...fake.bindings,
      changes: {
        ...fake.bindings.changes,
        issuedCursor: (list, cursor) => list === 'pin-history' && cursor === ('c-1' as Cursor),
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      agentRegistry: registryWith(['1.0.0']),
      agentPins: pins,
    });
    const refused = await app.request(`/v1/agents/${AGENT}/pin-history?cursor=made-up`, {
      headers: auth,
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('bad-input');
    expect(fake.calls).toEqual([]);
    const next = await app.request(`/v1/agents/${AGENT}/pin-history?cursor=c-1`, { headers: auth });
    expect(next.status).toBe(200);
    expect(fake.calls.map((c) => c.method)).toEqual(['pin-history.list']);
  });

  test('pages, newest first as the binding returns them', async () => {
    const { app, calls, state } = makeApp();
    const a = pin();
    state.page = { data: [a], nextCursor: 'c-2' as Cursor };
    const res = await app.request(`/v1/agents/${AGENT}/pin-history?limit=1&cursor=c-1`, {
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
      { method: 'pin-history.list', input: { tenantId, agentId: AGENT, limit: 1, cursor: 'c-1' } },
    ]);
  });

  test('narrows to a segment scope', async () => {
    const { app, calls } = makeApp();
    const res = await app.request(
      `/v1/agents/${AGENT}/pin-history?scopeKind=segment&scopeId=${PROJECT}&segment=plan:pro`,
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
    const res = await app.request(`/v1/agents/${AGENT}/pin-history${query}`, { headers: auth });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('GET /v1/agents/:agentId/pin-history/:changeId', () => {
  test('found → 200', async () => {
    const { app, state } = makeApp();
    state.found = pin();
    const res = await app.request(`/v1/agents/${AGENT}/pin-history/${state.found.id}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(state.found.id);
  });

  test('another agent’s pin → 404', async () => {
    const { app, state } = makeApp();
    state.found = pin({ agentId: 'acme.other' });
    const res = await app.request(`/v1/agents/${AGENT}/pin-history/${state.found.id}`, {
      headers: auth,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('pin-not-found');
  });
});

describe('POST /v1/agents/:agentId/pinned/unpin', () => {
  test('unpin a scope with no pin of its own → 409', async () => {
    const { app, calls, state } = makeApp();
    state.outcome = { kind: 'err', error: { code: 'not-pinned', message: 'no pin' } };
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/unpin`,
      post({ scope: { kind: 'org', orgId: ORG } }),
    );
    expect(res.status).toBe(409);
    expect(calls.map((c) => c.method)).toEqual(['unpin']);
  });
});

describe('without agentPins, the routes are not mounted', () => {
  test('GET /pinned → 404', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      agentRegistry: registryWith(['1.0.0']),
    });
    const res = await app.request(`/v1/agents/${AGENT}/pinned`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe('authorization: changing a pin needs pin; reading needs read', () => {
  function recordingAuthorizer(checked: string[]): Authorizer {
    return {
      authorize: (action, getResource) => async (c, next) => {
        const r = await getResource(c);
        checked.push(`${action} ${r.type}:${r.id}`);
        return next();
      },
      can: async () => false,
      canFor: async () => {
        throw new Error('unused');
      },
      check: async () => {
        throw new Error('unused');
      },
      filterByCan: async () => [],
    };
  }

  function mounted(checked: string[]) {
    const fake = fakePins();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-pins' as never);
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
    ['POST', '/pinned/pin', { version: '1.0.0', scope: { kind: 'tenant' } }, 'pin'],
    ['POST', '/pinned/unpin', { scope: { kind: 'tenant' } }, 'pin'],
    ['POST', '/pinned/check', { version: '1.0.0', scope: { kind: 'tenant' } }, 'read'],
    ['GET', '/release-gate?scopeKind=tenant', undefined, 'read'],
    ['GET', '/pinned', undefined, 'read'],
    ['GET', '/pinned-versions', undefined, 'read'],
    ['GET', '/pin-history', undefined, 'read'],
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

describe('POST /v1/agents/:agentId/versions/:version/unregister, a pinned version', () => {
  function appWhoseUnregister(outcome: {
    unregistered: boolean;
    pinned?: readonly AgentPinScope[];
  }) {
    return createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      agentRegistry: { ...registryWith(['1.0.0']), unregister: async () => outcome },
      agentPins: fakePins().bindings,
    });
  }

  test('refused with 409 agent-version-pinned, naming the scopes it serves', async () => {
    const app = appWhoseUnregister({
      unregistered: false,
      pinned: [
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
    expect(body.error.code).toBe('agent-version-pinned');
    expect(body.error.message).toContain('unpin, or pin another version there first');
    expect(body.error.details).toEqual({
      agentId: AGENT,
      version: '1.0.0',
      scopes: [
        { kind: 'tenant' },
        { kind: 'segment', projectId: PROJECT, path: [{ key: 'plan', value: 'pro' }] },
      ],
    });
  });

  test('a registry that knows no pinned versions: 404 as before', async () => {
    const res = await appWhoseUnregister({ unregistered: false }).request(
      `/v1/agents/${AGENT}/versions/1.0.0/unregister`,
      { method: 'POST', headers: auth },
    );
    expect(res.status).toBe(404);
  });
});

describe("an agent registry that takes Improve's candidates (kindgi dev)", () => {
  const MARKER: RegistryReadOnly = {
    reason: "Under kindgi dev, the pack is the source of agents: edit the pack's files.",
    takesCandidates: {
      undoReason: "Under kindgi dev, the pack's files are what's live: undo a change with git.",
      scopeReason: "Under kindgi dev, the pack's files serve every scope: use the whole tenant.",
    },
  };

  test('a pin gets through to the pins binding → 201', async () => {
    const { app, calls } = makeApp(undefined, MARKER);
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '1.1.0', scope: { kind: 'tenant' } }),
    );
    expect(res.status).toBe(201);
    expect(calls.map((c) => c.method)).toContain('pin');
  });

  test('a pin check gets through', async () => {
    const { app } = makeApp(undefined, MARKER);
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/check`,
      post({ version: '1.1.0', scope: { kind: 'tenant' } }),
    );
    expect(res.status).not.toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain('registry-read-only');
  });

  test.each(['/pinned/unpin'])(
    'POST %s is refused with the undo reason, and the binding is never called',
    async (path) => {
      const { app, calls } = makeApp(undefined, MARKER);
      const res = await app.request(
        `/v1/agents/${AGENT}${path}`,
        post({ scope: { kind: 'tenant' }, toVersion: '1.0.0' }),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject({
        code: 'registry-read-only',
        message: MARKER.takesCandidates?.undoReason,
      });
      expect(calls.map((c) => c.method)).not.toContain(path.slice('/pinned/'.length));
    },
  );

  test.each([
    '/v1/agents',
    `/v1/agents/${AGENT}/versions/1.0.0/unregister`,
    `/v1/agents/${AGENT}/versions/1.0.0/reinstate`,
  ])('POST %s is still refused with the registry reason', async (path) => {
    const { app } = makeApp(undefined, MARKER);
    const res = await app.request(path, post({ id: AGENT, version: '1.2.0', from: '1.1.0' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({
      code: 'registry-read-only',
      message: MARKER.reason,
    });
  });

  test('without the marker, a read-only registry refuses a pin too', async () => {
    const { app, calls } = makeApp(undefined, { reason: MARKER.reason });
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '1.1.0', scope: { kind: 'tenant' } }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({
      code: 'registry-read-only',
      message: MARKER.reason,
    });
    expect(calls).toEqual([]);
  });
});

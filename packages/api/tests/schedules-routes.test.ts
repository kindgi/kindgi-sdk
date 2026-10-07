// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/schedules` over the in-memory trigger registry: a schedule runs an
 * agent or a flow as its owner, with its catch-up and overlap policies;
 * its fire history, run-now and taking ownership; what each route asks
 * the authorizer; and mounting only the trigger kinds a deployment fires.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '@kindgi/testing';
import type { ProjectId, TenantId, TriggerId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import { schedulesRouter } from '../src/routes/schedules.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const TOKEN = 'schedules-token';
const PROJECT = randomUUID() as ProjectId;
const auth = { authorization: `Bearer ${TOKEN}` };
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId } : null;
const runHandler = {} as RunHandlerBinding;

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { ...auth, ...(body !== undefined && { 'content-type': 'application/json' }) },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

function app(triggerKinds?: readonly ('cron' | 'event' | 'webhook')[]) {
  const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT });
  const built = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    triggerRegistry: registry,
    ...(triggerKinds !== undefined && { triggerKinds }),
  });
  return { built, registry };
}

const nightly = {
  flowId: 'acme.nightly',
  flowVersion: '1.0.0',
  config: { cronExpression: '0 2 * * *', timezone: 'America/Toronto', input: { batch: 'all' } },
};

describe('registering a schedule', () => {
  test('a flow schedule: its owner is the caller, with the default policies', async () => {
    const { built } = app();
    const res = await built.request('/v1/schedules', send('POST', nightly));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      flowId: 'acme.nightly',
      flowVersion: '1.0.0',
      projectId: PROJECT,
      owner: { kind: 'user', id: userId },
      cronExpression: '0 2 * * *',
      timezone: 'America/Toronto',
      input: { batch: 'all' },
      catchUp: 'latest',
      overlap: 'skip',
      startingDeadlineSeconds: 600,
      status: 'active',
    });
    expect(body.scheduleId).toBe(body.triggerId);
    expect(body).not.toHaveProperty('agentId');
  });

  test('an agent schedule, at a version or live, with its own policies', async () => {
    const { built } = app();
    const res = await built.request(
      '/v1/schedules',
      send('POST', {
        agentId: 'acme.digest',
        config: { cronExpression: '0 7 * * 1-5', input: { userMessage: 'Morning digest' } },
        catchUp: 'skip',
        overlap: 'allow',
        startingDeadlineSeconds: 120,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      agentId: 'acme.digest',
      catchUp: 'skip',
      overlap: 'allow',
      startingDeadlineSeconds: 120,
    });
    expect(body).not.toHaveProperty('agentVersion');
    expect(body).not.toHaveProperty('flowId');
  });

  test.each([
    [{ ...nightly, agentId: 'acme.digest' }, 'one of them'],
    [{ ...nightly, flowVersion: undefined }, '`flowVersion` is required'],
    [{ agentId: 'a', flowVersion: '1.0.0', config: nightly.config }, 'goes with `flowId`'],
    [{ ...nightly, catchUp: 'all' }, '`catchUp` must be'],
    [{ ...nightly, overlap: 'cancel' }, '`overlap` must be'],
    [{ ...nightly, startingDeadlineSeconds: 0 }, '`startingDeadlineSeconds`'],
    [{ ...nightly, projectId: 'nope' }, '`projectId`'],
    [{ flowId: 'acme.nightly', flowVersion: '1.0.0' }, '`config.cronExpression` is required'],
    [
      { agentId: 'acme.digest', config: { cronExpression: '0 7 * * *' } },
      '`config.input.userMessage`',
    ],
    [
      { agentId: 'acme.digest', config: { cronExpression: '0 7 * * *', input: { batch: 'all' } } },
      '`config.input.userMessage`',
    ],
  ])('a bad body is a 400: %j', async (body, message) => {
    const res = await app().built.request('/v1/schedules', send('POST', body));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(message);
  });
});

const ACME = { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] };
const hourly = {
  improve: { agentId: 'acme.scorer', scope: ACME },
  config: { cronExpression: '0 * * * *' },
};

describe('an improve schedule', () => {
  test("registers in its scope's project, with the pass options' defaults kept on it", async () => {
    const { built } = app();
    const res = await built.request('/v1/schedules', send('POST', hourly));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      improve: { agentId: 'acme.scorer', scope: ACME },
      projectId: PROJECT,
      input: {
        tiers: ['settings'],
        objective: 'weightedYesShare',
        classWeights: 'restricted-only',
        budget: { maxCostUsd: 5, maxCandidates: 30 },
        threshold: { judgments: 5, runs: 3, judges: 2 },
        monthlyCapUsd: 20,
      },
    });
    expect(body).not.toHaveProperty('agentId');
    expect(body).not.toHaveProperty('flowId');
  });

  test('a prompt improve schedule keeps its model, and its own threshold and cap', async () => {
    const res = await app().built.request(
      '/v1/schedules',
      send('POST', {
        ...hourly,
        config: {
          cronExpression: '0 */6 * * *',
          input: {
            tiers: ['prompt'],
            model: { providerId: 'acme-llm', model: 'm-1' },
            threshold: { judgments: 10, runs: 4, judges: 3 },
            monthlyCapUsd: 50,
          },
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { input: unknown }).input).toMatchObject({
      tiers: ['prompt'],
      model: { providerId: 'acme-llm', model: 'm-1' },
      candidates: 3,
      threshold: { judgments: 10, runs: 4, judges: 3 },
      monthlyCapUsd: 50,
    });
  });

  test.each([
    [{ ...hourly, agentId: 'acme.digest' }, 'one of them'],
    [{ ...hourly, improve: { agentId: 'acme.scorer' } }, '`improve.scope`'],
    [{ ...hourly, agentVersion: '1.0.0' }, "don't go with it"],
    [
      { ...hourly, improve: { agentId: 'acme.scorer', scope: { kind: 'org', orgId: PROJECT } } },
      'an org spans several',
    ],
    [{ ...hourly, projectId: randomUUID() }, "in the schedule's project"],
    [
      {
        ...hourly,
        config: { cronExpression: '0 * * * *', input: { threshold: { judgments: 2, runs: 3 } } },
      },
      '`threshold`',
    ],
    [
      { ...hourly, config: { cronExpression: '0 * * * *', input: { tiers: ['prompt'] } } },
      '`model` is required',
    ],
    [
      { ...hourly, config: { cronExpression: '0 * * * *', input: { monthlyCapUsd: 0 } } },
      '`monthlyCapUsd`',
    ],
    [
      { ...hourly, config: { cronExpression: '0 * * * *', input: { suiteId: 'x' } } },
      "`suiteId` isn't an option",
    ],
  ])('a bad improve body is a 400: %j', async (body, message) => {
    const res = await app().built.request('/v1/schedules', send('POST', body));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(message);
  });

  test('its fires show the pass each started; a skipped fire says which count was short', async () => {
    const { built, registry } = app();
    const id = (
      (await (await built.request('/v1/schedules', send('POST', hourly))).json()) as {
        scheduleId: string;
      }
    ).scheduleId;
    const passId = randomUUID();
    registry.recordFire({
      triggerId: id as TriggerId,
      kind: 'schedule',
      scheduledFor: '2026-10-07T10:00:00.000Z',
      firedAt: '2026-10-07T10:00:01.000Z',
      outcome: 'skipped',
      detail: '4 of 5 trusted "no" judgments since 2026-10-07T09:00:00.000Z (3 runs, 2 judges)',
    });
    registry.recordFire({
      triggerId: id as TriggerId,
      kind: 'schedule',
      scheduledFor: '2026-10-07T11:00:00.000Z',
      firedAt: '2026-10-07T11:00:01.000Z',
      outcome: 'started',
      passId,
    });
    const fires = (await (
      await built.request(`/v1/schedules/${id}/fires`, send('GET'))
    ).json()) as {
      data: Record<string, unknown>[];
    };
    expect(fires.data.map((f) => f.outcome).sort()).toEqual(['skipped', 'started']);
    expect(fires.data.find((f) => f.outcome === 'started')).toMatchObject({ passId });
    expect(fires.data.find((f) => f.outcome === 'skipped')?.detail).toContain('4 of 5');
  });

  test('retargeting an agent schedule to improve needs pass options, not a user message', async () => {
    const { built } = app();
    const created = await built.request(
      '/v1/schedules',
      send('POST', {
        agentId: 'acme.digest',
        projectId: PROJECT,
        config: { cronExpression: '0 7 * * *', input: { userMessage: 'Morning digest' } },
      }),
    );
    const id = ((await created.json()) as { scheduleId: string }).scheduleId;
    const kept = await built.request(
      `/v1/schedules/${id}`,
      send('PATCH', { improve: hourly.improve }),
    );
    expect(kept.status).toBe(400);
    expect(JSON.stringify(await kept.json())).toContain("`userMessage` isn't an option");
    const moved = await built.request(
      `/v1/schedules/${id}`,
      send('PATCH', { improve: hourly.improve, config: { input: {} } }),
    );
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({
      improve: { agentId: 'acme.scorer' },
      input: { threshold: { judgments: 5, runs: 3, judges: 2 } },
    });
  });
});

describe("a schedule's life", () => {
  async function registered() {
    const h = app();
    const res = await h.built.request('/v1/schedules', send('POST', nightly));
    const id = ((await res.json()) as { scheduleId: string }).scheduleId;
    return { ...h, id };
  }

  test('get with its next occurrences asked for; update retargets it to an agent', async () => {
    const { built, id } = await registered();
    expect((await built.request(`/v1/schedules/${id}?upcoming=3`, send('GET'))).status).toBe(200);
    expect((await built.request(`/v1/schedules/${id}?upcoming=21`, send('GET'))).status).toBe(400);
    const patched = await built.request(
      `/v1/schedules/${id}`,
      send('PATCH', {
        agentId: 'acme.digest',
        agentVersion: '2.1.0',
        overlap: 'allow',
        config: { input: { userMessage: 'Nightly digest' } },
      }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      agentId: 'acme.digest',
      agentVersion: '2.1.0',
      overlap: 'allow',
      cronExpression: '0 2 * * *',
      input: { userMessage: 'Nightly digest' },
    });
  });

  test("an agent schedule's input keeps a user message: retargeting or patching without one is a 400", async () => {
    const { built, id } = await registered();
    // The flow's input has no user message; an agent can't run on it.
    const retarget = await built.request(
      `/v1/schedules/${id}`,
      send('PATCH', { agentId: 'acme.digest' }),
    );
    expect(retarget.status).toBe(400);
    expect(JSON.stringify(await retarget.json())).toContain('`config.input.userMessage`');
    const ok = await built.request(
      `/v1/schedules/${id}`,
      send('PATCH', { agentId: 'acme.digest', config: { input: { userMessage: 'hi' } } }),
    );
    expect(ok.status).toBe(200);
    const cleared = await built.request(
      `/v1/schedules/${id}`,
      send('PATCH', { config: { input: {} } }),
    );
    expect(cleared.status).toBe(400);
    // Other fields patch as before.
    expect(
      (await built.request(`/v1/schedules/${id}`, send('PATCH', { label: 'digest' }))).status,
    ).toBe(200);
  });

  test('pause, resume, unregister; then it is gone', async () => {
    const { built, id } = await registered();
    expect((await built.request(`/v1/schedules/${id}/pause`, send('POST'))).status).toBe(200);
    expect((await built.request(`/v1/schedules/${id}/pause`, send('POST'))).status).toBe(409);
    expect((await built.request(`/v1/schedules/${id}/resume`, send('POST'))).status).toBe(200);
    const gone = await built.request(`/v1/schedules/${id}/unregister`, send('POST'));
    expect(await gone.json()).toEqual({ scheduleId: id, unregistered: true });
    expect((await built.request(`/v1/schedules/${id}`, send('GET'))).status).toBe(404);
  });

  test('fires newest first; run-now records a manual fire; taking ownership', async () => {
    const { built, registry, id } = await registered();
    registry.recordFire({
      triggerId: id as TriggerId,
      kind: 'schedule',
      scheduledFor: '2026-10-07T06:00:00.000Z',
      firedAt: '2026-10-07T06:00:01.000Z',
      outcome: 'started',
      runId: randomUUID(),
      missedCount: 9,
    });
    const now = await built.request(`/v1/schedules/${id}/run-now`, send('POST'));
    expect(now.status).toBe(202);
    expect(await now.json()).toMatchObject({ scheduleId: id, outcome: 'pending', manual: true });

    const fires = await built.request(`/v1/schedules/${id}/fires`, send('GET'));
    const page = (await fires.json()) as { data: Record<string, unknown>[] };
    expect(page.data.map((f) => f.manual ?? false)).toEqual([true, false]);
    expect(page.data[1]).toMatchObject({ outcome: 'started', missedCount: 9 });

    const owned = await built.request(`/v1/schedules/${id}/owner`, send('POST'));
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({ owner: { kind: 'user', id: userId } });
  });

  test("another kind's trigger is not found here, and every lifecycle route checks it", async () => {
    const { built, registry } = app();
    const event = await registry.register({
      kind: 'event',
      tenantId,
      flowId: 'acme.react',
      flowVersion: '1.0.0',
      config: { eventKind: 'run.finished' },
    });
    if (event.kind === 'err') throw new Error(event.error.message);
    const id = event.value.triggerId;
    for (const [method, path] of [
      ['GET', ''],
      ['POST', '/pause'],
      ['POST', '/resume'],
      ['POST', '/unregister'],
      ['GET', '/fires'],
      ['POST', '/run-now'],
      ['POST', '/owner'],
    ] as const) {
      const res = await built.request(`/v1/schedules/${id}${path}`, send(method));
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await registry.get({ tenantId, triggerId: id }))?.status).toBe('active');
  });
});

describe('mounting', () => {
  test('a deployment that fires only schedules mounts only /v1/schedules', async () => {
    const { built } = app(['cron']);
    expect((await built.request('/v1/schedules', send('GET'))).status).toBe(200);
    expect((await built.request('/v1/event-triggers', send('GET'))).status).toBe(404);
    expect((await built.request('/v1/webhooks', send('GET'))).status).toBe(404);
  });

  test('without triggerKinds, all three mount, as before', async () => {
    const { built } = app();
    expect((await built.request('/v1/event-triggers', send('GET'))).status).toBe(200);
    expect((await built.request('/v1/webhooks', send('GET'))).status).toBe(200);
  });
});

describe('what each route asks the authorizer', () => {
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

  async function mounted() {
    const checked: string[] = [];
    const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT });
    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-schedules' as never);
      return next();
    });
    r.route('/', schedulesRouter(registry, recordingAuthorizer(checked)));
    const created = await r.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...nightly, projectId: PROJECT }),
    });
    const id = ((await created.json()) as { scheduleId: string }).scheduleId;
    return { r, id, checked };
  }

  test('registering an improve schedule: write on the project and publish on the agent', async () => {
    const checked: string[] = [];
    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-schedules' as never);
      return next();
    });
    r.route(
      '/',
      schedulesRouter(
        createInMemoryTriggerRegistry({ defaultProjectId: PROJECT }),
        recordingAuthorizer(checked),
      ),
    );
    const res = await r.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hourly),
    });
    expect(res.status).toBe(201);
    expect(checked).toEqual([`write project:${PROJECT}`, 'publish agent:acme.scorer']);
  });

  test('registering: write on the project and execute on what it runs', async () => {
    const { checked } = await mounted();
    expect(checked).toEqual([`write project:${PROJECT}`, 'execute flow:acme.nightly']);
  });

  test("registering with no project: write on the tenant's Default project, and it's stored there", async () => {
    const DEFAULT = randomUUID();
    for (const [projects, expected] of [
      [{ getDefault: async () => ({ id: DEFAULT }) as never }, `write project:${DEFAULT}`],
      // No Default to find: only a tenant admin may let the registry pick.
      [undefined, `admin tenant:${tenantId}`],
    ] as const) {
      const checked: string[] = [];
      const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT });
      const r = new Hono<AppEnv>();
      r.use('*', async (c, next) => {
        c.set('tenantId' as never, tenantId as never);
        c.set('requestId' as never, 'req-schedules' as never);
        return next();
      });
      r.route('/', schedulesRouter(registry, recordingAuthorizer(checked), projects));
      const res = await r.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nightly),
      });
      expect(res.status).toBe(201);
      expect(checked[0]).toBe(expected);
      if (projects !== undefined) {
        expect(((await res.json()) as { projectId: string }).projectId).toBe(DEFAULT);
      }
    }
  });

  test.each([
    ['GET', '', undefined, ['read']],
    ['PATCH', '', { label: 'x' }, ['write']],
    ['PATCH', '', { agentId: 'acme.digest' }, ['write', 'execute agent:acme.digest']],
    ['POST', '/pause', undefined, ['write']],
    ['POST', '/unregister', undefined, ['write']],
    ['GET', '/fires', undefined, ['read']],
    ['POST', '/run-now', undefined, ['write']],
    ['POST', '/owner', undefined, ['admin', 'execute flow:acme.nightly']],
  ])('%s %s → %j', async (method, path, body, expected) => {
    const { r, id, checked } = await mounted();
    checked.length = 0;
    await r.request(`/${id}${path}`, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    expect(checked).toEqual(expected.map((e) => (e.includes(' ') ? e : `${e} project:${PROJECT}`)));
  });
});

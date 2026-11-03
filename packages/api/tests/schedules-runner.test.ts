// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's runner keeps their own schedules: with `run` on the project, a
 * person registers a schedule of their own, and changes, pauses, resumes,
 * runs now and unregisters it. Anyone else's schedule, a shared one, an
 * Improve one, naming who its runs act as (`runAsServiceAccountId`,
 * `runAsProject`) and its tools allowed unattended take what they took
 * before. A webhook trigger's owner still needs `write`. A person who may
 * run the project only because everyone in its workspace may (no `read`)
 * sees their own personal schedule in the list and by id, and no one
 * else's.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  FlowRegistryBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID() as ProjectId;
/** Runners of the project. */
const RUE = randomUUID() as UserId;
const RAY = randomUUID() as UserId;
/** An editor, an admin and a viewer of the project. */
const EDIE = randomUUID() as UserId;
const ADA = randomUUID() as UserId;
const VIC = randomUUID() as UserId;
/** Two people everyone in the workspace lets run the project: no `read`. */
const BEA = randomUUID() as UserId;
const BEN = randomUUID() as UserId;
const BOT = 'sa-nightly';

type Role = 'everyone' | 'viewer' | 'runner' | 'editor' | 'admin';
const RUNS: readonly Action[] = ['read', 'run', 'execute', 'call'];
const WRITES: readonly Action[] = [...RUNS, 'write', 'publish'];
const ALLOWS: Record<Role, readonly Action[]> = {
  everyone: ['run', 'execute', 'call'],
  viewer: ['read'],
  runner: RUNS,
  editor: WRITES,
  admin: [...WRITES, 'admin', 'act_as'],
};

function decide(
  roles: Map<string, Role>,
  principal: unknown,
  action: Action,
  resource: ResourceRef,
): Decision {
  const actor = (principal as { actor?: { id?: string } }).actor?.id;
  const role = actor === undefined ? undefined : roles.get(actor);
  const allowed = role !== undefined && ALLOWS[role].includes(action);
  return {
    allowed,
    reason: allowed ? 'test: granted' : `test: ${action} not granted`,
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

const TOKENS: Record<string, Awaited<ReturnType<TokenResolver>>> = {
  rue: { tenantId, userId: RUE, scopes: [] },
  ray: { tenantId, userId: RAY, scopes: [] },
  edie: { tenantId, userId: EDIE, scopes: [] },
  ada: { tenantId, userId: ADA, scopes: [] },
  vic: { tenantId, userId: VIC, scopes: [] },
  bea: { tenantId, userId: BEA, scopes: [] },
  ben: { tenantId, userId: BEN, scopes: [] },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;

const flowRegistry = {
  get: async ({ flowId }: { flowId: string }) =>
    flowId === 'acme.orders' || flowId === 'acme.refunds' ? { id: flowId, nodes: [] } : null,
  getVersion: async ({ flowId, version }: { flowId: string; version: string }) =>
    (flowId === 'acme.orders' || flowId === 'acme.refunds') && version === '1.0.0'
      ? { id: flowId, version, nodes: [{ id: 'refund', kind: 'tool', ref: 'acme.refund' }] }
      : null,
} as unknown as FlowRegistryBinding;

const serviceAccountBinding = {
  get: async ({ serviceAccountId }: { serviceAccountId: string }) =>
    serviceAccountId === BOT
      ? { serviceAccountId, tenantId, name: 'acme-nightly-bot', grants: [], createdAt: '' }
      : null,
} as unknown as ServiceAccountBinding;

function harness() {
  const roles = new Map<string, Role>([
    [RUE, 'runner'],
    [RAY, 'runner'],
    [EDIE, 'editor'],
    [ADA, 'admin'],
    [VIC, 'viewer'],
    [BEA, 'everyone'],
    [BEN, 'everyone'],
    [BOT, 'editor'],
  ]);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: createInMemoryTriggerRegistry({ defaultProjectId: PROJECT }),
    flowRegistry,
    serviceAccountBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (p, action, resource) => decide(roles, p, action, resource),
        checkBatch: async (p, action, resources) =>
          resources.map((resource) => decide(roles, p, action, resource)),
      } satisfies AuthzCheckBinding,
    },
  });
  const call = async (method: string, path: string, body?: unknown, token = 'rue') => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  /** The schedules in the project, as its admin lists them. */
  const listed = async () =>
    ((await call('GET', '/v1/schedules', undefined, 'ada')).body.data as unknown[]).length;
  return { call, roles, listed };
}
type Harness = ReturnType<typeof harness>;

const schedule = (over: Record<string, unknown> = {}) => ({
  flowId: 'acme.orders',
  flowVersion: '1.0.0',
  projectId: PROJECT,
  label: 'nightly',
  config: { cronExpression: '0 2 * * *', input: { region: 'eu' } },
  ...over,
});
const improve = {
  improve: { agentId: 'acme.scorer', projectId: PROJECT },
  config: { cronExpression: '0 * * * *' },
};

/** A schedule `token` registered, by id. */
async function made(h: Harness, token: string, body: Record<string, unknown> = schedule()) {
  const res = await h.call('POST', '/v1/schedules', body, token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.scheduleId as string;
}

/** Every change to a schedule, with the status it answers when allowed. */
const CHANGES: [string, string, unknown, number][] = [
  ['PATCH its label', '', { label: 'nightly, EU' }, 200],
  ['PATCH its cron line', '', { config: { cronExpression: '0 3 * * *' } }, 200],
  ['pause', '/pause', undefined, 200],
  ['resume', '/resume', undefined, 200],
  ['run now', '/run-now', undefined, 202],
  ['unregister', '/unregister', undefined, 200],
];
const send = (h: Harness, id: string, change: (typeof CHANGES)[number], token: string) =>
  h.call(change[1] === '' ? 'PATCH' : 'POST', `/v1/schedules/${id}${change[1]}`, change[2], token);

describe('a runner registers a schedule of their own', () => {
  test('201, owned by them', async () => {
    const h = harness();
    const res = await h.call('POST', '/v1/schedules', schedule());
    expect(res.status).toBe(201);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: RUE });
  });

  test('a viewer registers none: 403', async () => {
    const h = harness();
    expect((await h.call('POST', '/v1/schedules', schedule(), 'vic')).status).toBe(403);
    expect(await h.listed()).toBe(0);
  });

  test.each([
    ['`runAsServiceAccountId`', { runAsServiceAccountId: BOT }],
    ['`runAsProject`', { runAsProject: true }],
    ['`toolsAllowedUnattended`', { toolsAllowedUnattended: ['acme.refund'] }],
  ])('naming %s is a 403, and registers nothing', async (_name, over) => {
    const h = harness();
    const res = await h.call('POST', '/v1/schedules', schedule(over));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('permission-denied');
    expect(await h.listed()).toBe(0);
  });

  test('an Improve schedule is a 403: it takes write', async () => {
    const h = harness();
    const res = await h.call('POST', '/v1/schedules', improve);
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ action: 'write' });
    expect(await h.listed()).toBe(0);
  });
});

describe('a runner keeps their own schedule', () => {
  test.each(CHANGES)('%s: allowed', async (...change) => {
    const h = harness();
    const id = await made(h, 'rue');
    if (change[1] === '/resume')
      await h.call('POST', `/v1/schedules/${id}/pause`, undefined, 'rue');
    const res = await send(h, id, change, 'rue');
    expect(res.status, JSON.stringify(res.body)).toBe(change[3]);
  });

  test('retargets it to another flow it runs', async () => {
    const h = harness();
    const id = await made(h, 'rue');
    const res = await h.call('PATCH', `/v1/schedules/${id}`, {
      flowId: 'acme.refunds',
      flowVersion: '1.0.0',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ flowId: 'acme.refunds', owner: { kind: 'user', id: RUE } });
  });

  test('retargeting it to an Improve run takes write: 403', async () => {
    const h = harness();
    const id = await made(h, 'rue');
    const res = await h.call('PATCH', `/v1/schedules/${id}`, { improve: improve.improve });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ action: 'write' });
  });

  test('its tools allowed unattended still take a project admin', async () => {
    const h = harness();
    const id = await made(h, 'rue');
    const res = await h.call('PATCH', `/v1/schedules/${id}`, {
      toolsAllowedUnattended: ['acme.refund'],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ action: 'admin' });
  });

  test('taking it over still takes a project admin', async () => {
    const h = harness();
    const id = await made(h, 'rue');
    expect((await h.call('POST', `/v1/schedules/${id}/owner`, {})).status).toBe(403);
  });

  test('a runner who lost `run` keeps none of it', async () => {
    const h = harness();
    const id = await made(h, 'rue');
    h.roles.set(RUE, 'viewer');
    for (const change of CHANGES) {
      expect((await send(h, id, change, 'rue')).status, change[0]).toBe(403);
    }
  });
});

describe("a runner can't touch a schedule that isn't theirs", () => {
  test("another runner's personal schedule: write's 403 for every change, naming no owner", async () => {
    const h = harness();
    const id = await made(h, 'ray');
    for (const change of CHANGES) {
      const res = await send(h, id, change, 'rue');
      expect(res.status, change[0]).toBe(403);
      expect(res.body.error.details, change[0]).toMatchObject({ action: 'write' });
    }
    // Still its owner's.
    expect((await h.call('POST', `/v1/schedules/${id}/pause`, undefined, 'ray')).status).toBe(200);
  });

  test('a shared schedule: 403 for every change', async () => {
    const h = harness();
    const id = await made(h, 'ada', schedule({ runAsServiceAccountId: BOT }));
    for (const change of CHANGES) {
      expect((await send(h, id, change, 'rue')).status, change[0]).toBe(403);
    }
  });

  test('an Improve schedule they own (made as an editor): 403 for every change', async () => {
    const h = harness();
    const id = await made(h, 'edie', improve);
    h.roles.set(EDIE, 'runner');
    for (const change of CHANGES.filter((c) => c[1] !== '/run-now')) {
      const body = change[1] === '' ? { label: 'hourly' } : change[2];
      const res = await send(h, id, [change[0], change[1], body, change[3]], 'edie');
      expect(res.status, change[0]).toBe(403);
    }
    expect((await h.call('POST', `/v1/schedules/${id}/run-now`, undefined, 'edie')).status).toBe(
      403,
    );
  });
});

describe('a webhook trigger keeps write for its owner', () => {
  test('a runner who owns one (made as an editor) changes none of it', async () => {
    const h = harness();
    const made = await h.call(
      'POST',
      '/v1/webhooks',
      {
        flowId: 'acme.orders',
        flowVersion: '1.0.0',
        projectId: PROJECT,
        label: 'refunds',
        hmacSecretName: 'acme-hmac',
        config: { input: { region: 'eu' } },
      },
      'edie',
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.triggerId as string;
    h.roles.set(EDIE, 'runner');
    expect((await h.call('PATCH', `/v1/webhooks/${id}`, { label: 'x' }, 'edie')).status).toBe(403);
    for (const verb of ['pause', 'unregister']) {
      expect((await h.call('POST', `/v1/webhooks/${id}/${verb}`, undefined, 'edie')).status).toBe(
        403,
      );
    }
  });
});

describe("a person everyone may run sees their own schedule, and no one else's", () => {
  test('by id: their own; read refused, then run allowed', async () => {
    const h = harness();
    const own = await made(h, 'bea');
    const res = await h.call('GET', `/v1/schedules/${own}`, undefined, 'bea');
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: BEA });
  });

  test("by id: another person's, a runner's and a shared one are read's 403", async () => {
    const h = harness();
    await made(h, 'bea');
    for (const id of [
      await made(h, 'ben'),
      await made(h, 'rue'),
      await made(h, 'ada', schedule({ runAsServiceAccountId: BOT })),
    ]) {
      const res = await h.call('GET', `/v1/schedules/${id}`, undefined, 'bea');
      expect(res.status).toBe(403);
      expect(res.body.error.details).toMatchObject({ action: 'read' });
    }
  });

  test("their own schedule's fires and versions stay closed", async () => {
    const h = harness();
    const own = await made(h, 'bea');
    for (const tail of ['/fires', '/versions', '/versions/1']) {
      expect((await h.call('GET', `/v1/schedules/${own}${tail}`, undefined, 'bea')).status).toBe(
        403,
      );
    }
  });

  test("the list holds their own and no one else's, with the project filter too", async () => {
    const h = harness();
    await made(h, 'ben');
    const own = await made(h, 'bea');
    await made(h, 'rue');
    for (const path of ['/v1/schedules', `/v1/schedules?projectId=${PROJECT}`]) {
      const res = await h.call('GET', path, undefined, 'bea');
      expect(res.status).toBe(200);
      expect((res.body.data as { scheduleId: string }[]).map((s) => s.scheduleId)).toEqual([own]);
    }
    // A viewer of no project, and nobody everyone lets run it: the filter's 403.
    h.roles.delete(BEA);
    expect(
      (await h.call('GET', `/v1/schedules?projectId=${PROJECT}`, undefined, 'bea')).status,
    ).toBe(403);
  });

  test("a page of only another person's answers no rows and the next cursor; following it reaches theirs", async () => {
    const h = harness();
    await made(h, 'ben');
    const own = await made(h, 'bea');
    const first = await h.call('GET', '/v1/schedules?limit=1', undefined, 'bea');
    expect(first.body.data).toEqual([]);
    expect(first.body.hasMore).toBe(true);
    const next = first.body.nextCursor as string;
    const second = await h.call('GET', `/v1/schedules?limit=1&cursor=${next}`, undefined, 'bea');
    expect((second.body.data as { scheduleId: string }[]).map((s) => s.scheduleId)).toEqual([own]);
    expect(second.body.hasMore).toBe(false);
  });
});

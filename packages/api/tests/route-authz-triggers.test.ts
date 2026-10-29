// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Trigger routes and authorization.
 *
 * Event triggers (T243 A): the flow a trigger fires decides who may see or
 * change it (an event trigger has no parent tuple of its own). `read` on
 * the flow to list or get it; `write` to pause, resume or unregister it;
 * `write` and `execute` to register it or change it, since it starts runs
 * of the flow.
 *
 * Webhook triggers, as schedules: their project decides. `read` on it to
 * list, get or read the deliveries; `write` to change, pause, resume or
 * unregister; `admin` to take ownership. Registering, changing the flow
 * version, or taking ownership also needs `execute` on the flow, as
 * starting its run does.
 *
 * A trigger that isn't there is the handler's 404, with nothing asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
  TriggerRegistryBinding,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-triggers';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const MINE = 'acme.mine';
const THEIRS = 'acme.theirs';

type Kind = 'event' | 'webhook';

function record(kind: Kind, triggerId: string, flowId: string) {
  return {
    kind,
    triggerId,
    tenantId,
    flowId,
    flowVersion: '1.0.0',
    config: kind === 'event' ? { eventKind: 'acme.happened' } : {},
    ...(kind === 'webhook' && { webhookId: randomUUID(), hmacSecretName: 'acme-hmac' }),
    label: null,
    status: 'active',
    lastFiredAt: null,
    createdAt: '2026-10-08T08:00:00.000Z',
    updatedAt: '2026-10-08T08:00:00.000Z',
  };
}

function harness(kind: Kind, grants: readonly string[]) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const rows = [record(kind, 't-mine', MINE), record(kind, 't-theirs', THEIRS)];
  const byId = (id: string) => rows.find((r) => r.triggerId === id) ?? null;
  const ok = (value: unknown) => ({ kind: 'ok', value });
  const triggers = {
    list: async () => ({ data: rows }),
    get: async ({ triggerId }: { triggerId: string }) => byId(triggerId),
    register: async (input: { flowId: string }) => ok(record(kind, 't-new', input.flowId)),
    update: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    pause: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    resume: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    unregister: async () => ({ unregistered: true }),
  } as unknown as TriggerRegistryBinding;
  const app = createApp({
    ...createStubAppBindings(),
    triggerRegistry: triggers,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const base = kind === 'event' ? '/v1/event-triggers' : '/v1/webhooks';
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const registerBody = (flowId: string) =>
    kind === 'event'
      ? { flowId, flowVersion: '1.0.0', config: { eventKind: 'acme.happened' } }
      : { flowId, flowVersion: '1.0.0', hmacSecretName: 'acme-hmac' };
  return { call, asked, registerBody };
}

const READ_MINE = `read flow:${MINE}`;
const WRITE_MINE = `write flow:${MINE}`;
const EXECUTE_MINE = `execute flow:${MINE}`;

describe.each([['event']] as const)('%s triggers: the flow decides', (kind) => {
  test('the list holds only triggers of flows the caller may read', async () => {
    const { call } = harness(kind, [READ_MINE]);
    const res = await call('GET', '');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { triggerId: string }[] }).data.map(
      (t) => t.triggerId,
    );
    expect(ids).toEqual(['t-mine']);
  });

  test('registering needs `write` and `execute` on the flow', async () => {
    const both = harness(kind, [WRITE_MINE, EXECUTE_MINE]);
    expect((await both.call('POST', '', both.registerBody(MINE))).status).toBe(201);
    expect((await both.call('POST', '', both.registerBody(THEIRS))).status).toBe(403);

    const writeOnly = harness(kind, [WRITE_MINE]);
    expect((await writeOnly.call('POST', '', writeOnly.registerBody(MINE))).status).toBe(403);
    expect(writeOnly.asked).toEqual([WRITE_MINE, EXECUTE_MINE]);
  });

  test('reading one needs `read` on its flow', async () => {
    const { call } = harness(kind, [READ_MINE]);
    expect((await call('GET', '/t-mine')).status).toBe(200);
    expect((await call('GET', '/t-theirs')).status).toBe(403);
  });

  test('changing one needs `write` and `execute`; pausing, resuming and unregistering `write`', async () => {
    const writer = harness(kind, [WRITE_MINE]);
    expect((await writer.call('PATCH', '/t-mine', { label: 'x' })).status).toBe(403);
    for (const action of ['pause', 'resume', 'unregister']) {
      expect((await writer.call('POST', `/t-mine/${action}`)).status, action).toBe(200);
      expect((await writer.call('POST', `/t-theirs/${action}`)).status, action).toBe(403);
    }

    const both = harness(kind, [WRITE_MINE, EXECUTE_MINE]);
    expect((await both.call('PATCH', '/t-mine', { label: 'x' })).status).toBe(200);
    expect((await both.call('PATCH', '/t-theirs', { label: 'x' })).status).toBe(403);
  });

  test("a trigger that isn't there is the handler's 404, with nothing asked", async () => {
    const { call, asked } = harness(kind, []);
    expect((await call('GET', '/t-missing')).status).toBe(404);
    expect(asked).toEqual([]);
  });
});

// ---------- webhook triggers: the project decides ----------

const P_MINE = '00000000-0000-4000-8000-00000000a001';
const P_THEIRS = '00000000-0000-4000-8000-00000000a002';
const T_MINE = '00000000-0000-4000-8000-00000000b001';
const T_THEIRS = '00000000-0000-4000-8000-00000000b002';
const BOT = '00000000-0000-4000-8000-00000000c001';

function webhookRecord(triggerId: string, flowId: string, projectId: string) {
  return {
    kind: 'webhook',
    triggerId,
    tenantId,
    flowId,
    flowVersion: '1.0.0',
    projectId,
    owner: { kind: 'user', id: 'user-1' },
    config: {},
    webhookId: randomUUID(),
    hmacSecretName: 'acme-hmac',
    signature: { kind: 'hmac-sha256', encoding: 'hex', header: 'X-Kindgi-Signature' },
    bodyLimitBytes: 262144,
    rateLimitPerMinute: 600,
    label: null,
    status: 'active',
    lastFiredAt: null,
    createdAt: '2026-10-10T08:00:00.000Z',
    updatedAt: '2026-10-10T08:00:00.000Z',
  };
}

function webhookHarness(grants: readonly string[]) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const rows = [webhookRecord(T_MINE, MINE, P_MINE), webhookRecord(T_THEIRS, THEIRS, P_THEIRS)];
  const byId = (id: string) => rows.find((r) => r.triggerId === id) ?? null;
  const ok = (value: unknown) => ({ kind: 'ok', value });
  const triggers = {
    list: async () => ({ data: rows }),
    get: async ({ triggerId }: { triggerId: string }) => byId(triggerId),
    register: async (input: { flowId: string; projectId: string; owner?: unknown }) =>
      ok({
        ...webhookRecord(randomUUID(), input.flowId, input.projectId),
        ...(input.owner !== undefined && { owner: input.owner }),
      }),
    update: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    pause: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    resume: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    unregister: async () => ({ unregistered: true }),
    listFires: async () => ({ data: [] }),
    setOwner: async (input: { triggerId: string; owner?: unknown }) =>
      ok({ ...byId(input.triggerId), ...(input.owner !== undefined && { owner: input.owner }) }),
  } as unknown as TriggerRegistryBinding;
  const app = createApp({
    ...createStubAppBindings(),
    triggerRegistry: triggers,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    serviceAccountBinding: {
      get: async ({ serviceAccountId }: { serviceAccountId: string }) =>
        serviceAccountId === BOT
          ? { serviceAccountId, tenantId, name: 'acme-bot', grants: [], createdAt: '' }
          : null,
    } as unknown as ServiceAccountBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/v1/webhooks${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const registerBody = (flowId: string, projectId: string) => ({
    flowId,
    flowVersion: '1.0.0',
    hmacSecretName: 'acme-hmac',
    projectId,
  });
  return { app, call, asked, registerBody };
}

const READ_P = `read project:${P_MINE}`;
const WRITE_P = `write project:${P_MINE}`;
const ADMIN_P = `admin project:${P_MINE}`;

describe('webhook triggers: the project decides, as for schedules', () => {
  test('the list holds only triggers of projects the caller may read; a project filter needs `read` on it', async () => {
    const { call } = webhookHarness([READ_P]);
    const res = await call('GET', '');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { triggerId: string }[] }).data.map(
      (t) => t.triggerId,
    );
    expect(ids).toEqual([T_MINE]);
    expect((await call('GET', `?projectId=${P_THEIRS}`)).status).toBe(403);
  });

  test('registering needs `write` on the project and `execute` on the flow', async () => {
    const both = webhookHarness([WRITE_P, EXECUTE_MINE]);
    expect((await both.call('POST', '', both.registerBody(MINE, P_MINE))).status).toBe(201);
    expect((await both.call('POST', '', both.registerBody(MINE, P_THEIRS))).status).toBe(403);
    expect((await both.call('POST', '', both.registerBody(THEIRS, P_MINE))).status).toBe(403);

    const writeOnly = webhookHarness([WRITE_P]);
    expect((await writeOnly.call('POST', '', writeOnly.registerBody(MINE, P_MINE))).status).toBe(
      403,
    );
    expect(writeOnly.asked).toEqual([WRITE_P, EXECUTE_MINE]);
  });

  test('reading one, or its deliveries, needs `read` on its project', async () => {
    const { call } = webhookHarness([READ_P]);
    expect((await call('GET', `/${T_MINE}`)).status).toBe(200);
    expect((await call('GET', `/${T_MINE}/fires`)).status).toBe(200);
    expect((await call('GET', `/${T_THEIRS}`)).status).toBe(403);
    expect((await call('GET', `/${T_THEIRS}/fires`)).status).toBe(403);
  });

  test('changing, pausing, resuming and unregistering need `write`; a new flow version `execute` too', async () => {
    const writer = webhookHarness([WRITE_P]);
    expect((await writer.call('PATCH', `/${T_MINE}`, { label: 'x' })).status).toBe(200);
    expect((await writer.call('PATCH', `/${T_MINE}`, { flowVersion: '2.0.0' })).status).toBe(403);
    for (const action of ['pause', 'resume', 'unregister']) {
      expect((await writer.call('POST', `/${T_MINE}/${action}`)).status, action).toBe(200);
      expect((await writer.call('POST', `/${T_THEIRS}/${action}`)).status, action).toBe(403);
    }

    const both = webhookHarness([WRITE_P, EXECUTE_MINE]);
    expect((await both.call('PATCH', `/${T_MINE}`, { flowVersion: '2.0.0' })).status).toBe(200);
    expect((await both.call('PATCH', `/${T_THEIRS}`, { label: 'x' })).status).toBe(403);
  });

  test('taking ownership needs `write` and `admin` on the project and `execute` on the flow', async () => {
    const noWrite = webhookHarness([ADMIN_P, EXECUTE_MINE]);
    expect((await noWrite.call('POST', `/${T_MINE}/owner`)).status).toBe(403);
    expect(noWrite.asked).toEqual([WRITE_P]);
    const noExecute = webhookHarness([WRITE_P, ADMIN_P]);
    expect((await noExecute.call('POST', `/${T_MINE}/owner`)).status).toBe(403);
    expect(noExecute.asked).toEqual([WRITE_P, ADMIN_P, EXECUTE_MINE]);
    const all = webhookHarness([WRITE_P, ADMIN_P, EXECUTE_MINE]);
    expect((await all.call('POST', `/${T_MINE}/owner`)).status).toBe(200);
    const writer = webhookHarness([WRITE_P, EXECUTE_MINE]);
    expect((await writer.call('POST', `/${T_MINE}/owner`)).status).toBe(403);
  });

  test("a trigger that isn't there, or isn't a webhook trigger's id, is the handler's 404, with nothing asked", async () => {
    const { call, asked } = webhookHarness([]);
    expect((await call('GET', '/00000000-0000-4000-8000-00000000ffff')).status).toBe(404);
    expect((await call('GET', '/t-missing')).status).toBe(404);
    expect(asked).toEqual([]);
  });
});

// ---------- naming a service account as the owner (`runAsServiceAccountId`) ----------

const ACT_AS_BOT = `act_as service_account:${BOT}`;
const ownerOf = async (res: Response) =>
  ((await res.json()) as { owner?: { kind: string; id: string } }).owner;

describe('webhook triggers: naming a service account as owner needs `act_as` on it', () => {
  test('register: `act_as` withheld is a 403; held, the account owns the trigger', async () => {
    const withheld = webhookHarness([WRITE_P, EXECUTE_MINE]);
    const refused = await withheld.call('POST', '', {
      ...withheld.registerBody(MINE, P_MINE),
      runAsServiceAccountId: BOT,
    });
    expect(refused.status).toBe(403);
    expect(withheld.asked).toContain(ACT_AS_BOT);

    const held = webhookHarness([WRITE_P, EXECUTE_MINE, ACT_AS_BOT]);
    const ok = await held.call('POST', '', {
      ...held.registerBody(MINE, P_MINE),
      runAsServiceAccountId: BOT,
    });
    expect(ok.status).toBe(201);
    expect(await ownerOf(ok)).toMatchObject({ kind: 'service', id: BOT });
  });

  test('take-over: `act_as` withheld is a 403; held, the account owns it', async () => {
    const withheld = webhookHarness([WRITE_P, ADMIN_P, EXECUTE_MINE]);
    const refused = await withheld.call('POST', `/${T_MINE}/owner`, { runAsServiceAccountId: BOT });
    expect(refused.status).toBe(403);
    expect(withheld.asked).toContain(ACT_AS_BOT);

    const held = webhookHarness([WRITE_P, ADMIN_P, EXECUTE_MINE, ACT_AS_BOT]);
    const ok = await held.call('POST', `/${T_MINE}/owner`, { runAsServiceAccountId: BOT });
    expect(ok.status).toBe(200);
    expect(await ownerOf(ok)).toMatchObject({ kind: 'service', id: BOT });
  });

  test("a take-over body that isn't a JSON object with a service-account id is a 400", async () => {
    const h = webhookHarness([WRITE_P, ADMIN_P, EXECUTE_MINE]);
    const raw = (rawBody: string) =>
      h.app.request(`/v1/webhooks/${T_MINE}/owner`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: rawBody,
      });
    expect((await raw('not json{')).status).toBe(400); // not valid JSON
    expect((await raw('[1,2]')).status).toBe(400); // an array, not an object
    expect((await h.call('POST', `/${T_MINE}/owner`, { runAsServiceAccountId: 123 })).status).toBe(
      400,
    ); // not a string
    expect((await h.call('POST', `/${T_MINE}/owner`, { runAsServiceAccountId: '' })).status).toBe(
      400,
    ); // empty
  });
});

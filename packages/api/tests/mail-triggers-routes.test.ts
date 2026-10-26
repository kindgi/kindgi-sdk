// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Mail triggers (`/v1/mail-triggers`). A trigger is shared (a service
 * account owns it, on the company's mailbox) or personal (a person owns
 * it), and no edit moves the owner: only `POST …/owner` does. A personal
 * trigger's PATCH, pause, resume and unregister are its owner's or a
 * project admin's; the company's mailbox takes an admin; and
 * `toolsAllowedUnattended` is an admin's, named again for a new target or
 * mailbox. Driven through the app, with an authorizer that grants every
 * right but `admin`, which only Ada holds, and without one, where the
 * token's tenant-admin scope decides.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { ProjectId, TenantId, TriggerId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';
import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  FlowRegistryBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
/** A project admin, and a tenant admin. */
const ADA = randomUUID() as UserId;
/** A project writer: the person-mailbox triggers' owner. */
const WREN = randomUUID() as UserId;
/** Another project writer. */
const MILO = randomUUID() as UserId;
const BOT = 'sa-support';
const PROJECT = randomUUID() as ProjectId;

const TOKENS: Record<string, Awaited<ReturnType<TokenResolver>>> = {
  ada: { tenantId, userId: ADA, scopes: ['tenant-admin'] },
  wren: { tenantId, userId: WREN, scopes: [] },
  milo: { tenantId, userId: MILO, scopes: [] },
  bot: { tenantId, serviceAccountId: BOT as never },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;

/** Every right, but `admin` only for Ada. */
function decision(principal: unknown, action: Action, resource: ResourceRef): Decision {
  const actor = (principal as { actor?: { id?: string } }).actor?.id;
  const allowed = action !== 'admin' || actor === ADA;
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not an admin',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

const tool = (id: string) => ({ id });
const SUPPORT = { tools: [tool('acme.reply'), tool('acme.lookup')] };
const AGENTS: Record<string, Record<string, { tools: { id: string }[] }>> = {
  'acme.support': { latest: SUPPORT, '1.0.0': SUPPORT, '2.0.0': SUPPORT },
  'acme.triage': { latest: { tools: [tool('acme.lookup')] } },
};

const agentRegistry = {
  get: async ({ agentId }: { agentId: string }) => {
    const a = AGENTS[agentId]?.latest;
    return a === undefined ? null : { id: agentId, ...a };
  },
  getVersion: async ({ agentId, version }: { agentId: string; version: string }) => {
    const a = AGENTS[agentId]?.[version];
    return a === undefined ? null : { id: agentId, version, ...a };
  },
} as unknown as AgentRegistryBinding;

const flowRegistry = {
  get: async () => null,
  getVersion: async () => null,
} as unknown as FlowRegistryBinding;

const serviceAccountBinding = {
  get: async ({ serviceAccountId }: { serviceAccountId: string }) =>
    serviceAccountId === BOT
      ? { serviceAccountId, tenantId, name: 'acme-support-bot', grants: [], createdAt: '' }
      : null,
} as unknown as ServiceAccountBinding;

function harness(opts: { store?: boolean } = {}) {
  const written: AuditEvent[] = [];
  const store = createInMemoryAuditEventBinding();
  const auditEvents: typeof store = {
    ...store,
    append: async (events, ...rest) => {
      written.push(...events);
      return store.append(events, ...rest);
    },
  };
  const triggerRegistry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry,
    agentRegistry,
    flowRegistry,
    serviceAccountBinding,
    auditEvents,
    ...(opts.store !== false && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (p, action, resource) => decision(p, action, resource),
          checkBatch: async (p, action, resources) =>
            resources.map((resource) => decision(p, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (method: string, path: string, body?: unknown, token = 'ada') => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': 'req-mail',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const events = (kind: string): AuditEvent[] => written.filter((e) => e.kind === kind);
  return { call, events, triggerRegistry };
}

const docOf = (e: AuditEvent | undefined) =>
  (e?.payload as { doc?: Record<string, any> } | undefined)?.doc;

const BASE = '/v1/mail-triggers';

/** A trigger on the caller's own Gmail. */
const personal = (over: Record<string, unknown> = {}) => ({
  agentId: 'acme.support',
  projectId: PROJECT,
  config: { mailbox: { app: 'google', as: 'person' } },
  ...over,
});
/** A trigger on the company's Outlook mailbox. */
const company = (over: Record<string, unknown> = {}) => ({
  agentId: 'acme.support',
  projectId: PROJECT,
  config: { mailbox: { app: 'microsoft', as: 'company' } },
  ...over,
});

/** Wren's trigger on her own mailbox, and, when `tools` is given, the list Ada sets on it. */
async function wrensTrigger(
  h: ReturnType<typeof harness>,
  over: Record<string, unknown> = {},
  tools?: string[],
): Promise<string> {
  const made = await h.call('POST', BASE, personal(over), 'wren');
  expect(made.status).toBe(201);
  const id = made.body.triggerId as string;
  if (tools !== undefined) {
    const listed = await h.call('PATCH', `${BASE}/${id}`, { toolsAllowedUnattended: tools });
    expect(listed.status).toBe(200);
  }
  return id;
}

describe('register', () => {
  test('a writer registers a trigger on their own mailbox: they own it, at the default pace', async () => {
    const h = harness();
    const res = await h.call('POST', BASE, personal({ label: 'Support inbox' }), 'wren');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      agentId: 'acme.support',
      projectId: PROJECT,
      owner: { kind: 'user', id: WREN },
      mailbox: { app: 'google', as: 'person' },
      pollSeconds: 60,
      runsPerHour: 60,
      label: 'Support inbox',
      status: 'active',
    });
    expect(res.body.toolsAllowedUnattended).toBeUndefined();
    expect(validateAgainst('MailTriggerRecord', res.body)).toEqual([]);
  });

  test("the company's mailbox is an admin's: a writer's is a 403, and an admin's can name a service account, which owns it", async () => {
    const h = harness();
    expect((await h.call('POST', BASE, company(), 'wren')).status).toBe(403);
    const shared = await h.call('POST', BASE, company({ runAsServiceAccountId: BOT }));
    expect(shared.status).toBe(201);
    expect(shared.body.owner).toMatchObject({ kind: 'service', id: BOT });
    expect(h.events('trigger-owner-set')).toHaveLength(1);
    // Without one, the admin owns it: personal, on the company's mailbox.
    const own = await h.call('POST', BASE, company());
    expect(own.status).toBe(201);
    expect(own.body.owner).toMatchObject({ kind: 'user', id: ADA });
  });

  test("a person's mailbox is a person's: naming a service account, or calling as one, is a 400", async () => {
    const h = harness();
    const named = await h.call('POST', BASE, personal({ runAsServiceAccountId: BOT }));
    expect(named.status).toBe(400);
    expect(named.body.error.message).toMatch(/a person owns it/);
    expect((await h.call('POST', BASE, personal(), 'bot')).status).toBe(400);
  });

  test('config takes the mailbox, the folder and the pace, and no input', async () => {
    const h = harness();
    const cases: Record<string, unknown>[] = [
      { ...personal(), config: { mailbox: { app: 'google', as: 'person' }, input: {} } },
      { ...personal(), config: { mailbox: { app: 'google', as: 'person' }, pollSeconds: 10 } },
      { ...personal(), config: { mailbox: { app: 'google', as: 'person' }, runsPerHour: 601 } },
      { ...personal(), config: { mailbox: { app: 'yahoo', as: 'person' } } },
      { ...personal(), config: { mailbox: { app: 'google', as: 'shared' } } },
      { ...personal(), config: {} },
      { ...personal(), flowId: 'acme.orders', flowVersion: '1.0.0' },
      { projectId: PROJECT, config: { mailbox: { app: 'google', as: 'person' } } },
    ];
    for (const body of cases) {
      expect((await h.call('POST', BASE, body, 'wren')).status, JSON.stringify(body)).toBe(400);
    }
    const paced = await h.call(
      'POST',
      BASE,
      {
        ...personal(),
        config: {
          mailbox: { app: 'google', as: 'person' },
          folder: 'Label_7',
          pollSeconds: 300,
          runsPerHour: 20,
        },
      },
      'wren',
    );
    expect(paced.status).toBe(201);
    expect(paced.body).toMatchObject({ folder: 'Label_7', pollSeconds: 300, runsPerHour: 20 });
  });
});

describe('who may change a personal trigger', () => {
  test("another writer's PATCH, pause, resume and unregister are each a 403; its owner's and a project admin's are OK", async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'x' }, 'milo')).status).toBe(403);
    for (const verb of ['pause', 'resume', 'unregister']) {
      expect((await h.call('POST', `${BASE}/${id}/${verb}`, undefined, 'milo')).status).toBe(403);
    }
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'Mine' }, 'wren')).status).toBe(200);
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'Hers' })).status).toBe(200);
    expect((await h.call('POST', `${BASE}/${id}/pause`, undefined, 'wren')).status).toBe(200);
    expect((await h.call('POST', `${BASE}/${id}/resume`)).status).toBe(200);
    const gone = await h.call('POST', `${BASE}/${id}/unregister`);
    expect(gone).toMatchObject({ status: 200, body: { triggerId: id, unregistered: true } });
  });

  test("no edit moves the owner: an admin's retarget keeps it, audited as trigger-changed-for-owner", async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    const res = await h.call('PATCH', `${BASE}/${id}`, {
      agentId: 'acme.triage',
      config: { mailbox: { app: 'microsoft', as: 'person' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: WREN });
    const [changed, ...more] = h.events('trigger-changed-for-owner');
    expect(more).toEqual([]);
    expect(docOf(changed)).toEqual({
      triggerId: id,
      triggerKind: 'mail',
      owner: `user:${WREN}`,
      by: expect.any(String),
      change: 'updated',
      fields: ['target', 'mailbox'],
      target: { before: { agentId: 'acme.support' }, after: { agentId: 'acme.triage' } },
      mailbox: {
        before: { app: 'google', as: 'person' },
        after: { app: 'microsoft', as: 'person' },
      },
    });
    expect(h.events('trigger-owner-set')).toEqual([]);
    // An admin's change to its pace or label names only the fields.
    await h.call('PATCH', `${BASE}/${id}`, { label: 'Renamed', config: { pollSeconds: 300 } });
    const [, paced] = h.events('trigger-changed-for-owner');
    expect(docOf(paced)).toMatchObject({ change: 'updated', fields: ['pollSeconds', 'label'] });
    expect(docOf(paced)).not.toHaveProperty('target');
    // The owner's own change, and a PATCH that changes nothing, aren't audited.
    await h.call('PATCH', `${BASE}/${id}`, { agentId: 'acme.support' }, 'wren');
    await h.call('PATCH', `${BASE}/${id}`, { label: 'Renamed' });
    expect(h.events('trigger-changed-for-owner')).toHaveLength(2);
  });

  test("an admin's pause, resume and unregister of a person's trigger are audited; its owner's aren't", async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    await h.call('POST', `${BASE}/${id}/pause`, undefined, 'wren');
    await h.call('POST', `${BASE}/${id}/resume`, undefined, 'wren');
    expect(h.events('trigger-changed-for-owner')).toEqual([]);
    expect((await h.call('POST', `${BASE}/${id}/pause`)).status).toBe(200);
    // A pause of a paused trigger is a 409, and isn't audited.
    expect((await h.call('POST', `${BASE}/${id}/pause`)).status).toBe(409);
    for (const verb of ['resume', 'unregister']) {
      expect((await h.call('POST', `${BASE}/${id}/${verb}`)).status).toBe(200);
    }
    expect(h.events('trigger-changed-for-owner').map((e) => docOf(e)?.change)).toEqual([
      'paused',
      'resumed',
      'unregistered',
    ]);
    expect(docOf(h.events('trigger-changed-for-owner')[0])).toEqual({
      triggerId: id,
      triggerKind: 'mail',
      owner: `user:${WREN}`,
      by: expect.any(String),
      change: 'paused',
    });
  });

  test('a PATCH that names an owner is a 400: the owner moves only by a take-over', async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    const res = await h.call('PATCH', `${BASE}/${id}`, { runAsServiceAccountId: BOT });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/only by a take-over/);
  });

  test("a shared trigger's PATCH is an admin's, its pause a writer's; it can't move to a person's mailbox", async () => {
    const h = harness();
    const made = await h.call('POST', BASE, company({ runAsServiceAccountId: BOT }));
    const id = made.body.triggerId as string;
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'x' }, 'wren')).status).toBe(403);
    expect((await h.call('POST', `${BASE}/${id}/pause`, undefined, 'wren')).status).toBe(200);
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'Shared' })).status).toBe(200);
    const moved = await h.call('PATCH', `${BASE}/${id}`, {
      config: { mailbox: { app: 'google', as: 'person' } },
    });
    expect(moved.status).toBe(400);
  });

  test("moving a personal trigger to the company's mailbox takes an admin", async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    const body = { config: { mailbox: { app: 'google', as: 'company' } } };
    expect((await h.call('PATCH', `${BASE}/${id}`, body, 'wren')).status).toBe(403);
    expect((await h.call('PATCH', `${BASE}/${id}`, body)).status).toBe(200);
  });
});

describe('toolsAllowedUnattended', () => {
  test("the owner's retarget with a list on it: a 400 without the list, and a 403 with it, since a writer isn't an admin", async () => {
    const h = harness();
    const id = await wrensTrigger(h, {}, ['acme.lookup']);
    const bare = await h.call('PATCH', `${BASE}/${id}`, { agentId: 'acme.triage' }, 'wren');
    expect(bare.status).toBe(400);
    expect(bare.body.error.message).toMatch(/must name it again/);
    const named = await h.call(
      'PATCH',
      `${BASE}/${id}`,
      { agentId: 'acme.triage', toolsAllowedUnattended: ['acme.lookup'] },
      'wren',
    );
    expect(named.status).toBe(403);
  });

  test("an admin's retarget that names it, as it is or [], is OK", async () => {
    const h = harness();
    const id = await wrensTrigger(h, {}, ['acme.lookup']);
    const kept = await h.call('PATCH', `${BASE}/${id}`, {
      agentId: 'acme.triage',
      toolsAllowedUnattended: ['acme.lookup'],
    });
    expect(kept.status).toBe(200);
    expect(kept.body.toolsAllowedUnattended).toEqual(['acme.lookup']);
    const cleared = await h.call('PATCH', `${BASE}/${id}`, {
      agentId: 'acme.support',
      toolsAllowedUnattended: [],
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.toolsAllowedUnattended).toBeUndefined();
  });

  test('a version change keeps it; a mailbox change without it is a 400', async () => {
    const h = harness();
    const id = await wrensTrigger(h, { agentVersion: '1.0.0' }, ['acme.reply']);
    const version = await h.call(
      'PATCH',
      `${BASE}/${id}`,
      { agentId: 'acme.support', agentVersion: '2.0.0' },
      'wren',
    );
    expect(version.status).toBe(200);
    expect(version.body).toMatchObject({
      agentVersion: '2.0.0',
      toolsAllowedUnattended: ['acme.reply'],
    });
    const mailbox = { config: { mailbox: { app: 'microsoft', as: 'person' } } };
    expect((await h.call('PATCH', `${BASE}/${id}`, mailbox, 'wren')).status).toBe(400);
    const named = await h.call('PATCH', `${BASE}/${id}`, {
      ...mailbox,
      toolsAllowedUnattended: ['acme.reply'],
    });
    expect(named.status).toBe(200);
  });

  test('a tool the target never calls is a 400', async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    const res = await h.call('PATCH', `${BASE}/${id}`, { toolsAllowedUnattended: ['acme.refund'] });
    expect(res.status).toBe(400);
  });

  test('a take-over keeps it, and a take-over body that names it is a 400', async () => {
    const h = harness();
    const id = await wrensTrigger(h, {}, ['acme.lookup']);
    const named = await h.call('POST', `${BASE}/${id}/owner`, { toolsAllowedUnattended: [] });
    expect(named.status).toBe(400);
    const taken = await h.call('POST', `${BASE}/${id}/owner`, {});
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({
      owner: { kind: 'user', id: ADA },
      toolsAllowedUnattended: ['acme.lookup'],
    });
    expect(docOf(h.events('trigger-owner-set')[0])).toMatchObject({
      toolsAllowedUnattended: ['acme.lookup'],
    });
  });

  test("a writer can't take a trigger over", async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    expect((await h.call('POST', `${BASE}/${id}/owner`, undefined, 'milo')).status).toBe(403);
  });
});

describe('without an authorization store', () => {
  test("another member's PATCH of a personal trigger is a 403; its owner's and a tenant-admin token's are OK", async () => {
    const h = harness({ store: false });
    const id = await wrensTrigger(h);
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'x' }, 'milo')).status).toBe(403);
    expect((await h.call('POST', `${BASE}/${id}/pause`, undefined, 'milo')).status).toBe(403);
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'Mine' }, 'wren')).status).toBe(200);
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'Hers' })).status).toBe(200);
  });

  test("the owner's create or PATCH that names a non-empty list is a 403 for a member, and OK for a tenant-admin token", async () => {
    const h = harness({ store: false });
    const listed = personal({ toolsAllowedUnattended: ['acme.lookup'] });
    expect((await h.call('POST', BASE, listed, 'wren')).status).toBe(403);
    const id = await wrensTrigger(h);
    const patch = { toolsAllowedUnattended: ['acme.lookup'] };
    expect((await h.call('PATCH', `${BASE}/${id}`, patch, 'wren')).status).toBe(403);
    expect((await h.call('PATCH', `${BASE}/${id}`, patch)).status).toBe(200);
    expect((await h.call('POST', BASE, listed)).status).toBe(201);
  });

  test('a company-mailbox create is a 403 for a member, and OK for a tenant-admin token', async () => {
    const h = harness({ store: false });
    expect((await h.call('POST', BASE, company(), 'wren')).status).toBe(403);
    expect((await h.call('POST', BASE, company())).status).toBe(201);
  });
});

describe('reads', () => {
  test("a get reads a mail trigger; another kind's id, and an id that isn't one, aren't found here", async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    const got = await h.call('GET', `${BASE}/${id}`, undefined, 'milo');
    expect(got.status).toBe(200);
    expect(got.body.triggerId).toBe(id);
    const schedule = await h.call('POST', '/v1/schedules', {
      agentId: 'acme.support',
      projectId: PROJECT,
      config: { cronExpression: '0 7 * * 1-5', input: { userMessage: 'The digest.' } },
    });
    expect(schedule.status).toBe(201);
    const other = await h.call('GET', `${BASE}/${schedule.body.triggerId}`);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('trigger-not-found');
    expect((await h.call('GET', `${BASE}/not-an-id`)).status).toBe(404);
    expect((await h.call('GET', `${BASE}/${randomUUID()}`)).status).toBe(404);
  });

  test("the list holds the tenant's mail triggers, by status and project", async () => {
    const h = harness();
    const a = await wrensTrigger(h);
    const b = await wrensTrigger(h);
    await h.call('POST', `${BASE}/${b}/pause`, undefined, 'wren');
    await h.call('POST', '/v1/schedules', {
      agentId: 'acme.support',
      projectId: PROJECT,
      config: { cronExpression: '0 7 * * 1-5', input: { userMessage: 'The digest.' } },
    });
    const all = await h.call('GET', BASE);
    expect(all.status).toBe(200);
    expect(all.body.data.map((t: { triggerId: string }) => t.triggerId).sort()).toEqual(
      [a, b].sort(),
    );
    expect(validateAgainst('MailTriggerCollectionPage', all.body)).toEqual([]);
    const paused = await h.call('GET', `${BASE}?status=paused`);
    expect(paused.body.data.map((t: { triggerId: string }) => t.triggerId)).toEqual([b]);
    const elsewhere = await h.call('GET', `${BASE}?projectId=${randomUUID()}`);
    expect(elsewhere.body.data).toEqual([]);
    expect((await h.call('GET', `${BASE}?projectId=nope`)).status).toBe(400);
  });

  test("fires: a mail's fire says why it waits", async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    const runId = randomUUID();
    h.triggerRegistry.recordFire({
      triggerId: id as TriggerId,
      kind: 'mail',
      firedAt: new Date().toISOString(),
      outcome: 'pending',
      detail: `thread-busy: waits for run ${runId}`,
    });
    const res = await h.call('GET', `${BASE}/${id}/fires`, undefined, 'milo');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        triggerId: id,
        outcome: 'pending',
        detail: `thread-busy: waits for run ${runId}`,
      }),
    ]);
    expect(validateAgainst('MailFirePage', res.body)).toEqual([]);
  });
});

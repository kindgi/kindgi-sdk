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
import { google } from '@kindgi/connections/google';
import { microsoft } from '@kindgi/connections/microsoft';
import type { Cursor, EnvName, ProjectId, TenantId, TriggerId, UserId } from '@kindgi/types';

import type { ConnectionBinding, ConnectionRecord } from '../src/connection-binding.js';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';
import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  FlowRegistryBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
  TriggerOwnerNotice,
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

/** A connection the fake binding keeps: the company's, unless a member's. */
interface FakeConnection {
  readonly connectionId: string;
  readonly app: 'google' | 'microsoft';
  readonly name: string;
  readonly member?: UserId;
  /** The company's, live, but on a registration that doesn't allow the project. */
  readonly elsewhere?: boolean;
}

/**
 * A connection binding over `list` (which a test may add to), in the
 * `local` env. It gives one candidate a page, so a route reads them all.
 */
function fakeConnections(list: readonly FakeConnection[]): ConnectionBinding {
  const binding: Pick<ConnectionBinding, 'entries' | 'get' | 'listCandidates'> = {
    entries: () => [google, microsoft],
    async get(input) {
      const c = list.find((x) => x.connectionId === input.connectionId);
      if (c === undefined || input.tenantId !== tenantId) return null;
      return {
        connectionId: c.connectionId,
        tenantId,
        envName: 'local',
        app: c.app,
        owner: c.member === undefined ? { kind: 'company' } : { kind: 'member', userId: c.member },
        state: 'working',
        label: c.name,
      } as unknown as ConnectionRecord;
    },
    async listCandidates(input) {
      const all = list.filter(
        (c) =>
          input.tenantId === tenantId &&
          input.projectId === PROJECT &&
          input.envName === 'local' &&
          c.member === undefined &&
          c.elsewhere !== true &&
          (input.app === undefined || c.app === input.app),
      );
      const at = input.cursor === undefined ? 0 : Number(input.cursor);
      return {
        data: all.slice(at, at + 1).map((c) => ({
          connectionId: c.connectionId,
          name: c.name,
          app: c.app,
          accountLabel: `${c.name}@acme.example`,
          state: 'working' as const,
        })),
        ...(at + 1 < all.length && { nextCursor: String(at + 1) as Cursor }),
      };
    },
  };
  return binding as ConnectionBinding;
}

function harness(opts: { store?: boolean; connections?: readonly FakeConnection[] } = {}) {
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
  const told: TriggerOwnerNotice[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry,
    agentRegistry,
    flowRegistry,
    serviceAccountBinding,
    auditEvents,
    triggerOwnerNotices: { tell: (notice) => void told.push(notice) },
    ...(opts.connections !== undefined && {
      connections: fakeConnections(opts.connections),
      envName: 'local' as EnvName,
    }),
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
  return { call, events, told, triggerRegistry };
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
    const res = await h.call('PATCH', `${BASE}/${id}`, { agentId: 'acme.triage' });
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
      fields: ['target'],
      target: { before: { agentId: 'acme.support' }, after: { agentId: 'acme.triage' } },
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

  test("what a person's trigger reads from their mailbox is its owner's alone to change; an admin may move it to the company's", async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    // An admin's other mailbox, or other folder, on a person's mailbox: a 403.
    const otherApp = await h.call('PATCH', `${BASE}/${id}`, {
      config: { mailbox: { app: 'microsoft', as: 'person' } },
    });
    expect(otherApp.status).toBe(403);
    expect(otherApp.body.error.message).toMatch(
      /Only the trigger's owner may choose which of their mailboxes it reads, and which folder or Gmail label in it/,
    );
    const folder = { config: { folder: 'Label_7' } };
    expect((await h.call('PATCH', `${BASE}/${id}`, folder)).status).toBe(403);
    expect(h.events('trigger-changed-for-owner')).toEqual([]);
    // Its owner's own are OK.
    expect((await h.call('PATCH', `${BASE}/${id}`, folder, 'wren')).status).toBe(200);
    const own = await h.call(
      'PATCH',
      `${BASE}/${id}`,
      { config: { mailbox: { app: 'microsoft', as: 'person' }, folder: 'inbox' } },
      'wren',
    );
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      mailbox: { app: 'microsoft', as: 'person' },
      folder: 'inbox',
    });
    // An admin's move to the company's mailbox is OK, and audited. The
    // folder was the person's mailbox's, so it goes: the company's inbox.
    const toCompany = await h.call('PATCH', `${BASE}/${id}`, {
      config: { mailbox: { app: 'microsoft', as: 'company' } },
    });
    expect(toCompany.status).toBe(200);
    expect(toCompany.body).not.toHaveProperty('folder');
    expect(docOf(h.events('trigger-changed-for-owner')[0])).toMatchObject({
      change: 'updated',
      fields: ['mailbox', 'folder'],
      mailbox: {
        before: { app: 'microsoft', as: 'person' },
        after: { app: 'microsoft', as: 'company' },
      },
      folder: { before: 'inbox', after: null },
    });
    // On the company's mailbox, its folder is an admin's as before.
    const companyFolder = { config: { folder: 'AAMkAD-orders' } };
    expect((await h.call('PATCH', `${BASE}/${id}`, companyFolder)).status).toBe(200);
    // Back to a person's mailbox, the owner's: an admin's move is a 403.
    const back = { config: { mailbox: { app: 'microsoft', as: 'person' } } };
    expect((await h.call('PATCH', `${BASE}/${id}`, back)).status).toBe(403);
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

  test("an admin's change, pause, resume, unregister and take-over tell the owner; the owner's own don't", async () => {
    const h = harness();
    const id = await wrensTrigger(h, { label: 'Orders' });
    await h.call('PATCH', `${BASE}/${id}`, { config: { pollSeconds: 120 } }, 'wren');
    await h.call('POST', `${BASE}/${id}/pause`, undefined, 'wren');
    await h.call('POST', `${BASE}/${id}/resume`, undefined, 'wren');
    expect(h.told).toEqual([]);
    await h.call('PATCH', `${BASE}/${id}`, { config: { pollSeconds: 300 }, label: 'Orders' });
    for (const verb of ['pause', 'resume', 'unregister']) {
      expect((await h.call('POST', `${BASE}/${id}/${verb}`)).status).toBe(200);
    }
    expect(h.told.map((n) => n.change)).toEqual(['updated', 'paused', 'resumed', 'unregistered']);
    expect(h.told[0]).toEqual({
      tenantId,
      projectId: PROJECT,
      triggerId: id,
      triggerKind: 'mail',
      label: 'Orders',
      owner: { kind: 'user', id: WREN },
      by: expect.any(String),
      at: expect.any(String),
      change: 'updated',
      fields: ['pollSeconds'],
    });
    // A take-over tells the former owner.
    const other = await wrensTrigger(h);
    expect((await h.call('POST', `${BASE}/${other}/owner`)).status).toBe(200);
    expect(h.told.at(-1)).toMatchObject({
      triggerId: other,
      triggerKind: 'mail',
      owner: { kind: 'user', id: WREN },
      change: 'taken-over',
    });
    expect(h.told).toHaveLength(5);
  });

  test('a refused change says who may make it', async () => {
    const h = harness();
    const id = await wrensTrigger(h);
    const milos = await h.call('PATCH', `${BASE}/${id}`, { label: 'x' }, 'milo');
    expect(milos.status).toBe(403);
    expect(milos.body.error.message).toBe(
      `This mail trigger is personal: only ${WREN} or a project admin can change it.`,
    );
    const takeOver = await h.call('POST', `${BASE}/${id}/owner`, undefined, 'wren');
    expect(takeOver.status).toBe(403);
    expect(takeOver.body.error.message).toBe('Taking a mail trigger over takes a project admin.');
    const made = await h.call('POST', BASE, company({ runAsServiceAccountId: BOT }));
    const shared = await h.call('PATCH', `${BASE}/${made.body.triggerId}`, { label: 'x' }, 'wren');
    expect(shared.body.error.message).toBe('Changing a shared mail trigger takes a project admin.');
    const companys = await h.call('POST', BASE, company(), 'wren');
    expect(companys.body.error.message).toBe(
      "Watching the company's mailbox takes a project admin.",
    );
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

describe('a move to another mailbox', () => {
  test('that names no folder watches its inbox: the folder goes, and the audit says so', async () => {
    const h = harness();
    const id = await wrensTrigger(h, {
      config: { mailbox: { app: 'google', as: 'person' }, folder: 'Label_9' },
    });
    const moved = await h.call(
      'PATCH',
      `${BASE}/${id}`,
      { config: { mailbox: { app: 'microsoft', as: 'person' } } },
      'wren',
    );
    expect(moved.status).toBe(200);
    expect(moved.body.mailbox).toEqual({ app: 'microsoft', as: 'person' });
    expect(moved.body).not.toHaveProperty('folder');
    expect(validateAgainst('MailTriggerRecord', moved.body)).toEqual([]);
    expect((await h.call('GET', `${BASE}/${id}`, undefined, 'wren')).body).not.toHaveProperty(
      'folder',
    );
    // The same app's company mailbox is another mailbox too.
    const adas = await h.call(
      'POST',
      BASE,
      personal({ config: { mailbox: { app: 'google', as: 'person' }, folder: 'Label_9' } }),
    );
    const toCompany = await h.call('PATCH', `${BASE}/${adas.body.triggerId}`, {
      config: { mailbox: { app: 'google', as: 'company' } },
    });
    expect(toCompany.body).toMatchObject({ mailbox: { app: 'google', as: 'company' } });
    expect(toCompany.body).not.toHaveProperty('folder');
  });

  test('a folder named with it is the one; the same mailbox again, or a pace edit, keeps the folder', async () => {
    const h = harness();
    const made = await h.call('POST', BASE, {
      ...company(),
      config: { mailbox: { app: 'microsoft', as: 'company' }, folder: 'archive' },
    });
    const id = made.body.triggerId as string;
    const named = await h.call('PATCH', `${BASE}/${id}`, {
      config: { mailbox: { app: 'google', as: 'company' }, folder: 'SENT' },
    });
    expect(named.body).toMatchObject({ mailbox: { app: 'google', as: 'company' }, folder: 'SENT' });
    const again = await h.call('PATCH', `${BASE}/${id}`, {
      config: { mailbox: { app: 'google', as: 'company' } },
    });
    expect(again.body.folder).toBe('SENT');
    const paced = await h.call('PATCH', `${BASE}/${id}`, { config: { pollSeconds: 300 } });
    expect(paced.body).toMatchObject({ folder: 'SENT', pollSeconds: 300 });
  });
});

const SUPPORT_GMAIL: FakeConnection = {
  connectionId: randomUUID(),
  app: 'google',
  name: 'support',
};
const SALES_GMAIL: FakeConnection = { connectionId: randomUUID(), app: 'google', name: 'sales' };
const OPS_OUTLOOK: FakeConnection = { connectionId: randomUUID(), app: 'microsoft', name: 'ops' };
const WRENS_GMAIL: FakeConnection = {
  connectionId: randomUUID(),
  app: 'google',
  name: 'wren',
  member: WREN,
};
const WRENS_OUTLOOK: FakeConnection = {
  connectionId: randomUUID(),
  app: 'microsoft',
  name: 'wren',
  member: WREN,
};
const BILLING_GMAIL: FakeConnection = {
  connectionId: randomUUID(),
  app: 'google',
  name: 'billing',
  elsewhere: true,
};
const FIELD = 'config.mailbox.connectionId';

/** The company's Gmail, through `connectionId` when given. */
const gmail = (connectionId?: string) => ({
  app: 'google',
  as: 'company',
  ...(connectionId !== undefined && { connectionId }),
});
/** A trigger on the company's Gmail. */
const companyGmail = (connectionId?: string, over: Record<string, unknown> = {}) =>
  company({ config: { mailbox: gmail(connectionId) }, ...over });

describe('the company connection it reads with', () => {
  test('a named candidate is stored, and every answer carries it', async () => {
    const h = harness({ connections: [SUPPORT_GMAIL, SALES_GMAIL] });
    const made = await h.call('POST', BASE, companyGmail(SALES_GMAIL.connectionId));
    expect(made.status).toBe(201);
    const mailbox = gmail(SALES_GMAIL.connectionId);
    expect(made.body.mailbox).toEqual(mailbox);
    expect(validateAgainst('MailTriggerRecord', made.body)).toEqual([]);
    const id = made.body.triggerId as string;
    const stored = await h.triggerRegistry.get({ tenantId, triggerId: id as TriggerId });
    expect((stored?.config as { mailbox?: unknown } | undefined)?.mailbox).toEqual(mailbox);
    expect((await h.call('GET', `${BASE}/${id}`)).body.mailbox).toEqual(mailbox);
    expect((await h.call('GET', BASE)).body.data[0].mailbox).toEqual(mailbox);
    const paced = await h.call('PATCH', `${BASE}/${id}`, { config: { pollSeconds: 300 } });
    expect(paced.body.mailbox).toEqual(mailbox);
  });

  test("a named id that isn't one of the project's candidates of the app is a 404 naming the field; a person's live connection of the app is a 400", async () => {
    const h = harness({
      connections: [SUPPORT_GMAIL, OPS_OUTLOOK, WRENS_GMAIL, WRENS_OUTLOOK, BILLING_GMAIL],
    });
    // A person's connection of another app couldn't be read with anyway, so
    // it says no more than an id that isn't there.
    for (const named of [
      BILLING_GMAIL.connectionId,
      OPS_OUTLOOK.connectionId,
      WRENS_OUTLOOK.connectionId,
      randomUUID(),
    ]) {
      const res = await h.call('POST', BASE, companyGmail(named));
      expect(res.status, named).toBe(404);
      expect(res.body.error).toMatchObject({
        code: 'connection-not-found',
        details: { connectionId: named, field: FIELD },
      });
    }
    const persons = await h.call('POST', BASE, companyGmail(WRENS_GMAIL.connectionId));
    expect(persons.status).toBe(400);
    expect(persons.body.error).toMatchObject({
      code: 'bad-input',
      message:
        "A person's own connection is used for them; the company's mailbox is read with a company connection.",
      details: { field: FIELD },
    });
    expect((await h.call('GET', BASE)).body.data).toEqual([]);
  });

  test("a person's mailbox names no connection, and an id is a UUID", async () => {
    const h = harness({ connections: [WRENS_GMAIL] });
    const mailbox = { app: 'google', as: 'person', connectionId: WRENS_GMAIL.connectionId };
    const res = await h.call('POST', BASE, personal({ config: { mailbox } }), 'wren');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      "A person's mailbox is read with its owner's own connection; `connectionId` is for the company's.",
    );
    const notAnId = await h.call('POST', BASE, companyGmail('support'));
    expect(notAnId.status).toBe(400);
    expect(notAnId.body.error.message).toMatch(/a UUID/);
  });

  test('none named: the only candidate is stored, and with none, nothing is', async () => {
    const h = harness({ connections: [SUPPORT_GMAIL, BILLING_GMAIL, WRENS_GMAIL] });
    const only = await h.call('POST', BASE, companyGmail());
    expect(only.status).toBe(201);
    expect(only.body.mailbox).toEqual(gmail(SUPPORT_GMAIL.connectionId));
    const none = await h.call('POST', BASE, company());
    expect(none.status).toBe(201);
    expect(none.body.mailbox).toEqual({ app: 'microsoft', as: 'company' });
  });

  test('none named and several is a 409 that lists them by name, and registers nothing', async () => {
    const h = harness({ connections: [SUPPORT_GMAIL, SALES_GMAIL, OPS_OUTLOOK] });
    const res = await h.call('POST', BASE, companyGmail());
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'connection-not-chosen',
      message:
        'This project has 2 company Google connections (sales, support); name one in config.mailbox.connectionId.',
      details: {
        choices: [
          { connectionId: SALES_GMAIL.connectionId, name: 'sales' },
          { connectionId: SUPPORT_GMAIL.connectionId, name: 'support' },
        ],
        field: FIELD,
      },
      requestId: 'req-mail',
    });
    expect((await h.call('GET', BASE)).body.data).toEqual([]);
  });

  test("with no project to check against, a named id is the tenant's live company connection of the app, and none named stores none", async () => {
    const h = harness({
      connections: [SUPPORT_GMAIL, SALES_GMAIL, BILLING_GMAIL, WRENS_GMAIL, OPS_OUTLOOK],
    });
    const noProject = (connectionId?: string) => {
      const { projectId: _, ...body } = companyGmail(connectionId);
      return body;
    };
    const named = await h.call('POST', BASE, noProject(BILLING_GMAIL.connectionId));
    expect(named.status).toBe(201);
    expect(named.body.mailbox).toEqual(gmail(BILLING_GMAIL.connectionId));
    expect((await h.call('POST', BASE, noProject(OPS_OUTLOOK.connectionId))).status).toBe(404);
    expect((await h.call('POST', BASE, noProject(randomUUID()))).status).toBe(404);
    expect((await h.call('POST', BASE, noProject(WRENS_GMAIL.connectionId))).status).toBe(400);
    const unnamed = await h.call('POST', BASE, noProject());
    expect(unnamed.status).toBe(201);
    expect(unnamed.body.mailbox).toEqual(gmail());
  });

  test('pointing it at another connection is another mailbox: an admin names the list again, and the folder goes', async () => {
    const h = harness({ connections: [SUPPORT_GMAIL, SALES_GMAIL] });
    const made = await h.call(
      'POST',
      BASE,
      company({
        config: { mailbox: gmail(SUPPORT_GMAIL.connectionId), folder: 'Label_9' },
        toolsAllowedUnattended: ['acme.lookup'],
      }),
    );
    expect(made.status).toBe(201);
    const id = made.body.triggerId as string;
    const to = { config: { mailbox: gmail(SALES_GMAIL.connectionId) } };
    const bare = await h.call('PATCH', `${BASE}/${id}`, to);
    expect(bare.status).toBe(400);
    expect(bare.body.error.message).toMatch(/must name it again/);
    const restated = { ...to, toolsAllowedUnattended: ['acme.lookup'] };
    expect((await h.call('PATCH', `${BASE}/${id}`, restated, 'wren')).status).toBe(403);
    const set = h.events('trigger-tools-allowed-unattended-set').length;
    const moved = await h.call('PATCH', `${BASE}/${id}`, restated);
    expect(moved.status).toBe(200);
    expect(moved.body.mailbox).toEqual(gmail(SALES_GMAIL.connectionId));
    expect(moved.body).not.toHaveProperty('folder');
    // The list named again for another mailbox is audited, as for another app.
    expect(h.events('trigger-tools-allowed-unattended-set')).toHaveLength(set + 1);
    // The same connection again is the same mailbox: no list, and the folder stays.
    await h.call('PATCH', `${BASE}/${id}`, { config: { folder: 'Label_3' } });
    const again = await h.call('PATCH', `${BASE}/${id}`, to);
    expect(again.status).toBe(200);
    expect(again.body.folder).toBe('Label_3');
    // So is the company's mailbox sent again with no connection: it keeps
    // the one it reads with, though the project has two.
    const resent = await h.call('PATCH', `${BASE}/${id}`, { config: { mailbox: gmail() } });
    expect(resent.status).toBe(200);
    expect(resent.body.mailbox).toEqual(gmail(SALES_GMAIL.connectionId));
    expect(resent.body.folder).toBe('Label_3');
  });

  test('where it named none, the only one taken when none is named is the mailbox it reads already, and with several none is taken; one named is another mailbox', async () => {
    const list: FakeConnection[] = [];
    const h = harness({ connections: list });
    const make = async (more: Record<string, unknown> = {}) => {
      const made = await h.call(
        'POST',
        BASE,
        company({ config: { mailbox: gmail(), folder: 'Label_9' }, ...more }),
      );
      expect(made.body.mailbox).toEqual(gmail());
      return made.body.triggerId as string;
    };
    const plain = await make();
    const listed = await make({ toolsAllowedUnattended: ['acme.lookup'] });
    const other = await make({ toolsAllowedUnattended: ['acme.lookup'] });
    const unstored = await make();
    list.push(SUPPORT_GMAIL);
    // It already reads with the only one: storing it keeps the folder, and
    // the list needs no naming again.
    for (const id of [plain, listed]) {
      const pinned = await h.call('PATCH', `${BASE}/${id}`, { config: { mailbox: gmail() } });
      expect(pinned.status, id).toBe(200);
      expect(pinned.body.mailbox).toEqual(gmail(SUPPORT_GMAIL.connectionId));
      expect(pinned.body.folder).toBe('Label_9');
    }
    // With two there, there's no only one to take: the mailbox sent again
    // is refused, and the trigger stays as it was.
    list.push(SALES_GMAIL);
    const several = await h.call('PATCH', `${BASE}/${unstored}`, { config: { mailbox: gmail() } });
    expect(several.status).toBe(409);
    expect(several.body.error.code).toBe('connection-not-chosen');
    expect(several.body.error.details.choices).toHaveLength(2);
    const kept = await h.call('GET', `${BASE}/${unstored}`);
    expect(kept.body.mailbox).toEqual(gmail());
    expect(kept.body.folder).toBe('Label_9');
    // One named where none was is another mailbox: the list is named again,
    // and it watches that mailbox's inbox.
    const to = { config: { mailbox: gmail(SUPPORT_GMAIL.connectionId) } };
    const bare = await h.call('PATCH', `${BASE}/${other}`, to);
    expect(bare.status).toBe(400);
    expect(bare.body.error.message).toMatch(/must name it again/);
    const named = await h.call('PATCH', `${BASE}/${other}`, {
      ...to,
      toolsAllowedUnattended: ['acme.lookup'],
    });
    expect(named.status).toBe(200);
    expect(named.body.mailbox).toEqual(gmail(SUPPORT_GMAIL.connectionId));
    expect(named.body).not.toHaveProperty('folder');
  });

  test("a new mailbox takes the same rule, nothing changes when it's refused, and a move to a person's mailbox drops the id", async () => {
    const h = harness({ connections: [SUPPORT_GMAIL, SALES_GMAIL, WRENS_GMAIL] });
    const made = await h.call('POST', BASE, companyGmail(SUPPORT_GMAIL.connectionId));
    const id = made.body.triggerId as string;
    const other = randomUUID();
    const notOne = await h.call('PATCH', `${BASE}/${id}`, { config: { mailbox: gmail(other) } });
    expect(notOne.status).toBe(404);
    expect(notOne.body.error).toMatchObject({
      code: 'connection-not-found',
      details: { connectionId: other, field: FIELD },
    });
    const persons = await h.call('PATCH', `${BASE}/${id}`, {
      config: { mailbox: gmail(WRENS_GMAIL.connectionId) },
    });
    expect(persons.status).toBe(400);
    expect((await h.call('GET', `${BASE}/${id}`)).body.mailbox).toEqual(
      gmail(SUPPORT_GMAIL.connectionId),
    );
    const toPerson = await h.call('PATCH', `${BASE}/${id}`, {
      config: { mailbox: { app: 'google', as: 'person' } },
    });
    expect(toPerson.status).toBe(200);
    expect(toPerson.body.mailbox).toEqual({ app: 'google', as: 'person' });
    const stored = await h.triggerRegistry.get({ tenantId, triggerId: id as TriggerId });
    expect((stored?.config as { mailbox?: unknown } | undefined)?.mailbox).toEqual({
      app: 'google',
      as: 'person',
    });
    // Back to the company's mailbox, a new one again: two there and none named.
    const several = await h.call('PATCH', `${BASE}/${id}`, { config: { mailbox: gmail() } });
    expect(several.status).toBe(409);
    expect(several.body.error.code).toBe('connection-not-chosen');
    expect(several.body.error.details.choices).toHaveLength(2);
    expect((await h.call('GET', `${BASE}/${id}`)).body.mailbox).toEqual({
      app: 'google',
      as: 'person',
    });
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
    const bare = await h.call('PATCH', `${BASE}/${id}`, mailbox, 'wren');
    expect(bare.status).toBe(400);
    expect(bare.body.error.message).toMatch(
      /`\[\]` to clear it, or a list, which a project admin sets/,
    );
    // The owner may clear it with their own new mailbox, not name a list.
    const listed = { ...mailbox, toolsAllowedUnattended: ['acme.reply'] };
    expect((await h.call('PATCH', `${BASE}/${id}`, listed, 'wren')).status).toBe(403);
    const cleared = await h.call(
      'PATCH',
      `${BASE}/${id}`,
      { ...mailbox, toolsAllowedUnattended: [] },
      'wren',
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.toolsAllowedUnattended).toBeUndefined();
    expect(docOf(h.events('trigger-tools-allowed-unattended-set').at(-1))).toMatchObject({
      from: ['acme.reply'],
      to: [],
    });
  });

  test("the owner's `[]` goes only with their own new target or mailbox", async () => {
    const h = harness();
    const id = await wrensTrigger(h, {}, ['acme.lookup']);
    const alone = { toolsAllowedUnattended: [] };
    expect((await h.call('PATCH', `${BASE}/${id}`, alone, 'wren')).status).toBe(403);
    const retarget = { agentId: 'acme.triage', toolsAllowedUnattended: [] };
    expect((await h.call('PATCH', `${BASE}/${id}`, retarget, 'wren')).status).toBe(200);
    // Another writer's is a 403 before the list is looked at.
    const other = await wrensTrigger(h, {}, ['acme.lookup']);
    expect((await h.call('PATCH', `${BASE}/${other}`, retarget, 'milo')).status).toBe(403);
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

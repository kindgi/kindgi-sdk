// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Text triggers (`/v1/text-triggers`). A text trigger answers the texts to
 * one business number: a company connection of app `texts` in its
 * project, which one live text trigger answers at a time. The number is
 * the company's, so registering and every PATCH take a project admin; a
 * shared trigger's pause, resume and unregister take `write`, and a
 * personal one's its owner or an admin. `toolsAllowedUnattended` never
 * lists `kindgi_send_text`. Driven through the app, with an authorizer that
 * grants every right but `admin`, which only Ada and Pia hold, and
 * without one, where the token's tenant-admin scope decides.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { REMEMBER_TOOL_ID } from '@kindgi/agents';
import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { google } from '@kindgi/connections/google';
import { HAND_TO_PERSON_TOOL_ID, REPLY_TO_TEXT_TOOL_ID, SEND_TEXT_TOOL_ID } from '@kindgi/runtime';
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
/** A project writer. */
const WREN = randomUUID() as UserId;
/** A project admin who isn't a tenant admin. */
const PIA = randomUUID() as UserId;
const BOT = 'sa-front-desk';
const PROJECT = randomUUID() as ProjectId;

const TOKENS: Record<string, Awaited<ReturnType<TokenResolver>>> = {
  ada: { tenantId, userId: ADA, scopes: ['tenant-admin'] },
  wren: { tenantId, userId: WREN, scopes: [] },
  pia: { tenantId, userId: PIA, scopes: [] },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;

/** Every right, but `admin` only for Ada, and for Pia below the tenant. */
function decision(principal: unknown, action: Action, resource: ResourceRef): Decision {
  const actor = (principal as { actor?: { id?: string } }).actor?.id;
  const allowed =
    action !== 'admin' || actor === ADA || (actor === PIA && resource.type !== 'tenant');
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
const SUPPORT = { tools: [tool('acme.lookup'), tool('acme.note')] };
/** It declares what it remembers, so it is offered the remember tool. */
const REMEMBERS = {
  tools: [tool('acme.lookup')],
  memory: { remember: { types: ['preference'], scope: 'same-user' } },
};
const AGENTS: Record<string, Record<string, { tools: { id: string }[]; memory?: unknown }>> = {
  'acme.support': { latest: SUPPORT, '1.0.0': SUPPORT, '2.0.0': SUPPORT },
  'acme.triage': { latest: { tools: [tool('acme.lookup')] } },
  'acme.remembers': { latest: REMEMBERS },
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

/**
 * The flows, by id: `acme.orders`, whose one step is the agent
 * `acme.triage`; `acme.batch`, with tool steps only; `acme.nested`, whose
 * one step runs `acme.orders` as a subflow.
 */
const FLOWS: Record<string, readonly Record<string, unknown>[]> = {
  'acme.orders': [{ id: 'help', kind: 'agent', ref: 'acme.triage' }],
  'acme.batch': [{ id: 'look', kind: 'tool', ref: 'acme.lookup' }],
  'acme.nested': [
    { id: 'inner', kind: 'subgraph', flowRef: { flowId: 'acme.orders', version: '1.0.0' } },
  ],
};

const flowRegistry = {
  get: async () => null,
  getVersion: async ({ flowId, version }: { flowId: string; version: string }) => {
    const nodes = FLOWS[flowId];
    return nodes === undefined ? null : { id: flowId, version, nodes };
  },
} as unknown as FlowRegistryBinding;

const serviceAccountBinding = {
  get: async ({ serviceAccountId }: { serviceAccountId: string }) =>
    serviceAccountId === BOT
      ? { serviceAccountId, tenantId, name: 'acme-front-desk-bot', grants: [], createdAt: '' }
      : null,
} as unknown as ServiceAccountBinding;

/** A connection the fake binding keeps: the company's, unless a member's. */
interface FakeConnection {
  readonly connectionId: string;
  readonly app: 'texts' | 'google';
  readonly name: string;
  readonly member?: UserId;
  /** The company's, live, but on a registration that doesn't allow the project. */
  readonly elsewhere?: boolean;
}

const FRONT_DESK: FakeConnection = {
  connectionId: randomUUID(),
  app: 'texts',
  name: 'front-desk',
};
const SALES: FakeConnection = { connectionId: randomUUID(), app: 'texts', name: 'sales' };
const BILLING: FakeConnection = {
  connectionId: randomUUID(),
  app: 'texts',
  name: 'billing',
  elsewhere: true,
};
const WRENS_TEXTS: FakeConnection = {
  connectionId: randomUUID(),
  app: 'texts',
  name: 'wren',
  member: WREN,
};
const SUPPORT_GMAIL: FakeConnection = {
  connectionId: randomUUID(),
  app: 'google',
  name: 'support',
};
const ALL = [FRONT_DESK, SALES, BILLING, WRENS_TEXTS, SUPPORT_GMAIL];

/**
 * A connection binding over `list`, in the `local` env. It gives one
 * candidate a page, so a route reads them all.
 */
function fakeConnections(list: readonly FakeConnection[]): ConnectionBinding {
  const binding: Pick<ConnectionBinding, 'entries' | 'get' | 'listCandidates'> = {
    entries: () => [google],
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
          c.member === input.person?.userId &&
          c.elsewhere !== true &&
          (input.app === undefined || c.app === input.app),
      );
      const at = input.cursor === undefined ? 0 : Number(input.cursor);
      return {
        data: all.slice(at, at + 1).map((c) => ({
          connectionId: c.connectionId,
          name: c.name,
          app: c.app,
          accountLabel: `+1555010${at}`,
          state: 'working' as const,
        })),
        ...(at + 1 < all.length && { nextCursor: String(at + 1) as Cursor }),
      };
    },
  };
  return binding as ConnectionBinding;
}

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
    connections: fakeConnections(ALL),
    envName: 'local' as EnvName,
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
        'x-request-id': 'req-text',
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

const BASE = '/v1/text-triggers';
const FIELD = 'config.connectionId';

/** A trigger that answers `connection`'s number. */
const answering = (connection: FakeConnection, over: Record<string, unknown> = {}) => ({
  agentId: 'acme.support',
  projectId: PROJECT,
  config: { connectionId: connection.connectionId },
  ...over,
});

/** A trigger registered by `token` (Ada, unless named), and its id. */
async function registered(
  h: ReturnType<typeof harness>,
  body: Record<string, unknown>,
  token = 'ada',
): Promise<string> {
  const made = await h.call('POST', BASE, body, token);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.triggerId as string;
}

describe('register', () => {
  test('an admin registers a text trigger on a company connection of app `texts`: they own it, at the default limits', async () => {
    const h = harness();
    const res = await h.call('POST', BASE, answering(FRONT_DESK, { label: 'Front desk' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      agentId: 'acme.support',
      projectId: PROJECT,
      owner: { kind: 'user', id: ADA },
      connectionId: FRONT_DESK.connectionId,
      runsPerHour: 60,
      perSenderPerHour: 10,
      label: 'Front desk',
      status: 'active',
    });
    expect(res.body.toolsAllowedUnattended).toBeUndefined();
    expect(validateAgainst('TextTriggerRecord', res.body)).toEqual([]);
    const stored = await h.triggerRegistry.get({
      tenantId,
      triggerId: res.body.triggerId as TriggerId,
    });
    expect(stored?.kind).toBe('text');
  });

  test("the company's number is an admin's: a writer's register is a 403, and an admin's can name a service account, which owns it", async () => {
    const h = harness();
    const writers = await h.call('POST', BASE, answering(FRONT_DESK), 'wren');
    expect(writers.status).toBe(403);
    expect(writers.body.error.message).toBe("Answering the company's texts takes a project admin.");
    const shared = await h.call(
      'POST',
      BASE,
      answering(FRONT_DESK, { runAsServiceAccountId: BOT }),
    );
    expect(shared.status).toBe(201);
    expect(shared.body.owner).toMatchObject({ kind: 'service', id: BOT });
    expect(h.events('trigger-owner-set')).toHaveLength(1);
    // A project admin who isn't a tenant admin registers one too.
    const pias = await h.call('POST', BASE, answering(SALES), 'pia');
    expect(pias.status).toBe(201);
    expect(pias.body.owner).toMatchObject({ kind: 'user', id: PIA });
  });

  test('config takes the connection and the limits, and no input', async () => {
    const h = harness();
    const at = (config: Record<string, unknown>) => ({ ...answering(FRONT_DESK), config });
    const id = FRONT_DESK.connectionId;
    const cases: Record<string, unknown>[] = [
      at({ connectionId: id, input: {} }),
      at({ connectionId: id, pollSeconds: 60 }),
      at({}),
      at({ connectionId: 'front-desk' }),
      { ...answering(FRONT_DESK), config: [] },
      { ...answering(FRONT_DESK), flowId: 'acme.orders' },
      { projectId: PROJECT, config: { connectionId: id } },
    ];
    for (const body of cases) {
      expect((await h.call('POST', BASE, body)).status, JSON.stringify(body)).toBe(400);
    }
    const unnamed = await h.call('POST', BASE, at({ runsPerHour: 30 }));
    expect(unnamed.body.error.message).toBe(
      "`config.connectionId` is required: the company's connection of app `texts` for the number",
    );
    expect((await h.call('GET', BASE)).body.data).toEqual([]);
  });

  test('the limits: whole numbers within their bounds, the defaults when left out', async () => {
    const h = harness();
    const at = (limits: Record<string, unknown>) => ({
      ...answering(FRONT_DESK),
      config: { connectionId: FRONT_DESK.connectionId, ...limits },
    });
    for (const [limits, message] of [
      [
        { runsPerHour: 0 },
        '`config.runsPerHour` must be a whole number from 1 to 600 (default 60)',
      ],
      [
        { runsPerHour: 601 },
        '`config.runsPerHour` must be a whole number from 1 to 600 (default 60)',
      ],
      [
        { runsPerHour: 1.5 },
        '`config.runsPerHour` must be a whole number from 1 to 600 (default 60)',
      ],
      [
        { perSenderPerHour: 0 },
        '`config.perSenderPerHour` must be a whole number from 1 to 60 (default 10)',
      ],
      [
        { perSenderPerHour: 61 },
        '`config.perSenderPerHour` must be a whole number from 1 to 60 (default 10)',
      ],
      [
        { perSenderPerHour: '10' },
        '`config.perSenderPerHour` must be a whole number from 1 to 60 (default 10)',
      ],
    ] as const) {
      const res = await h.call('POST', BASE, at(limits));
      expect(res.status, JSON.stringify(limits)).toBe(400);
      expect(res.body.error.message).toBe(message);
    }
    const least = await h.call('POST', BASE, at({ runsPerHour: 1, perSenderPerHour: 1 }));
    expect(least.status).toBe(201);
    expect(least.body).toMatchObject({ runsPerHour: 1, perSenderPerHour: 1 });
    const id = least.body.triggerId as string;
    const most = await h.call('PATCH', `${BASE}/${id}`, {
      config: { runsPerHour: 600, perSenderPerHour: 60 },
    });
    expect(most.status).toBe(200);
    expect(most.body).toMatchObject({ runsPerHour: 600, perSenderPerHour: 60 });
    const over = await h.call('PATCH', `${BASE}/${id}`, { config: { perSenderPerHour: 61 } });
    expect(over.status).toBe(400);
    // A PATCH that leaves one out keeps it.
    const one = await h.call('PATCH', `${BASE}/${id}`, { config: { runsPerHour: 30 } });
    expect(one.body).toMatchObject({ runsPerHour: 30, perSenderPerHour: 60 });
  });
});

describe('one live text trigger a connection', () => {
  test('a register on a connection another live trigger answers is a 409 naming it, paused or not; once that one is unregistered, it registers', async () => {
    const h = harness();
    const first = await registered(h, answering(FRONT_DESK));
    const again = await h.call('POST', BASE, answering(FRONT_DESK, { agentId: 'acme.triage' }));
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'trigger-connection-taken',
      details: { heldBy: first, connectionId: FRONT_DESK.connectionId },
      requestId: 'req-text',
    });
    expect(again.body.error.message).toContain(first);
    expect((await h.call('POST', `${BASE}/${first}/pause`)).status).toBe(200);
    const paused = await h.call('POST', BASE, answering(FRONT_DESK));
    expect(paused.status).toBe(409);
    expect(paused.body.error.details.heldBy).toBe(first);
    expect((await h.call('GET', BASE)).body.data).toHaveLength(1);

    expect((await h.call('POST', `${BASE}/${first}/unregister`)).status).toBe(200);
    const freed = await h.call('POST', BASE, answering(FRONT_DESK));
    expect(freed.status).toBe(201);
    // Another connection was free all along.
    expect((await h.call('POST', BASE, answering(SALES))).status).toBe(201);
  });

  test('a move onto a connection another trigger answers is a 409 naming it, and nothing changes; its own connection sent again is no change', async () => {
    const h = harness();
    const front = await registered(h, answering(FRONT_DESK));
    const sales = await registered(h, answering(SALES));
    const moved = await h.call('PATCH', `${BASE}/${sales}`, {
      config: { connectionId: FRONT_DESK.connectionId },
    });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatchObject({
      code: 'trigger-connection-taken',
      details: { heldBy: front, connectionId: FRONT_DESK.connectionId, triggerId: sales },
    });
    const kept = await h.call('GET', `${BASE}/${sales}`);
    expect(kept.body).toMatchObject({ connectionId: SALES.connectionId, version: 1 });
    const same = await h.call('PATCH', `${BASE}/${front}`, {
      config: { connectionId: FRONT_DESK.connectionId },
    });
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(1);
  });

  test('a paused trigger keeps its connection, so its resume answers the same number', async () => {
    const h = harness();
    const id = await registered(h, answering(FRONT_DESK));
    expect((await h.call('POST', `${BASE}/${id}/pause`)).body.status).toBe('paused');
    expect((await h.call('POST', BASE, answering(FRONT_DESK))).status).toBe(409);
    const resumed = await h.call('POST', `${BASE}/${id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      status: 'active',
      connectionId: FRONT_DESK.connectionId,
      version: 1,
    });
  });
});

describe('the company connection it answers', () => {
  test("a named id that isn't one of the project's company connections of app `texts` is a 404 naming the field; a person's is a 400", async () => {
    const h = harness();
    for (const named of [BILLING, SUPPORT_GMAIL, { connectionId: randomUUID() }]) {
      const res = await h.call('POST', BASE, answering(named as FakeConnection));
      expect(res.status, named.connectionId).toBe(404);
      expect(res.body.error).toMatchObject({
        code: 'connection-not-found',
        details: { connectionId: named.connectionId, field: FIELD },
      });
    }
    const persons = await h.call('POST', BASE, answering(WRENS_TEXTS));
    expect(persons.status).toBe(400);
    expect(persons.body.error).toMatchObject({
      code: 'bad-input',
      message:
        "A person's own connection is used for them; a text trigger answers the number of a company connection.",
      details: { field: FIELD },
    });
    expect((await h.call('GET', BASE)).body.data).toEqual([]);
  });

  test("with no project to check against, a named id is the tenant's live company connection of app `texts`", async () => {
    const h = harness();
    const noProject = (connection: FakeConnection) => {
      const { projectId: _, ...body } = answering(connection);
      return body;
    };
    const named = await h.call('POST', BASE, noProject(BILLING));
    expect(named.status).toBe(201);
    expect(named.body.connectionId).toBe(BILLING.connectionId);
    expect((await h.call('POST', BASE, noProject(SUPPORT_GMAIL))).status).toBe(404);
    expect((await h.call('POST', BASE, noProject(WRENS_TEXTS))).status).toBe(400);
    // It takes a tenant admin.
    expect((await h.call('POST', BASE, noProject(FRONT_DESK), 'pia')).status).toBe(403);
  });

  test('a move to another connection is checked as at registration, frees the old one, and names the list again', async () => {
    const h = harness();
    const id = await registered(
      h,
      answering(FRONT_DESK, { toolsAllowedUnattended: ['acme.lookup'] }),
    );
    for (const elsewhere of [SUPPORT_GMAIL, BILLING]) {
      const res = await h.call('PATCH', `${BASE}/${id}`, {
        config: { connectionId: elsewhere.connectionId },
        toolsAllowedUnattended: ['acme.lookup'],
      });
      expect(res.status).toBe(404);
    }
    const bare = await h.call('PATCH', `${BASE}/${id}`, {
      config: { connectionId: SALES.connectionId },
    });
    expect(bare.status).toBe(400);
    expect(bare.body.error.message).toMatch(/a new target or connection must name it again/);
    expect((await h.call('GET', `${BASE}/${id}`)).body.connectionId).toBe(FRONT_DESK.connectionId);

    const moved = await h.call('PATCH', `${BASE}/${id}`, {
      config: { connectionId: SALES.connectionId },
      toolsAllowedUnattended: ['acme.lookup'],
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      connectionId: SALES.connectionId,
      toolsAllowedUnattended: ['acme.lookup'],
    });
    expect((await h.call('POST', BASE, answering(FRONT_DESK))).status).toBe(201);
  });
});

describe('toolsAllowedUnattended', () => {
  test('never lists `kindgi_send_text`: a 400 at register and on PATCH', async () => {
    const h = harness();
    for (const tools of [[SEND_TEXT_TOOL_ID], ['acme.lookup', SEND_TEXT_TOOL_ID]]) {
      const res = await h.call(
        'POST',
        BASE,
        answering(FRONT_DESK, { toolsAllowedUnattended: tools }),
      );
      expect(res.status, tools.join()).toBe(400);
      expect(res.body.error.message).toBe(
        "`toolsAllowedUnattended` can't list `kindgi_send_text`: a text that isn't a reply always waits for a person's yes",
      );
    }
    const id = await registered(h, answering(FRONT_DESK));
    const patched = await h.call('PATCH', `${BASE}/${id}`, {
      toolsAllowedUnattended: [SEND_TEXT_TOOL_ID],
    });
    expect(patched.status).toBe(400);
    expect(patched.body.error.message).toMatch(/always waits for a person's yes/);
    expect(h.events('trigger-tools-allowed-unattended-set')).toEqual([]);
  });

  test("an agent target's text trigger can list the reply and hand-to-person tools it is offered", async () => {
    const h = harness();
    const tools = [REPLY_TO_TEXT_TOOL_ID, HAND_TO_PERSON_TOOL_ID];
    const res = await h.call(
      'POST',
      BASE,
      answering(FRONT_DESK, { agentId: 'acme.triage', toolsAllowedUnattended: tools }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.toolsAllowedUnattended).toEqual(tools);
    const patched = await h.call('PATCH', `${BASE}/${res.body.triggerId}`, {
      toolsAllowedUnattended: [HAND_TO_PERSON_TOOL_ID],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.toolsAllowedUnattended).toEqual([HAND_TO_PERSON_TOOL_ID]);
  });

  test('`texts.send` is just an id its agent does not call: a 400 that says so', async () => {
    const h = harness();
    const res = await h.call(
      'POST',
      BASE,
      answering(FRONT_DESK, { agentId: 'acme.triage', toolsAllowedUnattended: ['texts.send'] }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      '`toolsAllowedUnattended`: agent "acme.triage" doesn\'t call "texts.send"',
    );
  });

  test('a flow whose step is an agent can list the reply and hand-to-person tools', async () => {
    const h = harness();
    const tools = [REPLY_TO_TEXT_TOOL_ID, HAND_TO_PERSON_TOOL_ID];
    const res = await h.call('POST', BASE, {
      flowId: 'acme.orders',
      flowVersion: '1.0.0',
      projectId: PROJECT,
      config: { connectionId: FRONT_DESK.connectionId },
      toolsAllowedUnattended: tools,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.toolsAllowedUnattended).toEqual(tools);
  });

  test("a flow with no agent step of its own can't: only the target's agent steps answer the text", async () => {
    const h = harness();
    // Tool steps only; or an agent step in a subflow, whose run is the
    // subflow's, not the trigger's target's.
    for (const flowId of ['acme.batch', 'acme.nested']) {
      const res = await h.call('POST', BASE, {
        flowId,
        flowVersion: '1.0.0',
        projectId: PROJECT,
        config: { connectionId: FRONT_DESK.connectionId },
        toolsAllowedUnattended: [REPLY_TO_TEXT_TOOL_ID],
      });
      expect(res.status, flowId).toBe(400);
      expect(res.body.error.message).toBe(
        `\`toolsAllowedUnattended\`: flow "${flowId}" at 1.0.0 doesn't call "${REPLY_TO_TEXT_TOOL_ID}"`,
      );
    }
  });

  test('an agent that declares what it remembers can list the remember tool', async () => {
    const h = harness();
    const res = await h.call(
      'POST',
      BASE,
      answering(FRONT_DESK, {
        agentId: 'acme.remembers',
        toolsAllowedUnattended: [REMEMBER_TOOL_ID],
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.toolsAllowedUnattended).toEqual([REMEMBER_TOOL_ID]);
    // An agent that declares none is not offered it.
    const none = await h.call(
      'POST',
      BASE,
      answering(FRONT_DESK, { agentId: 'acme.triage', toolsAllowedUnattended: [REMEMBER_TOOL_ID] }),
    );
    expect(none.status).toBe(400);
  });

  test("an admin's list of tools its target calls is set and audited; a tool it never calls is a 400", async () => {
    const h = harness();
    const id = await registered(h, answering(FRONT_DESK));
    const listed = await h.call('PATCH', `${BASE}/${id}`, {
      toolsAllowedUnattended: ['acme.lookup', 'acme.note'],
    });
    expect(listed.status).toBe(200);
    expect(listed.body.toolsAllowedUnattended).toEqual(['acme.lookup', 'acme.note']);
    expect(docOf(h.events('trigger-tools-allowed-unattended-set').at(-1))).toMatchObject({
      triggerKind: 'text',
      to: ['acme.lookup', 'acme.note'],
    });
    const never = await h.call('PATCH', `${BASE}/${id}`, {
      toolsAllowedUnattended: ['acme.refund'],
    });
    expect(never.status).toBe(400);
  });

  test('a retarget while it lists any must name it again; a version change keeps it', async () => {
    const h = harness();
    const id = await registered(
      h,
      answering(FRONT_DESK, { agentVersion: '1.0.0', toolsAllowedUnattended: ['acme.lookup'] }),
    );
    const version = await h.call('PATCH', `${BASE}/${id}`, {
      agentId: 'acme.support',
      agentVersion: '2.0.0',
    });
    expect(version.status).toBe(200);
    expect(version.body.toolsAllowedUnattended).toEqual(['acme.lookup']);
    const bare = await h.call('PATCH', `${BASE}/${id}`, { agentId: 'acme.triage' });
    expect(bare.status).toBe(400);
    const cleared = await h.call('PATCH', `${BASE}/${id}`, {
      agentId: 'acme.triage',
      toolsAllowedUnattended: [],
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.toolsAllowedUnattended).toBeUndefined();
  });
});

describe('who may change it', () => {
  test("every PATCH is a project admin's; a shared trigger's pause, resume and unregister are a writer's", async () => {
    const h = harness();
    const id = await registered(h, answering(FRONT_DESK, { runAsServiceAccountId: BOT }));
    const writers = await h.call('PATCH', `${BASE}/${id}`, { label: 'x' }, 'wren');
    expect(writers.status).toBe(403);
    expect(writers.body.error.message).toBe('Changing a text trigger takes a project admin.');
    for (const verb of ['pause', 'resume', 'unregister']) {
      expect((await h.call('POST', `${BASE}/${id}/${verb}`, undefined, 'wren')).status, verb).toBe(
        200,
      );
    }
  });

  test("a personal trigger: another member's PATCH, pause and unregister are each a 403; another admin's change is audited, and its owner told", async () => {
    const h = harness();
    const id = await registered(h, answering(FRONT_DESK, { label: 'Front desk' }), 'pia');
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'x' }, 'wren')).status).toBe(403);
    for (const verb of ['pause', 'unregister']) {
      expect((await h.call('POST', `${BASE}/${id}/${verb}`, undefined, 'wren')).status, verb).toBe(
        403,
      );
    }
    // Its owner's own change isn't audited for the owner.
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'Desk' }, 'pia')).status).toBe(200);
    expect(h.told).toEqual([]);

    const res = await h.call('PATCH', `${BASE}/${id}`, {
      config: { connectionId: SALES.connectionId, perSenderPerHour: 5 },
    });
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: PIA });
    expect(docOf(h.events('trigger-changed-for-owner').at(-1))).toMatchObject({
      triggerId: id,
      triggerKind: 'text',
      owner: `user:${PIA}`,
      change: 'updated',
      fields: ['connectionId', 'perSenderPerHour'],
      connectionId: { before: FRONT_DESK.connectionId, after: SALES.connectionId },
    });
    expect(h.told).toEqual([
      expect.objectContaining({
        triggerId: id,
        triggerKind: 'text',
        owner: { kind: 'user', id: PIA },
        change: 'updated',
      }),
    ]);
  });

  test('a PATCH that names an owner is a 400: the owner moves only by a take-over', async () => {
    const h = harness();
    const id = await registered(h, answering(FRONT_DESK));
    for (const body of [{ runAsServiceAccountId: BOT }, { runAsProject: true }]) {
      const res = await h.call('PATCH', `${BASE}/${id}`, body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/only by a take-over/);
    }
  });
});

describe('versions and take-over', () => {
  test('each change makes a version; a version reads as it was', async () => {
    const h = harness();
    const id = await registered(h, answering(FRONT_DESK, { label: 'Front desk' }));
    const paced = await h.call('PATCH', `${BASE}/${id}`, { config: { runsPerHour: 30 } });
    expect(paced.body.version).toBe(2);
    const page = await h.call('GET', `${BASE}/${id}/versions`, undefined, 'wren');
    expect(page.status).toBe(200);
    expect(validateAgainst('TextTriggerVersionPage', page.body)).toEqual([]);
    expect(page.body.data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(page.body.data[0].definition).toMatchObject({
      agentId: 'acme.support',
      connectionId: FRONT_DESK.connectionId,
      runsPerHour: 30,
      perSenderPerHour: 10,
      label: 'Front desk',
    });
    const first = await h.call('GET', `${BASE}/${id}/versions/1`);
    expect(first.status).toBe(200);
    expect(validateAgainst('TextTriggerVersion', first.body)).toEqual([]);
    expect(first.body.definition).toMatchObject({ runsPerHour: 60 });
    const never = await h.call('GET', `${BASE}/${id}/versions/9`);
    expect(never.status).toBe(404);
    expect(never.body.error.code).toBe('trigger-version-not-found');
  });

  test("a take-over is an admin's: it keeps the list, a body that names it is a 400, and the former owner is told", async () => {
    const h = harness();
    const id = await registered(
      h,
      answering(FRONT_DESK, { toolsAllowedUnattended: ['acme.lookup'] }),
      'pia',
    );
    const writers = await h.call('POST', `${BASE}/${id}/owner`, undefined, 'wren');
    expect(writers.status).toBe(403);
    expect(writers.body.error.message).toBe('Taking a text trigger over takes a project admin.');
    const named = await h.call('POST', `${BASE}/${id}/owner`, { toolsAllowedUnattended: [] });
    expect(named.status).toBe(400);
    const taken = await h.call('POST', `${BASE}/${id}/owner`, {});
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({
      owner: { kind: 'user', id: ADA },
      toolsAllowedUnattended: ['acme.lookup'],
    });
    expect(h.told.at(-1)).toMatchObject({
      triggerId: id,
      triggerKind: 'text',
      owner: { kind: 'user', id: PIA },
      change: 'taken-over',
    });
    const shared = await h.call('POST', `${BASE}/${id}/owner`, { runAsServiceAccountId: BOT });
    expect(shared.status).toBe(200);
    expect(shared.body.owner).toMatchObject({ kind: 'service', id: BOT });
  });
});

describe('without an authorization store', () => {
  test("a member's register or PATCH is a 403, and a tenant-admin token's is OK", async () => {
    const h = harness({ store: false });
    expect((await h.call('POST', BASE, answering(FRONT_DESK), 'wren')).status).toBe(403);
    const id = await registered(h, answering(FRONT_DESK));
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'x' }, 'wren')).status).toBe(403);
    expect((await h.call('PATCH', `${BASE}/${id}`, { label: 'Desk' })).status).toBe(200);
  });
});

describe('reads', () => {
  test("a get reads a text trigger; another kind's id, and an id that isn't one, aren't found here", async () => {
    const h = harness();
    const id = await registered(h, answering(FRONT_DESK));
    const got = await h.call('GET', `${BASE}/${id}`, undefined, 'wren');
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

  test("the list holds the tenant's text triggers, by status and project", async () => {
    const h = harness();
    const a = await registered(h, answering(FRONT_DESK));
    const b = await registered(h, answering(SALES));
    await h.call('POST', `${BASE}/${b}/pause`);
    const schedule = await h.call('POST', '/v1/schedules', {
      agentId: 'acme.support',
      projectId: PROJECT,
      config: { cronExpression: '0 7 * * 1-5', input: { userMessage: 'The digest.' } },
    });
    expect(schedule.status).toBe(201);
    const all = await h.call('GET', BASE, undefined, 'wren');
    expect(all.status).toBe(200);
    expect(all.body.data.map((t: { triggerId: string }) => t.triggerId).sort()).toEqual(
      [a, b].sort(),
    );
    expect(validateAgainst('TextTriggerCollectionPage', all.body)).toEqual([]);
    const paused = await h.call('GET', `${BASE}?status=paused`);
    expect(paused.body.data.map((t: { triggerId: string }) => t.triggerId)).toEqual([b]);
    const elsewhere = await h.call('GET', `${BASE}?projectId=${randomUUID()}`);
    expect(elsewhere.body.data).toEqual([]);
    expect((await h.call('GET', `${BASE}?projectId=nope`)).status).toBe(400);
  });

  test("fires: a text's fire past a limit says it was refused", async () => {
    const h = harness();
    const id = await registered(h, answering(FRONT_DESK));
    h.triggerRegistry.recordFire({
      triggerId: id as TriggerId,
      kind: 'text',
      firedAt: new Date().toISOString(),
      outcome: 'refused',
      detail: 'over-limit: 10 runs an hour from one sender',
    });
    const res = await h.call('GET', `${BASE}/${id}/fires`, undefined, 'wren');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        triggerId: id,
        outcome: 'refused',
        detail: 'over-limit: 10 runs an hour from one sender',
      }),
    ]);
    expect(validateAgainst('TextFirePage', res.body)).toEqual([]);
  });
});

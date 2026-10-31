// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A trigger named to run as a service account (`runAsServiceAccountId`)
 * needs an account that can run what the trigger starts: the check every
 * fire makes, asked when the owner is set. Otherwise each fire would be
 * refused until the trigger paused.
 *
 * - With an authorization model: register and take-over, for schedules,
 *   webhooks and mail triggers, refuse an account that can't with a 409
 *   `trigger-owner-cannot-run-target`, after the `act_as` gate, so no
 *   one past whom the gate stops learns anything.
 * - The account's check is `targetAccess`: `execute` on the flow or agent,
 *   `publish` on the agent for an Improve run.
 * - A retarget (`PATCH` with a new target) of a schedule or mail trigger
 *   asks the same of its owner, of any kind, since the owner stays: unless
 *   the caller is the owner, or the owner is gone.
 * - Without a model, nothing changes: a grant limits nothing there.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type Action,
  type AuthzCheckBinding,
  type AuthzCheckContext,
  type Decision,
  type Principal,
  type ResourceRef,
  ref,
  targetAccess,
} from '@kindgi/authz';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  IdentityDirectoryBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ADA = randomUUID() as UserId;
const MEMBER = randomUUID() as UserId;
/** A project admin who isn't a tenant admin. */
const PADMIN = randomUUID() as UserId;
/** A person who owns a schedule. */
const PAT = randomUUID() as UserId;
const BOT = randomUUID();
const PROJECT = randomUUID() as ProjectId;
const ADMIN_TOKEN = 'can-run-admin';
const MEMBER_TOKEN = 'can-run-member';
const PADMIN_TOKEN = 'can-run-project-admin';
const PAT_TOKEN = 'can-run-pat';
const FLOW = 'acme.nightly';
const AGENT = 'acme.agent';
/** The agent a retarget moves a schedule to. */
const AGENT2 = 'acme.agent-two';

const resolveToken: TokenResolver = async (token) => {
  if (token === ADMIN_TOKEN) return { tenantId, userId: ADA, scopes: ['tenant-admin'] };
  if (token === MEMBER_TOKEN) return { tenantId, userId: MEMBER, scopes: [] };
  if (token === PADMIN_TOKEN) return { tenantId, userId: PADMIN, scopes: [] };
  if (token === PAT_TOKEN) return { tenantId, userId: PAT, scopes: [] };
  return null;
};

/** What the caller (Ada, a tenant admin) holds: enough to register and take over anything here. */
const ADA_GRANTS = [
  `admin tenant:${tenantId}`,
  `read project:${PROJECT}`,
  `write project:${PROJECT}`,
  `admin project:${PROJECT}`,
  `execute flow:${FLOW}`,
  `execute agent:${AGENT}`,
  `execute agent:${AGENT2}`,
  `publish agent:${AGENT}`,
  `act_as service_account:${BOT}`,
];

/** What the project admin and Pat hold as callers: enough to see and change the schedule. */
const PADMIN_GRANTS = [
  `padmin read project:${PROJECT}`,
  `padmin write project:${PROJECT}`,
  `padmin admin project:${PROJECT}`,
  `padmin execute agent:${AGENT}`,
  `padmin execute agent:${AGENT2}`,
];
const PAT_GRANTS = [
  `pat read project:${PROJECT}`,
  `pat write project:${PROJECT}`,
  `pat execute agent:${AGENT}`,
];

/**
 * A key the fake store grants, as `action type:id`: Ada's bare, the
 * others' prefixed `member `, `padmin ` or `pat `, the account's `bot `.
 */
const WHO: Readonly<Record<string, string>> = {
  [MEMBER]: 'member ',
  [PADMIN]: 'padmin ',
  [PAT]: 'pat ',
};
const key = (p: Principal, action: Action, r: ResourceRef) => {
  const who = p.actor.kind === 'service_account' ? 'bot ' : (WHO[p.actor.id] ?? '');
  return `${who}${action} ${r.type}:${r.id}`;
};

/**
 * The app with a fake store that grants `grants` and records each ask,
 * with the context it was asked with. `failForBot` makes every check of the
 * account throw, as a store that's down does. `gone` is read on each call:
 * set `bot` to unregister the account, `pat` to remove Pat, `reads` to make
 * every read of either fail. `directory: false` leaves the app without one.
 */
function harness(
  grants: readonly string[],
  opts: {
    readonly authz?: boolean;
    readonly failForBot?: boolean;
    readonly directory?: boolean;
  } = {},
) {
  const gone = { bot: false, pat: false, reads: false };
  const asked: { readonly key: string; readonly ctx?: AuthzCheckContext }[] = [];
  const decide = (
    p: Principal,
    action: Action,
    r: ResourceRef,
    ctx?: AuthzCheckContext,
  ): Decision => {
    const k = key(p, action, r);
    asked.push({ key: k, ...(ctx !== undefined && { ctx }) });
    if (opts.failForBot === true && p.actor.kind === 'service_account') {
      throw new Error('test: the store is down');
    }
    const allowed = [...ADA_GRANTS, ...PADMIN_GRANTS, ...PAT_GRANTS, ...grants].includes(k);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (p, action, r, ctx) => decide(p, action, r, ctx),
    checkBatch: async (p, action, rs, ctx) => rs.map((r) => decide(p, action, r, ctx)),
  };
  const serviceAccountBinding = {
    get: async ({ serviceAccountId }: { serviceAccountId: string }) => {
      if (gone.reads) throw new Error('test: the read failed');
      return serviceAccountId === BOT
        ? {
            serviceAccountId,
            tenantId,
            name: 'acme-nightly-bot',
            grants: [],
            createdAt: '',
            ...(gone.bot && { unregisteredAt: '2026-10-26T00:00:00Z' }),
          }
        : null;
    },
  } as unknown as ServiceAccountBinding;
  const identityDirectory = {
    getUser: async ({ userId }: { userId: string }) => {
      if (gone.reads) throw new Error('test: the read failed');
      return userId === PAT
        ? {
            userId,
            tenantId,
            displayName: 'Pat Acme',
            createdAt: '',
            ...(gone.pat && { unregisteredAt: '2026-10-26T00:00:00Z' }),
          }
        : null;
    },
  } as unknown as IdentityDirectoryBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: createInMemoryTriggerRegistry({ defaultProjectId: PROJECT }),
    serviceAccountBinding,
    ...(opts.directory !== false && { identityDirectory }),
    ...(opts.authz !== false && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });
  const call = async (method: string, path: string, body?: unknown, token = ADMIN_TOKEN) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': 'req-can-run',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      // Not JSON: an empty body stands.
    }
    return { status: res.status, body: json };
  };
  /** The account's asks, by key. */
  const botAsked = () => asked.filter((a) => a.key.startsWith('bot ')).map((a) => a.key);
  /** How many times the store was asked `k`. */
  const askedTimes = (k: string) => asked.filter((a) => a.key === k).length;
  return { call, asked, botAsked, askedTimes, gone };
}

const schedule = (over: Record<string, unknown> = {}) => ({
  agentId: AGENT,
  projectId: PROJECT,
  config: { cronExpression: '0 2 * * *', input: { userMessage: 'Check the overnight orders.' } },
  ...over,
});
const flowSchedule = () =>
  schedule({
    agentId: undefined,
    flowId: FLOW,
    flowVersion: '1.0.0',
    config: { cronExpression: '0 2 * * *' },
  });
const improveSchedule = () =>
  schedule({
    agentId: undefined,
    improve: { agentId: AGENT, scope: { kind: 'project', projectId: PROJECT } },
    config: { cronExpression: '0 2 * * *' },
  });
const webhook = (over: Record<string, unknown> = {}) => ({
  flowId: FLOW,
  flowVersion: '1.0.0',
  hmacSecretName: 'acme-hmac',
  projectId: PROJECT,
  ...over,
});

const AGENT_MESSAGE = `Service account "acme-nightly-bot" can't run agent "${AGENT}", so the trigger can't run as it. Give the account the editor role on the target's project, or name another account.`;
const FLOW_MESSAGE = `Service account "acme-nightly-bot" can't run flow "${FLOW}", so the trigger can't run as it. Give the account the editor role on the target's project, or name another account.`;
const IMPROVE_MESSAGE = `Service account "acme-nightly-bot" can't publish agent "${AGENT}", so the trigger can't run as it. Give the account the editor role on the target's project, or name another account.`;

describe('targetAccess: the one mapping a trigger target is checked by', () => {
  test('execute on a flow or an agent; publish on the agent an Improve run works on', () => {
    expect(targetAccess({ kind: 'flow', flowId: FLOW })).toEqual(['execute', ref('flow', FLOW)]);
    expect(targetAccess({ kind: 'agent', agentId: AGENT })).toEqual([
      'execute',
      ref('agent', AGENT),
    ]);
    expect(targetAccess({ kind: 'improve', agentId: AGENT })).toEqual([
      'publish',
      ref('agent', AGENT),
    ]);
  });
});

describe('register: an account that cannot run the target is a 409', () => {
  test('a schedule with an agent target', async () => {
    const h = harness([]);
    const res = await h.call('POST', '/v1/schedules', schedule({ runAsServiceAccountId: BOT }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: AGENT_MESSAGE,
    });
    expect(h.botAsked()).toEqual([`bot execute agent:${AGENT}`]);
    // Nothing was made.
    expect((await h.call('GET', '/v1/schedules')).body.data).toEqual([]);
  });

  test('a schedule with a flow target', async () => {
    const h = harness([]);
    const res = await h.call('POST', '/v1/schedules', {
      ...flowSchedule(),
      runAsServiceAccountId: BOT,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ message: FLOW_MESSAGE });
    expect(h.botAsked()).toEqual([`bot execute flow:${FLOW}`]);
  });

  test('an improvement schedule asks publish, and an account that is only a viewer has none', async () => {
    const h = harness([`bot read agent:${AGENT}`, `bot execute agent:${AGENT}`]);
    const res = await h.call('POST', '/v1/schedules', {
      ...improveSchedule(),
      runAsServiceAccountId: BOT,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: IMPROVE_MESSAGE,
    });
    expect(h.botAsked()).toEqual([`bot publish agent:${AGENT}`]);
  });

  test('a webhook', async () => {
    const h = harness([]);
    const res = await h.call('POST', '/v1/webhooks', webhook({ runAsServiceAccountId: BOT }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: FLOW_MESSAGE,
    });
    expect(h.botAsked()).toEqual([`bot execute flow:${FLOW}`]);
  });
});

describe('register: an account that can run it owns the trigger', () => {
  test('a schedule, a flow schedule, an improvement schedule and a webhook', async () => {
    const h = harness([
      `bot execute agent:${AGENT}`,
      `bot execute flow:${FLOW}`,
      `bot publish agent:${AGENT}`,
    ]);
    for (const [path, body] of [
      ['/v1/schedules', schedule()],
      ['/v1/schedules', flowSchedule()],
      ['/v1/schedules', improveSchedule()],
      ['/v1/webhooks', webhook()],
    ] as const) {
      const res = await h.call('POST', path, { ...body, runAsServiceAccountId: BOT });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
    }
  });
});

describe('take-over: naming an account that cannot run the target is a 409', () => {
  test('a schedule: a 409 while the account cannot run it, and the owner stays', async () => {
    const h = harness([]);
    const made = await h.call('POST', '/v1/schedules', schedule());
    expect(made.status).toBe(201);
    const id = made.body.triggerId as string;
    const refused = await h.call('POST', `/v1/schedules/${id}/owner`, {
      runAsServiceAccountId: BOT,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: AGENT_MESSAGE,
    });
    // The owner is unchanged.
    expect((await h.call('GET', `/v1/schedules/${id}`)).body.owner).toMatchObject({
      kind: 'user',
      id: ADA,
    });
  });

  test('a webhook', async () => {
    const h = harness([]);
    const made = await h.call('POST', '/v1/webhooks', webhook());
    expect(made.status).toBe(201);
    const id = made.body.triggerId as string;
    const refused = await h.call('POST', `/v1/webhooks/${id}/owner`, {
      runAsServiceAccountId: BOT,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: FLOW_MESSAGE,
    });
  });

  test('an account that can run it takes the schedule over', async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const made = await h.call('POST', '/v1/schedules', schedule());
    const id = made.body.triggerId as string;
    const ok = await h.call('POST', `/v1/schedules/${id}/owner`, { runAsServiceAccountId: BOT });
    expect(ok.status).toBe(200);
    expect(ok.body.owner).toMatchObject({ kind: 'service', id: BOT });
  });
});

describe('the check comes after the act_as gate', () => {
  test('a caller without act_as gets the one 403, and the account is never asked', async () => {
    const h = harness([`member write project:${PROJECT}`, `member execute agent:${AGENT}`]);
    const res = await h.call(
      'POST',
      '/v1/schedules',
      schedule({ runAsServiceAccountId: BOT }),
      MEMBER_TOKEN,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'permission-denied' });
    expect(h.botAsked()).toEqual([]);
  });
});

describe("the account's check, as the store sees it", () => {
  test("it carries the request's id as its correlation id", async () => {
    const h = harness([]);
    await h.call('POST', '/v1/schedules', schedule({ runAsServiceAccountId: BOT }));
    const ask = h.asked.find((a) => a.key.startsWith('bot '));
    expect(ask?.ctx).toMatchObject({ correlationId: 'req-can-run' });
  });

  test('a store that fails refuses the request, and no trigger is made', async () => {
    const h = harness([], { failForBot: true });
    const res = await h.call('POST', '/v1/schedules', schedule({ runAsServiceAccountId: BOT }));
    expect(res.status).toBe(500);
    expect((await h.call('GET', '/v1/schedules')).body.data).toEqual([]);
  });
});

const BOT_RETARGET = `Service account "acme-nightly-bot" can't run agent "${AGENT2}", so the trigger can't run it as that account. A tenant admin can give the account the editor role on the target's project, or a project admin can take the trigger over first.`;
const patRetarget = (name: string) =>
  `${name} can't run agent "${AGENT2}", so the trigger can't run it as them. A project admin can take the trigger over first.`;

type Harness = ReturnType<typeof harness>;

/** A schedule the account owns (it must be able to run AGENT). */
async function botSchedule(h: Harness): Promise<string> {
  const made = await h.call('POST', '/v1/schedules', schedule({ runAsServiceAccountId: BOT }));
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.triggerId as string;
}

/** A schedule Pat registered, so Pat owns it. */
async function patSchedule(h: Harness): Promise<string> {
  const made = await h.call('POST', '/v1/schedules', schedule(), PAT_TOKEN);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body.owner).toMatchObject({ kind: 'user', id: PAT });
  return made.body.triggerId as string;
}

const retarget = (h: Harness, id: string, token = ADMIN_TOKEN) =>
  h.call('PATCH', `/v1/schedules/${id}`, { agentId: AGENT2 }, token);

describe('retarget: the owner must be able to run the new target', () => {
  test('to an agent the owner account cannot run: a 409, and the schedule keeps its target', async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const id = await botSchedule(h);
    const res = await retarget(h, id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: BOT_RETARGET,
    });
    expect(h.botAsked()).toContain(`bot execute agent:${AGENT2}`);
    const got = await h.call('GET', `/v1/schedules/${id}`);
    expect(JSON.stringify(got.body)).not.toContain(AGENT2);
  });

  test('to an Improve run, asked publish: an account with only execute gets a 409', async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const id = await botSchedule(h);
    const res = await h.call('PATCH', `/v1/schedules/${id}`, {
      improve: { agentId: AGENT, scope: { kind: 'project', projectId: PROJECT } },
      config: { input: {} },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: BOT_RETARGET.replace(`run agent "${AGENT2}"`, `publish agent "${AGENT}"`),
    });
    expect(h.botAsked()).toContain(`bot publish agent:${AGENT}`);
    const got = await h.call('GET', `/v1/schedules/${id}`);
    expect(JSON.stringify(got.body)).not.toContain('"improve"');
  });

  test('to one it can run: a 200, and the account still owns it', async () => {
    const h = harness([`bot execute agent:${AGENT}`, `bot execute agent:${AGENT2}`]);
    const id = await botSchedule(h);
    const res = await retarget(h, id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
  });

  test('a change that keeps the target asks the owner nothing', async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const id = await botSchedule(h);
    const before = h.botAsked().length;
    const res = await h.call('PATCH', `/v1/schedules/${id}`, { label: 'nightly orders' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.botAsked()).toHaveLength(before);
  });
});

describe('retarget: who reaches the 409', () => {
  test('a project admin who is not a tenant admin gets it, with the same words', async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const id = await botSchedule(h);
    const res = await retarget(h, id, PADMIN_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: BOT_RETARGET,
    });
  });

  test("a writer who isn't an admin gets the shared schedule's 403 first, and the account isn't asked", async () => {
    const h = harness([
      `bot execute agent:${AGENT}`,
      `member read project:${PROJECT}`,
      `member write project:${PROJECT}`,
      `member execute agent:${AGENT}`,
      `member execute agent:${AGENT2}`,
    ]);
    const id = await botSchedule(h);
    const res = await retarget(h, id, MEMBER_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(h.askedTimes(`bot execute agent:${AGENT2}`)).toBe(0);
  });
});

describe("retarget: a person's schedule", () => {
  test("a project admin moves it to an agent Pat can't run: the 409 names Pat", async () => {
    const h = harness([]);
    const id = await patSchedule(h);
    const res = await retarget(h, id, PADMIN_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: patRetarget('Pat Acme'),
    });
    expect(h.askedTimes(`pat execute agent:${AGENT2}`)).toBe(1);
  });

  test("Pat moves it there: Pat's own 403 as the caller, before any 409", async () => {
    const h = harness([]);
    const id = await patSchedule(h);
    const res = await retarget(h, id, PAT_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'permission-denied' });
    expect(h.askedTimes(`pat execute agent:${AGENT2}`)).toBe(1);
  });

  test('Pat moves it to an agent Pat can run: a 200, asked once, as the caller', async () => {
    const h = harness([`pat execute agent:${AGENT2}`]);
    const id = await patSchedule(h);
    const res = await retarget(h, id, PAT_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.askedTimes(`pat execute agent:${AGENT2}`)).toBe(1);
  });

  test('an agent Pat can run: a 200, and Pat still owns it', async () => {
    const h = harness([`pat execute agent:${AGENT2}`]);
    const id = await patSchedule(h);
    const res = await retarget(h, id, PADMIN_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: PAT });
  });

  test('without a directory, the words name Pat by id', async () => {
    const h = harness([], { directory: false });
    const id = await patSchedule(h);
    const res = await retarget(h, id, PADMIN_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({ message: patRetarget(PAT) });
  });
});

describe('retarget: an owner that is gone is not checked', () => {
  test('an unregistered account: a 200, and the account is not asked', async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const id = await botSchedule(h);
    h.gone.bot = true;
    const res = await retarget(h, id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.askedTimes(`bot execute agent:${AGENT2}`)).toBe(0);
  });

  test('a person removed from the tenant: a 200, and they are not asked', async () => {
    const h = harness([]);
    const id = await patSchedule(h);
    h.gone.pat = true;
    const res = await retarget(h, id, PADMIN_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.askedTimes(`pat execute agent:${AGENT2}`)).toBe(0);
  });

  test("a read that fails isn't a gone owner: the check runs, and the id names the account", async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const id = await botSchedule(h);
    h.gone.reads = true;
    const res = await retarget(h, id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      message: BOT_RETARGET.replace('"acme-nightly-bot"', `"${BOT}"`),
    });
  });
});

const MAIL = '/v1/mail-triggers';
/** A trigger on the company's mailbox, which an account may own. */
const companyMail = (over: Record<string, unknown> = {}) => ({
  agentId: AGENT,
  projectId: PROJECT,
  config: { mailbox: { app: 'microsoft', as: 'company' } },
  ...over,
});
/** A trigger on Pat's own mailbox, so Pat owns it. */
const patMail = () => ({
  agentId: AGENT,
  projectId: PROJECT,
  config: { mailbox: { app: 'google', as: 'person' } },
});

describe('mail triggers: the owner must be able to run the target, too', () => {
  test('register naming an account that cannot run it: a 409, and nothing is made', async () => {
    const h = harness([]);
    const res = await h.call('POST', MAIL, companyMail({ runAsServiceAccountId: BOT }));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: AGENT_MESSAGE,
    });
    expect((await h.call('GET', MAIL)).body.data).toEqual([]);
  });

  test('take-over naming that account: a 409, and the owner stays', async () => {
    const h = harness([]);
    const made = await h.call('POST', MAIL, companyMail());
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.triggerId as string;
    const res = await h.call('POST', `${MAIL}/${id}/owner`, { runAsServiceAccountId: BOT });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: AGENT_MESSAGE,
    });
    expect((await h.call('GET', `${MAIL}/${id}`)).body.owner).toMatchObject({
      kind: 'user',
      id: ADA,
    });
  });

  test('an account that can run it owns the mail trigger', async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const made = await h.call('POST', MAIL, companyMail({ runAsServiceAccountId: BOT }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.owner).toMatchObject({ kind: 'service', id: BOT });
  });

  test('retarget of one the account owns to an agent it cannot run: a 409, and the target is kept', async () => {
    const h = harness([`bot execute agent:${AGENT}`]);
    const made = await h.call('POST', MAIL, companyMail({ runAsServiceAccountId: BOT }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.triggerId as string;
    const res = await h.call('PATCH', `${MAIL}/${id}`, { agentId: AGENT2 });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: BOT_RETARGET,
    });
    expect(JSON.stringify((await h.call('GET', `${MAIL}/${id}`)).body)).not.toContain(AGENT2);
  });

  test("a project admin moves Pat's to an agent Pat can't run: the 409 names Pat", async () => {
    const h = harness([]);
    const made = await h.call('POST', MAIL, patMail(), PAT_TOKEN);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.triggerId as string;
    const res = await h.call('PATCH', `${MAIL}/${id}`, { agentId: AGENT2 }, PADMIN_TOKEN);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: patRetarget('Pat Acme'),
    });
  });

  test('an account that can run both: register and retarget succeed, and it owns the trigger', async () => {
    const h = harness([`bot execute agent:${AGENT}`, `bot execute agent:${AGENT2}`]);
    const made = await h.call('POST', MAIL, companyMail({ runAsServiceAccountId: BOT }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const res = await h.call('PATCH', `${MAIL}/${made.body.triggerId as string}`, {
      agentId: AGENT2,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
  });
});

describe('without an authorization model, nothing changes', () => {
  test('a tenant-admin key names an account with no grants: the account owns the trigger', async () => {
    const h = harness([], { authz: false });
    for (const [path, body] of [
      ['/v1/schedules', schedule()],
      ['/v1/webhooks', webhook()],
    ] as const) {
      const res = await h.call('POST', path, { ...body, runAsServiceAccountId: BOT });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
    }
    expect(h.asked).toEqual([]);
  });

  test('a retarget of a schedule the account owns gets a 200', async () => {
    const h = harness([], { authz: false });
    const made = await h.call('POST', '/v1/schedules', schedule({ runAsServiceAccountId: BOT }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const res = await retarget(h, made.body.triggerId as string);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.asked).toEqual([]);
  });
});

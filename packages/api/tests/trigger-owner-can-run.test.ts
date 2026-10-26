// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A trigger named to run as a service account (`runAsServiceAccountId`)
 * needs an account that can run what the trigger starts: the check every
 * fire makes, asked when the owner is set. Otherwise each fire would be
 * refused until the trigger paused.
 *
 * - With an authorization model: register and take-over, for schedules and
 *   webhooks, refuse an account that can't with a 409
 *   `trigger-owner-cannot-run-target`, after the `act_as` gate, so no
 *   one past whom the gate stops learns anything.
 * - The account's check is `targetAccess`: `execute` on the flow or agent,
 *   `publish` on the agent for an improvement pass.
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
import type { RunHandlerBinding, ServiceAccountBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ADA = randomUUID() as UserId;
const MEMBER = randomUUID() as UserId;
const BOT = randomUUID();
const PROJECT = randomUUID() as ProjectId;
const ADMIN_TOKEN = 'can-run-admin';
const MEMBER_TOKEN = 'can-run-member';
const FLOW = 'acme.nightly';
const AGENT = 'acme.agent';

const resolveToken: TokenResolver = async (token) => {
  if (token === ADMIN_TOKEN) return { tenantId, userId: ADA, scopes: ['tenant-admin'] };
  if (token === MEMBER_TOKEN) return { tenantId, userId: MEMBER, scopes: [] };
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
  `publish agent:${AGENT}`,
  `act_as service_account:${BOT}`,
];

/**
 * A key the fake store grants, as `action type:id`: Ada's bare, the
 * member's prefixed `member `, the account's prefixed `bot `.
 */
const key = (p: Principal, action: Action, r: ResourceRef) => {
  const who = p.actor.kind === 'service_account' ? 'bot ' : p.actor.id === MEMBER ? 'member ' : '';
  return `${who}${action} ${r.type}:${r.id}`;
};

/**
 * The app with a fake store that grants `grants` and records each ask,
 * with the context it was asked with. `failForBot` makes every check of the
 * account throw, as a store that's down does.
 */
function harness(
  grants: readonly string[],
  opts: { readonly authz?: boolean; readonly failForBot?: boolean } = {},
) {
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
    const allowed = [...ADA_GRANTS, ...grants].includes(k);
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
    get: async ({ serviceAccountId }: { serviceAccountId: string }) =>
      serviceAccountId === BOT
        ? { serviceAccountId, tenantId, name: 'acme-nightly-bot', grants: [], createdAt: '' }
        : null,
  } as unknown as ServiceAccountBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: createInMemoryTriggerRegistry({ defaultProjectId: PROJECT }),
    serviceAccountBinding,
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
  return { call, asked, botAsked };
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
  test('execute on a flow or an agent; publish on the agent an improvement pass works on', () => {
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
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A trigger in a later environment of an order: who may run its target
 * (`runAccess`), and whether the project runs a version of it at all.
 *
 * - One rule for running a trigger's target from its project, asked of the
 *   caller at register, on a change and at a take-over, and of the owner
 *   there and at every fire: an agent or flow more than one project serves,
 *   with the trigger's project among them, is that project's `call` or
 *   `execute`; an improve of one is `write` where its new versions are
 *   made; anything else is the item's own right, as before.
 * - An agent named with no version is asked about as any version its
 *   project runs (`anyVersion`), and reach is asked before the target's
 *   right, so a project that doesn't run it yet gets the 400 that names a
 *   promotion, not a bare 403.
 *
 * The order is `[Default, Live]`: `acme.desk` and `acme.nightly` are made
 * in Default and, once promoted, served by Live too; `acme.solo` is
 * Default's alone.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { ref } from '@kindgi/authz';
import type { ProjectId, TenantId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ItemReference,
  ReferenceScopeBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
} from '../src/index.js';
import { runAccess, servedQuestionsFrom, servedThere } from '../src/item-rights.js';
import type { ServedQuestions } from '../src/item-rights.js';
import { triggerTargetReference } from '../src/reference-scope.js';
import { environmentOrders } from './support/environment-orders.js';
import { type Grant, type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const DEFAULT = randomUUID() as ProjectId;
const LIVE = randomUUID() as ProjectId;
const AGENT = 'acme.desk';
const AGENT2 = 'acme.desk-two';
const FLOW = 'acme.nightly';
const SOLO = 'acme.solo';
/** A named service account, and the Live project's own account. */
const BOT = randomUUID();
const PA = randomUUID();

/** What each caller (by token, which is also its id) and account holds. */
function grants(): Record<string, Grant[]> {
  const live: Grant[] = [`call project:${LIVE}`, `execute project:${LIVE}`];
  return {
    'live-admin': [
      `read project:${LIVE}`,
      `write project:${LIVE}`,
      `admin project:${LIVE}`,
      ...live,
      `act_as service_account:${BOT}`,
      `execute agent:${SOLO}`,
    ],
    'live-editor': [`read project:${LIVE}`, `write project:${LIVE}`, ...live],
    'live-caller': [`call project:${LIVE}`],
    'both-admin': [
      `read project:${LIVE}`,
      `write project:${LIVE}`,
      `admin project:${LIVE}`,
      `write project:${DEFAULT}`,
      ...live,
    ],
    'default-admin': [
      `read project:${DEFAULT}`,
      `write project:${DEFAULT}`,
      `admin project:${DEFAULT}`,
      `execute agent:${SOLO}`,
      `act_as service_account:${BOT}`,
    ],
    pat: [`read project:${LIVE}`, `write project:${LIVE}`, ...live],
    [BOT]: [],
    [PA]: [`write project:${LIVE}`, ...live],
  };
}

const resolveToken: TokenResolver = async (token) =>
  token === 'none' ? null : { tenantId, userId: token as never, scopes: [] };

/**
 * The app over `[Default, Live]`. `promoted` puts Live among the projects
 * of `acme.desk`, `acme.desk-two` and `acme.nightly`; `reach` answers the
 * reference scope (absent: none, every reference is taken); `served:
 * false` leaves out the item-projects binding.
 */
function harness(
  opts: {
    readonly promoted?: boolean;
    readonly reach?: (projectId: ProjectId, ref: ItemReference) => boolean;
    readonly served?: false;
  } = {},
) {
  const carried = opts.promoted === false ? [DEFAULT] : [DEFAULT, LIVE];
  const rows: ItemRow[] = [
    { kind: 'agent', id: AGENT, projects: carried },
    { kind: 'agent', id: AGENT2, projects: carried },
    { kind: 'flow', id: FLOW, projects: carried },
    { kind: 'agent', id: SOLO, projects: [DEFAULT] },
  ];
  const held = grants();
  const authz = grantsAuthz(held);
  const reachAsked: ItemReference[] = [];
  const referenceScope: ReferenceScopeBinding | undefined =
    opts.reach === undefined
      ? undefined
      : {
          reachable: async ({ fromProjectId, ref: r }) => {
            reachAsked.push(r);
            return opts.reach?.(fromProjectId, r) ?? true;
          },
        };
  const account = (serviceAccountId: string) =>
    serviceAccountId === BOT
      ? { serviceAccountId, tenantId, name: 'acme-nightly-bot', grants: [], createdAt: '' }
      : serviceAccountId === PA
        ? {
            serviceAccountId,
            tenantId,
            name: `project-${LIVE}`,
            grants: [],
            createdAt: '',
            projectId: LIVE,
          }
        : null;
  const serviceAccountBinding = {
    get: async ({ serviceAccountId }: { serviceAccountId: string }) => account(serviceAccountId),
    projectAccounts: {
      get: async ({ projectId }: { projectId: string }) =>
        projectId === LIVE ? account(PA) : null,
      ensure: async ({ projectId }: { projectId: string }) =>
        projectId === LIVE
          ? { kind: 'ok', value: account(PA) }
          : { kind: 'err', error: { code: 'project-not-found', message: 'no such project' } },
    },
  } as unknown as ServiceAccountBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: createInMemoryTriggerRegistry({ defaultProjectId: DEFAULT }),
    serviceAccountBinding,
    authz: authz.authz,
    environmentOrders: environmentOrders([[DEFAULT, LIVE]]),
    ...(opts.served !== false && { itemProjects: itemProjects(rows) }),
    ...(referenceScope !== undefined && { referenceScope }),
  });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const before = authz.asked.length;
    const askedReach = reachAsked.length;
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        'x-request-id': 'req-run-access',
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
    return {
      status: res.status,
      text,
      body: json,
      asked: authz.asked.slice(before),
      reachAsked: reachAsked.slice(askedReach),
    };
  };
  return { call, held };
}

const agentSchedule = (over: Record<string, unknown> = {}) => ({
  agentId: AGENT,
  projectId: LIVE,
  config: { cronExpression: '0 2 * * *', input: { userMessage: 'Check the overnight orders.' } },
  ...over,
});
const flowSchedule = (over: Record<string, unknown> = {}) => ({
  flowId: FLOW,
  flowVersion: '1.0.0',
  projectId: LIVE,
  config: { cronExpression: '0 2 * * *' },
  ...over,
});
const improveSchedule = (agentId = AGENT) => ({
  improve: { agentId, scope: { kind: 'project', projectId: LIVE } },
  projectId: LIVE,
  config: { cronExpression: '0 2 * * *' },
});
const webhook = (over: Record<string, unknown> = {}) => ({
  flowId: FLOW,
  flowVersion: '1.0.0',
  hmacSecretName: 'acme-hmac',
  projectId: LIVE,
  ...over,
});
const companyMail = (over: Record<string, unknown> = {}) => ({
  agentId: AGENT,
  projectId: LIVE,
  config: { mailbox: { app: 'microsoft', as: 'company' } },
  ...over,
});

/** `ServedQuestions` over a fixed table of projects, recording what's asked. */
function questions(projects: Readonly<Record<string, readonly ProjectId[]>>) {
  const asked: string[] = [];
  const served: ServedQuestions = {
    servesIn: async (kind, id, projectId) => {
      asked.push(`servesIn ${kind}:${id} ${projectId}`);
      const all = projects[`${kind}:${id}`];
      return all === undefined
        ? undefined
        : { own: all[0] as ProjectId, serves: all.includes(projectId as ProjectId) };
    },
    servedElsewhere: async (kind, id) => {
      asked.push(`servedElsewhere ${kind}:${id}`);
      const all = projects[`${kind}:${id}`];
      return all === undefined
        ? undefined
        : { own: all[0] as ProjectId, elsewhere: all.length > 1 };
    },
    madeIn: async (own) => {
      asked.push(`madeIn ${own}`);
      return own;
    },
  };
  return { served, asked };
}

describe('runAccess: the one rule for running a trigger target from its project', () => {
  const both = { [`agent:${AGENT}`]: [DEFAULT, LIVE], [`flow:${FLOW}`]: [DEFAULT, LIVE] };
  const agent = { kind: 'agent', agentId: AGENT } as const;
  const flow = { kind: 'flow', flowId: FLOW } as const;
  const improve = { kind: 'improve', agentId: AGENT } as const;

  test('one project serves it: the item own right, as before', async () => {
    const { served } = questions({ [`agent:${AGENT}`]: [DEFAULT] });
    expect(await runAccess(served, agent, DEFAULT)).toEqual({
      action: 'execute',
      resource: ref('agent', AGENT),
      on: 'item',
    });
  });

  test("two serve it, the trigger's project among them: call or execute on that project", async () => {
    const { served } = questions(both);
    expect(await runAccess(served, agent, LIVE)).toEqual({
      action: 'call',
      resource: ref('project', LIVE),
      on: 'project',
    });
    expect(await runAccess(served, flow, DEFAULT)).toEqual({
      action: 'execute',
      resource: ref('project', DEFAULT),
      on: 'project',
    });
  });

  test("two serve it, the trigger's project not among them: the item own right", async () => {
    const { served } = questions(both);
    expect(await runAccess(served, agent, randomUUID())).toMatchObject({ on: 'item' });
  });

  test('an improve of an agent two projects serve: write where its new versions are made', async () => {
    const { served, asked } = questions(both);
    expect(await runAccess(served, improve, LIVE)).toEqual({
      action: 'write',
      resource: ref('project', DEFAULT),
      on: 'made-in',
    });
    expect(asked).toEqual([`servedElsewhere agent:${AGENT}`, `madeIn ${DEFAULT}`]);
  });

  test('an improve of an agent one project serves: publish on it, as before', async () => {
    const { served } = questions({ [`agent:${AGENT}`]: [DEFAULT] });
    expect(await runAccess(served, improve, DEFAULT)).toEqual({
      action: 'publish',
      resource: ref('agent', AGENT),
      on: 'item',
    });
  });

  test('no binding, or no project: the item own right', async () => {
    const { served, asked } = questions(both);
    expect(await runAccess(undefined, agent, LIVE)).toMatchObject({ on: 'item' });
    expect(await runAccess(served, agent, undefined)).toMatchObject({ on: 'item' });
    expect(asked).toEqual([]);
  });

  test('servedThere: a later project is enough; the first one needs another', async () => {
    const { served, asked } = questions(both);
    expect(await servedThere(served, { kind: 'agent', id: AGENT }, LIVE)).toBe(true);
    expect(asked).toEqual([`servesIn agent:${AGENT} ${LIVE}`]);
    expect(await servedThere(served, { kind: 'agent', id: AGENT }, DEFAULT)).toBe(true);
    const alone = questions({ [`agent:${AGENT}`]: [DEFAULT] });
    expect(await servedThere(alone.served, { kind: 'agent', id: AGENT }, DEFAULT)).toBe(false);
  });

  test('from the binding alone: only the narrow questions, and new versions where the order starts', async () => {
    const items = itemProjects([{ kind: 'agent', id: AGENT, projects: [LIVE, DEFAULT] }]);
    const served = servedQuestionsFrom(items, tenantId, environmentOrders([[DEFAULT, LIVE]]));
    expect(await runAccess(served, improve, LIVE)).toEqual({
      action: 'write',
      resource: ref('project', DEFAULT),
      on: 'made-in',
    });
    expect(await runAccess(served, agent, DEFAULT)).toMatchObject({ on: 'project' });
    expect(items.asked.some((a) => a.startsWith('projectsOf'))).toBe(false);
  });
});

describe('triggerTargetReference: an agent with no version is any version its project runs', () => {
  test('each target', () => {
    expect(triggerTargetReference({ kind: 'agent', agentId: AGENT } as never)).toEqual({
      kind: 'agent',
      id: AGENT,
      anyVersion: true,
    });
    expect(
      triggerTargetReference({ kind: 'agent', agentId: AGENT, agentVersion: '1.2.0' } as never),
    ).toEqual({ kind: 'agent', id: AGENT, version: '1.2.0' });
    expect(
      triggerTargetReference({ kind: 'flow', flowId: FLOW, flowVersion: '1.0.0' } as never),
    ).toEqual({ kind: 'flow', id: FLOW, version: '1.0.0' });
    expect(
      triggerTargetReference({
        kind: 'improve',
        agentId: AGENT,
        scope: { kind: 'project', projectId: LIVE },
      } as never),
    ).toEqual({ kind: 'agent', id: AGENT });
  });
});

describe('register in the later project, once a build is promoted there', () => {
  test("an editor there: 201, asked write and the project's run right", async () => {
    const h = harness({ reach: () => true });
    const agent = await h.call('live-editor', 'POST', '/v1/schedules', agentSchedule());
    expect(agent.status, agent.text).toBe(201);
    expect(agent.asked).toEqual([
      `live-editor write project:${LIVE}`,
      `live-editor call project:${LIVE}`,
    ]);
    expect(agent.reachAsked).toEqual([{ kind: 'agent', id: AGENT, anyVersion: true }]);
    const flow = await h.call('live-editor', 'POST', '/v1/schedules', flowSchedule());
    expect(flow.status, flow.text).toBe(201);
    expect(flow.asked).toContain(`live-editor execute project:${LIVE}`);
    const hook = await h.call('live-editor', 'POST', '/v1/webhooks', webhook());
    expect(hook.status, hook.text).toBe(201);
    expect(hook.asked).toContain(`live-editor execute project:${LIVE}`);
  });

  test("a mail trigger on the company's mailbox, by an admin there: 201", async () => {
    const h = harness({ reach: () => true });
    const res = await h.call('live-admin', 'POST', '/v1/mail-triggers', companyMail());
    expect(res.status, res.text).toBe(201);
    expect(res.asked).toContain(`live-admin call project:${LIVE}`);
  });

  test("naming an account with the run role there only: 201, its check the project's", async () => {
    const h = harness({ reach: () => true });
    h.held[BOT] = [`call project:${LIVE}`, `execute project:${LIVE}`];
    for (const [path, body] of [
      ['/v1/schedules', agentSchedule({ runAsServiceAccountId: BOT })],
      ['/v1/schedules', flowSchedule({ runAsServiceAccountId: BOT })],
      ['/v1/mail-triggers', companyMail({ runAsServiceAccountId: BOT })],
    ] as const) {
      const res = await h.call('live-admin', 'POST', path, body);
      expect(res.status, res.text).toBe(201);
      expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
      expect(res.asked.filter((a) => a.startsWith(BOT))).toEqual([
        body === undefined || !('flowId' in body)
          ? `${BOT} call project:${LIVE}`
          : `${BOT} execute project:${LIVE}`,
      ]);
    }
  });

  test("the project's own account: 201", async () => {
    const h = harness({ reach: () => true });
    const res = await h.call(
      'live-admin',
      'POST',
      '/v1/schedules',
      agentSchedule({ runAsProject: true }),
    );
    expect(res.status, res.text).toBe(201);
    expect(res.body.owner).toMatchObject({ kind: 'service', id: PA });
  });

  test('a person with the run role only, not write: the 403 at write, and reach is never asked', async () => {
    const h = harness({ reach: () => true });
    const res = await h.call('live-caller', 'POST', '/v1/schedules', agentSchedule());
    expect(res.status, res.text).toBe(403);
    expect(res.asked).toEqual([`live-caller write project:${LIVE}`]);
    expect(res.reachAsked).toEqual([]);
  });
});

describe("reach comes before the target's right", () => {
  const unpromotedLive = (projectId: ProjectId, r: ItemReference) =>
    projectId !== LIVE || r.id !== SOLO;

  test('before the first promotion, an editor of the later project gets the 400 that names a promotion', async () => {
    const h = harness({ promoted: false, reach: (p) => p !== LIVE });
    const res = await h.call('live-editor', 'POST', '/v1/schedules', agentSchedule());
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('reference-out-of-scope');
    expect(res.body.error.details.issues).toEqual([
      expect.objectContaining({ path: '/target', kind: 'agent', id: AGENT }),
    ]);
    expect(res.body.error.message).toBe(
      `This project can't reference agent "${AGENT}": it has no version that runs here (none was made in this project, and no build in place here ships one). If it's made in an earlier environment of this project's order, promote a build that ships it here; else make the trigger in the project that makes it`,
    );
    // Only write was asked of the caller: the target's right comes after.
    expect(res.asked).toEqual([`live-editor write project:${LIVE}`]);
    const mail = await h.call('live-admin', 'POST', '/v1/mail-triggers', companyMail());
    expect(mail.status, mail.text).toBe(400);
  });

  test('a change to a target the project does not run: the 400, not the 403', async () => {
    const h = harness({ reach: unpromotedLive });
    const made = await h.call('live-editor', 'POST', '/v1/schedules', agentSchedule());
    expect(made.status, made.text).toBe(201);
    const id = made.body.triggerId as string;
    const res = await h.call('live-editor', 'PATCH', `/v1/schedules/${id}`, { agentId: SOLO });
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('reference-out-of-scope');
    expect(res.asked).not.toContain(`live-editor execute agent:${SOLO}`);
  });

  test("a mail trigger's change to an agent the project does not run: the 400, not the 403", async () => {
    const h = harness({ reach: unpromotedLive });
    const made = await h.call('live-admin', 'POST', '/v1/mail-triggers', companyMail());
    expect(made.status, made.text).toBe(201);
    const id = made.body.triggerId as string;
    h.held['live-admin'] = (h.held['live-admin'] ?? []).filter(
      (g) => g !== `execute agent:${SOLO}`,
    );
    const res = await h.call('live-admin', 'PATCH', `/v1/mail-triggers/${id}`, { agentId: SOLO });
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('reference-out-of-scope');
    expect(res.reachAsked).toEqual([{ kind: 'agent', id: SOLO, anyVersion: true }]);
    expect(res.asked).not.toContain(`live-admin execute agent:${SOLO}`);
  });

  test('a webhook on a flow not yet promoted here: the 400, not the 403', async () => {
    const h = harness({ promoted: false, reach: (p) => p !== LIVE });
    const res = await h.call('live-editor', 'POST', '/v1/webhooks', webhook());
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('reference-out-of-scope');
    expect(res.body.error.details.issues).toEqual([
      expect.objectContaining({ path: '/flowId', kind: 'flow', id: FLOW }),
    ]);
    expect(res.asked).not.toContain(`live-editor execute flow:${FLOW}`);
    // Without a reference scope, the flow's own right refuses it.
    const unscoped = await harness({ promoted: false }).call(
      'live-editor',
      'POST',
      '/v1/webhooks',
      webhook(),
    );
    expect(unscoped.status, unscoped.text).toBe(403);
  });

  test("a webhook's change to a flow version not promoted here: the 400, and the run right is never asked", async () => {
    const h = harness({
      reach: (p, r) => p !== LIVE || r.kind !== 'flow' || r.version !== '2.0.0',
    });
    const made = await h.call('live-editor', 'POST', '/v1/webhooks', webhook());
    expect(made.status, made.text).toBe(201);
    const id = made.body.triggerId as string;
    const res = await h.call('live-editor', 'PATCH', `/v1/webhooks/${id}`, {
      flowVersion: '2.0.0',
    });
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('reference-out-of-scope');
    expect(res.reachAsked).toEqual([{ kind: 'flow', id: FLOW, version: '2.0.0' }]);
    expect(res.asked).not.toContain(`live-editor execute project:${LIVE}`);
  });

  test('a caller without write on the project: its 403, and reach is never asked', async () => {
    const h = harness({ promoted: false, reach: () => false });
    const res = await h.call('default-admin', 'POST', '/v1/schedules', agentSchedule());
    expect(res.status, res.text).toBe(403);
    expect(res.reachAsked).toEqual([]);
  });

  test('one body for an agent that does not exist and one no version of which runs here', async () => {
    const h = harness({ promoted: false, reach: (p) => p !== LIVE });
    const ghost = await h.call(
      'live-editor',
      'POST',
      '/v1/schedules',
      agentSchedule({ agentId: 'acme.ghost' }),
    );
    const desk = await h.call('live-editor', 'POST', '/v1/schedules', agentSchedule());
    expect([ghost.status, desk.status]).toEqual([400, 400]);
    expect(JSON.stringify(ghost.body.error).replaceAll('acme.ghost', AGENT)).toBe(
      JSON.stringify(desk.body.error),
    );
  });
});

describe("the caller's target check, where it still refuses", () => {
  test('no reference scope, the agent served by Default only: the item own 403, as before', async () => {
    const h = harness({ promoted: false });
    const res = await h.call('live-editor', 'POST', '/v1/schedules', agentSchedule());
    expect(res.status, res.text).toBe(403);
    expect(res.asked).toEqual([
      `live-editor write project:${LIVE}`,
      `live-editor execute agent:${AGENT}`,
    ]);
  });

  test("the same host once Live serves it: 201, on Live's right", async () => {
    const h = harness();
    const res = await h.call('live-editor', 'POST', '/v1/schedules', agentSchedule());
    expect(res.status, res.text).toBe(201);
  });

  test('an improve of an agent made in Default: write there, with its words', async () => {
    const h = harness({ reach: () => true });
    const res = await h.call('live-editor', 'POST', '/v1/schedules', improveSchedule());
    expect(res.status, res.text).toBe(403);
    expect(res.body.error.message).toContain(
      `improving agent "${AGENT}" needs write on project ${DEFAULT}, where agent "${AGENT}" gets its new versions`,
    );
  });
});

describe("the owner is checked by the trigger's project", () => {
  test('an account whose only right is a grant on the agent itself: a 409 once two projects serve it, naming the role here', async () => {
    const h = harness({ reach: () => true });
    h.held[BOT] = [`execute agent:${AGENT}`, `execute flow:${FLOW}`];
    const agent = await h.call(
      'live-admin',
      'POST',
      '/v1/schedules',
      agentSchedule({ runAsServiceAccountId: BOT }),
    );
    expect(agent.status, agent.text).toBe(409);
    expect(agent.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: `Service account "acme-nightly-bot" can't run agent "${AGENT}" in this project, so the trigger can't run as it. Give the account the caller role on this project, or name another account.`,
    });
    const flow = await h.call(
      'live-admin',
      'POST',
      '/v1/schedules',
      flowSchedule({ runAsServiceAccountId: BOT }),
    );
    expect(flow.status, flow.text).toBe(409);
    expect(flow.body.error.message).toBe(
      `Service account "acme-nightly-bot" can't run flow "${FLOW}" in this project, so the trigger can't run as it. Give the account the executor role on this project, or name another account.`,
    );
  });

  test('the same grant on an agent one project serves: 201, as before', async () => {
    const h = harness({ reach: () => true });
    h.held[BOT] = [`execute agent:${SOLO}`];
    const res = await h.call(
      'default-admin',
      'POST',
      '/v1/schedules',
      agentSchedule({ agentId: SOLO, projectId: DEFAULT, runAsServiceAccountId: BOT }),
    );
    expect(res.status, res.text).toBe(201);
    expect(res.asked).toContain(`${BOT} execute agent:${SOLO}`);
  });
});

describe("a retarget asks the owner by the trigger's project", () => {
  test("a person who lost the Live role: the 409 says they can't run it in this project", async () => {
    const h = harness({ reach: () => true });
    const made = await h.call('pat', 'POST', '/v1/schedules', agentSchedule());
    expect(made.status, made.text).toBe(201);
    h.held.pat = [];
    const id = made.body.triggerId as string;
    const res = await h.call('live-admin', 'PATCH', `/v1/schedules/${id}`, { agentId: AGENT2 });
    expect(res.status, res.text).toBe(409);
    expect(res.asked).toContain(`pat call project:${LIVE}`);
    expect(res.body.error.message).toBe(
      `pat can't run agent "${AGENT2}" in this project, so the trigger can't run it as them. A project admin can take the trigger over first.`,
    );
  });

  test('an account that lost it: the fix names the caller role on this project', async () => {
    const h = harness({ reach: () => true });
    h.held[BOT] = [`call project:${LIVE}`];
    const made = await h.call(
      'live-admin',
      'POST',
      '/v1/schedules',
      agentSchedule({ runAsServiceAccountId: BOT }),
    );
    expect(made.status, made.text).toBe(201);
    h.held[BOT] = [];
    const id = made.body.triggerId as string;
    const res = await h.call('live-admin', 'PATCH', `/v1/schedules/${id}`, { agentId: AGENT2 });
    expect(res.status, res.text).toBe(409);
    expect(res.body.error.message).toBe(
      `Service account "acme-nightly-bot" can't run agent "${AGENT2}" in this project, so the trigger can't run it as that account. A tenant admin can give the account the caller role on this project, or a project admin can take the trigger over first.`,
    );
  });

  test("to an agent one project serves: the item own right, with today's words", async () => {
    const h = harness({ reach: () => true });
    h.held[BOT] = [`call project:${LIVE}`];
    const made = await h.call(
      'live-admin',
      'POST',
      '/v1/schedules',
      agentSchedule({ runAsServiceAccountId: BOT }),
    );
    const id = made.body.triggerId as string;
    const res = await h.call('live-admin', 'PATCH', `/v1/schedules/${id}`, { agentId: SOLO });
    expect(res.status, res.text).toBe(409);
    expect(res.asked).toContain(`${BOT} execute agent:${SOLO}`);
    expect(res.body.error.message).toBe(
      `Service account "acme-nightly-bot" can't run agent "${SOLO}", so the trigger can't run it as that account. A tenant admin can give the account the editor role on the target's project, or a project admin can take the trigger over first.`,
    );
  });
});

describe("the project's own account: its words are a guard", () => {
  const PROJECT_WORDS = "The project's own account runs only what the project's editors can";

  test('a target the project does not serve: reach refuses first, and without a scope its words', async () => {
    const scoped = harness({ reach: (p, r) => p !== LIVE || r.id !== SOLO });
    const refused = await scoped.call(
      'live-admin',
      'POST',
      '/v1/schedules',
      agentSchedule({ agentId: SOLO, runAsProject: true }),
    );
    expect(refused.status, refused.text).toBe(400);
    const open = harness();
    const words = await open.call(
      'live-admin',
      'POST',
      '/v1/schedules',
      agentSchedule({ agentId: SOLO, runAsProject: true }),
    );
    expect(words.status, words.text).toBe(409);
    expect(words.body.error.message).toContain(PROJECT_WORDS);
  });

  test('an improve whose new versions are made in another project: its words', async () => {
    const h = harness({ reach: () => true });
    const res = await h.call('both-admin', 'POST', '/v1/schedules', {
      ...improveSchedule(),
      runAsProject: true,
    });
    expect(res.status, res.text).toBe(409);
    expect(res.asked).toContain(`${PA} write project:${DEFAULT}`);
    expect(res.body.error.message).toContain(PROJECT_WORDS);
  });
});

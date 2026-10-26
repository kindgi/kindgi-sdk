// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A shared trigger can run as its project (`runAsProject: true`): its runs
 * act as the project's own service account, made the first time a trigger
 * runs as the project, with `editor` on it. Naming the project takes a
 * project admin (without an authorization store, a tenant-admin key), and
 * no `act_as`. The account has no keys, its grant is fixed, and it isn't
 * named by id; a tenant admin may unregister it, and deleting the project
 * unregisters it. Such a trigger is shared under the owner rule.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import { makeInMemoryProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  FlowRegistryBinding,
  RunHandlerBinding,
  ServiceAccount,
  ServiceAccountBinding,
  TokenAdmin,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID() as ProjectId;
const ADA = randomUUID() as UserId;
const GRACE = randomUUID() as UserId;
const ROOT = randomUUID() as UserId;
const BOT = 'sa-nightly';

type Role = 'write' | 'admin';
const RANK: Record<Role, number> = { write: 2, admin: 3 };

/** Ada writes the project; Grace administers it; Root is a tenant admin. */
const ROLES = new Map<string, Role>([
  [ADA, 'write'],
  [GRACE, 'admin'],
  [ROOT, 'admin'],
]);

/**
 * A flow another project serves to this one: the people here hold
 * `execute` on it, the project's own account doesn't.
 */
const SERVED = 'acme.refunds';

function decide(principal: unknown, action: Action, resource: ResourceRef): Decision {
  const { id: actor, kind } = (principal as { actor?: { id?: string; kind?: string } }).actor ?? {};
  // A service account here is the project's own: `editor` on the project, a writer's rank.
  const account = kind === 'service_account';
  const role =
    actor === undefined ? undefined : (ROLES.get(actor) ?? (account ? 'write' : undefined));
  // Only Root administers the tenant; Grace administers the project.
  const needs = action === 'read' ? 1 : action === 'admin' || action === 'act_as' ? 3 : 2;
  const allowed =
    role !== undefined &&
    RANK[role] >= needs &&
    (resource.type !== 'tenant' || action === 'read' || actor === ROOT) &&
    !(account && resource.type === 'flow' && resource.id === SERVED);
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
  ada: { tenantId, userId: ADA, scopes: [] },
  grace: { tenantId, userId: GRACE, scopes: [] },
  root: { tenantId, userId: ROOT, scopes: ['tenant-admin'] },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;

const flowRegistry = {
  get: async ({ flowId }: { flowId: string }) =>
    flowId === 'acme.orders' || flowId === 'acme.refunds' ? { id: flowId, nodes: [] } : null,
  getVersion: async ({ flowId, version }: { flowId: string; version: string }) =>
    (flowId === 'acme.orders' || flowId === 'acme.refunds') && version === '1.0.0'
      ? { id: flowId, version, nodes: [] }
      : null,
} as unknown as FlowRegistryBinding;

/**
 * Service accounts in memory, with a project's own account: one active per
 * project, `project-<id>`, `editor` on it, and its grant fixed.
 */
function accountsStore(opts: { projectAccounts?: boolean } = {}) {
  const accounts = new Map<string, ServiceAccount>([
    [
      BOT,
      {
        serviceAccountId: BOT,
        tenantId,
        name: 'acme-nightly-bot',
        grants: [],
        createdAt: '2026-01-01T00:00:00.000Z' as never,
      },
    ],
  ]);
  let ensured = 0;
  const activeFor = (projectId: string) =>
    [...accounts.values()].find((a) => a.projectId === projectId && a.unregisteredAt === undefined);
  const owned = (id: string) =>
    accounts.get(id)?.projectId !== undefined
      ? {
          kind: 'err' as const,
          error: {
            code: 'service-account-project-owned' as const,
            message: "A project's own account's grant is fixed.",
          },
        }
      : undefined;
  const binding: ServiceAccountBinding = {
    create: async () => {
      throw new Error('not in this test');
    },
    get: async ({ serviceAccountId }) => accounts.get(serviceAccountId) ?? null,
    list: async () => ({ data: [...accounts.values()] }),
    grant: async ({ serviceAccountId }) =>
      owned(serviceAccountId) ?? {
        kind: 'ok',
        value: accounts.get(serviceAccountId) as ServiceAccount,
      },
    ungrant: async ({ serviceAccountId }) =>
      owned(serviceAccountId) ?? {
        kind: 'ok',
        value: accounts.get(serviceAccountId) as ServiceAccount,
      },
    unregister: async ({ serviceAccountId }) => {
      const a = accounts.get(serviceAccountId) as ServiceAccount;
      const gone = { ...a, grants: [], unregisteredAt: '2026-02-02T00:00:00.000Z' as never };
      accounts.set(serviceAccountId, gone);
      return { kind: 'ok', value: gone };
    },
    ...(opts.projectAccounts !== false && {
      projectAccounts: {
        get: async ({ projectId }) => activeFor(projectId) ?? null,
        ensure: async ({ projectId, by }) => {
          ensured += 1;
          const held = activeFor(projectId);
          if (held !== undefined) return { kind: 'ok', value: held };
          const made: ServiceAccount = {
            serviceAccountId: randomUUID(),
            tenantId,
            name: `project-${projectId}`,
            grants: [{ kind: 'project', projectId, role: 'editor' }],
            ...(by !== undefined && { createdBy: by }),
            createdAt: '2026-01-01T00:00:00.000Z' as never,
            projectId,
          };
          accounts.set(made.serviceAccountId, made);
          return { kind: 'ok', value: made };
        },
      },
    }),
  };
  return {
    binding,
    accounts,
    activeFor,
    ensured: () => ensured,
    projectAccountsMade: () => [...accounts.values()].filter((a) => a.projectId !== undefined),
  };
}

/** A key store whose every mint is refused as a project's own account's. */
const noKeysForProjectAccounts = {
  mint: async () => ({
    kind: 'service-account-project-owned' as const,
    message: "A project's own account has no keys: give an app a service account of its own.",
  }),
  list: async () => [],
  get: async () => undefined,
} as unknown as TokenAdmin;

function harness(
  opts: {
    authz?: boolean;
    projectAccounts?: boolean;
    accounts?: ReturnType<typeof accountsStore>;
  } = {},
) {
  const accounts = opts.accounts ?? accountsStore(opts);
  const written: AuditEvent[] = [];
  const store = createInMemoryAuditEventBinding();
  const auditEvents: typeof store = {
    ...store,
    append: async (events, ...rest) => {
      written.push(...events);
      return store.append(events, ...rest);
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: createInMemoryTriggerRegistry({ defaultProjectId: PROJECT }),
    flowRegistry,
    serviceAccountBinding: accounts.binding,
    tokenAdmin: noKeysForProjectAccounts,
    auditEvents,
    ...(opts.authz !== false && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (p, action, resource) => decide(p, action, resource),
          checkBatch: async (p, action, resources) =>
            resources.map((resource) => decide(p, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (method: string, path: string, body?: unknown, token = 'grace') => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': 'req-run-as-project',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const ownerSets = () =>
    written
      .filter((e) => e.kind === 'trigger-owner-set')
      .map((e) => (e.payload as { doc?: Record<string, unknown> }).doc);
  return { call, accounts, ownerSets };
}
type Harness = ReturnType<typeof harness>;

const KINDS = {
  schedule: {
    path: '/v1/schedules',
    idOf: (b: Record<string, any>) => b.scheduleId as string,
    make: (over: Record<string, unknown> = {}) => ({
      flowId: 'acme.orders',
      flowVersion: '1.0.0',
      projectId: PROJECT,
      label: 'nightly',
      config: { cronExpression: '0 2 * * *' },
      ...over,
    }),
  },
  webhook: {
    path: '/v1/webhooks',
    idOf: (b: Record<string, any>) => b.triggerId as string,
    make: (over: Record<string, unknown> = {}) => ({
      flowId: 'acme.orders',
      flowVersion: '1.0.0',
      projectId: PROJECT,
      label: 'refunds',
      hmacSecretName: 'acme-hmac',
      ...over,
    }),
  },
} as const;
type Kind = keyof typeof KINDS;
const BOTH: Kind[] = ['schedule', 'webhook'];

const register = (h: Harness, kind: Kind, over: Record<string, unknown>, token = 'grace') =>
  h.call('POST', KINDS[kind].path, KINDS[kind].make(over), token);

/** A trigger run as the project, by Grace: its id and owner. */
async function runAsProject(h: Harness, kind: Kind) {
  const res = await register(h, kind, { runAsProject: true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: KINDS[kind].idOf(res.body), owner: res.body.owner as Record<string, unknown> };
}

describe.each(BOTH)('a %s run as its project', (kind) => {
  test("a project admin's: the owner is the project's own account, and a second reuses it", async () => {
    const h = harness();
    const first = await runAsProject(h, kind);
    const made = h.accounts.projectAccountsMade();
    expect(made).toHaveLength(1);
    expect(first.owner).toEqual({
      kind: 'service',
      id: made[0]?.serviceAccountId,
      displayName: `project-${PROJECT}`,
      isProjectAccount: true,
    });
    expect(made[0]).toMatchObject({
      grants: [{ kind: 'project', projectId: PROJECT, role: 'editor' }],
      createdBy: `user:${GRACE}`,
    });
    const second = await runAsProject(h, kind);
    expect(second.owner.id).toBe(first.owner.id);
    expect(h.accounts.projectAccountsMade()).toHaveLength(1);
    // Audited as the owner it sets, saying it's the project's own.
    expect(h.ownerSets()[0]).toMatchObject({
      to: `service:${first.owner.id}`,
      projectAccount: true,
      by: `user:${GRACE}`,
    });
  });

  test("a target its account can't run: the 409, nothing registered, and the account it made is the next one's", async () => {
    const h = harness();
    const res = await register(h, kind, { runAsProject: true, flowId: SERVED });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: `The trigger can't run flow "${SERVED}" as the project. The project's own account runs only what the project's editors can: run the trigger as a service account that can, or own it yourself.`,
    });
    expect((await h.call('GET', KINDS[kind].path)).body.data).toEqual([]);
    // Made before the check, it stays, with no keys, and the next `runAsProject` reuses it.
    const made = h.accounts.projectAccountsMade();
    expect(made).toHaveLength(1);
    const next = await runAsProject(h, kind);
    expect(next.owner.id).toBe(made[0]?.serviceAccountId);
    expect(h.accounts.projectAccountsMade()).toHaveLength(1);
  });

  test("a take-over to the project's account when it can't run the target: the 409, and the owner stays", async () => {
    const h = harness();
    const made = await register(h, kind, { flowId: SERVED }, 'ada');
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = KINDS[kind].idOf(made.body);
    const res = await h.call('POST', `${KINDS[kind].path}/${id}/owner`, { runAsProject: true });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('trigger-owner-cannot-run-target');
    const read = await h.call('GET', `${KINDS[kind].path}/${id}`);
    expect(read.body.owner).toMatchObject({ kind: 'user', id: ADA });
  });

  test("a writer who isn't an admin gets the 403, and no account is made", async () => {
    const h = harness();
    const res = await register(h, kind, { runAsProject: true }, 'ada');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Running a trigger as the project takes a project admin.');
    expect(h.accounts.ensured()).toBe(0);
  });

  test('both fields together are a 400, and nothing is made', async () => {
    const h = harness();
    const res = await register(h, kind, { runAsProject: true, runAsServiceAccountId: BOT });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Name one: `runAsProject` or `runAsServiceAccountId`.');
    expect(h.accounts.ensured()).toBe(0);
  });

  test("`runAsProject` that isn't a boolean is a 400", async () => {
    const h = harness();
    const res = await register(h, kind, { runAsProject: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('`runAsProject` must be a boolean');
  });

  test("without an authorization store: a tenant-admin key may, a member's key gets the 403", async () => {
    const h = harness({ authz: false });
    expect((await register(h, kind, { runAsProject: true }, 'root')).status).toBe(201);
    const member = await register(h, kind, { runAsProject: true }, 'ada');
    expect(member.status).toBe(403);
    expect(h.accounts.ensured()).toBe(1);
  });

  test("a runtime that can't make the account answers 501", async () => {
    const h = harness({ projectAccounts: false });
    const res = await register(h, kind, { runAsProject: true });
    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({
      code: 'trigger-operation-unsupported',
      message: "This runtime can't make a project's own account.",
    });
  });

  test('named by id, it is refused: a tenant admin gets the 409, a non-reader the one 403', async () => {
    const h = harness();
    const { owner } = await runAsProject(h, kind);
    const byAdmin = await register(h, kind, { runAsServiceAccountId: owner.id }, 'root');
    expect(byAdmin.status).toBe(409);
    expect(byAdmin.body.error.code).toBe('service-account-project-owned');
    const byWriter = await register(h, kind, { runAsServiceAccountId: owner.id }, 'ada');
    expect(byWriter.status).toBe(403);
    expect(byWriter.body.error.message).toBe(
      "You can't name that service account as the trigger's owner.",
    );
  });

  test("a take-over with `runAsProject` moves a personal trigger to the project's account", async () => {
    const h = harness();
    const made = await register(h, kind, {}, 'ada');
    expect(made.status).toBe(201);
    const id = KINDS[kind].idOf(made.body);
    const res = await h.call('POST', `${KINDS[kind].path}/${id}/owner`, { runAsProject: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const account = h.accounts.activeFor(PROJECT);
    expect(res.body.owner).toMatchObject({
      kind: 'service',
      id: account?.serviceAccountId,
      isProjectAccount: true,
    });
    expect(h.ownerSets().at(-1)).toMatchObject({
      from: `user:${ADA}`,
      to: `service:${account?.serviceAccountId}`,
      projectAccount: true,
    });
  });

  test('a take-over naming both is a 400, and the owner stays', async () => {
    const h = harness();
    const made = await register(h, kind, {}, 'ada');
    const id = KINDS[kind].idOf(made.body);
    const res = await h.call('POST', `${KINDS[kind].path}/${id}/owner`, {
      runAsProject: true,
      runAsServiceAccountId: BOT,
    });
    expect(res.status).toBe(400);
    const read = await h.call('GET', `${KINDS[kind].path}/${id}`);
    expect(read.body.owner).toMatchObject({ kind: 'user', id: ADA });
  });

  test("it's shared: a writer may pause it and change its label, and changing its input takes an admin", async () => {
    const h = harness();
    const { id } = await runAsProject(h, kind);
    const path = `${KINDS[kind].path}/${id}`;
    expect((await h.call('PATCH', path, { label: 'renamed' }, 'ada')).status).toBe(200);
    expect((await h.call('POST', `${path}/pause`, undefined, 'ada')).status).toBe(200);
    const input = { config: { input: { region: 'us' } } };
    expect((await h.call('PATCH', path, input, 'ada')).status).toBe(403);
    expect((await h.call('PATCH', path, input)).status).toBe(200);
  });
});

const MAIL = '/v1/mail-triggers';

/** A trigger on the company's Outlook mailbox, or (`person`) the caller's own. */
const mail = (as: 'company' | 'person', over: Record<string, unknown> = {}) => ({
  flowId: 'acme.orders',
  flowVersion: '1.0.0',
  projectId: PROJECT,
  label: 'inbox',
  config: { mailbox: { app: 'microsoft', as } },
  ...over,
});

describe("a schedule run as its project, moved to a target its account can't run", () => {
  test('the 409 says a take-over is the fix, and the schedule keeps its target', async () => {
    const h = harness();
    const { id } = await runAsProject(h, 'schedule');
    const res = await h.call('PATCH', `/v1/schedules/${id}`, {
      flowId: SERVED,
      flowVersion: '1.0.0',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'trigger-owner-cannot-run-target',
      message: `The trigger can't run flow "${SERVED}" as the project. The project's own account runs only what the project's editors can: a project admin can take the trigger over first, to own it or to run it as a service account that can.`,
    });
    const read = await h.call('GET', `/v1/schedules/${id}`);
    expect(JSON.stringify(read.body)).not.toContain(SERVED);
  });
});

describe('a mail trigger run as its project', () => {
  test("on the company's mailbox, a project admin's: the project's own account owns it, and a second reuses it", async () => {
    const h = harness();
    const first = await h.call('POST', MAIL, mail('company', { runAsProject: true }));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const made = h.accounts.projectAccountsMade();
    expect(made).toHaveLength(1);
    expect(first.body.owner).toEqual({
      kind: 'service',
      id: made[0]?.serviceAccountId,
      displayName: `project-${PROJECT}`,
      isProjectAccount: true,
    });
    const second = await h.call('POST', MAIL, mail('company', { runAsProject: true }));
    expect(second.body.owner.id).toBe(first.body.owner.id);
    expect(h.accounts.projectAccountsMade()).toHaveLength(1);
    expect(h.ownerSets()[0]).toMatchObject({
      to: `service:${first.body.owner.id}`,
      projectAccount: true,
      by: `user:${GRACE}`,
    });
  });

  test("on a person's mailbox it's a 400, at register and at a take-over, and nothing is made", async () => {
    const h = harness();
    const named = await h.call('POST', MAIL, mail('person', { runAsProject: true }));
    expect(named.status).toBe(400);
    expect(named.body.error.message).toMatch(/a person owns it/);
    const adas = await h.call('POST', MAIL, mail('person'), 'ada');
    expect(adas.status, JSON.stringify(adas.body)).toBe(201);
    const id = adas.body.triggerId as string;
    const takeOver = await h.call('POST', `${MAIL}/${id}/owner`, { runAsProject: true });
    expect(takeOver.status).toBe(400);
    expect(takeOver.body.error.message).toMatch(/a person owns it/);
    expect((await h.call('GET', `${MAIL}/${id}`)).body.owner).toMatchObject({
      kind: 'user',
      id: ADA,
    });
    expect(h.accounts.ensured()).toBe(0);
  });

  test("a take-over with `runAsProject` moves a company-mailbox trigger to the project's account", async () => {
    const h = harness();
    const mine = await h.call('POST', MAIL, mail('company'));
    expect(mine.body.owner).toMatchObject({ kind: 'user', id: GRACE });
    const id = mine.body.triggerId as string;
    const res = await h.call('POST', `${MAIL}/${id}/owner`, { runAsProject: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const account = h.accounts.activeFor(PROJECT);
    expect(res.body.owner).toMatchObject({
      kind: 'service',
      id: account?.serviceAccountId,
      isProjectAccount: true,
    });
    expect(h.ownerSets().at(-1)).toMatchObject({
      from: `user:${GRACE}`,
      to: `service:${account?.serviceAccountId}`,
      projectAccount: true,
    });
  });

  test("the owner moves only by a take-over, and a person's mailbox stays a person's", async () => {
    const h = harness();
    const made = await h.call('POST', MAIL, mail('company', { runAsProject: true }));
    const path = `${MAIL}/${made.body.triggerId as string}`;
    const named = await h.call('PATCH', path, { runAsProject: true });
    expect(named.status).toBe(400);
    expect(named.body.error.message).toMatch(/only by a take-over/);
    const toPerson = await h.call('PATCH', path, {
      config: { mailbox: { app: 'google', as: 'person' } },
    });
    expect(toPerson.status).toBe(400);
    expect(toPerson.body.error.message).toMatch(/a person owns it/);
  });

  test("without an authorization store, a tenant-admin key may; a runtime that can't make the account answers 501", async () => {
    const open = harness({ authz: false });
    const root = await open.call('POST', MAIL, mail('company', { runAsProject: true }), 'root');
    expect(root.status, JSON.stringify(root.body)).toBe(201);
    expect(root.body.owner).toMatchObject({ isProjectAccount: true });
    const none = harness({ projectAccounts: false });
    const res = await none.call('POST', MAIL, mail('company', { runAsProject: true }));
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('trigger-operation-unsupported');
  });
});

describe('a schedule with no project', () => {
  test('`runAsProject` is a 400', async () => {
    const h = harness();
    const res = await h.call(
      'POST',
      '/v1/schedules',
      {
        flowId: 'acme.orders',
        flowVersion: '1.0.0',
        config: { cronExpression: '0 2 * * *' },
        runAsProject: true,
      },
      'root',
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("`runAsProject` needs the trigger's project.");
  });
});

describe("the project's own account itself", () => {
  test('it shows its project, and a grant or ungrant on it is a 409', async () => {
    const h = harness();
    const { owner } = await runAsProject(h, 'schedule');
    const read = await h.call('GET', `/v1/service-accounts/${owner.id}`, undefined, 'root');
    expect(read.body.projectId).toBe(PROJECT);
    const grant = await h.call(
      'POST',
      `/v1/service-accounts/${owner.id}/grant`,
      { kind: 'tenant-member' },
      'root',
    );
    expect([grant.status, grant.body.error?.code]).toEqual([409, 'service-account-project-owned']);
    const ungrant = await h.call(
      'POST',
      `/v1/service-accounts/${owner.id}/ungrant`,
      { kind: 'project', projectId: PROJECT },
      'root',
    );
    expect([ungrant.status, ungrant.body.error?.code]).toEqual([
      409,
      'service-account-project-owned',
    ]);
  });

  test('a tenant admin may unregister it, and the next `runAsProject` makes a new one', async () => {
    const h = harness();
    const first = await runAsProject(h, 'schedule');
    const gone = await h.call(
      'POST',
      `/v1/service-accounts/${first.owner.id}/unregister`,
      undefined,
      'root',
    );
    expect(gone.status).toBe(200);
    expect(gone.body.unregisteredAt).toBeDefined();
    const next = await runAsProject(h, 'schedule');
    expect(next.owner.id).not.toBe(first.owner.id);
    expect(next.owner.isProjectAccount).toBe(true);
  });

  test('a key for it is a 409', async () => {
    const h = harness();
    const { owner } = await runAsProject(h, 'schedule');
    const res = await h.call(
      'POST',
      '/v1/tokens',
      { for: { kind: 'service-account', id: owner.id } },
      'root',
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'service-account-project-owned',
      message: "A project's own account has no keys: give an app a service account of its own.",
    });
  });
});

describe("a project's deletion", () => {
  async function withProject(
    unregister?: ServiceAccountBinding['unregister'],
    refuseDelete = false,
  ) {
    const trio = makeInMemoryProjectBinding();
    const created = await trio.projects.create(tenantId, { name: 'acme-shop', slug: 'acme-shop' });
    if (created.kind !== 'ok') throw new Error(`project not made: ${created.kind}`);
    const projectId = created.projectId as unknown as string;
    const accounts = accountsStore();
    const projectAccounts = accounts.binding.projectAccounts;
    if (projectAccounts === undefined) throw new Error('unreachable');
    await projectAccounts.ensure({ tenantId, projectId });
    const lines: string[] = [];
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      projectBinding: {
        ...trio.projects,
        ...(refuseDelete && {
          delete: async () => {
            throw new Error('a trigger still names the project');
          },
        }),
      },
      projectMembershipBinding: trio.memberships,
      teamProjectGrantBinding: trio.grants,
      serviceAccountBinding: {
        ...accounts.binding,
        ...(unregister !== undefined && { unregister }),
      },
      logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    const del = await app.request(`/v1/projects/${projectId}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer root', 'x-request-id': 'req-delete' },
    });
    return { status: del.status, account: accounts.activeFor(projectId), lines };
  }

  test('unregisters its own account', async () => {
    const { status, account } = await withProject();
    expect(status).toBe(204);
    expect(account).toBeUndefined();
  });

  test('an unregister that fails is logged, and the delete still answers 204', async () => {
    const { status, lines } = await withProject(async () => {
      throw new Error('store down');
    });
    expect(status).toBe(204);
    expect(lines.join('\n')).toMatch(/its own account wasn't unregistered .*store down/);
  });

  test('a delete refused leaves the account', async () => {
    const { status, account } = await withProject(undefined, true);
    expect(status).toBe(500);
    expect(account).toBeDefined();
  });
});

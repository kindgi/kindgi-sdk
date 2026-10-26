// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A schedule or webhook trigger a person owns is personal: only they (holding
 * `write`) or a project admin may change, pause, resume, fire or delete it.
 * One a service account owns is shared: changing what it runs (its target or
 * version, its input, its tools allowed unattended, a webhook's signing
 * secret) takes a project admin, and the project's writers keep the rest. No
 * change moves the owner; only `POST …/owner` does. Without an authorization
 * store, a project admin is a tenant-admin key. A change by anyone but a
 * personal trigger's owner is audited as `trigger-changed-for-owner`, and the
 * owner is told, without the request waiting for it.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  FlowRegistryBinding,
  IdentityDirectoryBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
  TriggerOwnerNotice,
  TriggerOwnerNotices,
  TriggerRegistryBinding,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID() as ProjectId;
const ADA = randomUUID() as UserId;
const BEN = randomUUID() as UserId;
const GRACE = randomUUID() as UserId;
const READER = randomUUID() as UserId;
const GONE = randomUUID() as UserId;
const ROOT = randomUUID() as UserId;
const BOT = 'sa-nightly';

type Role = 'read' | 'write' | 'admin';
const RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

/** Ada, Ben and the bot write the project; Grace administers it; the reader reads it. */
const startingRoles = (): Map<string, Role> =>
  new Map<string, Role>([
    [ADA, 'write'],
    [BEN, 'write'],
    [GRACE, 'admin'],
    [READER, 'read'],
    [GONE, 'write'],
    [BOT, 'write'],
  ]);

function decide(
  roles: Map<string, Role>,
  principal: unknown,
  action: Action,
  resource: ResourceRef,
): Decision {
  const actor = (principal as { actor?: { id?: string } }).actor?.id;
  const role = actor === undefined ? undefined : roles.get(actor);
  const needs = action === 'read' ? 1 : action === 'admin' || action === 'act_as' ? 3 : 2;
  const allowed = role !== undefined && RANK[role] >= needs;
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
  ben: { tenantId, userId: BEN, scopes: [] },
  grace: { tenantId, userId: GRACE, scopes: [] },
  reader: { tenantId, userId: READER, scopes: [] },
  gone: { tenantId, userId: GONE, scopes: [] },
  root: { tenantId, userId: ROOT, scopes: ['tenant-admin'] },
  bot: { tenantId, serviceAccountId: BOT as never },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;

const flowRegistry = {
  get: async ({ flowId }: { flowId: string }) =>
    flowId === 'acme.orders' || flowId === 'acme.refunds' ? { id: flowId, nodes: [] } : null,
  getVersion: async ({ flowId, version }: { flowId: string; version: string }) =>
    (flowId === 'acme.orders' && (version === '1.0.0' || version === '2.0.0')) ||
    (flowId === 'acme.refunds' && version === '1.0.0')
      ? { id: flowId, version, nodes: [{ id: 'refund', kind: 'tool', ref: 'acme.refund' }] }
      : null,
} as unknown as FlowRegistryBinding;

const identityDirectory = {
  getUser: async ({ userId }: { userId: string }) =>
    userId === ADA ? { userId, tenantId, displayName: 'Ada Lovelace', createdAt: '' } : null,
} as unknown as IdentityDirectoryBinding;

const serviceAccountBinding = {
  get: async ({ serviceAccountId }: { serviceAccountId: string }) =>
    serviceAccountId === BOT
      ? { serviceAccountId, tenantId, name: 'acme-nightly-bot', grants: [], createdAt: '' }
      : null,
} as unknown as ServiceAccountBinding;

function harness(
  opts: {
    authz?: boolean;
    tell?: TriggerOwnerNotices['tell'];
    wrap?: (registry: TriggerRegistryBinding) => TriggerRegistryBinding;
  } = {},
) {
  const roles = startingRoles();
  const written: AuditEvent[] = [];
  const store = createInMemoryAuditEventBinding();
  const auditEvents: typeof store = {
    ...store,
    append: async (events, ...rest) => {
      written.push(...events);
      return store.append(events, ...rest);
    },
  };
  const told: TriggerOwnerNotice[] = [];
  const logLines: string[] = [];
  let setOwnerCalls = 0;
  const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT });
  const counted: TriggerRegistryBinding = {
    ...registry,
    setOwner: async (input) => {
      setOwnerCalls += 1;
      return (registry.setOwner as NonNullable<TriggerRegistryBinding['setOwner']>)(input);
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: (opts.wrap ?? ((r) => r))(counted),
    flowRegistry,
    identityDirectory,
    serviceAccountBinding,
    auditEvents,
    logger: createLogger({ level: 'debug', write: (line) => logLines.push(line) }),
    triggerOwnerNotices: {
      tell:
        opts.tell ??
        ((notice) => {
          told.push(notice);
        }),
    },
    ...(opts.authz !== false && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (p, action, resource) => decide(roles, p, action, resource),
          checkBatch: async (p, action, resources) =>
            resources.map((resource) => decide(roles, p, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (method: string, path: string, body?: unknown, token = 'ada') => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': 'req-write-rule',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const changes = () => written.filter((e) => e.kind === 'trigger-changed-for-owner');
  return { call, roles, told, logLines, changes, setOwnerCalls: () => setOwnerCalls };
}
type Harness = ReturnType<typeof harness>;

const docOf = (e: AuditEvent | undefined) =>
  (e?.payload as { doc?: Record<string, unknown> } | undefined)?.doc;

const schedule = (over: Record<string, unknown> = {}) => ({
  flowId: 'acme.orders',
  flowVersion: '1.0.0',
  projectId: PROJECT,
  label: 'nightly',
  config: { cronExpression: '0 2 * * *', input: { region: 'eu' } },
  ...over,
});

const webhook = (over: Record<string, unknown> = {}) => ({
  flowId: 'acme.orders',
  flowVersion: '1.0.0',
  projectId: PROJECT,
  label: 'refunds',
  hmacSecretName: 'acme-hmac',
  config: { input: { region: 'eu' } },
  ...over,
});

const KINDS = {
  schedule: {
    path: '/v1/schedules',
    idOf: (b: Record<string, any>) => b.scheduleId as string,
    make: schedule,
    word: 'schedule',
    triggerKind: 'cron',
  },
  webhook: {
    path: '/v1/webhooks',
    idOf: (b: Record<string, any>) => b.triggerId as string,
    make: webhook,
    word: 'webhook trigger',
    triggerKind: 'webhook',
  },
} as const;
type Kind = keyof typeof KINDS;

/** A trigger `token` made: personal to them, or shared when it runs as the bot. */
async function made(h: Harness, kind: Kind, token: string, over: Record<string, unknown> = {}) {
  const k = KINDS[kind];
  const res = await h.call('POST', k.path, k.make(over), token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return k.idOf(res.body);
}
const adas = (h: Harness, kind: Kind) => made(h, kind, 'ada');
const shared = (h: Harness, kind: Kind) => made(h, kind, 'grace', { runAsServiceAccountId: BOT });

/** What-it-runs edits, per kind. */
const RUNS: Record<Kind, [string, Record<string, unknown>][]> = {
  schedule: [
    ['its input', { config: { input: { region: 'us' } } }],
    ['its flow version', { flowId: 'acme.orders', flowVersion: '2.0.0' }],
    ['its flow', { flowId: 'acme.refunds', flowVersion: '1.0.0' }],
  ],
  webhook: [
    ['its input', { config: { input: { region: 'us' } } }],
    ['its flow version', { flowVersion: '2.0.0' }],
    ['its signing secret', { hmacSecretName: 'acme-hmac-2' }],
  ],
};
/** Edits that don't change what it runs, per kind. */
const SETTINGS: Record<Kind, [string, Record<string, unknown>][]> = {
  schedule: [
    ['its label', { label: 'nightly, EU' }],
    ['its cron line', { config: { cronExpression: '0 3 * * *' } }],
    ['its catch-up policy', { catchUp: 'skip' }],
  ],
  webhook: [
    ['its label', { label: 'refunds, EU' }],
    ['its rate limit', { rateLimitPerMinute: 30 }],
  ],
};
/** The lifecycle calls, per kind (a webhook has no run-now). */
const LIFECYCLE: Record<Kind, [string, string, number][]> = {
  schedule: [
    ['pause', 'paused', 200],
    ['resume', 'resumed', 200],
    ['run-now', 'fired', 202],
    ['unregister', 'unregistered', 200],
  ],
  webhook: [
    ['pause', 'paused', 200],
    ['resume', 'resumed', 200],
    ['unregister', 'unregistered', 200],
  ],
};

for (const kind of ['schedule', 'webhook'] as const) {
  const k = KINDS[kind];
  const personal = `This ${k.word} is personal: only Ada Lovelace or a project admin can change it.`;
  const sharedRuns = `Changing what a shared ${k.word} runs takes a project admin.`;

  describe(`a personal ${kind}, with an authorizer`, () => {
    test.each([...RUNS[kind], ...SETTINGS[kind]])(
      '%s, changed by its owner: OK, the owner stays, nothing recorded',
      async (_what, patch) => {
        const h = harness();
        const id = await adas(h, kind);
        const res = await h.call('PATCH', `${k.path}/${id}`, patch, 'ada');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.owner).toMatchObject({ kind: 'user', id: ADA });
        expect(h.changes()).toEqual([]);
        expect(h.told).toEqual([]);
        expect(h.setOwnerCalls()).toBe(0);
      },
    );

    test.each([...RUNS[kind], ...SETTINGS[kind]])(
      '%s, changed by another writer: a 403 that names the owner, no change',
      async (_what, patch) => {
        const h = harness();
        const id = await adas(h, kind);
        const before = await h.call('GET', `${k.path}/${id}`);
        const res = await h.call('PATCH', `${k.path}/${id}`, patch, 'ben');
        expect(res.status).toBe(403);
        expect(res.body.error).toMatchObject({ code: 'permission-denied', message: personal });
        expect((await h.call('GET', `${k.path}/${id}`)).body).toEqual(before.body);
        expect(h.changes()).toEqual([]);
        expect(h.told).toEqual([]);
      },
    );

    test.each(LIFECYCLE[kind])('%s by another writer: a 403 that names the owner', async (verb) => {
      const h = harness();
      const id = await adas(h, kind);
      const res = await h.call('POST', `${k.path}/${id}/${verb}`, undefined, 'ben');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'permission-denied', message: personal });
    });

    test.each(RUNS[kind])(
      '%s, changed by a project admin: OK, the owner stays, recorded once, the owner told once',
      async (_what, patch) => {
        const h = harness();
        const id = await adas(h, kind);
        const res = await h.call('PATCH', `${k.path}/${id}`, patch, 'grace');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.owner).toMatchObject({ kind: 'user', id: ADA });
        expect(h.setOwnerCalls()).toBe(0);
        const entries = h.changes();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          actor: `user:${GRACE}`,
          correlationId: 'req-write-rule',
        });
        expect(docOf(entries[0])).toMatchObject({
          triggerId: id,
          triggerKind: k.triggerKind,
          owner: `user:${ADA}`,
          by: `user:${GRACE}`,
          change: 'updated',
        });
        expect((docOf(entries[0]) as { fields?: string[] }).fields?.length).toBeGreaterThan(0);
        expect(h.told).toHaveLength(1);
        expect(h.told[0]).toMatchObject({
          tenantId,
          projectId: PROJECT,
          triggerId: id,
          triggerKind: k.triggerKind,
          owner: { kind: 'user', id: ADA },
          by: `user:${GRACE}`,
          change: 'updated',
        });
      },
    );

    test('an admin changing its input: the entry names no input value', async () => {
      const h = harness();
      const id = await adas(h, kind);
      await h.call(
        'PATCH',
        `${k.path}/${id}`,
        { config: { input: { region: 'acme-secret-region' } } },
        'grace',
      );
      const seen = JSON.stringify([h.changes(), h.told]);
      expect(seen).not.toContain('acme-secret-region');
      expect(seen).not.toContain('"eu"');
    });

    test.each(LIFECYCLE[kind])(
      '%s by a project admin: OK, recorded once, the owner told once',
      async (verb, change, status) => {
        const h = harness();
        const id = await adas(h, kind);
        if (verb === 'resume') await h.call('POST', `${k.path}/${id}/pause`, undefined, 'ada');
        const res = await h.call('POST', `${k.path}/${id}/${verb}`, undefined, 'grace');
        expect(res.status, JSON.stringify(res.body)).toBe(status);
        expect(h.changes().map((e) => docOf(e)?.change)).toEqual([change]);
        expect(h.told.map((n) => n.change)).toEqual([change]);
      },
    );

    test.each(LIFECYCLE[kind])(
      '%s by its owner: OK, nothing recorded',
      async (verb, _c, status) => {
        const h = harness();
        const id = await adas(h, kind);
        if (verb === 'resume') await h.call('POST', `${k.path}/${id}/pause`, undefined, 'ada');
        const res = await h.call('POST', `${k.path}/${id}/${verb}`, undefined, 'ada');
        expect(res.status).toBe(status);
        expect(h.changes()).toEqual([]);
        expect(h.told).toEqual([]);
      },
    );

    test('a reader gets the authorizer’s own 403, which never names the owner', async () => {
      const h = harness();
      const id = await adas(h, kind);
      const res = await h.call('PATCH', `${k.path}/${id}`, { label: 'x' }, 'reader');
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('Ada');
      expect(JSON.stringify(res.body)).not.toContain(ADA);
    });

    test('an owner who lost `write` gets the authorizer’s own 403 on their own trigger', async () => {
      const h = harness();
      const id = await adas(h, kind);
      h.roles.set(ADA, 'read');
      const res = await h.call('PATCH', `${k.path}/${id}`, { label: 'x' }, 'ada');
      expect(res.status).toBe(403);
      expect(res.body.error.message).not.toBe(personal);
    });

    test('an owner who is also an admin: their own change is not recorded', async () => {
      const h = harness();
      h.roles.set(ADA, 'admin');
      const id = await adas(h, kind);
      const res = await h.call('PATCH', `${k.path}/${id}`, RUNS[kind][0]![1], 'ada');
      expect(res.status).toBe(200);
      expect(h.changes()).toEqual([]);
      expect(h.told).toEqual([]);
    });

    test('an owner removed from the tenant: the 403 names them by id; an admin’s change is recorded and told', async () => {
      const h = harness();
      const id = await made(h, kind, 'gone');
      h.roles.delete(GONE);
      const refused = await h.call('PATCH', `${k.path}/${id}`, { label: 'x' }, 'ben');
      expect(refused.status).toBe(403);
      expect(refused.body.error.message).toBe(
        `This ${k.word} is personal: only ${GONE} or a project admin can change it.`,
      );
      const res = await h.call('PATCH', `${k.path}/${id}`, { label: 'x' }, 'grace');
      expect(res.status).toBe(200);
      expect(h.changes()).toHaveLength(1);
      expect(h.told).toMatchObject([{ owner: { kind: 'user', id: GONE } }]);
    });

    test('an owner’s PATCH that sets only the list still takes the admin', async () => {
      const h = harness();
      const id = await adas(h, kind);
      const res = await h.call(
        'PATCH',
        `${k.path}/${id}`,
        { toolsAllowedUnattended: ['acme.refund'] },
        'ada',
      );
      expect(res.status).toBe(403);
      const byAdmin = await h.call(
        'PATCH',
        `${k.path}/${id}`,
        { toolsAllowedUnattended: ['acme.refund'] },
        'grace',
      );
      expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    });

    test('a take-over from its owner tells them, and is audited as `trigger-owner-set`', async () => {
      const h = harness();
      const id = await adas(h, kind);
      const res = await h.call('POST', `${k.path}/${id}/owner`, {}, 'grace');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.owner).toMatchObject({ kind: 'user', id: GRACE });
      expect(h.told).toMatchObject([
        { owner: { kind: 'user', id: ADA }, by: `user:${GRACE}`, change: 'taken-over' },
      ]);
      expect(h.changes()).toEqual([]);
    });

    test('a take-over still takes the admin', async () => {
      const h = harness();
      const id = await adas(h, kind);
      expect((await h.call('POST', `${k.path}/${id}/owner`, {}, 'ben')).status).toBe(403);
      expect(h.told).toEqual([]);
    });
  });

  describe(`a shared ${kind}, with an authorizer`, () => {
    test.each(SETTINGS[kind])(
      '%s, changed by a writer: OK, nothing recorded',
      async (_what, patch) => {
        const h = harness();
        const id = await shared(h, kind);
        const res = await h.call('PATCH', `${k.path}/${id}`, patch, 'ben');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
        expect(h.changes()).toEqual([]);
        expect(h.told).toEqual([]);
      },
    );

    test.each(LIFECYCLE[kind])('%s by a writer: OK', async (verb, _c, status) => {
      const h = harness();
      const id = await shared(h, kind);
      if (verb === 'resume') await h.call('POST', `${k.path}/${id}/pause`, undefined, 'ben');
      expect((await h.call('POST', `${k.path}/${id}/${verb}`, undefined, 'ben')).status).toBe(
        status,
      );
      expect(h.changes()).toEqual([]);
    });

    test.each(RUNS[kind])('%s, changed by a writer: a 403', async (_what, patch) => {
      const h = harness();
      const id = await shared(h, kind);
      const res = await h.call('PATCH', `${k.path}/${id}`, patch, 'ben');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'permission-denied', message: sharedRuns });
    });

    test.each(RUNS[kind])(
      '%s, changed by a project admin: OK, nothing recorded',
      async (_what, patch) => {
        const h = harness();
        const id = await shared(h, kind);
        const res = await h.call('PATCH', `${k.path}/${id}`, patch, 'grace');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
        expect(h.changes()).toEqual([]);
        expect(h.told).toEqual([]);
      },
    );

    test('the owning service account’s own writer key: a 403 for what it runs, OK for the label', async () => {
      const h = harness();
      const id = await shared(h, kind);
      expect((await h.call('PATCH', `${k.path}/${id}`, RUNS[kind][0]![1], 'bot')).status).toBe(403);
      expect(
        (await h.call('PATCH', `${k.path}/${id}`, { label: 'by the bot' }, 'bot')).status,
      ).toBe(200);
    });

    test('the same value sent again is not a change to what it runs', async () => {
      const h = harness();
      const id = await shared(h, kind);
      const res = await h.call(
        'PATCH',
        `${k.path}/${id}`,
        { config: { input: { region: 'eu' } } },
        'ben',
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
  });
}

describe('telling the owner never holds up or fails the change', () => {
  const adminEdit = async (h: Harness) => {
    const id = await adas(h, 'schedule');
    return h.call('PATCH', `/v1/schedules/${id}`, { label: 'by an admin' }, 'grace');
  };

  test('a `tell` that throws: 200, and the error is logged', async () => {
    const h = harness({
      tell: () => {
        throw new Error('acme notices down');
      },
    });
    expect((await adminEdit(h)).status).toBe(200);
    expect(h.changes()).toHaveLength(1);
    expect(h.logLines.join('\n')).toContain('acme notices down');
  });

  test('a `tell` whose promise rejects: 200, and the error is logged', async () => {
    const h = harness({ tell: async () => Promise.reject(new Error('acme notices down')) });
    expect((await adminEdit(h)).status).toBe(200);
    await vi.waitFor(() => expect(h.logLines.join('\n')).toContain('acme notices down'));
    expect(h.logLines.join('\n')).toContain('req-write-rule');
  });

  test('a `tell` that never settles: 200 all the same', async () => {
    const h = harness({ tell: () => new Promise<void>(() => {}) });
    expect((await adminEdit(h)).status).toBe(200);
  });
});

describe('without an authorizer: a project admin is a tenant-admin key', () => {
  const noAuthz = () => harness({ authz: false });

  test.each([
    ['PATCH', '', { label: 'x' }],
    ['PATCH', '', { config: { input: { region: 'us' } } }],
    ['POST', '/pause', undefined],
    ['POST', '/run-now', undefined],
    ['POST', '/unregister', undefined],
  ])("another member's %s%s of a personal schedule: a 403", async (method, suffix, body) => {
    const h = noAuthz();
    const id = await adas(h, 'schedule');
    const res = await h.call(method, `/v1/schedules/${id}${suffix}`, body, 'ben');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'permission-denied' });
  });

  test('a tenant-admin key may change it, and the owner is told', async () => {
    const h = noAuthz();
    const id = await adas(h, 'schedule');
    const res = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { config: { input: { region: 'us' } } },
      'root',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: ADA });
    expect(h.told).toHaveLength(1);
  });

  test('the owner may change it', async () => {
    const h = noAuthz();
    const id = await adas(h, 'schedule');
    expect(
      (await h.call('PATCH', `/v1/schedules/${id}`, { config: { input: { region: 'us' } } }))
        .status,
    ).toBe(200);
  });

  test("a member's label change on a shared schedule: OK; a retarget: a 403", async () => {
    const h = noAuthz();
    const id = await made(h, 'schedule', 'root', { runAsServiceAccountId: BOT });
    expect((await h.call('PATCH', `/v1/schedules/${id}`, { label: 'x' }, 'ben')).status).toBe(200);
    const res = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { flowId: 'acme.orders', flowVersion: '2.0.0' },
      'ben',
    );
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(
      'Changing what a shared schedule runs takes a project admin.',
    );
  });

  test('the shared schedule’s own service-account key, not a tenant admin: a 403 on a retarget', async () => {
    const h = noAuthz();
    const id = await made(h, 'schedule', 'root', { runAsServiceAccountId: BOT });
    const res = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { flowId: 'acme.orders', flowVersion: '2.0.0' },
      'bot',
    );
    expect(res.status).toBe(403);
  });

  test('a member naming a non-empty list on their own schedule: a 403; a tenant-admin key: OK', async () => {
    const h = noAuthz();
    const id = await adas(h, 'schedule');
    const list = { toolsAllowedUnattended: ['acme.refund'] };
    expect((await h.call('PATCH', `/v1/schedules/${id}`, list, 'ada')).status).toBe(403);
    expect((await h.call('PATCH', `/v1/schedules/${id}`, list, 'root')).status).toBe(200);
  });

  test("a member's take-over of a colleague's schedule: a 403; a tenant-admin key: OK", async () => {
    const h = noAuthz();
    const id = await adas(h, 'schedule');
    expect((await h.call('POST', `/v1/schedules/${id}/owner`, {}, 'ben')).status).toBe(403);
    expect((await h.call('POST', `/v1/schedules/${id}/owner`, {}, 'root')).status).toBe(200);
  });

  test("another member's PATCH of a personal webhook trigger: a 403 that says webhook trigger", async () => {
    const h = noAuthz();
    const id = await adas(h, 'webhook');
    const res = await h.call('PATCH', `/v1/webhooks/${id}`, { label: 'x' }, 'ben');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(
      'This webhook trigger is personal: only Ada Lovelace or a project admin can change it.',
    );
  });
});

describe('a trigger with no owner is treated as shared', () => {
  // A store from before owners: the registry answers no owner.
  const noOwner = (registry: TriggerRegistryBinding): TriggerRegistryBinding => ({
    ...registry,
    get: async (input) => {
      const rec = await registry.get(input);
      return rec === null ? null : { ...rec, owner: { kind: 'service', id: 'unknown' } };
    },
  });

  test.each([true, false])(
    'authorizer %s: a writer’s label change is OK; a retarget takes the admin',
    async (authz) => {
      const h = harness({ authz, wrap: noOwner });
      const id = await adas(h, 'schedule');
      expect((await h.call('PATCH', `/v1/schedules/${id}`, { label: 'x' }, 'ben')).status).toBe(
        200,
      );
      const retarget = { flowId: 'acme.orders', flowVersion: '2.0.0' };
      expect((await h.call('PATCH', `/v1/schedules/${id}`, retarget, 'ben')).status).toBe(403);
      expect(
        (await h.call('PATCH', `/v1/schedules/${id}`, retarget, authz ? 'grace' : 'root')).status,
      ).toBe(200);
      expect(h.told).toEqual([]);
    },
  );
});

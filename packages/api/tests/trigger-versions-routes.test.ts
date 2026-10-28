// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A trigger's versions, for every kind, over the in-memory registry:
 * registering makes version 1 and each change the next, newest first; a
 * PATCH that changes nothing, pausing and resuming make none; a take-over
 * makes one (`owner`). A version names the authenticated caller, never
 * what a body says, and never changes after. Reading versions is reading
 * the trigger: who can't read it can't read them, and another tenant's
 * trigger isn't found.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision } from '@kindgi/authz';
import type { EnvName, ProjectId, TenantId, UserId } from '@kindgi/types';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';
import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  ProviderRegistryBinding,
  RunHandlerBinding,
  SecretBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const otherTenant = randomUUID() as TenantId;
/** A project writer: registers and edits. */
const WREN = randomUUID() as UserId;
/** A tenant admin: takes triggers over. */
const ADA = randomUUID() as UserId;
/** In the tenant, but may read nothing. */
const EVE = randomUUID() as UserId;
const PROJECT = randomUUID() as ProjectId;

const TOKENS: Record<string, Awaited<ReturnType<TokenResolver>>> = {
  wren: { tenantId, userId: WREN, scopes: [] },
  ada: { tenantId, userId: ADA, scopes: ['tenant-admin'] },
  eve: { tenantId, userId: EVE, scopes: [] },
  other: { tenantId: otherTenant, userId: ADA, scopes: ['tenant-admin'] },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;

/** Every right, except none at all for Eve. */
function decision(principal: unknown, action: Action): Decision {
  const allowed = (principal as { actor?: { id?: string } }).actor?.id !== EVE;
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: { action, relation: '', resource: '', actorSubject: '' },
  };
}

const agentRegistry = {
  get: async ({ agentId }: { agentId: string }) => ({ id: agentId, tools: [] }),
  getVersion: async ({ agentId, version }: { agentId: string; version: string }) => ({
    id: agentId,
    version,
    tools: [],
  }),
} as unknown as AgentRegistryBinding;

function harness() {
  const registry = createInMemoryTriggerRegistry({ defaultProjectId: PROJECT });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: registry,
    agentRegistry,
    secretsBinding: { get: async () => null } as unknown as SecretBinding,
    providerRegistry: {
      resolveForRuntime: async () => [],
    } as unknown as ProviderRegistryBinding,
    webhookReceiver: { envName: 'test' as EnvName },
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (p, action) => decision(p, action),
        checkBatch: async (p, action, rs) => rs.map(() => decision(p, action)),
      } satisfies AuthzCheckBinding,
    },
  });
  const call = async (method: string, path: string, body?: unknown, token = 'wren') => {
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
  return { call, registry };
}

/** What a body may claim of who made a change: never what a version names. */
const FORGED = { createdBy: 'user:mallory', by: 'user:mallory' };

interface Kind {
  readonly name: string;
  readonly base: string;
  /** Its schemas' prefix in the document; none for a kind the document leaves out. */
  readonly schema?: string;
  readonly register: Record<string, unknown>;
  /** A change: v2's definition differs from v1's by `changed`. */
  readonly edit: Record<string, unknown>;
  readonly before: Record<string, unknown>;
  readonly changed: Record<string, unknown>;
  /** The fields v1's definition holds as registered. */
  readonly definition: Record<string, unknown>;
  /** Whether a take-over is a route of this kind's. */
  readonly owned: boolean;
  /** Its fires' kind, where it has a fire history on the wire. */
  readonly fires?: 'schedule' | 'webhook' | 'mail';
}

const KINDS: readonly Kind[] = [
  {
    name: 'schedule',
    base: '/v1/schedules',
    schema: 'Schedule',
    register: {
      flowId: 'acme.nightly',
      flowVersion: '1.0.0',
      projectId: PROJECT,
      config: { cronExpression: '0 2 * * *', input: { batch: 'all' } },
      label: 'Nightly',
    },
    edit: { config: { cronExpression: '0 3 * * *' } },
    before: { cronExpression: '0 2 * * *' },
    changed: { cronExpression: '0 3 * * *' },
    definition: {
      flowId: 'acme.nightly',
      flowVersion: '1.0.0',
      projectId: PROJECT,
      owner: { kind: 'user', id: WREN },
      cronExpression: '0 2 * * *',
      input: { batch: 'all' },
      catchUp: 'latest',
      overlap: 'skip',
      startingDeadlineSeconds: 600,
      label: 'Nightly',
    },
    owned: true,
    fires: 'schedule',
  },
  {
    name: 'webhook trigger',
    base: '/v1/webhooks',
    schema: 'WebhookTrigger',
    register: {
      flowId: 'acme.refund-review',
      flowVersion: '1.0.0',
      projectId: PROJECT,
      hmacSecretName: 'acme-hmac',
      label: 'Refunds',
    },
    edit: { rateLimitPerMinute: 120 },
    before: { rateLimitPerMinute: 600 },
    changed: { rateLimitPerMinute: 120 },
    definition: {
      flowId: 'acme.refund-review',
      flowVersion: '1.0.0',
      projectId: PROJECT,
      owner: { kind: 'user', id: WREN },
      hmacSecretName: 'acme-hmac',
      hmacSecretScope: { kind: 'tenant' },
      signature: { kind: 'hmac-sha256', encoding: 'hex', header: 'X-Kindgi-Signature' },
      bodyLimitBytes: 262144,
      rateLimitPerMinute: 600,
      label: 'Refunds',
    },
    owned: true,
    fires: 'webhook',
  },
  {
    name: 'mail trigger',
    base: '/v1/mail-triggers',
    schema: 'MailTrigger',
    register: {
      agentId: 'acme.support',
      projectId: PROJECT,
      config: { mailbox: { app: 'google', as: 'person' } },
      label: 'Support',
    },
    edit: { config: { pollSeconds: 120 } },
    before: { pollSeconds: 60 },
    changed: { pollSeconds: 120 },
    definition: {
      agentId: 'acme.support',
      projectId: PROJECT,
      owner: { kind: 'user', id: WREN },
      mailbox: { app: 'google', as: 'person' },
      pollSeconds: 60,
      runsPerHour: 60,
      label: 'Support',
    },
    owned: true,
    fires: 'mail',
  },
  {
    name: 'event trigger',
    base: '/v1/event-triggers',
    register: {
      flowId: 'acme.react',
      flowVersion: '1.0.0',
      config: { eventKind: 'run.finished', input: { from: 'acme' } },
      label: 'React',
    },
    edit: { config: { eventKind: 'run.failed' } },
    before: { eventKind: 'run.finished' },
    changed: { eventKind: 'run.failed' },
    definition: {
      flowId: 'acme.react',
      flowVersion: '1.0.0',
      eventKind: 'run.finished',
      input: { from: 'acme' },
      label: 'React',
    },
    owned: false,
  },
];

describe.each(KINDS)("a $name's versions", (kind) => {
  async function registered(h: ReturnType<typeof harness>): Promise<string> {
    const made = await h.call('POST', kind.base, { ...kind.register, ...FORGED });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.version).toBe(1);
    return made.body.triggerId as string;
  }

  test('register, then an edit: two versions, newest first, each with its definition, cause and maker', async () => {
    const h = harness();
    const id = await registered(h);
    const edited = await h.call('PATCH', `${kind.base}/${id}`, { ...kind.edit, ...FORGED });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.version).toBe(2);

    const page = await h.call('GET', `${kind.base}/${id}/versions`);
    expect(page.status).toBe(200);
    if (kind.schema !== undefined) {
      expect(validateAgainst(`${kind.schema}VersionPage`, page.body)).toEqual([]);
    }
    expect(page.body.data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(page.body.hasMore).toBe(false);

    const v1 = await h.call('GET', `${kind.base}/${id}/versions/1`);
    expect(v1.status).toBe(200);
    if (kind.schema !== undefined) {
      expect(validateAgainst(`${kind.schema}Version`, v1.body)).toEqual([]);
    }
    expect(v1.body).toMatchObject({
      triggerId: id,
      version: 1,
      cause: 'register',
      createdBy: `user:${WREN}`,
    });
    expect(v1.body.definition).toEqual(kind.definition);

    const v2 = await h.call('GET', `${kind.base}/${id}/versions/2`);
    expect(v2.status).toBe(200);
    expect(v2.body).toMatchObject({ version: 2, cause: 'edit', createdBy: `user:${WREN}` });
    expect(v2.body.definition).toEqual({ ...kind.definition, ...kind.changed });
    expect(page.body.data).toEqual([v2.body, v1.body]);
  });

  test('a PATCH that changes nothing makes no version, nor do pausing and resuming', async () => {
    const h = harness();
    const id = await registered(h);
    const same = await h.call('PATCH', `${kind.base}/${id}`, { label: kind.register.label });
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(1);
    for (const verb of ['pause', 'resume']) {
      const res = await h.call('POST', `${kind.base}/${id}/${verb}`);
      expect(res.status, verb).toBe(200);
      expect(res.body.version, verb).toBe(1);
    }
    const page = await h.call('GET', `${kind.base}/${id}/versions`);
    expect(page.body.data.map((v: { cause: string }) => v.cause)).toEqual(['register']);
  });

  test('an older version is as it was after a later edit', async () => {
    const h = harness();
    const id = await registered(h);
    const before = (await h.call('GET', `${kind.base}/${id}/versions/1`)).body;
    await h.call('PATCH', `${kind.base}/${id}`, kind.edit);
    await h.call('PATCH', `${kind.base}/${id}`, { label: 'Renamed' });
    expect((await h.call('GET', `${kind.base}/${id}/versions/1`)).body).toEqual(before);
    const v2 = (await h.call('GET', `${kind.base}/${id}/versions/2`)).body;
    expect(v2.definition).toMatchObject({ ...kind.changed, label: kind.register.label });
    const v3 = (await h.call('GET', `${kind.base}/${id}/versions/3`)).body;
    expect(v3.definition).toMatchObject({ ...kind.changed, label: 'Renamed' });
    expect(before.definition).toMatchObject(kind.before);
  });

  test.runIf(kind.owned)(
    'a take-over makes a version (`owner`), naming who took it, whatever the body says',
    async () => {
      const h = harness();
      const id = await registered(h);
      const taken = await h.call('POST', `${kind.base}/${id}/owner`, FORGED, 'ada');
      expect(taken.status, JSON.stringify(taken.body)).toBe(200);
      expect(taken.body.version).toBe(2);
      const v2 = await h.call('GET', `${kind.base}/${id}/versions/2`);
      expect(v2.body).toMatchObject({ version: 2, cause: 'owner', createdBy: `user:${ADA}` });
      expect(v2.body.definition).toEqual({
        ...kind.definition,
        owner: expect.objectContaining({ kind: 'user', id: ADA }),
      });
    },
  );

  test('a version it never had is a 404 (`trigger-version-not-found`); a malformed one a 400', async () => {
    const h = harness();
    const id = await registered(h);
    const missing = await h.call('GET', `${kind.base}/${id}/versions/2`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({
      code: 'trigger-version-not-found',
      details: { triggerId: id, version: 2 },
    });
    for (const bad of ['0', '-1', '1.5', 'one', '01']) {
      const res = await h.call('GET', `${kind.base}/${id}/versions/${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error.code, bad).toBe('bad-input');
    }
  });

  test("another tenant's trigger isn't found, and who can't read it can't read its versions", async () => {
    const h = harness();
    const id = await registered(h);
    for (const path of [`/${id}/versions`, `/${id}/versions/1`]) {
      const elsewhere = await h.call('GET', `${kind.base}${path}`, undefined, 'other');
      expect(elsewhere.status, path).toBe(404);
      expect(elsewhere.body.error.code, path).toBe('trigger-not-found');
      expect((await h.call('GET', `${kind.base}/${id}`, undefined, 'eve')).status).toBe(403);
      expect((await h.call('GET', `${kind.base}${path}`, undefined, 'eve')).status, path).toBe(403);
    }
  });

  test.runIf(kind.fires !== undefined)(
    'a fire names the version its run started with, and none before it starts',
    async () => {
      const h = harness();
      const id = await registered(h);
      const at = { triggerId: id as never, kind: kind.fires ?? 'schedule' };
      h.registry.recordFire({
        ...at,
        firedAt: '2026-10-07T10:00:01.000Z',
        outcome: 'started',
        runId: randomUUID() as never,
        version: 1,
      });
      h.registry.recordFire({ ...at, firedAt: '2026-10-07T11:00:01.000Z', outcome: 'pending' });
      const fires = await h.call('GET', `${kind.base}/${id}/fires`);
      expect(fires.status).toBe(200);
      expect(fires.body.data.map((f: { version?: number }) => f.version)).toEqual([undefined, 1]);
    },
  );

  test("an unregistered trigger's versions aren't found", async () => {
    const h = harness();
    const id = await registered(h);
    expect((await h.call('POST', `${kind.base}/${id}/unregister`)).status).toBe(200);
    expect((await h.call('GET', `${kind.base}/${id}/versions`)).status).toBe(404);
    expect((await h.call('GET', `${kind.base}/${id}/versions/1`)).status).toBe(404);
  });
});

describe('the versions list pages', () => {
  test('newest first, `limit` at a time, with a cursor to the rest', async () => {
    const h = harness();
    const made = await h.call('POST', '/v1/schedules', KINDS[0]?.register);
    const id = made.body.triggerId as string;
    for (const label of ['b', 'c', 'd']) {
      expect((await h.call('PATCH', `/v1/schedules/${id}`, { label })).status).toBe(200);
    }
    const first = await h.call('GET', `/v1/schedules/${id}/versions?limit=3`);
    expect(first.body.data.map((v: { version: number }) => v.version)).toEqual([4, 3, 2]);
    expect(first.body.hasMore).toBe(true);
    const rest = await h.call(
      'GET',
      `/v1/schedules/${id}/versions?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(rest.body.data.map((v: { version: number }) => v.version)).toEqual([1]);
    expect(rest.body.hasMore).toBe(false);
    expect(rest.body).not.toHaveProperty('nextCursor');
  });

  test("a trigger of another kind is that route's 404", async () => {
    const h = harness();
    const made = await h.call('POST', '/v1/schedules', KINDS[0]?.register);
    const id = made.body.triggerId as string;
    expect((await h.call('GET', `/v1/webhooks/${id}/versions`)).status).toBe(404);
    expect((await h.call('GET', `/v1/mail-triggers/${id}/versions/1`)).status).toBe(404);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A trigger runs as whoever created it, or last changed what it runs. When
 * anyone but the person who owns a schedule or webhook changes its target or
 * version, its input, its `toolsAllowedUnattended` or a webhook's signing
 * secret, the editor becomes its owner, as `POST …/owner` would make them,
 * audited as `trigger-owner-set`. A label, the cron line, the delivery
 * settings, the same value sent again, or the owner's own edit doesn't move
 * it. A trigger a service account owns keeps its owner; a service account
 * that changes a person's trigger makes it the service account's.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  FlowRegistryBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
  TriggerRegistryBinding,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ADA = randomUUID() as UserId;
const BEN = randomUUID() as UserId;
const BOT = 'sa-nightly';
const PROJECT = randomUUID() as ProjectId;

const TOKENS: Record<string, Awaited<ReturnType<TokenResolver>>> = {
  ada: { tenantId, userId: ADA, scopes: ['tenant-admin'] },
  ben: { tenantId, userId: BEN, scopes: ['tenant-admin'] },
  bot: { tenantId, serviceAccountId: BOT as never },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;

const flowRegistry = {
  get: async ({ flowId }: { flowId: string }) =>
    flowId === 'acme.orders' ? { id: flowId, nodes: [] } : null,
  getVersion: async ({ flowId, version }: { flowId: string; version: string }) =>
    flowId === 'acme.orders' && (version === '1.0.0' || version === '2.0.0')
      ? { id: flowId, version, nodes: [{ id: 'refund', kind: 'tool', ref: 'acme.refund' }] }
      : null,
} as unknown as FlowRegistryBinding;

function harness(wrap: (registry: TriggerRegistryBinding) => TriggerRegistryBinding = (r) => r) {
  const auditEvents = createInMemoryAuditEventBinding();
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
    triggerRegistry: wrap(createInMemoryTriggerRegistry({ defaultProjectId: PROJECT })),
    flowRegistry,
    serviceAccountBinding,
    auditEvents,
  });
  const call = async (method: string, path: string, body?: unknown, token = 'ada') => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': 'req-edit',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const ownerSets = async (): Promise<AuditEvent[]> => {
    const page = await auditEvents.query({ tenantId, limit: 50 });
    if (page.kind === 'err') throw new Error(page.error.message);
    return page.value.data.filter((e) => e.kind === 'trigger-owner-set');
  };
  return { call, ownerSets };
}

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
  hmacSecretName: 'acme-hmac',
  config: { input: { region: 'eu' } },
  ...over,
});

/** A schedule Ada made: she owns it, unless it runs as a service account. */
async function adasSchedule(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  const made = await h.call('POST', '/v1/schedules', schedule(over));
  expect(made.status).toBe(201);
  expect(made.body.owner).toMatchObject(
    over.runAsServiceAccountId === undefined ? { kind: 'user', id: ADA } : { kind: 'service' },
  );
  return made.body.scheduleId as string;
}

describe('a schedule: whoever changes what it runs becomes its owner', () => {
  test.each([
    ['its input', { config: { input: { region: 'us' } } }],
    ['its flow version', { flowId: 'acme.orders', flowVersion: '2.0.0' }],
    ['its tool list', { toolsAllowedUnattended: ['acme.refund'] }],
  ])('%s, changed by another person: the editor owns it, audited', async (_what, patch) => {
    const h = harness();
    const id = await adasSchedule(h);
    const res = await h.call('PATCH', `/v1/schedules/${id}`, patch, 'ben');
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: BEN });

    const read = await h.call('GET', `/v1/schedules/${id}`);
    expect(read.body.owner).toMatchObject({ kind: 'user', id: BEN });
    const events = await h.ownerSets();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: `user:${BEN}`, correlationId: 'req-edit' });
    expect(docOf(events[0])).toMatchObject({
      triggerId: id,
      triggerKind: 'cron',
      from: `user:${ADA}`,
      to: `user:${BEN}`,
      by: `user:${BEN}`,
    });
  });

  test('the audit names the tool list the new owner runs with', async () => {
    const h = harness();
    const id = await adasSchedule(h);
    await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { toolsAllowedUnattended: ['acme.refund'] },
      'ben',
    );
    expect(docOf((await h.ownerSets())[0])).toMatchObject({
      toolsAllowedUnattended: ['acme.refund'],
    });
  });

  test.each([
    ['its label', { label: 'nightly, EU' }],
    ['its cron line', { config: { cronExpression: '0 3 * * *' } }],
    ['its catch-up policy', { catchUp: 'skip' }],
    ['the same input again, keys in another order', { config: { input: { region: 'eu' } } }],
    ['the same flow version again', { flowId: 'acme.orders', flowVersion: '1.0.0' }],
    ['the same (empty) tool list', { toolsAllowedUnattended: [] }],
  ])('%s, changed by another person: the owner stays', async (_what, patch) => {
    const h = harness();
    const id = await adasSchedule(h);
    const res = await h.call('PATCH', `/v1/schedules/${id}`, patch, 'ben');
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: ADA });
    expect(await h.ownerSets()).toEqual([]);
  });

  test("the owner's own change keeps the owner", async () => {
    const h = harness();
    const id = await adasSchedule(h);
    const res = await h.call('PATCH', `/v1/schedules/${id}`, {
      config: { input: { region: 'us' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: ADA });
    expect(await h.ownerSets()).toEqual([]);
  });

  test("a service account that changes a person's schedule makes it the service account's", async () => {
    const h = harness();
    const id = await adasSchedule(h);
    const res = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { config: { input: { region: 'us' } } },
      'bot',
    );
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
    expect(docOf((await h.ownerSets())[0])).toMatchObject({
      from: `user:${ADA}`,
      to: `service:${BOT}`,
    });
  });

  test('a schedule a service account owns keeps its owner', async () => {
    const h = harness();
    const id = await adasSchedule(h, { runAsServiceAccountId: BOT });
    const before = (await h.ownerSets()).length;
    const res = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { config: { input: { region: 'us' } } },
      'ben',
    );
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });
    expect(await h.ownerSets()).toHaveLength(before);
  });
});

describe('when the change itself fails', () => {
  const failingUpdate =
    (opts: { putBackFails?: boolean } = {}) =>
    (registry: TriggerRegistryBinding): TriggerRegistryBinding => {
      let setOwnerCalls = 0;
      return {
        ...registry,
        update: async (input) => ({
          kind: 'err',
          error: {
            code: 'trigger-update-failed',
            message: 'the store is unavailable',
            triggerId: input.triggerId,
          },
        }),
        setOwner: async (input) => {
          setOwnerCalls += 1;
          if (opts.putBackFails === true && setOwnerCalls > 1) {
            return {
              kind: 'err',
              error: {
                code: 'trigger-lifecycle-failed',
                message: 'the store is unavailable',
                triggerId: input.triggerId,
              },
            };
          }
          return (registry.setOwner as NonNullable<TriggerRegistryBinding['setOwner']>)(input);
        },
      };
    };

  test("the owner is put back, nothing is audited, and the answer is the change's error", async () => {
    const h = harness(failingUpdate());
    const id = await adasSchedule(h);
    const res = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { config: { input: { region: 'us' } } },
      'ben',
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'trigger-update-failed' });
    const read = await h.call('GET', `/v1/schedules/${id}`);
    expect(read.body.owner).toMatchObject({ kind: 'user', id: ADA });
    expect(await h.ownerSets()).toEqual([]);
  });

  test("when the owner can't be put back either, the move stands and is audited", async () => {
    const h = harness(failingUpdate({ putBackFails: true }));
    const id = await adasSchedule(h);
    const res = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { config: { input: { region: 'us' } } },
      'ben',
    );
    expect(res.body.error).toMatchObject({ code: 'trigger-update-failed' });
    const read = await h.call('GET', `/v1/schedules/${id}`);
    expect(read.body.owner).toMatchObject({ kind: 'user', id: BEN });
    expect(docOf((await h.ownerSets())[0])).toMatchObject({
      from: `user:${ADA}`,
      to: `user:${BEN}`,
    });
  });
});

describe("a deployment whose triggers can't change owner", () => {
  const noSetOwner = (registry: TriggerRegistryBinding): TriggerRegistryBinding => {
    const { setOwner: _dropped, ...rest } = registry;
    return rest;
  };

  test("refuses another person's change to what a schedule runs, and makes no change", async () => {
    const h = harness(noSetOwner);
    const id = await adasSchedule(h);
    const res = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { config: { input: { region: 'us' } } },
      'ben',
    );
    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({ code: 'trigger-operation-unsupported' });
    const read = await h.call('GET', `/v1/schedules/${id}`);
    expect(read.body.input).toEqual({ region: 'eu' });
  });

  test("still takes the owner's own change, and another person's label", async () => {
    const h = harness(noSetOwner);
    const id = await adasSchedule(h);
    const own = await h.call('PATCH', `/v1/schedules/${id}`, {
      config: { input: { region: 'us' } },
    });
    expect(own.status).toBe(200);
    const label = await h.call('PATCH', `/v1/schedules/${id}`, { label: 'renamed' }, 'ben');
    expect(label.status).toBe(200);
  });
});

describe('a webhook: whoever changes what it runs becomes its owner', () => {
  async function adasWebhook(h: ReturnType<typeof harness>) {
    const made = await h.call('POST', '/v1/webhooks', webhook());
    expect(made.status).toBe(201);
    expect(made.body.owner).toMatchObject({ kind: 'user', id: ADA });
    return made.body.triggerId as string;
  }

  test.each([
    ['its signing secret', { hmacSecretName: 'acme-hmac-2' }],
    ['its flow version', { flowVersion: '2.0.0' }],
    ['its input', { config: { input: { region: 'us' } } }],
  ])('%s, changed by another person: the editor owns it, audited', async (_what, patch) => {
    const h = harness();
    const id = await adasWebhook(h);
    const res = await h.call('PATCH', `/v1/webhooks/${id}`, patch, 'ben');
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: BEN });
    expect(docOf((await h.ownerSets())[0])).toMatchObject({
      triggerId: id,
      triggerKind: 'webhook',
      from: `user:${ADA}`,
      to: `user:${BEN}`,
      by: `user:${BEN}`,
    });
  });

  test.each([
    ['its label', { label: 'refunds' }],
    ['its rate limit', { rateLimitPerMinute: 30 }],
    ['the same signing secret again', { hmacSecretName: 'acme-hmac' }],
  ])('%s, changed by another person: the owner stays', async (_what, patch) => {
    const h = harness();
    const id = await adasWebhook(h);
    const res = await h.call('PATCH', `/v1/webhooks/${id}`, patch, 'ben');
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: ADA });
    expect(await h.ownerSets()).toEqual([]);
  });
});

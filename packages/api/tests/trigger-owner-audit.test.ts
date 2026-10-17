// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Naming a service account as a trigger's owner is a delegation, and it's
 * recorded: a `trigger-owner-set` audit event names the trigger, the new
 * owner (`to`) and the caller (`by`). A take-over records every time (a
 * plain caller take-over included), with the previous owner (`from`). A
 * plain register — the trigger's own creation, owner = caller — records
 * nothing. Driven through the schedules route; webhooks share the helper.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, ServiceAccountBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ADA = randomUUID() as UserId;
const BOT = randomUUID();
const PROJECT = randomUUID() as ProjectId;
const ADMIN_TOKEN = 'audit-admin';

// A tenant admin (the `scopes` an admin holds): `isTenantAdmin` is true, so
// the caller may read service accounts and the reader-ordered checks apply.
const resolveToken: TokenResolver = async (token) =>
  token === ADMIN_TOKEN ? { tenantId, userId: ADA, scopes: ['tenant-admin'] } : null;

function harness() {
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
    triggerRegistry: createInMemoryTriggerRegistry({ defaultProjectId: PROJECT }),
    serviceAccountBinding,
    auditEvents,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'x-request-id': 'req-owner',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const recorded = async (): Promise<AuditEvent[]> => {
    const page = await auditEvents.query({ tenantId, limit: 50 });
    if (page.kind === 'err') throw new Error(page.error.message);
    return [...page.value.data];
  };
  return { call, recorded };
}

const schedule = (over: Record<string, unknown> = {}) => ({
  flowId: 'acme.nightly',
  flowVersion: '1.0.0',
  projectId: PROJECT,
  config: { cronExpression: '0 2 * * *' },
  ...over,
});

const docOf = (e: AuditEvent | undefined) =>
  (e?.payload as { doc?: Record<string, unknown> } | undefined)?.doc;

describe('delegating a trigger is recorded', () => {
  test('register with runAsServiceAccountId: trigger-owner-set, to the service, by the caller', async () => {
    const h = harness();
    const res = await h.call('POST', '/v1/schedules', schedule({ runAsServiceAccountId: BOT }));
    expect(res.status).toBe(201);
    expect(res.body.owner).toMatchObject({ kind: 'service', id: BOT });

    const events = await h.recorded();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'trigger-owner-set',
      tenantId,
      projectId: PROJECT,
      actor: `user:${ADA}`,
      correlationId: 'req-owner',
      outcome: 'succeeded',
    });
    expect(docOf(events[0])).toMatchObject({
      triggerId: res.body.scheduleId,
      triggerKind: 'cron',
      to: `service:${BOT}`,
      by: `user:${ADA}`,
    });
    expect(docOf(events[0])).not.toHaveProperty('from');
  });

  test('a plain register (owner = caller) records nothing', async () => {
    const h = harness();
    const res = await h.call('POST', '/v1/schedules', schedule());
    expect(res.status).toBe(201);
    expect(res.body.owner).toMatchObject({ kind: 'user', id: ADA });
    expect(await h.recorded()).toEqual([]);
  });
});

describe('every take-over is recorded, with the previous owner', () => {
  test('a take-over to a service account: from the caller, to the service', async () => {
    const h = harness();
    const made = await h.call('POST', '/v1/schedules', schedule());
    expect(made.status).toBe(201);
    const id = made.body.scheduleId as string;

    const taken = await h.call('POST', `/v1/schedules/${id}/owner`, {
      runAsServiceAccountId: BOT,
    });
    expect(taken.status).toBe(200);
    expect(taken.body.owner).toMatchObject({ kind: 'service', id: BOT });

    const events = await h.recorded();
    expect(events.map((e) => e.kind)).toEqual(['trigger-owner-set']);
    expect(docOf(events[0])).toMatchObject({
      triggerId: id,
      triggerKind: 'cron',
      from: `user:${ADA}`,
      to: `service:${BOT}`,
      by: `user:${ADA}`,
    });
  });

  test('a plain caller take-over (no body) is recorded too', async () => {
    const h = harness();
    const made = await h.call('POST', '/v1/schedules', schedule());
    const id = made.body.scheduleId as string;
    const taken = await h.call('POST', `/v1/schedules/${id}/owner`);
    expect(taken.status).toBe(200);
    const events = await h.recorded();
    expect(events.map((e) => e.kind)).toEqual(['trigger-owner-set']);
    expect(docOf(events[0])).toMatchObject({
      from: `user:${ADA}`,
      to: `user:${ADA}`,
    });
  });
});

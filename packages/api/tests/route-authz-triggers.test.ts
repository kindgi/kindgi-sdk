// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Event triggers, webhook triggers and authorization (T243 A): the flow a
 * trigger fires decides who may see or change it (a trigger has no
 * parent tuple of its own). `read` on the flow to list or get it; `write`
 * to pause, resume or unregister it; `write` and `execute` to register
 * it or change it, since it starts runs of the flow. A trigger that isn't
 * there is the handler's 404, with nothing asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver, TriggerRegistryBinding } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-triggers';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const MINE = 'acme.mine';
const THEIRS = 'acme.theirs';

type Kind = 'event' | 'webhook';

function record(kind: Kind, triggerId: string, flowId: string) {
  return {
    kind,
    triggerId,
    tenantId,
    flowId,
    flowVersion: '1.0.0',
    config: kind === 'event' ? { eventKind: 'acme.happened' } : {},
    ...(kind === 'webhook' && { webhookId: randomUUID(), hmacSecretName: 'acme-hmac' }),
    label: null,
    status: 'active',
    lastFiredAt: null,
    createdAt: '2026-10-08T08:00:00.000Z',
    updatedAt: '2026-10-08T08:00:00.000Z',
  };
}

function harness(kind: Kind, grants: readonly string[]) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const rows = [record(kind, 't-mine', MINE), record(kind, 't-theirs', THEIRS)];
  const byId = (id: string) => rows.find((r) => r.triggerId === id) ?? null;
  const ok = (value: unknown) => ({ kind: 'ok', value });
  const triggers = {
    list: async () => ({ data: rows }),
    get: async ({ triggerId }: { triggerId: string }) => byId(triggerId),
    register: async (input: { flowId: string }) => ok(record(kind, 't-new', input.flowId)),
    update: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    pause: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    resume: async ({ triggerId }: { triggerId: string }) => ok(byId(triggerId)),
    unregister: async () => ({ unregistered: true }),
  } as unknown as TriggerRegistryBinding;
  const app = createApp({
    ...createStubAppBindings(),
    triggerRegistry: triggers,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const base = kind === 'event' ? '/v1/event-triggers' : '/v1/webhooks';
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const registerBody = (flowId: string) =>
    kind === 'event'
      ? { flowId, flowVersion: '1.0.0', config: { eventKind: 'acme.happened' } }
      : { flowId, flowVersion: '1.0.0', hmacSecretName: 'acme-hmac' };
  return { call, asked, registerBody };
}

const READ_MINE = `read flow:${MINE}`;
const WRITE_MINE = `write flow:${MINE}`;
const EXECUTE_MINE = `execute flow:${MINE}`;

describe.each([['event'], ['webhook']] as const)('%s triggers: the flow decides', (kind) => {
  test('the list holds only triggers of flows the caller may read', async () => {
    const { call } = harness(kind, [READ_MINE]);
    const res = await call('GET', '');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { triggerId: string }[] }).data.map(
      (t) => t.triggerId,
    );
    expect(ids).toEqual(['t-mine']);
  });

  test('registering needs `write` and `execute` on the flow', async () => {
    const both = harness(kind, [WRITE_MINE, EXECUTE_MINE]);
    expect((await both.call('POST', '', both.registerBody(MINE))).status).toBe(201);
    expect((await both.call('POST', '', both.registerBody(THEIRS))).status).toBe(403);

    const writeOnly = harness(kind, [WRITE_MINE]);
    expect((await writeOnly.call('POST', '', writeOnly.registerBody(MINE))).status).toBe(403);
    expect(writeOnly.asked).toEqual([WRITE_MINE, EXECUTE_MINE]);
  });

  test('reading one needs `read` on its flow', async () => {
    const { call } = harness(kind, [READ_MINE]);
    expect((await call('GET', '/t-mine')).status).toBe(200);
    expect((await call('GET', '/t-theirs')).status).toBe(403);
  });

  test('changing one needs `write` and `execute`; pausing, resuming and unregistering `write`', async () => {
    const writer = harness(kind, [WRITE_MINE]);
    expect((await writer.call('PATCH', '/t-mine', { label: 'x' })).status).toBe(403);
    for (const action of ['pause', 'resume', 'unregister']) {
      expect((await writer.call('POST', `/t-mine/${action}`)).status, action).toBe(200);
      expect((await writer.call('POST', `/t-theirs/${action}`)).status, action).toBe(403);
    }

    const both = harness(kind, [WRITE_MINE, EXECUTE_MINE]);
    expect((await both.call('PATCH', '/t-mine', { label: 'x' })).status).toBe(200);
    expect((await both.call('PATCH', '/t-theirs', { label: 'x' })).status).toBe(403);
  });

  test("a trigger that isn't there is the handler's 404, with nothing asked", async () => {
    const { call, asked } = harness(kind, []);
    expect((await call('GET', '/t-missing')).status).toBe(404);
    expect(asked).toEqual([]);
  });
});

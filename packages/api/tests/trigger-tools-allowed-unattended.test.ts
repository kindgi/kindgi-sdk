// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A webhook's or a schedule's `toolsAllowedUnattended` (`trigger-tools.ts`):
 * the tools whose calls in its runs needn't wait for a person's yes. Only a
 * project admin sets or changes it (register too); each id names a tool the
 * target calls, with no wildcard; a take-over keeps it; every change is
 * audited; and a schedule's new target while it lists any must name it
 * again. Driven through the app, with an authorizer that grants every right
 * but, for one caller, `admin`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { ProjectId, Semver, TenantId, UserId } from '@kindgi/types';

import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';
import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  AgentReleaseBindings,
  FlowRegistryBinding,
  RunHandlerBinding,
  ServiceAccountBinding,
  TokenResolver,
} from '../src/index.js';
import { toolsTargetCanCall, triggerScope } from '../src/routes/trigger-tools.js';

const tenantId = randomUUID() as TenantId;
const ADA = randomUUID() as UserId;
const WRITER = randomUUID() as UserId;
const PROJECT = randomUUID() as ProjectId;
/** A project where no version of `acme.digest` runs. */
const ELSEWHERE = randomUUID() as ProjectId;
const ADMIN_TOKEN = 'tools-admin';
const WRITER_TOKEN = 'tools-writer';
// A shared schedule runs as it; a writer may change anything but what it runs.
const BOT = 'sa-orders';

const resolveToken: TokenResolver = async (token) => {
  if (token === ADMIN_TOKEN) return { tenantId, userId: ADA, scopes: ['tenant-admin'] };
  if (token === WRITER_TOKEN) return { tenantId, userId: WRITER, scopes: [] };
  return null;
};

/** Every right, but `admin` only for Ada. */
function decision(principal: unknown, action: Action, resource: ResourceRef): Decision {
  const actor = (principal as { actor?: { id?: string } }).actor?.id;
  const allowed = action !== 'admin' || actor === ADA;
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

// What each target calls. `acme.orders@1.0.0`: a tool step, a pinned agent,
// a loop body's tool, a fan-out branch and a subflow's tool; at 2.0.0 only
// `acme.refund`. `acme.helper`'s highest calls a tool its pinned version
// doesn't. `acme.digest`'s highest calls `acme.archive`; its 1.0.0, which is
// Latest in PROJECT (`releases`), doesn't.
const tool = (id: string) => ({ id });
const AGENTS: Record<string, Record<string, { tools: { id: string }[] }>> = {
  'acme.weekly': { latest: { tools: [tool('acme.send')] } },
  'acme.helper': {
    '2.0.0': { tools: [tool('acme.lookup')] },
    latest: { tools: [tool('acme.latest-only')] },
  },
  'acme.digest': {
    '1.0.0': { tools: [tool('acme.send')] },
    latest: { tools: [tool('acme.send'), tool('acme.archive')] },
  },
};
const leaf = (id: string, kind: 'tool' | 'agent', ref: string) => ({ id, kind, ref });
const FLOWS: Record<string, Record<string, unknown>> = {
  'acme.orders@1.0.0': {
    pins: { tools: {}, agents: { 'acme.helper': '2.0.0' } },
    nodes: [
      leaf('refund', 'tool', 'acme.refund'),
      leaf('help', 'agent', 'acme.helper'),
      { id: 'each', kind: 'loop', body: { nodes: [leaf('notify', 'tool', 'acme.notify')] } },
      { id: 'fan', kind: 'fanout', branches: [{ id: 'a', handler: 'acme.fan' }] },
      { id: 'sub', kind: 'subgraph', flowRef: { flowId: 'acme.sub', version: '1.0.0' } },
    ],
  },
  'acme.orders@2.0.0': { nodes: [leaf('refund', 'tool', 'acme.refund')] },
  'acme.sub@1.0.0': {
    nodes: [
      leaf('subtool', 'tool', 'acme.sub-tool'),
      // A cycle back to its parent: followed once.
      { id: 'back', kind: 'subgraph', flowRef: { flowId: 'acme.orders', version: '1.0.0' } },
    ],
  },
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

const flowRegistry = {
  get: async ({ flowId }: { flowId: string }) =>
    FLOWS[`${flowId}@1.0.0`] === undefined ? null : { id: flowId, ...FLOWS[`${flowId}@1.0.0`] },
  getVersion: async ({ flowId, version }: { flowId: string; version: string }) => {
    const f = FLOWS[`${flowId}@${version}`];
    return f === undefined ? null : { id: flowId, version, ...f };
  },
} as unknown as FlowRegistryBinding;

/** No pins; `acme.digest`'s Latest is 1.0.0 in PROJECT, and nothing elsewhere. */
const releases = {
  live: { resolve: async () => null, list: async () => [] },
  latest: {
    latest: async ({ agentId, projectId }: { agentId: string; projectId?: ProjectId }) =>
      agentId === 'acme.digest' && projectId === PROJECT ? { version: '1.0.0' as Semver } : null,
    byProject: async () => [],
  },
} as unknown as AgentReleaseBindings;

const serviceAccountBinding = {
  get: async ({ serviceAccountId }: { serviceAccountId: string }) =>
    serviceAccountId === BOT
      ? { serviceAccountId, tenantId, name: 'acme-orders-bot', grants: [], createdAt: '' }
      : null,
} as unknown as ServiceAccountBinding;

function harness(opts: { registries?: boolean; releases?: boolean } = {}) {
  // Every event, in the order written (a query orders same-millisecond
  // events by their random ids).
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
    ...(opts.registries !== false && { agentRegistry, flowRegistry }),
    ...(opts.releases === true && { agentReleases: releases }),
    auditEvents,
    serviceAccountBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (p, action, resource) => decision(p, action, resource),
        checkBatch: async (p, action, resources) =>
          resources.map((resource) => decision(p, action, resource)),
      } satisfies AuthzCheckBinding,
    },
  });
  const call = async (method: string, path: string, body?: unknown, token = ADMIN_TOKEN) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': 'req-tools',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  /** The events of `kind` (default `trigger-tools-allowed-unattended-set`), oldest first. */
  const toolEvents = async (kind = 'trigger-tools-allowed-unattended-set'): Promise<AuditEvent[]> =>
    written.filter((e) => e.kind === kind);
  return { call, toolEvents };
}

const docOf = (e: AuditEvent | undefined) =>
  (e?.payload as { doc?: Record<string, unknown> } | undefined)?.doc;

const flowSchedule = (over: Record<string, unknown> = {}) => ({
  flowId: 'acme.orders',
  flowVersion: '1.0.0',
  projectId: PROJECT,
  config: { cronExpression: '0 2 * * *' },
  ...over,
});
const agentSchedule = (over: Record<string, unknown> = {}) => ({
  agentId: 'acme.digest',
  projectId: PROJECT,
  config: { cronExpression: '0 7 * * 1-5', input: { userMessage: 'The digest.' } },
  ...over,
});
const webhook = (over: Record<string, unknown> = {}) => ({
  flowId: 'acme.orders',
  flowVersion: '1.0.0',
  projectId: PROJECT,
  hmacSecretName: 'acme-hmac',
  ...over,
});

describe('which tools a target calls', () => {
  test("a flow: its tool steps, loop bodies, fan-out branches, its agents' tools at the pin, its subflows' (a cycle followed once)", async () => {
    const tools = await toolsTargetCanCall(
      { agents: agentRegistry, flows: flowRegistry },
      { tenantId },
      {
        kind: 'flow',
        flowId: 'acme.orders',
        flowVersion: '1.0.0',
      } as never,
    );
    expect([...(tools ?? [])].sort()).toEqual([
      'acme.fan',
      'acme.lookup',
      'acme.notify',
      'acme.refund',
      'acme.sub-tool',
    ]);
  });

  test('an agent: at its version, else its highest with no pins or Latest wired; an improvement pass: none; unreadable: undefined', async () => {
    const deps = { agents: agentRegistry, flows: flowRegistry };
    const at = (target: Record<string, unknown>) =>
      toolsTargetCanCall(deps, { tenantId }, target as never).then((s) =>
        s === undefined ? undefined : [...s].sort(),
      );
    expect(await at({ kind: 'agent', agentId: 'acme.digest', agentVersion: '1.0.0' })).toEqual([
      'acme.send',
    ]);
    expect(await at({ kind: 'agent', agentId: 'acme.digest' })).toEqual([
      'acme.archive',
      'acme.send',
    ]);
    expect(await at({ kind: 'improve', agentId: 'acme.digest' })).toEqual([]);
    expect(await at({ kind: 'agent', agentId: 'acme.nobody' })).toBeUndefined();
    expect(
      await toolsTargetCanCall(undefined, { tenantId }, {
        kind: 'flow',
        flowId: 'acme.orders',
        flowVersion: '1.0.0',
      } as never),
    ).toBeUndefined();
  });

  test("with pins and Latest wired, an agent that names no version: what runs in the trigger's project, not its highest", async () => {
    const deps = { agents: agentRegistry, flows: flowRegistry, releases };
    const at = (projectId: ProjectId | undefined, target: Record<string, unknown>) =>
      toolsTargetCanCall(deps, triggerScope(tenantId, projectId), target as never).then((s) =>
        s === undefined ? undefined : [...s].sort(),
      );
    expect(await at(PROJECT, { kind: 'agent', agentId: 'acme.digest' })).toEqual(['acme.send']);
    // A named version is read as named.
    expect(
      await at(PROJECT, { kind: 'agent', agentId: 'acme.digest', agentVersion: '1.0.0' }),
    ).toEqual(['acme.send']);
    // No version runs there (no pin, no Latest), so there's nothing to check against.
    expect(await at(ELSEWHERE, { kind: 'agent', agentId: 'acme.digest' })).toBeUndefined();
  });
});

describe('the field as a body names it', () => {
  test.each([
    ['not a list', 'acme.refund', 'must be a list of tool ids'],
    ['a wildcard', ['acme.*'], "isn't a tool id"],
    ['a pattern', ['acme.[a-z]'], "isn't a tool id"],
    ['whitespace', ['acme refund'], "isn't a tool id"],
    ['an empty id', [''], 'must be a tool id'],
    ['not a string', [7], 'must be a tool id'],
    ['an id twice', ['acme.refund', 'acme.refund'], 'is named twice'],
    ['more than 100', Array.from({ length: 101 }, (_, i) => `acme.t${i}`), 'at most 100'],
  ])('%s: 400, nothing registered', async (_name, value, says) => {
    const h = harness();
    const res = await h.call(
      'POST',
      '/v1/schedules',
      flowSchedule({ toolsAllowedUnattended: value }),
    );
    expect([res.status, res.body.error.code]).toEqual([400, 'bad-input']);
    expect(res.body.error.message).toContain(says);
    expect((await h.call('GET', '/v1/schedules')).body.data).toEqual([]);
  });
});

describe('a schedule', () => {
  test('register by an admin: listed in the record, and audited with the target and no `from`', async () => {
    const h = harness();
    const res = await h.call(
      'POST',
      '/v1/schedules',
      flowSchedule({ toolsAllowedUnattended: ['acme.refund', 'acme.lookup'] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.toolsAllowedUnattended).toEqual(['acme.refund', 'acme.lookup']);
    expect(validateAgainst('ScheduleRecord', res.body)).toEqual([]);
    const got = await h.call('GET', `/v1/schedules/${res.body.scheduleId}`);
    expect(got.body.toolsAllowedUnattended).toEqual(['acme.refund', 'acme.lookup']);

    const events = await h.toolEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId,
      projectId: PROJECT,
      actor: `user:${ADA}`,
      correlationId: 'req-tools',
    });
    expect(docOf(events[0])).toEqual({
      triggerId: res.body.scheduleId,
      triggerKind: 'cron',
      target: { kind: 'flow', id: 'acme.orders', version: '1.0.0' },
      projectId: PROJECT,
      to: ['acme.refund', 'acme.lookup'],
      by: `user:${ADA}`,
      version: 1,
    });
  });

  test('register by a project writer who is no admin: 403 when it names the list, `[]` too; without it, registered', async () => {
    const h = harness();
    for (const list of [['acme.refund'], []]) {
      const res = await h.call(
        'POST',
        '/v1/schedules',
        flowSchedule({ toolsAllowedUnattended: list }),
        WRITER_TOKEN,
      );
      expect(res.status).toBe(403);
    }
    expect((await h.call('POST', '/v1/schedules', flowSchedule(), WRITER_TOKEN)).status).toBe(201);
    expect(await h.toolEvents()).toEqual([]);
  });

  test('`[]` at register: no list on the record, nothing audited', async () => {
    const h = harness();
    const res = await h.call('POST', '/v1/schedules', flowSchedule({ toolsAllowedUnattended: [] }));
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('toolsAllowedUnattended');
    expect(await h.toolEvents()).toEqual([]);
  });

  test('an id the target never calls: 400 naming it (a typo lifts nothing, so it is refused)', async () => {
    const h = harness();
    const res = await h.call(
      'POST',
      '/v1/schedules',
      flowSchedule({ toolsAllowedUnattended: ['acme.refund', 'acme.refnud'] }),
    );
    expect([res.status, res.body.error.code]).toEqual([400, 'bad-input']);
    expect(res.body.error.message).toContain('"acme.refnud"');
    expect(res.body.error.message).not.toContain('"acme.refund"');
    // An agent's highest calls `acme.archive`; its 1.0.0 doesn't.
    const pinned = await h.call(
      'POST',
      '/v1/schedules',
      agentSchedule({ agentVersion: '1.0.0', toolsAllowedUnattended: ['acme.archive'] }),
    );
    expect(pinned.status).toBe(400);
    const latest = await h.call(
      'POST',
      '/v1/schedules',
      agentSchedule({ toolsAllowedUnattended: ['acme.archive'] }),
    );
    expect(latest.status).toBe(201);
  });

  test("with pins and Latest wired: an agent's list is checked against what runs in the schedule's project", async () => {
    const h = harness({ releases: true });
    // 1.0.0 is Latest in PROJECT: the highest's `acme.archive` isn't called there.
    const res = await h.call(
      'POST',
      '/v1/schedules',
      agentSchedule({ toolsAllowedUnattended: ['acme.archive'] }),
    );
    expect([res.status, res.body.error.code]).toEqual([400, 'bad-input']);
    expect(res.body.error.message).toContain(`doesn't call "acme.archive"`);
    const sent = await h.call(
      'POST',
      '/v1/schedules',
      agentSchedule({ toolsAllowedUnattended: ['acme.send'] }),
    );
    expect(sent.status).toBe(201);
  });

  test("with no registry to read the target: a list is refused, `[]` isn't", async () => {
    const h = harness({ registries: false });
    const res = await h.call(
      'POST',
      '/v1/schedules',
      flowSchedule({ toolsAllowedUnattended: ['acme.refund'] }),
    );
    expect([res.status, res.body.error.code]).toEqual([400, 'bad-input']);
    expect(res.body.error.message).toContain("can't read");
    expect(
      (await h.call('POST', '/v1/schedules', flowSchedule({ toolsAllowedUnattended: [] }))).status,
    ).toBe(201);
  });

  test('an improvement pass calls no tools: only `[]`', async () => {
    const h = harness();
    const improve = {
      improve: { agentId: 'acme.digest', scope: { kind: 'project', projectId: PROJECT } },
      config: { cronExpression: '0 3 * * *' },
    };
    const listed = await h.call('POST', '/v1/schedules', {
      ...improve,
      toolsAllowedUnattended: ['acme.send'],
    });
    expect([listed.status, listed.body.error.message]).toEqual([
      400,
      'an improvement pass calls no tools: its `toolsAllowedUnattended` can only be empty',
    ]);
    expect(
      (await h.call('POST', '/v1/schedules', { ...improve, toolsAllowedUnattended: [] })).status,
    ).toBe(201);
  });

  test('update: absent keeps it; a change is admin-only, checked and audited from → to; the same list is not audited', async () => {
    const h = harness();
    // Shared, so a writer may change its label.
    const made = await h.call(
      'POST',
      '/v1/schedules',
      flowSchedule({ toolsAllowedUnattended: ['acme.refund'], runAsServiceAccountId: BOT }),
    );
    const id = made.body.scheduleId as string;

    const label = await h.call('PATCH', `/v1/schedules/${id}`, { label: 'nightly' }, WRITER_TOKEN);
    expect(label.status).toBe(200);
    expect(label.body.toolsAllowedUnattended).toEqual(['acme.refund']);

    const byWriter = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { toolsAllowedUnattended: [] },
      WRITER_TOKEN,
    );
    expect(byWriter.status).toBe(403);

    const uncallable = await h.call('PATCH', `/v1/schedules/${id}`, {
      toolsAllowedUnattended: ['acme.send'],
    });
    expect(uncallable.status).toBe(400);

    const same = await h.call('PATCH', `/v1/schedules/${id}`, {
      toolsAllowedUnattended: ['acme.refund'],
    });
    expect(same.status).toBe(200);
    expect(await h.toolEvents()).toHaveLength(1);

    const changed = await h.call('PATCH', `/v1/schedules/${id}`, {
      toolsAllowedUnattended: ['acme.notify', 'acme.refund'],
    });
    expect(changed.body.toolsAllowedUnattended).toEqual(['acme.notify', 'acme.refund']);
    const cleared = await h.call('PATCH', `/v1/schedules/${id}`, { toolsAllowedUnattended: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body).not.toHaveProperty('toolsAllowedUnattended');

    // Each names the version it made: the label's edit made the second.
    const docs = (await h.toolEvents()).map(docOf);
    expect(docs.map((d) => [d?.from, d?.to, d?.version])).toEqual([
      [undefined, ['acme.refund'], 1],
      [['acme.refund'], ['acme.notify', 'acme.refund'], 3],
      [['acme.notify', 'acme.refund'], [], 4],
    ]);
  });

  test('the same tools in another order: no change, so no version and nothing audited', async () => {
    const h = harness();
    const made = await h.call(
      'POST',
      '/v1/schedules',
      flowSchedule({ toolsAllowedUnattended: ['acme.notify', 'acme.refund'] }),
    );
    const id = made.body.scheduleId as string;
    const reordered = await h.call('PATCH', `/v1/schedules/${id}`, {
      toolsAllowedUnattended: ['acme.refund', 'acme.notify'],
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.version).toBe(1);
    expect(reordered.body.toolsAllowedUnattended).toEqual(['acme.notify', 'acme.refund']);
    expect(await h.toolEvents()).toHaveLength(1);
  });

  test('a new target while it lists any: 400 naming the kept ids unless the body names it again; a version alone keeps it', async () => {
    const h = harness();
    const made = await h.call(
      'POST',
      '/v1/schedules',
      agentSchedule({ agentVersion: '1.0.0', toolsAllowedUnattended: ['acme.send'] }),
    );
    const id = made.body.scheduleId as string;
    expect(await h.toolEvents()).toHaveLength(1);

    // A version alone: kept, nothing audited.
    const bumped = await h.call('PATCH', `/v1/schedules/${id}`, {
      agentId: 'acme.digest',
      agentVersion: '2.0.0',
    });
    expect(bumped.status).toBe(200);
    expect(bumped.body.toolsAllowedUnattended).toEqual(['acme.send']);
    expect(await h.toolEvents()).toHaveLength(1);

    // Another target, the field left out: refused, the schedule unchanged.
    const silent = await h.call('PATCH', `/v1/schedules/${id}`, {
      flowId: 'acme.orders',
      flowVersion: '1.0.0',
      config: { input: {} },
    });
    expect([silent.status, silent.body.error.code]).toEqual([400, 'bad-input']);
    expect(silent.body.error.message).toContain('"acme.send"');
    expect(silent.body.error.message).toContain('a new target must name it again');
    expect((await h.call('GET', `/v1/schedules/${id}`)).body.agentId).toBe('acme.digest');

    // A writer can't name it, so can't retarget it at all while it lists any.
    const byWriter = await h.call(
      'PATCH',
      `/v1/schedules/${id}`,
      { flowId: 'acme.orders', flowVersion: '1.0.0', toolsAllowedUnattended: [] },
      WRITER_TOKEN,
    );
    expect(byWriter.status).toBe(403);

    // The kept list, checked against the new target: the flow never calls it.
    const kept = await h.call('PATCH', `/v1/schedules/${id}`, {
      flowId: 'acme.orders',
      flowVersion: '1.0.0',
      toolsAllowedUnattended: ['acme.send'],
    });
    expect(kept.status).toBe(400);
    expect(kept.body.error.message).toContain('doesn\'t call "acme.send"');

    // Named for the new target: retargeted, audited with the new target.
    const moved = await h.call('PATCH', `/v1/schedules/${id}`, {
      flowId: 'acme.orders',
      flowVersion: '1.0.0',
      toolsAllowedUnattended: ['acme.refund'],
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      flowId: 'acme.orders',
      toolsAllowedUnattended: ['acme.refund'],
    });
    const last = docOf((await h.toolEvents()).at(-1));
    expect(last).toMatchObject({
      from: ['acme.send'],
      to: ['acme.refund'],
      target: { kind: 'flow', id: 'acme.orders', version: '1.0.0' },
    });
  });

  test('a new target naming the same list again is audited (an admin chose it for what the schedule now runs)', async () => {
    const h = harness();
    const made = await h.call(
      'POST',
      '/v1/schedules',
      agentSchedule({ toolsAllowedUnattended: ['acme.send'] }),
    );
    const id = made.body.scheduleId as string;
    const moved = await h.call('PATCH', `/v1/schedules/${id}`, {
      agentId: 'acme.weekly',
      toolsAllowedUnattended: ['acme.send'],
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      agentId: 'acme.weekly',
      toolsAllowedUnattended: ['acme.send'],
    });
    expect(docOf((await h.toolEvents()).at(-1))).toMatchObject({
      from: ['acme.send'],
      to: ['acme.send'],
      target: { kind: 'agent', id: 'acme.weekly' },
    });
    // `[]` named again on yet another target, from `[]`: no change, nothing audited.
    await h.call('PATCH', `/v1/schedules/${id}`, { toolsAllowedUnattended: [] });
    const before = (await h.toolEvents()).length;
    const again = await h.call('PATCH', `/v1/schedules/${id}`, {
      agentId: 'acme.digest',
      toolsAllowedUnattended: [],
    });
    expect(again.status).toBe(200);
    expect(await h.toolEvents()).toHaveLength(before);
  });

  test('with no list, a new target needs nothing', async () => {
    const h = harness();
    const made = await h.call('POST', '/v1/schedules', agentSchedule(), WRITER_TOKEN);
    const moved = await h.call(
      'PATCH',
      `/v1/schedules/${made.body.scheduleId}`,
      { flowId: 'acme.orders', flowVersion: '1.0.0', config: { input: {} } },
      WRITER_TOKEN,
    );
    expect(moved.status).toBe(200);
  });

  test('a take-over keeps it, records it on `trigger-owner-set`, and refuses a body naming it', async () => {
    const h = harness();
    const made = await h.call(
      'POST',
      '/v1/schedules',
      flowSchedule({ toolsAllowedUnattended: ['acme.refund'] }),
    );
    const id = made.body.scheduleId as string;
    const named = await h.call('POST', `/v1/schedules/${id}/owner`, {
      toolsAllowedUnattended: [],
    });
    expect([named.status, named.body.error.code]).toEqual([400, 'bad-input']);
    expect(named.body.error.message).toContain('change it with PATCH');

    const taken = await h.call('POST', `/v1/schedules/${id}/owner`);
    expect(taken.status).toBe(200);
    expect(taken.body.toolsAllowedUnattended).toEqual(['acme.refund']);
    const owned = await h.toolEvents('trigger-owner-set');
    expect(docOf(owned.at(-1))).toMatchObject({
      triggerId: id,
      toolsAllowedUnattended: ['acme.refund'],
    });
    // The take-over changed no list: nothing more on the list's own kind.
    expect(await h.toolEvents()).toHaveLength(1);
  });
});

describe('a webhook trigger', () => {
  test('register by an admin: listed and audited; by a writer naming it: 403', async () => {
    const h = harness();
    const res = await h.call(
      'POST',
      '/v1/webhooks',
      webhook({ toolsAllowedUnattended: ['acme.sub-tool'] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.toolsAllowedUnattended).toEqual(['acme.sub-tool']);
    expect(validateAgainst('WebhookTriggerRecord', res.body)).toEqual([]);
    expect(docOf((await h.toolEvents())[0])).toEqual({
      triggerId: res.body.triggerId,
      triggerKind: 'webhook',
      target: { kind: 'flow', id: 'acme.orders', version: '1.0.0' },
      projectId: PROJECT,
      to: ['acme.sub-tool'],
      by: `user:${ADA}`,
      version: 1,
    });

    const byWriter = await h.call(
      'POST',
      '/v1/webhooks',
      webhook({ toolsAllowedUnattended: [] }),
      WRITER_TOKEN,
    );
    expect(byWriter.status).toBe(403);
    expect(await h.toolEvents()).toHaveLength(1);
  });

  test('the same tools in another order: no change, so no version and nothing audited', async () => {
    const h = harness();
    const made = await h.call(
      'POST',
      '/v1/webhooks',
      webhook({ toolsAllowedUnattended: ['acme.notify', 'acme.refund'] }),
    );
    const id = made.body.triggerId as string;
    const reordered = await h.call('PATCH', `/v1/webhooks/${id}`, {
      toolsAllowedUnattended: ['acme.refund', 'acme.notify'],
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.version).toBe(1);
    expect(reordered.body.toolsAllowedUnattended).toEqual(['acme.notify', 'acme.refund']);
    expect(await h.toolEvents()).toHaveLength(1);
  });

  test('a new flow version keeps it; naming it checks it against that version', async () => {
    const h = harness();
    const made = await h.call(
      'POST',
      '/v1/webhooks',
      webhook({ toolsAllowedUnattended: ['acme.refund', 'acme.notify'] }),
    );
    const id = made.body.triggerId as string;

    const notAtV2 = await h.call('PATCH', `/v1/webhooks/${id}`, {
      flowVersion: '2.0.0',
      toolsAllowedUnattended: ['acme.refund', 'acme.notify'],
    });
    expect(notAtV2.status).toBe(400);
    expect(notAtV2.body.error.message).toContain('doesn\'t call "acme.notify"');

    const bumped = await h.call('PATCH', `/v1/webhooks/${id}`, { flowVersion: '2.0.0' });
    expect(bumped.status).toBe(200);
    expect(bumped.body.toolsAllowedUnattended).toEqual(['acme.refund', 'acme.notify']);

    const trimmed = await h.call(
      'PATCH',
      `/v1/webhooks/${id}`,
      { toolsAllowedUnattended: ['acme.refund'] },
      WRITER_TOKEN,
    );
    expect(trimmed.status).toBe(403);
    const byAdmin = await h.call('PATCH', `/v1/webhooks/${id}`, {
      toolsAllowedUnattended: ['acme.refund'],
    });
    expect(byAdmin.body.toolsAllowedUnattended).toEqual(['acme.refund']);
    expect(docOf((await h.toolEvents()).at(-1))).toMatchObject({
      from: ['acme.refund', 'acme.notify'],
      to: ['acme.refund'],
      target: { kind: 'flow', id: 'acme.orders', version: '2.0.0' },
    });
  });

  test('a take-over keeps it and refuses a body naming it', async () => {
    const h = harness();
    const made = await h.call(
      'POST',
      '/v1/webhooks',
      webhook({ toolsAllowedUnattended: ['acme.refund'] }),
    );
    const id = made.body.triggerId as string;
    const named = await h.call('POST', `/v1/webhooks/${id}/owner`, {
      toolsAllowedUnattended: ['acme.refund'],
    });
    expect(named.status).toBe(400);
    const taken = await h.call('POST', `/v1/webhooks/${id}/owner`);
    expect(taken.status).toBe(200);
    expect(taken.body.toolsAllowedUnattended).toEqual(['acme.refund']);
    expect(docOf((await h.toolEvents('trigger-owner-set')).at(-1))).toMatchObject({
      triggerId: id,
      triggerKind: 'webhook',
      toolsAllowedUnattended: ['acme.refund'],
    });
  });
});

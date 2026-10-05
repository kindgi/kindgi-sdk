// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/judgments` and `/v1/judge-classes`: judging an item of a finished
 * run, supersede, list filters, removal, and the judge-class CRUD.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { KernelRunRecord, RunAgentRef, RunBinding } from '@kindgi/runtime';
import type { ConversationId, ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  JudgeClass,
  JudgedRunCopy,
  Judgment,
  JudgmentRegistryBinding,
  JudgmentWithCopies,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { judgeClassApplies } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectA = randomUUID() as ProjectId;
const projectB = randomUUID() as ProjectId;
const USER_TOKEN = 'judgments-user-token';
const KEY_TOKEN = 'judgments-key-token';

const resolveToken: TokenResolver = async (token) => {
  if (token === USER_TOKEN) return { tenantId, userId: 'user-1' as UserId };
  if (token === KEY_TOKEN) return { tenantId, tokenId: 'key-1' as never };
  return null;
};

const runHandler = {} as RunHandlerBinding;

const agentRef = (version: string): RunAgentRef => ({
  id: 'acme.matcher',
  version,
  conversationId: randomUUID() as ConversationId,
});

function row(overrides: Partial<KernelRunRecord> = {}): KernelRunRecord {
  const at = '2026-09-30T00:00:00.000Z' as Timestamp;
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId: projectA,
    flowId: 'acme.match',
    flowVersion: '1.0.0',
    status: 'completed',
    input: { query: 'acme' },
    output: { matches: [{ id: 'c1' }, { id: 'c2' }] },
    dryRun: false,
    createdAt: at,
    updatedAt: at,
    agent: agentRef('2.0.0'),
    ...overrides,
  };
}

/** In-memory `JudgmentRegistryBinding` honouring supersede and one run copy per run. */
function inMemoryBinding(): JudgmentRegistryBinding {
  const classes: JudgeClass[] = [];
  const judgments: Judgment[] = [];
  const copies = new Map<string, JudgedRunCopy>();
  const itemValues = new Map<string, unknown>();
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 9, 1, 0, 0, seq++)).toISOString();
  const sameScope = (a: JudgeClass['scope'], b: JudgeClass['scope']) =>
    JSON.stringify(a) === JSON.stringify(b);
  const page = <T>(rows: readonly T[], limit: number) => ({
    data: rows.slice(0, limit),
    hasMore: rows.length > limit,
  });

  return {
    async createClass(input) {
      const taken = classes.some(
        (k) =>
          k.unregisteredAt === undefined &&
          k.name === input.name &&
          sameScope(k.scope, input.scope),
      );
      if (taken) return { kind: 'name-taken' };
      const at = now();
      const judgeClass: JudgeClass = {
        id: `jc-${classes.length + 1}`,
        tenantId: input.tenantId,
        scope: input.scope,
        name: input.name,
        weight: input.weight,
        ...(input.description !== undefined && { description: input.description }),
        createdAt: at,
        updatedAt: at,
      };
      classes.push(judgeClass);
      return { kind: 'created', judgeClass };
    },
    async listClasses(input) {
      const rows = classes
        .filter((k) => k.unregisteredAt === undefined)
        .filter((k) => input.scope === undefined || sameScope(k.scope, input.scope))
        .reverse();
      return page(rows, input.limit);
    },
    async getClass(input) {
      const k = classes.find((c) => c.id === input.judgeClassId) ?? null;
      if (k === null) return null;
      return k.unregisteredAt !== undefined && input.includeUnregistered !== true ? null : k;
    },
    async updateClass(input) {
      const i = classes.findIndex(
        (c) => c.id === input.judgeClassId && c.unregisteredAt === undefined,
      );
      const current = classes[i];
      if (current === undefined) return null;
      const next: JudgeClass = {
        ...current,
        ...(input.weight !== undefined && { weight: input.weight }),
        ...(input.description !== undefined && { description: input.description }),
        updatedAt: now(),
      };
      classes[i] = next;
      return next;
    },
    async unregisterClass(input) {
      const i = classes.findIndex(
        (c) => c.id === input.judgeClassId && c.unregisteredAt === undefined,
      );
      const current = classes[i];
      if (current === undefined) return { unregistered: false };
      classes[i] = { ...current, unregisteredAt: now() };
      return { unregistered: true };
    },

    async record(input) {
      const id = `j-${judgments.length + 1}`;
      if (!copies.has(input.runId)) {
        copies.set(input.runId, {
          runId: input.runId,
          subject: input.run.subject,
          input: input.run.input,
          output: input.run.output,
          capturedAt: now(),
        });
      }
      for (let i = 0; i < judgments.length; i++) {
        const j = judgments[i] as Judgment;
        if (
          j.unregisteredAt === undefined &&
          j.runId === input.runId &&
          j.item.key === input.item.key &&
          j.assertedBy.kind === input.assertedBy.kind &&
          j.assertedBy.id === input.assertedBy.id &&
          j.participantId === input.participantId
        ) {
          judgments[i] = { ...j, unregisteredAt: now(), supersededBy: id };
        }
      }
      const judgment: Judgment = {
        id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        runId: input.runId,
        subject: input.run.subject,
        item: input.item,
        verdict: input.verdict,
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.judgeClassId !== undefined && { judgeClassId: input.judgeClassId }),
        assertedBy: input.assertedBy,
        ...(input.participantId !== undefined && { participantId: input.participantId }),
        createdAt: now(),
      };
      judgments.push(judgment);
      if (input.itemValue !== undefined) itemValues.set(id, input.itemValue);
      return judgment;
    },
    async list(input) {
      const rows = judgments
        .filter((j) => j.unregisteredAt === undefined)
        .filter((j) => input.runId === undefined || j.runId === input.runId)
        .filter(
          (j) =>
            input.agentId === undefined ||
            (j.subject.kind === 'agent' && j.subject.id === input.agentId),
        )
        .filter((j) => input.agentVersion === undefined || j.subject.version === input.agentVersion)
        .filter(
          (j) =>
            input.flowId === undefined ||
            (j.subject.kind === 'flow' && j.subject.id === input.flowId),
        )
        .filter((j) => input.verdict === undefined || j.verdict === input.verdict)
        .filter((j) => input.judgeClassId === undefined || j.judgeClassId === input.judgeClassId)
        .filter((j) => input.participantId === undefined || j.participantId === input.participantId)
        .filter(
          (j) =>
            input.scope === undefined ||
            input.scope.kind !== 'project' ||
            j.projectId === input.scope.projectId,
        )
        .reverse();
      return page(rows, input.limit);
    },
    async get(input): Promise<JudgmentWithCopies | null> {
      const j = judgments.find((x) => x.id === input.judgmentId);
      if (j === undefined) return null;
      const run = copies.get(j.runId) as JudgedRunCopy;
      return {
        ...j,
        run,
        ...(itemValues.has(j.id) && { itemValue: itemValues.get(j.id) }),
      };
    },
    async unregister(input) {
      const i = judgments.findIndex(
        (x) => x.id === input.judgmentId && x.unregisteredAt === undefined,
      );
      const current = judgments[i];
      if (current === undefined) return { unregistered: false };
      judgments[i] = { ...current, unregisteredAt: now() };
      return { unregistered: true };
    },
  };
}

interface Harness {
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ) => Promise<{ readonly status: number; readonly body: Record<string, any> }>;
  readonly binding: JudgmentRegistryBinding;
}

function harness(rows: KernelRunRecord[]): Harness {
  const binding = inMemoryBinding();
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) => rows.find((r) => r.runId === id) ?? null,
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler,
    judgmentRegistry: binding,
  });
  const call: Harness['call'] = async (method, path, body, token = USER_TOKEN) => {
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
  return { call, binding };
}

async function tenantClass(h: Harness, name = 'expert', weight = 3): Promise<string> {
  const res = await h.call('POST', '/v1/judge-classes', {
    scope: { kind: 'tenant' },
    name,
    weight,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('POST /v1/judgments', () => {
  test('with a pointer: stores the item value and the run copy', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);

    const res = await h.call('POST', '/v1/judgments', {
      runId: run.runId,
      item: { key: 'c2', pointer: '/matches/1', rank: 1 },
      verdict: 'yes',
      reason: 'Right company.',
      judgeClassId: classId,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      runId: run.runId,
      projectId: projectA,
      subject: { kind: 'agent', id: 'acme.matcher', version: '2.0.0' },
      item: { key: 'c2', pointer: '/matches/1', rank: 1 },
      verdict: 'yes',
      reason: 'Right company.',
      judgeClassId: classId,
    });

    const got = await h.call('GET', `/v1/judgments/${res.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.itemValue).toEqual({ id: 'c2' });
    expect(got.body.run).toMatchObject({
      runId: run.runId,
      input: { query: 'acme' },
      output: { matches: [{ id: 'c1' }, { id: 'c2' }] },
    });
  });

  test('a run that has not finished: 409 run-not-finished', async () => {
    const run = row({ status: 'running', output: undefined });
    const h = harness([run]);
    const classId = await tenantClass(h);
    const res = await h.call('POST', '/v1/judgments', {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'no',
      judgeClassId: classId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('run-not-finished');
  });

  test('an unknown run: 404 run-not-found', async () => {
    const h = harness([]);
    const classId = await tenantClass(h);
    const res = await h.call('POST', '/v1/judgments', {
      runId: randomUUID(),
      item: { key: 'c1' },
      verdict: 'no',
      judgeClassId: classId,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('run-not-found');
  });

  test('a pointer to nothing: 400 item-not-found', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const res = await h.call('POST', '/v1/judgments', {
      runId: run.runId,
      item: { key: 'c9', pointer: '/matches/9' },
      verdict: 'yes',
      judgeClassId: classId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('item-not-found');
  });

  test("a project class on another project's run: 400 judge-class-not-applicable", async () => {
    const run = row({ projectId: projectA });
    const h = harness([run]);
    const created = await h.call('POST', '/v1/judge-classes', {
      scope: { kind: 'project', projectId: projectB },
      name: 'expert',
      weight: 1,
    });
    const res = await h.call('POST', '/v1/judgments', {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
      judgeClassId: created.body.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('judge-class-not-applicable');
  });

  test('a malformed body: 400 bad-input', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    for (const body of [
      { runId: run.runId, item: { key: 'c1' }, verdict: 'maybe', judgeClassId: classId },
      { runId: run.runId, item: {}, verdict: 'yes', judgeClassId: classId },
      {
        runId: run.runId,
        item: { key: 'c1', pointer: 'matches' },
        verdict: 'yes',
        judgeClassId: classId,
      },
    ]) {
      const res = await h.call('POST', '/v1/judgments', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad-input');
    }
  });

  test('judging again supersedes: one live judgment, the old one kept as history', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const body = { runId: run.runId, item: { key: 'c1' }, judgeClassId: classId };
    const first = await h.call('POST', '/v1/judgments', { ...body, verdict: 'yes' });
    const second = await h.call('POST', '/v1/judgments', { ...body, verdict: 'no' });
    expect(second.status).toBe(201);

    const live = await h.call('GET', `/v1/judgments?runId=${run.runId}`);
    expect(live.body.data.map((j: { id: string }) => j.id)).toEqual([second.body.id]);

    const old = await h.call('GET', `/v1/judgments/${first.body.id}`);
    expect(old.body.supersededBy).toBe(second.body.id);
    expect(old.body.unregisteredAt).toBeTypeOf('string');
  });

  test('without a judge class: recorded unclassified, no judgeClassId on the wire', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/judgments', {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('judgeClassId');
    const got = await h.call('GET', `/v1/judgments/${res.body.id}`);
    expect(got.body).not.toHaveProperty('judgeClassId');
  });

  test('a judge class that does not exist: 400 judge-class-not-applicable', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/judgments', {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
      judgeClassId: 'jc-missing',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('judge-class-not-applicable');
  });

  test('a different participant does not supersede', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const body = { runId: run.runId, item: { key: 'c1' }, judgeClassId: classId, verdict: 'yes' };
    await h.call('POST', '/v1/judgments', { ...body, participantId: 'end-user-1' });
    await h.call('POST', '/v1/judgments', { ...body, participantId: 'end-user-2' });
    const live = await h.call('GET', `/v1/judgments?runId=${run.runId}`);
    expect(live.body.data).toHaveLength(2);
  });

  test('assertedBy comes from the principal, never the body', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const body = {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
      judgeClassId: classId,
      assertedBy: { kind: 'user', id: 'someone-else' },
    };
    const asUser = await h.call('POST', '/v1/judgments', body, USER_TOKEN);
    expect(asUser.body.assertedBy).toEqual({ kind: 'user', id: 'user-1' });
    const asKey = await h.call('POST', '/v1/judgments', body, KEY_TOKEN);
    expect(asKey.body.assertedBy).toEqual({ kind: 'service', id: 'key-1' });
  });
});

describe('GET /v1/judgments', () => {
  test('filters by run, agent and version, and verdict', async () => {
    const r1 = row();
    const r2 = row({ agent: agentRef('3.0.0') });
    const { agent: _agent, ...flowRun } = row({ flowId: 'acme.other' });
    const r3: KernelRunRecord = flowRun;
    const h = harness([r1, r2, r3]);
    const classId = await tenantClass(h);
    const judge = (run: KernelRunRecord, key: string, verdict: 'yes' | 'no') =>
      h.call('POST', '/v1/judgments', {
        runId: run.runId,
        item: { key },
        verdict,
        judgeClassId: classId,
      });
    await judge(r1, 'a', 'yes');
    await judge(r1, 'b', 'no');
    await judge(r2, 'a', 'yes');
    await judge(r3, 'a', 'no');

    const list = async (qs: string) =>
      (await h.call('GET', `/v1/judgments?${qs}`)).body.data as {
        runId: string;
        verdict: string;
      }[];

    expect(await list(`runId=${r1.runId}`)).toHaveLength(2);
    expect(await list('agentId=acme.matcher')).toHaveLength(3);
    const v3 = await list('agentId=acme.matcher&agentVersion=3.0.0');
    expect(v3.map((j) => j.runId)).toEqual([r2.runId]);
    expect(await list('verdict=no')).toHaveLength(2);
    expect(await list('flowId=acme.other')).toHaveLength(1);
    expect(await list(`judgeClassId=${classId}`)).toHaveLength(4);
  });

  test('agentVersion without agentId, or an unknown verdict: 400', async () => {
    const h = harness([]);
    const a = await h.call('GET', '/v1/judgments?agentVersion=1.0.0');
    expect(a.status).toBe(400);
    const b = await h.call('GET', '/v1/judgments?verdict=maybe');
    expect(b.status).toBe(400);
  });

  test('pages with limit and nextCursor fields on the wire shape', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    for (const key of ['a', 'b', 'c']) {
      await h.call('POST', '/v1/judgments', {
        runId: run.runId,
        item: { key },
        verdict: 'yes',
        judgeClassId: classId,
      });
    }
    const page = await h.call('GET', '/v1/judgments?limit=2');
    expect(page.body.data).toHaveLength(2);
    expect(page.body.hasMore).toBe(true);
  });
});

describe('POST /v1/judgments/:id/unregister', () => {
  test('removes the judgment; it stops listing and a second removal is 404', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const made = await h.call('POST', '/v1/judgments', {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
      judgeClassId: classId,
    });
    const gone = await h.call('POST', `/v1/judgments/${made.body.id}/unregister`, {});
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ judgmentId: made.body.id, unregistered: true });

    expect((await h.call('GET', '/v1/judgments')).body.data).toHaveLength(0);
    const again = await h.call('POST', `/v1/judgments/${made.body.id}/unregister`, {});
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('judgment-not-found');
  });

  test('an unknown judgment: 404 on get and unregister', async () => {
    const h = harness([]);
    expect((await h.call('GET', '/v1/judgments/nope')).status).toBe(404);
    expect((await h.call('POST', '/v1/judgments/nope/unregister', {})).status).toBe(404);
  });
});

describe('/v1/judge-classes', () => {
  test('create, get, list, update, unregister', async () => {
    const h = harness([]);
    const created = await h.call('POST', '/v1/judge-classes', {
      scope: { kind: 'tenant' },
      name: 'expert',
      weight: 3,
      description: 'Domain experts.',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      tenantId,
      scope: { kind: 'tenant' },
      name: 'expert',
      weight: 3,
      description: 'Domain experts.',
    });
    const id = created.body.id as string;

    expect((await h.call('GET', `/v1/judge-classes/${id}`)).body.name).toBe('expert');
    expect((await h.call('GET', '/v1/judge-classes')).body.data).toHaveLength(1);

    const patched = await h.call('PATCH', `/v1/judge-classes/${id}`, { weight: 5 });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ weight: 5, description: 'Domain experts.' });

    const gone = await h.call('POST', `/v1/judge-classes/${id}/unregister`, {});
    expect(gone.body).toEqual({ judgeClassId: id, unregistered: true });
    expect((await h.call('GET', '/v1/judge-classes')).body.data).toHaveLength(0);
    // A retired class stays readable, but cannot be changed or retired again.
    const retired = await h.call('GET', `/v1/judge-classes/${id}`);
    expect(retired.status).toBe(200);
    expect(retired.body.unregisteredAt).toBeTypeOf('string');
    expect((await h.call('PATCH', `/v1/judge-classes/${id}`, { weight: 1 })).status).toBe(404);
    expect((await h.call('POST', `/v1/judge-classes/${id}/unregister`, {})).status).toBe(404);
  });

  test('the same name twice in one scope: 409 judge-class-name-taken', async () => {
    const h = harness([]);
    await tenantClass(h, 'expert');
    const dup = await h.call('POST', '/v1/judge-classes', {
      scope: { kind: 'tenant' },
      name: 'expert',
      weight: 1,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('judge-class-name-taken');
    // The same name in another scope is fine.
    const other = await h.call('POST', '/v1/judge-classes', {
      scope: { kind: 'project', projectId: projectA },
      name: 'expert',
      weight: 1,
    });
    expect(other.status).toBe(201);
  });

  test('list narrows by scope; an incomplete scope is 400', async () => {
    const h = harness([]);
    await tenantClass(h, 'expert');
    await h.call('POST', '/v1/judge-classes', {
      scope: { kind: 'agent', projectId: projectA, agentId: 'acme.matcher' },
      name: 'user',
      weight: 1,
    });
    const tenantOnly = await h.call('GET', '/v1/judge-classes?scopeKind=tenant');
    expect(tenantOnly.body.data.map((k: { name: string }) => k.name)).toEqual(['expert']);
    const agent = await h.call(
      'GET',
      `/v1/judge-classes?scopeKind=agent&projectId=${projectA}&agentId=acme.matcher`,
    );
    expect(agent.body.data.map((k: { name: string }) => k.name)).toEqual(['user']);
    expect((await h.call('GET', '/v1/judge-classes?scopeKind=agent')).status).toBe(400);
  });

  test('bad bodies: 400 bad-input; unknown class: 404', async () => {
    const h = harness([]);
    for (const body of [
      { scope: { kind: 'tenant' }, name: 'x', weight: -1 },
      { scope: { kind: 'tenant' }, name: '', weight: 1 },
      { scope: { kind: 'project' }, name: 'x', weight: 1 },
      { name: 'x', weight: 1 },
    ]) {
      const res = await h.call('POST', '/v1/judge-classes', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad-input');
    }
    expect((await h.call('PATCH', '/v1/judge-classes/nope', { weight: 1 })).status).toBe(404);
    expect((await h.call('PATCH', '/v1/judge-classes/nope', {})).status).toBe(400);
    expect((await h.call('GET', '/v1/judge-classes/nope')).status).toBe(404);
  });
});

describe('judgeClassApplies', () => {
  const subject = { kind: 'agent', id: 'acme.matcher', version: '1.0.0' } as const;
  test('tenant covers everything; project and agent cover their own', () => {
    const run = { projectId: projectA, subject };
    expect(judgeClassApplies({ kind: 'tenant' }, run)).toBe(true);
    expect(judgeClassApplies({ kind: 'project', projectId: projectA }, run)).toBe(true);
    expect(judgeClassApplies({ kind: 'project', projectId: projectB }, run)).toBe(false);
    expect(
      judgeClassApplies({ kind: 'agent', projectId: projectA, agentId: 'acme.matcher' }, run),
    ).toBe(true);
    expect(
      judgeClassApplies({ kind: 'agent', projectId: projectA, agentId: 'acme.other' }, run),
    ).toBe(false);
  });
});

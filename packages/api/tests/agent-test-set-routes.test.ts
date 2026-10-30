// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/agents/:agentId/test-set`: an agent's corrections are its test
 * set's cases (Won't fix and Removed ones aside), cases added by hand join
 * them, and a case can be retired, one project at a time.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ConversationId, ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  CorrectionRecordInput,
  CorrectionRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { expectOf } from '../src/index.js';
import { isTestSetPath } from '../src/routes/agent-test-set.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';
import { itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const projectA = randomUUID() as ProjectId;
const projectB = randomUUID() as ProjectId;
const AGENT = 'acme.matcher';
const TOKEN = 'test-set-user-token';
const SET = `/v1/agents/${AGENT}/test-set`;

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

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
    output: { answer: 'Refunded.', matches: [{ id: 'c1' }] },
    dryRun: false,
    createdAt: at,
    updatedAt: at,
    agent: { id: AGENT, version: '2.0.0', conversationId: randomUUID() as ConversationId },
    ...overrides,
  };
}

/** With `grants`, it allows exactly these `action type:id` pairs, and records each check in `checked`. */
interface Authz {
  readonly grants: string[];
  readonly checked: string[];
}

function decision(authz: Authz, action: Action, resource: ResourceRef): Decision {
  const key = `${action} ${resource.type}:${resource.id}`;
  authz.checked.push(key);
  const allowed = authz.grants.includes(key);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

function harness(
  rows: KernelRunRecord[],
  opts: {
    readonly authz?: Authz;
    readonly agents?: AgentRegistryBinding;
    readonly served?: ReturnType<typeof itemProjects>;
  } = {},
) {
  const binding: CorrectionRegistryBinding = inMemoryCorrections();
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) => rows.find((r) => r.runId === id) ?? null,
    readJournal: async () => ({ kind: 'ok', value: [] }),
  } as unknown as RunBinding;
  const conversationBinding = {
    ...stubs.conversationBinding,
    readMessages: async () => ({ kind: 'ok', value: [] }),
  } as unknown as typeof stubs.conversationBinding;
  const { authz } = opts;
  const app = createApp({
    ...stubs,
    conversationBinding,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    correctionRegistry: binding,
    ...(opts.agents !== undefined && { agentRegistry: opts.agents }),
    ...(opts.served !== undefined && { itemProjects: opts.served }),
    ...(authz !== undefined && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_principal, action, resource) => decision(authz, action, resource),
          checkBatch: async (_principal, action, resources) =>
            resources.map((resource) => decision(authz, action, resource)),
          recordDecision: () => undefined,
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  /** A correction of `r`, recorded straight into the store. */
  const corrected = async (
    r: KernelRunRecord,
    said: Partial<CorrectionRecordInput>,
    by: string = randomUUID(),
  ): Promise<string> => {
    const correction = await binding.record({
      tenantId,
      projectId: r.projectId,
      runId: r.runId,
      run: {
        subject:
          r.agent !== undefined
            ? { kind: 'agent', id: r.agent.id, version: r.agent.version }
            : { kind: 'flow', id: r.flowId, version: r.flowVersion },
        input: r.input,
        output: r.output,
      },
      madeBy: { kind: 'user', id: by },
      status: 'open',
      ...said,
    });
    return correction.id;
  };
  return { call, binding, corrected };
}

const WRONG_ANSWER = { answer: 'wrong', shouldSay: 'Final sale: no refund.' } as const;

describe("an agent's test set", () => {
  test("every correction is a case but Won't fix and Removed ones; each expects what its verdicts say", async () => {
    const runs = [row(), row(), row(), row(), row(), row(), row({ projectId: projectB })];
    const { agent: _agent, ...flowRun } = row();
    const other = row({
      agent: { id: 'acme.other', version: '1.0.0', conversationId: randomUUID() as ConversationId },
    });
    const h = harness([...runs, flowRun, other]);
    const [r0, r1, r2, r3, r4, r5, inB] = runs as [KernelRunRecord, ...KernelRunRecord[]];
    const open = await h.corrected(r0, WRONG_ANSWER);
    const owner = await h.corrected(r1 as KernelRunRecord, {
      decisions: 'wrong',
      shouldCall: [{ tool: 'lookup_order', args: {} }],
      mustNotCall: ['issue_refund'],
      status: 'with-owner',
    });
    const right = await h.corrected(r2 as KernelRunRecord, {
      decisions: 'right',
      answer: 'right',
      status: 'fixed',
      fixedIn: { how: 'recorded-right', at: '2026-10-01T00:00:00.000Z' },
    });
    await h.corrected(r3 as KernelRunRecord, { ...WRONG_ANSWER, status: 'wont-fix' });
    await h.corrected(r4 as KernelRunRecord, { ...WRONG_ANSWER, status: 'removed' });
    // Superseded by the same author's second correction of the run: only the second is a case.
    await h.corrected(r5 as KernelRunRecord, WRONG_ANSWER, 'expert-1');
    const second = await h.corrected(
      r5 as KernelRunRecord,
      { items: [{ key: 'c1', verdict: 'wrong' }] },
      'expert-1',
    );
    await h.corrected(inB as KernelRunRecord, WRONG_ANSWER);
    await h.corrected(flowRun, WRONG_ANSWER);
    await h.corrected(other, WRONG_ANSWER);

    const cases = await h.call('GET', `${SET}/cases?projectId=${projectA}`);
    expect(cases.status).toBe(200);
    expect(cases.body.data.map((k: { id: string }) => k.id)).toEqual([second, right, owner, open]);
    const byId = Object.fromEntries(cases.body.data.map((k: { id: string }) => [k.id, k]));
    expect(byId[open]).toMatchObject({
      kind: 'correction',
      projectId: projectA,
      runId: r0.runId,
      madeOn: '2.0.0',
      expect: { answer: { verdict: 'wrong', shouldSay: 'Final sale: no refund.' } },
      addedBy: { kind: 'user' },
    });
    expect(byId[owner].expect).toEqual({
      decisions: {
        verdict: 'wrong',
        shouldCall: [{ tool: 'lookup_order', args: {} }],
        mustNotCall: ['issue_refund'],
      },
    });
    expect(byId[right].expect).toEqual({
      decisions: { verdict: 'right' },
      answer: { verdict: 'right' },
    });
    expect(byId[second].expect).toEqual({ items: [{ key: 'c1', verdict: 'wrong' }] });
    expect(byId[open].retired).toBeUndefined();

    const set = await h.call('GET', `${SET}?projectId=${projectA}`);
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      agentId: AGENT,
      projectId: projectA,
      cases: { active: 4, retired: 0 },
      lastAddedAt: byId[second].addedAt,
    });
    const inProjectB = await h.call('GET', `${SET}?projectId=${projectB}`);
    expect(inProjectB.body.cases).toEqual({ active: 1, retired: 0 });
  });

  test('a set with no case has no lastAddedAt', async () => {
    const h = harness([]);
    const set = await h.call('GET', `${SET}?projectId=${projectA}`);
    expect(set.body).toEqual({
      agentId: AGENT,
      projectId: projectA,
      cases: { active: 0, retired: 0 },
    });
  });

  test('a read names its project, by id; include and kind take only what they list', async () => {
    const h = harness([]);
    for (const [path, says] of [
      [SET, 'projectId is required'],
      [`${SET}/cases`, 'projectId is required'],
      [`${SET}?projectId=support`, 'not a project id'],
      [`${SET}/cases?projectId=${projectA}&include=removed`, 'include takes only retired'],
      [`${SET}/cases?projectId=${projectA}&kind=correction,manual`, 'not "manual"'],
    ] as const) {
      const res = await h.call('GET', path);
      expect(res.status, path).toBe(400);
      expect(res.body.error.message, path).toContain(says);
    }
  });

  test("an unknown agent's set is a 404, with an agent registry to ask", async () => {
    const agents = { headExists: async () => false } as unknown as AgentRegistryBinding;
    const h = harness([], { agents });
    const res = await h.call('GET', `${SET}?projectId=${projectA}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('agent-not-found');
  });
});

describe('a case added by hand', () => {
  test("is a case with no status: it's listed with the set, and never as a correction", async () => {
    const r = row();
    const h = harness([r]);
    const corrected = await h.corrected(r, { answer: 'right' });
    const added = await h.call('POST', `${SET}/cases`, { runId: r.runId, ...WRONG_ANSWER });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      kind: 'hand',
      projectId: projectA,
      runId: r.runId,
      madeOn: '2.0.0',
      expect: { answer: { verdict: 'wrong', shouldSay: 'Final sale: no refund.' } },
      addedBy: { kind: 'user', id: 'user-1' },
    });
    expect(added.body.id).toMatch(/^case-/);
    expect(added.body.status).toBeUndefined();

    const hand = await h.call('GET', `${SET}/cases?projectId=${projectA}&kind=hand`);
    expect(hand.body.data.map((k: { id: string }) => k.id)).toEqual([added.body.id]);
    const both = await h.call('GET', `${SET}/cases?projectId=${projectA}&kind=correction,hand`);
    expect(both.body.data.map((k: { id: string }) => k.id)).toEqual([added.body.id, corrected]);
    const list = await h.call('GET', '/v1/corrections');
    expect(list.body.data.map((j: { id: string }) => j.id)).toEqual([corrected]);
    const counts = await h.call('GET', `/v1/corrections/counts?scopeKind=project&scopeId=${projectA}`);
    expect(counts.body).toMatchObject({ open: 1 });
  });

  test("takes a correction's body on a finished run of the agent, and nothing else", async () => {
    const r = row();
    const other = row({
      agent: { id: 'acme.other', version: '1.0.0', conversationId: randomUUID() as ConversationId },
    });
    const running = row({ status: 'running', output: undefined });
    const replay = row({ replayOf: r.runId });
    const erased = row({ contentErasedAt: '2026-10-01T00:00:00.000Z' as Timestamp });
    const h = harness([r, other, running, replay, erased]);
    for (const [body, status, says] of [
      [{ runId: r.runId }, 400, 'at least one of decisions, answer and items'],
      [
        { runId: r.runId, ...WRONG_ANSWER, correctorGroupId: 'jc-1' },
        400,
        'has no correctorGroupId',
      ],
      [
        { runId: r.runId, ...WRONG_ANSWER, participantId: 'p-1' },
        400,
        'has no correctorGroupId or participantId',
      ],
      [{ runId: randomUUID(), ...WRONG_ANSWER }, 404, 'No run'],
      [{ runId: other.runId, ...WRONG_ANSWER }, 400, `isn't a run of agent "${AGENT}"`],
      [{ runId: running.runId, ...WRONG_ANSWER }, 409, 'no output'],
      [{ runId: erased.runId, ...WRONG_ANSWER }, 410, 'was erased'],
      [{ runId: replay.runId, ...WRONG_ANSWER }, 400, "a comparison's replay"],
      [
        { runId: r.runId, items: [{ key: 'c9', pointer: '/matches/9', verdict: 'wrong' }] },
        400,
        'Nothing at "/matches/9"',
      ],
    ] as const) {
      const res = await h.call('POST', `${SET}/cases`, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.body.error.message, JSON.stringify(body)).toContain(says);
    }
    const cases = await h.call('GET', `${SET}/cases?projectId=${projectA}`);
    expect(cases.body.data).toEqual([]);
  });
});

describe('retiring a case', () => {
  test("keeps it listed, greyed out of the count, the correction's status as it was, and can't be undone", async () => {
    const r = row();
    const h = harness([r]);
    const id = await h.corrected(r, WRONG_ANSWER);
    const retired = await h.call('POST', `${SET}/cases/${id}/retire`, {
      reason: 'The refund rule changed.',
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.retired).toMatchObject({
      reason: 'The refund rule changed.',
      by: { kind: 'user', id: 'user-1' },
    });
    expect(retired.body.updatedAt).toBe(retired.body.retired.at);

    const active = await h.call('GET', `${SET}/cases?projectId=${projectA}`);
    expect(active.body.data).toEqual([]);
    const all = await h.call('GET', `${SET}/cases?projectId=${projectA}&include=retired`);
    expect(all.body.data.map((k: { id: string }) => k.id)).toEqual([id]);
    const set = await h.call('GET', `${SET}?projectId=${projectA}`);
    expect(set.body.cases).toEqual({ active: 0, retired: 1 });
    const correction = await h.call('GET', `/v1/corrections/${id}`);
    expect(correction.body.status).toBe('open');

    const again = await h.call('POST', `${SET}/cases/${id}/retire`, { reason: 'Twice.' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('test-case-retired');
  });

  test('needs a reason, and a case the set has', async () => {
    const r = row();
    const h = harness([r]);
    const id = await h.corrected(r, WRONG_ANSWER);
    for (const body of [{}, { reason: '  ' }, { reason: 'x'.repeat(4001) }]) {
      const res = await h.call('POST', `${SET}/cases/${id}/retire`, body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('reason is required');
    }
    const unknown = await h.call('POST', `${SET}/cases/case-9/retire`, { reason: 'Gone.' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('test-case-not-found');
    const elsewhere = await h.call('POST', `/v1/agents/acme.other/test-set/cases/${id}/retire`, {
      reason: 'Not its case.',
    });
    expect(elsewhere.status).toBe(404);
  });
});

describe('who may', () => {
  const agents = { headExists: async () => true } as unknown as AgentRegistryBinding;

  test('reading needs read on the project; adding and retiring, publish on the agent and read on the project', async () => {
    const r = row();
    const authz: Authz = { grants: [], checked: [] };
    const h = harness([r], { authz, agents });
    const id = await h.corrected(r, WRONG_ANSWER);
    const read = () => h.call('GET', `${SET}/cases?projectId=${projectA}`);
    const add = () => h.call('POST', `${SET}/cases`, { runId: r.runId, answer: 'right' });
    const retire = () => h.call('POST', `${SET}/cases/${id}/retire`, { reason: 'Old.' });

    expect((await read()).status).toBe(403);
    authz.grants.push(`read project:${projectA}`);
    expect((await read()).status).toBe(200);

    const denied = await add();
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain(`publish on agent "${AGENT}"`);
    expect((await retire()).status).toBe(403);
    // The agents router's own gate (admin on the agent for a write) leaves these routes.
    expect(authz.checked).not.toContain(`admin agent:${AGENT}`);

    authz.grants.push(`publish agent:${AGENT}`);
    expect((await add()).status).toBe(201);
    expect((await retire()).status).toBe(200);
    expect(authz.checked).not.toContain(`admin agent:${AGENT}`);
  });

  test("for an agent more than one project serves, a change takes write on the case's project", async () => {
    const r = row({ projectId: projectB });
    const authz: Authz = {
      grants: [`read project:${projectB}`, `publish agent:${AGENT}`],
      checked: [],
    };
    const served = itemProjects([{ kind: 'agent', id: AGENT, projects: [projectA, projectB] }]);
    const h = harness([r], { authz, agents, served });
    const denied = await h.call('POST', `${SET}/cases`, { runId: r.runId, answer: 'right' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain(`write on project ${projectB}`);
    authz.grants.push(`write project:${projectB}`);
    const added = await h.call('POST', `${SET}/cases`, { runId: r.runId, answer: 'right' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  });

  test("a read-only agent registry (under `kindgi dev`) still takes cases: they are the corrections store's", async () => {
    const r = row();
    const readOnly = {
      headExists: async () => true,
      readOnly: { reason: 'the pack' },
    } as unknown as AgentRegistryBinding;
    const h = harness([r], { agents: readOnly });
    const added = await h.call('POST', `${SET}/cases`, { runId: r.runId, answer: 'right' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  });
});

describe('the parts', () => {
  test("a case expects nothing of a part an erasure left nothing to check, and isn't a case when nothing is left", () => {
    expect(expectOf({ answer: 'wrong' })).toBeNull();
    expect(expectOf({ answer: 'wrong', decisions: 'right' })).toEqual({
      decisions: { verdict: 'right' },
    });
    expect(expectOf({ decisions: 'wrong' })).toBeNull();
    expect(expectOf({ items: [] })).toBeNull();
  });

  test('only the test set paths are left to their own routes', () => {
    expect(isTestSetPath(`/v1/agents/${AGENT}/test-set`)).toBe(true);
    expect(isTestSetPath(`/v1/agents/${AGENT}/test-set/cases/c-1/retire`)).toBe(true);
    expect(isTestSetPath(`/v1/agents/${AGENT}/test-sets`)).toBe(false);
    expect(isTestSetPath(`/v1/agents/${AGENT}/versions`)).toBe(false);
  });
});

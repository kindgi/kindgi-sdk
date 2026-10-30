// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type { TupleIntent } from '@kindgi/authz';
import type { AgentId, ProjectId, TenantId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import {
  type CorrectionRecordInput,
  type CorrectionRegistryBinding,
  RUN_COPIES_MAX,
  type TestSet,
  type TestSetRecord,
  type TestSetRegistryBinding,
  agentTestSetId,
  createTestSetFreeze,
} from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const otherProjectId = randomUUID() as ProjectId;
const agentId = 'acme.desk' as AgentId;
const testSetId = agentTestSetId(agentId, projectId);

/** Test sets in memory: the newest active version, unregistered ones kept, tuples recorded. */
function inMemoryTestSets() {
  const versions = new Map<string, TestSetRecord[]>();
  const tuples: TupleIntent[] = [];
  const patch = (v: string) => Number(v.split('.')[2]);
  const all = (id: string) => versions.get(id) ?? [];
  const registry: TestSetRegistryBinding = {
    async list() {
      return { data: [] };
    },
    async get({ testSetId: id }) {
      const active = all(id).filter((r) => r.unregisteredAt === undefined);
      return active.sort((a, b) => patch(b.version) - patch(a.version))[0] ?? null;
    },
    async getVersion({ testSetId: id, version }) {
      return all(id).find((r) => r.version === version) ?? null;
    },
    async headExists({ testSetId: id }) {
      return versions.has(id);
    },
    async listVersions({ testSetId: id, includeTombstoned }) {
      return {
        data: all(id).filter((r) => includeTombstoned === true || r.unregisteredAt === undefined),
      };
    },
    async publish({ testSet, projectId: into, enqueueTuples }) {
      const existing = all(testSet.id);
      if (existing.some((r) => r.version === testSet.version)) {
        return { kind: 'already-registered', testSetId: testSet.id, version: testSet.version };
      }
      if (existing.length === 0) tuples.push(...enqueueTuples(testSet.id));
      versions.set(testSet.id, [...existing, { ...testSet, projectId: into }]);
      return { kind: 'ok', testSetId: testSet.id, version: testSet.version };
    },
    async unregister({ testSetId: id, version }) {
      const rows = all(id);
      const i = rows.findIndex((r) => r.version === version);
      if (i < 0) return { unregistered: false };
      rows[i] = { ...(rows[i] as TestSetRecord), unregisteredAt: new Date().toISOString() };
      return { unregistered: true };
    },
    async reinstateVersion({ testSetId: id, version }) {
      return { kind: 'not-found', testSetId: id, version };
    },
  };
  return { registry, tuples, versionsOf: (id: string) => all(id).map((r) => r.version) };
}

function harness(overrides: { corrections?: Partial<CorrectionRegistryBinding> } = {}) {
  const store = inMemoryCorrections();
  const corrections = { ...store, ...overrides.corrections } as CorrectionRegistryBinding;
  const testSets = inMemoryTestSets();
  const cases = inMemoryCaseStore();
  const freeze = createTestSetFreeze({ corrections, testSets: testSets.registry, cases });
  /** A correction of a new run (or `runId`'s) of the agent, by `by`. */
  const corrected = async (
    said: Partial<CorrectionRecordInput>,
    opts: { runId?: string; by?: string; project?: ProjectId; agent?: string } = {},
  ) =>
    store.record({
      tenantId,
      projectId: opts.project ?? projectId,
      runId: opts.runId ?? randomUUID(),
      run: {
        subject: { kind: 'agent', id: opts.agent ?? agentId, version: '1.2.0' },
        input: { ask: 'refund order 41?' },
        output: { text: 'Refunded.' },
      },
      madeBy: { kind: 'user', id: opts.by ?? randomUUID() },
      status: 'open',
      ...said,
    });
  const stored = async (version: string) =>
    (await cases.listCases({ tenantId, testSetId, version, limit: 1000 })).data;
  const run = () => freeze.freezeTestSet({ tenantId, agentId, projectId });
  return { store, testSets, cases, corrected, stored, run };
}

const WRONG_ANSWER = { answer: 'wrong', shouldSay: 'Final sale: no refund.' } as const;

describe('createTestSetFreeze', () => {
  test("freezes the project's active cases as 1.0.0, oldest first, each a copy of its run with what it expects", async () => {
    const h = harness();
    const runId = randomUUID();
    const first = await h.corrected(WRONG_ANSWER, { runId });
    const second = await h.corrected(
      { decisions: 'wrong', shouldCall: [{ tool: 'acme.ask', args: { why: 'sale?' } }] },
      { runId },
    );
    const ranked = await h.corrected({
      items: [
        { key: 'a', pointer: '/items/0', rank: 0, verdict: 'right' },
        { key: 'b', pointer: '/items/1', rank: 1, verdict: 'wrong' },
      ],
    });
    const hand = await h.store.addCase({
      tenantId,
      projectId,
      runId: randomUUID(),
      run: {
        subject: { kind: 'agent', id: agentId, version: '1.1.0' },
        input: { ask: 'cancel?' },
        output: { text: 'Cancelled.' },
        segments: [{ key: 'company', value: 'acme-east' }],
      },
      madeBy: { kind: 'user', id: randomUUID() },
      answer: 'wrong',
      why: 'Ask which order first.',
    });
    // Not this project's, or not this agent's.
    await h.corrected(WRONG_ANSWER, { project: otherProjectId });
    await h.corrected(WRONG_ANSWER, { agent: 'acme.other' });

    const out = await h.run();

    expect(out).toEqual({
      testSetId,
      testSetVersion: '1.0.0',
      cases: [
        { caseId: first.id, correctionId: first.id },
        { caseId: second.id, correctionId: second.id },
        { caseId: ranked.id, correctionId: ranked.id },
        { caseId: hand.id, correctionId: null },
      ],
    });
    const subject = { kind: 'agent', id: agentId, version: '1.2.0' };
    const run = { subject, input: { ask: 'refund order 41?' }, output: { text: 'Refunded.' } };
    expect(await h.stored('1.0.0')).toEqual([
      {
        caseId: first.id,
        ...run,
        items: [],
        expect: { answer: { verdict: 'wrong', shouldSay: 'Final sale: no refund.' } },
      },
      {
        caseId: second.id,
        ...run,
        items: [],
        corrections: [
          {
            correctionId: second.id,
            calls: [{ tool: 'acme.ask', args: { why: 'sale?' } }],
            notCalled: [],
          },
        ],
        expect: {
          decisions: {
            verdict: 'wrong',
            shouldCall: [{ tool: 'acme.ask', args: { why: 'sale?' } }],
          },
        },
      },
      {
        caseId: ranked.id,
        ...run,
        items: [
          {
            key: 'a',
            pointer: '/items/0',
            rank: 0,
            yes: 1,
            no: 0,
            yesWeight: 1,
            totalWeight: 1,
            correctionIds: [ranked.id],
            reasons: [],
          },
          {
            key: 'b',
            pointer: '/items/1',
            rank: 1,
            yes: 0,
            no: 1,
            yesWeight: 0,
            totalWeight: 1,
            correctionIds: [ranked.id],
            reasons: [],
          },
        ],
        expect: {
          items: [
            { key: 'a', pointer: '/items/0', rank: 0, verdict: 'right' },
            { key: 'b', pointer: '/items/1', rank: 1, verdict: 'wrong' },
          ],
        },
      },
      {
        caseId: hand.id,
        subject: { kind: 'agent', id: agentId, version: '1.1.0' },
        input: { ask: 'cancel?' },
        output: { text: 'Cancelled.' },
        segments: [{ key: 'company', value: 'acme-east' }],
        items: [],
        expect: { answer: { verdict: 'wrong', why: 'Ask which order first.' } },
      },
    ]);
    // Two people's corrections of one run are two cases, each kept with its run.
    expect(h.cases.runIdOf(testSetId, '1.0.0', first.id)).toBe(runId);
    expect(h.cases.runIdOf(testSetId, '1.0.0', second.id)).toBe(runId);
    expect(h.cases.runIdOf(testSetId, '1.0.0', hand.runId)).toBeUndefined();
    expect(h.cases.runIdOf(testSetId, '1.0.0', hand.id)).toBe(hand.runId);
    // Reading it needs read on its project: the project is its parent, and it has no owner.
    expect(h.testSets.tuples).toEqual([
      {
        operation: 'write',
        user: `project:${projectId}`,
        relation: 'parent',
        object: `eval_suite:${testSetId}`,
      },
    ]);
  });

  test('the same cases answer the newest version again, and a change makes the next one', async () => {
    const h = harness();
    const first = await h.corrected(WRONG_ANSWER);
    const v0 = await h.run();
    expect(await h.run()).toEqual(v0);
    expect(h.testSets.versionsOf(testSetId)).toEqual(['1.0.0']);

    // A new correction, a retired case, a correction said again: each a new version.
    const added = await h.corrected({ answer: 'right' });
    expect((await h.run()).testSetVersion).toBe('1.0.1');
    await h.store.retireCase({
      tenantId,
      agentId,
      caseId: first.id,
      reason: 'The policy changed.',
      by: { kind: 'user', id: randomUUID() },
    });
    const v2 = await h.run();
    expect(v2).toMatchObject({ testSetVersion: '1.0.2', cases: [{ caseId: added.id }] });
    const again = await h.corrected(WRONG_ANSWER, { runId: added.runId, by: added.madeBy.id });
    expect(await h.run()).toMatchObject({
      testSetVersion: '1.0.3',
      cases: [{ caseId: again.id, correctionId: again.id }],
    });
    // A frozen version tests what it froze.
    expect((await h.stored('1.0.0')).map((c) => c.caseId)).toEqual([first.id]);
    expect((await h.stored('1.0.2')).map((c) => c.caseId)).toEqual([added.id]);
  });

  test('a project with no cases freezes an empty version', async () => {
    const h = harness();
    expect(await h.run()).toEqual({ testSetId, testSetVersion: '1.0.0', cases: [] });
    expect(await h.run()).toEqual({ testSetId, testSetVersion: '1.0.0', cases: [] });
  });

  test("a case whose run's copy is gone is frozen erased, with no words", async () => {
    const h = harness({ corrections: { runCopies: async () => [] } });
    const c = await h.corrected(WRONG_ANSWER);
    expect((await h.run()).cases).toEqual([{ caseId: c.id, correctionId: c.id }]);
    expect(await h.stored('1.0.0')).toEqual([
      {
        caseId: c.id,
        subject: { kind: 'agent', id: agentId, version: '1.2.0' },
        input: null,
        output: null,
        items: [],
        erased: true,
      },
    ]);
  });

  test("a hand case freezes with its run's copy and its own words; only a case whose copy is gone is erased", async () => {
    const h = harness();
    const gone = await h.corrected(WRONG_ANSWER);
    const hand = await h.store.addCase({
      tenantId,
      projectId,
      runId: randomUUID(),
      run: {
        subject: { kind: 'agent', id: agentId, version: '1.2.0' },
        input: { ask: 'cancel?' },
        output: { text: 'Cancelled.' },
      },
      madeBy: { kind: 'user', id: randomUUID() },
      answer: 'wrong',
      shouldSay: 'Which order?',
    });
    const copies = h.store.runCopies;
    const frozen = createTestSetFreeze({
      corrections: {
        ...h.store,
        runCopies: async (input) =>
          copies({ ...input, runIds: input.runIds.filter((id) => id !== gone.runId) }),
      },
      testSets: h.testSets.registry,
      cases: h.cases,
    });
    await frozen.freezeTestSet({ tenantId, agentId, projectId });
    expect(await h.stored('1.0.0')).toEqual([
      {
        caseId: gone.id,
        subject: { kind: 'agent', id: agentId, version: '1.2.0' },
        input: null,
        output: null,
        items: [],
        erased: true,
      },
      {
        caseId: hand.id,
        subject: { kind: 'agent', id: agentId, version: '1.2.0' },
        input: { ask: 'cancel?' },
        output: { text: 'Cancelled.' },
        items: [],
        expect: { answer: { verdict: 'wrong', shouldSay: 'Which order?' } },
      },
    ]);
  });

  test(`asks for the runs' copies ${RUN_COPIES_MAX} at a time`, async () => {
    const asked: number[] = [];
    let copiesOf: CorrectionRegistryBinding['runCopies'] = async () => [];
    const h = harness({
      corrections: {
        runCopies: async (input) => {
          asked.push(input.runIds.length);
          return copiesOf(input);
        },
      },
    });
    copiesOf = h.store.runCopies;
    for (let i = 0; i < RUN_COPIES_MAX + 5; i += 1) await h.corrected({ answer: 'right' });
    expect((await h.run()).cases).toHaveLength(RUN_COPIES_MAX + 5);
    expect(asked).toEqual([RUN_COPIES_MAX, 5]);
  });

  test("writes nothing into a test set that isn't the agent's in this project", async () => {
    for (const spec of [
      {},
      { agentId: 'acme.other', projectId },
      { agentId, projectId: otherProjectId },
    ]) {
      const h = harness();
      await h.corrected(WRONG_ANSWER);
      const made: TestSet = {
        id: testSetId,
        tenantId,
        version: '1.0.0',
        kind: 'corrections',
        spec,
      };
      await h.testSets.registry.publish({
        tenantId,
        projectId,
        testSet: made,
        enqueueTuples: () => [],
      });
      await expect(h.run()).rejects.toThrow(
        `Test set ${testSetId} isn't agent ${agentId}'s test set in project ${projectId}`,
      );
      expect(h.testSets.versionsOf(testSetId)).toEqual(['1.0.0']);
      expect(await h.stored('1.0.0')).toEqual([]);
    }
  });

  test('numbers past an unregistered newest version, and still checks whose it is', async () => {
    const h = harness();
    await h.corrected(WRONG_ANSWER);
    await h.run();
    await h.corrected({ answer: 'right' });
    await h.run();
    await h.testSets.registry.unregister({ tenantId, testSetId, version: '1.0.1' });
    await h.testSets.registry.unregister({ tenantId, testSetId, version: '1.0.0' });
    await h.corrected({ answer: 'right' });
    expect((await h.run()).testSetVersion).toBe('1.0.2');
  });

  test('a version whose cases were never stored is frozen again', async () => {
    const h = harness();
    const c = await h.corrected(WRONG_ANSWER);
    const putCases = h.cases.putCases;
    h.cases.putCases = async () => {
      throw new Error('the store is down');
    };
    await expect(h.run()).rejects.toThrow('the store is down');
    h.cases.putCases = putCases;
    expect(await h.run()).toMatchObject({ testSetVersion: '1.0.1', cases: [{ caseId: c.id }] });
  });

  test("the in-memory store's run copies: at most 100 ids, the tenant's only", async () => {
    const h = harness();
    const c = await h.corrected(WRONG_ANSWER);
    const other = randomUUID() as TenantId;
    expect(await h.store.runCopies({ tenantId, runIds: [c.runId, 'unknown'] })).toMatchObject([
      { runId: c.runId, input: { ask: 'refund order 41?' } },
    ]);
    expect(await h.store.runCopies({ tenantId: other, runIds: [c.runId] })).toEqual([]);
    await expect(
      h.store.runCopies({
        tenantId,
        runIds: Array.from({ length: RUN_COPIES_MAX + 1 }, () => randomUUID()),
      }),
    ).rejects.toThrow(RangeError);
  });
});

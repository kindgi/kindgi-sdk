// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';
import type {
  AgentId,
  AgentPinScope,
  OrgId,
  ProjectId,
  RunId,
  Semver,
  TenantId,
  Timestamp,
} from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type {
  AgentPinBindings,
  AgentPinnedVersion,
  Pin,
  PinActor,
} from '../src/agent-pin-binding.js';
import {
  type PinTestRunDeps,
  pinTookEffect,
  projectsPinMoves,
  startPinTestRuns,
} from '../src/pin-test-runs.js';
import type { TestRun, TestRunStartInput } from '../src/test-run-binding.js';
import { applyTestRunOutcome, pinRunCorrelation } from '../src/test-run-outcome.js';
import { agentTestSetId } from '../src/test-set-binding.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';

const tenantId = randomUUID() as TenantId;
const agentId = 'acme.desk';
const ana = { kind: 'user', id: 'u-ana' } as const;
const ben = { kind: 'user', id: 'u-ben' } as const;
const north = randomUUID() as OrgId;
const south = randomUUID() as OrgId;
/** Support and Billing are in the north org, Returns in the south. */
const support = randomUUID() as ProjectId;
const billing = randomUUID() as ProjectId;
const returns = randomUUID() as ProjectId;
const orgOf = new Map<ProjectId, OrgId>([
  [support, north],
  [billing, north],
  [returns, south],
]);
const project = (projectId: ProjectId): AgentPinScope => ({ kind: 'project', projectId });

function scopeKey(scope: AgentPinScope): string {
  switch (scope.kind) {
    case 'tenant':
      return 'tenant';
    case 'org':
      return `org:${scope.orgId as unknown as string}`;
    case 'project':
      return `project:${scope.projectId as unknown as string}`;
    case 'segment':
      return `segment:${scope.projectId as unknown as string}:${JSON.stringify(scope.path)}`;
  }
}

/**
 * Three projects the agent runs in, each on its own Latest, with pins at
 * any scope, a frozen agent test set per project, and test runs that end
 * when the test says.
 */
function harness() {
  const corrections = inMemoryCorrections();
  const pinned = new Map<string, AgentPinnedVersion>();
  const latest = new Map<ProjectId, { version: Semver; since: string }>();
  const changes: Pin[] = [];
  const runs = new Map<string, TestRun>();
  const started: TestRunStartInput[] = [];
  const cases = new Map<ProjectId, string[]>();
  const testSetVersions = new Map<ProjectId, string>();
  const failing = new Set<ProjectId>();
  const warned: string[] = [];
  const log = { warn: (message: string) => void warned.push(message) };
  let second = 0;
  let ended = 0;
  // After the corrections' store clock (2026-10-01, counting seconds).
  const at = () => new Date(Date.UTC(2026, 10, 6, 9, 0, second++)).toISOString() as Timestamp;
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const agentPins: Pick<AgentPinBindings, 'pinned' | 'latest' | 'changes'> = {
    pinned: {
      resolve: async ({ projectId }) => {
        const order =
          projectId === undefined
            ? ['tenant']
            : [
                `project:${projectId as unknown as string}`,
                `org:${orgOf.get(projectId) as unknown as string}`,
                'tenant',
              ];
        for (const key of order) {
          const pin = pinned.get(key);
          if (pin !== undefined) return { version: pin.version, scope: pin.scope };
        }
        return null;
      },
      list: async () => [...pinned.values()],
    },
    latest: {
      latest: async ({ projectId }) =>
        projectId === undefined ? null : (latest.get(projectId) ?? null),
      byProject: async () => [...latest].map(([projectId, answer]) => ({ projectId, ...answer })),
    },
    changes: {
      pin: unused,
      unpin: unused,
      list: async ({ scope }) => ({
        data: changes
          .filter((c) => scope === undefined || scopeKey(c.scope) === scopeKey(scope))
          .reverse(),
      }),
      get: async (_tenant, changeId) => changes.find((c) => c.id === changeId) ?? null,
    },
  };
  const setPinned = (change: Pin) => {
    pinned.set(scopeKey(change.scope), {
      agentId,
      scope: change.scope,
      version: change.toVersion as Semver,
      changeId: change.id,
      setAt: (change.resolvedAt ?? change.createdAt) as Timestamp,
    });
  };
  const deps: PinTestRunDeps = {
    agentPins,
    corrections,
    projects: {
      get: async (_tenant, id) =>
        orgOf.has(id) ? ({ id, orgId: orgOf.get(id) } as never) : undefined,
    },
    itemProjects: { projectsOf: async () => [support, billing, returns] },
    testSets: {
      freezeTestSet: async ({ projectId }) => {
        if (failing.has(projectId)) throw new Error('the test set store is down');
        return {
          testSetId: agentTestSetId(agentId as AgentId, projectId),
          testSetVersion: testSetVersions.get(projectId) ?? '1',
          cases: (cases.get(projectId) ?? []).map((id) => ({
            caseId: `case-${id}`,
            correctionId: id,
          })),
        };
      },
    },
    testRuns: {
      get: async ({ testRunId }) => runs.get(testRunId) ?? null,
      start: async (input) => {
        const testRunId = randomUUID() as RunId;
        started.push(input);
        runs.set(testRunId, {
          testRunId,
          tenantId,
          testSetId: input.testSetId,
          testSetVersion: input.testSetVersion ?? '1',
          kind: 'corrections',
          ...(input.agentRef !== undefined && { agentRef: input.agentRef }),
          status: 'running',
          dryRun: false,
          startedAt: at(),
          ...(input.correlationId !== undefined && { correlationId: input.correlationId }),
          projectId: input.projectId,
        });
        return { kind: 'ok', testRunId };
      },
      list: async ({ filter }) => ({
        data: [...runs.values()]
          .filter(
            (r) =>
              r.testSetId === filter?.testSetId &&
              (filter?.from === undefined || r.startedAt >= filter.from),
          )
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
      }),
    },
  };
  return {
    deps,
    corrections,
    runs,
    started,
    latest,
    testSetVersions,
    /** Projects whose test set doesn't freeze: the store throws. */
    failing,
    /** What the pin flow logged. */
    warned,
    /** An open correction of the agent in `projectId`, a case on its test set. */
    async corrected(projectId: ProjectId) {
      const { id } = await corrections.record({
        tenantId,
        projectId,
        runId: randomUUID(),
        run: {
          subject: { kind: 'agent', id: agentId, version: '12.0.0' },
          input: { ask: 'refund order 41?' },
          output: { text: 'Refunded.' },
        },
        madeBy: ana,
        status: 'open',
        answer: 'wrong',
        shouldSay: 'Final sale: no refund.',
      });
      cases.set(projectId, [...(cases.get(projectId) ?? []), id]);
      return id;
    },
    onLatest(projectId: ProjectId, version: string) {
      latest.set(projectId, { version: version as Semver, since: at() });
    },
    /**
     * Pin as the pin flow does: the projects it moves read first, then the
     * change recorded (pinned, or waiting for approval), then its runs.
     */
    async pin(
      version: string,
      scope: AgentPinScope,
      opts: { by?: PinActor; waits?: boolean; testRunId?: RunId } = {},
    ) {
      const moved = await projectsPinMoves(deps, {
        tenantId,
        agentId,
        scope,
        version: version as Semver,
      });
      const change: Pin = {
        id: `pc-${changes.length + 1}`,
        agentId,
        scope,
        action: 'pin',
        fromVersion: pinned.get(scopeKey(scope))?.version ?? null,
        toVersion: version as Semver,
        requestedBy: opts.by ?? ana,
        ...(opts.testRunId !== undefined && { testRunId: opts.testRunId as unknown as string }),
        createdAt: at(),
        status: opts.waits === true ? 'pending-approval' : 'pinned',
      };
      changes.push(change);
      if (opts.waits !== true) setPinned(change);
      return {
        change,
        ...(await startPinTestRuns(deps, { tenantId, change, projects: moved, log })),
      };
    },
    /** The approval pins a waiting change: the same id and `createdAt`, with `resolvedAt`. */
    approve(change: Pin): Pin {
      const approved: Pin = { ...change, status: 'pinned', resolvedAt: at() };
      changes[changes.indexOf(change)] = approved;
      setPinned(approved);
      return approved;
    },
    /** A test run of `version` in `projectId` that has completed, as a card's check runs. */
    finished(
      projectId: ProjectId,
      version: string,
      found: Readonly<Record<string, boolean>>,
      run: Partial<TestRun> = {},
    ): RunId {
      const testRunId = randomUUID() as RunId;
      runs.set(testRunId, {
        testRunId,
        tenantId,
        testSetId: agentTestSetId(agentId as AgentId, projectId),
        testSetVersion: '1',
        kind: 'corrections',
        agentRef: { agentId: agentId as AgentId, version: version as Semver },
        status: 'completed',
        dryRun: false,
        startedAt: '2026-11-05T10:00:00.000Z' as Timestamp,
        completedAt: '2026-11-05T10:05:00.000Z' as Timestamp,
        correlationId: 'suggested-change:sc-1',
        projectId,
        result: perCase(found),
        ...run,
      });
      return testRunId;
    },
    /** A started run ends, completed, with what it found for each correction. */
    end(testRunId: RunId, found: Readonly<Record<string, boolean>>) {
      const run = runs.get(testRunId);
      if (run === undefined) throw new Error(`no run ${testRunId as unknown as string}`);
      runs.set(testRunId, {
        ...run,
        status: 'completed',
        completedAt: new Date(Date.UTC(2026, 10, 7, 0, 0, ended++)).toISOString() as Timestamp,
        result: perCase(found),
      });
    },
    apply: (testRunId: RunId) => applyTestRunOutcome(deps, { tenantId, testRunId }),
    tookEffect: (change: Pin) => pinTookEffect(deps, { tenantId, changeId: change.id, log }),
    get: (correctionId: string) => corrections.get({ tenantId, correctionId }),
  };
}

function perCase(found: Readonly<Record<string, boolean>>) {
  return {
    perCase: Object.entries(found).map(([correctionId, pass], i) => ({
      caseId: `case-${i}`,
      corrections: [{ correctionId, pass, repetitionsPassed: pass ? 1 : 0, repetitions: 1 }],
    })),
  };
}

describe('a project pin', () => {
  test('starts a run of the version on the project test set as frozen, which applies at its end', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    const id = await h.corrected(support);
    h.testSetVersions.set(support, '3');
    const pinned = await h.pin('13.0.0', project(support));
    expect(h.started).toEqual([
      {
        tenantId,
        projectId: support,
        testSetId: agentTestSetId(agentId as AgentId, support),
        testSetVersion: '3',
        agentRef: { agentId, version: '13.0.0' },
        correlationId: pinRunCorrelation(pinned.change.id),
      },
    ]);
    const [run] = pinned.testRuns;
    expect(pinned).toMatchObject({ testRuns: [{ projectId: support }], fixed: [], reopened: [] });
    if (run === undefined) throw new Error('no run');
    h.end(run.testRunId, { [id]: true });
    expect(await h.apply(run.testRunId)).toEqual({ fixed: [id], reopened: [] });
    expect(await h.get(id)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '13.0.0', how: 'pin', by: ana },
    });
  });

  test('reuses the finished run it names, which changes the statuses at pin time, as of the pin', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    const id = await h.corrected(support);
    const check = h.finished(support, '13.0.0', { [id]: true });
    const pinned = await h.pin('13.0.0', project(support), { by: ben, testRunId: check });
    expect(h.started).toEqual([]);
    expect(pinned).toMatchObject({
      testRuns: [{ projectId: support, testRunId: check }],
      fixed: [id],
      reopened: [],
    });
    expect(await h.get(id)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '13.0.0', how: 'pin', by: ben, at: pinned.change.createdAt },
    });
  });

  test('the run it names still changes a correction that changed after it ended, before the pin', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    const check = h.finished(
      support,
      '13.0.0',
      {},
      {
        startedAt: '2026-09-30T10:00:00.000Z' as Timestamp,
        completedAt: '2026-09-30T10:05:00.000Z' as Timestamp,
      },
    );
    const id = await h.corrected(support);
    const run = h.runs.get(check);
    if (run === undefined) throw new Error('no run');
    h.runs.set(check, { ...run, result: perCase({ [id]: true }) });
    // A suggested change takes it on after the run ended: it's being fixed.
    expect(
      await h.corrections.update({
        tenantId,
        correctionId: id,
        expected: { status: 'open', sortedTo: null },
        status: 'being-fixed',
        link: { kind: 'suggested-change', id: 'sc-1' },
      }),
    ).toMatchObject({ kind: 'updated' });
    const pinned = await h.pin('13.0.0', project(support), { testRunId: check });
    expect(pinned).toMatchObject({ fixed: [id], reopened: [] });
    expect(await h.get(id)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '13.0.0', how: 'pin', at: pinned.change.createdAt },
    });
  });

  test('starts a run when the one it names can not stand for the check', async () => {
    const notReusable: Partial<TestRun>[] = [
      { testSetVersion: '2' },
      { dryRun: true },
      { status: 'running' },
      { agentRef: { agentId: agentId as AgentId, version: '12.5.0' as Semver } },
      { projectId: billing },
      { testSetId: 'acme.refunds' },
      { comparison: { baseline: 'recorded', sample: 3 } as never },
      { comparison: { baseline: 'recorded', overrides: { settings: {} } } as never },
      { comparison: { baseline: 'recorded', rescoreOf: 'tr-1' } as never },
      { kind: 'accuracy' },
    ];
    for (const run of notReusable) {
      const h = harness();
      h.onLatest(support, '12.0.0');
      const id = await h.corrected(support);
      const named = h.finished(support, '13.0.0', { [id]: true }, run);
      const pinned = await h.pin('13.0.0', project(support), { testRunId: named });
      expect(pinned).toMatchObject({ fixed: [], reopened: [] });
      expect(pinned.testRuns).toHaveLength(1);
      expect(pinned.testRuns[0]?.testRunId).not.toBe(named);
      expect(await h.get(id)).toMatchObject({ status: 'open' });
    }
  });

  test('checks nothing in a project with no active cases, or that runs the version already', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    expect(await h.pin('13.0.0', project(support))).toMatchObject({ testRuns: [] });
    h.onLatest(billing, '13.0.0');
    await h.corrected(billing);
    expect(await h.pin('13.0.0', project(billing))).toMatchObject({ testRuns: [] });
    expect(h.started).toEqual([]);
  });

  test('a segment pin checks nothing', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    await h.corrected(support);
    const segment: AgentPinScope = {
      kind: 'segment',
      projectId: support,
      path: [{ key: 'company', value: 'acme' }],
    };
    expect(await h.pin('13.0.0', segment)).toMatchObject({ testRuns: [], fixed: [], reopened: [] });
    expect(h.started).toEqual([]);
  });
});

describe('a tenant or org pin', () => {
  test('a tenant pin checks each project the agent runs in that it moves, not one under its own pin', async () => {
    const h = harness();
    for (const p of [support, billing, returns]) {
      h.onLatest(p, '12.0.0');
      await h.corrected(p);
    }
    await h.pin('12.5.0', project(billing));
    h.started.length = 0;
    await h.pin('13.0.0', { kind: 'tenant' });
    expect(h.started.map((s) => s.projectId)).toEqual([support, returns]);
  });

  test("an org pin checks the org's projects, and a tenant pin under it none of them", async () => {
    const h = harness();
    for (const p of [support, billing, returns]) {
      h.onLatest(p, '12.0.0');
      await h.corrected(p);
    }
    await h.pin('13.0.0', { kind: 'org', orgId: north });
    expect(h.started.map((s) => s.projectId)).toEqual([support, billing]);
    h.started.length = 0;
    await h.pin('14.0.0', { kind: 'tenant' });
    expect(h.started.map((s) => s.projectId)).toEqual([returns]);
  });

  test("a project whose test run doesn't start is left out and logged; the others start", async () => {
    const h = harness();
    for (const p of [support, billing, returns]) {
      h.onLatest(p, '12.0.0');
      await h.corrected(p);
    }
    h.failing.add(billing);
    const pinned = await h.pin('13.0.0', { kind: 'tenant' });
    expect(pinned.testRuns.map((r) => r.projectId)).toEqual([support, returns]);
    expect(h.warned).toEqual([
      `pin change ${pinned.change.id}'s test run in project ${billing as unknown as string} didn't start or apply: the test set store is down`,
    ]);
  });

  test('a run of a project the pin moved applies at its end', async () => {
    const h = harness();
    h.onLatest(returns, '12.0.0');
    const id = await h.corrected(returns);
    const pinned = await h.pin('13.0.0', { kind: 'tenant' });
    const [run] = pinned.testRuns;
    if (run === undefined) throw new Error('no run');
    h.end(run.testRunId, { [id]: false });
    await h.apply(run.testRunId);
    expect(await h.get(id)).toMatchObject({ status: 'open' });
    expect(run.projectId).toBe(returns);
  });
});

describe('a pin that waits for approval', () => {
  test('starts its runs at once; one that ends while it waits changes nothing, and the approval applies it', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    const id = await h.corrected(support);
    const waiting = await h.pin('13.0.0', project(support), { waits: true });
    expect(waiting).toMatchObject({ testRuns: [{ projectId: support }], fixed: [], reopened: [] });
    const [run] = waiting.testRuns;
    if (run === undefined) throw new Error('no run');
    h.end(run.testRunId, { [id]: true });
    expect(await h.apply(run.testRunId)).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
    const approved = h.approve(waiting.change);
    expect(await h.tookEffect(approved)).toEqual({
      testRuns: [{ projectId: support, testRunId: run.testRunId }],
      fixed: [id],
      reopened: [],
    });
    expect(await h.get(id)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '13.0.0', how: 'pin', by: ana, at: approved.resolvedAt },
    });
    expect(h.started).toHaveLength(1);
  });

  test('a run still going when it is approved applies at its own end', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    const id = await h.corrected(support);
    const waiting = await h.pin('13.0.0', project(support), { waits: true });
    const [run] = waiting.testRuns;
    if (run === undefined) throw new Error('no run');
    const approved = h.approve(waiting.change);
    expect(await h.tookEffect(approved)).toEqual({
      testRuns: [{ projectId: support, testRunId: run.testRunId }],
      fixed: [],
      reopened: [],
    });
    h.end(run.testRunId, { [id]: true });
    expect(await h.apply(run.testRunId)).toEqual({ fixed: [id], reopened: [] });
    expect(h.started).toHaveLength(1);
  });

  test('the run it names is listed while it waits, and applies when it is approved', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    const id = await h.corrected(support);
    const check = h.finished(support, '13.0.0', { [id]: true });
    const waiting = await h.pin('13.0.0', project(support), { waits: true, testRunId: check });
    expect(waiting).toMatchObject({
      testRuns: [{ projectId: support, testRunId: check }],
      fixed: [],
      reopened: [],
    });
    expect(await h.get(id)).toMatchObject({ status: 'open' });
    expect(await h.tookEffect(h.approve(waiting.change))).toMatchObject({ fixed: [id] });
    expect(h.started).toEqual([]);
  });

  test('the approval starts a run for a project the change covers that has none', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    const waiting = await h.pin('13.0.0', project(support), { waits: true });
    expect(waiting.testRuns).toEqual([]);
    const id = await h.corrected(support);
    const effect = await h.tookEffect(h.approve(waiting.change));
    expect(h.started.map((s) => s.correlationId)).toEqual([pinRunCorrelation(waiting.change.id)]);
    expect(effect).toMatchObject({ testRuns: [{ projectId: support }], fixed: [], reopened: [] });
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test("the approval leaves out a project whose test run doesn't start, and logs it", async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    h.onLatest(returns, '12.0.0');
    const waiting = await h.pin('13.0.0', { kind: 'tenant' }, { waits: true });
    expect(waiting.testRuns).toEqual([]);
    await h.corrected(support);
    await h.corrected(returns);
    h.failing.add(support);
    const effect = await h.tookEffect(h.approve(waiting.change));
    expect(effect.testRuns.map((r) => r.projectId)).toEqual([returns]);
    expect(h.warned).toHaveLength(1);
    expect(h.warned[0]).toContain(support as unknown as string);
  });

  test('a refused pin, and one still waiting, apply nothing at approval time', async () => {
    const h = harness();
    h.onLatest(support, '12.0.0');
    await h.corrected(support);
    const waiting = await h.pin('13.0.0', project(support), { waits: true });
    expect(await h.tookEffect(waiting.change)).toEqual({ testRuns: [], fixed: [], reopened: [] });
    const refused: Pin = { ...waiting.change, id: 'pc-refused', status: 'refused' };
    expect(
      await startPinTestRuns(h.deps, { tenantId, change: refused, projects: [support] }),
    ).toEqual({ testRuns: [], fixed: [], reopened: [] });
  });
});

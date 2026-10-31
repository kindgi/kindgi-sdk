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

import {
  type AgentPinBindings,
  type Pin,
  type PinActor,
  type TestRun,
  type TestRunComparison,
  applyTestRunOutcome,
  latestRunCorrelation,
  pinRunCorrelation,
  reapplyTestRunOutcomes,
  testRunReason,
} from '../src/index.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const agentId = 'acme.desk';
const ana = { kind: 'user', id: 'u-ana' } as const;
const ben = { kind: 'user', id: 'u-ben' } as const;
const dana = { kind: 'user', id: 'u-dana' } as const;
const projectScope: AgentPinScope = { kind: 'project', projectId };
const tenantScope: AgentPinScope = { kind: 'tenant' };
/** The project's org. */
const orgId = randomUUID() as OrgId;

/** One project's pin (its own, or the tenant's) and Latest, with each scope's pin history newest first. */
function pins() {
  const state: {
    pinned?:
      | { version: Semver; changeId: string; setAt: Timestamp; scope: AgentPinScope }
      | undefined;
    latest?: { version: Semver; since: string };
    changes: Pin[];
  } = { changes: [] };
  let second = 0;
  // After the corrections' store clock (2026-10-01, counting seconds).
  const at = () => new Date(Date.UTC(2026, 10, 6, 9, 0, second++)).toISOString() as Timestamp;
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const bindings: Pick<AgentPinBindings, 'pinned' | 'latest' | 'changes'> = {
    pinned: {
      resolve: async () =>
        state.pinned === undefined
          ? null
          : { version: state.pinned.version, scope: state.pinned.scope },
      list: async () => (state.pinned === undefined ? [] : [{ agentId, ...state.pinned }]),
    },
    latest: {
      latest: async () => state.latest ?? null,
      byProject: async () => (state.latest === undefined ? [] : [{ projectId, ...state.latest }]),
    },
    changes: {
      pin: unused,
      unpin: unused,
      list: async ({ scope }) => ({
        data: state.changes.filter((c) => c.scope.kind === scope?.kind).reverse(),
      }),
      get: async (_tenant, changeId) => state.changes.find((c) => c.id === changeId) ?? null,
    },
  };
  const change = (
    action: Pin['action'],
    toVersion: string | null,
    by: PinActor,
    scope: AgentPinScope,
    keepsRanBefore: boolean,
  ): Pin => {
    const ranBefore = state.pinned?.version ?? state.latest?.version;
    const made: Pin = {
      id: `pc-${state.changes.length + 1}`,
      agentId,
      scope,
      action,
      fromVersion: state.pinned?.scope.kind === scope.kind ? state.pinned.version : null,
      toVersion: toVersion as Semver | null,
      ...(action === 'pin' && keepsRanBefore && ranBefore !== undefined && { ranBefore }),
      requestedBy: by,
      createdAt: at(),
      ...(action === 'pin' && { status: 'pinned' as const }),
    };
    state.changes.push(made);
    return made;
  };
  return {
    bindings,
    state,
    /** `keepsRanBefore: false` records the pin as a store from before `ranBefore` was kept. */
    pin(version: string, by: PinActor, { scope = projectScope, keepsRanBefore = true } = {}): Pin {
      const made = change('pin', version, by, scope, keepsRanBefore);
      state.pinned = {
        version: version as Semver,
        changeId: made.id,
        setAt: made.createdAt,
        scope,
      };
      return made;
    },
    unpin(by: PinActor, scope: AgentPinScope = projectScope): Pin {
      const made = change('unpin', null, by, scope, false);
      state.pinned = undefined;
      return made;
    },
    moveLatest(version: string): string {
      const since = at();
      state.latest = { version: version as Semver, since };
      return since;
    },
  };
}

function harness() {
  const corrections = inMemoryCorrections();
  const project = pins();
  const runs = new Map<string, TestRun>();
  let ended = 0;
  const deps = {
    testRuns: { get: async ({ testRunId }: { testRunId: RunId }) => runs.get(testRunId) ?? null },
    agentPins: project.bindings,
    corrections,
    projects: {
      get: async (_tenant: TenantId, id: ProjectId) =>
        id === projectId ? ({ id, orgId } as never) : undefined,
    },
  };
  const corrected = async (status: 'open' | 'fixed' = 'open') => {
    const { id } = await corrections.record({
      tenantId,
      projectId,
      runId: randomUUID(),
      run: {
        subject: { kind: 'agent', id: agentId, version: '1.2.0' },
        input: { ask: 'refund order 41?' },
        output: { text: 'Refunded.' },
      },
      madeBy: ana,
      status,
      answer: 'wrong',
      shouldSay: 'Final sale: no refund.',
    });
    return id;
  };
  /** A finished test run of `version`, and what it found for each correction. */
  const ran = (
    version: string,
    correlationId: string,
    found: Readonly<Record<string, boolean>>,
    status: TestRun['status'] = 'completed',
    run: Partial<TestRun> = {},
  ): RunId => {
    const testRunId = randomUUID() as RunId;
    runs.set(testRunId, {
      testRunId,
      tenantId,
      testSetId: `agent.${agentId}.${projectId as unknown as string}`,
      testSetVersion: '1',
      kind: 'corrections',
      agentRef: { agentId: agentId as AgentId, version: version as Semver },
      status,
      dryRun: false,
      // After every pin change the harness records (2026-11-06 09:00, counting seconds).
      startedAt: '2026-11-06T10:00:00.000Z' as Timestamp,
      // Each run ends after the last one, and after every write of the store's.
      completedAt: new Date(Date.UTC(2026, 10, 7, 0, 0, ended++)).toISOString() as Timestamp,
      correlationId,
      projectId,
      result: {
        perCase: Object.entries(found).map(([correctionId, pass], i) => ({
          caseId: `case-${i}`,
          corrections: [{ correctionId, pass, repetitionsPassed: pass ? 1 : 0, repetitions: 1 }],
        })),
      },
      ...run,
    });
    return testRunId;
  };
  const apply = (testRunId: RunId) => applyTestRunOutcome(deps, { tenantId, testRunId });
  /** Runs applied again, newest first, as a start-up reconcile does. */
  const reapply = (...testRunIds: RunId[]) =>
    reapplyTestRunOutcomes(deps, { tenantId, testRunIds });
  const get = async (correctionId: string) => corrections.get({ tenantId, correctionId });
  return { corrections, project, corrected, ran, apply, reapply, get };
}

describe('a test run names why it started', () => {
  test('a pin change, or Latest moving in a project', () => {
    expect(testRunReason(pinRunCorrelation('pc-1'))).toEqual({ kind: 'pin', changeId: 'pc-1' });
    expect(testRunReason(latestRunCorrelation('acme.desk', projectId))).toEqual({
      kind: 'latest',
      agentId: 'acme.desk',
      projectId,
    });
    for (const other of [
      undefined,
      'suggested-change:sc-1',
      'pin:',
      'latest:acme.desk',
      'latest::p',
    ]) {
      expect(testRunReason(other)).toBeUndefined();
    }
  });
});

describe("applying a pin's test run", () => {
  test('a pass makes an open correction fixed in the pinned version, by whoever pinned it', async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const outcome = await h.apply(h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true }));
    expect(outcome).toEqual({ fixed: [id], reopened: [] });
    expect(await h.get(id)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '13.0.0', how: 'pin', by: ana, at: v13.createdAt },
    });
  });

  test("pin v13 starts run A and pin v14 run B: B applies, and A, ending later, doesn't land over it", async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const a = h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: false });
    const v14 = h.project.pin('14.0.0', ben);
    const b = h.ran('14.0.0', pinRunCorrelation(v14.id), { [id]: true });
    expect(await h.apply(b)).toEqual({ fixed: [id], reopened: [] });
    // The project runs v14 now, so v13's outcome is dropped.
    expect(await h.apply(a)).toBeUndefined();
    expect(await h.get(id)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '14.0.0', how: 'pin', by: ben },
    });
  });

  test('pin v13, pin v14, back to v13: run A applies as the going back, by whoever went back, and run C finds nothing to move', async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const a = h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: false });
    const v14 = h.project.pin('14.0.0', ben);
    await h.apply(h.ran('14.0.0', pinRunCorrelation(v14.id), { [id]: true }));
    const back = h.project.pin('13.0.0', dana);
    const c = h.ran('13.0.0', pinRunCorrelation(back.id), { [id]: false });

    // A ends while v13 runs again: it applies, as dana going back.
    expect(await h.apply(a)).toEqual({ fixed: [], reopened: [id] });
    const reopened = await h.get(id);
    expect(reopened).toMatchObject({
      status: 'open',
      fixedIn: { version: '14.0.0', how: 'pin', by: ben },
      reopenedIn: { version: '13.0.0', how: 'went-back', by: dana, at: back.createdAt },
    });
    // C ends: the correction is already open, so nothing changes.
    expect(await h.apply(c)).toEqual({ fixed: [], reopened: [] });
    expect(await h.get(id)).toEqual(reopened);
  });

  test('going back fixes in a pin: a pass after going back reads `pin` in fixedIn', async () => {
    const h = harness();
    const id = await h.corrected();
    h.project.pin('14.0.0', ana);
    const back = h.project.pin('13.0.0', dana);
    await h.apply(h.ran('13.0.0', pinRunCorrelation(back.id), { [id]: true }));
    expect(await h.get(id)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '13.0.0', how: 'pin', by: dana },
    });
  });

  test('an unpin reopens as `unpin`, and a pass under it is fixed in what the project now follows', async () => {
    const h = harness();
    const fails = await h.corrected();
    const passes = await h.corrected();
    const v14 = h.project.pin('14.0.0', ana);
    await h.apply(h.ran('14.0.0', pinRunCorrelation(v14.id), { [fails]: true }));
    h.project.moveLatest('13.0.0');
    const unpin = h.project.unpin(ben);
    const outcome = await h.apply(
      h.ran('13.0.0', pinRunCorrelation(unpin.id), { [fails]: false, [passes]: true }),
    );
    expect(outcome).toEqual({ fixed: [passes], reopened: [fails] });
    expect(await h.get(fails)).toMatchObject({
      status: 'open',
      fixedIn: { version: '14.0.0', how: 'pin', by: ana },
      reopenedIn: { version: '13.0.0', how: 'unpin', by: ben, at: unpin.createdAt },
    });
    expect(await h.get(passes)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '13.0.0', how: 'latest', by: ben },
    });
  });
});

describe('going back', () => {
  test('a pin of an earlier version than Latest is going back, where the project had no pin of its own', async () => {
    const h = harness();
    const id = await h.corrected();
    h.project.moveLatest('14.0.0');
    await h.apply(h.ran('14.0.0', latestRunCorrelation(agentId, projectId), { [id]: true }));
    const back = h.project.pin('13.0.0', dana);
    expect(back).toMatchObject({ fromVersion: null, ranBefore: '14.0.0' });
    const outcome = await h.apply(h.ran('13.0.0', pinRunCorrelation(back.id), { [id]: false }));
    expect(outcome).toEqual({ fixed: [], reopened: [id] });
    expect(await h.get(id)).toMatchObject({
      status: 'open',
      fixedIn: { version: '14.0.0', how: 'latest' },
      reopenedIn: { version: '13.0.0', how: 'went-back', by: dana, at: back.createdAt },
    });
  });

  test("a pin recorded before what ran before it was kept goes back against the scope's own pin before", async () => {
    const h = harness();
    const id = await h.corrected();
    const v14 = h.project.pin('14.0.0', ana);
    await h.apply(h.ran('14.0.0', pinRunCorrelation(v14.id), { [id]: true }));
    const back = h.project.pin('13.0.0', dana, { keepsRanBefore: false });
    expect(back).not.toHaveProperty('ranBefore');
    await h.apply(h.ran('13.0.0', pinRunCorrelation(back.id), { [id]: false }));
    expect(await h.get(id)).toMatchObject({
      reopenedIn: { version: '13.0.0', how: 'went-back', by: dana },
    });
  });

  test('earlier is by semver: 1.0.0-rc.9 after 1.0.0-rc.10 is going back, and rc.10 after rc.9 is a pin', async () => {
    const h = harness();
    const id = await h.corrected();
    const rc9 = h.project.pin('1.0.0-rc.9', ana);
    await h.apply(h.ran('1.0.0-rc.9', pinRunCorrelation(rc9.id), { [id]: true }));
    const rc10 = h.project.pin('1.0.0-rc.10', ben);
    await h.apply(h.ran('1.0.0-rc.10', pinRunCorrelation(rc10.id), { [id]: false }));
    expect(await h.get(id)).toMatchObject({
      reopenedIn: { version: '1.0.0-rc.10', how: 'pin', by: ben },
    });
    await h.apply(h.ran('1.0.0-rc.10', pinRunCorrelation(rc10.id), { [id]: true }));
    const back = h.project.pin('1.0.0-rc.9', dana);
    await h.apply(h.ran('1.0.0-rc.9', pinRunCorrelation(back.id), { [id]: false }));
    expect(await h.get(id)).toMatchObject({
      reopenedIn: { version: '1.0.0-rc.9', how: 'went-back', by: dana },
    });
  });
});

describe('a wider scope', () => {
  test("a tenant pin's run that ends after the tenant unpinned to Latest at that version applies, by whoever pinned it", async () => {
    const h = harness();
    const id = await h.corrected();
    h.project.moveLatest('13.0.0');
    // An old unpin of the project's own: older than the tenant's pin, so not the newest change.
    h.project.pin('12.0.0', dana);
    h.project.unpin(dana);
    const v14 = h.project.pin('14.0.0', ana, { scope: tenantScope });
    const run = h.ran('14.0.0', pinRunCorrelation(v14.id), { [id]: true });
    h.project.moveLatest('14.0.0');
    h.project.unpin(ben, tenantScope);
    expect(await h.apply(run)).toEqual({ fixed: [id], reopened: [] });
    expect(await h.get(id)).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '14.0.0', how: 'latest', by: ana, at: v14.createdAt },
    });
  });
});

describe("applying a Latest check's test run", () => {
  test('a pass is fixed in Latest, by nobody, at when it became Latest', async () => {
    const h = harness();
    const id = await h.corrected();
    const since = h.project.moveLatest('15.0.0');
    const run = h.ran('15.0.0', latestRunCorrelation(agentId, projectId), { [id]: true });
    expect(await h.apply(run)).toEqual({ fixed: [id], reopened: [] });
    const got = await h.get(id);
    expect(got).toMatchObject({
      status: 'fixed',
      fixedIn: { version: '15.0.0', how: 'latest', at: since },
    });
    expect(got?.fixedIn).not.toHaveProperty('by');
  });

  test('a check that ends after Latest moved again is dropped', async () => {
    const h = harness();
    const id = await h.corrected();
    h.project.moveLatest('15.0.0');
    const run = h.ran('15.0.0', latestRunCorrelation(agentId, projectId), { [id]: true });
    h.project.moveLatest('16.0.0');
    expect(await h.apply(run)).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });
});

describe('a run that changes nothing', () => {
  test('a dry run, and a comparison with other content, on a sample or a rescore', async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const correlation = pinRunCorrelation(v13.id);
    const compared: TestRunComparison = {
      baseline: 'recorded',
      reads: 'recorded',
      repetitions: 1,
      k: 5,
    };
    const unpublished = [
      { dryRun: true },
      {
        comparison: {
          ...compared,
          overrides: { prompts: { system: { template: 'Always refund.' } } },
        },
      },
      { comparison: { ...compared, sample: { part: 'search', seed: 's-1', holdOutShare: 0.2 } } },
      { comparison: { ...compared, rescoreOf: randomUUID() } },
    ] satisfies Partial<TestRun>[];
    for (const run of unpublished) {
      expect(await h.apply(h.ran('13.0.0', correlation, { [id]: true }, 'completed', run))).toBe(
        undefined,
      );
    }
    expect(await h.get(id)).toMatchObject({ status: 'open' });
    // The version as published, on all its cases, applies.
    const published = h.ran('13.0.0', correlation, { [id]: true }, 'completed', {
      comparison: compared,
    });
    expect(await h.apply(published)).toEqual({ fixed: [id], reopened: [] });
  });

  test("a `latest:` run whose own agent or project isn't the one its correlation names", async () => {
    const h = harness();
    const id = await h.corrected();
    h.project.moveLatest('15.0.0');
    const elsewhere = randomUUID() as ProjectId;
    const forged = [
      h.ran('15.0.0', latestRunCorrelation(agentId, projectId), { [id]: true }, 'completed', {
        projectId: elsewhere,
      }),
      h.ran('15.0.0', latestRunCorrelation('acme.other', projectId), { [id]: true }),
    ];
    for (const run of forged) expect(await h.apply(run)).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test('a `latest:` run that ends once a pin covers the project, even of the same version', async () => {
    const h = harness();
    const id = await h.corrected();
    h.project.moveLatest('15.0.0');
    const run = h.ran('15.0.0', latestRunCorrelation(agentId, projectId), { [id]: true });
    h.project.pin('15.0.0', ana);
    expect(await h.apply(run)).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test("one that didn't complete, or that neither a pin nor Latest started", async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    expect(
      await h.apply(h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true }, 'failed')),
    ).toBeUndefined();
    expect(await h.apply(h.ran('13.0.0', 'suggested-change:sc-1', { [id]: true }))).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test('the same run applied twice changes the corrections once', async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const run = h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true });
    expect(await h.apply(run)).toEqual({ fixed: [id], reopened: [] });
    expect(await h.apply(run)).toEqual({ fixed: [], reopened: [] });
  });
});

describe("a `pin:` run applies only as its change's own run", () => {
  test("an org pin's run of a project in the org applies", async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana, { scope: { kind: 'org', orgId } });
    expect(await h.apply(h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true }))).toEqual({
      fixed: [id],
      reopened: [],
    });
  });

  test('one whose correlation names no recorded change, or more than its id', async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    for (const correlationId of [pinRunCorrelation('pc-none'), `${pinRunCorrelation(v13.id)}-x`]) {
      expect(await h.apply(h.ran('13.0.0', correlationId, { [id]: true }))).toBeUndefined();
    }
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test("one whose correlation names a recorded change of another agent's", async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const other: Pin = { ...v13, id: 'pc-other', agentId: 'acme.billing' };
    h.project.state.changes.push(other);
    expect(
      await h.apply(h.ran('13.0.0', pinRunCorrelation(other.id), { [id]: true })),
    ).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test('one that started before its change was recorded', async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const early = h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true }, 'completed', {
      startedAt: '2026-11-06T08:59:59.999Z' as Timestamp,
    });
    expect(await h.apply(early)).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test('one of another version than its change pinned, though the project runs that version now', async () => {
    const h = harness();
    const id = await h.corrected();
    const v12 = h.project.pin('12.0.0', ana);
    h.project.pin('13.0.0', ben);
    expect(
      await h.apply(h.ran('13.0.0', pinRunCorrelation(v12.id), { [id]: true })),
    ).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test("one of a project outside its change's scope: another project, another org, a segment", async () => {
    const h = harness();
    const id = await h.corrected();
    const outside: AgentPinScope[] = [
      { kind: 'project', projectId: randomUUID() as ProjectId },
      { kind: 'org', orgId: randomUUID() as OrgId },
      { kind: 'segment', projectId, path: [{ key: 'company', value: 'acme' }] },
    ];
    for (const scope of outside) {
      const change = h.project.pin('13.0.0', ana, { scope });
      expect(
        await h.apply(h.ran('13.0.0', pinRunCorrelation(change.id), { [id]: true })),
      ).toBeUndefined();
    }
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });

  test("one not on its project's agent test set", async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const run = h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true }, 'completed', {
      testSetId: 'acme.refunds',
    });
    expect(await h.apply(run)).toBeUndefined();
    expect(await h.get(id)).toMatchObject({ status: 'open' });
  });
});

describe('applying ended runs again, newest first', () => {
  test('a run whose end was never applied lands, and one applied before changes nothing', async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    const applied = h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true });
    await h.apply(applied);
    const v14 = h.project.pin('14.0.0', ben);
    const missed = h.ran('14.0.0', pinRunCorrelation(v14.id), { [id]: false });
    expect(await h.reapply(missed, applied)).toEqual({ fixed: [], reopened: [id] });
    expect(await h.get(id)).toMatchObject({
      status: 'open',
      fixedIn: { version: '13.0.0', by: ana },
      reopenedIn: { version: '14.0.0', how: 'pin', by: ben },
    });
  });

  test("of two runs of the version a project runs, an older one's fail never lands over a newer one's pass", async () => {
    const h = harness();
    const id = await h.corrected();
    const v13 = h.project.pin('13.0.0', ana);
    await h.apply(h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true }));
    // Neither end was applied: the older fails it, the newer passes it and so changes nothing.
    const older = h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: false });
    const newer = h.ran('13.0.0', pinRunCorrelation(v13.id), { [id]: true });
    expect(await h.reapply(newer, older)).toEqual({ fixed: [], reopened: [] });
    expect(await h.get(id)).toMatchObject({ status: 'fixed', fixedIn: { version: '13.0.0' } });
  });
});

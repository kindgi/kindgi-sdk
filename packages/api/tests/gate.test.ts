// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The release gate: a gate's checks against a
 * comparison's summary, one by one, passing and failing.
 */

import { describe, expect, test } from 'vitest';

import type { AgentPinScope, OrgId, ProjectId } from '@kindgi/types';

import type { ComparisonMetric, CorrectedComparisonSummary } from '../src/corrected-dispatcher.js';
import { type GateInput, casesDetails, evaluateGate } from '../src/gate.js';
import type { ReleaseGateSpec } from '../src/release-gate-binding.js';

const PROJECT = '00000000-0000-4000-8000-0000000000aa' as ProjectId;
const ORG = '00000000-0000-4000-8000-0000000000bb' as OrgId;
const NOW = new Date('2026-10-06T12:00:00.000Z');

function metric(overrides: Partial<ComparisonMetric> = {}): ComparisonMetric {
  return {
    baseline: 0.7,
    candidate: 0.75,
    delta: 0.05,
    n: 30,
    weight: 40,
    baselineN: 30,
    baselineWeight: 40,
    direction: 'higher',
    ...overrides,
  };
}

function summary(overrides: Partial<CorrectedComparisonSummary> = {}): CorrectedComparisonSummary {
  return {
    testRunId: 'eval-1',
    status: 'completed',
    completedAt: '2026-10-06T10:00:00.000Z',
    testSet: { id: 'acme.drafting-set', version: '1.0.0' },
    candidate: { kind: 'agent', agentId: 'acme.drafting', version: '1.2.0', pinsDigest: 'sha-120' },
    baseline: {
      kind: 'recorded',
      versions: [{ agentId: 'acme.drafting', version: '1.1.0', cases: 30 }],
    },
    scope: { projectId: PROJECT },
    cases: 30,
    diverged: 0,
    refusedWrites: 0,
    errors: 0,
    stopped: 0,
    reads: 'recorded',
    sampling: { models: [] },
    repetitions: 1,
    metrics: {
      passRate: metric(),
      caseCoverage: metric({ baseline: 0.9, candidate: 0.9, delta: 0 }),
      weightedPrecisionAtK: metric({ k: 5 }),
    },
    ...overrides,
  };
}

function gate(
  spec: ReleaseGateSpec,
  over: {
    summary?: CorrectedComparisonSummary | null;
    scope?: AgentPinScope;
    pinsDigest?: string | null;
    serving?: string;
    summaryProjectOrgId?: string;
    passedBefore?: readonly string[];
  } = {},
) {
  const input: GateInput = {
    spec,
    pin: {
      agentId: 'acme.drafting',
      version: '1.2.0',
      pinsDigest: over.pinsDigest === undefined ? 'sha-120' : over.pinsDigest,
      scope: over.scope ?? { kind: 'project', projectId: PROJECT },
    },
    summary: over.summary === undefined ? summary() : over.summary,
    servingVersion: over.serving ?? '1.1.0',
    ...(over.summaryProjectOrgId !== undefined && {
      summaryProjectOrgId: over.summaryProjectOrgId,
    }),
    ...(over.passedBefore !== undefined && { passedBefore: over.passedBefore }),
    now: NOW,
  };
  return evaluateGate(input);
}

const check = (r: ReturnType<typeof gate>, name: string) => r.checks.find((c) => c.name === name);

describe('the comparison', () => {
  test('an empty spec checks nothing and passes, without a comparison', () => {
    const r = gate({}, { summary: null });
    expect(r).toEqual({ checks: [], passed: true });
  });

  test('a spec with metrics needs a comparison', () => {
    const r = gate({ metrics: [{ name: 'passRate', minCandidate: 0.5 }] }, { summary: null });
    expect(r.passed).toBe(false);
    expect(check(r, 'comparison.required')?.message).toContain('`testRunId`');
  });

  test('approvals alone need no comparison', () => {
    expect(gate({ approvals: {} }, { summary: null })).toMatchObject({ checks: [], passed: true });
  });

  test('a partial comparison passes only within replay.maxErrors; a failed one never', () => {
    const partial = summary({ status: 'partial', errors: 2 });
    expect(check(gate({}, { summary: partial }), 'comparison.status')?.passed).toBe(false);
    expect(
      check(gate({ replay: { maxErrors: 2 } }, { summary: partial }), 'comparison.status')?.passed,
    ).toBe(true);
    expect(
      check(
        gate({ replay: { maxErrors: 9 } }, { summary: summary({ status: 'failed' }) }),
        'comparison.status',
      )?.passed,
    ).toBe(false);
  });

  test('freshness: within maxAgeHours', () => {
    expect(check(gate({ comparison: { maxAgeHours: 3 } }), 'comparison.freshness')).toMatchObject({
      passed: true,
      value: 2,
      threshold: 3,
    });
    expect(check(gate({ comparison: { maxAgeHours: 1 } }), 'comparison.freshness')?.passed).toBe(
      false,
    );
  });

  test('testSet: id, and version when the gate names one', () => {
    expect(
      check(gate({ comparison: { testSet: { id: 'acme.drafting-set' } } }), 'comparison.testSet')
        ?.passed,
    ).toBe(true);
    expect(
      check(
        gate({ comparison: { testSet: { id: 'acme.drafting-set', version: '2.0.0' } } }),
        'comparison.testSet',
      )?.message,
    ).toBe(
      'The test run used test cases acme.drafting-set 1.0.0; the gate needs acme.drafting-set 2.0.0.',
    );
  });
});

describe('sameContents', () => {
  test('the same agent, version and pins pass', () => {
    expect(check(gate({}), 'sameContents')?.passed).toBe(true);
  });

  test('another version, other pins, no recorded pins, a flow: each refused with its reason', () => {
    const other = summary({
      candidate: { kind: 'agent', agentId: 'acme.drafting', version: '1.3.0', pinsDigest: 'x' },
    });
    expect(check(gate({}, { summary: other }), 'sameContents')?.message).toBe(
      'The test run tried acme.drafting 1.3.0, not acme.drafting 1.2.0.',
    );
    expect(check(gate({}, { pinsDigest: 'sha-other' }), 'sameContents')?.message).toContain(
      'other pins',
    );
    expect(check(gate({}, { pinsDigest: null }), 'sameContents')?.message).toContain('republish');
    const old = summary({
      candidate: { kind: 'agent', agentId: 'acme.drafting', version: '1.2.0' },
    });
    expect(check(gate({}, { summary: old }), 'sameContents')?.message).toContain(
      '(its pinsDigest): re-run it.',
    );
    const flow = summary({ candidate: { kind: 'flow', flowId: 'acme.intake', version: '1.0.0' } });
    expect(check(gate({}, { summary: flow }), 'sameContents')?.passed).toBe(false);
  });
});

describe('baselineIsPinned', () => {
  test('one baseline version, the one serving the scope', () => {
    expect(check(gate({}), 'baselineIsPinned')?.passed).toBe(true);
    expect(check(gate({}, { serving: '1.0.0' }), 'baselineIsPinned')).toMatchObject({
      passed: false,
      value: 'acme.drafting 1.1.0',
      threshold: 'acme.drafting 1.0.0',
    });
  });

  test('a baseline mixing versions is refused', () => {
    const mixed = summary({
      baseline: {
        kind: 'recorded',
        versions: [
          { agentId: 'acme.drafting', version: '1.0.0', cases: 10 },
          { agentId: 'acme.drafting', version: '1.1.0', cases: 20 },
        ],
      },
    });
    expect(check(gate({}, { summary: mixed }), 'baselineIsPinned')?.message).toContain(
      'measured this version against 2 versions',
    );
  });
});

describe('scopeCovered', () => {
  test('a project or segment pin needs that project’s corrections', () => {
    expect(check(gate({}), 'scopeCovered')?.passed).toBe(true);
    const elsewhere = summary({ scope: { projectId: '00000000-0000-4000-8000-0000000000cc' } });
    expect(check(gate({}, { summary: elsewhere }), 'scopeCovered')?.passed).toBe(false);
    const segment: AgentPinScope = {
      kind: 'segment',
      projectId: PROJECT,
      path: [{ key: 'company', value: 'acme' }],
    };
    expect(check(gate({}, { scope: segment }), 'scopeCovered')?.passed).toBe(true);
  });

  test('an org pin: tenant-wide corrections, or a project in the org', () => {
    const org: AgentPinScope = { kind: 'org', orgId: ORG };
    const inOrg = check(gate({}, { scope: org, summaryProjectOrgId: ORG }), 'scopeCovered');
    expect(inOrg?.passed).toBe(true);
    expect(inOrg?.message).toBe(`The corrections came from project ${PROJECT}, within org ${ORG}.`);
    const outside = check(gate({}, { scope: org }), 'scopeCovered');
    expect(outside?.passed).toBe(false);
    expect(outside?.message).toBe(
      `The corrections came from project ${PROJECT}, outside org ${ORG}.`,
    );
    const everywhere = check(
      gate({}, { scope: org, summary: summary({ scope: {} }) }),
      'scopeCovered',
    );
    expect(everywhere?.passed).toBe(true);
    expect(everywhere?.message).toBe(
      `The corrections came from every project, which covers org ${ORG}.`,
    );
  });

  test('a tenant pin takes any corrections', () => {
    expect(check(gate({}, { scope: { kind: 'tenant' } }), 'scopeCovered')?.passed).toBe(true);
  });
});

describe('replay', () => {
  test('each knob in the block defaults to 0', () => {
    const r = gate(
      { replay: { maxRefusedWrites: 3 } },
      { summary: summary({ diverged: 1, refusedWrites: 3 }) },
    );
    expect(check(r, 'replay.maxDiverged')).toMatchObject({ passed: false, value: 1, threshold: 0 });
    expect(check(r, 'replay.maxRefusedWrites')).toMatchObject({
      passed: true,
      value: 3,
      threshold: 3,
    });
    expect(check(r, 'replay.maxStopped')?.passed).toBe(true);
  });

  test('says what it counted: refused tool calls, and cases stopped at one', () => {
    const one = gate(
      { replay: { maxRefusedWrites: 1 } },
      { summary: summary({ refusedWrites: 1, stopped: 1 }) },
    );
    expect(check(one, 'replay.maxRefusedWrites')?.message).toBe(
      '1 tool call was refused; the gate allows 1.',
    );
    expect(check(one, 'replay.maxStopped')?.message).toBe(
      '1 case stopped at a refused tool call; the gate allows 0.',
    );
    const many = gate({ replay: {} }, { summary: summary({ refusedWrites: 2, stopped: 2 }) });
    expect(check(many, 'replay.maxRefusedWrites')?.message).toBe(
      '2 tool calls were refused; the gate allows 0.',
    );
    expect(check(many, 'replay.maxStopped')?.message).toBe(
      '2 cases stopped at a refused tool call; the gate allows 0.',
    );
  });

  test('no replay block: no replay checks', () => {
    expect(gate({}).checks.some((c) => c.name.startsWith('replay.'))).toBe(false);
  });
});

describe('cases', () => {
  const graded = (results: readonly { correctionId: string; pass: boolean }[]) =>
    summary({
      corrections: {
        checked: results.length,
        passed: results.filter((r) => r.pass).length,
        results,
      },
    });
  const passes = (ids: readonly string[]) =>
    ids.map((correctionId) => ({ correctionId, pass: true }));
  const fails = (ids: readonly string[]) =>
    ids.map((correctionId) => ({ correctionId, pass: false }));

  test('minPassing: at least that many of the graded cases pass', () => {
    const run = graded([...passes(['c-1', 'c-2', 'c-3']), ...fails(['c-4'])]);
    expect(check(gate({ cases: { minPassing: 4 } }, { summary: run }), 'cases.minPassing')).toEqual(
      {
        name: 'cases.minPassing',
        passed: false,
        message: '3 of 4 cases pass; the gate needs at least 4.',
        value: 3,
        threshold: 4,
      },
    );
    expect(
      check(gate({ cases: { minPassing: 3 } }, { summary: run }), 'cases.minPassing')?.passed,
    ).toBe(true);
  });

  test('minPassing: a test run that graded no case passes none', () => {
    expect(check(gate({ cases: { minPassing: 1 } }), 'cases.minPassing')).toMatchObject({
      passed: false,
      message: '0 of 0 cases pass; the gate needs at least 1.',
      value: 0,
    });
  });

  test("noNewFailures: a case that's fixed now and fails is newly failing; one that wasn't fixed, or wasn't graded, isn't", () => {
    const r = gate(
      { cases: { noNewFailures: true } },
      {
        summary: graded([...passes(['c-1']), ...fails(['c-2', 'c-3'])]),
        passedBefore: ['c-1', 'c-2', 'c-9'],
      },
    );
    expect(check(r, 'cases.noNewFailures')).toEqual({
      name: 'cases.noNewFailures',
      passed: false,
      message:
        '1 case that passed before fails now: c-2. The test run checked 2 of the 3 cases fixed now.',
      value: 1,
      threshold: 0,
      caseIds: ['c-2'],
    });
    expect(r.passed).toBe(false);
  });

  test('noNewFailures: says how many that passed before it checked, when none fails', () => {
    const one = gate(
      { cases: { noNewFailures: true } },
      { summary: graded([...passes(['c-1']), ...fails(['c-3'])]), passedBefore: ['c-1'] },
    );
    expect(check(one, 'cases.noNewFailures')).toMatchObject({
      passed: true,
      message: 'The test run checked 1 of the 1 case fixed now, and it still passes.',
      caseIds: [],
    });
    const many = gate(
      { cases: { noNewFailures: true } },
      { summary: graded(passes(['c-1', 'c-2'])), passedBefore: ['c-1', 'c-2'] },
    );
    expect(check(many, 'cases.noNewFailures')?.message).toBe(
      'The test run checked 2 of the 2 cases fixed now, and they all still pass.',
    );
    const none = gate(
      { cases: { noNewFailures: true } },
      { summary: graded(fails(['c-3'])), passedBefore: ['c-1'] },
    );
    expect(check(none, 'cases.noNewFailures')).toMatchObject({
      passed: true,
      message: 'The test run checked none of the 1 case fixed now.',
      caseIds: [],
    });
  });

  test("noNewFailures: a case fixed now that the run didn't grade isn't counted, and the message says how many it graded", () => {
    const ungraded = gate({ cases: { noNewFailures: true } }, { passedBefore: ['c-1', 'c-2'] });
    expect(check(ungraded, 'cases.noNewFailures')).toMatchObject({
      passed: true,
      message: 'The test run checked none of the 2 cases fixed now.',
      caseIds: [],
    });
    const some = gate(
      { cases: { noNewFailures: true } },
      { summary: graded(passes(['c-1'])), passedBefore: ['c-1', 'c-2', 'c-3'] },
    );
    expect(check(some, 'cases.noNewFailures')?.message).toBe(
      'The test run checked 1 of the 3 cases fixed now, and it still passes.',
    );
    const nothingFixed = gate(
      { cases: { noNewFailures: true } },
      { summary: graded(fails(['c-1'])), passedBefore: [] },
    );
    expect(check(nothingFixed, 'cases.noNewFailures')).toMatchObject({
      passed: true,
      message: 'No case is fixed now, so none that passed before can fail.',
    });
  });

  test('noNewFailures: a correction graded on two cases fails once if either fails', () => {
    const r = gate(
      { cases: { noNewFailures: true } },
      {
        summary: graded([
          { correctionId: 'c-1', pass: true },
          { correctionId: 'c-1', pass: false },
        ]),
        passedBefore: ['c-1'],
      },
    );
    expect(check(r, 'cases.noNewFailures')).toMatchObject({ passed: false, caseIds: ['c-1'] });
  });

  test('noNewFailures: the message lists five, and caseIds has them all', () => {
    const ids = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6', 'c-7'];
    const r = gate(
      { cases: { noNewFailures: true } },
      { summary: graded(fails(ids)), passedBefore: ids },
    );
    expect(check(r, 'cases.noNewFailures')).toMatchObject({
      message:
        '7 cases that passed before fail now: c-1, c-2, c-3, c-4, c-5, and 2 more. The test run checked 7 of the 7 cases fixed now.',
      caseIds: ids,
    });
  });

  test("noNewFailures fails when it can't tell: the cases that passed before weren't read, or the run kept no case-by-case grades", () => {
    const unread = gate({ cases: { noNewFailures: true } }, { summary: graded(fails(['c-1'])) });
    expect(check(unread, 'cases.noNewFailures')).toEqual({
      name: 'cases.noNewFailures',
      passed: false,
      message:
        "The cases that passed before couldn't be read, so the gate can't tell whether one fails now.",
    });
    const old = gate(
      { cases: { noNewFailures: true } },
      { summary: summary({ corrections: { checked: 2, passed: 1 } }), passedBefore: ['c-1'] },
    );
    expect(check(old, 'cases.noNewFailures')).toMatchObject({
      passed: false,
      message:
        "The test run doesn't say how each case did (it was recorded before that was kept): run it again.",
    });
    expect(check(old, 'cases.noNewFailures')?.caseIds).toBeUndefined();
  });

  test('noNewFailures: false checks nothing', () => {
    expect(check(gate({ cases: { noNewFailures: false } }), 'cases.noNewFailures')).toBeUndefined();
  });

  test('the rule needs a test run', () => {
    const r = gate({ cases: { minPassing: 1 } }, { summary: null });
    expect(check(r, 'comparison.required')?.passed).toBe(false);
    expect(check(r, 'cases.minPassing')).toBeUndefined();
  });

  test("a refusal's figures come off the cases checks", () => {
    const r = gate(
      { cases: { minPassing: 3, noNewFailures: true } },
      { summary: graded([...passes(['c-1', 'c-2']), ...fails(['c-3'])]), passedBefore: ['c-3'] },
    );
    expect(casesDetails(r.checks)).toEqual({ passing: 2, needs: 3, newlyFailing: ['c-3'] });
    expect(casesDetails(gate({}).checks)).toEqual({});
    const unread = gate({ cases: { noNewFailures: true } }, { summary: graded(fails(['c-1'])) });
    expect(casesDetails(unread.checks)).toEqual({});
  });
});

describe('metrics and evidence', () => {
  test('minCandidate, with its plain message', () => {
    const r = gate({ metrics: [{ name: 'weightedPrecisionAtK', minCandidate: 0.8 }] });
    expect(check(r, 'metric.weightedPrecisionAtK.minCandidate')).toEqual({
      name: 'metric.weightedPrecisionAtK.minCandidate',
      passed: false,
      message: 'Precision at 5 is 0.75; the gate needs at least 0.8.',
      value: 0.75,
      threshold: 0.8,
    });
  });

  test('maxDrop against the pinned version, with room for float rounding', () => {
    const exact = summary({
      metrics: {
        ...summary().metrics,
        passRate: metric({ baseline: 0.7, candidate: 0.68 }),
      },
    });
    expect(
      check(
        gate({ metrics: [{ name: 'passRate', maxDrop: 0.02 }] }, { summary: exact }),
        'metric.passRate.maxDrop',
      )?.passed,
    ).toBe(true);
    expect(
      check(
        gate({ metrics: [{ name: 'passRate', maxDrop: 0.01 }] }, { summary: exact }),
        'metric.passRate.maxDrop',
      )?.passed,
    ).toBe(false);
  });

  test("a side without evidence from corrections can't pass", () => {
    const empty = summary({
      metrics: {
        ...summary().metrics,
        caseCoverage: metric({ baseline: null, candidate: null }),
      },
    });
    const r = gate(
      { metrics: [{ name: 'caseCoverage', minCandidate: 0.1, maxDrop: 0 }] },
      { summary: empty },
    );
    expect(check(r, 'metric.caseCoverage.minCandidate')?.passed).toBe(false);
    expect(check(r, 'metric.caseCoverage.maxDrop')?.passed).toBe(false);
  });

  test("k must be the gate's", () => {
    const r = gate({ metrics: [{ name: 'weightedPrecisionAtK', k: 10, minCandidate: 0.5 }] });
    expect(check(r, 'metric.weightedPrecisionAtK.k')).toMatchObject({
      passed: false,
      value: 5,
      threshold: 10,
    });
  });

  test('evidence on the candidate, and on the baseline for a metric with maxDrop', () => {
    const thin = summary({
      metrics: {
        ...summary().metrics,
        passRate: metric({ n: 30, weight: 40, baselineN: 2, baselineWeight: 2 }),
      },
    });
    const r = gate(
      {
        evidence: { minCases: 20, minWeight: 10 },
        metrics: [{ name: 'passRate', maxDrop: 0.02 }],
      },
      { summary: thin },
    );
    expect(check(r, 'evidence.passRate.minCases')?.passed).toBe(true);
    expect(check(r, 'evidence.passRate.minWeight')?.passed).toBe(true);
    expect(check(r, 'evidence.passRate.baselineMinCases')).toMatchObject({
      passed: false,
      value: 2,
    });
    expect(check(r, 'evidence.passRate.baselineMinWeight')?.passed).toBe(false);
    const minOnly = gate(
      { evidence: { minCases: 20 }, metrics: [{ name: 'passRate', minCandidate: 0.5 }] },
      { summary: thin },
    );
    expect(minOnly.checks.some((c) => /^evidence\..*\.baseline/.test(c.name))).toBe(false);
  });
});

describe('the verdict', () => {
  const strict: ReleaseGateSpec = {
    comparison: { maxAgeHours: 168 },
    evidence: { minCases: 20 },
    metrics: [{ name: 'weightedPrecisionAtK', k: 5, minCandidate: 0.7, maxDrop: 0.02 }],
    replay: {},
  };

  test('every check passing passes; the gate’s approval comes with it', () => {
    expect(gate(strict).passed).toBe(true);
    expect(gate({ ...strict, approvals: {} })).toMatchObject({
      passed: true,
      approval: { role: 'senior', count: 1, separateApprover: true },
    });
    expect(
      gate({ approvals: { role: 'admin', separateApprover: false } }, { summary: null }).approval,
    ).toEqual({
      role: 'admin',
      count: 1,
      separateApprover: false,
    });
  });

  test('one failing check fails the gate', () => {
    expect(gate(strict, { serving: '1.0.0' }).passed).toBe(false);
  });
});

describe('onlyExpertGroups (T200)', () => {
  test('needs a comparison weighted experts-only', () => {
    expect(gate({ onlyExpertGroups: true }, { summary: null }).checks).toEqual([
      expect.objectContaining({ name: 'comparison.required', passed: false }),
    ]);
    const asRecorded = check(gate({ onlyExpertGroups: true }), 'groupWeights.expertsOnly');
    expect(asRecorded).toMatchObject({ passed: false, value: 'as-recorded' });
    expect(asRecorded?.message).toContain("groupWeights: 'experts-only'");
    const restricted = gate(
      { onlyExpertGroups: true },
      { summary: summary({ groupWeights: 'experts-only' }) },
    );
    expect(check(restricted, 'groupWeights.expertsOnly')?.passed).toBe(true);
  });
});

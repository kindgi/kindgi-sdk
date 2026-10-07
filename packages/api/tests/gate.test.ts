// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The promotion gate (evals step 4b): a policy's checks against a
 * comparison's summary, one by one, passing and failing.
 */

import { describe, expect, test } from 'vitest';

import type { LiveScope, OrgId, ProjectId } from '@kindgi/types';

import type { GatePolicySpec } from '../src/gate-policy-binding.js';
import { type GateInput, evaluateGate } from '../src/gate.js';
import type { ComparisonMetric, JudgedComparisonSummary } from '../src/judged-dispatcher.js';

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

function summary(overrides: Partial<JudgedComparisonSummary> = {}): JudgedComparisonSummary {
  return {
    evalRunId: 'eval-1',
    status: 'completed',
    completedAt: '2026-10-06T10:00:00.000Z',
    suite: { id: 'acme.drafting-set', version: '1.0.0' },
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
      weightedYesShare: metric(),
      judgedCoverage: metric({ baseline: 0.9, candidate: 0.9, delta: 0 }),
      weightedPrecisionAtK: metric({ k: 5 }),
    },
    ...overrides,
  };
}

function gate(
  spec: GatePolicySpec,
  over: {
    summary?: JudgedComparisonSummary | null;
    scope?: LiveScope;
    pinsDigest?: string | null;
    serving?: string;
    summaryProjectOrgId?: string;
  } = {},
) {
  const input: GateInput = {
    spec,
    promotion: {
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
    const r = gate(
      { metrics: [{ name: 'weightedYesShare', minCandidate: 0.5 }] },
      { summary: null },
    );
    expect(r.passed).toBe(false);
    expect(check(r, 'comparison.required')?.message).toContain('`evalRunId`');
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

  test('suite: id, and version when the policy names one', () => {
    expect(
      check(gate({ comparison: { suite: { id: 'acme.drafting-set' } } }), 'comparison.suite')
        ?.passed,
    ).toBe(true);
    expect(
      check(
        gate({ comparison: { suite: { id: 'acme.drafting-set', version: '2.0.0' } } }),
        'comparison.suite',
      )?.message,
    ).toBe(
      'The comparison ran test set acme.drafting-set 1.0.0; the policy needs acme.drafting-set 2.0.0.',
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
      'The comparison ran acme.drafting 1.3.0, not acme.drafting 1.2.0.',
    );
    expect(check(gate({}, { pinsDigest: 'sha-other' }), 'sameContents')?.message).toContain(
      'other pins',
    );
    expect(check(gate({}, { pinsDigest: null }), 'sameContents')?.message).toContain('republish');
    const old = summary({
      candidate: { kind: 'agent', agentId: 'acme.drafting', version: '1.2.0' },
    });
    expect(check(gate({}, { summary: old }), 'sameContents')?.message).toContain(
      're-run the comparison',
    );
    const flow = summary({ candidate: { kind: 'flow', flowId: 'acme.intake', version: '1.0.0' } });
    expect(check(gate({}, { summary: flow }), 'sameContents')?.passed).toBe(false);
  });
});

describe('baselineIsLive', () => {
  test('one baseline version, the one serving the scope', () => {
    expect(check(gate({}), 'baselineIsLive')?.passed).toBe(true);
    expect(check(gate({}, { serving: '1.0.0' }), 'baselineIsLive')).toMatchObject({
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
    expect(check(gate({}, { summary: mixed }), 'baselineIsLive')?.message).toContain(
      'mixes 2 versions',
    );
  });
});

describe('scopeCovered', () => {
  test('a project or segment promotion needs that project’s judgments', () => {
    expect(check(gate({}), 'scopeCovered')?.passed).toBe(true);
    const elsewhere = summary({ scope: { projectId: '00000000-0000-4000-8000-0000000000cc' } });
    expect(check(gate({}, { summary: elsewhere }), 'scopeCovered')?.passed).toBe(false);
    const segment: LiveScope = {
      kind: 'segment',
      projectId: PROJECT,
      path: [{ key: 'company', value: 'acme' }],
    };
    expect(check(gate({}, { scope: segment }), 'scopeCovered')?.passed).toBe(true);
  });

  test('an org promotion: tenant-wide judgments, or a project in the org', () => {
    const org: LiveScope = { kind: 'org', orgId: ORG };
    expect(check(gate({}, { scope: org, summaryProjectOrgId: ORG }), 'scopeCovered')?.passed).toBe(
      true,
    );
    expect(check(gate({}, { scope: org }), 'scopeCovered')?.passed).toBe(false);
    expect(
      check(gate({}, { scope: org, summary: summary({ scope: {} }) }), 'scopeCovered')?.passed,
    ).toBe(true);
  });

  test('a tenant promotion takes any judgments', () => {
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

  test('no replay block: no replay checks', () => {
    expect(gate({}).checks.some((c) => c.name.startsWith('replay.'))).toBe(false);
  });
});

describe('metrics and evidence', () => {
  test('minCandidate, with its plain message', () => {
    const r = gate({ metrics: [{ name: 'weightedPrecisionAtK', minCandidate: 0.8 }] });
    expect(check(r, 'metric.weightedPrecisionAtK.minCandidate')).toEqual({
      name: 'metric.weightedPrecisionAtK.minCandidate',
      passed: false,
      message: 'Precision at 5 is 0.75; the policy needs at least 0.8.',
      value: 0.75,
      threshold: 0.8,
    });
  });

  test('maxDrop against the live version, with room for float rounding', () => {
    const exact = summary({
      metrics: {
        ...summary().metrics,
        weightedYesShare: metric({ baseline: 0.7, candidate: 0.68 }),
      },
    });
    expect(
      check(
        gate({ metrics: [{ name: 'weightedYesShare', maxDrop: 0.02 }] }, { summary: exact }),
        'metric.weightedYesShare.maxDrop',
      )?.passed,
    ).toBe(true);
    expect(
      check(
        gate({ metrics: [{ name: 'weightedYesShare', maxDrop: 0.01 }] }, { summary: exact }),
        'metric.weightedYesShare.maxDrop',
      )?.passed,
    ).toBe(false);
  });

  test("a side without judged evidence can't pass", () => {
    const empty = summary({
      metrics: {
        ...summary().metrics,
        judgedCoverage: metric({ baseline: null, candidate: null }),
      },
    });
    const r = gate(
      { metrics: [{ name: 'judgedCoverage', minCandidate: 0.1, maxDrop: 0 }] },
      { summary: empty },
    );
    expect(check(r, 'metric.judgedCoverage.minCandidate')?.passed).toBe(false);
    expect(check(r, 'metric.judgedCoverage.maxDrop')?.passed).toBe(false);
  });

  test("k must be the policy's", () => {
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
        weightedYesShare: metric({ n: 30, weight: 40, baselineN: 2, baselineWeight: 2 }),
      },
    });
    const r = gate(
      {
        evidence: { minCases: 20, minWeight: 10 },
        metrics: [{ name: 'weightedYesShare', maxDrop: 0.02 }],
      },
      { summary: thin },
    );
    expect(check(r, 'evidence.weightedYesShare.minCases')?.passed).toBe(true);
    expect(check(r, 'evidence.weightedYesShare.minWeight')?.passed).toBe(true);
    expect(check(r, 'evidence.weightedYesShare.baselineMinCases')).toMatchObject({
      passed: false,
      value: 2,
    });
    expect(check(r, 'evidence.weightedYesShare.baselineMinWeight')?.passed).toBe(false);
    const minOnly = gate(
      { evidence: { minCases: 20 }, metrics: [{ name: 'weightedYesShare', minCandidate: 0.5 }] },
      { summary: thin },
    );
    expect(minOnly.checks.some((c) => /^evidence\..*\.baseline/.test(c.name))).toBe(false);
  });
});

describe('the verdict', () => {
  const strict: GatePolicySpec = {
    comparison: { maxAgeHours: 168 },
    evidence: { minCases: 20 },
    metrics: [{ name: 'weightedPrecisionAtK', k: 5, minCandidate: 0.7, maxDrop: 0.02 }],
    replay: {},
  };

  test('every check passing passes; the policy’s approval comes with it', () => {
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

describe('onlyRestrictedClasses (T200)', () => {
  test('needs a comparison weighted restricted-only', () => {
    expect(gate({ onlyRestrictedClasses: true }, { summary: null }).checks).toEqual([
      expect.objectContaining({ name: 'comparison.required', passed: false }),
    ]);
    const asRecorded = check(gate({ onlyRestrictedClasses: true }), 'classWeights.restrictedOnly');
    expect(asRecorded).toMatchObject({ passed: false, value: 'as-recorded' });
    expect(asRecorded?.message).toContain("classWeights: 'restricted-only'");
    const restricted = gate(
      { onlyRestrictedClasses: true },
      { summary: summary({ classWeights: 'restricted-only' }) },
    );
    expect(check(restricted, 'classWeights.restrictedOnly')?.passed).toBe(true);
  });
});

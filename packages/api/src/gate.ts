// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReviewerRole } from '@kindgi/authz';
import type { LiveScope } from '@kindgi/types';

import type { ComparisonMetric, CorrectedComparisonSummary } from './corrected-dispatcher.js';
import type { EvalSample } from './test-run-binding.js';
import type { GateMetricName, GateMetricSpec, GatePolicySpec } from './gate-policy-binding.js';

/**
 * The promotion gate (evals step 4b): a policy's checks against a
 * comparison's summary. Pure; the promotion route and `…/check` both
 * call it, so a check answers exactly what a promotion would.
 */

/** One check, as the promotion records it and every client shows it. */
export interface GateCheck {
  /** Stable: `metric.weightedPrecisionAtK.minCandidate`, `replay.maxDiverged`, … */
  readonly name: string;
  readonly passed: boolean;
  /** A plain sentence saying what was found against what the policy asks. */
  readonly message: string;
  readonly value?: number | string;
  readonly threshold?: number | string;
}

/** What a passing promotion still needs: a reviewer's approval. */
export interface GateApproval {
  readonly role: ReviewerRole;
  /** How many reviewers decide (one, today). */
  readonly count: number;
  readonly separateApprover: boolean;
}

export interface GateInput {
  readonly spec: GatePolicySpec;
  /** What's being promoted. */
  readonly promotion: {
    readonly agentId: string;
    readonly version: string;
    /** The promoted version's `pinsDigest`; `null` for a version published before pins. */
    readonly pinsDigest: string | null;
    readonly scope: LiveScope;
  };
  /** The comparison named by `testRunId`; `null` when none was. */
  readonly summary: CorrectedComparisonSummary | null;
  /** The version serving the promotion's scope now: what "no regression" is measured against. */
  readonly servingVersion: string;
  /**
   * The org of the project the comparison's corrections came from (for an
   * org promotion). Absent: that project has no org, or none was looked up.
   */
  readonly summaryProjectOrgId?: string;
  readonly now: Date;
}

export interface GateResult {
  readonly checks: readonly GateCheck[];
  readonly passed: boolean;
  /** Set when the policy asks for an approval. */
  readonly approval?: GateApproval;
}

/** Room for float rounding in the metric comparisons. */
const EPSILON = 1e-9;

/** Whether the spec checks anything only a comparison shows. */
function needsComparison(spec: GatePolicySpec): boolean {
  return (
    spec.comparison !== undefined ||
    spec.evidence !== undefined ||
    (spec.metrics?.length ?? 0) > 0 ||
    spec.replay !== undefined ||
    spec.onlyExpertGroups === true
  );
}

export function gateApproval(spec: GatePolicySpec): GateApproval | undefined {
  if (spec.approvals === undefined) return undefined;
  return {
    role: spec.approvals.role ?? 'senior',
    count: 1,
    separateApprover: spec.approvals.separateApprover ?? true,
  };
}

export function evaluateGate(input: GateInput): GateResult {
  const { spec, summary } = input;
  const checks: GateCheck[] = [];
  const approval = gateApproval(spec);
  const required = needsComparison(spec);

  if (summary === null) {
    if (required) {
      checks.push({
        name: 'comparison.required',
        passed: false,
        message:
          'This policy needs a test run: name one with `testRunId` (a finished test run that tried this version on the test cases).',
      });
    }
    return result(checks, approval);
  }

  if (required) {
    checks.push({
      name: 'comparison.required',
      passed: true,
      message: `Test run ${summary.testRunId} is named.`,
    });
  }
  checks.push(statusCheck(spec, summary));
  if (spec.comparison?.maxAgeHours !== undefined) {
    checks.push(freshnessCheck(spec.comparison.maxAgeHours, summary, input.now));
  }
  if (spec.comparison?.testSet !== undefined)
    checks.push(testSetCheck(spec.comparison.testSet, summary));
  if (summary.sample !== undefined) checks.push(sampleCheck(summary.sample));
  checks.push(sameContentsCheck(input));
  checks.push(baselineCheck(summary, input));
  checks.push(scopeCheck(summary, input));
  if (spec.onlyExpertGroups === true) {
    const counted = summary.groupWeights ?? 'as-recorded';
    checks.push({
      name: 'groupWeights.expertsOnly',
      passed: counted === 'experts-only',
      message:
        counted === 'experts-only'
          ? "The test run counted only experts' corrections."
          : "The policy counts only experts' corrections; the test run counted everyone's. Re-run it with `groupWeights: 'experts-only'`.",
      value: counted,
      threshold: 'experts-only',
    });
  }
  if (spec.replay !== undefined) checks.push(...replayChecks(spec.replay, summary));
  for (const metric of spec.metrics ?? []) checks.push(...metricChecks(metric, spec, summary));
  return result(checks, approval);
}

function result(checks: readonly GateCheck[], approval: GateApproval | undefined): GateResult {
  return {
    checks,
    passed: checks.every((c) => c.passed),
    ...(approval !== undefined && { approval }),
  };
}

function statusCheck(spec: GatePolicySpec, summary: CorrectedComparisonSummary): GateCheck {
  const maxErrors = spec.replay?.maxErrors ?? 0;
  const base = { name: 'comparison.status', value: summary.status } as const;
  if (summary.status === 'completed') {
    return { ...base, passed: true, message: 'The test run completed.' };
  }
  if (summary.status === 'partial' && summary.errors <= maxErrors) {
    return {
      ...base,
      passed: true,
      message: `The test run finished with ${count(summary.errors, 'case')} in error; the policy allows ${maxErrors}.`,
      threshold: maxErrors,
    };
  }
  return {
    ...base,
    passed: false,
    message:
      summary.status === 'failed'
        ? 'The test run failed.'
        : `The test run finished with ${count(summary.errors, 'case')} in error; the policy allows ${maxErrors}.`,
    ...(summary.status === 'partial' && { threshold: maxErrors }),
  };
}

function freshnessCheck(
  maxAgeHours: number,
  summary: CorrectedComparisonSummary,
  now: Date,
): GateCheck {
  const ageHours = (now.getTime() - new Date(summary.completedAt).getTime()) / 3_600_000;
  const passed = ageHours <= maxAgeHours;
  return {
    name: 'comparison.freshness',
    passed,
    message: `The test run finished ${round(ageHours)} hours ago; the policy accepts up to ${maxAgeHours}.`,
    value: round(ageHours),
    threshold: maxAgeHours,
  };
}

function testSetCheck(
  testSet: { readonly id: string; readonly version?: string },
  summary: CorrectedComparisonSummary,
): GateCheck {
  const ran = `${summary.testSet.id} ${summary.testSet.version}`;
  const wanted = testSet.version === undefined ? testSet.id : `${testSet.id} ${testSet.version}`;
  const passed =
    summary.testSet.id === testSet.id &&
    (testSet.version === undefined || summary.testSet.version === testSet.version);
  return {
    name: 'comparison.testSet',
    passed,
    message: passed
      ? `The test run used test cases ${ran}.`
      : `The test run used test cases ${ran}; the policy needs ${wanted}.`,
    value: ran,
    threshold: wanted,
  };
}

/**
 * A comparison on part of the test set: the hold-out part proves a
 * candidate; the search part chose it, so its numbers flatter it.
 */
function sampleCheck(sample: EvalSample): GateCheck {
  const passed = sample.part === 'hold-out';
  return {
    name: 'comparison.sample',
    passed,
    message: passed
      ? `The test run used the cases Improve didn't learn from (seed ${sample.seed}).`
      : "The test run used the cases Improve learned from, which chose this version: try it on the cases Improve didn't learn from, or on all the test cases.",
    value: sample.part,
    threshold: 'hold-out',
  };
}

function sameContentsCheck(input: GateInput): GateCheck {
  const { promotion, summary } = input;
  const candidate = summary?.candidate;
  const name = 'sameContents';
  const promoted = `${promotion.agentId} ${promotion.version}`;
  if (candidate === undefined || candidate.kind !== 'agent') {
    return {
      name,
      passed: false,
      message: `The test run tried a flow; try the agent itself (${promoted}) on the test cases.`,
    };
  }
  const compared = `${candidate.agentId} ${candidate.version}`;
  if (candidate.overrides !== undefined) {
    return {
      name,
      passed: false,
      message: `The test run tried ${compared} with other content for ${[...(candidate.overrides.settings ?? []), ...(candidate.overrides.prompts ?? [])].join(', ')} than it pins (one of the changes Improve tried): try the published version on the test cases.`,
    };
  }
  if (candidate.agentId !== promotion.agentId || candidate.version !== promotion.version) {
    return {
      name,
      passed: false,
      message: `The test run tried ${compared}, not ${promoted}.`,
      value: compared,
      threshold: promoted,
    };
  }
  if (promotion.pinsDigest === null) {
    return {
      name,
      passed: false,
      message: `${promoted} was published before versions recorded their pins: republish it to pin it, then try that version on the test cases.`,
    };
  }
  if (candidate.pinsDigest === undefined) {
    return {
      name,
      passed: false,
      message: 'The test run predates recording what it tried (its pinsDigest): re-run it.',
    };
  }
  const passed = candidate.pinsDigest === promotion.pinsDigest;
  return {
    name,
    passed,
    message: passed
      ? `The test run tried ${promoted} with the same pins.`
      : `The test run tried ${promoted} with other pins than it has now: re-run it.`,
    value: candidate.pinsDigest,
    threshold: promotion.pinsDigest,
  };
}

function baselineCheck(summary: CorrectedComparisonSummary, input: GateInput): GateCheck {
  const name = 'baselineIsLive';
  const serving = `${input.promotion.agentId} ${input.servingVersion}`;
  const versions =
    summary.baseline.kind === 'recorded'
      ? summary.baseline.versions.map((v) =>
          'agentId' in v ? `${v.agentId} ${v.version}` : `flow ${v.flowId} ${v.version}`,
        )
      : [`${summary.baseline.agentId} ${summary.baseline.version}`];
  if (versions.length !== 1) {
    return {
      name,
      passed: false,
      message: `The test run measured this version against ${versions.length} versions (${versions.join(', ')}); it must be measured against the live version, ${serving}.`,
      value: versions.join(', '),
      threshold: serving,
    };
  }
  const passed = versions[0] === serving;
  return {
    name,
    passed,
    message: passed
      ? `The test run measured this version against the live version, ${serving}.`
      : `The test run measured this version against ${versions[0]}; the live version is ${serving}. Re-run it against that one.`,
    value: versions[0] ?? '',
    threshold: serving,
  };
}

function scopeCheck(summary: CorrectedComparisonSummary, input: GateInput): GateCheck {
  const name = 'scopeCovered';
  const from = summary.scope.projectId;
  const scope = input.promotion.scope;
  const correctedIn = from === undefined ? 'every project' : `project ${from}`;
  switch (scope.kind) {
    case 'tenant':
      return { name, passed: true, message: `The corrections came from ${correctedIn}.` };
    case 'org': {
      const passed = from === undefined || input.summaryProjectOrgId === scope.orgId;
      return {
        name,
        passed,
        message: !passed
          ? `The corrections came from ${correctedIn}, outside org ${scope.orgId}.`
          : from === undefined
            ? `The corrections came from every project, which covers org ${scope.orgId}.`
            : `The corrections came from ${correctedIn}, within org ${scope.orgId}.`,
      };
    }
    case 'project':
    case 'segment': {
      const passed = from === scope.projectId;
      return {
        name,
        passed,
        message: passed
          ? `The corrections came from project ${scope.projectId}, the one it goes live in.`
          : `The corrections came from ${correctedIn}; it goes live in project ${scope.projectId}, so it needs that project's corrections.`,
      };
    }
  }
}

const REPLAY_KNOBS = [
  [
    'maxDiverged',
    'diverged',
    'case diverged from its recorded reads',
    'cases diverged from their recorded reads',
  ],
  ['maxErrors', 'errors', 'case errored', 'cases errored'],
  ['maxRefusedWrites', 'refusedWrites', 'tool call was refused', 'tool calls were refused'],
  [
    'maxStopped',
    'stopped',
    'case stopped at a refused tool call',
    'cases stopped at a refused tool call',
  ],
] as const;

function replayChecks(
  replay: NonNullable<GatePolicySpec['replay']>,
  summary: CorrectedComparisonSummary,
): GateCheck[] {
  return REPLAY_KNOBS.map(([knob, field, one, many]) => {
    const max = replay[knob] ?? 0;
    const value = summary[field];
    return {
      name: `replay.${knob}`,
      passed: value <= max,
      message: `${value} ${value === 1 ? one : many}; the policy allows ${max}.`,
      value,
      threshold: max,
    };
  });
}

function metricLabel(name: GateMetricName, metric: ComparisonMetric): string {
  switch (name) {
    case 'weightedYesShare':
      return 'The weighted share marked right';
    case 'judgedCoverage':
      return 'The share of answers corrected';
    case 'weightedPrecisionAtK':
      return `Precision at ${metric.k ?? 'k'}`;
  }
}

function metricChecks(
  spec: GateMetricSpec,
  policy: GatePolicySpec,
  summary: CorrectedComparisonSummary,
): GateCheck[] {
  const metric = summary.metrics[spec.name];
  const label = metricLabel(spec.name, metric);
  const at = `metric.${spec.name}`;
  const checks: GateCheck[] = [];
  if (spec.name === 'weightedPrecisionAtK' && spec.k !== undefined) {
    checks.push({
      name: `${at}.k`,
      passed: metric.k === spec.k,
      message:
        metric.k === spec.k
          ? `The test run ranked the top ${spec.k}, as the policy asks.`
          : `The test run ranked the top ${metric.k ?? '?'}; the policy checks the top ${spec.k}. Re-run it with \`k: ${spec.k}\`.`,
      ...(metric.k !== undefined && { value: metric.k }),
      threshold: spec.k,
    });
  }
  checks.push(...evidenceChecks(spec, policy, metric, label));
  if (spec.minCandidate !== undefined) {
    const value = metric.candidate;
    checks.push({
      name: `${at}.minCandidate`,
      passed: value !== null && value + EPSILON >= spec.minCandidate,
      message:
        value === null
          ? `${label} has no corrected answers for this version; the policy needs at least ${fmt(spec.minCandidate)}.`
          : `${label} is ${fmt(value)}; the policy needs at least ${fmt(spec.minCandidate)}.`,
      ...(value !== null && { value: round(value) }),
      threshold: spec.minCandidate,
    });
  }
  if (spec.maxDrop !== undefined) {
    const { candidate, baseline } = metric;
    const floor = baseline === null ? null : baseline - spec.maxDrop;
    checks.push({
      name: `${at}.maxDrop`,
      passed: candidate !== null && floor !== null && candidate + EPSILON >= floor,
      message:
        candidate === null || baseline === null
          ? `${label} can't be compared: ${candidate === null ? 'this version' : 'the live version'} has no corrected answers.`
          : `${label} is ${fmt(candidate)} against the live version's ${fmt(baseline)}; the policy allows a drop of at most ${fmt(spec.maxDrop)}.`,
      ...(candidate !== null && baseline !== null && { value: round(candidate - baseline) }),
      threshold: -spec.maxDrop,
    });
  }
  return checks;
}

function evidenceChecks(
  spec: GateMetricSpec,
  policy: GatePolicySpec,
  metric: ComparisonMetric,
  label: string,
): GateCheck[] {
  const evidence = policy.evidence;
  if (evidence === undefined) return [];
  const at = `evidence.${spec.name}`;
  const sides: { prefix: string; whose: string; n: number; weight: number }[] = [
    { prefix: '', whose: 'this version', n: metric.n, weight: metric.weight },
  ];
  // "No regression" means nothing on a baseline with two corrections.
  if (spec.maxDrop !== undefined) {
    sides.push({
      prefix: 'baseline',
      whose: 'the live version',
      n: metric.baselineN,
      weight: metric.baselineWeight,
    });
  }
  const checks: GateCheck[] = [];
  for (const side of sides) {
    const key = (k: 'MinCases' | 'MinWeight') =>
      side.prefix === '' ? `${at}.${k[0]?.toLowerCase()}${k.slice(1)}` : `${at}.${side.prefix}${k}`;
    if (evidence.minCases !== undefined) {
      checks.push({
        name: key('MinCases'),
        passed: side.n >= evidence.minCases,
        message: `${label} rests on ${count(side.n, 'corrected case')} for ${side.whose}; the policy needs at least ${evidence.minCases}.`,
        value: side.n,
        threshold: evidence.minCases,
      });
    }
    if (evidence.minWeight !== undefined) {
      checks.push({
        name: key('MinWeight'),
        passed: side.weight + EPSILON >= evidence.minWeight,
        message: `${label} rests on corrections weighing ${fmt(side.weight)} for ${side.whose}; the policy needs at least ${fmt(evidence.minWeight)}.`,
        value: round(side.weight),
        threshold: evidence.minWeight,
      });
    }
  }
  return checks;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmt(n: number): string {
  return String(round(n));
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

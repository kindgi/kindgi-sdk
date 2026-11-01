// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReviewerRole } from '@kindgi/authz';
import type { AgentPinScope } from '@kindgi/types';

import type { ComparisonMetric, CorrectedComparisonSummary } from './corrected-dispatcher.js';
import type { GateMetricName, GateMetricSpec, ReleaseGateSpec } from './release-gate-binding.js';
import type { TestRunSample } from './test-run-binding.js';

/**
 * The release gate: a gate's checks against a
 * comparison's summary. Pure; the pin route and `…/check` both call it,
 * so a check answers exactly what a pin would.
 */

/** One check, as the pin records it and every client shows it. */
export interface GateCheck {
  /** Stable: `metric.weightedPrecisionAtK.minCandidate`, `replay.maxDiverged`, … */
  readonly name: string;
  readonly passed: boolean;
  /** A plain sentence saying what was found against what the gate asks. */
  readonly message: string;
  readonly value?: number | string;
  readonly threshold?: number | string;
  /** The cases it names: for `cases.noNewFailures`, the ones that passed before and fail now. */
  readonly caseIds?: readonly string[];
}

/** What a passing pin still needs: a reviewer's approval. */
export interface GateApproval {
  readonly role: ReviewerRole;
  /** How many reviewers decide (one, today). */
  readonly count: number;
  readonly separateApprover: boolean;
}

export interface GateInput {
  readonly spec: ReleaseGateSpec;
  /** What's being pinned. */
  readonly pin: {
    readonly agentId: string;
    readonly version: string;
    /** The version's `pinsDigest`; `null` for a version published before pins. */
    readonly pinsDigest: string | null;
    readonly scope: AgentPinScope;
  };
  /** The comparison named by `testRunId`; `null` when none was. */
  readonly summary: CorrectedComparisonSummary | null;
  /** The version serving the pin's scope now: what "no regression" is measured against. */
  readonly servingVersion: string;
  /**
   * The org of the project the comparison's corrections came from (for an
   * org pin). Absent: that project has no org, or none was looked up.
   */
  readonly summaryProjectOrgId?: string;
  /**
   * For `cases.noNewFailures`: the comparison's corrections that are
   * `fixed` now, so passed before. Absent: they weren't read, and the
   * check fails.
   */
  readonly passedBefore?: readonly string[];
  readonly now: Date;
}

export interface GateResult {
  readonly checks: readonly GateCheck[];
  readonly passed: boolean;
  /** Set when the gate asks for an approval. */
  readonly approval?: GateApproval;
}

/** Room for float rounding in the metric comparisons. */
const EPSILON = 1e-9;

/** Whether the spec checks anything only a comparison shows. */
function needsComparison(spec: ReleaseGateSpec): boolean {
  return (
    spec.comparison !== undefined ||
    spec.evidence !== undefined ||
    (spec.metrics?.length ?? 0) > 0 ||
    spec.replay !== undefined ||
    spec.cases !== undefined ||
    spec.onlyExpertGroups === true
  );
}

export function gateApproval(spec: ReleaseGateSpec): GateApproval | undefined {
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
          'This release gate needs a test run: name one with `testRunId` (a completed test run that tried this version on the test cases).',
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
          : "The gate counts only experts' corrections; the test run counted everyone's. Re-run it with `groupWeights: 'experts-only'`.",
      value: counted,
      threshold: 'experts-only',
    });
  }
  if (spec.replay !== undefined) checks.push(...replayChecks(spec.replay, summary));
  for (const metric of spec.metrics ?? []) checks.push(...metricChecks(metric, spec, summary));
  if (spec.cases !== undefined)
    checks.push(...casesChecks(spec.cases, summary, input.passedBefore));
  return result(checks, approval);
}

/**
 * A refusal's figures for the gate's `cases` rule, read off its checks:
 * `passing` and `needs` with `minPassing`, and `newlyFailing` with
 * `noNewFailures` once it could tell. Empty without the rule.
 */
export function casesDetails(checks: readonly GateCheck[]): {
  readonly passing?: number;
  readonly needs?: number;
  readonly newlyFailing?: readonly string[];
} {
  const min = checks.find((c) => c.name === 'cases.minPassing');
  const none = checks.find((c) => c.name === 'cases.noNewFailures');
  return {
    ...(typeof min?.value === 'number' && { passing: min.value }),
    ...(typeof min?.threshold === 'number' && { needs: min.threshold }),
    ...(none?.caseIds !== undefined && { newlyFailing: none.caseIds }),
  };
}

function result(checks: readonly GateCheck[], approval: GateApproval | undefined): GateResult {
  return {
    checks,
    passed: checks.every((c) => c.passed),
    ...(approval !== undefined && { approval }),
  };
}

function statusCheck(spec: ReleaseGateSpec, summary: CorrectedComparisonSummary): GateCheck {
  const maxErrors = spec.replay?.maxErrors ?? 0;
  const base = { name: 'comparison.status', value: summary.status } as const;
  if (summary.status === 'completed') {
    return { ...base, passed: true, message: 'The test run completed.' };
  }
  if (summary.status === 'partial' && summary.errors <= maxErrors) {
    return {
      ...base,
      passed: true,
      message: `The test run finished with ${count(summary.errors, 'case')} in error; the gate allows ${maxErrors}.`,
      threshold: maxErrors,
    };
  }
  return {
    ...base,
    passed: false,
    message:
      summary.status === 'failed'
        ? 'The test run failed.'
        : `The test run finished with ${count(summary.errors, 'case')} in error; the gate allows ${maxErrors}.`,
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
    message: `The test run finished ${round(ageHours)} hours ago; the gate accepts up to ${maxAgeHours}.`,
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
      : `The test run used test cases ${ran}; the gate needs ${wanted}.`,
    value: ran,
    threshold: wanted,
  };
}

/**
 * A comparison on part of the test set: the hold-out part proves a
 * candidate; the search part chose it, so its numbers flatter it.
 */
function sampleCheck(sample: TestRunSample): GateCheck {
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
  const { pin, summary } = input;
  const candidate = summary?.candidate;
  const name = 'sameContents';
  const target = `${pin.agentId} ${pin.version}`;
  if (candidate === undefined || candidate.kind !== 'agent') {
    return {
      name,
      passed: false,
      message: `The test run tried a flow; try the agent itself (${target}) on the test cases.`,
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
  if (candidate.agentId !== pin.agentId || candidate.version !== pin.version) {
    return {
      name,
      passed: false,
      message: `The test run tried ${compared}, not ${target}.`,
      value: compared,
      threshold: target,
    };
  }
  if (pin.pinsDigest === null) {
    return {
      name,
      passed: false,
      message: `${target} was published before versions recorded their pins: republish it to pin it, then try that version on the test cases.`,
    };
  }
  if (candidate.pinsDigest === undefined) {
    return {
      name,
      passed: false,
      message: 'The test run predates recording what it tried (its pinsDigest): re-run it.',
    };
  }
  const passed = candidate.pinsDigest === pin.pinsDigest;
  return {
    name,
    passed,
    message: passed
      ? `The test run tried ${target} with the same pins.`
      : `The test run tried ${target} with other pins than it has now: re-run it.`,
    value: candidate.pinsDigest,
    threshold: pin.pinsDigest,
  };
}

function baselineCheck(summary: CorrectedComparisonSummary, input: GateInput): GateCheck {
  const name = 'baselineIsPinned';
  const serving = `${input.pin.agentId} ${input.servingVersion}`;
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
      message: `The test run measured this version against ${versions.length} versions (${versions.join(', ')}); it must be measured against the pinned version, ${serving}.`,
      value: versions.join(', '),
      threshold: serving,
    };
  }
  const passed = versions[0] === serving;
  return {
    name,
    passed,
    message: passed
      ? `The test run measured this version against the pinned version, ${serving}.`
      : `The test run measured this version against ${versions[0]}; the pinned version is ${serving}. Re-run it against that one.`,
    value: versions[0] ?? '',
    threshold: serving,
  };
}

function scopeCheck(summary: CorrectedComparisonSummary, input: GateInput): GateCheck {
  const name = 'scopeCovered';
  const from = summary.scope.projectId;
  const scope = input.pin.scope;
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
          ? `The corrections came from project ${scope.projectId}, the one it is being pinned in.`
          : `The corrections came from ${correctedIn}; it is being pinned in project ${scope.projectId}, so it needs that project's corrections.`,
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
  replay: NonNullable<ReleaseGateSpec['replay']>,
  summary: CorrectedComparisonSummary,
): GateCheck[] {
  return REPLAY_KNOBS.map(([knob, field, one, many]) => {
    const max = replay[knob] ?? 0;
    const value = summary[field];
    return {
      name: `replay.${knob}`,
      passed: value <= max,
      message: `${value} ${value === 1 ? one : many}; the gate allows ${max}.`,
      value,
      threshold: max,
    };
  });
}

/** Cases a failing check lists by id in its message; `caseIds` has them all. */
const LISTED_CASES = 5;

/** How many of the comparison's cases pass, and whether one that passed before fails now. */
function casesChecks(
  cases: NonNullable<ReleaseGateSpec['cases']>,
  summary: CorrectedComparisonSummary,
  passedBefore: readonly string[] | undefined,
): GateCheck[] {
  const graded = summary.corrections;
  const checks: GateCheck[] = [];
  if (cases.minPassing !== undefined) {
    const passing = graded?.passed ?? 0;
    const needs = cases.minPassing;
    checks.push({
      name: 'cases.minPassing',
      passed: passing >= needs,
      message: `${passing} of ${count(graded?.checked ?? 0, 'case')} pass; the gate needs at least ${needs}.`,
      value: passing,
      threshold: needs,
    });
  }
  if (cases.noNewFailures === true) checks.push(noNewFailuresCheck(graded, passedBefore));
  return checks;
}

function noNewFailuresCheck(
  graded: CorrectedComparisonSummary['corrections'],
  passedBefore: readonly string[] | undefined,
): GateCheck {
  const name = 'cases.noNewFailures';
  if (passedBefore === undefined) {
    return {
      name,
      passed: false,
      message:
        "The cases that passed before couldn't be read, so the gate can't tell whether one fails now.",
    };
  }
  if (graded !== undefined && graded.results === undefined) {
    return {
      name,
      passed: false,
      message:
        "The test run doesn't say how each case did (it was recorded before that was kept): run it again.",
    };
  }
  const before = new Set(passedBefore);
  const { checked, caseIds } = newlyFailing(graded?.results ?? [], before);
  return {
    name,
    passed: caseIds.length === 0,
    message: noNewFailuresMessage(checked, before.size, caseIds),
    value: caseIds.length,
    threshold: 0,
    caseIds,
  };
}

/**
 * Of the graded corrections that passed before: how many the run
 * checked, and the ones it failed. A correction graded on more than one
 * case fails when any of them does.
 */
function newlyFailing(
  results: readonly { readonly correctionId: string; readonly pass: boolean }[],
  before: ReadonlySet<string>,
): { checked: number; caseIds: string[] } {
  const checked = new Set<string>();
  const failing = new Set<string>();
  for (const r of results) {
    if (!before.has(r.correctionId)) continue;
    checked.add(r.correctionId);
    if (!r.pass) failing.add(r.correctionId);
  }
  return { checked: checked.size, caseIds: [...failing] };
}

/**
 * What the check found, always with how many of the cases fixed now the
 * run graded: one it didn't grade isn't counted either way.
 */
function noNewFailuresMessage(checked: number, fixed: number, caseIds: readonly string[]): string {
  if (fixed === 0) return 'No case is fixed now, so none that passed before can fail.';
  const of = `${checked === 0 ? 'none' : checked} of the ${count(fixed, 'case')} fixed now`;
  if (caseIds.length > 0) {
    const listed = caseIds.slice(0, LISTED_CASES).join(', ');
    const more = caseIds.length - LISTED_CASES;
    const verb = caseIds.length === 1 ? 'fails' : 'fail';
    return `${count(caseIds.length, 'case')} that passed before ${verb} now: ${listed}${more > 0 ? `, and ${more} more` : ''}. The test run checked ${of}.`;
  }
  if (checked === 0) return `The test run checked ${of}.`;
  return `The test run checked ${of}, and ${checked === 1 ? 'it still passes' : 'they all still pass'}.`;
}

function metricLabel(name: GateMetricName, metric: ComparisonMetric): string {
  switch (name) {
    case 'passRate':
      return 'The weighted share marked right';
    case 'caseCoverage':
      return 'The share of answers corrected';
    case 'weightedPrecisionAtK':
      return `Precision at ${metric.k ?? 'k'}`;
  }
}

function metricChecks(
  spec: GateMetricSpec,
  gate: ReleaseGateSpec,
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
          ? `The test run ranked the top ${spec.k}, as the gate asks.`
          : `The test run ranked the top ${metric.k ?? '?'}; the gate checks the top ${spec.k}. Re-run it with \`k: ${spec.k}\`.`,
      ...(metric.k !== undefined && { value: metric.k }),
      threshold: spec.k,
    });
  }
  checks.push(...evidenceChecks(spec, gate, metric, label));
  if (spec.minCandidate !== undefined) {
    const value = metric.candidate;
    checks.push({
      name: `${at}.minCandidate`,
      passed: value !== null && value + EPSILON >= spec.minCandidate,
      message:
        value === null
          ? `${label} has no corrected answers for this version; the gate needs at least ${fmt(spec.minCandidate)}.`
          : `${label} is ${fmt(value)}; the gate needs at least ${fmt(spec.minCandidate)}.`,
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
          ? `${label} can't be compared: ${candidate === null ? 'this version' : 'the pinned version'} has no corrected answers.`
          : `${label} is ${fmt(candidate)} against the pinned version's ${fmt(baseline)}; the gate allows a drop of at most ${fmt(spec.maxDrop)}.`,
      ...(candidate !== null && baseline !== null && { value: round(candidate - baseline) }),
      threshold: -spec.maxDrop,
    });
  }
  return checks;
}

function evidenceChecks(
  spec: GateMetricSpec,
  gate: ReleaseGateSpec,
  metric: ComparisonMetric,
  label: string,
): GateCheck[] {
  const evidence = gate.evidence;
  if (evidence === undefined) return [];
  const at = `evidence.${spec.name}`;
  const sides: { prefix: string; whose: string; n: number; weight: number }[] = [
    { prefix: '', whose: 'this version', n: metric.n, weight: metric.weight },
  ];
  // "No regression" means nothing on a baseline with two corrections.
  if (spec.maxDrop !== undefined) {
    sides.push({
      prefix: 'baseline',
      whose: 'the pinned version',
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
        message: `${label} rests on ${count(side.n, 'corrected case')} for ${side.whose}; the gate needs at least ${evidence.minCases}.`,
        value: side.n,
        threshold: evidence.minCases,
      });
    }
    if (evidence.minWeight !== undefined) {
      checks.push({
        name: key('MinWeight'),
        passed: side.weight + EPSILON >= evidence.minWeight,
        message: `${label} rests on corrections weighing ${fmt(side.weight)} for ${side.whose}; the gate needs at least ${fmt(evidence.minWeight)}.`,
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

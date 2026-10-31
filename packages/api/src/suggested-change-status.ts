// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Pin } from './agent-pin-binding.js';
import type { CorrectedComparisonSummary } from './corrected-dispatcher.js';
import type {
  ProposedChange,
  StoredSuggestedChange,
  SuggestedChangeDrafter,
  SuggestedChangeMaker,
  SuggestedChangeObjective,
  SuggestedChangeRule,
} from './supervisor-binding.js';
import type { TestRun, TestRunStatus } from './test-run-binding.js';

/**
 * Where a suggested change stands. Never stored: it follows from its own
 * steps, its check's test runs and its pin.
 *
 * - `checking`: its check's runs are queued or running.
 * - `check-failed`: its check failed or was cancelled, or never started
 *   (its check `not-started`).
 * - `ready`: its check finished; the scores say how it did. A pin the
 *   gate refused, a second person rejected or that expired leaves it here,
 *   with a note.
 * - `waiting-for-second-person`: pinned, and the approval is open.
 * - `pinned`: its version was pinned in its project.
 * - `added-as-latest`: its version was added as its project's Latest.
 * - `withdrawn`: withdrawn.
 */
export type SuggestedChangeStatus =
  | 'checking'
  | 'check-failed'
  | 'ready'
  | 'waiting-for-second-person'
  | 'pinned'
  | 'added-as-latest'
  | 'withdrawn';

export const SUGGESTED_CHANGE_STATUSES: readonly SuggestedChangeStatus[] = [
  'checking',
  'check-failed',
  'ready',
  'waiting-for-second-person',
  'pinned',
  'added-as-latest',
  'withdrawn',
];

/**
 * Why a `ready` suggested change was asked to be pinned and wasn't: the
 * release gate refused it, a second person rejected it, the approval
 * expired, or the project's version or release gate changed before it was
 * approved.
 */
export type SuggestedChangeNote =
  | {
      readonly kind: 'gate-refused' | 'rejected' | 'expired' | 'superseded';
      readonly pinChangeId: string;
    }
  /**
   * A deploy's suggested change: what its project runs (`version`) isn't
   * running to be checked against, and has no finished run on the same
   * cases, so its check has no `now`.
   */
  | { readonly kind: 'not-running'; readonly version: string };

/** What a finished comparison says about the candidate, on the suggested change's objective. */
export interface SuggestedChangeEvaluationOutcome {
  readonly runStatus: TestRunStatus;
  readonly objective: SuggestedChangeObjective;
  /** The recorded (corrected) outputs' score. `null` without evidence from corrections. */
  readonly baseline?: number | null;
  readonly candidate?: number | null;
  readonly delta?: number | null;
  /** With more than one repetition: the candidate's max − min. The noise a delta must beat. */
  readonly spread?: number;
  readonly cases?: number;
  /** Set once the comparison finished. */
  readonly better?: boolean;
  /** How the candidate is kept (`SuggestedChangeEvaluationRef.rule`). Absent: `better`. */
  readonly rule?: SuggestedChangeRule;
  /** With a reference: its test run's status (the candidate's is `runStatus`). */
  readonly referenceStatus?: TestRunStatus;
  /** With a reference, once both finished: each side's replays' cost, when both reported one. */
  readonly costUsd?: { readonly current: number; readonly candidate: number };
  /** With a reference, once both finished: the corrections the current version was checked on. */
  readonly decisions?: SuggestedChangeDecisions;
  /**
   * With a reference, once both finished: whether the candidate is kept
   * under its rule, its decisions kept; `notKept` says why not.
   */
  readonly kept?: boolean;
  readonly notKept?: SuggestedChangeNotKept;
  /** Once the candidate's run finished: the test set version it ran. */
  readonly testSetVersion?: string;
  /** Once the candidate's run finished: how it did. */
  readonly with?: SuggestedChangeSide;
  /** With a reference, once both finished: how the current version did on the same cases. */
  readonly now?: SuggestedChangeSide;
  /**
   * With a reference, once both finished: the corrections the current
   * version passes and the candidate fails, by id.
   */
  readonly newlyFailing?: readonly string[];
}

/** How one version did on a check's cases. */
export interface SuggestedChangeSide {
  /** The corrections it passed (every repetition did). */
  readonly passing: number;
  /** The corrections it was checked on. */
  readonly of: number;
  /**
   * Its replays' cost in model calls, in US dollars: the total over
   * `cases`, the cases whose every repetition reported one, averaged over
   * the repetitions. Absent when no case's did.
   */
  readonly costUsd?: { readonly total: number; readonly cases: number };
}

/**
 * The corrections the current version (the reference) was checked on,
 * against the candidate: `held`, it passed them and so did the candidate;
 * `broken`, it passed them and the candidate didn't; `stillWrong`,
 * neither passed. The rest the candidate fixed.
 */
export interface SuggestedChangeDecisions {
  readonly checked: number;
  readonly held: number;
  readonly broken: number;
  readonly stillWrong: number;
}

/**
 * Why a candidate with a reference isn't kept, the first that applies:
 * no correction was checked; one the current version passes broke; the
 * two comparisons didn't run the same cases (the candidate errored on
 * one, or they counted others); it's no better (`better`) or worse than
 * the current version (`cheaper`); it doesn't cost less beyond the
 * cost's own spread.
 */
export type SuggestedChangeNotKept =
  | 'no-decisions'
  | 'decisions-broken'
  | 'other-cases'
  | 'not-better'
  | 'worse'
  | 'not-cheaper';

/** Room for float rounding. */
const EPSILON = 1e-9;

/** A finished comparison's summary, or `null` for any other test run. */
export function comparisonSummaryOf(run: TestRun): CorrectedComparisonSummary | null {
  const summary = run.result?.summary;
  return run.kind === 'corrections' && summary !== null && typeof summary === 'object'
    ? (summary as CorrectedComparisonSummary)
    : null;
}

/**
 * The suggested change's evaluation, read off its test run, and with a reference
 * (the current version replayed on the same cases) held to it under its
 * rule.
 */
export function evaluationOutcome(
  objective: SuggestedChangeObjective,
  run: TestRun,
  against?: { readonly rule: SuggestedChangeRule; readonly reference: TestRun },
): SuggestedChangeEvaluationOutcome {
  const rule = against !== undefined && { rule: against.rule };
  const referenceStatus = against !== undefined && { referenceStatus: against.reference.status };
  const summary = run.status === 'completed' ? comparisonSummaryOf(run) : null;
  if (summary === null) return { runStatus: run.status, objective, ...rule, ...referenceStatus };
  const metric = summary.metrics[objective];
  const noise = metric.spread ?? 0;
  const better = metric.delta !== null && metric.delta > noise + EPSILON;
  const reference =
    against?.reference.status === 'completed' ? comparisonSummaryOf(against.reference) : null;
  return {
    runStatus: run.status,
    objective,
    baseline: metric.baseline,
    candidate: metric.candidate,
    delta: metric.delta,
    ...(metric.spread !== undefined && { spread: metric.spread }),
    cases: summary.cases,
    better,
    ...rule,
    ...referenceStatus,
    testSetVersion: summary.testSet.version,
    with: sideOf(summary),
    ...(against !== undefined &&
      reference !== null && {
        ...heldTo(objective, against.rule, summary, reference, better),
        now: sideOf(reference),
        newlyFailing: newlyFailingOf(reference, summary),
      }),
  };
}

/** How a finished comparison's candidate did. */
function sideOf(summary: CorrectedComparisonSummary): SuggestedChangeSide {
  const cost = summary.costUsd;
  return {
    passing: summary.corrections?.passed ?? 0,
    of: summary.corrections?.checked ?? 0,
    ...(cost !== undefined && { costUsd: { total: cost.candidate, cases: cost.cases } }),
  };
}

/** The corrections the reference passed and the candidate didn't, by id. */
function newlyFailingOf(
  reference: CorrectedComparisonSummary,
  candidate: CorrectedComparisonSummary,
): string[] {
  const passed = new Set(
    (candidate.corrections?.results ?? []).filter((j) => j.pass).map((j) => j.correctionId),
  );
  return (reference.corrections?.results ?? [])
    .filter((j) => j.pass && !passed.has(j.correctionId))
    .map((j) => j.correctionId);
}

/** A finished candidate held to its finished reference under the rule. */
function heldTo(
  objective: SuggestedChangeObjective,
  rule: SuggestedChangeRule,
  candidate: CorrectedComparisonSummary,
  reference: CorrectedComparisonSummary,
  better: boolean,
): Pick<SuggestedChangeEvaluationOutcome, 'costUsd' | 'decisions' | 'kept' | 'notKept'> {
  const decisions = decisionsOf(reference, candidate);
  const current = reference.costUsd;
  const cost = candidate.costUsd;
  let notKept: SuggestedChangeNotKept | undefined;
  if (decisions.checked === 0) notKept = 'no-decisions';
  else if (decisions.broken > 0) notKept = 'decisions-broken';
  else if (rule === 'better') notKept = better ? undefined : 'not-better';
  else notKept = notCheaper(objective, candidate, reference);
  return {
    ...(current !== undefined &&
      cost !== undefined && {
        costUsd: { current: current.candidate, candidate: cost.candidate },
      }),
    decisions,
    kept: notKept === undefined,
    ...(notKept !== undefined && { notKept }),
  };
}

/**
 * Under `cheaper`, why the candidate isn't kept: it didn't run the same
 * cases with a cost for each, it's worse beyond the reference's spread,
 * or it doesn't cost less beyond the cost's own; `undefined` when it's kept.
 */
function notCheaper(
  objective: SuggestedChangeObjective,
  candidate: CorrectedComparisonSummary,
  reference: CorrectedComparisonSummary,
): SuggestedChangeNotKept | undefined {
  const current = reference.costUsd;
  const cost = candidate.costUsd;
  if (
    candidate.errors !== 0 ||
    candidate.cases !== reference.cases ||
    current === undefined ||
    cost === undefined ||
    cost.cases !== current.cases
  ) {
    return 'other-cases';
  }
  const mine = candidate.metrics[objective].candidate;
  const theirs = reference.metrics[objective];
  if (mine === null || theirs.candidate === null) return 'worse';
  if (mine < theirs.candidate - (theirs.spread ?? 0) - EPSILON) return 'worse';
  return current.candidate - cost.candidate > (current.spread ?? 0) + EPSILON
    ? undefined
    : 'not-cheaper';
}

/** The corrections the reference was checked on, against the candidate's, by correction. */
function decisionsOf(
  reference: CorrectedComparisonSummary,
  candidate: CorrectedComparisonSummary,
): SuggestedChangeDecisions {
  const passed = new Set(
    (candidate.corrections?.results ?? []).filter((j) => j.pass).map((j) => j.correctionId),
  );
  let held = 0;
  let broken = 0;
  let stillWrong = 0;
  const checked = reference.corrections?.results ?? [];
  for (const j of checked) {
    const kept = passed.has(j.correctionId);
    if (j.pass && kept) held += 1;
    else if (j.pass) broken += 1;
    else if (!kept) stillWrong += 1;
  }
  return { checked: checked.length, held, broken, stillWrong };
}

const PIN_NOTE: Readonly<
  Record<
    'refused' | 'rejected' | 'expired' | 'superseded',
    Exclude<SuggestedChangeNote['kind'], 'not-running'>
  >
> = {
  refused: 'gate-refused',
  rejected: 'rejected',
  expired: 'expired',
  superseded: 'superseded',
};

/**
 * A suggested change's status from what's recorded: its own steps first
 * (withdrawn, added as Latest, rolled back), then its pin, then its
 * check. `pin` and `evaluation` are what its ids resolve to
 * (`undefined` when it has none). One stored before these statuses reads
 * the same way: a rollback was a pin, and a draft never checked is
 * `check-failed`.
 */
export function suggestedChangeStatus(
  suggestedChange: StoredSuggestedChange,
  pin: Pin | null | undefined,
  evaluation: SuggestedChangeEvaluationOutcome | null | undefined,
): SuggestedChangeStatus {
  if (suggestedChange.withdrawn !== undefined) return 'withdrawn';
  if (suggestedChange.addedAsLatest !== undefined) return 'added-as-latest';
  if (suggestedChange.rolledBack !== undefined) return 'pinned';
  if (pin !== undefined && pin !== null) {
    const status = pin.status ?? 'pinned';
    if (status === 'pending-approval') return 'waiting-for-second-person';
    if (status === 'pinned') return 'pinned';
  }
  if (evaluation === undefined || evaluation === null) return 'check-failed';
  switch (evaluation.runStatus) {
    case 'pending':
    case 'running':
      return 'checking';
    case 'failed':
    case 'cancelled':
      return 'check-failed';
    case 'completed':
      return finishedStatus(evaluation);
  }
}

/** The note on a `ready` suggested change whose pin didn't go through. */
export function suggestedChangeNote(pin: Pin | null | undefined): SuggestedChangeNote | undefined {
  const status = pin?.status;
  if (pin === undefined || pin === null || status === undefined) return undefined;
  if (status === 'pending-approval' || status === 'pinned') return undefined;
  return { kind: PIN_NOTE[status], pinChangeId: pin.id };
}

/** A finished check's status: with a reference, `ready` once that's finished too. */
function finishedStatus(evaluation: SuggestedChangeEvaluationOutcome): SuggestedChangeStatus {
  const status = evaluation.referenceStatus;
  if (status === undefined) return 'ready';
  switch (status) {
    case 'completed':
      return 'ready';
    case 'pending':
    case 'running':
      return 'checking';
    case 'failed':
    case 'cancelled':
      return 'check-failed';
  }
}

/**
 * Who or what made a suggested change: as recorded, or for one stored
 * before that was, read from its drafter. A person's `user:<id>` is that
 * person, and a `service:<id>` that service account; a drafter with an
 * improvement pass is that Improve run; any other drafter is a service
 * named by its kind.
 */
export function suggestedChangeMaker(suggestedChange: {
  readonly madeBy?: SuggestedChangeMaker;
  readonly drafter: SuggestedChangeDrafter;
}): SuggestedChangeMaker {
  if (suggestedChange.madeBy !== undefined) return suggestedChange.madeBy;
  const { drafter } = suggestedChange;
  if (drafter.kind === 'person') {
    const [kind, ...rest] = drafter.by.split(':');
    const id = rest.join(':');
    if (kind === 'user' && id !== '') return { kind: 'person', userId: id };
    return { kind: 'service', id: kind === 'service' && id !== '' ? id : drafter.by };
  }
  if (drafter.improveRunId !== undefined) {
    return { kind: 'improve-run', improveRunId: drafter.improveRunId };
  }
  return { kind: 'service', id: drafter.kind };
}

/**
 * A suggested change's block change, with its tier. `undefined` for a
 * deploy card (`tier: 'code'`), which changes the whole version.
 */
export function blockChangeOf(suggestedChange: {
  readonly tier: StoredSuggestedChange['tier'];
  readonly change: StoredSuggestedChange['change'];
}): ProposedChange | undefined {
  const { tier, change } = suggestedChange;
  if (tier === 'code' || !('blockId' in change)) return undefined;
  return { tier, change } as ProposedChange;
}

/** The calls on a suggested change, and the statuses each starts from. */
export const SUGGESTED_CHANGE_ACTIONS = {
  // Check it again: after its check failed, or for new scores.
  check: ['check-failed', 'ready'],
  pin: ['ready'],
  'add-as-latest': ['ready'],
  // Not while a second person decides its pin: they reject it instead.
  withdraw: ['checking', 'check-failed', 'ready'],
} as const satisfies Readonly<Record<string, readonly SuggestedChangeStatus[]>>;

export type SuggestedChangeAction = keyof typeof SUGGESTED_CHANGE_ACTIONS;

export function suggestedChangeActionAllowed(
  action: SuggestedChangeAction,
  status: SuggestedChangeStatus,
): boolean {
  return (SUGGESTED_CHANGE_ACTIONS[action] as readonly SuggestedChangeStatus[]).includes(status);
}

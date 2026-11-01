// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The comparison test run of a `corrections` test set (a test set): each case is a
 * past run people corrected; the candidate agent version re-runs it as a
 * replay (`TestRunSubjectInvokeInput.replay`, so it does nothing the past
 * run didn't), `repetitions` times, and its output's items are scored
 * against the corrections, beside the baseline's.
 *
 * Per case: the replay runs, the items kept, dropped and new (new ones
 * for experts to correct), the tool calls and what happened to each, and
 * whether the replay diverged (a read ran live under `reads: 'recorded'`,
 * other than a recomputed one). The summary (`CorrectedComparisonSummary`) is what a
 * release gate reads.
 */

import type { ReplayTurnReport } from '@kindgi/agents';
import type { FlowVersionOverrides } from '@kindgi/flow';
import type { Cursor, RunId, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { AnswerCheckBinding } from './answer-check-binding.js';
import {
  type ItemChanges,
  type ItemCorrections,
  type OutputScore,
  itemChanges,
  matchCorrected,
  outputItems,
  scoreItems,
  turnToolIds,
  withFresh,
} from './corrected-items.js';
import { groupWeightReader, summarizeByItem } from './corrected-summary.js';
import type { Correction, CorrectionRegistryBinding } from './correction-binding.js';
import {
  type CallDifference,
  type CandidateCall,
  gradeExpectedDecisions,
} from './expected-decisions.js';
import type {
  CorrectedTestCase,
  FrozenCaseStoreBinding,
  TestCaseExpectedDecisions,
} from './frozen-case-binding.js';
import type { TestCaseAnswer, TestCaseDecisions, TestCaseExpect } from './test-case-binding.js';
import type {
  AgentRef,
  FlowRef,
  TestRunBinding,
  TestRunComparison,
  TestRunGroupWeights,
  TestRunSample,
} from './test-run-binding.js';
import type {
  DispatchContext,
  DispatchResult,
  TestRunDispatcher,
  TestRunSubjectInvokeOutcome,
} from './test-run-dispatcher.js';
import { sampleCases } from './test-run-sample.js';

export const DEFAULT_COMPARISON: TestRunComparison = {
  baseline: 'recorded',
  reads: 'recorded',
  repetitions: 1,
  k: 10,
};

/** One metric, baseline beside candidate. `null` where a side had no evidence from corrections. */
export interface ComparisonMetric {
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
  /** The candidate's evidence: cases with corrected items, and the correction weight behind it. */
  readonly n: number;
  readonly weight: number;
  readonly baselineN: number;
  readonly baselineWeight: number;
  readonly direction: 'higher';
  /** `weightedPrecisionAtK`: the ranked items it looked at. */
  readonly k?: number;
  /** With more than one repetition: the candidate's max − min across them. */
  readonly spread?: number;
  /**
   * Of `weight`, the part corrected on the candidate's replays themselves (a
   * rescore, after people corrected a changed answer there). Absent when none.
   */
  readonly freshWeight?: number;
}

export type ComparisonBaselineSummary =
  | {
      readonly kind: 'recorded';
      /** The versions that served the recorded runs, with how many cases each. */
      readonly versions: readonly RecordedVersion[];
    }
  | {
      readonly kind: 'version';
      readonly agentId: string;
      readonly version: string;
      readonly via: 'explicit' | 'pinned';
      readonly pinnedScope?: Readonly<Record<string, unknown>>;
    };

/** A version behind recorded runs: an agent's or a flow's. */
export type RecordedVersion =
  | { readonly agentId: string; readonly version: string; readonly cases: number }
  | { readonly flowId: string; readonly version: string; readonly cases: number };

/** What ran on the cases: an agent version, or a flow version. */
export type ComparisonCandidate =
  | {
      readonly kind: 'agent';
      readonly agentId: string;
      readonly version: string;
      /**
       * The version's `pinsDigest`: what it ran, as a release gate checks.
       * Absent for a version published before pins, and from a dispatcher
       * without an agent registry.
       */
      readonly pinsDigest?: string;
      /**
       * The blocks whose content the replays replaced
       * (`comparison.overrides`): it ran no published version, so it
       * can't gate a pin.
       */
      readonly overrides?: {
        readonly settings?: readonly string[];
        readonly prompts?: readonly string[];
      };
    }
  | {
      readonly kind: 'flow';
      readonly flowId: string;
      readonly version: string;
      /** Agents and tools its replays ran at other versions than the flow version's pins. */
      readonly versions?: FlowVersionOverrides;
    };

/** What a comparison test run concluded: what a release gate reads. */
export interface CorrectedComparisonSummary {
  readonly testRunId: string;
  readonly status: 'completed' | 'partial' | 'failed';
  readonly completedAt: string;
  readonly testSet: { readonly id: string; readonly version: string };
  readonly candidate: ComparisonCandidate;
  readonly baseline: ComparisonBaselineSummary;
  /** Where the test set's corrections came from. */
  readonly scope: { readonly projectId?: string };
  readonly cases: number;
  /**
   * Cases where a read ran live under `reads: 'recorded'`: one with no
   * recording, or one re-run because the candidate pins other settings
   * that reads from somewhere. A recomputed call (reads from nowhere) isn't.
   */
  readonly diverged: number;
  /**
   * Tool calls the replay refused across the cases (what the candidate
   * would have done). Reads count too, despite the name: the replay refuses
   * a call it can't run live (a write, or a read that needs an approval or
   * reaches outside, say) that has no recording of the same call.
   */
  readonly refusedWrites: number;
  /** Cases that errored: none of their repetitions ran. */
  readonly errors: number;
  /**
   * Cases that stopped at a refused tool call (a flow's tool node the
   * replay refused): no output to score, so they're left out of the metrics.
   */
  readonly stopped: number;
  /**
   * Cases an erasure cleared (a person's words were erased): left out of
   * the run and the metrics. Absent: none.
   */
  readonly erased?: number;
  /** A rescore: the comparison test run whose replays it scored again. */
  readonly rescoreOf?: string;
  /** A rescore: cases whose replays couldn't be read again, kept at their earlier scores. */
  readonly notRescored?: number;
  readonly reads: TestRunComparison['reads'];
  /**
   * Which corrections counted: `experts-only` weighs a correction not
   * recorded under an expert group 0 (a gate can require it). Absent
   * from a summary recorded before T200: `as-recorded`.
   */
  readonly groupWeights?: TestRunGroupWeights;
  /** The part of the test set it ran (absent: every case). */
  readonly sample?: TestRunSample;
  /** The models that answered the candidate's replays, and how many replays each. */
  readonly sampling: {
    readonly models: readonly {
      readonly providerId: string;
      readonly model: string;
      readonly runs: number;
    }[];
  };
  readonly repetitions: number;
  readonly metrics: {
    readonly passRate: ComparisonMetric;
    readonly caseCoverage: ComparisonMetric;
    readonly weightedPrecisionAtK: ComparisonMetric;
  };
  /**
   * Corrections graded across the cases, shown for a release gate, not
   * enforced. Absent when the test set carries no corrections.
   */
  readonly corrections?: {
    readonly checked: number;
    readonly passed: number;
    /**
     * Each correction graded: whether it passed (every repetition did).
     * What an Improve run compares, run to run, to keep only a
     * model-settings change that breaks none the current version passes. Absent from a summary recorded before it.
     */
    readonly results?: readonly { readonly correctionId: string; readonly pass: boolean }[];
  };
  /**
   * The cases whose pass isn't known (`passKnown`): a part of their
   * `expect` couldn't be checked (each entry's `unchecked`), and none that
   * was checked failed. They're the ones left out of `corrections`. `why`
   * is the first reason the answer checker gave for an answer of theirs it
   * couldn't check, when it gave one. Absent when there are none.
   */
  readonly unchecked?: { readonly cases: number; readonly why?: string };
  /**
   * What the candidate's replays cost in model calls, as the runtime
   * reported it: each repetition's total over the cases whose every
   * repetition reported a cost (`cases`), averaged over the repetitions;
   * with more than one, `spread` is the totals' max − min. Absent when no
   * case's did.
   */
  readonly costUsd?: {
    readonly candidate: number;
    readonly spread?: number;
    readonly cases: number;
  };
}

/** One case's result. */
export interface CorrectedCaseResult {
  readonly caseId: string;
  /** The candidate's replay runs, one per repetition (absent for one that couldn't start). */
  readonly runIds: readonly string[];
  readonly baseline: OutputScore;
  /** One per repetition that ran. */
  readonly candidate: readonly OutputScore[];
  /** The first repetition's items against the corrected ones. */
  readonly changes?: ItemChanges;
  /** The first repetition's tool calls. */
  readonly tools?: ReplayTurnReport['tools'];
  /**
   * Each correction on the case, graded on the replay: its verdict and how
   * many of the repetitions passed (it passes only when every one did).
   * Shown, not enforced. Kept through an erasure, all but `why` — the
   * differences, which quote values, are in `correctionDifferences`.
   *
   * A case that carries `expect` gives one entry instead, keyed by the
   * case's id: it passes a repetition when every part it expects passed
   * on it, and each part that was checked (`parts`) is one check in
   * `passRate`, beside the case's items. A part that couldn't be checked is
   * named in `unchecked`, and the case doesn't pass. It gives none when it
   * expects only items.
   */
  readonly corrections?: readonly CorrectionGraded[];
  /**
   * How each correction's calls differed, by correction: the differences from
   * the first repetition that failed it, and that repetition's number (the
   * shown `tools` are the first repetition's, which may differ). Quotes
   * argument values, so an erasure clears it.
   */
  readonly correctionDifferences?: readonly {
    readonly correctionId: string;
    /** Which repetition (1-based) these differences are from. */
    readonly repetition: number;
    readonly differences: readonly CallDifference[];
  }[];
  /**
   * What each repetition's replay cost in model calls, as the runtime
   * reported it, one per repetition, with what checking its answer cost
   * (`CorrectedDispatcherOptions.answers`). Absent when a repetition
   * reported none.
   */
  readonly costUsd?: readonly number[];
  readonly diverged: boolean;
  /**
   * Tool calls the replay refused in this case: the most in any one of its
   * repetitions. Reads count too, despite the name.
   */
  readonly refusedWrites: number;
  readonly noContext: boolean;
  readonly approvalSkipped: boolean;
  readonly error?: string;
  /** Set when the replay stopped at a refused tool call: what it would have done. */
  readonly stopped?: NonNullable<TestRunSubjectInvokeOutcome['stopped']>;
  /**
   * Set in a rescore when this case's replays can't be read again (a
   * retention purge, say): its scores are the run rescored's.
   */
  readonly rescored?: false;
}

/** One correction graded on a case, or the case's own `expect`. */
export interface CorrectionGraded {
  readonly correctionId: string;
  readonly pass: boolean;
  /**
   * How many repetitions passed. For a case's `expect` with an `answer`,
   * the answers after the first that failed aren't checked, and their
   * repetitions count as not passed. With a part `unchecked`, none passed.
   */
  readonly repetitionsPassed: number;
  readonly repetitions: number;
  /**
   * The judging model's reason, from the first repetition whose answer
   * failed (a case's `expect.answer`), when the model gave one. It can
   * quote the answer, so an erasure clears it.
   */
  readonly why?: string;
  /**
   * A case's `expect` only: whether each part it expects that was checked
   * passed on every repetition. Each one is a check in `passRate`.
   */
  readonly parts?: { readonly decisions?: boolean; readonly answer?: boolean };
  /**
   * A case's `expect` only: each part it expects that couldn't be checked
   * (`gradeExpect`). It adds no check to `passRate`, and the case doesn't
   * pass. Whether its pass is known: `passKnown`.
   */
  readonly unchecked?: readonly ('decisions' | 'answer')[];
}

/**
 * Whether an entry's `pass` is known: no part of it was unchecked, or a
 * part that was checked failed. One that isn't is read as a case the run
 * didn't grade: it's left out of the summary's `corrections` and doesn't
 * change its correction's status.
 */
export function passKnown(entry: CorrectionGraded): boolean {
  if (entry.unchecked === undefined || entry.unchecked.length === 0) return true;
  return entry.parts?.decisions === false || entry.parts?.answer === false;
}

/** Reads a replay run's output again, for a rescore. */
export interface ReplayRunReader {
  getRun(tenantId: TenantId, runId: RunId): Promise<{ readonly output?: unknown } | null>;
}

export interface CorrectedDispatcherOptions {
  readonly cases: FrozenCaseStoreBinding;
  /** Where the candidate's `pinsDigest` is read, for the summary. */
  readonly agents?: Pick<AgentRegistryBinding, 'getVersion'>;
  /**
   * For a rescore (`comparison.rescoreOf`): the run rescored, its replays'
   * outputs, and the corrections recorded on them since. Without all three a
   * rescore is refused; a comparison that replays needs none.
   */
  readonly testRuns?: Pick<TestRunBinding, 'get'>;
  readonly runs?: ReplayRunReader;
  readonly corrections?: Pick<CorrectionRegistryBinding, 'list' | 'getGroup'>;
  /**
   * Checks a replay's answer against a case's `expect.answer`, with the
   * judging model (`DispatchContext.judging`, else the tested version's
   * own). The host passes it in. Without it, a case's answer is unchecked:
   * it adds no check. A rescore never calls it.
   */
  readonly answers?: AnswerCheckBinding;
}

export const RESCORE_UNSUPPORTED =
  "This runtime can't rescore a comparison: it doesn't read replays and their corrections again.";

/** Cases read per page. */
const CASE_PAGE = 100;

export const OVERRIDES_NEED_AN_AGENT =
  "`overrides` replaces an agent version's block content: it needs `agentRef`.";

export const VERSIONS_NEED_A_FLOW =
  '`versions` runs a flow with some of its agents or tools at other versions: it needs `flowRef`.';

function validateComparison(
  testSet: { readonly spec: Readonly<Record<string, unknown>> },
  target: AgentRef | FlowRef,
  comparison: TestRunComparison | undefined,
): { kind: 'ok' } | { kind: 'err'; message: string } {
  if (target.version === undefined) {
    return {
      kind: 'err',
      message:
        'agentId' in target
          ? '`agentRef.version` is required: the candidate is one version of the agent.'
          : '`flowRef.version` is required: the candidate is one version of the flow.',
    };
  }
  if (testSet.spec.caseCount === 0) {
    return { kind: 'err', message: 'The test set has no cases.' };
  }
  const c = comparison ?? DEFAULT_COMPARISON;
  if (c.versions !== undefined && 'agentId' in target) {
    return { kind: 'err', message: VERSIONS_NEED_A_FLOW };
  }
  if (c.overrides !== undefined && !('agentId' in target)) {
    return { kind: 'err', message: OVERRIDES_NEED_AN_AGENT };
  }
  if (c.baseline !== 'recorded') {
    return { kind: 'err', message: "Only `baseline: 'recorded'` runs today." };
  }
  return { kind: 'ok' };
}

export function createCorrectedDispatcher(options: CorrectedDispatcherOptions): TestRunDispatcher {
  return {
    kind: 'corrections',
    validate(testSet, target, comparison) {
      const checked = validateComparison(testSet, target, comparison);
      if (checked.kind === 'err' || comparison?.rescoreOf === undefined) return checked;
      return options.testRuns !== undefined &&
        options.runs !== undefined &&
        options.corrections !== undefined
        ? checked
        : { kind: 'err', message: RESCORE_UNSUPPORTED };
    },
    async dispatch(ctx): Promise<DispatchResult> {
      const comparison = ctx.comparison ?? DEFAULT_COMPARISON;
      const listed = await allCases(options.cases, ctx);
      // An erased case has nothing left to replay: left out, and counted.
      // A sample is drawn from the rest.
      const replayable = listed.filter((c) => c.erased !== true);
      const erased = listed.length - replayable.length;
      const stored =
        comparison.sample === undefined ? replayable : sampleCases(replayable, comparison.sample);
      const all = comparison.groupWeights === 'experts-only' ? stored.map(expertsOnly) : stored;
      if (ctx.dryRun) {
        return {
          result: { dryRun: true, cases: all.length, ...(erased > 0 && { erased }), comparison },
        };
      }
      if (comparison.rescoreOf !== undefined) {
        return rescore(options, ctx, comparison, all, erased);
      }
      return replayAll(options, ctx, comparison, all, erased);
    },
  };
}

/** A comparison that replays: each case's candidate runs again, and its output is scored. */
async function replayAll(
  options: CorrectedDispatcherOptions,
  ctx: DispatchContext,
  comparison: TestRunComparison,
  all: readonly CorrectedTestCase[],
  erased: number,
): Promise<DispatchResult> {
  const results: CorrectedCaseResult[] = [];
  const models = new Map<string, { providerId: string; model: string; runs: number }>();
  // Erased after they were listed: the replay was refused (`run-erased`).
  const erasedLate = new Set<string>();
  let halt: Halt | undefined;
  // The first reason the checker gave for an answer it couldn't check.
  let uncheckedWhy: string | undefined;
  for (const correctedCase of all) {
    if (ctx.abortSignal.aborted) break;
    const done = await runCase(ctx, comparison, correctedCase, models, options.answers);
    if (done === 'erased') {
      erasedLate.add(correctedCase.caseId);
      continue;
    }
    if ('halt' in done) {
      halt = done.halt;
      break;
    }
    results.push(done.result);
    uncheckedWhy ??= done.uncheckedWhy;
    ctx.onProgress(done.result as unknown as Readonly<Record<string, unknown>>);
  }
  const pinsDigest = await candidatePins(options.agents, ctx);
  const ran = all.filter((c) => !erasedLate.has(c.caseId));
  const erasedAll = erased + erasedLate.size;
  const summary = {
    ...summarize(ctx, comparison, ran, results, [...models.values()], pinsDigest, uncheckedWhy),
    ...(erasedAll > 0 && { erased: erasedAll }),
  };
  return {
    result: { summary, perCase: results },
    ...(ctx.abortSignal.aborted && { error: 'cancelled' }),
    ...(halt !== undefined && { error: 'cancelled', cancelReason: halt.reason }),
  };
}

async function allCases(
  store: FrozenCaseStoreBinding,
  ctx: DispatchContext,
): Promise<readonly CorrectedTestCase[]> {
  const out: CorrectedTestCase[] = [];
  let cursor: Parameters<FrozenCaseStoreBinding['listCases']>[0]['cursor'];
  for (;;) {
    const page = await store.listCases({
      tenantId: ctx.tenantId,
      testSetId: ctx.testSet.id,
      version: ctx.testSet.version,
      limit: CASE_PAGE,
      ...(cursor !== undefined && { cursor }),
    });
    out.push(...page.data);
    if (!page.hasMore || page.nextCursor === undefined) return out;
    cursor = page.nextCursor;
  }
}

/** Why a case couldn't start, and the test run stops (`TestRunSubjectInvokeOutcome.halt`). */
type Halt = NonNullable<TestRunSubjectInvokeOutcome['halt']>;

/** A tool call's arguments as an object; anything else compares as no fields. */
function asArgs(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** One case's repetitions as they come back. */
class CaseTally {
  readonly runIds: string[] = [];
  readonly candidate: OutputScore[] = [];
  first: { changes: ItemChanges; replay?: ReplayTurnReport } | undefined;
  error: string | undefined;
  stopped: CorrectedCaseResult['stopped'];
  diverged = false;
  refusedWrites = 0;
  approvalSkipped = false;
  private readonly correctionsCase: readonly TestCaseExpectedDecisions[];
  /** correctionId -> how many repetitions this correction passed. */
  private readonly correctionPasses = new Map<string, number>();
  /**
   * correctionId -> the first repetition that failed this correction: its number
   * (1-based) and its differences. Kept so a correction that passes the first
   * repetition and fails a later one still shows why.
   */
  private readonly firstFailure = new Map<
    string,
    { readonly repetition: number; readonly differences: readonly CallDifference[] }
  >();
  private correctionRepetitions = 0;
  /** Each repetition's reported cost, in order (undefined where one reported none). */
  private readonly costs: (number | undefined)[] = [];
  /** Each repetition as a case's `expect` is graded on it, in order. */
  readonly repetitions: Repetition[] = [];

  constructor(
    private readonly correctedCase: CorrectedTestCase,
    private readonly comparison: TestRunComparison,
    private readonly agentTurn: boolean,
  ) {
    // A case that carries `expect` is graded from it, not from its corrections.
    this.correctionsCase =
      correctedCase.expect === undefined ? (correctedCase.corrections ?? []) : [];
  }

  add(outcome: TestRunSubjectInvokeOutcome): 'ran' | 'stopped' | 'error' {
    const calls = candidateCalls(outcome);
    this.gradeCorrections(calls);
    this.costs.push(outcome.costUsd);
    this.repetitions.push({
      ran: outcome.stopped === undefined && outcome.error === undefined,
      output: outcome.output,
      calls,
    });
    if (outcome.runId !== undefined) this.runIds.push(outcome.runId as unknown as string);
    if (outcome.stopped !== undefined) {
      this.stopped ??= outcome.stopped;
      this.refusedWrites = Math.max(this.refusedWrites, refusedCount(outcome));
      this.first ??= { changes: { kept: [], dropped: [], new: [] }, ...replayOf(outcome) };
      return 'stopped';
    }
    if (outcome.error !== undefined) {
      this.error ??= outcome.error;
      return 'error';
    }
    this.ran(outcome);
    return 'ran';
  }

  private ran(outcome: TestRunSubjectInvokeOutcome): void {
    const { correctedCase, comparison } = this;
    const matched = matchCorrected(
      outputItems(outcome.output, this.agentTurn),
      correctedCase.items,
      correctedCase.output,
    );
    this.candidate.push(scoreItems(matched, comparison.k));
    const tools = outcome.replay?.tools ?? [];
    this.refusedWrites = Math.max(this.refusedWrites, refusedCount(outcome));
    // A recomputed call read nothing new: only a live read diverges.
    if (
      comparison.reads === 'recorded' &&
      tools.some((t) => t.source === 'live' && t.recomputed !== true)
    ) {
      this.diverged = true;
    }
    if (outcome.replay?.approval === 'skipped') this.approvalSkipped = true;
    this.first ??= { changes: itemChanges(matched, correctedCase.items), ...replayOf(outcome) };
  }

  /**
   * Grade every correction on the case against this repetition's recorded
   * calls (refused calls included, so a refused-then-retried call still
   * counts). Called for every repetition — one that errored has no calls, so
   * a `calls` correction fails it. The first repetition that fails a
   * correction keeps its differences, with its repetition number.
   */
  private gradeCorrections(calls: readonly CandidateCall[]): void {
    if (this.correctionsCase.length === 0) return;
    this.correctionRepetitions += 1;
    const repetition = this.correctionRepetitions;
    for (const c of this.correctionsCase) {
      const graded = gradeExpectedDecisions(c, calls);
      if (graded.pass) {
        this.correctionPasses.set(
          c.correctionId,
          (this.correctionPasses.get(c.correctionId) ?? 0) + 1,
        );
      } else if (!this.firstFailure.has(c.correctionId)) {
        this.firstFailure.set(c.correctionId, { repetition, differences: graded.differences });
      }
    }
  }

  /** The case's result; `graded`: its `expect`, graded (`gradeExpect`). */
  result(baseline: OutputScore, graded?: ExpectGraded): CorrectedCaseResult {
    const none = this.candidate.length === 0;
    const n = this.comparison.repetitions;
    const corrections: CorrectionGraded[] = this.correctionsCase.map((c) => {
      const passed = this.correctionPasses.get(c.correctionId) ?? 0;
      return {
        correctionId: c.correctionId,
        pass: passed === n,
        repetitionsPassed: passed,
        repetitions: n,
      };
    });
    if (graded?.entry !== undefined) corrections.push(graded.entry);
    const correctionDifferences = this.correctionsCase.flatMap((c) => {
      const failure = this.firstFailure.get(c.correctionId);
      return failure === undefined
        ? []
        : [
            {
              correctionId: c.correctionId,
              repetition: failure.repetition,
              differences: failure.differences,
            },
          ];
    });
    if (graded?.differences !== undefined) correctionDifferences.push(graded.differences);
    // A judging call's cost counts in its repetition's, when the replay reported one.
    const costs = this.costs.map((c, i) =>
      c === undefined ? undefined : c + (graded?.judgingCosts[i] ?? 0),
    );
    const costUsd =
      costs.length === n && costs.every((c): c is number => c !== undefined) ? costs : undefined;
    return {
      caseId: this.correctedCase.caseId,
      runIds: this.runIds,
      baseline,
      candidate: this.candidate,
      ...(this.first !== undefined && { changes: this.first.changes }),
      ...(this.first?.replay !== undefined && { tools: this.first.replay.tools }),
      ...(corrections.length > 0 && { corrections }),
      ...(correctionDifferences.length > 0 && { correctionDifferences }),
      ...(costUsd !== undefined && { costUsd }),
      diverged: this.diverged,
      refusedWrites: this.refusedWrites,
      noContext: this.correctedCase.context === undefined,
      approvalSkipped: this.approvalSkipped,
      // A case none of whose repetitions ran stopped (at a refused tool call) or errored.
      ...(none && this.stopped !== undefined && { stopped: this.stopped }),
      ...(none && this.stopped === undefined && this.error !== undefined && { error: this.error }),
    };
  }
}

async function runCase(
  ctx: DispatchContext,
  comparison: TestRunComparison,
  correctedCase: CorrectedTestCase,
  models: Map<string, { providerId: string; model: string; runs: number }>,
  answers: AnswerCheckBinding | undefined,
): Promise<CaseRan | 'erased' | { readonly halt: Halt }> {
  // An agent turn's items are its answer and typed result; a flow run's, its whole output.
  const agentTurn = correctedCase.subject.kind === 'agent';
  const baseline = scoreItems(
    matchCorrected(
      outputItems(correctedCase.output, agentTurn),
      correctedCase.items,
      correctedCase.output,
    ),
    comparison.k,
  );
  const tally = new CaseTally(correctedCase, comparison, agentTurn);
  for (let rep = 0; rep < comparison.repetitions; rep++) {
    const outcome = await invokeCase(ctx, correctedCase);
    // Its past run was erased meanwhile: nothing left to replay.
    if (outcome.erased === true) return 'erased';
    // Its project or tenant takes no new runs: the test run stops here.
    if (outcome.halt !== undefined) return { halt: outcome.halt };
    if (tally.add(outcome) === 'ran') countModel(models, outcome);
  }
  const graded =
    correctedCase.expect === undefined
      ? undefined
      : await gradeExpect(ctx, correctedCase, correctedCase.expect, tally.repetitions, answers);
  return {
    result: tally.result(baseline, graded),
    ...(graded?.uncheckedWhy !== undefined && { uncheckedWhy: graded.uncheckedWhy }),
  };
}

/** A case that ran: its result, and why the checker couldn't check its answer, when it said. */
interface CaseRan {
  readonly result: CorrectedCaseResult;
  readonly uncheckedWhy?: string;
}

/** One repetition, as a case's `expect` is graded on it. */
interface Repetition {
  /** It ran: it neither errored nor stopped at a refused call. */
  readonly ran: boolean;
  readonly output: unknown;
  /** Its tool calls, refused ones included. */
  readonly calls: readonly CandidateCall[];
}

/** A case's `expect`, graded over its repetitions. */
interface ExpectGraded {
  /** Its one entry, keyed by the case's id; absent when it expects only items. */
  readonly entry?: CorrectionGraded;
  /** How the calls differed from `decisions: wrong` on the first repetition whose calls did. */
  readonly differences?: {
    readonly correctionId: string;
    readonly repetition: number;
    readonly differences: readonly CallDifference[];
  };
  /** What checking each repetition's answer cost, by repetition (0-based). */
  readonly judgingCosts: readonly (number | undefined)[];
  /** Why the checker couldn't check the answer, when it said and the case's pass isn't known. */
  readonly uncheckedWhy?: string;
}

/**
 * Grade a case's `expect` over its repetitions: each part it expects,
 * repetition by repetition.
 *
 * - `decisions: wrong`: every `shouldCall` (args where given) and none of
 *   `mustNotCall`, exactly (`gradeExpectedDecisions`).
 * - `decisions: right`: the same tools the recorded run called, by id, in
 *   any order. Unchecked when the recorded calls can't be read.
 * - `answer`: the host's checker (`answers`), for each repetition in
 *   order, stopping at the first answer that fails, so a failed answer
 *   costs one call at most. It's checked on a repetition whose decisions
 *   failed too: it's a check of its own in `passRate`. Unchecked without a
 *   checker, when it answers `unchecked`, or when the test run is stopped
 *   before a check.
 *
 * A repetition that errored or stopped fails every part; its answer isn't
 * checked, nor any after it. A repetition passes when every part passed on
 * it, and each part (`parts`) passes when it passed on every repetition.
 * The entry is left out when the case expects only items (they count
 * toward `weightedPrecisionAtK`); a part that couldn't be checked is named
 * in `unchecked`, and no repetition passes. What checking cost counts
 * either way.
 */
async function gradeExpect(
  ctx: DispatchContext,
  correctedCase: CorrectedTestCase,
  expect: TestCaseExpect,
  repetitions: readonly Repetition[],
  answers: AnswerCheckBinding | undefined,
): Promise<ExpectGraded> {
  const { decisions, answer } = expect;
  if (decisions === undefined && answer === undefined) return { judgingCosts: [] };
  const unchecked: ('decisions' | 'answer')[] = [];
  const decided = gradeDecisions(correctedCase, decisions, repetitions);
  // Decisions that can't be checked are unchecked; the answer is still checked.
  if (decided === undefined) unchecked.push('decisions');
  const differences = decided?.differences;
  let answered: readonly (boolean | undefined)[] | undefined = repetitions.map(() => true);
  let judgingCosts: readonly (number | undefined)[] = [];
  let why: string | undefined;
  let uncheckedWhy: string | undefined;
  if (answer !== undefined) {
    const checked = await checkAnswers(ctx, correctedCase, answer, repetitions, answers);
    // What a check cost counts even when a later one couldn't be made.
    judgingCosts = checked.costs;
    if (checked.unchecked === true) {
      unchecked.push('answer');
      answered = undefined;
      uncheckedWhy = checked.reason;
    } else {
      answered = checked.passes;
      why = checked.why;
    }
  }
  const n = repetitions.length;
  // A part that's unchecked passes no repetition.
  const repetitionsPassed = repetitions.filter(
    (_, i) => decided?.passes[i] === true && answered?.[i] === true,
  ).length;
  const entry: CorrectionGraded = {
    correctionId: correctedCase.caseId,
    pass: n > 0 && repetitionsPassed === n,
    repetitionsPassed,
    repetitions: n,
    ...(why !== undefined && { why }),
    parts: partsPassed(expect, decided?.passes, answered, n),
    ...(unchecked.length > 0 && { unchecked }),
  };
  return {
    entry,
    ...(differences !== undefined && { differences }),
    judgingCosts,
    // The summary's reason is for a case whose pass the run couldn't know.
    ...(uncheckedWhy !== undefined && !passKnown(entry) && { uncheckedWhy }),
  };
}

/**
 * Whether each part the case expects that was checked passed on every one
 * of its `n` repetitions (`parts`). A part with no passes wasn't checked,
 * and has none.
 */
function partsPassed(
  expect: TestCaseExpect,
  decided: readonly boolean[] | undefined,
  answered: readonly (boolean | undefined)[] | undefined,
  n: number,
): NonNullable<CorrectionGraded['parts']> {
  return {
    ...(expect.decisions !== undefined &&
      decided !== undefined && { decisions: n > 0 && decided.every((p) => p) }),
    ...(expect.answer !== undefined &&
      answered !== undefined && { answer: n > 0 && answered.every((p) => p === true) }),
  };
}

/**
 * Whether each repetition's decisions passed (each does when the case
 * expects none), and how the calls differed from `decisions: wrong` on the
 * first repetition whose calls did. `undefined` when they can't be
 * checked: `decisions: right` on a recorded run whose calls can't be read.
 */
function gradeDecisions(
  correctedCase: CorrectedTestCase,
  decisions: TestCaseDecisions | undefined,
  repetitions: readonly Repetition[],
):
  | { readonly passes: readonly boolean[]; readonly differences?: ExpectGraded['differences'] }
  | undefined {
  if (decisions === undefined) return { passes: repetitions.map(() => true) };
  if (decisions.verdict === 'right') {
    const recorded = turnToolIds(correctedCase.output);
    if (recorded === undefined) return undefined;
    return { passes: repetitions.map((r) => r.ran && sameTools(recorded, r.calls)) };
  }
  const expected = { calls: decisions.shouldCall ?? [], notCalled: decisions.mustNotCall ?? [] };
  const passes: boolean[] = [];
  let differences: ExpectGraded['differences'];
  for (const [i, r] of repetitions.entries()) {
    const graded = gradeExpectedDecisions(expected, r.calls);
    passes.push(r.ran && graded.pass);
    if (differences === undefined && graded.differences.length > 0) {
      differences = {
        correctionId: correctedCase.caseId,
        repetition: i + 1,
        differences: graded.differences,
      };
    }
  }
  return { passes, ...(differences !== undefined && { differences }) };
}

/** Each repetition's answer, checked (`checkAnswers`). */
interface AnswersChecked {
  /** Whether each passed; `undefined` where none was checked. */
  readonly passes: readonly (boolean | undefined)[];
  /** What each check cost, by repetition. */
  readonly costs: readonly (number | undefined)[];
  /** The first failing answer's reason, when the judging model gave one. */
  readonly why?: string;
  /**
   * Set when the answers couldn't be checked: no checker, a candidate that
   * isn't an agent version, a check the checker couldn't make, or a test
   * run stopped before a check.
   */
  readonly unchecked?: true;
  /** Why the checker couldn't check one, when it said (`AnswerCheck`). */
  readonly reason?: string;
}

/**
 * Check each repetition's answer, in order, stopping at the first answer
 * that fails: the answer has failed then, and checking more would only
 * cost more. A repetition whose decisions failed is still checked. One that
 * errored or stopped fails with no call. A test run stopped before a check
 * leaves the answers unchecked.
 */
async function checkAnswers(
  ctx: DispatchContext,
  correctedCase: CorrectedTestCase,
  expect: TestCaseAnswer,
  repetitions: readonly Repetition[],
  answers: AnswerCheckBinding | undefined,
): Promise<AnswersChecked> {
  const target = ctx.target;
  if (answers === undefined || !('agentId' in target) || target.version === undefined) {
    return { passes: [], costs: [], unchecked: true };
  }
  const judging = ctx.judging ?? { version: target.version };
  const passes: (boolean | undefined)[] = repetitions.map(() => undefined);
  const costs: (number | undefined)[] = repetitions.map(() => undefined);
  for (const [i, r] of repetitions.entries()) {
    if (!r.ran) {
      passes[i] = false;
      return { passes, costs };
    }
    if (ctx.abortSignal.aborted) return { passes, costs, unchecked: true };
    const checked = await answers.check({
      tenantId: ctx.tenantId,
      ...(ctx.projectId !== undefined && { projectId: ctx.projectId }),
      testRunId: ctx.testRunId,
      caseId: correctedCase.caseId,
      agentId: target.agentId,
      judging,
      input: correctedCase.input,
      recorded: correctedCase.output,
      answer: r.output,
      expect,
    });
    // A call whose reply couldn't be read still cost what it did.
    costs[i] = checked.costUsd;
    if (checked.kind === 'unchecked') {
      const reason = checked.reason.trim();
      return { passes, costs, unchecked: true, ...(reason.length > 0 && { reason }) };
    }
    passes[i] = checked.pass;
    if (!checked.pass) {
      return { passes, costs, ...(checked.why !== undefined && { why: checked.why }) };
    }
  }
  return { passes, costs };
}

/** Whether a repetition called the same tools as the recorded run, by id, in any order. */
function sameTools(recorded: ReadonlySet<string>, calls: readonly CandidateCall[]): boolean {
  const made = new Set(calls.map((c) => c.tool));
  return made.size === recorded.size && [...recorded].every((tool) => made.has(tool));
}

/** A repetition's tool calls as a correction grades them, refused ones included. */
function candidateCalls(outcome: TestRunSubjectInvokeOutcome): CandidateCall[] {
  return (outcome.replay?.tools ?? []).map((t) => ({
    tool: t.toolId,
    args: asArgs(t.arguments),
    step: t.step,
    callId: t.callId,
    ...(t.source === 'refused' && { refused: true }),
  }));
}

/**
 * A rescore: the run rescored's replays, scored again with what people have
 * corrected on them since (a changed answer is corrected on the replay itself).
 * Nothing runs. A case the run rescored didn't have (sampled out, erased
 * since) is left out; one whose replays are gone keeps its scores.
 */
async function rescore(
  options: CorrectedDispatcherOptions,
  ctx: DispatchContext,
  comparison: TestRunComparison,
  all: readonly CorrectedTestCase[],
  erased: number,
): Promise<DispatchResult> {
  const { testRuns, runs } = options;
  const of = comparison.rescoreOf as string;
  const prior =
    testRuns === undefined
      ? null
      : await testRuns.get({ tenantId: ctx.tenantId, testRunId: of as unknown as RunId });
  const before = prior === null ? undefined : priorCases(prior);
  if (runs === undefined || prior === null || before === undefined) {
    return {
      result: {},
      error: `Test run "${of}" can't be rescored: it isn't a finished comparison here.`,
    };
  }
  if (prior.testSetId !== ctx.testSet.id || prior.testSetVersion !== ctx.testSet.version) {
    return {
      result: {},
      error: `Test run "${of}" ran ${prior.testSetId}@${prior.testSetVersion}: a rescore runs that test set version.`,
    };
  }
  const fresh = freshReader(options.corrections, ctx.tenantId, comparison);
  const results: CorrectedCaseResult[] = [];
  for (const correctedCase of all) {
    if (ctx.abortSignal.aborted) break;
    const earlier = before.get(correctedCase.caseId);
    if (earlier === undefined) continue;
    const result = await rescoreCase(ctx, comparison, correctedCase, earlier, runs, fresh);
    results.push(result);
    ctx.onProgress(result as unknown as Readonly<Record<string, unknown>>);
  }
  const pinsDigest = await candidatePins(options.agents, ctx);
  const ran = all.filter((c) => before.has(c.caseId));
  const notRescored = results.filter((r) => r.rescored === false).length;
  const summary = {
    ...summarize(
      ctx,
      comparison,
      ran,
      results,
      priorModels(prior),
      pinsDigest,
      priorUncheckedWhy(prior),
    ),
    rescoreOf: of,
    ...(notRescored > 0 && { notRescored }),
    ...(erased > 0 && { erased }),
  };
  return {
    result: { summary, perCase: results },
    ...(ctx.abortSignal.aborted && { error: 'cancelled' }),
  };
}

async function rescoreCase(
  ctx: DispatchContext,
  comparison: TestRunComparison,
  correctedCase: CorrectedTestCase,
  earlier: CorrectedCaseResult,
  runs: ReplayRunReader,
  fresh: (runId: string) => Promise<readonly ItemCorrections[]>,
): Promise<CorrectedCaseResult> {
  const agentTurn = correctedCase.subject.kind === 'agent';
  const baseline = scoreItems(
    matchCorrected(
      outputItems(correctedCase.output, agentTurn),
      correctedCase.items,
      correctedCase.output,
    ),
    comparison.k,
  );
  // A case none of whose replays ran has nothing to rescore; one some of
  // whose replays stopped keeps its scores (each score is a replay that ran).
  if (earlier.candidate.length === 0) return { ...earlier, baseline };
  if (earlier.candidate.length !== earlier.runIds.length) {
    return { ...earlier, baseline, rescored: false };
  }
  const candidate: OutputScore[] = [];
  let changes: ItemChanges | undefined;
  for (const runId of earlier.runIds) {
    const run = await runs.getRun(ctx.tenantId, runId as unknown as RunId);
    if (run === null || run.output === undefined || run.output === null) {
      return { ...earlier, baseline, rescored: false };
    }
    const matched = withFresh(
      matchCorrected(outputItems(run.output, agentTurn), correctedCase.items, correctedCase.output),
      await fresh(runId),
    );
    candidate.push(scoreItems(matched, comparison.k));
    changes ??= itemChanges(matched, correctedCase.items);
  }
  return { ...earlier, baseline, candidate, ...(changes !== undefined && { changes }) };
}

/** The corrections recorded on a replay run, summed per item key, as the comparison weighs them. */
function freshReader(
  corrections: CorrectedDispatcherOptions['corrections'],
  tenantId: TenantId,
  comparison: TestRunComparison,
): (runId: string) => Promise<readonly ItemCorrections[]> {
  if (corrections === undefined) return async () => [];
  const weightOf = groupWeightReader(corrections, tenantId);
  return async (runId) => {
    const all: Correction[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await corrections.list({
        tenantId,
        runId,
        limit: CASE_PAGE,
        ...(cursor !== undefined && { cursor }),
      });
      all.push(...page.data);
      if (!page.hasMore || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    const items = await summarizeByItem(all, weightOf);
    return comparison.groupWeights === 'experts-only' ? expertItems(items) : items;
  };
}

/** The finished comparison's cases, by case id; `undefined` when it isn't one. */
function priorCases(run: {
  readonly kind: string;
  readonly status: string;
  readonly result?: Readonly<Record<string, unknown>>;
}): Map<string, CorrectedCaseResult> | undefined {
  const perCase = run.result?.perCase;
  if (run.kind !== 'corrections' || run.status !== 'completed' || !Array.isArray(perCase)) {
    return undefined;
  }
  return new Map((perCase as CorrectedCaseResult[]).map((r) => [r.caseId, r]));
}

/** The models that answered the run rescored's replays: the rescore's are theirs. */
function priorModels(run: {
  readonly result?: Readonly<Record<string, unknown>>;
}): { providerId: string; model: string; runs: number }[] {
  const summary = run.result?.summary as CorrectedComparisonSummary | undefined;
  return [...(summary?.sampling?.models ?? [])];
}

/**
 * The first reason the checker gave in the run rescored: a rescore checks
 * no answer, and keeps that run's entries.
 */
function priorUncheckedWhy(run: {
  readonly result?: Readonly<Record<string, unknown>>;
}): string | undefined {
  const summary = run.result?.summary as CorrectedComparisonSummary | undefined;
  return summary?.unchecked?.why;
}

function refusedCount(outcome: TestRunSubjectInvokeOutcome): number {
  return (outcome.replay?.tools ?? []).filter((t) => t.source === 'refused').length;
}

function replayOf(outcome: TestRunSubjectInvokeOutcome): { replay?: ReplayTurnReport } {
  return outcome.replay !== undefined ? { replay: outcome.replay } : {};
}

async function invokeCase(
  ctx: DispatchContext,
  correctedCase: CorrectedTestCase,
): Promise<TestRunSubjectInvokeOutcome> {
  try {
    return await ctx.subject.invoke({
      tenantId: ctx.tenantId,
      target: ctx.target,
      // An agent turn's input is its user message.
      input: correctedCase.input,
      dryRun: false,
      abortSignal: ctx.abortSignal,
      ...(ctx.projectId !== undefined && { projectId: ctx.projectId }),
      replay: {
        of: correctedCase.runId as unknown as RunId,
        caseId: correctedCase.caseId,
        testRunId: ctx.testRunId as unknown as string,
      },
      ...(correctedCase.subject.kind === 'agent' && {
        history: correctedCase.context?.history ?? [],
      }),
      ...(!('agentId' in ctx.target) &&
        ctx.comparison?.versions !== undefined && { versions: ctx.comparison.versions }),
    });
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function countModel(
  models: Map<string, { providerId: string; model: string; runs: number }>,
  outcome: TestRunSubjectInvokeOutcome,
): void {
  if (outcome.provider === undefined) return;
  const key = `${outcome.provider.id}\u0000${outcome.provider.model}`;
  const kept = models.get(key) ?? {
    providerId: outcome.provider.id,
    model: outcome.provider.model,
    runs: 0,
  };
  kept.runs += 1;
  models.set(key, kept);
}

type Side = (s: OutputScore) => { readonly yes: number; readonly total: number };

const yesShare: Side = (s) => ({ yes: s.yesWeight, total: s.totalWeight });
const precisionAtK: Side = (s) => ({ yes: s.topK.yesWeight, total: s.topK.totalWeight });
/** Coverage's ratio is corrected items over items; its evidence weight is the corrected weight. */
const coverage: Side = (s) => ({ yes: s.correctedItems, total: s.items });

/** A metric over cases: Σ numerator / Σ denominator, with its evidence. */
function pooled(
  scores: readonly OutputScore[],
  side: Side,
  weightOf: (s: OutputScore) => number,
): { readonly value: number | null; readonly n: number; readonly weight: number } {
  let yes = 0;
  let total = 0;
  let n = 0;
  let weight = 0;
  for (const s of scores) {
    const { yes: y, total: t } = side(s);
    if (t <= 0) continue;
    yes += y;
    total += t;
    n += 1;
    weight += weightOf(s);
  }
  return { value: total > 0 ? yes / total : null, n, weight };
}

function metric(
  results: readonly CorrectedCaseResult[],
  repetitions: number,
  side: Side,
  weightOf: (s: OutputScore) => number,
  extra: { readonly k?: number; readonly fresh?: boolean } = {},
): ComparisonMetric {
  // Only cases the candidate ran: errored and stopped cases leave both sides.
  const scored = results.filter((r) => r.candidate.length > 0);
  const baseline = pooled(
    scored.map((r) => r.baseline),
    side,
    weightOf,
  );
  // Each repetition is a full pass over the cases: its value, then the spread across them.
  const perRep = Array.from({ length: repetitions }, (_, rep) =>
    pooled(
      scored.flatMap((r) => (r.candidate[rep] !== undefined ? [r.candidate[rep]] : [])),
      side,
      weightOf,
    ),
  );
  const values = perRep.map((p) => p.value).filter((v): v is number => v !== null);
  const candidate = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const cases = new Set<number>();
  scored.forEach((r, i) => {
    if (r.candidate.some((s) => side(s).total > 0)) cases.add(i);
  });
  const weight = perRep.reduce((a, p) => a + p.weight, 0) / Math.max(1, perRep.length);
  // Of that weight, what was corrected on the replays themselves (a rescore):
  // for a metric whose weight is all the corrected weight.
  const freshWeight =
    extra.fresh === true
      ? Array.from({ length: repetitions }, (_, rep) =>
          scored.reduce((a, r) => a + (r.candidate[rep]?.fresh?.totalWeight ?? 0), 0),
        ).reduce((a, w) => a + w, 0) / Math.max(1, repetitions)
      : 0;
  return {
    baseline: baseline.value,
    candidate,
    delta: baseline.value !== null && candidate !== null ? candidate - baseline.value : null,
    n: cases.size,
    weight,
    baselineN: baseline.n,
    baselineWeight: baseline.weight,
    direction: 'higher',
    ...(extra.k !== undefined && { k: extra.k }),
    ...(repetitions > 1 &&
      values.length > 1 && { spread: Math.max(...values) - Math.min(...values) }),
    ...(freshWeight > 0 && { freshWeight }),
  };
}

/**
 * The cases as `passRate` counts them: each part of a case's graded
 * `expect` (its entry under its id: `parts`) is one check of weight 1,
 * beside its items. The recorded run passes a part when people marked it
 * `right`; each repetition that ran, when the part passed on every one.
 * A case with no entry (only `items`) adds none, and nor does a part
 * unchecked.
 */
function withExpectChecks(
  cases: readonly CorrectedTestCase[],
  results: readonly CorrectedCaseResult[],
): readonly CorrectedCaseResult[] {
  const expects = new Map(cases.map((c) => [c.caseId, c.expect]));
  return results.map((r) => {
    const expect = expects.get(r.caseId);
    const parts =
      expect === undefined
        ? undefined
        : r.corrections?.find((c) => c.correctionId === r.caseId)?.parts;
    if (expect === undefined || parts === undefined) return r;
    const checks: { readonly recorded: boolean; readonly pass: boolean }[] = [];
    if (expect.decisions !== undefined && parts.decisions !== undefined) {
      checks.push({ recorded: expect.decisions.verdict !== 'wrong', pass: parts.decisions });
    }
    if (expect.answer !== undefined && parts.answer !== undefined) {
      checks.push({ recorded: expect.answer.verdict !== 'wrong', pass: parts.answer });
    }
    if (checks.length === 0) return r;
    return {
      ...r,
      baseline: withChecks(
        r.baseline,
        checks.map((c) => c.recorded),
      ),
      candidate: r.candidate.map((s) =>
        withChecks(
          s,
          checks.map((c) => c.pass),
        ),
      ),
    };
  });
}

function withChecks(s: OutputScore, passes: readonly boolean[]): OutputScore {
  return {
    ...s,
    yesWeight: s.yesWeight + passes.filter(Boolean).length,
    totalWeight: s.totalWeight + passes.length,
  };
}

function summarize(
  ctx: DispatchContext,
  comparison: TestRunComparison,
  cases: readonly CorrectedTestCase[],
  results: readonly CorrectedCaseResult[],
  models: readonly { providerId: string; model: string; runs: number }[],
  pinsDigest: string | undefined,
  uncheckedWhy: string | undefined,
): CorrectedComparisonSummary {
  const errors = results.filter((r) => r.error !== undefined).length;
  const stopped = results.filter((r) => r.stopped !== undefined).length;
  const versions = new Map<string, { id: string; flow: boolean; version: string; cases: number }>();
  for (const c of cases) {
    const key = `${c.subject.kind}:${c.subject.id}@${c.subject.version}`;
    const kept = versions.get(key) ?? {
      id: c.subject.id,
      flow: c.subject.kind === 'flow',
      version: c.subject.version,
      cases: 0,
    };
    kept.cases += 1;
    versions.set(key, kept);
  }
  const specProject = ctx.testSet.spec.projectId;
  const projectId =
    typeof specProject === 'string'
      ? specProject
      : (ctx.projectId as unknown as string | undefined);
  const correctedWeight = (s: OutputScore) => s.totalWeight;
  const corrections = correctionsOf(results);
  const unchecked = uncheckedOf(results, uncheckedWhy);
  const costUsd = costOf(results, comparison.repetitions);
  return {
    testRunId: ctx.testRunId as unknown as string,
    status:
      results.length > 0 && errors === 0
        ? 'completed'
        : errors < results.length
          ? 'partial'
          : 'failed',
    completedAt: new Date().toISOString(),
    testSet: { id: ctx.testSet.id, version: ctx.testSet.version },
    candidate: candidateOf(ctx.target, ctx.comparison, pinsDigest),
    baseline: {
      kind: 'recorded',
      versions: [...versions.values()].map(
        (v): RecordedVersion =>
          v.flow
            ? { flowId: v.id, version: v.version, cases: v.cases }
            : { agentId: v.id, version: v.version, cases: v.cases },
      ),
    },
    scope: { ...(projectId !== undefined && { projectId }) },
    cases: results.length,
    diverged: results.filter((r) => r.diverged).length,
    refusedWrites: results.reduce((a, r) => a + r.refusedWrites, 0),
    errors,
    stopped,
    reads: comparison.reads,
    groupWeights: comparison.groupWeights ?? 'as-recorded',
    ...(comparison.sample !== undefined && { sample: comparison.sample }),
    sampling: { models },
    repetitions: comparison.repetitions,
    metrics: {
      passRate: metric(
        withExpectChecks(cases, results),
        comparison.repetitions,
        yesShare,
        correctedWeight,
        { fresh: true },
      ),
      caseCoverage: metric(results, comparison.repetitions, coverage, correctedWeight, {
        fresh: true,
      }),
      weightedPrecisionAtK: metric(
        results,
        comparison.repetitions,
        precisionAtK,
        (s) => s.topK.totalWeight,
        { k: comparison.k },
      ),
    },
    ...(corrections !== undefined && { corrections }),
    ...(unchecked !== undefined && { unchecked }),
    ...(costUsd !== undefined && { costUsd }),
  };
}

/**
 * The corrections graded across the cases, and whether each one passed, by
 * correction; none graded, undefined. An entry whose pass isn't known
 * (`passKnown`) is left out.
 */
function correctionsOf(
  results: readonly CorrectedCaseResult[],
): CorrectedComparisonSummary['corrections'] {
  const graded = results.flatMap((r) =>
    (r.corrections ?? [])
      .filter(passKnown)
      .map(({ correctionId, pass }) => ({ correctionId, pass })),
  );
  if (graded.length === 0) return undefined;
  const passed = graded.filter((j) => j.pass).length;
  return { checked: graded.length, passed, results: graded };
}

/**
 * The cases whose pass isn't known (`passKnown`), and the first reason the
 * checker gave for one (`why`); none, undefined.
 */
function uncheckedOf(
  results: readonly CorrectedCaseResult[],
  why: string | undefined,
): CorrectedComparisonSummary['unchecked'] {
  const cases = results.filter((r) => (r.corrections ?? []).some((c) => !passKnown(c))).length;
  if (cases === 0) return undefined;
  return { cases, ...(why !== undefined && { why }) };
}

/**
 * What the candidate's replays cost: each repetition's total over the
 * cases whose every repetition reported a cost, averaged, and with more
 * than one repetition the totals' spread. Undefined when no case's did.
 */
function costOf(
  results: readonly CorrectedCaseResult[],
  repetitions: number,
): CorrectedComparisonSummary['costUsd'] {
  const costed = results.flatMap((r) => (r.costUsd?.length === repetitions ? [r.costUsd] : []));
  if (costed.length === 0) return undefined;
  const totals = Array.from({ length: repetitions }, (_, rep) =>
    costed.reduce((a, c) => a + (c[rep] ?? 0), 0),
  );
  return {
    candidate: totals.reduce((a, b) => a + b, 0) / repetitions,
    ...(repetitions > 1 && { spread: Math.max(...totals) - Math.min(...totals) }),
    cases: costed.length,
  };
}

/**
 * A case as an `experts-only` comparison counts it: each item at its
 * expert-group corrections' weights; an item with none is left out, so it
 * counts as uncorrected. Corrections filter the same way — only the ones
 * recorded under an expert group are kept, so a correction from someone
 * outside the restriction isn't graded. A case's `expect` is kept only on
 * an expert's case (`expert`), so no one else's case is graded.
 */
function expertsOnly(c: CorrectedTestCase): CorrectedTestCase {
  const { corrections, expect, ...rest } = c;
  const kept = corrections?.filter((x) => x.expert === true);
  return {
    ...rest,
    items: expertItems(rest.items),
    ...(kept !== undefined && kept.length > 0 && { corrections: kept }),
    ...(expect !== undefined && c.expert === true && { expect }),
  };
}

/** Only what the people a group was restricted to said: an item without it counts as uncorrected. */
function expertItems<T extends CorrectedTestCase['items'][number]>(items: readonly T[]): T[] {
  return items.flatMap((item) =>
    item.expert !== undefined && item.expert.totalWeight > 0
      ? [
          {
            ...item,
            yesWeight: item.expert.yesWeight,
            totalWeight: item.expert.totalWeight,
          },
        ]
      : [],
  );
}

/** The agent candidate's `pinsDigest`, from the registry. */
async function candidatePins(
  agents: CorrectedDispatcherOptions['agents'],
  ctx: DispatchContext,
): Promise<string | undefined> {
  if (agents === undefined || !('agentId' in ctx.target) || ctx.target.version === undefined) {
    return undefined;
  }
  const found = await agents.getVersion({
    tenantId: ctx.tenantId,
    agentId: ctx.target.agentId,
    version: ctx.target.version,
  });
  return found?.pinsDigest;
}

function candidateOf(
  target: AgentRef | FlowRef,
  comparison: TestRunComparison | undefined,
  pinsDigest?: string,
): ComparisonCandidate {
  const versions = comparison?.versions;
  const settings = Object.keys(comparison?.overrides?.settings ?? {}).sort();
  const prompts = Object.keys(comparison?.overrides?.prompts ?? {}).sort();
  const overrides = {
    ...(settings.length > 0 && { settings }),
    ...(prompts.length > 0 && { prompts }),
  };
  return 'agentId' in target
    ? {
        kind: 'agent',
        agentId: target.agentId as unknown as string,
        version: target.version ?? '',
        ...(pinsDigest !== undefined && { pinsDigest }),
        ...(Object.keys(overrides).length > 0 && { overrides }),
      }
    : {
        kind: 'flow',
        flowId: target.flowId as unknown as string,
        version: target.version ?? '',
        ...(versions !== undefined && { versions }),
      };
}

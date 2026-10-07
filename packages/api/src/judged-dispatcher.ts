// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The comparison eval run of a `judged` suite (a test set): each case is a
 * past run people judged; the candidate agent version re-runs it as a
 * replay (`EvalRunSubjectInvokeInput.replay`, so it does nothing the past
 * run didn't), `repetitions` times, and its output's items are scored
 * against the judgments, beside the baseline's.
 *
 * Per case: the replay runs, the items kept, dropped and new (new ones
 * for experts to judge), the tool calls and what happened to each, and
 * whether the replay diverged (a read with no recording ran live under
 * `reads: 'recorded'`). The summary (`JudgedComparisonSummary`) is what a
 * promotion gate reads.
 */

import type { ReplayTurnReport } from '@kindgi/agents';
import type { FlowVersionOverrides } from '@kindgi/flow';
import type { RunId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { EvalCaseStoreBinding, JudgedEvalCase } from './eval-case-binding.js';
import type { AgentRef, EvalClassWeights, EvalComparison, FlowRef } from './eval-run-binding.js';
import type {
  DispatchContext,
  DispatchResult,
  EvalRunDispatcher,
  EvalRunSubjectInvokeOutcome,
} from './eval-run-dispatcher.js';
import {
  type ItemChanges,
  type OutputScore,
  itemChanges,
  matchJudged,
  outputItems,
  scoreItems,
} from './judged-items.js';

export const DEFAULT_COMPARISON: EvalComparison = {
  baseline: 'recorded',
  reads: 'recorded',
  repetitions: 1,
  k: 10,
};

/** One metric, baseline beside candidate. `null` where a side had no judged evidence. */
export interface ComparisonMetric {
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
  /** The candidate's evidence: cases with judged items, and the judgment weight behind it. */
  readonly n: number;
  readonly weight: number;
  readonly baselineN: number;
  readonly baselineWeight: number;
  readonly direction: 'higher';
  /** `weightedPrecisionAtK`: the ranked items it looked at. */
  readonly k?: number;
  /** With more than one repetition: the candidate's max − min across them. */
  readonly spread?: number;
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
      readonly via: 'explicit' | 'live';
      readonly liveScope?: Readonly<Record<string, unknown>>;
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
       * The version's `pinsDigest`: what it ran, as a promotion gate checks.
       * Absent for a version published before pins, and from a dispatcher
       * without an agent registry.
       */
      readonly pinsDigest?: string;
    }
  | {
      readonly kind: 'flow';
      readonly flowId: string;
      readonly version: string;
      /** Agents and tools its replays ran at other versions than the flow version's pins. */
      readonly versions?: FlowVersionOverrides;
    };

/** What a comparison eval run concluded: what a promotion gate reads. */
export interface JudgedComparisonSummary {
  readonly evalRunId: string;
  readonly status: 'completed' | 'partial' | 'failed';
  readonly completedAt: string;
  readonly suite: { readonly id: string; readonly version: string };
  readonly candidate: ComparisonCandidate;
  readonly baseline: ComparisonBaselineSummary;
  /** Where the test set's judgments came from. */
  readonly scope: { readonly projectId?: string };
  readonly cases: number;
  /** Cases where a read with no recording ran live under `reads: 'recorded'`. */
  readonly diverged: number;
  /** Tool calls refused across the cases (what the candidate would have done). */
  readonly refusedWrites: number;
  /** Cases that errored: none of their repetitions ran. */
  readonly errors: number;
  /**
   * Cases that stopped at a refused write (a flow's tool node the replay
   * refused): no output to score, so they're left out of the metrics.
   */
  readonly stopped: number;
  /**
   * Cases an erasure cleared (a person's words were erased): left out of
   * the run and the metrics. Absent: none.
   */
  readonly erased?: number;
  readonly reads: EvalComparison['reads'];
  /**
   * Which judgments counted: `restricted-only` weighs a judgment not
   * recorded under a restricted class 0 (a gate can require it). Absent
   * from a summary recorded before T200: `as-recorded`.
   */
  readonly classWeights?: EvalClassWeights;
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
    readonly weightedYesShare: ComparisonMetric;
    readonly judgedCoverage: ComparisonMetric;
    readonly weightedPrecisionAtK: ComparisonMetric;
  };
}

/** One case's result. */
export interface JudgedCaseResult {
  readonly caseId: string;
  /** The candidate's replay runs, one per repetition (absent for one that couldn't start). */
  readonly runIds: readonly string[];
  readonly baseline: OutputScore;
  /** One per repetition that ran. */
  readonly candidate: readonly OutputScore[];
  /** The first repetition's items against the judged ones. */
  readonly changes?: ItemChanges;
  /** The first repetition's tool calls. */
  readonly tools?: ReplayTurnReport['tools'];
  readonly diverged: boolean;
  readonly refusedWrites: number;
  readonly noContext: boolean;
  readonly approvalSkipped: boolean;
  readonly error?: string;
  /** Set when the replay stopped at a refused write: what it would have done. */
  readonly stopped?: NonNullable<EvalRunSubjectInvokeOutcome['stopped']>;
}

export interface JudgedDispatcherOptions {
  readonly cases: EvalCaseStoreBinding;
  /** Where the candidate's `pinsDigest` is read, for the summary. */
  readonly agents?: Pick<AgentRegistryBinding, 'getVersion'>;
}

/** Cases read per page. */
const CASE_PAGE = 100;

export const VERSIONS_NEED_A_FLOW =
  '`versions` runs a flow with some of its agents or tools at other versions: it needs `flowRef`.';

function validateComparison(
  suite: { readonly spec: Readonly<Record<string, unknown>> },
  target: AgentRef | FlowRef,
  comparison: EvalComparison | undefined,
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
  if (suite.spec.caseCount === 0) {
    return { kind: 'err', message: 'The test set has no cases.' };
  }
  const c = comparison ?? DEFAULT_COMPARISON;
  if (c.versions !== undefined && 'agentId' in target) {
    return { kind: 'err', message: VERSIONS_NEED_A_FLOW };
  }
  if (c.baseline !== 'recorded') {
    return { kind: 'err', message: "Only `baseline: 'recorded'` runs today." };
  }
  return { kind: 'ok' };
}

export function createJudgedDispatcher(options: JudgedDispatcherOptions): EvalRunDispatcher {
  return {
    kind: 'judged',
    validate: validateComparison,
    async dispatch(ctx): Promise<DispatchResult> {
      const comparison = ctx.comparison ?? DEFAULT_COMPARISON;
      const listed = await allCases(options.cases, ctx);
      // An erased case has nothing left to replay: left out, and counted.
      const stored = listed.filter((c) => c.erased !== true);
      const erased = listed.length - stored.length;
      const all =
        comparison.classWeights === 'restricted-only' ? stored.map(restrictedOnly) : stored;
      if (ctx.dryRun) {
        return {
          result: { dryRun: true, cases: all.length, ...(erased > 0 && { erased }), comparison },
        };
      }
      const results: JudgedCaseResult[] = [];
      const models = new Map<string, { providerId: string; model: string; runs: number }>();
      for (const judgedCase of all) {
        if (ctx.abortSignal.aborted) break;
        const result = await runCase(ctx, comparison, judgedCase, models);
        results.push(result);
        ctx.onProgress(result as unknown as Readonly<Record<string, unknown>>);
      }
      const pinsDigest = await candidatePins(options.agents, ctx);
      const summary = {
        ...summarize(ctx, comparison, all, results, [...models.values()], pinsDigest),
        ...(erased > 0 && { erased }),
      };
      return {
        result: { summary, perCase: results },
        ...(ctx.abortSignal.aborted && { error: 'cancelled' }),
      };
    },
  };
}

async function allCases(
  store: EvalCaseStoreBinding,
  ctx: DispatchContext,
): Promise<readonly JudgedEvalCase[]> {
  const out: JudgedEvalCase[] = [];
  let cursor: Parameters<EvalCaseStoreBinding['listCases']>[0]['cursor'];
  for (;;) {
    const page = await store.listCases({
      tenantId: ctx.tenantId,
      suiteId: ctx.suite.id,
      version: ctx.suite.version,
      limit: CASE_PAGE,
      ...(cursor !== undefined && { cursor }),
    });
    out.push(...page.data);
    if (!page.hasMore || page.nextCursor === undefined) return out;
    cursor = page.nextCursor;
  }
}

/** One case's repetitions as they come back. */
class CaseTally {
  readonly runIds: string[] = [];
  readonly candidate: OutputScore[] = [];
  first: { changes: ItemChanges; replay?: ReplayTurnReport } | undefined;
  error: string | undefined;
  stopped: JudgedCaseResult['stopped'];
  diverged = false;
  refusedWrites = 0;
  approvalSkipped = false;

  constructor(
    private readonly judgedCase: JudgedEvalCase,
    private readonly comparison: EvalComparison,
    private readonly agentTurn: boolean,
  ) {}

  add(outcome: EvalRunSubjectInvokeOutcome): 'ran' | 'stopped' | 'error' {
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

  private ran(outcome: EvalRunSubjectInvokeOutcome): void {
    const { judgedCase, comparison } = this;
    const matched = matchJudged(
      outputItems(outcome.output, this.agentTurn),
      judgedCase.items,
      judgedCase.output,
    );
    this.candidate.push(scoreItems(matched, comparison.k));
    const tools = outcome.replay?.tools ?? [];
    this.refusedWrites = Math.max(this.refusedWrites, refusedCount(outcome));
    if (comparison.reads === 'recorded' && tools.some((t) => t.source === 'live')) {
      this.diverged = true;
    }
    if (outcome.replay?.approval === 'skipped') this.approvalSkipped = true;
    this.first ??= { changes: itemChanges(matched, judgedCase.items), ...replayOf(outcome) };
  }

  result(baseline: OutputScore): JudgedCaseResult {
    const none = this.candidate.length === 0;
    return {
      caseId: this.judgedCase.caseId,
      runIds: this.runIds,
      baseline,
      candidate: this.candidate,
      ...(this.first !== undefined && { changes: this.first.changes }),
      ...(this.first?.replay !== undefined && { tools: this.first.replay.tools }),
      diverged: this.diverged,
      refusedWrites: this.refusedWrites,
      noContext: this.judgedCase.context === undefined,
      approvalSkipped: this.approvalSkipped,
      // A case none of whose repetitions ran stopped (at a refused write) or errored.
      ...(none && this.stopped !== undefined && { stopped: this.stopped }),
      ...(none && this.stopped === undefined && this.error !== undefined && { error: this.error }),
    };
  }
}

async function runCase(
  ctx: DispatchContext,
  comparison: EvalComparison,
  judgedCase: JudgedEvalCase,
  models: Map<string, { providerId: string; model: string; runs: number }>,
): Promise<JudgedCaseResult> {
  // An agent turn's items are its answer and typed result; a flow run's, its whole output.
  const agentTurn = judgedCase.subject.kind === 'agent';
  const baseline = scoreItems(
    matchJudged(outputItems(judgedCase.output, agentTurn), judgedCase.items, judgedCase.output),
    comparison.k,
  );
  const tally = new CaseTally(judgedCase, comparison, agentTurn);
  for (let rep = 0; rep < comparison.repetitions; rep++) {
    const outcome = await invokeCase(ctx, judgedCase);
    if (tally.add(outcome) === 'ran') countModel(models, outcome);
  }
  return tally.result(baseline);
}

function refusedCount(outcome: EvalRunSubjectInvokeOutcome): number {
  return (outcome.replay?.tools ?? []).filter((t) => t.source === 'refused').length;
}

function replayOf(outcome: EvalRunSubjectInvokeOutcome): { replay?: ReplayTurnReport } {
  return outcome.replay !== undefined ? { replay: outcome.replay } : {};
}

async function invokeCase(
  ctx: DispatchContext,
  judgedCase: JudgedEvalCase,
): Promise<EvalRunSubjectInvokeOutcome> {
  try {
    return await ctx.subject.invoke({
      tenantId: ctx.tenantId,
      target: ctx.target,
      // An agent turn's input is its user message.
      input: judgedCase.input,
      dryRun: false,
      abortSignal: ctx.abortSignal,
      ...(ctx.projectId !== undefined && { projectId: ctx.projectId }),
      replay: {
        of: judgedCase.caseId as unknown as RunId,
        evalRunId: ctx.runId as unknown as string,
      },
      ...(judgedCase.subject.kind === 'agent' && { history: judgedCase.context?.history ?? [] }),
      ...(!('agentId' in ctx.target) &&
        ctx.comparison?.versions !== undefined && { versions: ctx.comparison.versions }),
    });
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function countModel(
  models: Map<string, { providerId: string; model: string; runs: number }>,
  outcome: EvalRunSubjectInvokeOutcome,
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
/** Coverage's ratio is judged items over items; its evidence weight is the judged weight. */
const coverage: Side = (s) => ({ yes: s.judgedItems, total: s.items });

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
  results: readonly JudgedCaseResult[],
  repetitions: number,
  side: Side,
  weightOf: (s: OutputScore) => number,
  extra: { readonly k?: number } = {},
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
  };
}

function summarize(
  ctx: DispatchContext,
  comparison: EvalComparison,
  cases: readonly JudgedEvalCase[],
  results: readonly JudgedCaseResult[],
  models: readonly { providerId: string; model: string; runs: number }[],
  pinsDigest: string | undefined,
): JudgedComparisonSummary {
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
  const specProject = ctx.suite.spec.projectId;
  const projectId =
    typeof specProject === 'string'
      ? specProject
      : (ctx.projectId as unknown as string | undefined);
  const judgedWeight = (s: OutputScore) => s.totalWeight;
  return {
    evalRunId: ctx.runId as unknown as string,
    status:
      results.length > 0 && errors === 0
        ? 'completed'
        : errors < results.length
          ? 'partial'
          : 'failed',
    completedAt: new Date().toISOString(),
    suite: { id: ctx.suite.id, version: ctx.suite.version },
    candidate: candidateOf(ctx.target, ctx.comparison?.versions, pinsDigest),
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
    classWeights: comparison.classWeights ?? 'as-recorded',
    sampling: { models },
    repetitions: comparison.repetitions,
    metrics: {
      weightedYesShare: metric(results, comparison.repetitions, yesShare, judgedWeight),
      judgedCoverage: metric(results, comparison.repetitions, coverage, judgedWeight),
      weightedPrecisionAtK: metric(
        results,
        comparison.repetitions,
        precisionAtK,
        (s) => s.topK.totalWeight,
        { k: comparison.k },
      ),
    },
  };
}

/**
 * A case as a `restricted-only` comparison counts it: each item at its
 * restricted judgments' weights; an item with none is left out, so it
 * counts as unjudged.
 */
function restrictedOnly(c: JudgedEvalCase): JudgedEvalCase {
  return {
    ...c,
    items: c.items.flatMap((item) =>
      item.restricted !== undefined && item.restricted.totalWeight > 0
        ? [
            {
              ...item,
              yesWeight: item.restricted.yesWeight,
              totalWeight: item.restricted.totalWeight,
            },
          ]
        : [],
    ),
  };
}

/** The agent candidate's `pinsDigest`, from the registry. */
async function candidatePins(
  agents: JudgedDispatcherOptions['agents'],
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
  versions: FlowVersionOverrides | undefined,
  pinsDigest?: string,
): ComparisonCandidate {
  return 'agentId' in target
    ? {
        kind: 'agent',
        agentId: target.agentId as unknown as string,
        version: target.version ?? '',
        ...(pinsDigest !== undefined && { pinsDigest }),
      }
    : {
        kind: 'flow',
        flowId: target.flowId as unknown as string,
        version: target.version ?? '',
        ...(versions !== undefined && { versions }),
      };
}

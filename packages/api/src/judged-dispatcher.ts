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
import type { RunId } from '@kindgi/types';

import type { EvalCaseStoreBinding, JudgedEvalCase } from './eval-case-binding.js';
import type { AgentRef, EvalComparison } from './eval-run-binding.js';
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
      readonly versions: readonly {
        readonly agentId: string;
        readonly version: string;
        readonly cases: number;
      }[];
    }
  | {
      readonly kind: 'version';
      readonly agentId: string;
      readonly version: string;
      readonly via: 'explicit' | 'live';
      readonly liveScope?: Readonly<Record<string, unknown>>;
    };

/** What a comparison eval run concluded: what a promotion gate reads. */
export interface JudgedComparisonSummary {
  readonly evalRunId: string;
  readonly status: 'completed' | 'partial' | 'failed';
  readonly completedAt: string;
  readonly suite: { readonly id: string; readonly version: string };
  readonly candidate: { readonly agentId: string; readonly version: string };
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
  readonly reads: EvalComparison['reads'];
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
}

export interface JudgedDispatcherOptions {
  readonly cases: EvalCaseStoreBinding;
}

/** Cases read per page. */
const CASE_PAGE = 100;

function validateComparison(
  suite: { readonly spec: Readonly<Record<string, unknown>> },
  target: AgentRef | { readonly flowId: unknown },
  comparison: EvalComparison | undefined,
): { kind: 'ok' } | { kind: 'err'; message: string } {
  if (!('agentId' in target)) {
    return { kind: 'err', message: 'A test set compares an agent version; give `agentRef`.' };
  }
  if (target.version === undefined) {
    return {
      kind: 'err',
      message: '`agentRef.version` is required: the candidate is one version of the agent.',
    };
  }
  if (suite.spec.caseCount === 0) {
    return { kind: 'err', message: 'The test set has no cases.' };
  }
  const c = comparison ?? DEFAULT_COMPARISON;
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
      const all = await allCases(options.cases, ctx);
      if (ctx.dryRun) {
        return { result: { dryRun: true, cases: all.length, comparison } };
      }
      const results: JudgedCaseResult[] = [];
      const models = new Map<string, { providerId: string; model: string; runs: number }>();
      for (const judgedCase of all) {
        if (ctx.abortSignal.aborted) break;
        const result = await runCase(ctx, comparison, judgedCase, models);
        results.push(result);
        ctx.onProgress(result as unknown as Readonly<Record<string, unknown>>);
      }
      const summary = summarize(ctx, comparison, all, results, [...models.values()]);
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

async function runCase(
  ctx: DispatchContext,
  comparison: EvalComparison,
  judgedCase: JudgedEvalCase,
  models: Map<string, { providerId: string; model: string; runs: number }>,
): Promise<JudgedCaseResult> {
  const baseline = scoreItems(
    matchJudged(outputItems(judgedCase.output, true), judgedCase.items, judgedCase.output),
    comparison.k,
  );
  const runIds: string[] = [];
  const candidate: OutputScore[] = [];
  let first: { changes: ItemChanges; replay?: ReplayTurnReport } | undefined;
  let error: string | undefined;
  let diverged = false;
  let refusedWrites = 0;
  let approvalSkipped = false;
  for (let rep = 0; rep < comparison.repetitions; rep++) {
    const outcome = await invokeCase(ctx, judgedCase);
    if (outcome.runId !== undefined) runIds.push(outcome.runId as unknown as string);
    if (outcome.error !== undefined) {
      error ??= outcome.error;
      continue;
    }
    countModel(models, outcome);
    const matched = matchJudged(
      outputItems(outcome.output, true),
      judgedCase.items,
      judgedCase.output,
    );
    candidate.push(scoreItems(matched, comparison.k));
    const tools = outcome.replay?.tools ?? [];
    const refused = tools.filter((t) => t.source === 'refused').length;
    refusedWrites = Math.max(refusedWrites, refused);
    if (comparison.reads === 'recorded' && tools.some((t) => t.source === 'live')) {
      diverged = true;
    }
    if (outcome.replay?.approval === 'skipped') approvalSkipped = true;
    first ??= {
      changes: itemChanges(matched, judgedCase.items),
      ...(outcome.replay !== undefined && { replay: outcome.replay }),
    };
  }
  return {
    caseId: judgedCase.caseId,
    runIds,
    baseline,
    candidate,
    ...(first !== undefined && { changes: first.changes }),
    ...(first?.replay !== undefined && { tools: first.replay.tools }),
    diverged,
    refusedWrites,
    noContext: judgedCase.context === undefined,
    approvalSkipped,
    ...(error !== undefined && { error }),
  };
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
      history: judgedCase.context?.history ?? [],
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
  const scored = results.filter((r) => r.error === undefined || r.candidate.length > 0);
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
): JudgedComparisonSummary {
  const errors = results.filter((r) => r.candidate.length === 0).length;
  const target = ctx.target as AgentRef;
  const versions = new Map<string, { agentId: string; version: string; cases: number }>();
  for (const c of cases) {
    const key = `${c.subject.id}@${c.subject.version}`;
    const kept = versions.get(key) ?? {
      agentId: c.subject.id,
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
    candidate: { agentId: target.agentId as unknown as string, version: target.version ?? '' },
    baseline: { kind: 'recorded', versions: [...versions.values()] },
    scope: { ...(projectId !== undefined && { projectId }) },
    cases: results.length,
    diverged: results.filter((r) => r.diverged).length,
    refusedWrites: results.reduce((a, r) => a + r.refusedWrites, 0),
    errors,
    reads: comparison.reads,
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

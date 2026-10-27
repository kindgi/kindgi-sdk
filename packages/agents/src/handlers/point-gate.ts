// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The gate at a point inside the turn's loop (`Guardrail.at`): evaluates
 * the guardrails there, once per step, records and reports what they came
 * to, and acts on it (`judgeAtPoint`). The final answer's gate is
 * `budget-check`'s and `evaluate-guardrails`'.
 */

import type { ModelMessage, UsageSink } from '@kindgi/capabilities';
import {
  type EvaluationOutcome,
  type EvaluationResult,
  type Guardrail,
  type RunTrace,
  type TraceCallResult,
  type TraceStep,
  guardrailCoversTool,
} from '@kindgi/guardrails';
import type { NodeContext } from '@kindgi/handler';
import type { Timestamp } from '@kindgi/types';

import {
  type GuardrailEvaluationError,
  buildRunTrace,
  categorizeOutcomes,
  evaluateGate,
} from '../guardrails-gate.js';
import type { ConversationMessage } from '../types.js';
import type { TurnContext } from './context.js';
import {
  emitGateEvents,
  failTurn,
  judgeUsageSink,
  recordOutcomes,
  throwIfJudgeCallsUnrecorded,
  traceBaseOf,
  violationsOf,
  withBlocked,
} from './evaluate-guardrails.js';
import {
  type LoopPoint,
  type PointWhere,
  checkTimeLimitMs,
  guardrailsAt,
  loopIteration,
  pointFaultOutcome,
  ranCallKey,
  turnStepsLeft,
  verdictKey,
} from './guardrail-points.js';
import { type RetryFailure, attemptsOf, sentBackSoFar, turnRetryNotes } from './guardrail-retry.js';
import type { PointCheckNode } from './turn-provenance.js';

/**
 * Each guardrail's outcome at a loop point, in order, decided once per
 * step: the first run journals it (`kctx.record`), and the step run again
 * (resumed after a park, or retried) gets it back without running the
 * check, so a judge is neither asked nor billed twice. `fresh` says which
 * this run of the step decided. A guardrail whose check doesn't run at
 * the point (`ctx.guardrailPointFaults`) fails as a check that couldn't
 * run, uncalled. Each check gets its time (`checkTimeLimitMs`); one that
 * runs past it is stopped and fails as `check-timed-out`. A cancelled
 * turn propagates, as at the final answer.
 */
async function evaluateAtPoint(
  ctx: TurnContext,
  kctx: NodeContext,
  where: PointWhere,
  guardrails: readonly Guardrail[],
  trace: RunTrace,
): Promise<{
  readonly outcomes: readonly EvaluationOutcome[];
  readonly fresh: ReadonlySet<string>;
}> {
  const usage = judgeUsageSink(ctx, kctx);
  const fresh = new Set<string>();
  const outcomes = await Promise.all(
    guardrails.map((g) =>
      kctx.record(verdictKey(where, g), async () => {
        fresh.add(g.id as string);
        return journaled(await evaluateOne(ctx, where.point, g, trace, usage));
      }),
    ),
  );
  return { outcomes, fresh };
}

/**
 * An outcome as the step journals it, which `kctx.record` keeps as JSON:
 * a check's error keeps what it says, and its `cause`, which can be any
 * value a check threw, only as text.
 */
function journaled(outcome: EvaluationOutcome): EvaluationOutcome {
  if (outcome.kind !== 'err' || !('cause' in outcome.error)) return outcome;
  const { cause } = outcome.error as { readonly cause: unknown };
  return {
    kind: 'err',
    error: { ...outcome.error, cause: cause instanceof Error ? cause.message : String(cause) },
  } as EvaluationOutcome;
}

const TIMED_OUT = 'timed-out' as const;

async function evaluateOne(
  ctx: TurnContext,
  point: LoopPoint,
  guardrail: Guardrail,
  trace: RunTrace,
  usage: UsageSink | undefined,
): Promise<EvaluationOutcome> {
  const fault = ctx.guardrailPointFaults?.get(guardrail.id as string);
  if (fault !== undefined) return pointFaultOutcome(guardrail, point, fault);
  const limitMs = checkTimeLimitMs(guardrail);
  const stop = new AbortController();
  const signal = AbortSignal.any([ctx.turnAbort.signal, stop.signal]);
  const evaluated = (async () => {
    const [outcome] = await evaluateGate(
      [guardrail],
      trace,
      ctx.bindings,
      ctx.tenantPolicy,
      signal,
      usage,
    );
    if (outcome === undefined) {
      throw new Error(`guardrail-points: no outcome for guardrail "${guardrail.id}"`);
    }
    return outcome;
  })();
  // The race can be lost to the timer; the check's later failure is then nobody's.
  evaluated.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(TIMED_OUT);
    }, limitMs);
  });
  try {
    const raced = await Promise.race([evaluated, timedOut]);
    if (raced !== TIMED_OUT) {
      throwIfJudgeCallsUnrecorded([raced]);
      return raced;
    }
  } catch (cause) {
    // The turn's own cancellation, or a failure before the time ran out, is the check's to report.
    if (!stop.signal.aborted || ctx.turnAbort.signal.aborted) throw cause;
  } finally {
    clearTimeout(timer);
  }
  return {
    kind: 'err',
    error: {
      code: 'check-timed-out',
      message: `Guardrail "${guardrail.id}"'s check "${guardrail.check}" ran past ${limitMs} ms and was stopped`,
      guardrailId: guardrail.id,
      limitMs,
    },
  };
}

/** What a loop point's gate came to. `halt`s and attempts run out fail the turn, so never come back. */
export type PointVerdict =
  | { readonly kind: 'pass' }
  /** `retry` guardrails failed it: refuse the call, withhold its result, or send the reply back. */
  | { readonly kind: 'retry'; readonly failures: readonly RetryFailure[] };

/**
 * What one `dispatch-tools` step's points came to, gathered as it runs:
 * the step's output carries it, so a resumed turn has it back
 * (`rehydrate`), and its provenance comes from it.
 */
export interface StepPoints {
  /** The model step the step dispatches. */
  readonly step: number;
  /** What the step stored so far: a check of a call whose result it stored links to the call. */
  readonly stored: readonly ConversationMessage[];
  /** Its failed checks, and those that couldn't run. */
  readonly checks: PendingCheck[];
  /** Its failures only recorded, by their `ctx.pointViolations` key. */
  readonly violations: { readonly key: string; readonly violation: EvaluationResult }[];
}

/**
 * What a `dispatch-tools` step's output carries of its points, each only
 * when there's any: a resumed turn reads them back (`rehydrate`).
 */
export interface StepPointsOutput {
  /** Its failures only recorded (`StepPoints.violations`). */
  readonly guardrailViolations?: StepPoints['violations'];
  /** The calls of its reply that ran, by `ranCallKey`. */
  readonly ranCalls?: readonly string[];
  /** Its checks in provenance (`pointCheckNodes`). */
  readonly guardrailChecks?: readonly PointCheckNode[];
}

/** A step's points as its output carries them (`StepPointsOutput`). */
export function stepPointsOutput(
  ctx: TurnContext,
  points: StepPoints,
  checks: readonly PointCheckNode[],
  replySequence: number | undefined,
): StepPointsOutput {
  const ran =
    replySequence === undefined
      ? []
      : [...(ctx.ranCalls ?? [])].filter((k) => k.startsWith(ranCallKey(replySequence, '')));
  return {
    ...(points.violations.length > 0 && { guardrailViolations: points.violations }),
    ...(ran.length > 0 && { ranCalls: ran }),
    ...(checks.length > 0 && { guardrailChecks: checks }),
  };
}

/** A point's check in provenance, before the step knows what it links to. */
export interface PendingCheck {
  readonly id: string;
  readonly timestamp: Timestamp;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly callId?: string;
}

/** A step's gathered points (`StepPoints`), empty. */
export function stepPoints(step: number, stored: readonly ConversationMessage[]): StepPoints {
  return { step, stored, checks: [], violations: [] };
}

/**
 * The step's checks as provenance nodes, each `influenced-by` the call it
 * judged, when the step stored the call's result, or else the model call
 * whose reply it judged or whose call it refused.
 */
export function pointCheckNodes(points: StepPoints): readonly PointCheckNode[] {
  const answered = new Set(
    points.stored.flatMap((m) =>
      m.role === 'tool' && m.toolCall !== undefined ? [m.toolCall.invocationId] : [],
    ),
  );
  return points.checks.map(({ callId, ...node }) => ({
    ...node,
    to:
      callId !== undefined && answered.has(callId)
        ? `tool-call:${callId}`
        : `model-call:${points.step}`,
  }));
}

/**
 * Judges a loop point on the turn's guardrails there (`guardrailsAt`, and
 * at a tool point those whose `scope.tools` covers the call's tool).
 * Records the outcomes under this step and point (`dispatch-tools@<iteration>`,
 * with `:<callId>` at a tool point), emits the events (once: a step run
 * again after a park emits none for the outcomes it gets back), then acts:
 *
 * - a `halt` that failed it, or couldn't run, fails the turn;
 * - a `retry` that failed it, or couldn't run, comes back as `retry`,
 *   while the guardrail has attempts left (`retry.maxAttempts`, the notes
 *   of every point counted, `sent` being the loop's messages so far) and
 *   the turn has steps left; otherwise the turn fails, as at the final
 *   answer;
 * - every other failure is recorded on `ctx.pointViolations`, for the
 *   turn's result.
 *
 * On a dry run, a `retry` is recorded only: nothing is refused, withheld
 * or sent back, as the final answer's `retry` isn't. The failed checks
 * and the recorded failures are gathered on `points`.
 */
export async function judgeAtPoint(
  ctx: TurnContext,
  kctx: NodeContext,
  where: PointWhere,
  trace: Omit<PointTraceInput, 'where'>,
  sent: readonly ModelMessage[],
  points: StepPoints,
): Promise<PointVerdict> {
  const call = where.call;
  const guardrails = guardrailsAt(ctx.guardrails, where.point).filter(
    (g) => call === undefined || guardrailCoversTool(g.scope, call.toolId as string),
  );
  if (guardrails.length === 0) return { kind: 'pass' };
  const evaluatedAt = new Date().toISOString() as Timestamp;
  const { outcomes, fresh } = await evaluateAtPoint(
    ctx,
    kctx,
    where,
    guardrails,
    await pointTrace(ctx, kctx, guardrails, { ...trace, where }),
  );
  const categorized = categorizeOutcomes(outcomes, guardrails);
  const halted = categorized.blocking.length > 0 || categorized.blockingErrors.length > 0;
  const retryErrors = kctx.dryRun ? [] : categorized.errors.filter((e) => e.action === 'retry');
  const failures: RetryFailure[] = kctx.dryRun
    ? []
    : [...categorized.retry.map(retryFailureOf), ...retryErrors.map(retryFailureOfError)];
  const sentBack = sentBackSoFar(turnRetryNotes(ctx, sent, true));
  const stepsLeft = turnStepsLeft(ctx, kctx);
  const byId = new Map(guardrails.map((g) => [g.id as string, g]));
  const outOfAttempts = halted
    ? []
    : failures.filter((f) => {
        const guardrail = byId.get(f.guardrailId);
        const tries = (sentBack.get(f.guardrailId) ?? 0) + 1;
        return !stepsLeft || guardrail === undefined || tries >= attemptsOf(guardrail);
      });
  const iteration = loopIteration(kctx, ctx);
  const stepId = `${kctx.nodeId as unknown as string}@${iteration}${call !== undefined ? `:${call.callId}` : ''}`;
  const outOfAttemptsViolations = categorized.retry.filter((v) =>
    outOfAttempts.some((f) => f.guardrailId === (v.guardrailId as string)),
  );
  await recordOutcomes(
    ctx,
    kctx,
    evaluatedAt,
    withBlocked(categorized.checks, outOfAttemptsViolations),
    stepId,
    where,
  );
  if (fresh.size > 0) {
    const decided = guardrails.filter((g) => fresh.has(g.id as string));
    await emitGateEvents(
      ctx,
      categorizeOutcomes(
        outcomes.filter((_, i) => fresh.has(guardrails[i]?.id as string)),
        decided,
      ),
      where,
    );
  }
  gatherChecks(points, where, categorized, evaluatedAt);

  for (const v of [
    ...categorized.warnings,
    ...categorized.other,
    ...(kctx.dryRun ? categorized.retry : []),
  ]) {
    const key = `${stepId}:${v.guardrailId as string}`;
    ctx.pointViolations ??= new Map();
    ctx.pointViolations.set(key, v);
    points.violations.push({ key, violation: v });
  }
  if (halted) {
    return failTurn(
      ctx,
      categorized.blocking,
      categorized.blockingErrors,
      categorized.errors,
      undefined,
      where,
    );
  }
  if (outOfAttempts.length > 0) {
    const errored = new Set(outOfAttempts.map((f) => f.guardrailId));
    return failTurn(
      ctx,
      outOfAttemptsViolations,
      retryErrors.filter((e) => errored.has(e.guardrailId)),
      categorized.errors,
      Math.max(...outOfAttempts.map((f) => (sentBack.get(f.guardrailId) ?? 0) + 1)),
      where,
    );
  }
  return failures.length === 0 ? { kind: 'pass' } : { kind: 'retry', failures };
}

/**
 * A point's failed checks and those that couldn't run, as the final
 * answer's are (`addCheckNodes`), named by their point: at a tool point
 * `guardrail-check:<id>@<point>:<callId>`, at a reply
 * `guardrail-check:<id>@model-step:<step>`.
 */
function gatherChecks(
  points: StepPoints,
  where: PointWhere,
  categorized: ReturnType<typeof categorizeOutcomes>,
  evaluatedAt: Timestamp,
): void {
  const call = where.call;
  const at = call !== undefined ? call.callId : String(points.step);
  const placed = {
    point: where.point,
    ...(call !== undefined && { callId: call.callId }),
  };
  for (const v of violationsOf(categorized)) {
    points.checks.push({
      id: `guardrail-check:${v.guardrailId as string}@${where.point}:${at}`,
      timestamp: v.at,
      attributes: {
        guardrailId: v.guardrailId,
        action: v.action,
        severity: v.severity,
        passed: false,
        ...(v.result.reason !== undefined && { reason: v.result.reason }),
        ...placed,
      },
      ...(call !== undefined && { callId: call.callId }),
    });
  }
  for (const e of categorized.errors) {
    points.checks.push({
      id: `guardrail-check:${e.guardrailId}@${where.point}:${at}`,
      timestamp: evaluatedAt,
      attributes: {
        guardrailId: e.guardrailId,
        ...(e.action !== undefined && { action: e.action }),
        ...(e.severity !== undefined && { severity: e.severity }),
        evaluated: false,
        error: e.code,
        reason: e.message,
        ...placed,
      },
      ...(call !== undefined && { callId: call.callId }),
    });
  }
}

function retryFailureOf(v: EvaluationResult): RetryFailure {
  const reason = v.result.reason?.trim();
  return {
    guardrailId: v.guardrailId as string,
    ...(reason !== undefined && reason !== '' && { reason }),
  };
}

function retryFailureOfError(e: GuardrailEvaluationError): RetryFailure {
  return { guardrailId: e.guardrailId, reason: `its check couldn't run (${e.code}): ${e.message}` };
}

/** What a loop point's trace adds to the turn's. */
export interface PointTraceInput {
  readonly where: PointWhere;
  /** At `'after-tool'`: what the call came to. */
  readonly result?: TraceCallResult;
  /** At `'model-step'`: the reply. */
  readonly step?: TraceStep;
}

/**
 * The trace a loop point's checks read: the turn so far, with `at` and
 * the call, its result or the reply. Its `toolCalls` and `toolResults`
 * are the calls that ran (`ctx.ranCalls`): never a call refused, nor,
 * before a call, that call. It has no `output`: there's no answer yet.
 */
async function pointTrace(
  ctx: TurnContext,
  kctx: NodeContext,
  guardrails: readonly Guardrail[],
  input: PointTraceInput,
): Promise<RunTrace> {
  const evaluatedAt = new Date().toISOString() as Timestamp;
  return buildRunTrace({
    ...(await traceBaseOf(ctx, kctx, guardrails)),
    appended: ctx.appended,
    evaluatedAt,
    point: {
      at: input.where.point,
      ranCalls: ctx.ranCalls ?? new Set(),
      ...(input.where.call !== undefined && { call: input.where.call }),
      ...(input.result !== undefined && { result: input.result }),
      ...(input.step !== undefined && { step: input.step }),
    },
  });
}

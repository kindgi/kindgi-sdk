// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The turn's guardrails at the points inside its loop (`Guardrail.at`):
 * `'before-tool'`, a call the model asked for, before it runs and before
 * any approval is asked; `'after-tool'`, a call's result, before the
 * model sees it; and `'model-step'`, a model reply that asks for calls,
 * before any of them runs. The final answer stays with `budget-check` and
 * `evaluate-guardrails`.
 *
 * At a loop point, `halt` fails the turn, `retry` refuses the call,
 * withholds its result or sends the reply back (counted against the
 * guardrail's attempts, as the final answer's are), and every other
 * action is recorded, as at the final answer. A check that can't run
 * (no such check, a point its check doesn't run at, its time run out) is
 * handled by the same actions: a `halt` fails the turn, a `retry` acts as
 * on a violation with a reason that names the failure, so a broken check
 * ends in a halt, never in a call let through unchecked.
 */

import {
  type CheckRegistry,
  DEFAULT_CHECK_POINTS,
  type EvaluationOutcome,
  type Guardrail,
  type GuardrailPoint,
  type TraceCall,
  checkPoints,
  guardrailCheckPointProblems,
  guardrailPoint,
} from '@kindgi/guardrails';
import type { NodeContext } from '@kindgi/handler';

import { AGENT_TURN_LOOP_MAX_ITERATIONS } from '../agent-turn-flow.js';
import { DEFAULT_MAX_STEPS } from './constants.js';
import type { TurnContext } from './context.js';

/** A point inside the turn's loop. */
export type LoopPoint = Exclude<GuardrailPoint, 'final-answer'>;

/** Where in the loop a gate runs: its point, and at a tool point the call it judges. */
export interface PointWhere {
  readonly point: LoopPoint;
  /** At `'before-tool'` and `'after-tool'`. */
  readonly call?: TraceCall;
}

/** The turn's guardrails that run at `point`, in the turn's order. */
export function guardrailsAt(
  guardrails: readonly Guardrail[] | undefined,
  point: GuardrailPoint,
): readonly Guardrail[] {
  return (guardrails ?? []).filter((g) => guardrailPoint(g) === point);
}

/** Whether any of the turn's guardrails runs inside the loop. */
export function hasLoopGuardrails(ctx: TurnContext): boolean {
  return (ctx.guardrails ?? []).some((g) => guardrailPoint(g) !== 'final-answer');
}

/**
 * The turn's guardrails that run where their check, as the turn
 * resolved it (`checks`), doesn't (`RegisteredCheck.points`): each id with
 * the problem. The check that runs is the one the registry holds now,
 * which can differ from the one the guardrail was registered or deployed
 * against (a pack's newest deployment can drop a point), so the turn
 * checks whenever it resolves its checks: at setup, and again on each
 * resume. Away from the final answer, a check the registry doesn't hold
 * counts as the final answer only, since a strategy that runs without
 * the registry can't say where it runs. At the final answer, such a check
 * is left to the engine's `unknown-check`, as before points existed.
 */
export function guardrailPointFaults(
  guardrails: readonly Guardrail[],
  checks: CheckRegistry | undefined,
): ReadonlyMap<string, string> {
  const faults = new Map<string, string>();
  for (const g of guardrails) {
    const check = checks?.get(g.check);
    if (check === undefined && guardrailPoint(g) === 'final-answer') continue;
    const [problem] = guardrailCheckPointProblems(
      g,
      check !== undefined ? checkPoints(check) : DEFAULT_CHECK_POINTS,
    );
    if (problem !== undefined) faults.set(g.id as string, problem.message);
  }
  return faults;
}

/**
 * The outcome of a guardrail that runs where its check doesn't
 * (`guardrailPointFaults`): a check that couldn't run, never called.
 */
export function pointFaultOutcome(
  guardrail: Guardrail,
  point: GuardrailPoint,
  problem: string,
): EvaluationOutcome {
  return {
    kind: 'err',
    error: {
      code: 'check-point-unsupported',
      message: `Guardrail "${guardrail.id}" runs where its check "${guardrail.check}" doesn't: ${problem}`,
      guardrailId: guardrail.id,
      checkId: guardrail.check,
      point,
    },
  };
}

/** The time a check at a loop point gets when its guardrail sets none (`budget.maxLatencyMs`), by kind. */
export const DEFAULT_CHECK_TIME_LIMITS_MS: Readonly<Record<string, number>> = {
  'zero-llm': 10_000,
  'llm-judge': 60_000,
};

/** The time any other kind's check gets: `external`, and a pack's own kind. */
export const DEFAULT_OTHER_CHECK_TIME_LIMIT_MS = 30_000;

/** The time a guardrail's check gets at a loop point. */
export function checkTimeLimitMs(guardrail: Guardrail): number {
  return (
    guardrail.budget?.maxLatencyMs ??
    DEFAULT_CHECK_TIME_LIMITS_MS[guardrail.kind] ??
    DEFAULT_OTHER_CHECK_TIME_LIMIT_MS
  );
}

/**
 * The kernel's loop iteration of this step (`$loop.iteration`), which a
 * replay of the loop numbers the same. A handler run outside the kernel's
 * loop counts by the turn's model calls instead.
 */
export function loopIteration(kctx: NodeContext, ctx: TurnContext): number {
  const loop = (kctx.state as { readonly $loop?: { readonly iteration?: unknown } } | undefined)
    ?.$loop;
  return typeof loop?.iteration === 'number' ? loop.iteration : ctx.usage.steps - 1;
}

/**
 * Whether the turn can ask the model again: another model call within the
 * agent's steps, in another iteration within the loop's own cap.
 */
export function turnStepsLeft(ctx: TurnContext, kctx: NodeContext): boolean {
  const declared = ctx.input.agent.budget?.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxSteps = Math.min(declared, AGENT_TURN_LOOP_MAX_ITERATIONS);
  return (
    ctx.usage.steps < maxSteps && loopIteration(kctx, ctx) + 1 < AGENT_TURN_LOOP_MAX_ITERATIONS
  );
}

/** A guardrail's verdict at a loop point, recorded once per step. */
export function verdictKey(where: PointWhere, guardrail: Guardrail): string {
  return where.call === undefined
    ? `guardrail:${where.point}:${guardrail.id}`
    : `guardrail:${where.point}:${where.call.callId}:${guardrail.id}`;
}

/**
 * The guardrails whose note answers a call (a refusal before it, or a
 * result withheld after it), recorded once per step, so a step run again
 * after a park marks the note it reuses (`guardrailNoteOf`).
 */
function noteKey(callId: string): string {
  return `guardrail-note:${callId}`;
}

/** That a call runs, recorded before it runs, so a step run again after a park knows (`callRan`). */
function ranKey(callId: string): string {
  return `guardrail-ran:${callId}`;
}

/** A call the turn ran, by its reply's stored sequence and the model's id for it, unique in the turn. */
export function ranCallKey(replySequence: number, callId: string): string {
  return `${replySequence}:${callId}`;
}

/**
 * Records, before the call runs, that it runs (`ctx.ranCalls`), for the
 * trace's `toolCalls` at the loop's points. Only in a turn with a
 * guardrail in the loop: no other trace reads it.
 */
export async function markCallRan(
  ctx: TurnContext,
  kctx: NodeContext,
  replySequence: number,
  callId: string,
): Promise<void> {
  if (!hasLoopGuardrails(ctx)) return;
  await kctx.record(ranKey(callId), () => true);
  ctx.ranCalls ??= new Set();
  ctx.ranCalls.add(ranCallKey(replySequence, callId));
}

/**
 * For a call whose stored result a step run again after a park reuses:
 * whether it ran (its `markCallRan` record), restored to `ctx.ranCalls`,
 * and the guardrails whose note its result is, if it's one. Journals
 * nothing new.
 */
export async function reusedCallState(
  ctx: TurnContext,
  kctx: NodeContext,
  replySequence: number,
  callId: string,
): Promise<{ readonly note?: readonly string[] }> {
  if (!hasLoopGuardrails(ctx)) return {};
  const ran = await kctx.record<true | undefined>(ranKey(callId), () => undefined);
  if (ran === true) {
    ctx.ranCalls ??= new Set();
    ctx.ranCalls.add(ranCallKey(replySequence, callId));
  }
  const note = await kctx.record<readonly string[] | undefined>(noteKey(callId), () => undefined);
  return note !== undefined ? { note } : {};
}

/** Records the guardrails whose note answers the call, before the note is stored. */
export async function recordNote(
  kctx: NodeContext,
  callId: string,
  guardrailIds: readonly string[],
): Promise<void> {
  await kctx.record(noteKey(callId), () => [...guardrailIds]);
}

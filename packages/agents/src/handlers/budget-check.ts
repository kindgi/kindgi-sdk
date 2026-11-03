// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext, NodeHandler } from '@kindgi/handler';
import type { Timestamp } from '@kindgi/types';

import { AGENT_TURN_LOOP_MAX_ITERATIONS } from '../agent-turn-flow.js';
import type { GuardrailEvaluationError } from '../guardrails-gate.js';
import type { AgentOutputSpec } from '../types.js';
import { DEFAULT_MAX_STEPS } from './constants.js';
import type { AgentTurnIterationOutput, TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import {
  addCheckNodes,
  addModelOutputNode,
  emitGateEvents,
  failTurn,
  judgeAnswer,
  recordOutcomes,
  violationsOf,
  withBlocked,
} from './evaluate-guardrails.js';
import { guardrailsAt, loopIteration } from './guardrail-points.js';
import {
  answerNotes,
  attemptsOf,
  isRetryGuardrail,
  judgedInLoop,
  retryNote,
  sentBackSoFar,
  turnRetryNotes,
} from './guardrail-retry.js';
import {
  DEFAULT_MAX_REPAIRS,
  type OutputChecker,
  outputChecker,
  repairMessage,
  repairsSoFar,
} from './structured-output.js';

/**
 * Loop-body node #3. The final gate before `$loop-end`. Decides
 * whether the iteration finalizes the turn based on:
 *
 *   - The model's `finishReason` (anything other than `tool-use` with
 *     calls terminates).
 *   - `agent.budget.maxSteps` — enforced against `ctx.usage.steps`, and
 *     held to `AGENT_TURN_LOOP_MAX_ITERATIONS`: the turn's loop runs no
 *     more iterations than that, so a turn that would go on past it
 *     fails here, as `budget-exceeded`, instead of the loop ending
 *     with no answer.
 *   - `agent.budget.maxCostUsd` — enforced against cumulative cost.
 *   - Cooperative abort from `ctx.turnAbort`.
 *   - `agent.output` — a final answer that isn't JSON matching the
 *     schema keeps the turn going with a repair message, while repairs
 *     (and steps) are left; after that the turn fails with
 *     `output-schema-violation`. Skipped on a dry run.
 *   - The turn's `retry` guardrails at the final answer — when it has
 *     one, a finished answer (a valid one, for a typed agent) is judged
 *     here on its `halt` and `retry` guardrails there. A `halt` that fails it fails the turn at once. A
 *     `retry` that fails it sends it back with a note giving the reasons,
 *     while that guardrail's attempts (and the steps) last; after that the
 *     turn fails with `guardrail-violation`. Skipped on a dry run. The
 *     answer it lets finish is named on `ctx.answerJudgedInLoop`, so
 *     `evaluate-guardrails` judges it on the other guardrails only.
 *
 * Returns the fully-shaped `AgentTurnIterationOutput` — this is the
 * iteration's `$loop-end` output that the loop node's `outputSchema`
 * validates against.
 */
export function buildBudgetCheckHandler(ctx: TurnContext): NodeHandler {
  let checker: OutputChecker | undefined;
  return async (input: unknown, kctx) => {
    // Names this iteration's answer only once it's judged here, below.
    ctx.answerJudgedInLoop = undefined;
    if (ctx.turnAbort.signal.aborted) {
      throwAgentTurnFailure({
        code: 'agent-turn-aborted',
        message: 'Agent turn aborted before budget-check',
        reason: ctx.abortReason ?? 'timeout',
      });
    }

    const partial = input as {
      readonly step: number;
      readonly finishReason: AgentTurnIterationOutput['finishReason'];
      readonly message: ModelMessage;
      readonly iterationAppended: readonly AgentTurnIterationOutput['iterationAppended'][number][];
      readonly iterationUsage: AgentTurnIterationOutput['iterationUsage'];
      readonly provider: AgentTurnIterationOutput['provider'];
      readonly nextMessages: readonly ModelMessage[];
      readonly hasToolCalls: boolean;
    };

    const declaredSteps = ctx.input.agent.budget?.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxSteps = Math.min(declaredSteps, AGENT_TURN_LOOP_MAX_ITERATIONS);
    const maxCostUsd = ctx.input.agent.budget?.maxCostUsd;

    // Cost cap is a hard failure — the caller sees `budget-exceeded`
    // before the turn tries another iteration.
    if (maxCostUsd !== undefined && ctx.usage.totalCostUsd > maxCostUsd) {
      throwAgentTurnFailure({
        code: 'budget-exceeded',
        message: `Agent turn cost budget exceeded (limit ${maxCostUsd}, observed ${ctx.usage.totalCostUsd})`,
        kind: 'cost',
        limit: maxCostUsd,
        observed: ctx.usage.totalCostUsd,
      });
    }

    // Step cap — if the model still wants another tool call but we've
    // used the allotted steps, fail the run. A `maxSteps` above the
    // loop's iterations stops at the loop's, and the message says why.
    if (partial.hasToolCalls && ctx.usage.steps >= maxSteps) {
      const held =
        maxSteps < declaredSteps
          ? `: a turn makes at most ${AGENT_TURN_LOOP_MAX_ITERATIONS} model calls, fewer than its maxSteps of ${declaredSteps}`
          : '';
      throwAgentTurnFailure({
        code: 'budget-exceeded',
        message: `Agent turn steps budget exceeded (limit ${maxSteps}, observed ${ctx.usage.steps})${held}`,
        kind: 'steps',
        limit: maxSteps,
        observed: ctx.usage.steps,
      });
    }

    // `finishedTurn` semantics: true when the model's finishReason is
    // terminal (i.e. not a live tool-use) — the current iteration's
    // assistant message is the final answer.
    let finishedTurn = !partial.hasToolCalls;
    let nextMessages = partial.nextMessages;

    const spec = ctx.input.agent.output;
    if (finishedTurn && spec !== undefined && !kctx.dryRun) {
      checker ??= outputChecker(spec);
      const repair = outputRepair(spec, checker, partial.message, partial.nextMessages, {
        stepsLeft: ctx.usage.steps < maxSteps,
      });
      if (repair !== undefined) {
        finishedTurn = false;
        nextMessages = repair;
      }
    }

    if (
      finishedTurn &&
      !kctx.dryRun &&
      guardrailsAt(ctx.guardrails, 'final-answer').some(isRetryGuardrail)
    ) {
      const sentBack = await judgeInLoop(ctx, kctx, partial, nextMessages, maxSteps);
      if (sentBack !== undefined) {
        finishedTurn = false;
        nextMessages = sentBack;
      }
    }

    const output: AgentTurnIterationOutput = {
      finishReason: partial.finishReason,
      message: partial.message,
      iterationAppended: partial.iterationAppended,
      iterationUsage: partial.iterationUsage,
      provider: partial.provider,
      finishedTurn,
      nextMessages,
    };
    return output;
  };
}

/** An answer the loop judges: the model's message, and who wrote it. */
type Answer = Pick<AgentTurnIterationOutput, 'message' | 'provider'>;

/**
 * Judge the answer that would finish the turn on its `halt` and `retry`
 * guardrails (`guardrailRetry`). Returns the messages that send it back,
 * or `undefined` when it passed them, and then names it, by iteration and
 * message, on `ctx.answerJudgedInLoop`, with the checks there that
 * couldn't run on it.
 */
async function judgeInLoop(
  ctx: TurnContext,
  kctx: NodeContext,
  answer: Answer,
  sent: readonly ModelMessage[],
  maxSteps: number,
): Promise<readonly ModelMessage[] | undefined> {
  const iteration = loopIteration(kctx, ctx);
  const judged = await guardrailRetry(ctx, kctx, iteration, answer, sent, {
    // A new answer is another model call, in another iteration: within
    // the agent's steps, and within the loop's own cap, or the loop
    // would end on the answer it sent back.
    stepsLeft: ctx.usage.steps < maxSteps && iteration + 1 < AGENT_TURN_LOOP_MAX_ITERATIONS,
  });
  if (judged.kind === 'sent-back') return judged.messages;
  ctx.answerJudgedInLoop = {
    iteration,
    message: JSON.stringify(answer.message),
    errors: judged.errors,
  };
  return undefined;
}

/**
 * Judge a finished answer on the turn's `halt` and `retry` guardrails.
 * A `halt` that fails it fails the turn at once, before any answer is
 * sent back. A `retry` that fails it returns the next model call's
 * messages (the answer, then a note with the guardrails' reasons) while
 * each such guardrail has attempts left (`retry.maxAttempts`, answers in
 * all, the first one included) and the turn has steps left; otherwise the
 * turn fails with `guardrail-violation`, with the answers it wrote; the
 * answer that fails it has its checks in provenance, as the outer gate's
 * final answer does. `passed`: the answer passed them, with the checks
 * that couldn't run.
 * Each answer's outcomes go to the ledger under this step and its
 * iteration (`budget-check@2`), so one answer's never replace another's.
 */
async function guardrailRetry(
  ctx: TurnContext,
  kctx: NodeContext,
  iteration: number,
  answer: Answer,
  sent: readonly ModelMessage[],
  budget: { readonly stepsLeft: boolean },
): Promise<
  | { readonly kind: 'sent-back'; readonly messages: readonly ModelMessage[] }
  | { readonly kind: 'passed'; readonly errors: readonly GuardrailEvaluationError[] }
> {
  const guardrails = guardrailsAt(ctx.guardrails, 'final-answer').filter(judgedInLoop);
  const evaluatedAt = new Date().toISOString() as Timestamp;
  const categorized = await judgeAnswer(ctx, kctx, answer.message, guardrails, evaluatedAt);
  const halted = categorized.blocking.length > 0 || categorized.blockingErrors.length > 0;
  const notes = answerNotes(
    turnRetryNotes(ctx, sent),
    guardrailsAt(ctx.guardrails, 'final-answer'),
  );
  const sentBack = sentBackSoFar(notes);
  const byId = new Map(guardrails.map((g) => [g.id as unknown as string, g]));
  const outOfAttempts = halted
    ? []
    : categorized.retry.filter((v) => {
        const id = v.guardrailId as unknown as string;
        const guardrail = byId.get(id);
        const answers = (sentBack.get(id) ?? 0) + 1;
        return !budget.stepsLeft || guardrail === undefined || answers >= attemptsOf(guardrail);
      });
  const stepId = `${kctx.nodeId as unknown as string}@${iteration}`;
  // Recorded before acting on them, as the outer gate does.
  await recordOutcomes(
    ctx,
    kctx,
    evaluatedAt,
    withBlocked(categorized.checks, outOfAttempts),
    stepId,
  );
  await emitGateEvents(ctx, categorized);
  if (halted || outOfAttempts.length > 0) {
    // The answer that fails the turn is its final one: it and its checks
    // go in provenance, as the outer gate's do.
    addModelOutputNode(ctx, answer.provider, evaluatedAt);
    addCheckNodes(ctx, violationsOf(categorized), categorized.errors, notes, evaluatedAt);
    return halted
      ? failTurn(ctx, categorized.blocking, categorized.blockingErrors, categorized.errors)
      : failTurn(ctx, outOfAttempts, [], categorized.errors, notes.length + 1);
  }
  if (categorized.retry.length === 0) return { kind: 'passed', errors: categorized.errors };
  return { kind: 'sent-back', messages: [...sent, answer.message, retryNote(categorized.retry)] };
}

/**
 * Check a final answer against the agent's output schema. A valid
 * answer returns `undefined` (the turn finishes). An invalid one with
 * repairs and steps left returns the next model call's messages: the
 * answer, then a repair message listing what's wrong. Otherwise the
 * turn fails with `output-schema-violation`.
 */
function outputRepair(
  spec: AgentOutputSpec,
  checker: OutputChecker,
  answer: ModelMessage,
  sent: readonly ModelMessage[],
  budget: { readonly stepsLeft: boolean },
): readonly ModelMessage[] | undefined {
  const checked = checker.check(answer.content);
  if (checked.kind === 'ok') return undefined;
  const repairs = repairsSoFar(sent);
  if (repairs < (spec.maxRepairs ?? DEFAULT_MAX_REPAIRS) && budget.stepsLeft) {
    return [...sent, answer, repairMessage(spec, checked.errors)];
  }
  throwAgentTurnFailure({
    code: 'output-schema-violation',
    message: `The agent's answer does not match its ${spec.name ?? 'output'} schema after ${repairs} repair${repairs === 1 ? '' : 's'}: ${checked.errors.join('; ')}`,
    errors: checked.errors,
    attempts: repairs + 1,
  });
}

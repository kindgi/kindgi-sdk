// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeHandler } from '@kindgi/handler';

import type { AgentOutputSpec } from '../types.js';
import { DEFAULT_MAX_STEPS } from './constants.js';
import type { AgentTurnIterationOutput, TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
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
 *   - `agent.budget.maxSteps` — enforced against `ctx.usage.steps`.
 *   - `agent.budget.maxCostUsd` — enforced against cumulative cost.
 *   - Cooperative abort from `ctx.turnAbort`.
 *   - `agent.output` — a final answer that isn't JSON matching the
 *     schema keeps the turn going with a repair message, while repairs
 *     (and steps) are left; after that the turn fails with
 *     `output-schema-violation`. Skipped on a dry run.
 *
 * Returns the fully-shaped `AgentTurnIterationOutput` — this is the
 * iteration's `$loop-end` output that the loop node's `outputSchema`
 * validates against.
 */
export function buildBudgetCheckHandler(ctx: TurnContext): NodeHandler {
  let checker: OutputChecker | undefined;
  return async (input: unknown, kctx) => {
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

    const maxSteps = ctx.input.agent.budget?.maxSteps ?? DEFAULT_MAX_STEPS;
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
    // used the allotted steps, fail the run.
    if (partial.hasToolCalls && ctx.usage.steps >= maxSteps) {
      throwAgentTurnFailure({
        code: 'budget-exceeded',
        message: `Agent turn steps budget exceeded (limit ${maxSteps}, observed ${ctx.usage.steps})`,
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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LoopNodeOutput } from '@kindgi/handler';

import { AGENT_TURN_LOOP_MAX_ITERATIONS } from '../agent-turn-flow.js';

import type { AgentTurnIterationOutput } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * The agent loop's final iteration — the response the turn ends with.
 * `nodeName` names the reading node in the failure message.
 *
 * Only an iteration that finished the turn is an answer, so an
 * unfinished one fails the turn here, before either reader uses it. The
 * loop ends early only on a finished iteration: when it ran out
 * (`max-iterations`), the turn fails with `budget-exceeded`, kind
 * `steps`, as `budget-check` fails a turn whose model still wants a tool
 * on the last iteration. An unfinished iteration that ended the loop any
 * other way is broken loop output.
 *
 * So is loop output the readers can't read: not an object, without a
 * `finalOutput` object, or a finished iteration whose `message` or
 * `provider` isn't an object. It fails the turn with
 * `model-invocation-failed`.
 */
export function finalIteration(loopOutput: unknown, nodeName: string): AgentTurnIterationOutput {
  if (loopOutput === undefined) brokenLoopOutput(nodeName, 'undefined loop output');
  if (!isObject(loopOutput)) {
    brokenLoopOutput(nodeName, `loop output that is not an object (${kindOf(loopOutput)})`);
  }
  const output = loopOutput as LoopNodeOutput<AgentTurnIterationOutput>;
  if (output.finalOutput === undefined || output.finalOutput === null) {
    brokenLoopOutput(nodeName, 'loop output without finalOutput');
  }
  if (!isObject(output.finalOutput)) {
    brokenLoopOutput(
      nodeName,
      `loop output whose finalOutput is not an object (${kindOf(output.finalOutput)})`,
    );
  }
  const final = output.finalOutput;
  if (final.finishedTurn !== true) {
    if (output.stopReason === 'max-iterations') {
      throwAgentTurnFailure({
        code: 'budget-exceeded',
        message: `Agent turn steps budget exceeded (limit ${AGENT_TURN_LOOP_MAX_ITERATIONS}, observed ${output.iterations}): a turn makes at most ${AGENT_TURN_LOOP_MAX_ITERATIONS} model calls, and the last one did not finish the turn, so ${nodeName} has no answer`,
        kind: 'steps',
        limit: AGENT_TURN_LOOP_MAX_ITERATIONS,
        observed: output.iterations,
      });
    }
    brokenLoopOutput(
      nodeName,
      `loop output whose last iteration did not finish the turn (stopReason ${output.stopReason}, ${output.iterations} iterations)`,
    );
  }
  if (!isObject(final.message)) {
    brokenLoopOutput(
      nodeName,
      `loop output whose last iteration's message is not an object (${kindOf(final.message)})`,
    );
  }
  if (!isObject(final.provider)) {
    brokenLoopOutput(
      nodeName,
      `loop output whose last iteration's provider is not an object (${kindOf(final.provider)})`,
    );
  }
  return final;
}

/** Fails the turn on loop output `nodeName` can't read: a broken flow state. */
function brokenLoopOutput(nodeName: string, received: string): never {
  throwAgentTurnFailure({
    code: 'model-invocation-failed',
    message: `${nodeName} received ${received}`,
    cause: null,
  });
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** What a value that isn't an object is: `null`, or its `typeof`. */
function kindOf(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

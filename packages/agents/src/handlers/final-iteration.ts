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
 * other way is broken loop output, like a missing one.
 */
export function finalIteration(loopOutput: unknown, nodeName: string): AgentTurnIterationOutput {
  const output = loopOutput as LoopNodeOutput<AgentTurnIterationOutput> | undefined;
  if (output === undefined) {
    throwAgentTurnFailure({
      code: 'model-invocation-failed',
      message: `${nodeName} received undefined loop output`,
      cause: null,
    });
  }
  if (output.finalOutput === undefined || output.finalOutput === null) {
    throwAgentTurnFailure({
      code: 'model-invocation-failed',
      message: `${nodeName} received loop output without finalOutput`,
      cause: null,
    });
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
    throwAgentTurnFailure({
      code: 'model-invocation-failed',
      message: `${nodeName} received loop output whose last iteration did not finish the turn (stopReason ${output.stopReason}, ${output.iterations} iterations)`,
      cause: null,
    });
  }
  return final;
}

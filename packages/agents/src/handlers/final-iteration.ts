// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LoopNodeOutput } from '@kindgi/handler';

import type { AgentTurnIterationOutput } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * The agent loop's final iteration — the response the turn ends with.
 * `nodeName` names the reading node in the failure message.
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
  if (output.finalOutput === undefined) {
    throwAgentTurnFailure({
      code: 'model-invocation-failed',
      message: `${nodeName} received loop output without finalOutput`,
      cause: null,
    });
  }
  return output.finalOutput;
}

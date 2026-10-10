// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A rescore: a new comparison eval run of the same test set version,
 * candidate and settings that replays nothing. It scores the run's replays
 * again, with what people judged on them since (`comparison.rescoreOf`).
 * The run rescored stays as it was. `POST /v1/eval-runs/{runId}/rescore`
 * and `POST /v1/proposals/{proposalId}/rescore` both start one.
 */

import type { ProjectId } from '@kindgi/types';

import type { EvalRun, EvalRunStartInput } from './eval-run-binding.js';
import { DEFAULT_COMPARISON } from './judged-dispatcher.js';

/** Why `run` can't be rescored, or `undefined` when it can: a completed comparison of a test set. */
export function rescoreRefusal(run: EvalRun): string | undefined {
  if (run.kind === 'judged' && run.status === 'completed') return undefined;
  return `Eval run ${run.runId as unknown as string} can't be rescored: only a completed comparison of a test set can (this one is a ${run.kind} run, ${run.status}).`;
}

/** The start of a rescore of `run`, in `projectId`. */
export function rescoreStart(
  run: EvalRun,
  projectId: ProjectId,
  correlationId?: string,
): EvalRunStartInput {
  return {
    tenantId: run.tenantId,
    projectId,
    suiteId: run.suiteId,
    suiteVersion: run.suiteVersion,
    ...(run.agentRef !== undefined && { agentRef: run.agentRef }),
    ...(run.flowRef !== undefined && { flowRef: run.flowRef }),
    ...(correlationId !== undefined && { correlationId }),
    // A comparison started without settings ran the defaults.
    comparison: {
      ...(run.comparison ?? DEFAULT_COMPARISON),
      rescoreOf: run.runId as unknown as string,
    },
  };
}

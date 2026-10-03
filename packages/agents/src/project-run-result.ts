// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { KernelError, RunResult } from '@kindgi/runtime';
import type { Result } from '@kindgi/types';

import type { TurnContext } from './handlers/context.js';
import { parseFailureMessage } from './handlers/errors.js';
import type { InvokeAgentError } from './handlers/errors.js';
import type { AgentTurnResult } from './handlers/result-shape.js';
import { emitTurnEvent } from './streaming.js';

/**
 * Translate a kernel `Result<RunResult, KernelError>` into the
 * caller-facing `Result<AgentTurnResult, InvokeAgentError>`. Rules:
 *
 *   - Kernel-level errors (`handler-missing`, `flow-mismatch`,
 *     `journal-error`, `stuck`, `run-not-found`, etc.) map to
 *     `model-invocation-failed` with the KernelError as cause.
 *   - Run status `completed` — output is the `AgentTurnResult`
 *     composed by `compose-result`; unwrap and return `Result.ok`.
 *   - Run status `failed` — `failureMessage` was serialized by
 *     `AgentTurnFailure` on the throwing handler; parse back into
 *     structured `InvokeAgentError`. Fall back to
 *     `model-invocation-failed` if the message isn't ours.
 *   - Run status `cancelled` — external abort. Use `ctx.abortReason`
 *     to distinguish external vs timeout.
 */
export async function projectRunResult(
  kernelResult: Result<RunResult<AgentTurnResult>, KernelError>,
  ctx: TurnContext,
): Promise<Result<AgentTurnResult, InvokeAgentError>> {
  if (kernelResult.kind === 'err') {
    return {
      kind: 'err',
      error: {
        code: 'model-invocation-failed',
        message: `Kernel run failed: ${kernelResult.error.message}`,
        cause: kernelResult.error,
      },
    };
  }

  const run = kernelResult.value;
  if (run.status === 'completed') {
    if (run.output === undefined) {
      return {
        kind: 'err',
        error: {
          code: 'model-invocation-failed',
          message: 'Agent-turn run completed without emitting a result',
          cause: null,
        },
      };
    }
    return { kind: 'ok', value: { ...run.output, status: 'completed' } };
  }

  // Park-and-resume: the run suspended on a waitpoint (the setup
  // handler's session-HITL gate or a tool-level gate in the
  // dispatch-tools handler). Turn hasn't produced a response yet — the
  // reviewer's decision will resume the flow, and the resumed run's
  // completion produces the final AgentTurnResult in a follow-up call
  // (via resumeAgentTurn). An HTTP caller surfaces status='suspended'
  // to its client. Return a minimally-shaped AgentTurnResult so
  // kind='ok' is honest — the parked run is a successful start, not a
  // failure.
  if (run.status === 'suspended') {
    return {
      kind: 'ok',
      value: {
        runId: run.runId,
        conversationId: ctx.input.conversationId,
        turnNumber: 0,
        appended: [],
        response: {
          role: 'assistant',
          content: '',
        } as never,
        retrieved: [],
        violations: [],
        usage: {
          steps: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalCostUsd: 0,
          durationMs: Date.now() - ctx.startedAt,
        },
        provider: { id: '', model: '' },
        status: 'suspended',
      },
    };
  }

  if (run.status === 'cancelled') {
    const err: InvokeAgentError = {
      code: 'agent-turn-aborted',
      message: `Agent turn cancelled${run.failureMessage !== undefined ? `: ${run.failureMessage}` : ''}`,
      reason: ctx.abortReason ?? 'external',
    };
    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'turn.failed',
      conversationId: ctx.input.conversationId,
      errorCode: err.code,
      message: err.message,
    });
    return { kind: 'err', error: err };
  }

  // Failed
  const parsed = parseFailureMessage(run.failureMessage);
  if (parsed !== undefined) {
    // For failed runs, `turn.failed` is emitted only for guardrail
    // violations, by the evaluate-guardrails handler — nothing to emit
    // here.
    if (parsed.code === 'guardrail-violation') {
      // Already emitted by the evaluate-guardrails handler — skip.
    }
    return { kind: 'err', error: parsed };
  }

  // Unstructured failure — a bare exception the handlers didn't wrap.
  return {
    kind: 'err',
    error: {
      code: 'model-invocation-failed',
      message: run.failureMessage ?? 'Agent turn failed',
      cause: null,
    },
  };
}

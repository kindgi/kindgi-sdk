// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Timestamp } from '@kindgi/types';

import type { GuardrailError, JudgeMissingError, ScopeMismatchError } from './errors.js';
import {
  type ExecutionStrategy,
  type ExecutionStrategyRegistry,
  createExecutionStrategyRegistry,
  externalStrategy,
  makeLlmJudgeStrategy,
  zeroLlmStrategy,
} from './execution-strategy.js';
import { type LlmJudgeConfig, invokeJudge } from './judge.js';
import type {
  CheckRegistry,
  CheckResult,
  EvaluationBindings,
  EvaluationResult,
  Guardrail,
  RunTrace,
  Scope,
} from './types.js';

/**
 * Default strategy registry seeded with the built-ins (`zero-llm`,
 * `llm-judge`, `external`). Cached so repeated `evaluateGuardrail`
 * calls don't reinstantiate the registry.
 */
let defaultRegistry: ExecutionStrategyRegistry | undefined;
function getDefaultStrategyRegistry(): ExecutionStrategyRegistry {
  if (defaultRegistry === undefined) {
    defaultRegistry = createExecutionStrategyRegistry([
      zeroLlmStrategy,
      makeLlmJudgeStrategy((config, capability, trace, bindings) =>
        invokeJudge(config as LlmJudgeConfig, capability, trace, bindings),
      ),
      externalStrategy,
    ]);
  }
  return defaultRegistry;
}

/** Expose the built-in registry so callers can extend it with adapter strategies. */
export function builtInStrategies(): readonly ExecutionStrategy[] {
  return getDefaultStrategyRegistry().list();
}

/**
 * Evaluate one guardrail against a run trace. Handles:
 *   - Scope check (mode + agent + flow + tenant filters).
 *   - Dispatch by `kind` through `bindings.strategies` (or the built-ins):
 *     zero-llm → check.evaluate; llm-judge → invokeJudge; external → an
 *     `invalid-guardrail` error unless the caller registered its own
 *     `external` strategy.
 *   - Action derivation from `guardrail.action.on-violation`.
 *   - Compliance evidence emission on violation (if bindings.compliance
 *     is set and the trace carries a `projectId`).
 *   - Action-handler invocation on violation (if bindings.actions is set);
 *     an action with no registered handler returns `unknown-action`.
 *
 * Returns:
 *   - `{ kind: 'ok', value: EvaluationResult }` — guardrail applied + evaluated.
 *   - `{ kind: 'skip', reason }` — guardrail didn't apply (scope mismatch).
 *   - `{ kind: 'err', error }` — evaluation failed (unknown kind or check,
 *     judge missing or unroutable), or the violation's action has no
 *     handler in `bindings.actions` (`unknown-action`, after the violation
 *     was recorded).
 */
export type EvaluationOutcome =
  | { readonly kind: 'ok'; readonly value: EvaluationResult }
  | { readonly kind: 'skip'; readonly reason: ScopeMismatchError }
  | { readonly kind: 'err'; readonly error: GuardrailError | JudgeMissingError };

export async function evaluateGuardrail(
  guardrail: Guardrail,
  checks: CheckRegistry,
  trace: RunTrace,
  bindings: EvaluationBindings = {},
): Promise<EvaluationOutcome> {
  const scope = checkScope(guardrail, trace);
  if (scope !== null) return { kind: 'skip', reason: scope };

  // Check-registry lookup is delegated to each strategy — `zero-llm`
  // resolves the check inside its evaluate; strategies like
  // `sandbox-code` or `external` don't consult the CheckRegistry at
  // all. Keeps the engine strategy-agnostic.

  const strategies = bindings.strategies ?? getDefaultStrategyRegistry();
  const strategy = strategies.get(guardrail.kind);
  if (strategy === undefined) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-guardrail',
        message: `Guardrail "${guardrail.id}" declares unknown kind "${guardrail.kind}" — no execution strategy registered`,
        issues: [{ path: '/kind', message: `unknown kind: ${guardrail.kind}` }],
      },
    };
  }
  const strategyOutcome = await strategy.evaluate(guardrail, checks, trace, bindings);
  if (strategyOutcome.kind === 'err') {
    const err = strategyOutcome.error;
    return {
      kind: 'err',
      error: {
        code: err.code,
        message: err.message,
        ...(err.issues !== undefined && { issues: err.issues }),
        guardrailId: guardrail.id,
      } as GuardrailError | JudgeMissingError,
    };
  }
  const result: CheckResult = strategyOutcome.value;

  const action: EvaluationResult['action'] = result.passed
    ? 'noop'
    : guardrail.action['on-violation'];
  const severity = guardrail.severity ?? 'error';
  const evaluation: EvaluationResult = {
    guardrailId: guardrail.id,
    result,
    action,
    severity,
    at: new Date().toISOString() as Timestamp,
  };

  if (!result.passed && bindings.compliance !== undefined && trace.projectId !== undefined) {
    // Compliance emit needs `projectId` (every evidence record is
    // project-scoped). Skip emit when the trace carries no project
    // scope.
    await bindings.compliance.emit({
      tenantId: trace.tenantId,
      projectId: trace.projectId,
      kind: 'guardrail-violation',
      outcome: 'failed',
      payload: {
        version: 1,
        guardrailId: guardrail.id,
        guardrailName: guardrail.name,
        checkId: guardrail.check,
        checkKind: guardrail.kind,
        severity,
        action: guardrail.action['on-violation'],
        reason: result.reason,
        judgeResponse: result.judgeResponse,
        attributes: result.attributes,
      },
      ...(trace.runId !== undefined && {
        provenanceRef: { runId: trace.runId },
      }),
    });
  }

  // Invoke the registered action handler. Handler errors are logged into
  // the evaluation attributes but don't roll back the evaluation itself —
  // the violation is still recorded. `on-violation` is an open string, so
  // an action nobody registered a handler for fails here, by name.
  if (bindings.actions !== undefined && !result.passed) {
    const handler = bindings.actions.get(action);
    if (handler === undefined) {
      return {
        kind: 'err',
        error: {
          code: 'unknown-action',
          message: `Guardrail "${guardrail.id}" fired action "${action}", but no action handler is registered for it`,
          guardrailId: guardrail.id,
          action,
        },
      };
    }
    const applied = await handler.apply({ guardrail, evaluation, trace });
    if (applied.kind === 'err') {
      // Attach handler error to the evaluation attributes; don't fail.
      (evaluation as { result: CheckResult }).result = {
        ...evaluation.result,
        attributes: {
          ...(evaluation.result.attributes ?? {}),
          actionHandlerError: applied.error,
        },
      };
    }
  }

  return { kind: 'ok', value: evaluation };
}

/**
 * Evaluate every guardrail in the list against a trace. Order-independent —
 * each check is a pure function over the trace. Returns one outcome per
 * guardrail.
 */
export async function evaluateAll(
  guardrails: readonly Guardrail[],
  checks: CheckRegistry,
  trace: RunTrace,
  bindings: EvaluationBindings = {},
): Promise<readonly EvaluationOutcome[]> {
  return Promise.all(guardrails.map((inv) => evaluateGuardrail(inv, checks, trace, bindings)));
}

/**
 * Extract only the violations from a batch of outcomes — convenience for
 * callers that want to apply enforcement actions.
 */
export function violations(outcomes: readonly EvaluationOutcome[]): readonly EvaluationResult[] {
  const out: EvaluationResult[] = [];
  for (const o of outcomes) {
    if (o.kind === 'ok' && !o.value.result.passed) out.push(o.value);
  }
  return out;
}

function checkScope(guardrail: Guardrail, trace: RunTrace): ScopeMismatchError | null {
  const scope: Scope = guardrail.scope ?? {};
  const when = scope.when ?? 'always';
  if (when === 'ci-only' && trace.mode !== 'ci') {
    return {
      code: 'scope-mismatch',
      message: `guardrail "${guardrail.id}" is ci-only`,
      guardrailId: guardrail.id,
      reason: 'wrong-mode',
    };
  }
  if (when === 'runtime-only' && trace.mode !== 'runtime') {
    return {
      code: 'scope-mismatch',
      message: `guardrail "${guardrail.id}" is runtime-only`,
      guardrailId: guardrail.id,
      reason: 'wrong-mode',
    };
  }
  if (
    scope.agents !== undefined &&
    scope.agents.length > 0 &&
    (trace.agentId === undefined || !scope.agents.includes(trace.agentId))
  ) {
    return {
      code: 'scope-mismatch',
      message: `guardrail "${guardrail.id}" does not apply to agent ${String(trace.agentId)}`,
      guardrailId: guardrail.id,
      reason: 'wrong-agent',
    };
  }
  if (
    scope.flows !== undefined &&
    scope.flows.length > 0 &&
    (trace.flowId === undefined || !scope.flows.includes(trace.flowId))
  ) {
    return {
      code: 'scope-mismatch',
      message: `guardrail "${guardrail.id}" does not apply to flow ${String(trace.flowId)}`,
      guardrailId: guardrail.id,
      reason: 'wrong-flow',
    };
  }
  if (
    scope.tenants !== undefined &&
    scope.tenants.length > 0 &&
    !scope.tenants.includes(trace.tenantId)
  ) {
    return {
      code: 'scope-mismatch',
      message: `guardrail "${guardrail.id}" does not apply to tenant ${trace.tenantId}`,
      guardrailId: guardrail.id,
      reason: 'wrong-tenant',
    };
  }
  return null;
}

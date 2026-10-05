// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Capability } from '@kindgi/capabilities';

import type {
  CheckRegistry,
  CheckResult,
  EvaluationBindings,
  Guardrail,
  RunTrace,
} from './types.js';

/**
 * A strategy that knows how to evaluate one `Guardrail.kind`. Registered
 * once at boot; the engine dispatches by looking up `guardrail.kind`
 * against the strategy registry.
 *
 * Built-in strategies: `zero-llm` (delegates to `CheckRegistry`),
 * `llm-judge` (routes through capabilities + `invokeJudge`), and
 * `external` (returns an "evaluated elsewhere" error).
 *
 * Adapter packages register their own strategies without touching the
 * engine — e.g. a strategy that runs check code in a sandbox, or one
 * that delegates to an external policy engine.
 */
export interface ExecutionStrategy {
  readonly kind: string;
  /** Human-friendly name for diagnostics. */
  readonly name?: string;
  /**
   * Evaluate one guardrail against a trace. Returns the CheckResult the
   * engine finalizes into an EvaluationResult; or an error object shaped
   * to be surfaced directly.
   */
  evaluate(
    guardrail: Guardrail,
    checks: CheckRegistry,
    trace: RunTrace,
    bindings: EvaluationBindings,
  ): Promise<StrategyResult>;
}

/**
 * Discriminated result a strategy returns. `ok` produces a CheckResult;
 * `err` surfaces a structured error with a JSON-Pointer-style path so
 * the engine can attach it to the guardrail id it came from.
 */
export type StrategyResult =
  | { readonly kind: 'ok'; readonly value: CheckResult }
  | { readonly kind: 'err'; readonly error: StrategyError };

export interface StrategyError {
  /** Discriminant matching the engine's GuardrailError union or a sub-code. */
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
  /** Filled in by the engine — the guardrail id currently evaluating. */
  readonly guardrailId?: string;
}

/**
 * Registry the engine consults at dispatch time. Register once; every
 * subsequent `evaluateGuardrail` call sees the additional strategy.
 */
export interface ExecutionStrategyRegistry {
  register(strategy: ExecutionStrategy): void;
  get(kind: string): ExecutionStrategy | undefined;
  list(): readonly ExecutionStrategy[];
}

export function createExecutionStrategyRegistry(
  seed: readonly ExecutionStrategy[] = [],
): ExecutionStrategyRegistry {
  const strategies = new Map<string, ExecutionStrategy>();
  for (const s of seed) strategies.set(s.kind, s);
  return {
    register(strategy): void {
      strategies.set(strategy.kind, strategy);
    },
    get(kind): ExecutionStrategy | undefined {
      return strategies.get(kind);
    },
    list(): readonly ExecutionStrategy[] {
      return [...strategies.values()];
    },
  };
}

// ============ built-in strategies ============

/** `zero-llm` — delegate to the registered `Check` via CheckRegistry. */
export const zeroLlmStrategy: ExecutionStrategy = {
  kind: 'zero-llm',
  name: 'Zero-LLM check',
  async evaluate(guardrail, checks, trace, bindings): Promise<StrategyResult> {
    const check = checks.get(guardrail.check);
    if (check === undefined) {
      return {
        kind: 'err',
        error: {
          code: 'unknown-check',
          message: `Guardrail "${guardrail.id}" references unregistered check "${guardrail.check}"`,
        },
      };
    }
    const config = (guardrail.config ?? {}) as Readonly<Record<string, unknown>>;
    const result = await check.evaluate(config, trace, bindings);
    return { kind: 'ok', value: result };
  },
};

/**
 * `external` — placeholder for guardrails evaluated by an external
 * service: it always returns an `invalid-guardrail` error. Callers that
 * want external evaluation register their own `external` strategy that
 * routes to their service.
 */
export const externalStrategy: ExecutionStrategy = {
  kind: 'external',
  name: 'External (not implemented at engine layer)',
  async evaluate(): Promise<StrategyResult> {
    return {
      kind: 'err',
      error: {
        code: 'invalid-guardrail',
        message:
          'external-kind guardrails are evaluated outside the engine — register an execution strategy for kind `external`',
        issues: [
          {
            path: '/kind',
            message: 'external kind requires a caller-registered execution strategy',
          },
        ],
      },
    };
  },
};

/**
 * Factory for the built-in `llm-judge` strategy. Takes the judge
 * function as a parameter so this module does not import judge.ts; the
 * engine passes `invokeJudge`.
 */
export function makeLlmJudgeStrategy(
  invokeJudge: (
    config: unknown,
    capability: Capability,
    trace: RunTrace,
    bindings: EvaluationBindings,
    guardrailId?: string,
  ) => Promise<
    CheckResult | { readonly error: { readonly code: string; readonly message: string } }
  >,
): ExecutionStrategy {
  return {
    kind: 'llm-judge',
    name: 'LLM judge',
    async evaluate(guardrail, _checks, trace, bindings): Promise<StrategyResult> {
      if (guardrail.judgeCapabilities === undefined) {
        return {
          kind: 'err',
          error: {
            code: 'invalid-guardrail',
            message: `llm-judge guardrail "${guardrail.id}" missing judgeCapabilities`,
            issues: [{ path: '/judgeCapabilities', message: 'required for kind=llm-judge' }],
          },
        };
      }
      const judged = await invokeJudge(
        guardrail.config ?? {},
        guardrail.judgeCapabilities,
        trace,
        bindings,
        guardrail.id,
      );
      if ('error' in judged) {
        return {
          kind: 'err',
          error: { code: judged.error.code, message: judged.error.message },
        };
      }
      return { kind: 'ok', value: judged };
    },
  };
}

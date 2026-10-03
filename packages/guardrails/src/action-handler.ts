// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EvaluationResult, Guardrail, RunTrace } from './types.js';

/**
 * A handler that knows how to APPLY one action (`halt`, `retry`,
 * `escalate`, `log-only`, `compensate`, or custom). Registered once at
 * boot. When `EvaluationBindings.actions` is set, the engine calls the
 * handler for a violation's action after evaluating the guardrail;
 * without it, the engine only reports the action and the caller applies
 * it.
 *
 * Handlers don't mutate the trace; they emit side effects (schedule
 * retry, enqueue HITL review, run compensating tool). The engine
 * computes `action` from the guardrail's declaration and hands off to
 * the registered handler.
 *
 * Adapter packages register their own action handlers (e.g. escalate →
 * a HITL queue) without touching the engine.
 */
export interface ActionHandler {
  /** Discriminant matching `guardrail.action['on-violation']`. */
  readonly action: string;
  /** Human-friendly name for diagnostics. */
  readonly name?: string;
  /**
   * Apply the action. Called after the engine identifies a violation.
   * An `err` result is attached to the evaluation as
   * `result.attributes.actionHandlerError`; it doesn't roll back the
   * evaluation (violation still recorded, compliance evidence still
   * emitted).
   */
  apply(context: ActionContext): Promise<ActionResult>;
}

export interface ActionContext {
  readonly guardrail: Guardrail;
  readonly evaluation: EvaluationResult;
  readonly trace: RunTrace;
}

export type ActionResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'err'; readonly error: { readonly code: string; readonly message: string } };

/** Registry the engine consults when a violation surfaces. */
export interface ActionHandlerRegistry {
  register(handler: ActionHandler): void;
  get(action: string): ActionHandler | undefined;
  list(): readonly ActionHandler[];
}

export function createActionHandlerRegistry(
  seed: readonly ActionHandler[] = [],
): ActionHandlerRegistry {
  const handlers = new Map<string, ActionHandler>();
  for (const h of seed) handlers.set(h.action, h);
  return {
    register(handler): void {
      handlers.set(handler.action, handler);
    },
    get(action): ActionHandler | undefined {
      return handlers.get(action);
    },
    list(): readonly ActionHandler[] {
      return [...handlers.values()];
    },
  };
}

// ============ built-in action handlers (record-only defaults) ============

/**
 * `halt` — the caller (e.g. the agent runtime) is expected to stop the
 * run. This handler is a no-op record; the enforcement happens in the
 * caller, which sees the `halt` action in the EvaluationResult.
 */
export const haltHandler: ActionHandler = {
  action: 'halt',
  name: 'Halt run',
  async apply(): Promise<ActionResult> {
    return { kind: 'ok' };
  },
};

/** `log-only` — record + carry on. */
export const logOnlyHandler: ActionHandler = {
  action: 'log-only',
  name: 'Log only',
  async apply(): Promise<ActionResult> {
    return { kind: 'ok' };
  },
};

/** `noop` — action synthesized when the check passes; nothing to do. */
export const noopHandler: ActionHandler = {
  action: 'noop',
  name: 'No-op (check passed)',
  async apply(): Promise<ActionResult> {
    return { kind: 'ok' };
  },
};

/**
 * `retry` — records the retry intent. Actual retry scheduling happens
 * in the caller. Handler validates the guardrail's action.retry policy
 * is well-formed.
 */
export const retryHandler: ActionHandler = {
  action: 'retry',
  name: 'Retry (caller-scheduled)',
  async apply(ctx): Promise<ActionResult> {
    const retry = ctx.guardrail.action.retry;
    if (retry === undefined || retry.maxAttempts <= 0) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-action-config',
          message: `retry action on guardrail "${ctx.guardrail.id}" needs action.retry.maxAttempts > 0`,
        },
      };
    }
    return { kind: 'ok' };
  },
};

/**
 * `escalate` — records the escalate intent. Actual routing (e.g. to a
 * HITL review queue) happens in the caller or an adapter handler.
 * Handler validates `guardrail.action.escalateTo` is set.
 */
export const escalateHandler: ActionHandler = {
  action: 'escalate',
  name: 'Escalate (caller-routed)',
  async apply(ctx): Promise<ActionResult> {
    if (ctx.guardrail.action.escalateTo === undefined) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-action-config',
          message: `escalate action on guardrail "${ctx.guardrail.id}" needs action.escalateTo`,
        },
      };
    }
    return { kind: 'ok' };
  },
};

/**
 * `compensate` — records the compensation intent. The caller invokes
 * the compensating tool via `guardrail.action.compensateWith`.
 */
export const compensateHandler: ActionHandler = {
  action: 'compensate',
  name: 'Compensate (caller-invoked)',
  async apply(ctx): Promise<ActionResult> {
    if (ctx.guardrail.action.compensateWith === undefined) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-action-config',
          message: `compensate action on guardrail "${ctx.guardrail.id}" needs action.compensateWith`,
        },
      };
    }
    return { kind: 'ok' };
  },
};

/** Convenience seed with all built-in handlers. */
export const BUILT_IN_ACTION_HANDLERS: readonly ActionHandler[] = [
  haltHandler,
  logOnlyHandler,
  noopHandler,
  retryHandler,
  escalateHandler,
  compensateHandler,
];

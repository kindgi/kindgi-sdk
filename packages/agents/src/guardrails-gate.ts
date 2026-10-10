// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProviderRegistry, TenantPolicy, UsageSink } from '@kindgi/capabilities';
import type { ComplianceProvider } from '@kindgi/compliance';
import {
  type CheckRegistry,
  type EvaluationBindings,
  type EvaluationOutcome,
  type EvaluationResult,
  type Guardrail,
  type GuardrailCheckOutcome,
  type GuardrailSeverity,
  type ModelCallRecord,
  type OnViolation,
  type RunTrace,
  type ToolCallRecord,
  type ToolResultRecord,
  evaluateAll,
} from '@kindgi/guardrails';
import type {
  AgentId,
  GuardrailId,
  OrgId,
  ProjectId,
  Result,
  RunId,
  TenantId,
} from '@kindgi/types';

import type { Agent, ConversationId, ConversationMessage } from './types.js';

/**
 * Turn usage snapshot passed into `buildRunTrace`. Local mirror of
 * `AgentTurnUsage` (handlers/result-shape.ts) — kept here to avoid a
 * circular import.
 */
interface TurnUsageSnapshot {
  readonly steps: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalCostUsd: number;
  readonly durationMs: number;
}

/**
 * Bindings the guardrail gate consumes. All optional — if `guardrails`
 * is empty or `checks` is undefined, `evaluateGate` is a no-op. An
 * agent that references a guardrail id missing from `guardrails` fails
 * its turn with `unresolved-guardrail`.
 */
export interface GuardrailsBindings {
  /** Full guardrail definitions available for this run. Indexed by id. */
  readonly guardrails?: readonly Guardrail[];
  /** Check registry with built-ins + any adapter-registered custom checks. */
  readonly checks?: CheckRegistry;
  /** Optional compliance sink — every failed check emits an evidence record. */
  readonly compliance?: ComplianceProvider;
  /**
   * Provider registry for llm-judge guardrails; the judge model is
   * routed through it under the turn's tenant policy. If absent,
   * llm-judge guardrails error with `judge-missing`; if no provider
   * satisfies the judge's capability, with `judge-routing-failed`.
   */
  readonly providerRegistry?: ProviderRegistry;
}

/**
 * Materialize a `RunTrace` from an agent turn's captured state. The
 * guardrail engine reads only the trace — it doesn't touch memory,
 * kernel journal, or provenance directly (keeps checks pure and
 * dependency-free).
 */
export function buildRunTrace(input: {
  /** The kernel run of the turn. */
  readonly runId: RunId;
  readonly tenantId: TenantId;
  /** Lets the engine record compliance evidence for a failed check. */
  readonly projectId: ProjectId;
  /** The project's org, when it has one. */
  readonly orgId?: OrgId;
  readonly conversationId: ConversationId;
  /** 1-based number of this turn in the conversation. */
  readonly turnNumber: number;
  readonly agent: Agent;
  /** The user message that started the turn. */
  readonly userMessage: string;
  /** The turn's structured input (`InvokeAgentInput.input`), when it has one. */
  readonly stepInput?: unknown;
  /** The parsed answer, when the agent declares `output`. */
  readonly structuredOutput?: unknown;
  readonly appended: readonly ConversationMessage[];
  readonly finalResponse: ConversationMessage;
  readonly usage: TurnUsageSnapshot;
}): RunTrace {
  const toolCalls: ToolCallRecord[] = [];
  const toolResults: ToolResultRecord[] = [];
  const modelCalls: ModelCallRecord[] = [];

  for (const msg of input.appended) {
    if (msg.role === 'agent' && typeof msg.content === 'object' && msg.content !== null) {
      const structured = msg.content as {
        readonly toolCalls?: readonly {
          readonly id: string;
          readonly name: string;
          readonly arguments: Readonly<Record<string, unknown>>;
        }[];
      };
      if (structured.toolCalls !== undefined) {
        for (const call of structured.toolCalls) {
          toolCalls.push({
            toolId: call.name as never,
            toolName: call.name,
            arguments: call.arguments,
            at: msg.createdAt,
          });
        }
      }
    }
    if (msg.role === 'tool' && msg.toolCall !== undefined) {
      toolResults.push({
        toolCallId: msg.toolCall.invocationId,
        output: msg.content,
        at: msg.createdAt,
      });
    }
  }

  // Approximate a model-call record for cost/latency guardrails — a
  // more granular per-call breakdown would need an observability
  // hook.
  modelCalls.push({
    providerId: 'runtime.picked',
    model: 'runtime.picked',
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    at: input.finalResponse.createdAt,
  });

  const output =
    typeof input.finalResponse.content === 'string'
      ? input.finalResponse.content
      : JSON.stringify(input.finalResponse.content);

  return {
    runId: input.runId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    ...(input.orgId !== undefined && { orgId: input.orgId }),
    agentId: input.agent.id as unknown as AgentId,
    output,
    toolCalls,
    toolResults,
    modelCalls,
    mode: 'runtime',
    userInput: input.userMessage,
    conversationId: input.conversationId as unknown as string,
    turnNumber: input.turnNumber,
    totalCostUsd: input.usage.totalCostUsd,
    durationMs: input.usage.durationMs,
    attributes: {
      steps: input.usage.steps,
      ...(input.stepInput !== undefined && { stepInput: input.stepInput }),
      ...(input.structuredOutput !== undefined && { structuredOutput: input.structuredOutput }),
    },
  };
}

/**
 * Filter the bound guardrail list to those referenced by the agent's
 * `guardrails: string[]` declaration. Missing references are collected
 * into `missing` — the caller decides whether that's fatal.
 */
export function resolveGuardrails(
  agent: Agent,
  bindings: GuardrailsBindings,
): { readonly resolved: readonly Guardrail[]; readonly missing: readonly string[] } {
  const available = new Map<string, Guardrail>();
  for (const inv of bindings.guardrails ?? []) available.set(inv.id, inv);
  const resolved: Guardrail[] = [];
  const missing: string[] = [];
  for (const id of agent.guardrails) {
    const inv = available.get(id);
    if (inv !== undefined) resolved.push(inv);
    else missing.push(id);
  }
  return { resolved, missing };
}

/**
 * Evaluate every resolved guardrail against the turn's trace. Returns
 * the raw outcomes so the caller can decide how to react — the gate
 * doesn't halt on its own. `tenantPolicy` (the policy the turn was
 * routed under) also governs which models llm-judge guardrails may use;
 * `abortSignal` (the turn's) reaches every check, so a slow judge or
 * pack check stops when the turn does. `usage` (the turn's sink) records
 * every llm-judge call, as the turn's own model calls are.
 */
export async function evaluateGate(
  guardrails: readonly Guardrail[],
  trace: RunTrace,
  bindings: GuardrailsBindings,
  tenantPolicy?: TenantPolicy,
  abortSignal?: AbortSignal,
  usage?: UsageSink,
): Promise<readonly EvaluationOutcome[]> {
  if (guardrails.length === 0) return [];
  // No check registry at all: every guardrail is one whose check can't run, never one that
  // passed, so a `halt` guardrail fails the turn here too (it fails closed).
  if (bindings.checks === undefined) {
    return guardrails.map((g) => ({
      kind: 'err' as const,
      error: {
        code: 'unknown-check' as const,
        message: `guardrail "${g.id}": no check registry is bound, so its check "${g.check}" can't run`,
        guardrailId: g.id,
        checkId: g.check,
      },
    }));
  }
  const evalBindings: EvaluationBindings = {
    ...(bindings.providerRegistry !== undefined && { providerRegistry: bindings.providerRegistry }),
    ...(bindings.compliance !== undefined && { compliance: bindings.compliance }),
    ...(tenantPolicy !== undefined && { tenantPolicy }),
    ...(abortSignal !== undefined && { abortSignal }),
    ...(usage !== undefined && { usage }),
  };
  return await evaluateAll(guardrails, bindings.checks, trace, evalBindings);
}

/**
 * A guardrail whose check couldn't run (no such check, a bad configuration, a judge that couldn't
 * be routed), with what the guardrail would have done. Never counted as a violation.
 */
export interface GuardrailEvaluationError {
  readonly guardrailId: string;
  readonly message: string;
  /** The engine's error code: `unknown-check`, `invalid-check-config`, `judge-routing-failed`, … */
  readonly code: string;
  /** The guardrail's `on-violation` action and severity; absent when the guardrail is unknown. */
  readonly action?: OnViolation;
  readonly severity?: GuardrailSeverity;
}

/**
 * Sort evaluation outcomes by the failed guardrail's action. `halt` is
 * blocking — the turn fails with `guardrail-violation`. `log-only` and
 * `noop` are warnings; every other action (`retry`, `escalate`,
 * `compensate`, or a custom action — actions are open strings) lands in
 * `other`. Warnings and `other` are attached to the successful turn
 * result under `result.violations`; the turn does not carry out those
 * actions. Evaluation errors (a check that could not run) are collected
 * in `errors`; those of a `halt` guardrail are also in `blockingErrors`,
 * which fail the turn as a violation would (a guardrail that can't check
 * fails closed). `guardrails` is the list the outcomes came from, one
 * outcome per guardrail in order (`evaluateGate`), which says each error's
 * action; without it, an error's guardrail is looked up by id.
 *
 * `checks` is what each guardrail's check came to, in order, for the
 * outcome ledger (`GuardrailOutcomeSink`): `blocked` (in `blocking`),
 * `violated` (in `warnings` or `other`), `errored` (in `errors`), or
 * `passed`. A guardrail whose scope didn't match wasn't checked and has no
 * entry.
 */
export function categorizeOutcomes(
  outcomes: readonly EvaluationOutcome[],
  guardrails: readonly Guardrail[] = [],
): {
  readonly blocking: readonly EvaluationResult[];
  readonly warnings: readonly EvaluationResult[];
  readonly other: readonly EvaluationResult[];
  readonly errors: readonly GuardrailEvaluationError[];
  readonly blockingErrors: readonly GuardrailEvaluationError[];
  readonly checks: readonly GuardrailCheckOutcome[];
} {
  const blocking: EvaluationResult[] = [];
  const warnings: EvaluationResult[] = [];
  const other: EvaluationResult[] = [];
  const errors: GuardrailEvaluationError[] = [];
  const blockingErrors: GuardrailEvaluationError[] = [];
  const checks: GuardrailCheckOutcome[] = [];
  const byId = new Map(guardrails.map((g) => [g.id as string, g]));
  const inOrder = guardrails.length === outcomes.length;
  outcomes.forEach((outcome, i) => {
    if (outcome.kind === 'err') {
      const named =
        'guardrailId' in outcome.error && typeof outcome.error.guardrailId === 'string'
          ? outcome.error.guardrailId
          : undefined;
      const guardrail = inOrder ? guardrails[i] : named !== undefined ? byId.get(named) : undefined;
      const error: GuardrailEvaluationError = {
        guardrailId: guardrail?.id ?? named ?? '<unknown>',
        message: outcome.error.message,
        code: outcome.error.code,
        ...(guardrail !== undefined && {
          action: guardrail.action['on-violation'],
          severity: guardrail.severity ?? 'error',
        }),
      };
      errors.push(error);
      if (error.action === 'halt') blockingErrors.push(error);
      checks.push({
        guardrailId: error.guardrailId,
        outcome: 'errored',
        ...(error.action !== undefined && { action: error.action }),
        ...(error.severity !== undefined && { severity: error.severity }),
        errorCode: error.code,
      });
      return;
    }
    if (outcome.kind === 'skip') return;
    const evalResult = outcome.value;
    const guardrailId = evalResult.guardrailId as unknown as string;
    if (evalResult.result.passed) {
      // No action was taken (the engine's `noop`).
      checks.push({ guardrailId, outcome: 'passed', severity: evalResult.severity });
      return;
    }
    const check = { guardrailId, action: evalResult.action, severity: evalResult.severity };
    if (evalResult.action === 'halt') {
      blocking.push(evalResult);
      checks.push({ ...check, outcome: 'blocked' });
      return;
    }
    if (evalResult.action === 'log-only' || evalResult.action === 'noop') {
      warnings.push(evalResult);
    } else other.push(evalResult);
    checks.push({ ...check, outcome: 'violated' });
  });
  return { blocking, warnings, other, errors, blockingErrors, checks };
}

/**
 * Message for a turn stopped by blocking violations — names each
 * guardrail that fired, with its check's reason when it gave one:
 *
 *   Turn blocked by guardrail 'no-pii': Response contains an email address
 *   Turn blocked by 2 guardrails: 'no-pii' (Response contains …); 'max-length'
 */
export function describeBlockingViolations(
  blocking: readonly EvaluationResult[],
  blockingErrors: readonly GuardrailEvaluationError[] = [],
): string {
  const reasonOf = (v: EvaluationResult): string | undefined => {
    const reason = v.result.reason?.trim();
    return reason === undefined || reason === '' ? undefined : reason;
  };
  const couldNotRun = (e: GuardrailEvaluationError) =>
    `'${e.guardrailId}' couldn't run its check (${e.code}: ${e.message})`;
  const [only] = blocking;
  const [onlyError] = blockingErrors;
  if (blocking.length === 1 && only !== undefined && blockingErrors.length === 0) {
    const reason = reasonOf(only);
    return `Turn blocked by guardrail '${only.guardrailId}'${reason !== undefined ? `: ${reason}` : ''}`;
  }
  if (blocking.length === 0 && blockingErrors.length === 1 && onlyError !== undefined) {
    return `Turn blocked: guardrail ${couldNotRun(onlyError)}`;
  }
  const named = [
    ...blocking.map((v) => {
      const reason = reasonOf(v);
      return `'${v.guardrailId}'${reason !== undefined ? ` (${reason})` : ''}`;
    }),
    ...blockingErrors.map(couldNotRun),
  ];
  return `Turn blocked by ${named.length} guardrails: ${named.join('; ')}`;
}

/**
 * Result of a session-gate check performed BEFORE running a turn:
 * the HITL turn threshold (`conversationPolicy.hitl.afterTurns` or
 * `conversationPolicy.hitlAfterTurns`).
 */
export type SessionGateResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'hitl-required'; readonly reason: string; readonly threshold: number };

/**
 * Evaluate session-level gates against the conversation state before
 * running the next turn: the HITL threshold from
 * `conversationPolicy.hitl.afterTurns` or `conversationPolicy.hitlAfterTurns`.
 *
 * Overloaded call shapes:
 *   - `evaluateSessionGate(agent, turnCount)` — reads the agent's policy
 *     directly.
 *   - `evaluateSessionGate({ afterTurns? }, turnCount)` — reads a
 *     pre-resolved effective policy (the setup handler passes
 *     `resolveEffectiveHitlPolicy` output).
 */
export function evaluateSessionGate(
  input: Agent | { readonly afterTurns?: number },
  currentTurnCount: number,
): SessionGateResult {
  const asAgent = input as Agent;
  const asPolicy = input as { readonly afterTurns?: number };
  const threshold: number | undefined =
    'conversationPolicy' in asAgent
      ? (asAgent.conversationPolicy?.hitl?.afterTurns ?? asAgent.conversationPolicy?.hitlAfterTurns)
      : asPolicy.afterTurns;
  if (threshold !== undefined && currentTurnCount >= threshold) {
    return {
      kind: 'hitl-required',
      reason: `Conversation reached HITL threshold: ${currentTurnCount} turns >= ${threshold}`,
      threshold,
    };
  }
  return { kind: 'ok' };
}

/** Discriminated error emitted when blocking guardrails fail. */
export interface GuardrailViolationError {
  readonly code: 'guardrail-violation';
  readonly message: string;
  readonly violations: readonly EvaluationResult[];
  /**
   * Guardrails whose check couldn't even evaluate (missing check, bad config). A `halt`
   * guardrail's error blocks the turn on its own, so `violations` can be empty.
   */
  readonly evaluationErrors: readonly GuardrailEvaluationError[];
}

/**
 * Error shape for a turn blocked by the session HITL threshold.
 * `approvalId` is set when the caller supplied a `bindings.hitl` sink and
 * the enqueue succeeded — downstream code can poll or subscribe on that
 * id. The agent turn itself does not return this code: it parks on a
 * HITL waitpoint instead (`AgentTurnResult.status: 'suspended'`).
 */
export interface HitlRequiredError {
  readonly code: 'hitl-required';
  readonly message: string;
  readonly threshold: number;
  readonly approvalId?: string;
}

/** Emitted when the agent references guardrail IDs not in the registry. */
export interface UnresolvedGuardrailError {
  readonly code: 'unresolved-guardrail';
  readonly message: string;
  readonly guardrailIds: readonly string[];
}

// Silence unused-type lint (GuardrailId is used by callers via type inference).
void 0 as unknown as GuardrailId;

// Discriminated Result helper to keep call sites tidy.
export type GateResult<T, E> = Result<T, E>;

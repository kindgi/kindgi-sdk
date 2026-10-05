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
  type ModelCallRecord,
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
  if (guardrails.length === 0 || bindings.checks === undefined) return [];
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
 * Sort evaluation outcomes by the failed guardrail's action. `halt` is
 * blocking — the turn fails with `guardrail-violation`. `log-only` and
 * `noop` are warnings; every other action (`retry`, `escalate`,
 * `compensate`, or a custom action — actions are open strings) lands in
 * `other`. Warnings and `other` are attached to the successful turn
 * result under `result.violations`; the turn does not carry out those
 * actions. Evaluation errors (a check that could not run) are collected
 * in `errors`.
 */
export function categorizeOutcomes(outcomes: readonly EvaluationOutcome[]): {
  readonly blocking: readonly EvaluationResult[];
  readonly warnings: readonly EvaluationResult[];
  readonly other: readonly EvaluationResult[];
  readonly errors: readonly { readonly guardrailId: string; readonly message: string }[];
} {
  const blocking: EvaluationResult[] = [];
  const warnings: EvaluationResult[] = [];
  const other: EvaluationResult[] = [];
  const errors: { guardrailId: string; message: string }[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'err') {
      errors.push({
        guardrailId:
          'guardrailId' in outcome.error && typeof outcome.error.guardrailId === 'string'
            ? outcome.error.guardrailId
            : '<unknown>',
        message: outcome.error.message,
      });
      continue;
    }
    if (outcome.kind === 'skip') continue;
    const evalResult = outcome.value;
    if (evalResult.result.passed) continue;
    if (evalResult.action === 'halt') blocking.push(evalResult);
    else if (evalResult.action === 'log-only' || evalResult.action === 'noop') {
      warnings.push(evalResult);
    } else other.push(evalResult);
  }
  return { blocking, warnings, other, errors };
}

/**
 * Message for a turn stopped by blocking violations — names each
 * guardrail that fired, with its check's reason when it gave one:
 *
 *   Turn blocked by guardrail 'no-pii': Response contains an email address
 *   Turn blocked by 2 guardrails: 'no-pii' (Response contains …); 'max-length'
 */
export function describeBlockingViolations(blocking: readonly EvaluationResult[]): string {
  const reasonOf = (v: EvaluationResult): string | undefined => {
    const reason = v.result.reason?.trim();
    return reason === undefined || reason === '' ? undefined : reason;
  };
  const [only] = blocking;
  if (blocking.length === 1 && only !== undefined) {
    const reason = reasonOf(only);
    return `Turn blocked by guardrail '${only.guardrailId}'${reason !== undefined ? `: ${reason}` : ''}`;
  }
  const named = blocking.map((v) => {
    const reason = reasonOf(v);
    return `'${v.guardrailId}'${reason !== undefined ? ` (${reason})` : ''}`;
  });
  return `Turn blocked by ${blocking.length} guardrails: ${named.join('; ')}`;
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
  /** Errors from checks that couldn't even evaluate (missing check, bad config). */
  readonly evaluationErrors: readonly { readonly guardrailId: string; readonly message: string }[];
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

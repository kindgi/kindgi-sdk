// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EvaluationResult } from '@kindgi/guardrails';
import type { Semver } from '@kindgi/types';

import type { AgentId, ConversationId, ConversationMessage, RetrievedFact } from './types.js';

/**
 * Discriminated union of every event a turn emits during execution.
 * Callers wire `bindings.onEvent` to their transport (SSE, WebSocket,
 * background job queue, or nothing at all).
 *
 * Order is deterministic per turn: `turn.started` first, `turn.completed`
 * or `turn.failed` last. Intermediate events fire in the order the
 * corresponding action happens.
 */
export type TurnEvent =
  | TurnStartedEvent
  | RetrievalCompletedEvent
  | ModelCallStartedEvent
  | ModelCallCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | AgentMessageEvent
  | GuardrailViolatedEvent
  | TurnCompletedEvent
  | TurnFailedEvent;

export interface TurnStartedEvent {
  readonly kind: 'turn.started';
  readonly conversationId: ConversationId;
  readonly turnNumber: number;
  readonly agentId: AgentId;
  readonly agentVersion: Semver;
  readonly userMessage: string;
}

export interface RetrievalCompletedEvent {
  readonly kind: 'retrieval.completed';
  readonly count: number;
  /** Fact ids retrieved this turn. Empty when no intents declared. */
  readonly factIds: readonly string[];
}

export interface ModelCallStartedEvent {
  readonly kind: 'model.call.started';
  readonly step: number;
  readonly providerId: string;
  readonly model: string;
}

export interface ModelCallCompletedEvent {
  readonly kind: 'model.call.completed';
  readonly step: number;
  readonly finishReason: 'stop' | 'length' | 'tool-use' | 'content-filter' | 'error';
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
}

export interface ToolStartedEvent {
  readonly kind: 'tool.started';
  readonly step: number;
  readonly toolId: string;
  /**
   * The exact version dispatched (picked at run start by `resolve(id,
   * range)` on the tenant's tool registry) so subscribers can
   * distinguish `kb-search@1.2.3` from `kb-search@2.0.0`.
   */
  readonly toolVersion: string;
  /** The semver range the agent binding declared for this tool. */
  readonly toolVersionRange: string;
  readonly invocationId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ToolCompletedEvent {
  readonly kind: 'tool.completed';
  readonly step: number;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly toolVersionRange: string;
  readonly invocationId: string;
  readonly output: unknown;
  readonly durationMs: number;
  /**
   * In a replay turn: whether the tool ran (`live`), the past run's result
   * was used (`recorded`), or the call was refused (`refused`).
   */
  readonly replay?: 'live' | 'recorded' | 'refused';
}

export interface ToolFailedEvent {
  readonly kind: 'tool.failed';
  readonly step: number;
  readonly toolId: string;
  readonly invocationId: string;
  readonly error: { readonly code: string; readonly message: string };
}

export interface AgentMessageEvent {
  readonly kind: 'agent.message';
  readonly step: number;
  /** True when this is the final message that closes the turn. */
  readonly isFinal: boolean;
  readonly message: ConversationMessage;
}

export interface GuardrailViolatedEvent {
  readonly kind: 'guardrail.violated';
  readonly action: EvaluationResult['action'];
  readonly severity: EvaluationResult['severity'];
  readonly guardrailId: string;
  readonly reason?: string;
}

export interface TurnCompletedEvent {
  readonly kind: 'turn.completed';
  readonly conversationId: ConversationId;
  readonly turnNumber: number;
  readonly response: ConversationMessage;
  readonly retrieved: readonly RetrievedFact[];
  readonly durationMs: number;
  readonly totalCostUsd: number;
}

export interface TurnFailedEvent {
  readonly kind: 'turn.failed';
  readonly conversationId: ConversationId;
  readonly errorCode: string;
  readonly message: string;
}

/**
 * Adapter shape callers plug into `bindings.onEvent`. Sync + async both
 * supported. Errors thrown inside the handler are caught by the runtime
 * — a broken telemetry sink never breaks the turn.
 */
export type OnTurnEvent = (event: TurnEvent) => void | Promise<void>;

/**
 * Safe emit wrapper. Called by the turn's handlers at each observation
 * point; catches handler throws so a broken sink can't break the run.
 */
export async function emitTurnEvent(
  onEvent: OnTurnEvent | undefined,
  event: TurnEvent,
): Promise<void> {
  if (onEvent === undefined) return;
  try {
    await onEvent(event);
  } catch {
    // Intentionally swallow — telemetry sinks must not affect run outcome.
  }
}

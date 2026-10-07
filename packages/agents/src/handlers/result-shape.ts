// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EvaluationResult } from '@kindgi/guardrails';
import type { Provenance } from '@kindgi/provenance';
import type { RunId } from '@kindgi/types';

import type { ConversationId, ConversationMessage, RetrievedFact } from '../types.js';

import type { ReplayTurnReport } from './replay.js';

/**
 * Public shape returned by `invokeAgent` on success. Extracted from
 * `invoke.ts` into this module so handler code can import the type
 * without pulling in the orchestration entrypoint (avoids circular
 * deps).
 */
export interface AgentTurnUsage {
  readonly steps: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalCostUsd: number;
  readonly durationMs: number;
}

/**
 * Something about a completed turn its caller should know.
 * `fallback-provider`: the turn ran on a fallback provider
 * (`ProviderMetadata.fallback`, e.g. `dev-echo`) because no other
 * registered provider satisfies the agent's capability.
 */
export interface AgentTurnWarning {
  readonly code: 'fallback-provider';
  readonly message: string;
}

export interface AgentTurnResult {
  /** The kernel run of this turn. */
  readonly runId: RunId;
  readonly conversationId: ConversationId;
  readonly turnNumber: number;
  readonly appended: readonly ConversationMessage[];
  readonly response: ConversationMessage;
  readonly retrieved: readonly RetrievedFact[];
  readonly violations: readonly EvaluationResult[];
  readonly usage: AgentTurnUsage;
  readonly provider: { readonly id: string; readonly model: string };
  /** Present when there is something to warn about (see `AgentTurnWarning`). */
  readonly warnings?: readonly AgentTurnWarning[];
  /**
   * The parsed, schema-valid answer, when the agent declares `output`.
   * `null` on a dry run (the model call is skipped, so there is no
   * answer to validate).
   */
  readonly output?: unknown;
  readonly provenance?: Provenance;
  /**
   * `true` when the turn was executed with `InvokeAgentInput.dryRun: true`.
   * On dry runs: `appended` messages are synthetic (never persisted);
   * no provenance is emitted; retrievals still ran for real (reads are
   * side-effect-free); the model call was skipped and returned a fixed
   * mock. Consumers filter by this to distinguish plan previews from
   * executed turns.
   */
  readonly dryRun?: boolean;
  /**
   * Terminal state of the run backing this turn (park-and-resume).
   * Absent = 'completed'. `'suspended'` = the run parked on a HITL waitpoint;
   * `response`/`appended`/`usage` are empty placeholders until the
   * waitpoint resolves and the run resumes to completion. Callers that
   * render the final response should branch on this before reading
   * `response.content`.
   */
  readonly status?: 'completed' | 'suspended';
  /**
   * A replay turn's report (`InvokeAgentInput.replay`): each tool call and
   * whether it ran, used the past run's result, or was refused (what the
   * turn would have done), and how the session approval gate went.
   */
  readonly replay?: ReplayTurnReport;
}

/**
 * What an agent step in a flow outputs — the authoring contract for the
 * nodes after it. They read the typed answer as
 * `nodeOutputs.<step>.output.<field>` and the answer's text as
 * `nodeOutputs.<step>.text`.
 */
export interface AgentStepOutput {
  /** The parsed answer, when the agent declares `output`. */
  readonly output?: unknown;
  /** The final answer's text. */
  readonly text: string;
  /** The step's agent turn — a child run of the flow run. */
  readonly runId: RunId;
  readonly conversationId: ConversationId;
  readonly usage: AgentTurnUsage;
  /** Non-blocking guardrail findings on the answer. */
  readonly violations: readonly {
    readonly guardrailId: string;
    readonly severity: string;
    readonly action: string;
  }[];
}

/** An agent step's output, from its turn's result. */
export function agentStepOutput(result: AgentTurnResult): AgentStepOutput {
  const content = result.response.content;
  return {
    ...(result.output !== undefined && { output: result.output }),
    text: typeof content === 'string' ? content : JSON.stringify(content),
    runId: result.runId,
    conversationId: result.conversationId,
    usage: result.usage,
    violations: result.violations.map((v) => ({
      guardrailId: v.guardrailId as unknown as string,
      severity: v.severity,
      action: v.action,
    })),
  };
}

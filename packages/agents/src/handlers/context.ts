// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ModelInfo,
  ModelMessage,
  ModelProvider,
  ModelToolDefinition,
  TenantPolicy,
} from '@kindgi/capabilities';
import type { Guardrail } from '@kindgi/guardrails';
import type { ProvenanceBuilder } from '@kindgi/provenance';
import type { Tool } from '@kindgi/tools';

import type { EvaluationResult } from '@kindgi/guardrails';

import type { EffectiveHitlPolicy } from '../hitl-policy.js';
import type { ProvenanceBindings } from '../provenance-emit.js';
import type {
  Agent,
  Conversation,
  ConversationMessage,
  RecalledMemory,
  RetrievedFact,
} from '../types.js';

import type { HitlBindings, InvokeAgentBindings, InvokeAgentInput } from './public-types.js';
import type { TurnBlocks } from './resolve-blocks.js';
import type { ToolErrorPolicy } from './tool-errors.js';

/**
 * Per-invocation closure state shared across every node handler. This is
 * a mutable container populated by earlier nodes and read by later
 * nodes. Kernel journal entries record the coarse node-level inputs and
 * outputs; this object carries the finer-grained runtime state that is
 * either not JSON-serializable (functions, ModelProvider instances,
 * ProvenanceBuilder) or expensive to reserialize per node.
 *
 * One `TurnContext` lives for the duration of one `invokeAgent` call.
 */
export interface TurnContext {
  readonly input: InvokeAgentInput;
  readonly bindings: InvokeAgentBindings;
  /**
   * Composed abort signal: fires when the wall-clock timer expires OR
   * when the caller-provided abortSignal fires. Handlers pass this into
   * long-running I/O.
   */
  readonly turnAbort: AbortController;
  /**
   * Millisecond timestamp when `invokeAgent` was called. Used to
   * compute `usage.durationMs` inside `compose-result`.
   */
  readonly startedAt: number;
  /**
   * Populated by `setup` — the loaded conversation row.
   */
  conversation?: Conversation;
  /**
   * Populated by `setup` — resolved tools (per-name map + model
   * definitions).
   */
  /** The data blocks the turn runs with (set by setup; none when the agent references none). */
  blocks?: TurnBlocks;
  tools?: {
    readonly definitions: readonly ModelToolDefinition[];
    /**
     * Per-tool resolved binding: the exact `Tool` instance the runtime
     * dispatches, the `resolvedVersion` picked by `resolve` on the
     * tenant's registry (`toolRegistry.forTenant`)
     * (captured for provenance + telemetry so a replay can pin against
     * the same version), and the `requestedRange` the agent binding
     * declared.
     */
    readonly byName: ReadonlyMap<
      string,
      {
        readonly tool: Tool;
        readonly resolvedVersion: string;
        readonly requestedRange: string;
      }
    >;
  };
  /**
   * Populated by `setup` — the provider the router picked for the
   * agent's first capability.
   */
  provider?: ModelProvider;
  /**
   * Populated by `setup` alongside `provider` — the specific
   * `ModelInfo` within that provider the router picked. Threaded into
   * `ModelCallInput.model` on every invocation this turn.
   */
  model?: ModelInfo;
  /**
   * Populated by `setup` — resolved guardrails for the final-response gate.
   */
  guardrails?: readonly Guardrail[];
  /**
   * Populated by `persist-user-message` — the persisted user message row.
   */
  userMessage?: ConversationMessage;
  /**
   * Populated by `render-prompt` — the rendered system-instructions
   * string that seeds the first model call.
   */
  renderedPrompt?: string;
  /**
   * Populated by `run-retrievals` — facts pulled by declared intents.
   */
  retrieved?: readonly RetrievedFact[];
  /**
   * Populated by `run-retrievals` — messages of earlier conversations
   * recalled by intents over conversations.
   */
  recalled?: readonly RecalledMemory[];
  /**
   * Populated by `persist-final-message` — the terminal assistant
   * message. `compose-result` reads it back for the returned
   * `AgentTurnResult.response`.
   */
  finalMessage?: ConversationMessage;
  /**
   * Populated by `dispatch-tools` and `persist-final-message` — the
   * ordered list of every message appended during this turn. Starts
   * with the user message; then intermediate assistant + tool
   * messages; then the final assistant message.
   */
  appended: ConversationMessage[];
  /**
   * Cumulative usage across all model calls this turn. Updated by
   * `model-call`; read by `budget-check` and `compose-result`.
   */
  usage: {
    steps: number;
    promptTokens: number;
    completionTokens: number;
    totalCostUsd: number;
  };
  /**
   * Provider + model of the most recent model call (the one that
   * produced the final response). Set by `model-call`; `compose-result`
   * surfaces it as `AgentTurnResult.provider`.
   */
  lastProvider?: { readonly id: string; readonly model: string };
  /**
   * Provenance builder — undefined when the caller didn't wire one.
   */
  provenance?: ProvenanceBuilder;
  /**
   * Provenance bindings kept for reference (needed by
   * `persist-provenance` for `emit` + `keyProvider` details).
   */
  provenanceBindings?: ProvenanceBindings;
  /**
   * The persisted provenance snapshot (post `persist-provenance`).
   * Present only when the builder was wired AND persistence succeeded.
   */
  persistedProvenance?: import('@kindgi/provenance').Provenance;
  /**
   * This turn's tool results so far, by invocation id: a model call read
   * them all (they're in its input), so its provenance node is
   * `influenced-by` each. Filled by `dispatch-tools`, and by the rebuild
   * of a resumed turn.
   */
  toolResultIds?: string[];
  /**
   * The tool-call approvals this turn's journal shows decided, by
   * invocation id: each call's provenance shows the approval it waited on.
   * Populated by `rehydrateTurnContext` (a decision only reaches a turn
   * that parked, and resumes).
   */
  toolApprovals?: ReadonlyMap<string, import('./turn-provenance.js').ToolApproval>;
  /**
   * The tenant policy this turn's model was routed under (bound policy
   * merged with the policy registry's). Populated by `setup`; guardrail
   * judges route under it too.
   */
  tenantPolicy?: TenantPolicy;
  /**
   * How this turn retries failed tool calls: the agent's `toolErrors`
   * (or the default) capped by the tenant's `tool-errors` policy.
   * Populated by `setup`.
   */
  toolErrorPolicy?: ToolErrorPolicy;
  /**
   * The turn's approval (HITL) rules: the agent's, held to the tenant's
   * `hitl` policy. Populated at the start of the turn (`setup`, or the
   * rebuild of a resumed turn) by `resolveTurnHitlPolicy`.
   */
  hitlPolicy?: EffectiveHitlPolicy;
  /**
   * Set when the turn resumes after a park in `dispatch-tools` (a
   * tool-call approval): the messages that step stored before it parked.
   * The step runs again, and takes its assistant message and the results
   * of calls that already ran from here instead of storing (and running)
   * them again. Populated by `rehydrateTurnContext`.
   */
  storedBeforePark?: ConversationMessage[];
  /**
   * Warnings + other (non-halt) guardrail violations from the
   * final-response gate. Read by `compose-result` to populate
   * `AgentTurnResult.violations`.
   */
  nonBlockingViolations?: readonly EvaluationResult[];
  /**
   * A replay turn's tool calls so far, and what happened to each
   * (`decideReplayTool`). Rebuilt from the journal on resume.
   */
  replayTrace?: import('./replay.js').ReplayToolTrace[];
  /** A replay turn's session approval, when it reached the gate (`replaySessionApproval`). */
  replayApproval?: 'followed' | 'skipped';
  /**
   * Reason recorded when `turnAbort` fires. Used to distinguish
   * external cancellation from wall-clock timeout in the projected
   * error.
   */
  abortReason: 'external' | 'timeout' | undefined;
}

/**
 * Iteration output shape produced by the loop body's `budget-check`
 * node (and by extension, the loop's `$loop-end` output). Mirrors the
 * `iterationOutputSchema` declared in `agent-turn-flow.ts`.
 */
export interface AgentTurnIterationOutput {
  readonly finishReason: 'stop' | 'length' | 'tool-use' | 'content-filter' | 'error';
  readonly message: ModelMessage;
  readonly iterationAppended: readonly ConversationMessage[];
  readonly iterationUsage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly costUsd: number;
  };
  readonly provider: { readonly id: string; readonly model: string };
  readonly finishedTurn: boolean;
  readonly nextMessages: readonly ModelMessage[];
  /**
   * Set by `dispatch-tools` when a tool invocation surfaces an
   * `unresolved-tool` / `tool-invocation-failed`, or by
   * `budget-check` when the cost cap is exceeded. `compose-result`
   * inspects it and short-circuits the run into an error result.
   */
  readonly errorPayload?: {
    readonly code:
      | 'unresolved-tool'
      | 'tool-invocation-failed'
      | 'budget-exceeded'
      | 'agent-turn-aborted'
      | 'model-invocation-failed';
    readonly message: string;
    readonly extra?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Public re-export helper for callers building test doubles. Kept in
 * this module to avoid making `context.ts` a circular hub — everything
 * a handler needs is imported through here.
 */
export type { Agent, HitlBindings, InvokeAgentBindings, InvokeAgentInput, TenantPolicy };

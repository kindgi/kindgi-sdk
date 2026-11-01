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
   * Populated by `setup`, and on a resume by `rehydrate` from the set
   * `setup` journaled: the turn's guardrails, at every point
   * (`Guardrail.at`).
   */
  guardrails?: readonly Guardrail[];
  /**
   * The turn's guardrails that run where their check, as the turn
   * resolved it, doesn't, by id, with the problem
   * (`guardrailPointFaults`). Checked whenever the turn resolves its
   * checks: at setup and on each resume. Such a guardrail fails as a check
   * that couldn't run, uncalled.
   */
  guardrailPointFaults?: ReadonlyMap<string, string>;
  /**
   * The calls the turn ran, by `<reply sequence>:<call id>`
   * (`ranCallKey`), for the trace's `toolCalls` at the loop's points. Kept
   * only when the turn has a guardrail in the loop; restored on a resume
   * from the completed `dispatch-tools` steps and the parked step's records.
   */
  ranCalls?: Set<string>;
  /**
   * The flow whose step started the turn, once read (`flowOfTurn`): a
   * turn's flow doesn't change, so a gate at each call doesn't read it again.
   */
  turnFlow?: { readonly flowId: import('@kindgi/types').FlowId | undefined };
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
   * How many messages the agent loop starts with: the system message, the
   * history, the memory and the person's message. Set by
   * `build-initial-messages`, and by the rebuild of a resumed turn from
   * that step's journaled output. What a step of the loop adds (answers,
   * tool results, repair and retry notes) comes after them.
   */
  initialMessageCount?: number;
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
   * The providers' warnings about the turn's answers, by code (the first
   * message of each): set by `model-call`, surfaced in
   * `AgentTurnResult.warnings`.
   */
  modelWarnings?: Map<string, string>;
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
   * The failures the loop's points only recorded (`log-only`, and any
   * action other than `halt` and `retry`, even on a dry run), by
   * step and guardrail, in the order they ran: `evaluate-guardrails` puts
   * them first in `nonBlockingViolations`. Keyed, so a step run again
   * after a park adds none twice; restored on a resume from the completed
   * `dispatch-tools` steps' `guardrailViolations`.
   */
  pointViolations?: Map<string, EvaluationResult>;
  /**
   * The answer `budget-check` judged and let finish the turn, when the
   * turn has a `retry` guardrail: its loop iteration and its message. Its
   * `halt` and `retry` guardrails passed it there, so `evaluate-guardrails`
   * judges only the others, and only when the loop's final output is this
   * answer. In memory only: a turn resumed in another process has none,
   * and `evaluate-guardrails` judges every guardrail, as without a `retry`
   * one. `errors` are the checks there that couldn't run on it (a `retry`
   * guardrail's: a `halt` one's would have failed the turn), which
   * `evaluate-guardrails` shows in its provenance and its output, as for
   * the checks it runs.
   */
  answerJudgedInLoop?:
    | {
        readonly iteration: number;
        readonly message: string;
        readonly errors: readonly import('../guardrails-gate.js').GuardrailEvaluationError[];
      }
    | undefined;
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
 * One iteration's output, as the loop body's steps pass it on.
 * `model-call` and `dispatch-tools` give parts of it, and `budget-check`
 * returns it whole as the loop's `$loop-end` output, which
 * `iterationOutputSchema` in `agent-turn-flow.ts` validates. `warnings`
 * rides only `model-call`'s part: the schema has no such field, so
 * `budget-check` leaves it off.
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
  /** The provider's warnings about this answer (`ModelCallResult.warnings`). */
  readonly warnings?: readonly { readonly code: string; readonly message: string }[];
  readonly finishedTurn: boolean;
  readonly nextMessages: readonly ModelMessage[];
}

/**
 * Public re-export helper for callers building test doubles. Kept in
 * this module to avoid making `context.ts` a circular hub — everything
 * a handler needs is imported through here.
 */
export type { Agent, HitlBindings, InvokeAgentBindings, InvokeAgentInput, TenantPolicy };

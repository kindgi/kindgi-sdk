// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Principal } from '@kindgi/authz';
import type { ProviderRegistry, TenantPolicy, UsageSink } from '@kindgi/capabilities';
import type { EmbeddingProviderRegistry } from '@kindgi/embedding';
import type { MemoryQueryBinding } from '@kindgi/memory';
import type { PolicyRegistry } from '@kindgi/policy-contract';
import type {
  ParentRunRef,
  RunBinding,
  RunIdempotencyKey,
  RunReplayRef,
  RunTriggerRef,
} from '@kindgi/runtime';
import type { ToolRegistry, ToolSecretRef } from '@kindgi/tools';
import type {
  AgentVersionVia,
  LiveScope,
  OrgId,
  ProjectId,
  ProvenanceId,
  RunId,
  ScopeSegment,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import type { BlockReader } from '../blocks.js';
import type { ConversationBinding } from '../conversation-binding.js';
import type { GuardrailsBindings } from '../guardrails-gate.js';
import type { ProvenanceBindings } from '../provenance-emit.js';
import type { RunSnapshotBinding } from '../run-snapshot-binding.js';
import type { OnTurnEvent } from '../streaming.js';
import type { Agent, ConversationId } from '../types.js';

import type { ReplayBinding } from './replay.js';

/**
 * The user-facing input to `invokeAgent`. Split out from `invoke.ts` so
 * the handler modules can depend on the shape without pulling in the
 * orchestration entrypoint (would cause a circular import).
 */
export interface InvokeAgentInput {
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor. REQUIRED — every
   * agent turn is a run bound to exactly one project inside the
   * tenant. Callers without a natural project id resolve to the tenant's
   * Default via `projectBinding.getDefault(tenantId)` (`@kindgi/api`)
   * at the caller layer.
   */
  readonly projectId: ProjectId;
  /**
   * The project's org, when it belongs to one: the runtime resolves it
   * from the project, never from input. The turn's tools get it as
   * `ToolContext.orgId`, its guardrails as `trace.orgId`.
   */
  readonly orgId?: OrgId;
  readonly agent: Agent;
  readonly conversationId: ConversationId;
  /** Why the caller chose this agent version; recorded on the run (`RunAgentRef.via`). */
  readonly versionVia?: AgentVersionVia;
  /** The live pin that chose it, when `versionVia` is `live`. */
  readonly liveScope?: LiveScope;
  /** The segment path the turn runs for; recorded on its run (`KernelRunRecord.segments`). */
  readonly segments?: readonly ScopeSegment[];
  readonly userMessage: string;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Structured input for this turn — what a flow step hands its agent.
   * Available to the instructions as `{{ input.* }}`, kept in the run
   * snapshot for resume, and passed to guardrails as
   * `trace.attributes.stepInput`.
   */
  readonly input?: unknown;
  /**
   * The flow run and node that started this turn, when it is a flow
   * step. Recorded on the turn's run, so the flow can find its child.
   */
  readonly parent?: ParentRunRef;
  /**
   * Marks the turn as a replay: an eval run re-running a past run (`of`)
   * on this agent version. Recorded on the turn's run and in its snapshot.
   * Its tool calls are decided by `InvokeAgentBindings.replay` (every call
   * is refused when that isn't wired), and only a read-only tool can run.
   */
  readonly replay?: RunReplayRef;
  /** Start the turn's run at most once per key (`RunIdempotencyKey`). */
  readonly idempotencyKey?: RunIdempotencyKey;
  /** Set when a trigger starts the turn; its run records it (`RunTriggerRef`). */
  readonly trigger?: RunTriggerRef;
  readonly participantId?: string;
  readonly abortSignal?: AbortSignal;
  /**
   * When `true`, executes the turn as a plan preview: no side effects
   * to the conversation, memory, or provenance. Retrievals + guardrails
   * still run for real (pure reads); the model call is skipped and
   * returns a fixed mock response with no tool calls, so no tools run;
   * every `persist-*` node skips its write. The returned
   * `AgentTurnResult` carries `dryRun: true`, and the underlying run is
   * journaled as a dry run.
   */
  readonly dryRun?: boolean;
  /**
   * Authorization — the Principal on whose authority this agent turn
   * runs. When set together with `authz`, the underlying run checks
   * every tool invocation (and subgraph dispatch, if any) against this
   * principal at its enforcement point.
   *
   * Typical caller construction:
   *   principal = delegate(
   *     { kind: 'agent', id: input.agent.id, tenantId },
   *     userPrincipalFromSession
   *   )
   * — establishes the confused-deputy-safe intersection semantic.
   *
   * Absent = tool invocations are not authorization-checked.
   */
  readonly principal?: Principal;
  readonly authz?: {
    readonly fgaApiUrl: string;
  };
}

export interface InvokeAgentBindings extends GuardrailsBindings {
  /**
   * Model providers. Setup hydrates the tenant's providers (when the
   * registry supports it) and routes the agent's first capability over
   * `list(tenantId)` under the merged tenant policy; llm-judge
   * guardrails route through it too.
   */
  readonly providerRegistry: ProviderRegistry;
  /**
   * Tools. Setup calls `forTenant(tenantId)` and resolves the agent's
   * tool refs on the returned tenant-bound registry, so a turn never
   * sees another tenant's tools.
   */
  readonly toolRegistry: ToolRegistry;
  /**
   * Data blocks (prompts and settings). Setup loads the blocks the agent
   * references at their pinned versions. Optional: an agent that
   * references blocks fails its turn (`block-unresolvable`) without it.
   */
  readonly blockReader?: BlockReader;
  /**
   * Caller-plugged data-access surface for memory reads.
   * The Kindgi runtime supplies a Postgres-backed implementation;
   * any object satisfying the interface works (tests, custom stores).
   * Retrieval (listFacts / searchByKeyword / searchBySemantic) inside
   * the agent runtime routes through this binding — the runtime never
   * touches a database client directly for memory operations.
   */
  readonly memoryBinding: MemoryQueryBinding;
  /**
   * Caller-plugged conversation store. Every open / get / list /
   * close / delete / appendMessage / readMessages inside the agent
   * runtime routes through this binding — the runtime never touches
   * a database client directly for conversation ops. The Kindgi runtime
   * supplies a Postgres-backed implementation; any conforming object
   * works. Required.
   */
  readonly conversationBinding: ConversationBinding;
  /**
   * Caller-plugged run-snapshot store. Writes the reconstruction
   * envelope on run-start (idempotent under replay); reads it
   * on `resumeAgentTurn` to rebuild the suspended TurnContext.
   * The Kindgi runtime supplies a
   * Postgres-backed implementation; any conforming object works. Required.
   */
  readonly runSnapshotBinding: RunSnapshotBinding;
  /**
   * Run-lifecycle binding (`RunBinding` from `@kindgi/runtime`). Every
   * agent turn spawns a `runGraph` (or `resumeRun`) through it. The
   * Kindgi runtime supplies an implementation; a bespoke one can be
   * plugged in.
   *
   * Optional in the type, but `invokeAgent` and `resumeAgentTurn`
   * throw when it is missing — every caller MUST supply it.
   */
  readonly runBinding?: RunBinding;
  /**
   * Statically-injected tenant policy for model routing. When a
   * `policyRegistry` also yields a policy, the two are MERGED so the
   * result is at least as strict as each: allow lists intersect, deny
   * lists union, cost/token caps take the smaller value.
   *
   * Absent-and-registry-absent = router runs without any tenant policy.
   */
  readonly tenantPolicy?: TenantPolicy;
  /**
   * Optional policy registry. When present, the agent setup step calls
   * `policyRegistry.evaluate('model-routing', {tenantId})` and merges
   * the result with `tenantPolicy` before routing. Without a registry
   * (or without an executor for that kind), `tenantPolicy` applies
   * alone.
   */
  readonly policyRegistry?: PolicyRegistry;
  readonly embeddingRegistry?: EmbeddingProviderRegistry;
  readonly embeddingModel?: string;
  readonly onEvent?: OnTurnEvent;
  readonly provenance?: ProvenanceBindings;
  readonly hitl?: HitlBindings;
  /**
   * Where the turn records each model call (the runtime's cost ledger):
   * its usage, provider, model, run, agent and step, before the step
   * that made it goes on. Absent: calls aren't recorded.
   */
  readonly usage?: UsageSink;
  /**
   * Declarative HTTP tools: optional secret resolver populated
   * from the deployment's tenant-scoped `SecretBinding`. When present,
   * `dispatch-tools` threads it into every `ToolContext` so
   * declarative HTTP tools (spec kind 'http') can resolve declared `secret_ref`s at
   * invoke time. Absent → HTTP tools that declare `authorization`
   * throw a clear "resolveSecret is not wired" error; native tools
   * unaffected.
   */
  readonly resolveSecret?: (ref: ToolSecretRef) => Promise<string>;
  /**
   * How replay turns (`InvokeAgentInput.replay`) decide their tool calls,
   * retrievals and session approval. Consulted only for a replay turn.
   */
  readonly replay?: ReplayBinding;
}

export interface HitlBindings {
  readonly enqueue: (input: HitlEnqueueInput) => Promise<HitlEnqueueResult>;
}

export interface HitlEnqueueInput {
  readonly tenantId: TenantId;
  /** The turn's project: approval lists filter by it. */
  readonly projectId?: ProjectId;
  readonly subjectKind: string;
  readonly subjectRef: Readonly<Record<string, unknown>>;
  readonly requiredRole?: 'standard' | 'senior' | 'admin';
  readonly title?: string;
  readonly description?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  /**
   * Waitpoint token this approval resolves on approve/reject
   * (park-and-resume). The session gate (setup handler) and the tool
   * gate (dispatch-tools handler) compute it as a deterministic hash —
   * of (runId, gate scope, turnCount) and of (runId, callId, argsHash)
   * respectively. Enqueue is idempotent on this — handler replay is
   * safe.
   */
  readonly waitTokenId?: string;
  /**
   * Provenance reference for the parent run. Required for the
   * approvals-complete route to invoke `completeToken(runId, ...)` +
   * `resumeRun(runId)` on decision. Absent = the approval decides in
   * place, no waitpoint resolution.
   */
  readonly provenanceRef?: {
    readonly runId: RunId;
    readonly provenanceId?: ProvenanceId;
  };
  /**
   * Absolute deadline surfaced to reviewers; an approval still pending
   * after it can be expired. Materialized at enqueue time from the
   * effective HITL policy's `timeoutMs`.
   */
  readonly expiresAt?: Timestamp;
}

export interface HitlEnqueueResult {
  readonly approvalId: string;
}

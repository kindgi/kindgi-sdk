// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Principal } from '@kindgi/authz';
import type { ProviderRegistry, TenantPolicy, UsageSink } from '@kindgi/capabilities';
import type { EmbeddingProviderRegistry } from '@kindgi/embedding';
import type { GuardrailOutcomeSink } from '@kindgi/guardrails';
import type { MemoryQueryBinding, MemoryRememberBinding } from '@kindgi/memory';
import type { PolicyRegistry } from '@kindgi/policy-contract';
import type {
  ParentRunRef,
  RunBinding,
  RunIdempotencyKey,
  RunMailbox,
  RunReplayRef,
  RunStartedBy,
  RunTriggerRef,
} from '@kindgi/runtime';
import type { ConnectionResolver, ToolRegistry, ToolSecretRef } from '@kindgi/tools';
import type {
  AgentVersionVia,
  EnvName,
  FileValue,
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
import type { TemplateRenderer } from '../template-renderer.js';
import type { Agent, ConversationId } from '../types.js';

import type { FileBinding } from './files.js';
import type { ReplayBinding } from './replay.js';
import type { TurnMemoryBinding } from './turn-memory.js';

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
  /**
   * Stored files the turn's message carries: the run input's `files`, which
   * the runtime admitted when the run started. The user message carries
   * them, and the conversation keeps them with it. The model is shown them
   * as the run's rule and the agent's `vision` need allow.
   */
  readonly files?: readonly FileValue[];
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
  /**
   * How the turn's run started (`RunStartedBy`); its run records it. Only
   * `person` counts as attended: in any other turn, or one without it, a
   * tool that declares `needsApprovalWhenUnattended` waits for a person's
   * yes whatever the agent's approval rules say, and a turn a webhook, an
   * event or a mail started reads its message as data (`<event>`).
   */
  readonly startedBy?: RunStartedBy;
  /**
   * The tools, by id, whose `needsApprovalWhenUnattended` doesn't hold in
   * this turn though no person started its run: the
   * `toolsAllowedUnattended` of the webhook, schedule or mail trigger that
   * started it, recorded with the run (`RunFlowInput.toolsAllowedUnattended`).
   * Only that wait is lifted: the tenant's floor and the agent's own rules
   * still apply. Set by the runtime from the run, never from a request.
   */
  readonly toolsAllowedUnattended?: readonly string[];
  /**
   * The mailbox the turn's mail came from, on a turn a mail trigger
   * started (`RunFlowInput.mailbox`): a call with a connection of its app
   * and kind waits for a person's yes, read-only or not, unless the
   * trigger lists the tool. Set by the runtime from the run, never from a
   * request.
   */
  readonly mailbox?: RunMailbox;
  /**
   * The turn's message is an event's, though no webhook or event starts
   * this run: a replay of a run one started sets it (its turn, or a flow's
   * agent step's), and records no start of its own. The turn reads its
   * message as data (`<event>`), as `startedBy` `webhook` or `event` makes
   * it, and keeps it marked (`ConversationMessage.fromEvent`). It changes
   * nothing else: the run stays as unattended as `startedBy` says. Set by
   * the runtime, never from a request.
   */
  readonly messageFromEvent?: true;
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
   * runs. From runtime 0.1.8, the Kindgi runtime checks each of the
   * turn's tool calls against it (`InvokeAgentBindings.authorizeToolCall`)
   * for every turn a person or a key starts.
   */
  readonly principal?: Principal;
  /**
   * Where authorization is decided: OpenFGA's URL, never a credential (it's
   * stored with the turn's snapshot). From runtime 0.1.8, the Kindgi
   * runtime sets it on every turn a person or a key starts.
   */
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
   * Where an agent that declares `memory.remember` stores what it
   * remembers (the `kindgi_remember` tool). Absent: the tool still
   * shows, and a call answers that this host can't remember.
   */
  readonly memoryWriter?: MemoryRememberBinding;
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
   * alone. The turn reads `hitl` and `tool-errors` through it too; an
   * evaluation of any of the three that throws fails the turn with
   * `tenant-policy-unavailable`.
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
   * What the turn holds in memory, charged by size before each model call
   * (a runtime's limit, per tenant and in all, as Kindgi Cloud sets). Bound per turn; the
   * runtime releases the charge when the turn settles. Refused, the turn
   * fails with `turn-memory-limit-reached`. Absent: nothing is charged.
   */
  readonly turnMemory?: TurnMemoryBinding;
  /**
   * The turn's stored files: the run's rule for which files its model may
   * be shown, and their bytes for each model call. Bound per turn. Absent:
   * no file is shown, and a tool result's file values stay plain JSON.
   */
  readonly files?: FileBinding;
  /**
   * Where the turn records what each guardrail's check came to (passed,
   * violated, blocked or errored), before it acts on them: a blocked turn
   * is recorded before it fails. Replays and dry runs aren't recorded.
   * Absent: outcomes aren't recorded.
   */
  readonly guardrailOutcomes?: GuardrailOutcomeSink;
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
   * Whether the turn's principal may call a tool, asked before each call,
   * before any approval. A denied call runs nothing and asks no reviewer:
   * its result tells the model it wasn't allowed (`{ status: 'denied',
   * reason }`), and the turn goes on. The model sees `reason`, so write it
   * as a plain sentence for whoever reads the conversation.
   *
   * - **An approved call is asked again** right before it runs: access can
   *   change while it waits. Denied then, it runs nothing, and the
   *   reviewer's decision stays as it was.
   * - **Each decision is recorded with the call,** so a resumed turn keeps
   *   it. A throw records nothing and fails the step: a call never runs
   *   without an answer.
   * - **A built-in tool** (`kindgi_<verb>`) is asked only when what it
   *   touches reaches beyond the turn's project: `kindgi_remember` for a
   *   tenant-scope fact.
   * - **`principal` is absent** for a turn that has none. The authorizer
   *   decides what that gets.
   * - **`toolVersion` is the version the call runs:** the one the turn
   *   resolved for the agent's range, or a built-in's own. The turn sets it
   *   on every check, so a rule can differ per version, as a flow's tool
   *   step is checked on the exact version it runs.
   *
   * The Kindgi runtime checks `invoke` on the tool for the turn's
   * principal. Absent: every call is allowed.
   */
  readonly authorizeToolCall?: (input: {
    readonly tenantId: TenantId;
    readonly projectId: ProjectId;
    readonly principal?: Principal;
    readonly toolId: string;
    /** The version the call runs. The turn sets it on every check. */
    readonly toolVersion?: string;
  }) => Promise<ToolCallAuthorization>;
  /**
   * Where a tool call gets the connections its tool declares
   * (`needsSpec.connections`), before it runs: the runtime's resolver, and
   * the env it serves.
   *
   * - **Once per call, recorded:** a person's connection that's missing,
   *   lacks a permission or needs reconnecting makes a connect request when
   *   a person started the run, and the call waits for them to connect
   *   (`waitingFor.connections`). Any other run can't wait: the call fails.
   * - **Every time the tool runs,** the tokens are asked for fresh and never
   *   recorded (`ToolContext.connections`). When the app refuses one
   *   (`ConnectionRejectedError`), it's renewed and the call runs once more.
   * - **A call it stops runs nothing:** its result tells the model why
   *   (`{ status: 'failed', error: { code, message } }`, a `connection-*`
   *   code), and the turn goes on.
   * - **Approvals:** a call that acts with a person's connection and asks
   *   for an approval asks that person alone (`HitlEnqueueInput.approver`).
   *
   * Absent: a call to a tool that declares a connection fails with
   * `connection-app-missing`; no other call changes.
   */
  readonly connections?: TurnConnections;
  /**
   * How replay turns (`InvokeAgentInput.replay`) decide their tool calls,
   * retrievals and session approval. Consulted only for a replay turn.
   */
  readonly replay?: ReplayBinding;
  /**
   * Where the turn renders its instructions, off the thread that runs it:
   * `createWorkerTemplateRenderer` (`@kindgi/agents/render-worker`)
   * renders in child processes, so a template can't hold up the server's
   * other work. Absent: the turn renders them in-process.
   */
  readonly templateRenderer?: TemplateRenderer;
}

/** `InvokeAgentBindings.connections`. */
export interface TurnConnections {
  /** The env the runtime serves: a call uses the connections made in it. */
  readonly envName: EnvName;
  readonly resolver: ConnectionResolver;
}

export interface HitlBindings {
  /**
   * Open the approval a gate asks for. A binding refuses one past the
   * tenant's limit on approvals waiting by throwing an error with
   * `code: 'approvals-pending-limit'` (and `approvalsPending`, the limit):
   * the step then fails with that code, naming the limit. It refuses one
   * whose `approver` has no reviewer seat at its `requiredRole` or above
   * by throwing an error with `code: 'approver-not-a-reviewer'` (and
   * `approverUserId`, `requiredRole`): the call then fails with
   * `connection-approver-not-a-reviewer`, and the turn goes on. Any other
   * throw is soft: the gate still waits.
   */
  readonly enqueue: (input: HitlEnqueueInput) => Promise<HitlEnqueueResult>;
}

export interface HitlEnqueueInput {
  readonly tenantId: TenantId;
  /** The turn's project: approval lists filter by it. */
  readonly projectId?: ProjectId;
  readonly subjectKind: string;
  readonly subjectRef: Readonly<Record<string, unknown>>;
  readonly requiredRole?: 'standard' | 'senior' | 'admin';
  /**
   * Who asked: the person the turn runs for (`user:<id>`,
   * `service_account:<id>` or `system:<id>`), the same when another
   * person's decision resumes it. Absent when the turn runs for no one.
   */
  readonly requestedBy?: string;
  /**
   * Four eyes: the person who asked (`requestedBy`) may not approve it.
   * From the agent's `conversationPolicy.hitl.separateApprover`; absent =
   * `false`.
   */
  readonly separateApprover?: boolean;
  /**
   * The one member who decides it: approves, rejects or withdraws it. It's
   * listed to them alone among the reviewers, and needs them to hold a
   * reviewer seat at `requiredRole` or above. The tool gate sets it when
   * the call acts with a person's connection: to that connection's owner.
   * Absent: the reviewers decide, as before.
   */
  readonly approver?: { readonly kind: 'member'; readonly userId: string };
  /**
   * The account the call acts as, shown to its reviewer: the app's id and
   * name, and the account as people know it (`owner@acme.example`). Set
   * with `approver`.
   */
  readonly connection?: {
    readonly app: string;
    readonly appName: string;
    readonly account: string;
  };
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

/** `InvokeAgentBindings.authorizeToolCall`'s answer. */
export type ToolCallAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

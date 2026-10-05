// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * SDK type surface.
 *
 * Every DTO is either:
 *   - re-exported from `@kindgi/types` (branded ids, shared
 *     pagination shapes), or
 *   - declared locally: wire shapes that mirror
 *     `@kindgi/api/openapi.json` (`@wire`), and SDK-defined shapes with
 *     no matching API schema (`@unwired`), used by methods that throw
 *     `not-yet-wired`.
 *
 * `Filter<TStatus>` and `Cursor` are the canonical pagination shapes.
 * Every list method uses them.
 */

// Re-exports from @kindgi/types — shared branded ids and pagination shapes.
import type { ApprovalId } from '@kindgi/types';
export type { Filter, Page } from '@kindgi/types';
export type {
  AgentId,
  ApprovalId,
  ArtifactId,
  AuditBundleId,
  Cursor,
  DatasetId,
  EventId,
  FactId,
  FixProposalId,
  FlowId,
  GuardrailId,
  ObservationId,
  OrgId,
  PackId,
  PolicyId,
  ProvenanceId,
  ReviewerId,
  RunId,
  SessionId,
  SubscriptionId,
  SupervisorId,
  TeamId,
  TenantId,
  Timestamp,
  ToolId,
  UserId,
} from '@kindgi/types';

// @unwired Branded ids defined by the SDK; they are not in @kindgi/types.
import type { Brand } from '@kindgi/types';

/** @unwired SDK-defined id for a schedule. */
export type ScheduleId = Brand<string, 'ScheduleId'>;

/** @unwired SDK-defined id for a model provider. */
export type ProviderId = Brand<string, 'ProviderId'>;

/** @unwired SDK-defined id for an API token. */
export type ApiTokenId = Brand<string, 'ApiTokenId'>;

/** An outbound webhook endpoint id (`client.webhookEndpoints`). */
export type WebhookEndpointId = Brand<string, 'WebhookEndpointId'>;

/** @unwired SDK-defined id for a pack installation. */
export type InstallationId = Brand<string, 'InstallationId'>;

/**
 * @unwired SDK-defined schedule shape, keyed by agent. The API's
 * schedule routes (`/v1/schedules`) take a cron trigger config instead
 * — see `client.schedules` and its `RegisterScheduleInput`.
 *
 * Cron is standard 5-field (`min hour dom mon dow`). Timezone is an
 * IANA name. `input` is passed to the agent on every fire.
 */
export interface ScheduleSpec {
  readonly agent: import('@kindgi/types').AgentId;
  readonly cron: string;
  readonly input: unknown;
  readonly timezone?: string;
  readonly label?: string;
}

export interface Schedule {
  readonly id: ScheduleId;
  readonly agent: import('@kindgi/types').AgentId;
  readonly cron: string;
  readonly timezone: string;
  readonly label?: string;
  readonly status: 'active' | 'paused';
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly nextFireAt?: import('@kindgi/types').Timestamp;
  readonly lastFireAt?: import('@kindgi/types').Timestamp;
  readonly lastRun?: import('@kindgi/types').RunId;
}

/**
 * @unwired Result shape of `client.runs.dryRun()`, which has no API
 * route: a preview of what a run would do — planned nodes, tool calls,
 * memory writes and retrievals, guardrail evaluations against the
 * projected state, and a cost estimate. A dry run on the API is
 * `runs.start({ ..., options: { dryRun: true } })`, which returns a
 * `Run` marked `dryRun: true`. Distinct from
 * `client.supervisor.proposals.dryRun`, which is proposal-scoped.
 */
export interface DryRunResult {
  readonly plannedNodes: readonly PlannedNode[];
  readonly plannedToolCalls: readonly PlannedToolCall[];
  readonly plannedMemoryWrites: readonly PlannedMemoryWrite[];
  readonly plannedRetrievals: readonly PlannedRetrieval[];
  readonly guardrailEvaluations: readonly GuardrailEvaluation[];
  readonly costEstimate: CostEstimate;
  readonly warnings: readonly DryRunWarning[];
}

export interface PlannedNode {
  readonly nodeId: string;
  readonly kind: 'tool' | 'model' | 'retrieval' | 'guardrail' | 'waitpoint';
  readonly wouldExecute: boolean;
  readonly reason?: string;
}

export interface PlannedToolCall {
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly sequence: number;
}

export interface PlannedMemoryWrite {
  readonly factType: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly contentPreview: string;
}

export interface PlannedRetrieval {
  readonly query: string;
  readonly k: number;
  readonly filters?: Readonly<Record<string, unknown>>;
}

export interface GuardrailEvaluation {
  readonly guardrailId: string;
  readonly outcome: 'pass' | 'fail' | 'skip';
  readonly reason?: string;
}

export interface CostEstimate {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly providers: readonly string[];
}

export interface DryRunWarning {
  readonly kind: 'unresolvable-tool' | 'unresolvable-retrieval' | 'guardrail-gate-failed' | 'other';
  readonly message: string;
  readonly nodeId?: string;
}

// ============================================================
// RunEvent — SSE stream shape for client.runs.stream(id).
// @wire `@kindgi/api/openapi.json#/components/schemas/RunEvent`.
// SSE frame mapper: `packages/api/src/routes/sse.ts` (journal entry →
//   wire `RunEvent`; drops journal-only kinds like `edge.evaluated` and
//   `value.recorded`).
// Schema source: `@kindgi/specs/run-event.schema.json`.
// ============================================================

import type { TurnEvent } from '@kindgi/agents';

/**
 * Wire kind enum for `RunEvent` — the closed set of frame types emitted
 * over `GET /v1/runs/{runId}/stream`. Dotted-kebab per the API
 * conventions (`run.step-completed`, not `step.completed`).
 *
 * @wire `@kindgi/api/openapi.json#/components/schemas/RunEvent#kind` (enum).
 *
 * The run journal carries additional kinds (`edge.evaluated`,
 * `value.recorded`) that the wire SSE mapper drops — those still appear on
 * `GET /v1/runs/{runId}/journal` for callers that want the full record.
 */
export type RunEventKind =
  | 'run.queued'
  | 'run.started'
  | 'run.step-started'
  | 'run.step-completed'
  | 'run.step-failed'
  | 'run.step-retry-scheduled'
  | 'run.iteration-started'
  | 'run.iteration-completed'
  | 'run.tool-invoked'
  | 'run.tool-result'
  | 'run.model-token'
  | 'run.artifact-produced'
  | 'run.guardrail-violated'
  | 'run.wait-suspended'
  | 'run.wait-resumed'
  | 'run.approval-requested'
  | 'run.approval-completed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

/**
 * SSE frame payload from `GET /v1/runs/{runId}/stream`. Flat shape:
 * every frame carries the same fields; `kind` is the discriminant and
 * `payload` is the kind-specific opaque JSON.
 *
 * @wire `@kindgi/api/openapi.json#/components/schemas/RunEvent` — the closed
 *   shape (`{ eventId, runId, tenantId, timestamp, kind, sequence,
 *   nodeId?, payload? }`).
 *
 * Consumers that need per-kind narrowing branch on `kind` and read
 * `payload`; the stream mirrors what the server emits.
 */
export interface RunEvent {
  /**
   * Monotonic event id within the run — echoed back to the server as
   * `Last-Event-Id: <eventId>` on reconnect for resume-from-sequence.
   * Format is `<runId>:<sequence>` (opaque to callers; SDK handles the
   * resume plumbing internally).
   */
  readonly eventId: string;
  readonly runId: import('@kindgi/types').RunId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly timestamp: import('@kindgi/types').Timestamp;
  readonly kind: RunEventKind;
  /** Monotonic within-run sequence. */
  readonly sequence?: number;
  /** For step-scoped events (`run.step-*`, `run.tool-invoked`, …). */
  readonly nodeId?: string;
  /** Kind-specific opaque JSON payload; shape mirrors `@kindgi/specs/run-event.schema.json` by kind. */
  readonly payload?: unknown;
}

// Per-variant event interfaces, kept as `@deprecated` exports. Every
// field matches the wire's flat shape (`kind` + `payload`), so moving to
// `RunEvent` is mechanical.
/** @deprecated Wire is flat — see `RunEvent` (dotted kind + opaque `payload`). */
export interface RunStartedEvent {
  readonly kind: 'run.started';
  readonly runId: import('@kindgi/types').RunId;
  readonly flowId: import('@kindgi/types').FlowId;
  readonly flowVersion: string;
  readonly startedAt: import('@kindgi/types').Timestamp;
}

/** @deprecated Wire is flat — see `RunEvent`. */
export interface StepStartedEvent {
  readonly kind: 'run.step-started';
  readonly runId: import('@kindgi/types').RunId;
  readonly nodeId: string;
  readonly sequence: number;
  readonly startedAt: import('@kindgi/types').Timestamp;
}

/** @deprecated Wire is flat — see `RunEvent`. */
export interface StepCompletedEvent {
  readonly kind: 'run.step-completed';
  readonly runId: import('@kindgi/types').RunId;
  readonly nodeId: string;
  readonly sequence: number;
  readonly output: unknown;
  readonly durationMs: number;
}

/** @deprecated Wire is flat — see `RunEvent`. */
export interface StepFailedEvent {
  readonly kind: 'run.step-failed';
  readonly runId: import('@kindgi/types').RunId;
  readonly nodeId: string;
  readonly sequence: number;
  readonly error: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
}

/** @deprecated Wire is flat — see `RunEvent`. */
export interface StepRetryScheduledEvent {
  readonly kind: 'run.step-retry-scheduled';
  readonly runId: import('@kindgi/types').RunId;
  readonly nodeId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly nextDelayMs: number;
  readonly previousError: string;
}

/**
 * @deprecated Wire SSE drops `edge.evaluated` — it's journal-only.
 *   Callers who need edge evaluation observations should read
 *   `GET /v1/runs/{runId}/journal` instead of the SSE stream.
 */
export interface EdgeEvaluatedEvent {
  readonly kind: 'edge.evaluated';
  readonly runId: import('@kindgi/types').RunId;
  readonly edgeId: string;
  readonly sequence: number;
  readonly passed: boolean;
}

/** @deprecated Wire is flat — see `RunEvent`. */
export interface RunCompletedEvent {
  readonly kind: 'run.completed';
  readonly runId: import('@kindgi/types').RunId;
  readonly output: unknown;
  readonly completedAt: import('@kindgi/types').Timestamp;
}

/** @deprecated Wire is flat — see `RunEvent`. */
export interface RunFailedEvent {
  readonly kind: 'run.failed';
  readonly runId: import('@kindgi/types').RunId;
  readonly error: Readonly<Record<string, unknown>>;
  readonly failedAt: import('@kindgi/types').Timestamp;
}

/** @deprecated Wire is flat — see `RunEvent`. */
export interface WaitSuspendedEvent {
  readonly kind: 'run.wait-suspended';
  readonly runId: import('@kindgi/types').RunId;
  readonly tokenId: string;
  readonly suspendedAt: import('@kindgi/types').Timestamp;
}

/** @deprecated Wire is flat — see `RunEvent`. */
export interface WaitResumedEvent {
  readonly kind: 'run.wait-resumed';
  readonly runId: import('@kindgi/types').RunId;
  readonly tokenId: string;
  readonly resumedAt: import('@kindgi/types').Timestamp;
}

/**
 * @deprecated Wire SSE has no `turn.detail` frame kind. Agent-turn
 *   detail events exist only in process, as `@kindgi/agents`'
 *   `TurnEvent` (delivered to `InvokeAgentBindings.onEvent`).
 */
export interface TurnDetailEvent {
  readonly kind: 'turn.detail';
  readonly runId: import('@kindgi/types').RunId;
  readonly detail: TurnEvent;
}

// ============================================================
// Supervisor + fix-proposal shapes.
// ============================================================

// (These are re-exported at the top of the file already; imported here
// for internal use in the shape declarations below.)
import type {
  AuditBundleId,
  DatasetId,
  Filter,
  FixProposalId,
  ObservationId,
  ReviewerId,
  SupervisorId,
} from '@kindgi/types';

/**
 * @unwired SDK-defined supervisor shape; the API has no supervisor
 * definition routes (only `/v1/proposals` and `/v1/observations`). A
 * supervisor is an agent with fix-proposal tools; it observes guardrail
 * violations + structured failure patterns on a subscribed set of
 * agents.
 *
 * A supervisor's own guardrails + eval criteria cannot be modified
 * after it is defined, so an update is a define-with-new-version
 * operation, not a mutation.
 */
export interface SupervisorSpec {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  /** Agent-ids this supervisor observes. Empty = observes all agents in tenant. */
  readonly subscribedAgents?: readonly string[];
  /** Which guardrails trigger fix-proposal drafting. */
  readonly triggerGuardrails: readonly string[];
  /** Proposer tiers enabled (`prompt` | `retrieval` | `tool-config`). */
  readonly proposerTiers: readonly ('prompt' | 'retrieval' | 'tool-config')[];
  /** Dry-run eval criterion applied to every proposal. */
  readonly defaultCriterion?: DryRunCriterion;
}

export interface Supervisor {
  readonly id: SupervisorId;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly subscribedAgents: readonly string[];
  readonly triggerGuardrails: readonly string[];
  readonly proposerTiers: readonly ('prompt' | 'retrieval' | 'tool-config')[];
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly deprecatedAt?: import('@kindgi/types').Timestamp;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#FixProposalStatus`:
 * `draft → dry-running → dry-run-passed|failed → proposed-for-review →
 * approved|rejected → applied|rolled-back | withdrawn`, with a
 * transient `dry-running` state while the dry run executes.
 */
export type FixProposalStatus =
  | 'draft'
  | 'dry-running'
  | 'dry-run-passed'
  | 'dry-run-failed'
  | 'proposed-for-review'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'rolled-back'
  | 'withdrawn';

/**
 * Wire shape — matches `@kindgi/api/openapi.json#FixProposal`. The row
 * carries no review outcome, dry-run result or materialized run:
 * decisions live in the linked HITL approval (`reviewApprovalId`),
 * dry-run results are returned as `DryRunProposalResult` by the dry-run
 * route, and the applied agent version is `appliedVersion`.
 */
export interface FixProposal {
  readonly id: FixProposalId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly supervisorId: SupervisorId;
  readonly agentId: import('@kindgi/types').AgentId;
  readonly agentVersion: string;
  readonly tier: 'prompt' | 'retrieval' | 'tool-config';
  /** Polymorphic change payload — shape depends on `tier`. */
  readonly change: Readonly<Record<string, unknown>>;
  readonly patternRefs: readonly Readonly<Record<string, unknown>>[];
  /** Short human-readable why-this-change note. */
  readonly hypothesis: string;
  /** Proposer-rule identifier that produced this proposal. */
  readonly proposerRuleId: string;
  readonly status: FixProposalStatus;
  /** sha256(tier + agentId + agentVersion + canonical(change)) — dedup key. */
  readonly fingerprint: string;
  readonly resolutionReason?: string;
  /** Linked HITL approval id once the proposal reaches `proposed-for-review`. */
  readonly reviewApprovalId?: ApprovalId;
  /** Semver of the new agent version once applied. */
  readonly appliedVersion?: string;
  readonly appliedAt?: import('@kindgi/types').Timestamp;
  readonly rolledBackAt?: import('@kindgi/types').Timestamp;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly updatedAt: import('@kindgi/types').Timestamp;
  readonly resolvedAt?: import('@kindgi/types').Timestamp;
}

/**
 * @deprecated Per-example dry-run scores do not cross the wire:
 *   `supervisor.proposals.dryRun` returns `DryRunProposalResult
 *   { proposal, passed }`. This type is not returned by any SDK method.
 */
export interface ProposalDryRunResult {
  readonly outcome: 'pass' | 'fail';
  readonly criterion: DryRunCriterion;
  readonly datasetId: DatasetId;
  readonly datasetVersion: string;
  readonly scores: readonly ProposalDryRunScore[];
  readonly summary: {
    readonly baselineMean: number;
    readonly candidateMean: number;
    readonly delta: number;
  };
  readonly ranAt: import('@kindgi/types').Timestamp;
}

export interface ProposalDryRunScore {
  readonly index: number;
  readonly baseline: number;
  readonly candidate: number;
  readonly judgeRationale?: string;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#PassCriterion`.
 * `min-pass-rate` requires the candidate pass rate to hit a floor;
 * `strict-improvement` requires the candidate to beat a baseline by at
 * least `minDelta`.
 */
export type DryRunCriterion =
  | { readonly kind: 'min-pass-rate'; readonly minPassRate: number }
  | {
      readonly kind: 'strict-improvement';
      readonly baselinePassRate: number;
      readonly minDelta: number;
    };

/**
 * Wire shape — matches `@kindgi/api/openapi.json#DryRunProposalResult`.
 * Returned by `POST /v1/proposals/{id}/dry-run`.
 */
export interface DryRunProposalResult {
  readonly proposal: FixProposal;
  /** True when the candidate met the criterion (proposal moved to `dry-run-passed`). */
  readonly passed: boolean;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#SubmitReviewProposalResult`.
 * Returned by `POST /v1/proposals/{id}/submit-review`.
 */
export interface SubmitReviewProposalResult {
  readonly proposal: FixProposal;
  readonly approvalId: ApprovalId;
  /** True when the proposal targets one of the supervisor's own agent ids. */
  readonly metaFix: boolean;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#ApplyProposalResult`.
 * Returned by `POST /v1/proposals/{id}/apply`.
 */
export interface ApplyProposalResult {
  readonly proposalId: FixProposalId;
  readonly appliedVersion: string;
  readonly appliedAt: import('@kindgi/types').Timestamp;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#RollbackProposalResult`.
 * Returned by `POST /v1/proposals/{id}/rollback`.
 */
export interface RollbackProposalResult {
  readonly proposalId: FixProposalId;
  readonly rolledBackAt: import('@kindgi/types').Timestamp;
}

/**
 * @deprecated Wire does not surface a `ProposalReviewOutcome` sub-object
 *   on the proposal row. Review decisions live in the linked HITL
 *   approval — see `client.approvals.decide` + the returned
 *   `CompleteApprovalResult.decision`. Not returned by any SDK method.
 */
export interface ProposalReviewOutcome {
  readonly decision: 'approved' | 'rejected' | 'changes-requested';
  readonly reviewer: ReviewerId;
  readonly reviewedAt: import('@kindgi/types').Timestamp;
  readonly comments?: string;
}

// ============================================================
// Observation shapes.
// ============================================================

/**
 * Wire status values per `@kindgi/api/openapi.json#Observation.status`.
 */
export type ObservationStatus =
  | 'succeeded'
  | 'guardrail-violation'
  | 'guardrail-warning'
  | 'tool-error'
  | 'model-error'
  | 'budget-exceeded'
  | 'aborted'
  | 'other';

/**
 * Wire shape (matches `@kindgi/api/openapi.json#Observation`). The API layer
 * emits a flat status + violations array; the SDK does NOT re-model
 * this as a discriminated outcome — the goal is byte-fidelity with the
 * OpenAPI schema. Callers can pattern-match on `status`.
 */
export interface Observation {
  readonly id: ObservationId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly supervisorId: SupervisorId;
  readonly agentId: import('@kindgi/types').AgentId;
  readonly agentVersion: string;
  readonly conversationId: string;
  readonly turnNumber: number;
  readonly status: ObservationStatus;
  readonly failureCode?: string;
  readonly violations: readonly Readonly<Record<string, unknown>>[];
  readonly failureDetail?: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
  /** Decimal-string per wire (arbitrary precision USD). */
  readonly costUsd: string;
  readonly provider?: { readonly id: string; readonly model: string };
  readonly provenanceRef?: {
    readonly runId: import('@kindgi/types').RunId;
    readonly provenanceId?: import('@kindgi/types').ProvenanceId;
  };
  readonly observedAt: import('@kindgi/types').Timestamp;
}

// ============================================================
// Approval + reviewer + audit shapes.
// ============================================================

/**
 * Wire shape — matches `@kindgi/api/openapi.json#ApprovalStatus`
 * (note the snake_case `in_review` intermediate state).
 */
export type ApprovalStatus =
  | 'pending'
  | 'assigned'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'escalated'
  | 'expired'
  | 'withdrawn';

/**
 * Wire shape — matches `@kindgi/api/openapi.json#ReviewDecisionKind`:
 * `approve | reject | escalate | withdraw` (`escalate` bumps to the
 * next tier; `withdraw` retires the approval without a decision).
 */
export type ApprovalDecision = 'approve' | 'reject' | 'escalate' | 'withdraw';

/**
 * Wire shape — matches `@kindgi/api/openapi.json#Approval`: a flat
 * envelope with a nested `provenanceRef.runId`, a raw `waitTokenId`
 * string, `context` (opaque record), `createdAt + updatedAt`
 * timestamps, and an optional `subjectRef` describing what the reviewer
 * is deciding about (a fix proposal, an agent turn, a tool-call intent,
 * ...).
 *
 * Decisions are not on the row — they live in a separate
 * `ReviewDecision` row keyed by `approvalId`. `POST
 * /v1/approvals/{id}/complete` (`approvals.decide`) returns the
 * recorded decision in `CompleteApprovalResult`; the signed export from
 * `POST /v1/approvals/{id}/audit-bundle` embeds it too.
 */
export interface Approval {
  readonly id: ApprovalId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly projectId?: string;
  /** Discriminator for what the reviewer is deciding about (`agent-turn` / `fix-proposal` / `tool-call` / ...). */
  readonly subjectKind: string;
  /** Kind-specific subject envelope; shape depends on `subjectKind`. */
  readonly subjectRef: Readonly<Record<string, unknown>>;
  readonly requiredRole: ReviewerRole;
  readonly status: ApprovalStatus;
  readonly assignedTo?: ReviewerId;
  readonly batchKey?: string;
  readonly title?: string;
  readonly description?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  /** Present when the approval was raised by a suspended run — carries the run's provenance record id. */
  readonly provenanceRef?: {
    readonly runId: import('@kindgi/types').RunId;
    readonly provenanceId?: import('@kindgi/types').ProvenanceId;
  };
  /** Waitpoint token of the suspended run; a terminal `approve` / `reject` via `approvals.decide` completes it and resumes the run. */
  readonly waitTokenId?: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly updatedAt: import('@kindgi/types').Timestamp;
  readonly decidedAt?: import('@kindgi/types').Timestamp;
  readonly expiresAt?: import('@kindgi/types').Timestamp;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#ReviewDecision`. Decision row
 * returned inside `CompleteApprovalResult` when a review is submitted;
 * also embedded in signed audit-bundle exports.
 */
export interface ReviewDecision {
  readonly id: string;
  readonly approvalId: ApprovalId;
  readonly reviewerId: ReviewerId;
  readonly decision: ApprovalDecision;
  readonly rationale?: string;
  readonly reviewerRoleAtDecision: ReviewerRole;
  readonly decidedAt: import('@kindgi/types').Timestamp;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#CompleteApprovalResult`.
 * Returned by `POST /v1/approvals/{id}/complete` (SDK's
 * `approvals.decide`). When the decision terminates the approval the
 * `kind` is `'terminal'`; when the decision escalates to the next tier
 * a new approval row is created and returned as `nextApproval` (wire's
 * built-in escalation flow).
 */
export interface CompleteApprovalResult {
  readonly kind: 'terminal' | 'escalated';
  readonly approval: Approval;
  readonly decision: ReviewDecision;
  /** Present only when `kind === 'escalated'`. */
  readonly nextApproval?: Approval;
  /** True when the approval had a `waitTokenId` + terminal accept/reject and the run's waitpoint was completed as part of this call. */
  readonly waitpointResolved: boolean;
}

/**
 * Reviewer role classes. `senior` receives meta-fixes (supervisor
 * observing itself); `admin` manages the reviewer roster.
 */
export type ReviewerRole = 'standard' | 'senior' | 'admin';

/**
 * Wire shape — matches `@kindgi/api/openapi.json#RegisterReviewerBody`.
 * The roster is idempotent per `(tenantId, userId)` — re-registering
 * rotates role/displayName rather than inserting a duplicate.
 */
export interface ReviewerSpec {
  readonly userId: import('@kindgi/types').UserId;
  readonly role: ReviewerRole;
  readonly displayName?: string;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#Reviewer`.
 * Deactivation is soft — `deactivatedAt` present → the reviewer no
 * longer receives approvals; the audit trail survives.
 */
export interface Reviewer {
  readonly id: ReviewerId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly userId: import('@kindgi/types').UserId;
  readonly role: ReviewerRole;
  readonly displayName?: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly deactivatedAt?: import('@kindgi/types').Timestamp;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#UnregisterReviewerResult`.
 * Returned by `POST /v1/approvals/reviewers/{reviewerId}/unregister`.
 */
export interface UnregisterReviewerResult {
  readonly reviewerId: ReviewerId;
  readonly unregistered: true;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#ExportAuditBundleResult`:
 * a per-approval signed bundle envelope, the same shape as
 * `ExportProvenanceResult`, so one Ed25519 verifier (for example
 * `verifyEd25519` in `@kindgi/crypto`) handles both. `bundle` is base64
 * of the canonical JSON that was signed; decode + verify with
 * `publicKey` to validate independently.
 */
export interface AuditBundle {
  readonly approvalId: ApprovalId;
  /** Base64-encoded canonical JSON of the bundle body. */
  readonly bundle: string;
  /** Integer schema version for the bundle body. Currently `1`. */
  readonly bundleSchemaVersion: number;
  readonly algorithm: 'ed25519';
  readonly signingKeyId: string;
  /** Base64-encoded Ed25519 signature over the bundle bytes. */
  readonly signature: string;
  /** PEM-encoded Ed25519 public key (`parsePublicKeyPem` in `@kindgi/crypto` decodes it). */
  readonly publicKey: string;
  readonly canonicalization: 'sorted-key-json';
  readonly exportedAt: import('@kindgi/types').Timestamp;
}

/**
 * @deprecated The wire ships per-approval bundles inline via `export`;
 *   there is no list-bundles route. Used only by `approvals.audit.list`,
 *   which throws `not-yet-wired`.
 */
export interface AuditBundleMeta {
  readonly id: AuditBundleId;
  readonly generatedAt: import('@kindgi/types').Timestamp;
  readonly generatedBy: import('@kindgi/types').UserId;
  readonly approvalCount: number;
  readonly sizeBytes: number;
}

/**
 * Client-side verification result for `approvals.audit.verify`. That
 * method throws `not-yet-wired`: the SDK does not bundle an Ed25519
 * verifier (same as `provenance.verify`). To verify a bundle, use
 * `verifyEd25519` from `@kindgi/crypto`.
 */
export interface AuditVerifyResult {
  readonly valid: boolean;
  /** Populated when `valid: false`. */
  readonly issues?: readonly string[];
}

// ============================================================
// Flow / tool / guardrail authoring shapes.
// ============================================================

/**
 * Flow is JSON-serializable; `@kindgi/specs/flow.schema.json` is
 * source of truth; TS types derive from it. Re-export from
 * `@kindgi/flow` so consumers get the authoritative shape.
 */
export type { Flow, FlowEdge, FlowNode } from '@kindgi/flow';

/**
 * Wire shape — matches `@kindgi/api/openapi.json#Tool`. Handlers ship
 * server-side with the pack; the wire never carries executable code
 * (dynamic handler upload is not supported).
 *
 * Fields marked optional here mirror the OpenAPI `required` set.
 * `needs` is an array of `ToolNeed` objects on the wire.
 */
export interface Tool {
  readonly id: import('@kindgi/types').ToolId;
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
  readonly version?: string;
  readonly needs?: readonly Readonly<Record<string, unknown>>[];
  readonly effects?: readonly string[];
  readonly transport?: string;
  readonly mcpEndpoint?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Every tool produces an MCP-compatible manifest by construction.
 * Manifest is the wire shape MCP clients expect.
 */
export interface ToolManifest {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly effects: readonly string[];
}

export interface ToolInvocationResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly effectsObserved: readonly string[];
}

/**
 * @deprecated The API has no built-in guardrail catalog route; used
 *   only by `client.guardrails.builtIns`, which throws `not-yet-wired`.
 *   Built-in checks (`must-cite`, `never-call-tool`, `max-tool-calls`,
 *   `output-matches`, ...) are named + parameterized and referenced by
 *   a guardrail's `check` field; custom-handler checks ship with pack
 *   code, not over the SDK.
 */
export interface BuiltInGuardrail {
  readonly kind: string;
  readonly description: string;
  /** JSON Schema for the params this built-in accepts. */
  readonly paramsSchema: Readonly<Record<string, unknown>>;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#Guardrail`. Guardrails
 * are metadata-only: the `check` string references a server-registered
 * implementation; custom handler upload is not supported.
 */
export interface Guardrail {
  readonly id: import('@kindgi/types').GuardrailId;
  readonly name?: string;
  readonly description?: string;
  /**
   * How the guardrail is checked. Built-in kinds: `zero-llm` = deterministic,
   * `llm-judge` = judge, `external` = out-of-process. Open string: adapters
   * register strategies for their own kinds.
   */
  readonly kind: string;
  /** Reference to the concrete check implementation registered server-side. */
  readonly check: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly action: GuardrailAction;
  readonly severity?: 'info' | 'warn' | 'error' | 'critical';
  readonly scope?: GuardrailScope;
  readonly budget?: {
    readonly maxCostUsd?: number;
    readonly maxLatencyMs?: number;
  };
  readonly judgeCapabilities?: Readonly<Record<string, unknown>>;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#GuardrailAction`. Enumerates
 * what the runtime does when the check reports a violation.
 */
export interface GuardrailAction {
  /**
   * Built-in actions: `halt`, `retry`, `escalate`, `log-only`, `compensate`.
   * Open string: any other name needs an action handler registered under it
   * where the guardrail is evaluated.
   */
  readonly 'on-violation': string;
  readonly retry?: {
    readonly maxAttempts: number;
  };
  readonly escalateTo?: string;
  readonly compensateWith?: string;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#GuardrailScope`. Narrows
 * where the guardrail applies (`always` / `ci-only` / `runtime-only`;
 * per-agent / per-flow / per-tenant lists).
 */
export interface GuardrailScope {
  readonly when?: 'always' | 'ci-only' | 'runtime-only';
  readonly agents?: readonly string[];
  readonly flows?: readonly string[];
  readonly tenants?: readonly string[];
}

/**
 * Body for `POST /v1/guardrails` — matches
 * `@kindgi/api/openapi.json#RegisterGuardrailBody`. Same shape as `Guardrail`
 * on the wire (the `id` is the caller-supplied primary key).
 */
export interface GuardrailSpec {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  /** Built-in kinds: `zero-llm`, `llm-judge`, `external`. Open string — see `Guardrail.kind`. */
  readonly kind: string;
  readonly check: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly action: GuardrailAction;
  readonly severity?: 'info' | 'warn' | 'error' | 'critical';
  readonly scope?: GuardrailScope;
  readonly budget?: {
    readonly maxCostUsd?: number;
    readonly maxLatencyMs?: number;
  };
  readonly judgeCapabilities?: Readonly<Record<string, unknown>>;
}

/**
 * @deprecated No wire route for evaluate. Used only by
 *   `client.guardrails.evaluate`, which throws `not-yet-wired`.
 */
export interface EvaluationResult {
  readonly guardrailId: import('@kindgi/types').GuardrailId;
  readonly outcome: 'pass' | 'fail';
  readonly reason?: string;
  /** Structured evidence — the fields the guardrail kind promises. */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

// ============================================================
// Conversation shapes.
// ============================================================

/**
 * A conversation groups agent invocations into a user-visible thread.
 * Distinct from `Run`: one conversation contains many runs (one per
 * turn); each run's messages persist as memory facts of type
 * `agent-message` scoped to `threadId = conversationId`.
 */
export type ConversationStatus = 'open' | 'closed';

/**
 * Wire shape — matches `@kindgi/api/openapi.json#Conversation`.
 * `tenantId` is implicit in auth on requests but present in the
 * response.
 */
export interface Conversation {
  readonly id: import('@kindgi/types').ThreadId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly agentId: import('@kindgi/types').AgentId;
  readonly agentVersion: string;
  readonly title: string;
  readonly participantId?: string;
  /**
   * The project the conversation is in: the project of the run that
   * opened it, or `projectId` on open. Absent when opened without one, and
   * on conversations from before 0.1.3.
   */
  readonly projectId?: string;
  /** Structural scope (project id, matter id, etc.). */
  readonly scope: Readonly<Record<string, unknown>>;
  readonly status: ConversationStatus;
  readonly turnCount: number;
  readonly openedAt: import('@kindgi/types').Timestamp;
  readonly closedAt?: import('@kindgi/types').Timestamp;
  readonly lastMessageAt?: import('@kindgi/types').Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Wire body for `POST /v1/conversations` per
 * `@kindgi/api/openapi.json#OpenConversationBody`. `scope` is optional
 * (the server defaults an omitted `scope` to `{}`).
 */
export interface OpenConversationInput {
  readonly agentId: import('@kindgi/types').AgentId;
  readonly agentVersion: string;
  /** Put the conversation in a project (one of the tenant's): lists filter by it. */
  readonly projectId?: string;
  readonly scope?: Readonly<Record<string, unknown>>;
  readonly participantId?: string;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type MessageRole = 'user' | 'agent' | 'system' | 'tool';

/**
 * Wire shape — matches `@kindgi/api/openapi.json#ConversationMessage`:
 * `sequence / role / content / toolCall / actor / createdAt`.
 *
 * `content` is `unknown` on the wire (free-form string OR a structured
 * object for tool results / multi-modal payloads).
 */
export interface ConversationMessage {
  /** Monotonic index within the conversation; sort order for `list`. */
  readonly sequence: number;
  readonly role: MessageRole;
  /** Free-form string OR a structured object (tool results, multi-modal). */
  readonly content: unknown;
  /** Optional tool-call metadata when the message is emitted by a tool step. */
  readonly toolCall?: {
    readonly toolId: string;
    readonly invocationId: string;
  };
  /** Free-form actor identifier (user id, agent id, tool id). */
  readonly actor?: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
}

// ============================================================
// Memory shapes — facts, logs, retrieval.
// ============================================================

/**
 * Facts are versioned rows with a typed discoverable interface.
 * Content is a JSON payload; `type` selects the schema; `scope`
 * narrows to a project/thread/tenant.
 *
 * Wire shape — matches `@kindgi/api/openapi.json#Fact`: a numeric
 * `version`, `createdAt / updatedAt?`, and optional `contentRef` (for
 * externally-stored payloads), `contentHash`, `size`, `embeddingModel`,
 * `retention`, `source`, `causedByLogId`, `supersedes`.
 */
export interface Fact {
  readonly id: import('@kindgi/types').FactId;
  readonly type: string;
  readonly scope: Readonly<Record<string, unknown>>;
  /** Monotonic version within (scope, id). Supersession increments. */
  readonly version: number;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly updatedAt?: import('@kindgi/types').Timestamp;
  readonly content?: unknown;
  /** `blob://<provider>/<bucket>/<key>` when the payload is stored externally. */
  readonly contentRef?: string;
  readonly contentHash?: string;
  readonly size?: number;
  readonly embeddingModel?: string;
  readonly retention?: {
    readonly keepUntil?: import('@kindgi/types').Timestamp;
    readonly keepDays?: number;
    readonly legalHold?: boolean;
  };
  readonly source?: Readonly<Record<string, unknown>>;
  readonly causedByLogId?: readonly string[];
  readonly supersedes?: import('@kindgi/types').FactId;
}

/**
 * Body for `POST /v1/memory/facts` — matches
 * `@kindgi/api/openapi.json#WriteFactBody`. The version is
 * server-assigned; the idempotency key travels as a transport header
 * (pass it via `write(input, { idempotencyKey })`).
 */
export interface WriteFactInput {
  readonly type: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly content: unknown;
  readonly retention?: {
    readonly keepUntil?: import('@kindgi/types').Timestamp;
    readonly keepDays?: number;
    readonly legalHold?: boolean;
  };
  /** Caller-supplied idempotence hint (runtime computes its own hash regardless). */
  readonly contentHash?: string;
}

export interface FactFilter extends Filter {
  readonly type?: string;
  readonly scope?: Readonly<Record<string, unknown>>;
}

/**
 * @unwired SDK-defined memory log entry; the API has no memory log
 * routes (`client.memory.logs.*` throws `not-yet-wired`). Entries are
 * hash-chained (`prevHash → hash`) so tampering is detectable.
 */
export interface LogEntry {
  readonly id: import('@kindgi/types').LogEntryId;
  readonly kind: string;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly writtenAt: import('@kindgi/types').Timestamp;
  readonly runId?: import('@kindgi/types').RunId;
  readonly prevHash?: string;
  readonly hash: string;
}

export interface AppendLogInput {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly runId?: import('@kindgi/types').RunId;
}

export interface LogFilter extends Filter {
  readonly kind?: string;
  readonly runId?: import('@kindgi/types').RunId;
}

export interface LogVerifyResult {
  readonly valid: boolean;
  /** Populated when `valid: false` — sequence where the chain broke. */
  readonly brokenAtSequence?: number;
  readonly issues?: readonly string[];
}

/**
 * Retrieval over memory facts — a plain scoped list, keyword search,
 * semantic search, or both.
 *
 * Wire shape — matches `@kindgi/api/openapi.json#RetrieveIntent`:
 * `{ mode, query?, type?, scope?, limit?, embeddingModel? }`. The wire
 * returns a single unpaginated result set bounded by `limit`.
 */
export interface SearchInput {
  /** `list` = plain scoped list (no query). `keyword` = full-text rank. `semantic` = vector cosine similarity. `both` = union deduped. */
  readonly mode: 'list' | 'keyword' | 'semantic' | 'both';
  /** Required for `keyword` / `semantic` / `both`; ignored for `list`. */
  readonly query?: string;
  /** Restrict to a fact type. */
  readonly type?: string;
  /** Scope predicate — same shape as fact `scope`. */
  readonly scope?: Readonly<Record<string, unknown>>;
  readonly limit?: number;
  /** Which embedding to use for `semantic` / `both`. Deployment-defined. */
  readonly embeddingModel?: string;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#RetrievalHit`:
 * `{ fact, score? }` (score is absent for `list` mode; keyword mode
 * returns a full-text rank such as Postgres `ts_rank_cd`, semantic mode
 * returns cosine similarity in [-1, 1]).
 */
export interface RetrievalResult {
  readonly fact: Fact;
  /** Score semantics depend on `mode`. Absent for `list` mode. */
  readonly score?: number;
}

// ============================================================
// Provenance shapes — read + export + verify.
// ============================================================

/**
 * Wire shape — matches `@kindgi/api/openapi.json#ProvenanceRecord`. The full
 * DAG is nested under `dag: { nodes, edges }`. Signed records carry a
 * `signature` object with the ed25519 witness produced at emit time.
 */
export interface ProvenanceRecord {
  readonly id: import('@kindgi/types').ProvenanceId;
  readonly runId: import('@kindgi/types').RunId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly version: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly flowRef?: {
    readonly id: import('@kindgi/types').FlowId;
    readonly version: string;
  };
  readonly dag: {
    readonly nodes: readonly Readonly<Record<string, unknown>>[];
    readonly edges: readonly Readonly<Record<string, unknown>>[];
  };
  readonly signature?: {
    readonly algorithm: 'ed25519';
    readonly keyId: string;
    readonly value: string;
    readonly signedAt: import('@kindgi/types').Timestamp;
  };
  /**
   * Each model call's usage from the cost ledger, by the `callId` in its
   * `model-call` node's attributes. Joined when read: not part of the
   * signed DAG.
   */
  readonly callUsage?: Readonly<
    Record<
      string,
      {
        readonly usage: ModelCallTokens;
        readonly costUsd?: number;
        readonly durationMs?: number;
        readonly servedModel?: string;
      }
    >
  >;
}

/**
 * Wire shape for records surfaced by `GET /v1/provenance` (list). The
 * DAG payload is intentionally omitted — clients fetch it via
 * `GET /v1/provenance/{runId}`.
 */
export interface ProvenanceRecordMetadata {
  readonly id: import('@kindgi/types').ProvenanceId;
  readonly runId: import('@kindgi/types').RunId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly version: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly flowRef?: {
    readonly id: import('@kindgi/types').FlowId;
    readonly version: string;
  };
  readonly signed: boolean;
  /** The project of the record's run; absent on records from before 0.1.3. */
  readonly projectId?: string;
}

/**
 * Wire shape of a signed export bundle envelope — matches
 * `@kindgi/api/openapi.json#ExportProvenanceResult`. The `bundle` field is
 * base64 of canonical-JSON bytes; verifiers re-sign the base64-decoded
 * bytes against `signature`.
 */
export interface ExportedProvenance {
  readonly runId: import('@kindgi/types').RunId;
  readonly bundle: string;
  readonly bundleSchemaVersion: string;
  readonly algorithm: 'ed25519';
  readonly signingKeyId: string;
  readonly signature: string;
  readonly publicKey: string;
  readonly canonicalization: 'sorted-key-json';
  readonly exportedAt: import('@kindgi/types').Timestamp;
}

export interface ProvenanceQueryFilter extends Filter {
  /** Only one project's records (`kind: 'project'`), or every project's in an org (`kind: 'org'`). */
  readonly scope?: import('./scope-wire.js').ScopeRef;
  readonly runId?: import('@kindgi/types').RunId;
  readonly agentId?: import('@kindgi/types').AgentId;
  /** ISO 8601 timestamp — server filters `createdAt > createdAfter`. */
  readonly createdAfter?: import('@kindgi/types').Timestamp;
}

export interface ProvenanceVerifyResult {
  readonly valid: boolean;
  /** Populated when `valid: false`. */
  readonly issues?: readonly string[];
}

// ============================================================
// Platform: tenant, cost, capabilities, providers, adapters, policies.
// ============================================================

/**
 * Multi-tenant SaaS core: tenant lifecycle, user management, cost
 * budgets, admin ops.
 */
export interface Tenant {
  readonly id: import('@kindgi/types').TenantId;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly config: TenantConfig;
}

/**
 * Tenant-level configuration surface. Each field is optional and
 * independently updatable.
 */
export interface TenantConfig {
  /** Data residency (`us-east`, `eu-west`, ...); binds blob + DB regions. */
  readonly residency?: string;
  /** Default retention window in days for memory facts. */
  readonly defaultRetentionDays?: number;
  /** Whether cross-history search is enabled. */
  readonly crossHistoryEnabled?: boolean;
  /** Freeform metadata keyed by feature-flag name. */
  readonly featureFlags?: Readonly<Record<string, unknown>>;
}

export interface TenantConfigUpdate {
  readonly residency?: string;
  readonly defaultRetentionDays?: number;
  readonly crossHistoryEnabled?: boolean;
  readonly featureFlags?: Readonly<Record<string, unknown>>;
}

// -- Cost -------------------------------------------------------

/**
 * Wire shape — matches `@kindgi/api/openapi.json#CostRecord`: `{
 * category, quantity, unit, occurredAt, metrics, attributes }`, where
 * `category` is a free-form string (e.g. `llm.inference`,
 * `tool.invocation`, `storage.write`, `sandbox.exec`).
 */
export interface CostRecord {
  readonly id: string;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly category: string;
  readonly providerId?: ProviderId;
  readonly runId?: import('@kindgi/types').RunId;
  readonly agentId?: import('@kindgi/types').AgentId;
  readonly conversationId?: import('@kindgi/types').ThreadId;
  readonly quantity: number;
  readonly unit: string;
  readonly costUsd?: number;
  readonly occurredAt: import('@kindgi/types').Timestamp;
  readonly metrics?: Readonly<Record<string, unknown>>;
  readonly attributes?: Readonly<Record<string, unknown>>;
  // A model call (`category` `llm.inference`): one record per call.
  /** The call's id; its provenance `model-call` node carries it too. */
  readonly callId?: string;
  readonly projectId?: import('@kindgi/types').ProjectId;
  /** The root of the record's run tree (a flow run, for its agent turns). */
  readonly rootRunId?: import('@kindgi/types').RunId;
  readonly parentRunId?: import('@kindgi/types').RunId;
  readonly agentVersion?: string;
  /** The flow of the run tree's root. */
  readonly flowId?: string;
  /** The step that made the call, and the turn's step number. */
  readonly nodeId?: string;
  readonly step?: number;
  /** What the call was for, beyond the turn's own model step (`guardrail-judge:<id>`). */
  readonly purpose?: string;
  /** The model actually called. */
  readonly model?: string;
  /** The exact model version the vendor reported. */
  readonly servedModel?: string;
  /** The router picked a fallback provider for the turn. */
  readonly fallback?: boolean;
  /** `ok`: the provider answered. `failed`: the call threw. */
  readonly status?: 'ok' | 'failed';
  readonly usage?: ModelCallTokens;
  readonly durationMs?: number;
  readonly finishReason?: string;
  /** The vendor's id for the request. */
  readonly providerRequestId?: string;
  /** HTTP attempts the call took, the client's retries included. */
  readonly attempts?: number;
  readonly error?: { readonly message: string };
  /** The vendor's own usage object, as it reported it (only with `includeRawUsage`). */
  readonly rawUsage?: {
    readonly provider: string;
    readonly model: string;
    readonly usage: Readonly<Record<string, unknown>>;
  };
}

/**
 * A model call's tokens. `promptTokens` / `completionTokens` are the
 * totals; `cacheReadTokens` / `cacheWriteTokens` are parts of
 * `promptTokens`, `reasoningTokens` of `completionTokens`, present when
 * the provider reports them.
 */
export interface ModelCallTokens {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * Token sums of an aggregate. `prompt` / `completion` are the totals;
 * `cacheRead` / `cacheWrite` are parts of `prompt`, `reasoning` of
 * `completion` (`0` where providers didn't report them).
 */
export interface CostTokenTotals {
  readonly prompt: number;
  readonly completion: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

/** @deprecated Renamed to `CostRecord` to match the wire. */
export type UsageRecord = CostRecord;

/**
 * Wire query params for `GET /v1/cost/records` — the server-side
 * filter keys.
 */
export interface CostRecordFilter extends Filter {
  readonly runId?: import('@kindgi/types').RunId;
  /** With `runId`: also every run it started, at any depth. */
  readonly includeDescendants?: boolean;
  /** Every record of the run tree whose root is this run. */
  readonly rootRunId?: import('@kindgi/types').RunId;
  readonly agentId?: import('@kindgi/types').AgentId;
  readonly conversationId?: import('@kindgi/types').ThreadId;
  readonly category?: string;
  readonly providerId?: ProviderId;
  /** The model actually called. */
  readonly model?: string;
  /** The exact model version the vendor reported. */
  readonly servedModel?: string;
  /** Records in this scope: a project, or every project of an org. */
  readonly scope?: import('./scope-wire.js').ScopeRef;
  readonly from?: import('@kindgi/types').Timestamp;
  /** Exclusive. */
  readonly to?: import('@kindgi/types').Timestamp;
  /** Add each model call's `rawUsage`: the vendor's own usage object. */
  readonly includeRawUsage?: boolean;
}

/** @deprecated Renamed to `CostRecordFilter` to match the wire. */
export type UsageQueryFilter = CostRecordFilter;

/**
 * Wire enum of dimensions callers can pass to `cost.aggregate` — matches
 * `@kindgi/api/openapi.json#CostGroupDimension`.
 */
export type CostGroupDimension =
  | 'agentId'
  | 'runId'
  | 'category'
  | 'providerId'
  | 'day'
  | 'month'
  | 'tenant'
  | 'conversationId'
  | 'model'
  | 'servedModel'
  | 'projectId'
  | 'orgId'
  | 'rootRunId'
  | 'flowId';

/**
 * Wire shape for one aggregated bucket — matches
 * `@kindgi/api/openapi.json#CostAggregateGroup`.
 */
export interface CostAggregateGroup {
  /**
   * One entry per requested `groupBy` dimension. `null` = distinct
   * "unattributed" bucket (records had no value for that dimension).
   */
  readonly key: Readonly<Record<string, string | null>>;
  readonly count: number;
  readonly totalUsd: number;
  readonly tokens: CostTokenTotals;
}

/**
 * Wire shape for `GET /v1/cost/aggregate` response — matches
 * `@kindgi/api/openapi.json#CostAggregateResult`.
 */
export interface CostAggregateResult {
  readonly groups: readonly CostAggregateGroup[];
  readonly totalUsd: number;
  readonly totalRecords: number;
  readonly tokens: CostTokenTotals;
  readonly timeRange: {
    readonly from: import('@kindgi/types').Timestamp;
    readonly to: import('@kindgi/types').Timestamp;
  };
  /** The dimensions the server actually grouped by (echoed for round-trip). */
  readonly groupBy: readonly CostGroupDimension[];
}

/** @deprecated Renamed to `CostAggregateResult` to match the wire. */
export type UsageSummary = CostAggregateResult;

export interface Budgets {
  readonly perRunUsdCap?: number;
  readonly dailyUsdCap?: number;
  readonly monthlyUsdCap?: number;
  readonly perProviderUsdCaps?: Readonly<Record<string, number>>;
  readonly onExceed: 'halt' | 'throttle' | 'alert-only';
}

export interface BudgetsRemaining {
  readonly dailyUsdRemaining?: number;
  readonly monthlyUsdRemaining?: number;
  readonly perProviderRemaining?: Readonly<Record<string, number>>;
}

// -- Capabilities + providers ---------------------------------

/**
 * Wire shape — matches `@kindgi/api/openapi.json#CapabilityDescriptor`:
 * `{ id, feature, description, kind?, paramsSchema? }`. `feature` is
 * the primary discriminator (the closed `FEATURES` enum from
 * `@kindgi/capabilities` — `structured-output`, `vision`, `tool-use`,
 * `long-context`, ... — or a deployment-declared name); `id` is the
 * stable identifier (for example `feature:<feature>`; see
 * `packages/api/src/capability-binding.ts`).
 *
 * Capabilities are declarative constraints.
 */
export interface CapabilityDeclaration {
  readonly id: string;
  /** Feature name — either the closed built-in enum or a deployment-declared name. */
  readonly feature: string;
  readonly description: string;
  /** Capability kind (`llm-inference`, `embedding`, `gpu-compute`, ...). Absent = `llm-inference`. */
  readonly kind?: string;
  readonly paramsSchema?: Readonly<Record<string, unknown>>;
}

export interface CapabilityNeed {
  readonly feature: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * @deprecated No `POST /v1/capabilities/route` on the wire. Used only
 *   by `client.capabilities.route`, which throws `not-yet-wired`.
 */
export interface RouteResult {
  readonly selected: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly reason: string;
  };
  /** All candidates considered, ranked. */
  readonly candidates: readonly {
    readonly provider: ProviderId;
    readonly model: string;
    readonly score: number;
    readonly excluded?: string;
  }[];
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#ProviderMetadata`:
 * `{ id, model, region, contextWindow, features[], cost, p95LatencyMs?,
 * attributes?[], description?, capabilityKind? }`. One row per
 * endpoint (a specific `model` at a specific `region`); there is no
 * enable/disable state or vendor-with-N-models aggregation.
 *
 * Per-tenant policy filters provider candidates before selection.
 */
// Provider shape used by the `client.capabilities.providers` sub-client.
// Named to avoid colliding with the `Provider` re-exported from
// `./resources/providers.js` (aliased from generated `ProviderMetadata`).
// Not re-exported from index.ts.
export interface LegacyCapabilitiesProvider {
  readonly id: string;
  /** Human-readable model id (e.g. `acme-llm/acme-large`). */
  readonly model: string;
  /** Region the provider dispatches to. `'unspecified'` when not region-scoped. */
  readonly region: string;
  readonly contextWindow: number;
  readonly features: readonly string[];
  readonly cost: {
    readonly promptUsdPer1kTokens: number;
    readonly completionUsdPer1kTokens: number;
  };
  readonly p95LatencyMs?: number;
  readonly attributes?: readonly string[];
  readonly description?: string;
  readonly capabilityKind?: string;
}

/**
 * Body for `POST /v1/providers` — matches
 * `@kindgi/api/openapi.json#RegisterProviderBody` (same shape as
 * `ProviderMetadata`). Credentials are deployment-config concerns
 * (bound at boot in the caller-plugged `ProviderRegistryBinding` in
 * `@kindgi/api`); the register-provider wire body carries only
 * routing-relevant metadata.
 */
export interface ProviderSpec {
  readonly id: string;
  readonly model: string;
  readonly region: string;
  readonly contextWindow: number;
  readonly features: readonly string[];
  readonly cost: {
    readonly promptUsdPer1kTokens: number;
    readonly completionUsdPer1kTokens: number;
  };
  readonly p95LatencyMs?: number;
  readonly attributes?: readonly string[];
  readonly description?: string;
  readonly capabilityKind?: string;
}

// -- Adapters -------------------------------------------------

/**
 * Wire enum — matches `@kindgi/api/openapi.json#AdapterKind` (which mirrors
 * `ADAPTER_KINDS` in `@kindgi/api`). Adapters bridge the runtime to
 * outside systems: model providers, embedding services, blob storage,
 * sandbox providers, eval judges.
 */
export type AdapterKind =
  | 'model'
  | 'model-provider'
  | 'embedding'
  | 'blob'
  | 'sandbox'
  | 'eval-judge';

export type AdapterStatus = 'active' | 'degraded' | 'error';

/**
 * Wire shape — matches `@kindgi/api/openapi.json#Adapter`. `config` is
 * redacted routing metadata only (never credentials). `statusReason`
 * accompanies non-`active` statuses.
 */
export interface Adapter {
  readonly adapterId: string;
  readonly kind: AdapterKind;
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly status: AdapterStatus;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly statusReason?: string;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#AdapterTestOutcome`. A
 * failed probe returns HTTP 200 with `ok: false`; it is a valid
 * observation, not a server error (see `docs/API-ROUTE-CONVENTIONS.md`).
 */
export interface AdapterTestOutcome {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly probe: Readonly<Record<string, unknown>>;
}

// -- Policies -------------------------------------------------

/**
 * A tenant policy, versioned per tenant.
 *
 * Wire shape — matches `@kindgi/api/openapi.json#Policy`:
 * `{ tenantId, kind, description, spec }`. `kind` selects the schema
 * for `spec` (opaque JSON).
 */
export interface Policy {
  readonly id: import('@kindgi/types').PolicyId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly version: string;
  readonly kind: PolicyKind;
  readonly description?: string;
  /** Kind-specific policy body. Opaque jsonb on the wire. */
  readonly spec: Readonly<Record<string, unknown>>;
}

/**
 * Wire enum — matches `@kindgi/api/openapi.json#PolicyKind`.
 */
export type PolicyKind =
  | 'access-control'
  | 'model-routing'
  | 'adapter-allowlist'
  | 'rate-limit'
  | 'retention'
  | 'compliance'
  | 'tool-errors'
  | 'hitl';

/** @deprecated The wire has no policy status; policies are selected by `kind`. */
export type PolicyStatus = 'draft' | 'active' | 'archived';

/**
 * Wire body for `POST /v1/policies` per
 * `@kindgi/api/openapi.json#PublishPolicyBody`: `{ kind, description,
 * spec }`.
 */
export interface PolicySpec {
  readonly id: string;
  readonly version: string;
  readonly kind: PolicyKind;
  readonly description?: string;
  readonly spec: Readonly<Record<string, unknown>>;
}

/**
 * Input to policy evaluation — evaluate a policy against a principal +
 * resource + action tuple, returning a decision.
 */
export interface PolicyEvaluateInput {
  readonly principal: {
    readonly userId?: import('@kindgi/types').UserId;
    readonly roles?: readonly string[];
    readonly attributes?: Readonly<Record<string, unknown>>;
  };
  readonly resource: {
    readonly kind: string;
    readonly id: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  };
  readonly action: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface PolicyDecision {
  readonly effect: 'allow' | 'deny';
  readonly reason?: string;
  readonly matchedRule?: string;
}

// ============================================================
// Identity: users, teams, orgs, tokens, sessions.
// ============================================================

/**
 * Wire shape — matches `@kindgi/api/openapi.json#IdentitySessionSummary`:
 * `{ sessionId, userId, providerId, createdAt, expiresAt, scopes[],
 * revokedAt? }`. Provider access / refresh tokens never cross the wire,
 * even to admins (see `packages/api/src/routes/identity.ts`).
 */
export interface Session {
  readonly sessionId: string;
  readonly userId: import('@kindgi/types').UserId;
  readonly providerId: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly expiresAt: import('@kindgi/types').Timestamp;
  readonly scopes: readonly string[];
  readonly revokedAt?: import('@kindgi/types').Timestamp;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#UserRecord`:
 * `{ userId, tenantId, primaryEmail?, displayName?, createdAt,
 * lastActiveAt?, metadata? }`. The API does not own user persistence
 * (deployments plug in their identity plane — LDAP, SCIM, or a bespoke
 * store); attributes such as email verification or deactivation, when
 * an identity provider has them, travel in `metadata`.
 */
export interface User {
  readonly userId: import('@kindgi/types').UserId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly primaryEmail?: string;
  readonly displayName?: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly lastActiveAt?: import('@kindgi/types').Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#WhoamiResult`. Returned by
 * `GET /v1/identity/whoami` (`client.users.me()`). Bearer-token callers
 * see `tenantId` only (plus optional `userId` when the token was minted
 * with one); session-token callers additionally see `sessionId`,
 * `providerId`, `scopes`, and `expiresAt`. When the token carries a
 * `userId`, the identity directory adds `user: UserRecord`.
 */
export interface WhoamiResult {
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly scopes: readonly string[];
  readonly userId?: import('@kindgi/types').UserId;
  readonly sessionId?: string;
  readonly providerId?: string;
  readonly expiresAt?: import('@kindgi/types').Timestamp;
  readonly user?: User;
}

/**
 * @deprecated No user-creation route on the wire (the API does not own
 *   user persistence — deployments plug in their own identity plane).
 *   Used only by `client.users.create`, which throws `not-yet-wired`.
 */
export interface UserSpec {
  readonly email: string;
  readonly displayName: string;
  readonly orgId?: import('@kindgi/types').OrgId;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * @deprecated No user-update route on the wire. Used only by
 *   `client.users.update`, which throws `not-yet-wired`.
 */
export interface UserPatch {
  readonly email?: string;
  readonly displayName?: string;
  readonly orgId?: import('@kindgi/types').OrgId | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Result envelope for `POST /v1/identity/users/{userId}/revoke-sessions`. */
export interface RevokeSessionsResult {
  readonly userId: import('@kindgi/types').UserId;
  readonly revokedCount: number;
}

/**
 * Teams are people-groups; team↔project relationships live in OpenFGA,
 * not here.
 */
export interface Team {
  readonly id: import('@kindgi/types').TeamId;
  readonly name: string;
  readonly description?: string;
  readonly orgId?: import('@kindgi/types').OrgId;
  readonly memberCount: number;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly updatedAt: import('@kindgi/types').Timestamp;
}

export interface TeamSpec {
  readonly name: string;
  readonly description?: string;
  readonly orgId?: import('@kindgi/types').OrgId;
}

export interface TeamPatch {
  readonly name?: string;
  readonly description?: string;
  readonly orgId?: import('@kindgi/types').OrgId | null;
}

export type TeamRole = 'member' | 'admin';

export interface TeamMembership {
  readonly teamId: import('@kindgi/types').TeamId;
  readonly userId: import('@kindgi/types').UserId;
  readonly role: TeamRole;
  readonly joinedAt: import('@kindgi/types').Timestamp;
}

/**
 * Structural subdivision within a tenant (a firm's litigation dept, a
 * hospital's cardiology). Small tenants ignore; large tenants use.
 */
export interface Org {
  readonly id: import('@kindgi/types').OrgId;
  readonly name: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly updatedAt: import('@kindgi/types').Timestamp;
}

export interface OrgSpec {
  readonly name: string;
}

export interface OrgPatch {
  readonly name?: string;
}

/**
 * Project primitive. Each tenant has exactly one Default project.
 *
 * Mirrors `@kindgi/platform`'s `Project` shape. Vertical-agnostic on
 * the wire (packs alias it — `Matter` in legal, `Case` in HR,
 * `Engagement` in accounting, `Episode` in healthcare, `Deal` in
 * finance).
 */
export interface Project {
  readonly id: import('@kindgi/types').ProjectId;
  readonly tenantId: import('@kindgi/types').TenantId;
  /**
   * Optional nullable FK — a project may belong to an org, or be
   * cross-org (`orgId` absent).
   */
  readonly orgId?: import('@kindgi/types').OrgId;
  readonly name: string;
  readonly slug: string;
  /**
   * `true` for the tenant's auto-created "Default" project. Exactly
   * one row per tenant carries `isDefault = true`.
   */
  readonly isDefault: boolean;
  readonly description?: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly updatedAt: import('@kindgi/types').Timestamp;
}

export interface ProjectSpec {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly orgId?: import('@kindgi/types').OrgId;
  /**
   * Optional at spec time — the tenant's Default project is
   * created by the server when the tenant is created, not by a caller.
   */
  readonly isDefault?: boolean;
}

export interface ProjectPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly orgId?: import('@kindgi/types').OrgId | null;
}

/**
 * Roles on a `ProjectMembership` — the direct `User → Project`
 * grant shape. Additive with team-grants. Mirrors the OpenFGA
 * project-type relations (owner / editor / viewer)
 * plus the lightweight `member` and administrative `admin`
 * shorthands.
 */
export type ProjectRole = 'viewer' | 'editor' | 'owner' | 'admin' | 'member';

export interface ProjectMembership {
  readonly projectId: import('@kindgi/types').ProjectId;
  readonly userId: import('@kindgi/types').UserId;
  readonly role: ProjectRole;
  readonly joinedAt: import('@kindgi/types').Timestamp;
}

/**
 * An API key's role in its tenant: `admin` administers the tenant (and
 * manages keys); `member` belongs to it and administers nothing.
 */
export type ApiTokenRole = 'admin' | 'member';

/**
 * API keys: machine credentials, one service account each, per tenant,
 * with a role and explicit capabilities. The secret is shown once, at
 * creation.
 */
export interface ApiToken {
  readonly id: ApiTokenId;
  readonly role: ApiTokenRole;
  /** Framework capabilities the key carries (`env:write`, `secrets:write`, …). */
  readonly capabilities: readonly string[];
  readonly label?: string;
  readonly projectId?: import('@kindgi/types').ProjectId;
  /** Who minted it: `user:<id>` or `service_account:<tokenId>`. */
  readonly createdBy?: string;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly lastUsedAt?: import('@kindgi/types').Timestamp;
  readonly expiresAt?: import('@kindgi/types').Timestamp;
  readonly revokedAt?: import('@kindgi/types').Timestamp;
}

export interface ApiTokenSpec {
  /** `member` when absent. */
  readonly role?: ApiTokenRole;
  /** None when absent. Only capabilities the caller holds can be granted. */
  readonly capabilities?: readonly string[];
  readonly label?: string;
  readonly expiresAt?: import('@kindgi/types').Timestamp;
  readonly projectId?: import('@kindgi/types').ProjectId;
}

/**
 * Return value of `tokens.create` — the only place the plaintext
 * secret is ever surfaced. Consumers must persist immediately.
 */
export interface ApiTokenCreated {
  readonly meta: ApiToken;
  readonly secret: string;
}

// ============================================================
// Interop: MCP, events, artifacts (blobs), webhooks.
// ============================================================

/**
 * @unwired SDK-defined shapes for exposing Kindgi itself as an MCP
 * server (`serverInfo`, `tools`, `agents`, `invokeTool`, `invokeAgent`
 * on `client.mcp`); the API has no routes for them. The API's MCP
 * routes (`/v1/mcp/endpoints`) register external MCP servers the tenant
 * can reach — see `McpEndpoint`.
 */
export interface McpServerInfo {
  readonly url: string;
  readonly protocolVersion: string;
  /** Total tools + agents exposed at this endpoint. */
  readonly exposedCount: number;
}

export interface McpAgentExposure {
  readonly agentId: import('@kindgi/types').AgentId;
  readonly name: string;
  readonly description: string;
  /** Aggregate tool manifest for the agent's declared tools. */
  readonly toolManifests: readonly ToolManifest[];
}

/**
 * MCP transport variant — matches `@kindgi/api/openapi.json#MCPTransport`.
 *
 * - `stdio` — local subprocess (spawn a command).
 * - `http-sse` — the older HTTP+SSE transport (separate POST + SSE endpoints).
 * - `streamable-http` — MCP 2025-03 Streamable HTTP (single endpoint,
 *   session-id via header).
 */
export type McpTransport = 'stdio' | 'http-sse' | 'streamable-http';

/**
 * Transport-tagged config union — matches the `MCPEndpoint.config`
 * oneOf on the wire. Server enforces `config.transport === transport`
 * at registration.
 */
export type McpEndpointConfig =
  | {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: 'http-sse';
      readonly url: string;
      /** Optional distinct SSE endpoint if the server splits them. */
      readonly sseUrl?: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: 'streamable-http';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

/**
 * Wire shape — matches `@kindgi/api/openapi.json#MCPEndpointSecretRef`. The
 * secret an endpoint authenticates with, by name in the deployment's
 * secrets store (store it first); sent as the endpoint's bearer.
 */
export interface McpEndpointSecretRef {
  readonly envName: string;
  readonly name: string;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#MCPEndpoint`. Represents an
 * external MCP server the tenant has registered as reachable.
 */
export interface McpEndpoint {
  readonly endpointId: string;
  /** Human-readable display name. */
  readonly name: string;
  readonly transport: McpTransport;
  readonly config: McpEndpointConfig;
  readonly secretRef?: McpEndpointSecretRef;
}

/**
 * Input for `POST /v1/mcp/endpoints` per
 * `@kindgi/api/openapi.json#RegisterMCPEndpointBody`. `scope` is sent as
 * the body's `scopeKind` + `scopeId`.
 */
export interface RegisterMcpEndpointInput {
  readonly endpointId: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly config: McpEndpointConfig;
  /**
   * The secret to authenticate with. A deployment refuses `stdio` endpoints
   * (`403 host-access-denied`) unless it runs with `KINDGI_TENANT_HOST_ACCESS=local`.
   */
  readonly secretRef?: McpEndpointSecretRef;
  /** The scope the endpoint is registered in; authorization checks it. */
  readonly scope: import('./scope-wire.js').ScopeRef;
}

/**
 * @unwired SDK-defined event shapes; the API has no event emission or
 * subscription routes (`client.events.*` throws `not-yet-wired`).
 * Event-driven runs are configured with `client.eventTriggers`. Filters
 * are declarative predicates over event fields.
 */
export interface Event {
  readonly id: import('@kindgi/types').EventId;
  readonly kind: string;
  readonly emittedAt: import('@kindgi/types').Timestamp;
  readonly emittedBy?: import('@kindgi/types').RunId;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Causal reference — the event that caused this one, if any. */
  readonly causedBy?: import('@kindgi/types').EventId;
}

export interface EventSpec {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly causedBy?: import('@kindgi/types').EventId;
}

/**
 * The filter DSL is declarative predicates over event fields
 * (data, not code).
 */
export interface SubscriptionSpec {
  readonly name: string;
  readonly filter: EventFilter;
  /** Where to route matching events. */
  readonly target:
    | { readonly kind: 'trigger-flow'; readonly flow: import('@kindgi/types').FlowId }
    | { readonly kind: 'stream' }
    | { readonly kind: 'webhook'; readonly endpoint: WebhookEndpointId };
  /** Rate limiting (backpressure). */
  readonly maxRate?: { readonly perSecond: number; readonly dropPolicy: 'drop-new' | 'drop-old' };
}

export interface Subscription {
  readonly id: import('@kindgi/types').SubscriptionId;
  readonly name: string;
  readonly filter: EventFilter;
  readonly target: SubscriptionSpec['target'];
  readonly maxRate?: SubscriptionSpec['maxRate'];
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly active: boolean;
}

/**
 * Declarative event filter — a predicate tree over event fields.
 */
export type EventFilter =
  | { readonly kind: readonly string[] }
  | { readonly and: readonly EventFilter[] }
  | { readonly or: readonly EventFilter[] }
  | { readonly not: EventFilter }
  | { readonly field: string; readonly op: 'eq' | 'neq' | 'in'; readonly value: unknown };

export interface EventListFilter extends Filter {
  readonly kinds?: readonly string[];
  readonly emittedBy?: import('@kindgi/types').RunId;
}

/**
 * Object storage abstraction. Content-addressed (`sha256`), streamed
 * (never load-in-memory), policy-checked at every operation.
 * Presigned URLs for browser-direct upload.
 * `BlobRef` shape is the primary artifact reference across the OS.
 */
export interface BlobRef {
  readonly provider: string;
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly createdAt: import('@kindgi/types').Timestamp;
  readonly retentionUntil?: import('@kindgi/types').Timestamp;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#BlobMeta`: the
 * artifact metadata returned by the `/v1/artifacts` routes. `BlobRef`
 * is the SDK's artifact reference shape (memory facts carry `BlobRef`
 * for large content); the two overlap but are not identical.
 */
export interface BlobMeta {
  readonly blobId: import('@kindgi/types').ArtifactId;
  readonly tenantId: import('@kindgi/types').TenantId;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  /** sha256 of the body, hex-encoded, lowercase (64 chars). */
  readonly hash: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly ownerRunId?: import('@kindgi/types').RunId;
  readonly createdAt: import('@kindgi/types').Timestamp;
}

export interface PutArtifactInput {
  readonly contentType: string;
  readonly body: ReadableStream<Uint8Array> | Uint8Array | Blob;
  /** Optional key hint; default = content-addressed by sha256. */
  readonly key?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Retention lock — write-once, held until this timestamp. */
  readonly retentionUntil?: import('@kindgi/types').Timestamp;
}

export interface GetArtifactResult {
  readonly ref: BlobRef;
  readonly body: ReadableStream<Uint8Array>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PresignInput {
  readonly ref?: BlobRef;
  /** For upload presign — the content-type of the payload the caller will PUT. */
  readonly contentType?: string;
  readonly operation: 'get' | 'put';
  readonly ttlSeconds?: number;
}

export interface PresignedUrl {
  readonly url: string;
  readonly method: 'GET' | 'PUT';
  readonly expiresAt: import('@kindgi/types').Timestamp;
  /** Headers the caller must include when using the URL. */
  readonly headers?: Readonly<Record<string, string>>;
}

// ============================================================
// Packs — installable vertical applications.
// ============================================================

/**
 * @unwired Pack = manifest bundling agents + tools-as-MCP-endpoints +
 * guardrails + memory schemas + capability declarations + metadata.
 * The API has no pack routes (`client.packs.*` throws
 * `not-yet-wired`).
 *
 * The manifest is JSON per `@kindgi/specs/pack.schema.json` (source of
 * truth); content stays loose here.
 */
export interface Pack {
  readonly id: import('@kindgi/types').PackId;
  readonly name: string;
  readonly description: string;
  readonly vendor: string;
  readonly version: string;
  readonly latestVersion?: string;
  /** Manifest signature, when the pack is signed. */
  readonly signature?: {
    readonly algorithm: 'ed25519';
    readonly keyId: string;
    readonly value: string;
  };
  /** Contents of the pack: agents, tools, guardrails, memory schemas, capabilities. */
  readonly manifest: PackManifest;
  readonly publishedAt: import('@kindgi/types').Timestamp;
}

/**
 * Bundled content. Individual arrays are
 * intentionally loose (`unknown[]`) because the schemas of Agent /
 * Tool / Guardrail / MemorySchema / CapabilityDeclaration inside a
 * pack manifest are the per-package spec authorities — the pack
 * manifest is a package of those, not its own re-definition.
 */
export interface PackManifest {
  readonly agents: readonly unknown[];
  /** Tool bindings — tools-as-MCP-endpoints. */
  readonly tools: readonly PackToolBinding[];
  readonly guardrails: readonly unknown[];
  readonly memorySchemas: readonly unknown[];
  readonly capabilities: readonly unknown[];
  /** Metadata: display, icons, documentation URLs, min-OS-version. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * A pack tool reached over MCP. Its code runs outside the runtime server
 * process.
 */
export interface PackToolBinding {
  readonly toolId: string;
  readonly mcpEndpoint: string;
  readonly authRef?: string;
}

export type PackInstallStatus = 'installed' | 'disabled' | 'upgrading' | 'uninstalled';

/**
 * A pack installed into a specific tenant. Distinct from `Pack`
 * (the shippable artifact) — `InstalledPack` carries per-tenant
 * config, enable/disable state, and installation history.
 */
export interface InstalledPack {
  readonly installationId: InstallationId;
  readonly pack: import('@kindgi/types').PackId;
  readonly packVersion: string;
  readonly status: PackInstallStatus;
  readonly installedAt: import('@kindgi/types').Timestamp;
  readonly installedBy: import('@kindgi/types').UserId;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly disabledAt?: import('@kindgi/types').Timestamp;
  readonly uninstalledAt?: import('@kindgi/types').Timestamp;
}

/**
 * Pack install input: `bundle` installs a trusted manifest the admin
 * uploads; `registry` installs a published pack by id + version.
 */
export type PackInstallInput =
  | {
      readonly kind: 'bundle';
      /** Manifest JSON as literal or a `BlobRef` pointer to an uploaded bundle. */
      readonly manifest: PackManifest;
      readonly config?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'registry';
      readonly packId: import('@kindgi/types').PackId;
      readonly version: string;
      readonly config?: Readonly<Record<string, unknown>>;
    };

/**
 * Auth configuration. Two modes: an API token (M2M, per-tenant,
 * rotatable) or an OAuth 2.0 access token (user-context flows). Both
 * are sent as `Authorization: Bearer <token>`.
 */
export type AuthConfig =
  | { readonly kind: 'apiToken'; readonly token: string }
  | {
      readonly kind: 'oauth';
      readonly accessToken: string;
      /** Called when the server returns `auth/token-expired`. */
      readonly refresh?: () => Promise<string>;
    };

export interface ClientOptions {
  /** Base URL of the Kindgi API, without trailing slash. */
  readonly apiUrl: string;
  readonly auth: AuthConfig;
  /** Overridable fetch impl for testing. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

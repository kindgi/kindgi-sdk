// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Branded ID types for every entity kind in Kindgi.
 *
 * Every ID is a nominal string type — structurally a string, but statically distinct.
 * A `TenantId` cannot be passed where a `UserId` is expected, catching a whole class
 * of bugs at compile time.
 *
 * These are pure compile-time constructs; there is no runtime cost. Construction
 * is by cast (`as`). The one exception is `EnvName`, which has the validated
 * factory `makeEnvName` (the only runtime export of this package); validation of
 * wire payloads lives in `@kindgi/schema`.
 *
 * Naming convention:
 *   - `<Entity>Id`     — a single identifier for that entity kind.
 *   - Most entity kinds in the `@kindgi/specs/*.schema.json` files have an ID
 *     here (eval suites, for one, use plain strings); some IDs (e.g.
 *     `ConversationId`, `TriggerId`) name entities that have no schema.
 *
 * If you add a new entity kind to Kindgi, add its ID here. Consumers rely on
 * this being the canonical registry of branded IDs.
 */

/**
 * Generic brand utility. Prefer using the pre-defined branded types below;
 * this is exported for downstream packs that need to declare pack-scoped IDs
 * (e.g. `Brand<string, 'MatterId'>` in a pack that tracks legal matters).
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/**
 * `T` with every branded string in it (`FlowId`, `NodeId`, `EdgeId`, …)
 * loosened to plain `string`, all the way down: through arrays, objects
 * and unions. For authoring inputs, so an author writes `'acme.review'`
 * rather than `'acme.review' as FlowId`. A branded value still fits, since
 * it is a string. The validated result is branded again.
 */
export type Unbranded<T> = T extends string & { readonly __brand: string }
  ? string
  : T extends readonly (infer E)[]
    ? readonly Unbranded<E>[]
    : T extends object
      ? { readonly [K in keyof T]: Unbranded<T[K]> }
      : T;

/** Tenant — the sovereignty boundary. Cross-tenant access is denied by policy. */
export type TenantId = Brand<string, 'TenantId'>;

/** User within a tenant. */
export type UserId = Brand<string, 'UserId'>;

/** Organization scope within a tenant — optional structural subdivision (a firm's litigation department, a hospital's cardiology). Small tenants ignore this; large tenants use it. */
export type OrgId = Brand<string, 'OrgId'>;

/** Team scope — a people-group. A named collection of users who work together; users can belong to many teams. Same team works on many projects; same project can have many teams collaborating. Distinct from Org (structural) — Team is about working groups. */
export type TeamId = Brand<string, 'TeamId'>;

/** Project scope — vertical-agnostic ('matter' in legal, 'case' in HR, 'engagement' in accounting, 'episode' in healthcare). This is the primary content-scope: facts, artifacts, runs, blobs belong to a project. */
export type ProjectId = Brand<string, 'ProjectId'>;

/** Conversation thread within a session. */
export type ThreadId = Brand<string, 'ThreadId'>;

/**
 * Agent conversation. A conversation is a first-class primitive (see the
 * `agent_conversations` migration in `@kindgi/agents`): it groups many
 * agent invocations into one durable thread the user can reopen, hand
 * off, or reference in a later run. Distinct from `ThreadId` (which is a
 * lower-level session-thread identifier used by the session store).
 */
export type ConversationId = Brand<string, 'ConversationId'>;

/** User session. */
export type SessionId = Brand<string, 'SessionId'>;

/** A run — one execution of a flow. */
export type RunId = Brand<string, 'RunId'>;

/**
 * Task flow definition id. Convention: `<pack-id>.<flow-name>`
 * (kebab-case, dot-namespaced) — e.g. `acme.brief-review-flow`,
 * `demo.echo-flow`. The framework's built-in agent-turn flow is
 * `agent.turn` (`AGENT_TURN_FLOW_ID` in `@kindgi/agents`).
 */
export type FlowId = Brand<string, 'FlowId'>;

/** A node within a flow. Convention: kebab-case, unique within the flow — e.g. `dispatch-tool`, `wait-for-approval`. */
export type NodeId = Brand<string, 'NodeId'>;

/** An edge within a flow. Declared by the flow author (`FlowEdge.id` in `@kindgi/flow`); must be unique across the flow, including its loop bodies. */
export type EdgeId = Brand<string, 'EdgeId'>;

/**
 * Agent definition id. Convention: `<pack-id>.<agent-name>`
 * (kebab-case, dot-namespaced) — e.g. `acme.brief-writer`,
 * `demo.echo-agent`. The `<pack-id>` prefix scopes the agent to
 * its pack; `<agent-name>` describes the agent's role. Enforced by
 * `defineAgent` at author time.
 */
export type AgentId = Brand<string, 'AgentId'>;

/**
 * Tool definition id. Convention: `<pack-id>.<tool-name>`
 * (kebab-case, dot-namespaced) — e.g. `acme.verify-citation`,
 * `demo.echo`. The `<pack-id>` prefix scopes the tool to its pack;
 * `<tool-name>` names the operation. Enforced by `defineTool` at
 * author time.
 */
export type ToolId = Brand<string, 'ToolId'>;

/**
 * Guardrail declaration id. Convention: `<pack-id>.<guardrail-name>`
 * (kebab-case, dot-namespaced) — e.g. `acme.no-fabricated-quotes`,
 * `demo.response-not-empty`. `<guardrail-name>` describes the
 * property being asserted (usually a positive rule the agent turn
 * must satisfy). Enforced by `defineGuardrail` at author time.
 */
export type GuardrailId = Brand<string, 'GuardrailId'>;

/** A tenant policy document. */
export type PolicyId = Brand<string, 'PolicyId'>;

/** A pack manifest (installable vertical application). */
export type PackId = Brand<string, 'PackId'>;

/** An event (runtime-emitted or user-emitted). */
export type EventId = Brand<string, 'EventId'>;

/** A memory Fact — typed, versioned, retrievable. */
export type FactId = Brand<string, 'FactId'>;

/** A memory LogEntry — one line in the append-only event stream. */
export type LogEntryId = Brand<string, 'LogEntryId'>;

/** A generated artifact (draft, memo, report). */
export type ArtifactId = Brand<string, 'ArtifactId'>;

/** A provenance DAG record. */
export type ProvenanceId = Brand<string, 'ProvenanceId'>;

/** A subscription registration for the events system. */
export type SubscriptionId = Brand<string, 'SubscriptionId'>;

/** An approval request in the HITL queue. */
export type ApprovalId = Brand<string, 'ApprovalId'>;

/** A reviewer registered with HITL — carries a role class (standard/senior/admin). */
export type ReviewerId = Brand<string, 'ReviewerId'>;

/** A supervisor definition — the actor that observes runs and proposes fixes. */
export type SupervisorId = Brand<string, 'SupervisorId'>;

/** A recorded supervisor observation of a single agent run. */
export type ObservationId = Brand<string, 'ObservationId'>;

/** A supervisor's proposed fix to an agent artifact (prompt / retrieval / tool-config). */
export type FixProposalId = Brand<string, 'FixProposalId'>;

/** A signed audit bundle exported from HITL. Wraps approvals + evidence + provenance refs. */
export type AuditBundleId = Brand<string, 'AuditBundleId'>;

/** A compliance evidence bundle. */
export type ComplianceEvidenceId = Brand<string, 'ComplianceEvidenceId'>;

/** A wait token issued for pausing a run (HITL, external callback). */
export type WaitTokenId = Brand<string, 'WaitTokenId'>;

/** A training dataset registered in memory. */
export type DatasetId = Brand<string, 'DatasetId'>;

/** A recurring schedule that triggers agent / flow runs on a cadence. */
export type ScheduleId = Brand<string, 'ScheduleId'>;

/** A registered capability provider (model provider, embedding provider, etc.). */
export type ProviderId = Brand<string, 'ProviderId'>;

/** An API token issued to a caller for authenticating platform requests. */
export type ApiTokenId = Brand<string, 'ApiTokenId'>;

/** The routable public identifier of an inbound webhook trigger: the id in its receiver URL (see `TriggerId`). */
export type WebhookId = Brand<string, 'WebhookId'>;

/** An outbound webhook endpoint: a URL the platform sends signed events to. */
export type WebhookEndpointId = Brand<string, 'WebhookEndpointId'>;

/** One outbound webhook event. Sent as the `webhook-id` header and the same on every retry, so receivers deduplicate on it. */
export type WebhookEventId = Brand<string, 'WebhookEventId'>;

/** One event's delivery to one outbound endpoint, across all its attempts. */
export type WebhookDeliveryId = Brand<string, 'WebhookDeliveryId'>;

/** An installed pack instance for a tenant. Reserved: no package in this repository issues one. */
export type InstallationId = Brand<string, 'InstallationId'>;

/** A signing key — identifies a key pair in a caller-provided key store (see `SigningKeyBinding` in `@kindgi/crypto`). Keys themselves are opaque `Uint8Array` values; this ID is how consumers reference them at runtime without owning the store. */
export type SigningKeyId = Brand<string, 'SigningKeyId'>;

/** A registered trigger — its storage primary key. Distinct from `WebhookId` (routable public identifier used on the receiver URL); a webhook trigger has both a `TriggerId` (private, primary key) and a `WebhookId` (public, routable). */
export type TriggerId = Brand<string, 'TriggerId'>;

/**
 * A per-environment slug carried as a required dimension by `EnvBinding`
 * and `SecretBinding`.
 *
 * Grammar: `[a-z][a-z0-9-]{0,62}` — RFC-1035-like label (lowercase alnum
 * + hyphen, 1–63 chars, starts with a letter). Cross-provider portable
 * (Vault path chars, GCP secret names, AWS ARN paths, k8s namespaces).
 * Use `makeEnvName` for validated construction; unchecked casts are
 * a policy violation for any code path that receives external input.
 */
export type EnvName = Brand<string, 'EnvName'>;

const ENV_NAME_GRAMMAR = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Validated `EnvName` factory. Returns `null` on any grammar violation
 * (uppercase, underscore, dot, slash, non-ASCII, empty, >63 chars).
 */
export function makeEnvName(raw: string): EnvName | null {
  if (typeof raw !== 'string') return null;
  if (!ENV_NAME_GRAMMAR.test(raw)) return null;
  return raw as EnvName;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Operation registry — the single source of truth for the OpenAPI
 * document. Every route mounted on the Hono app has exactly one entry
 * here; the drift test in `tests/openapi.test.ts` fails if that
 * guardrail breaks.
 *
 * Fields:
 * - `honoPath`  — the path segment as registered via `r.get(path, ...)` in
 *                 the corresponding router. `:id` style.
 * - `openapiPath` — OpenAPI 3.1 templated path (`{id}` style). Derived
 *                 automatically by the drift test if you leave it out —
 *                 but authored explicitly here so the emitted JSON is
 *                 easy to scan.
 * - `security`  — `'bearer'` (default) or `'public'`. Public routes are
 *                 mounted outside the `/v1/*` auth chain.
 *
 * All request/response schemas are `$ref`s into
 * `components.schemas` (populated from `schemas.ts`).
 */

import { type JsonSchema, ref } from './schemas.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';

export interface ParameterSpec {
  readonly name: string;
  readonly in: 'query' | 'header' | 'path';
  readonly required?: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
  /**
   * A segment path, one `key:value` per repeated value, coarse to fine.
   * Emitted as `x-kindgi-segment-path: true`; a generated client takes
   * `{key, value}` steps and writes the values itself.
   */
  readonly segmentPath?: boolean;
}

export interface ResponseSpec {
  readonly description: string;
  /** JSON body schema for `application/json` responses. Omit for streaming responses. */
  readonly schema?: JsonSchema;
  /** Content-type of the response body. Defaults to `application/json`. */
  readonly contentType?: string;
}

export interface OperationSpec {
  readonly method: HttpMethod;
  readonly honoPath: string;
  readonly openapiPath: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  /**
   * `bearer`: an API token. `bearer-or-public-run`: an API token, or a
   * public run token (`kgi_pt_…`) naming the run, which gets the public
   * view. `public`: no authentication.
   */
  readonly security: 'bearer' | 'bearer-or-public-run' | 'public';
  readonly parameters?: readonly ParameterSpec[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly description?: string;
    readonly schema: JsonSchema;
    /**
     * Wire content type. Defaults to `application/json`. Set to
     * `multipart/form-data` (or a comma-separated list) for uploads
     * — the schema then describes the form parts, and OpenAPI will
     * emit the appropriate `content.<type>` slot.
     */
    readonly contentType?: string;
    /** Optional `encoding` map for multipart form parts. */
    readonly encoding?: Readonly<Record<string, Record<string, unknown>>>;
  };
  readonly responses: Readonly<Record<string, ResponseSpec>>;
  /**
   * Why the runtime doesn't serve this operation yet. Set, it stays
   * registered (its route mounts where a runtime supplies what it needs,
   * and the drift tests see it), but the public document leaves it out,
   * with the schemas only it uses, so no client offers it.
   */
  readonly unserved?: string;
  /**
   * Why no client offers this operation: it's the path an outside sender
   * calls (the inbound webhook receiver, signed with the trigger's
   * secret), not one a Kindgi client does. The document keeps it, marked
   * `x-kindgi-sender-only`, and the client generators skip it.
   */
  readonly senderOnly?: string;
}

// ---------------- shared parameters ----------------

const IdempotencyKeyParam: ParameterSpec = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    "Caller-supplied idempotency key, scoped to the caller: the same key from someone else in the tenant is their own request (from 0.1.5). Retries with the same key return the original response byte-identical (per `docs/API-ROUTE-CONVENTIONS.md` §3.1). A retry sent while the first request still runs is answered `409 idempotency-key-in-flight` with `Retry-After`, on a runtime whose store holds keys (from 0.1.5); retry after it, and you get the first request's answer. An answer that carries a secret (a new API key or public run token, a session token, a generated signing secret) isn't kept: a retry gets `409 idempotency-key-replay-withheld`, with the first request's status and when it succeeded (from 0.1.5). A request whose key store can't be read before it runs is answered `503 idempotency-store-unavailable` with `Retry-After`: nothing ran, so retry with the same key (from 0.3.0).",
  schema: { type: 'string', minLength: 1 },
};

const RunIdPathParam: ParameterSpec = {
  name: 'runId',
  in: 'path',
  required: true,
  description: 'RunId — opaque branded string (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const TokenIdPathParam: ParameterSpec = {
  name: 'tokenId',
  in: 'path',
  required: true,
  description: 'ApiTokenId — opaque branded string (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ServiceAccountIdPathParam: ParameterSpec = {
  name: 'serviceAccountId',
  in: 'path',
  required: true,
  description: 'The service account id.',
  schema: { type: 'string' },
};

const SigningKeyIdPathParam: ParameterSpec = {
  name: 'keyId',
  in: 'path',
  required: true,
  description: 'The signer key id deployment envelopes name.',
  schema: { type: 'string' },
};

const SystemTenantIdPathParam: ParameterSpec = {
  name: 'tenantId',
  in: 'path',
  required: true,
  description: "The tenant's id (a UUID).",
  schema: { type: 'string', format: 'uuid' },
};

const SystemDeploymentIdPathParam: ParameterSpec = {
  name: 'deploymentId',
  in: 'path',
  required: true,
  description: "The deployment's id, as `GET /v1/system/deployments` lists it.",
  schema: { type: 'string', minLength: 1, maxLength: 128 },
};

const CursorQueryParam: ParameterSpec = {
  name: 'cursor',
  in: 'query',
  required: false,
  description:
    'Where the previous page ended: its `nextCursor`, as it came. A runtime that seals cursors takes one only for the same list, filters and caller, within a day; otherwise `400 bad-input`, and the list starts again without it. Absent → first page.',
  schema: { type: 'string' },
};

const ProjectIdPathParam: ParameterSpec = {
  name: 'projectId',
  in: 'path',
  required: true,
  description: 'ProjectId — opaque branded string.',
  schema: { type: 'string' },
};

const TeamIdPathParam: ParameterSpec = {
  name: 'teamId',
  in: 'path',
  required: true,
  description: 'TeamId — opaque branded string.',
  schema: { type: 'string' },
};

const SiteIdPathParam: ParameterSpec = {
  name: 'siteId',
  in: 'path',
  required: true,
  description: 'The site id (a UUID).',
  schema: { type: 'string' },
};

const LimitQueryParam: ParameterSpec = {
  name: 'limit',
  in: 'query',
  required: false,
  description: '1..100. Default 25.',
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
};

const PackEnvSecretsQueryParam: ParameterSpec = {
  name: 'secrets',
  in: 'query',
  required: false,
  description:
    '`values`: give the values of the names set only as a secret too, in `secrets`, each audited before the answer. Only for a key holding `system:pack-env` itself. Left out: such a name is `pack-env-secret-not-yet`, and no secret is read.',
  schema: { type: 'string', enum: ['values'] },
};

const ParentRunIdQueryParam: ParameterSpec = {
  name: 'parentRunId',
  in: 'query',
  required: false,
  description: 'Only the child runs of this run.',
  schema: { type: 'string', format: 'uuid' },
};

const TopLevelQueryParam: ParameterSpec = {
  name: 'topLevel',
  in: 'query',
  required: false,
  description: 'When true, only runs that are not a child of another run.',
  schema: { type: 'boolean' },
};

const RunAgentIdQueryParam: ParameterSpec = {
  name: 'agentId',
  in: 'query',
  required: false,
  description:
    "Only this agent's turns, at any version. Turns that ran before Kindgi 0.1.3 don't name their agent and aren't matched.",
  schema: { type: 'string', minLength: 1 },
};

const RunReplaysQueryParam: ParameterSpec = {
  name: 'replays',
  in: 'query',
  required: false,
  description:
    'Replay runs (a test run re-running a past run). `exclude` (default) leaves them out; `include` lists them with the other runs; `only` lists just them.',
  schema: { type: 'string', enum: ['exclude', 'include', 'only'], default: 'exclude' },
};

const ConversationReplaysQueryParam: ParameterSpec = {
  name: 'replays',
  in: 'query',
  required: false,
  description:
    "Replay conversations (opened by a comparison's replay turn; `metadata.replayOf` names the run it replays). `exclude` (default) leaves them out; `include` lists them with the others; `only` lists just them.",
  schema: { type: 'string', enum: ['exclude', 'include', 'only'], default: 'exclude' },
};

const RunTestRunIdQueryParam: ParameterSpec = {
  name: 'testRunId',
  in: 'query',
  required: false,
  description:
    'Only the replay runs of this test run. Implies replays are included; cannot be combined with `replays=exclude`.',
  schema: { type: 'string', minLength: 1 },
};

const RunTriggerIdQueryParam: ParameterSpec = {
  name: 'triggerId',
  in: 'query',
  required: false,
  description: 'Only the runs this trigger started (`Run.trigger.triggerId`).',
  schema: { type: 'string', format: 'uuid' },
};

const RunStatusQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description:
    'Only runs in these statuses: one, or several, repeated (`status=failed&status=cancelled`) or comma-separated (`status=failed,cancelled`).',
  schema: { type: 'array', items: { $ref: '#/components/schemas/RunStatus' } },
};

const RunCreatedAfterQueryParam: ParameterSpec = {
  name: 'createdAfter',
  in: 'query',
  required: false,
  description: 'Only runs created strictly after this time.',
  schema: { type: 'string', format: 'date-time' },
};

const RunCreatedBeforeQueryParam: ParameterSpec = {
  name: 'createdBefore',
  in: 'query',
  required: false,
  description: 'Only runs created strictly before this time.',
  schema: { type: 'string', format: 'date-time' },
};

const RunAgentVersionQueryParam: ParameterSpec = {
  name: 'agentVersion',
  in: 'query',
  required: false,
  description:
    'With `agentId`: only the turns that ran this version. Turns from before versions were recorded never match.',
  schema: { type: 'string', minLength: 1 },
};

const RunFlowIdQueryParam: ParameterSpec = {
  name: 'flowId',
  in: 'query',
  required: false,
  description:
    "Only runs of this flow. An agent's turns run `agent.turn`; use `agentId` for an agent's.",
  schema: { type: 'string', minLength: 1 },
};

const RunFlowVersionQueryParam: ParameterSpec = {
  name: 'flowVersion',
  in: 'query',
  required: false,
  description: 'With `flowId`: only runs of this version.',
  schema: { type: 'string', minLength: 1 },
};

const ItemProjectQueryParam: ParameterSpec = {
  name: 'projectId',
  in: 'query',
  required: false,
  description:
    "The newest active version that can run in this project, a project the caller reads; `404` when there's none, or when the caller doesn't read the project. An item with one project answers its latest version for its own project and `404` for any other; one that names no project (under `kindgi dev`, a pack's agents, flows and tools) answers it for any. With authorization off, the caller reads every project. An older runtime ignores it and answers the latest version.",
  schema: { type: 'string', format: 'uuid' },
};

/** What a single read of an order's item answers (`GET /v1/agents/{agentId}` and its twins). */
const NEWEST_VISIBLE_DESCRIPTION =
  'An item more than one project serves (an environment order carries it to later environments) answers its newest active version that can run in a project the caller reads, and `404` when there is none. `projectId` narrows that to one project. An item with one project answers its latest active version.';

const AgentPinProjectQueryParam: ParameterSpec = {
  name: 'projectId',
  in: 'query',
  required: false,
  description: "The run's project; omit → only the agent's tenant-wide pin applies.",
  schema: { type: 'string', format: 'uuid' },
};

const SegmentQueryParam: ParameterSpec = {
  name: 'segment',
  in: 'query',
  required: false,
  description: 'One step of the segment path, `key:value`; repeat it in order, coarse to fine.',
  schema: { type: 'array', items: { type: 'string' } },
  segmentPath: true,
};

const PinScopeKindQueryParam: ParameterSpec = {
  name: 'scopeKind',
  in: 'query',
  required: false,
  description:
    'Only one scope: `tenant`, `org` or `project` (with `scopeId`), or `segment` (with `scopeId` and `segment`).',
  schema: { type: 'string', enum: ['tenant', 'org', 'project', 'segment'] },
};

const PinChangeIdPathParam: ParameterSpec = {
  name: 'changeId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const RunIncludeQueryParam: ParameterSpec = {
  name: 'include',
  in: 'query',
  required: false,
  description: "Comma-separated extras per run. `output` adds each run's output.",
  schema: { type: 'string', enum: ['output'] },
};

const IncludeTombstonedQueryParam: ParameterSpec = {
  name: 'includeTombstoned',
  in: 'query',
  required: false,
  description:
    'When `true`, the response includes soft-tombstoned versions in addition to active ones. Tombstoned rows carry an `unregisteredAt` ISO timestamp; active rows omit the field. Default: `false` (active-only).',
  schema: { type: 'boolean', default: false },
};

const JournalSinceQueryParam: ParameterSpec = {
  name: 'since',
  in: 'query',
  required: false,
  description: 'Only return journal entries with `sequence > since`.',
  schema: { type: 'integer', minimum: 0 },
};

/** `GET /v1/runs/{runId}/journal`'s: paging is opt-in, so there's no default. */
const JournalLimitQueryParam: ParameterSpec = {
  name: 'limit',
  in: 'query',
  required: false,
  description:
    'The most entries in a page, 1..100: then `nextCursor` while more remain. Without it, the whole journal (after `since` or `cursor`) in one answer.',
  schema: { type: 'integer', minimum: 1, maximum: 100 },
};

const LastEventIdParam: ParameterSpec = {
  name: 'Last-Event-Id',
  in: 'header',
  required: false,
  description:
    'Resume marker (`<runId>:<sequence>`). Server replays events with `sequence > lastSeen` before entering live-poll.',
  schema: { type: 'string' },
};

const GatePolicyIdPathParam: ParameterSpec = {
  name: 'policyId',
  in: 'path',
  required: true,
  description: 'The gate policy id.',
  schema: { type: 'string' },
};

const GatePolicyVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'A semver version of the gate policy.',
  schema: { type: 'string' },
};

const AgentIdPathParam: ParameterSpec = {
  name: 'agentId',
  in: 'path',
  required: true,
  description: 'AgentId — dotted namespace (`acme.drafting`).',
  schema: { type: 'string' },
};

const FlowIdPathParam: ParameterSpec = {
  name: 'flowId',
  in: 'path',
  required: true,
  description: 'FlowId — dotted namespace (`acme.ingest-invoice`).',
  schema: { type: 'string' },
};

const FlowVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'Semver of the flow version.',
  schema: { type: 'string' },
};

const FlowNameFilterQueryParam: ParameterSpec = {
  name: 'name',
  in: 'query',
  required: false,
  description: 'Prefix match on flow id.',
  schema: { type: 'string' },
};

const IncludeRetiredQueryParam: ParameterSpec = {
  name: 'includeRetired',
  in: 'query',
  required: false,
  description:
    "When `true`, retired items (every version unregistered) are listed too, each as its highest version with that version's `unregisteredAt`. Default: `false` (items with an active version only).",
  schema: { type: 'boolean', default: false },
};

const AgentVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'Semver of the agent version.',
  schema: { type: 'string' },
};

const AgentNameFilterQueryParam: ParameterSpec = {
  name: 'name',
  in: 'query',
  required: false,
  description: 'Prefix match on agent id.',
  schema: { type: 'string' },
};

const ToolIdPathParam: ParameterSpec = {
  name: 'toolId',
  in: 'path',
  required: true,
  description: 'ToolId — dotted namespace (`acme.lookup-order`).',
  schema: { type: 'string' },
};

const ToolVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'Exact semver of the tool version.',
  schema: { type: 'string' },
};

const GuardrailIdPathParam: ParameterSpec = {
  name: 'guardrailId',
  in: 'path',
  required: true,
  description: 'GuardrailId — unique identifier for the guardrail.',
  schema: { type: 'string' },
};

const NameFilterQueryParam: ParameterSpec = {
  name: 'name',
  in: 'query',
  required: false,
  description: 'Prefix match on the resource id.',
  schema: { type: 'string' },
};

const ApprovalIdPathParam: ParameterSpec = {
  name: 'approvalId',
  in: 'path',
  required: true,
  description: 'ApprovalId — opaque branded string (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ApprovalStatusQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description:
    'Only approvals in these statuses: one, or several, repeated (`status=pending&status=escalated`) or comma-separated (`status=pending,assigned,in_review`).',
  schema: { type: 'array', items: { $ref: '#/components/schemas/ApprovalStatus' } },
};

const ApprovalAssignedToQueryParam: ParameterSpec = {
  name: 'assignedTo',
  in: 'query',
  required: false,
  description:
    "`me`: only the approvals assigned to the caller's own reviewer row (none when the caller has no row).",
  schema: { type: 'string', enum: ['me'] },
};

const ApprovalDecidedByQueryParam: ParameterSpec = {
  name: 'decidedBy',
  in: 'query',
  required: false,
  description:
    "`me`: only the approvals the caller's own reviewer row decided (none when the caller has no row).",
  schema: { type: 'string', enum: ['me'] },
};

const ConversationOpenedByQueryParam: ParameterSpec = {
  name: 'openedBy',
  in: 'query',
  required: false,
  description:
    "`me`: only the conversations the caller opened (none for a caller with no principal). Conversations an older runtime opened record no opener and aren't listed by it.",
  schema: { type: 'string', enum: ['me'] },
};

const ApprovalOrderQueryParam: ParameterSpec = {
  name: 'order',
  in: 'query',
  required: false,
  description:
    "`desc` (newest first, the default) or `asc` (oldest first). A page's `nextCursor` continues its own order; the page says which order it's in (`order`).",
  schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
};

const ReviewerIdPathParam: ParameterSpec = {
  name: 'reviewerId',
  in: 'path',
  required: true,
  description: 'ReviewerId — opaque branded string (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ReviewerRoleQueryParam: ParameterSpec = {
  name: 'role',
  in: 'query',
  required: false,
  description: 'Filter reviewers by role class.',
  schema: { $ref: '#/components/schemas/ReviewerRole' },
};

const ApprovalRequiredRoleQueryParam: ParameterSpec = {
  name: 'requiredRole',
  in: 'query',
  required: false,
  description: 'Filter by required reviewer role. Caller must have a rank ≥ the value — else 403.',
  schema: { $ref: '#/components/schemas/ReviewerRole' },
};

const WaitTokenIdQueryParam: ParameterSpec = {
  name: 'waitTokenId',
  in: 'query',
  required: false,
  description:
    "Only approvals linked to one of these run waits (an approval's `waitTokenId`; a run's journal names its open waits in `wait.suspended` entries). Repeat it for several, at most 50.",
  schema: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50 },
};

const CreatedAfterQueryParam: ParameterSpec = {
  name: 'createdAfter',
  in: 'query',
  required: false,
  description: 'ISO 8601 timestamp; return approvals created strictly after this.',
  schema: { type: 'string', format: 'date-time' },
};

const ObservationStatusQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Filter by observation status.',
  schema: { $ref: '#/components/schemas/ObservationStatus' },
};

const AgentIdQueryParam: ParameterSpec = {
  name: 'agentId',
  in: 'query',
  required: false,
  schema: { type: 'string' },
};

const ConversationIdPathParam: ParameterSpec = {
  name: 'conversationId',
  in: 'path',
  required: true,
  description: 'ConversationId — opaque branded string (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ConversationStatusQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Filter by conversation lifecycle status.',
  schema: { $ref: '#/components/schemas/ConversationStatus' },
};

const SupervisorIdQueryParam: ParameterSpec = {
  name: 'supervisorId',
  in: 'query',
  required: false,
  schema: { type: 'string' },
};

const ObservationAgentVersionQueryParam: ParameterSpec = {
  name: 'agentVersion',
  in: 'query',
  required: false,
  description: 'Only the observations of this agent version (with `agentId`).',
  schema: { type: 'string' },
};

const ObservationConversationIdQueryParam: ParameterSpec = {
  name: 'conversationId',
  in: 'query',
  required: false,
  description: 'Only the observations of turns in this conversation.',
  schema: { type: 'string' },
};

const LicenseUsageSinceQueryParam: ParameterSpec = {
  name: 'since',
  in: 'query',
  required: true,
  description:
    "The period's start (ISO 8601, with a zone): `kindgi license renew` sends when the current key was issued. Up to five minutes ahead of the runtime's clock is taken as now, since clocks differ; further ahead is refused.",
  schema: { type: 'string', format: 'date-time' },
};

const ObservationSinceQueryParam: ParameterSpec = {
  name: 'since',
  in: 'query',
  required: false,
  description: 'Only the observations at or after this time (ISO 8601).',
  schema: { type: 'string', format: 'date-time' },
};

const ObservationUntilQueryParam: ParameterSpec = {
  name: 'until',
  in: 'query',
  required: false,
  description: 'Only the observations at or before this time (ISO 8601).',
  schema: { type: 'string', format: 'date-time' },
};

const ErasureIdPathParam: ParameterSpec = {
  name: 'erasureId',
  in: 'path',
  required: true,
  description: 'The erasure (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const FactIdPathParam: ParameterSpec = {
  name: 'factId',
  in: 'path',
  required: true,
  description: 'The fact id (kept across revisions).',
  schema: { type: 'string' },
};

const FactTypeQueryParam: ParameterSpec = {
  name: 'type',
  in: 'query',
  required: false,
  description: 'Filter by fact type (exact match).',
  schema: { type: 'string' },
};

const FactScopeQueryParam: ParameterSpec = {
  name: 'scope',
  in: 'query',
  required: false,
  description:
    'JSON-encoded partial scope object. Every provided key must match. Example: `%7B%22projectId%22%3A%22...%22%7D`.',
  schema: { type: 'string' },
};

const FactAsOfQueryParam: ParameterSpec = {
  name: 'asOf',
  in: 'query',
  required: false,
  description:
    'Read memory as it stood at this time (ISO 8601): the revision that was current then, including one since superseded or deleted.',
  schema: { type: 'string', format: 'date-time' },
};

const FactVersionQueryParam: ParameterSpec = {
  name: 'version',
  in: 'query',
  required: false,
  description: 'A revision number: that revision, current or not.',
  schema: { type: 'integer', minimum: 1 },
};

const FactExpectVersionQueryParam: ParameterSpec = {
  name: 'expectVersion',
  in: 'query',
  required: false,
  description:
    'Only if the current revision is still this one; otherwise `409 fact-changed` with `currentVersion`.',
  schema: { type: 'integer', minimum: 1 },
};

// ---------------- scope triplet ----------------
//
// Shared parameters for the `?scopeKind + ?scopeId + ?inherit` filter.
// Design decision: the wire encoding is a discriminated triplet
// (human-readable; curl / browser / access-log auditable). Every
// scope-aware list endpoint (and the cost aggregate) carries these three
// params so SDK and curl callers see one uniform shape.

const ScopeKindQueryParam: ParameterSpec = {
  name: 'scopeKind',
  in: 'query',
  required: false,
  description: 'Optional scope discriminator. If absent, no scope filter is applied.',
  schema: { $ref: '#/components/schemas/ScopeKind' },
};

const ScopeIdQueryParam: ParameterSpec = {
  name: 'scopeId',
  in: 'query',
  required: false,
  description:
    'Required IF scopeKind is `org` or `project`. MUST be absent if scopeKind=`tenant` (tenant is implicit from the session). Malformed combinations return 400 scope-invalid.',
  schema: { type: 'string', minLength: 1 },
};

const InheritQueryParam: ParameterSpec = {
  name: 'inherit',
  in: 'query',
  required: false,
  description:
    'Default `true`. `false` = literal-at-this-scope only (admin/audit view). Load-bearing for policy/config-scoped resources (mcp-endpoints); documented no-op for content-scoped resources (agents/flows/tools/...).',
  schema: { type: 'boolean', default: true },
};

const ImproveRunIdPathParam: ParameterSpec = {
  name: 'improveRunId',
  in: 'path',
  required: true,
  description: 'The Improve run id (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const SuggestedChangeIdPathParam: ParameterSpec = {
  name: 'suggestedChangeId',
  in: 'path',
  required: true,
  description: 'The suggested change id (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ProvenanceRunIdQueryParam: ParameterSpec = {
  name: 'runId',
  in: 'query',
  required: false,
  description: 'Filter records to this run id (exact match).',
  schema: { type: 'string', format: 'uuid' },
};

const ProvenanceAgentIdQueryParam: ParameterSpec = {
  name: 'agentId',
  in: 'query',
  required: false,
  description:
    "Only the records of this agent's turns, at any version: the agent the record's run names, as `GET /v1/runs?agentId=` matches it. Turns that ran before Kindgi 0.1.3 don't name their agent and aren't matched.",
  schema: { type: 'string' },
};

const ProvenanceFlowIdQueryParam: ParameterSpec = {
  name: 'flowId',
  in: 'query',
  required: false,
  description:
    "Only the records of this flow's runs, at any version (`flowRef.id`, exact match). An agent's turns aren't matched: use `agentId` for those.",
  schema: { type: 'string', minLength: 1 },
};

const ProvenanceCreatedAfterQueryParam: ParameterSpec = {
  name: 'createdAfter',
  in: 'query',
  required: false,
  description: 'ISO 8601 timestamp; return records created strictly after this.',
  schema: { type: 'string', format: 'date-time' },
};

const SuggestedChangeStatusQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Only suggested changes with this (derived) status.',
  schema: { $ref: '#/components/schemas/SuggestedChangeStatus' },
};

const SuggestedChangeTierQueryParam: ParameterSpec = {
  name: 'tier',
  in: 'query',
  required: false,
  description: 'Only suggested changes of this tier.',
  schema: { $ref: '#/components/schemas/SuggestedChangeTier' },
};

// Admin plane — capabilities + providers.

const CapabilityIdPathParam: ParameterSpec = {
  name: 'capabilityId',
  in: 'path',
  required: true,
  description: 'CapabilityId — opaque string identifier (e.g. `feature:<feature>`).',
  schema: { type: 'string' },
};

// Admin plane — cost readback.

const CostRecordIdPathParam: ParameterSpec = {
  name: 'recordId',
  in: 'path',
  required: true,
  description: 'CostRecordId — opaque string identifier chosen by the binding.',
  schema: { type: 'string' },
};

const CostRunIdQueryParam: ParameterSpec = {
  name: 'runId',
  in: 'query',
  required: false,
  description: 'Filter records to this run id (exact match).',
  schema: { type: 'string', format: 'uuid' },
};

const CostAgentIdQueryParam: ParameterSpec = {
  name: 'agentId',
  in: 'query',
  required: false,
  description: 'Filter records to this agent id (exact match).',
  schema: { type: 'string' },
};

const CostConversationIdQueryParam: ParameterSpec = {
  name: 'conversationId',
  in: 'query',
  required: false,
  description: 'Filter records to this conversation id (exact match).',
  schema: { type: 'string', format: 'uuid' },
};

const CostCategoryQueryParam: ParameterSpec = {
  name: 'category',
  in: 'query',
  required: false,
  description:
    'Filter to a specific category (`llm.inference`, `tool.invocation`, `storage.write`, `sandbox.exec`, …). Exact match.',
  schema: { type: 'string' },
};

const CostProviderIdQueryParam: ParameterSpec = {
  name: 'providerId',
  in: 'query',
  required: false,
  description: 'Filter records to this provider id (exact match).',
  schema: { type: 'string' },
};

const CostFromQueryParam: ParameterSpec = {
  name: 'from',
  in: 'query',
  required: false,
  description:
    'ISO 8601 timestamp; records with `occurredAt >= from`. Required on `/v1/cost/aggregate` (or both endpoints omitted for default last-30-days window).',
  schema: { type: 'string', format: 'date-time' },
};

const CostToQueryParam: ParameterSpec = {
  name: 'to',
  in: 'query',
  required: false,
  description:
    'ISO 8601 timestamp; records with `occurredAt < to` (exclusive). Required on `/v1/cost/aggregate` (or both endpoints omitted for default last-30-days window).',
  schema: { type: 'string', format: 'date-time' },
};

const CostGroupByQueryParam: ParameterSpec = {
  name: 'groupBy',
  in: 'query',
  required: true,
  description:
    "Comma-separated list of dimensions to aggregate over. Each value must be one of `agentId | runId | category | providerId | day | month | tenant | conversationId | model | servedModel | projectId | orgId | rootRunId | flowId`. `model` is the model actually called; `servedModel` the exact version the vendor reported; `orgId` the org of the record's project. Duplicates collapse.",
  schema: { type: 'string' },
};

const CostAggregateLimitQueryParam: ParameterSpec = {
  name: 'limit',
  in: 'query',
  required: false,
  description:
    'The most groups to return: the most expensive ones (`groups` is ordered by `totalUsd`, highest first). 1 to 10000, default 1000. When there were more, `truncated` is `true` and `totalGroups` says how many; the totals still cover every record.',
  schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 },
};

const CostModelQueryParam: ParameterSpec = {
  name: 'model',
  in: 'query',
  required: false,
  description: 'Filter model calls to this model, the one actually called (exact match).',
  schema: { type: 'string' },
};

const CostServedModelQueryParam: ParameterSpec = {
  name: 'servedModel',
  in: 'query',
  required: false,
  description: 'Filter model calls to the exact model version the vendor reported (exact match).',
  schema: { type: 'string' },
};

const CostRootRunIdQueryParam: ParameterSpec = {
  name: 'rootRunId',
  in: 'query',
  required: false,
  description:
    'Every record of the run tree whose root is this run: a flow run and the agent turns and sub-flows it started.',
  schema: { type: 'string', format: 'uuid' },
};

const CostFlowIdQueryParam: ParameterSpec = {
  name: 'flowId',
  in: 'query',
  required: false,
  description:
    "Every record of the run trees whose root is a run of this flow (the record's `flowId`, exact match): the flow's spend across its runs, any version.",
  schema: { type: 'string' },
};

const CostIncludeDescendantsQueryParam: ParameterSpec = {
  name: 'includeDescendants',
  in: 'query',
  required: false,
  description:
    "With `runId`: the run's records and those of every run it started, at any depth. `true` or `false` (default).",
  schema: { type: 'boolean', default: false },
};

const CostIncludeQueryParam: ParameterSpec = {
  name: 'include',
  in: 'query',
  required: false,
  description:
    "Extra fields, comma-separated. `rawUsage`: each model call's usage object exactly as the vendor reported it.",
  schema: { type: 'string', enum: ['rawUsage'] },
};

const ProviderIdPathParam: ParameterSpec = {
  name: 'providerId',
  in: 'path',
  required: true,
  description: 'ProviderId — opaque string identifier chosen by the deployment.',
  schema: { type: 'string' },
};

const FeatureFilterQueryParam: ParameterSpec = {
  name: 'feature',
  in: 'query',
  required: false,
  description:
    'For `/v1/capabilities`: prefix match on `feature`. For `/v1/providers`: exact match against `metadata.features[]`.',
  schema: { type: 'string' },
};

// Interop plane — MCP endpoint registry.

const MCPEndpointIdPathParam: ParameterSpec = {
  name: 'endpointId',
  in: 'path',
  required: true,
  description: 'MCPEndpointId — deployment-stable string identifier chosen by the caller.',
  schema: { type: 'string', minLength: 1 },
};

const MCPTransportFilterQueryParam: ParameterSpec = {
  name: 'transport',
  in: 'query',
  required: false,
  description:
    'Filter to endpoints of a single transport variant. Values: `stdio | http-sse | streamable-http`.',
  schema: { $ref: '#/components/schemas/MCPTransport' },
};

const MCPResourceUriPathParam: ParameterSpec = {
  name: 'uri',
  in: 'path',
  required: true,
  description:
    'URL-encoded MCP resource URI (e.g. `file%3A%2F%2F%2Freadme.md`). Decoded server-side before dispatch.',
  schema: { type: 'string', minLength: 1 },
};

const MCPPromptNamePathParam: ParameterSpec = {
  name: 'name',
  in: 'path',
  required: true,
  description: 'Name of the prompt template at the remote endpoint.',
  schema: { type: 'string', minLength: 1 },
};

// Admin plane — adapters.

const AdapterIdPathParam: ParameterSpec = {
  name: 'adapterId',
  in: 'path',
  required: true,
  description: 'AdapterId — stable string chosen by the deployment (e.g. `sandbox-primary`).',
  schema: { type: 'string' },
};

// Trigger surface — shared across schedules / event-triggers / webhooks.

const TriggerIdPathParam: ParameterSpec = {
  name: 'triggerId',
  in: 'path',
  required: true,
  description: 'TriggerId — the trigger id (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const TriggerVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: "The version's number: 1 for the trigger's first, one more for each after.",
  schema: { type: 'integer', minimum: 1 },
};

const WebhookEndpointIdPathParam: ParameterSpec = {
  name: 'endpointId',
  in: 'path',
  required: true,
  description: 'The webhook endpoint id.',
  schema: { type: 'string' },
};

const ConnectionAppIdPathParam: ParameterSpec = {
  name: 'appId',
  in: 'path',
  required: true,
  description: 'The app registration id (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ConnectionIdPathParam: ParameterSpec = {
  name: 'connectionId',
  in: 'path',
  required: true,
  description: 'The connection id (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ConnectRequestIdPathParam: ParameterSpec = {
  name: 'requestId',
  in: 'path',
  required: true,
  description: 'The connect request id (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const WebhookDeliveryIdPathParam: ParameterSpec = {
  name: 'deliveryId',
  in: 'path',
  required: true,
  description: 'The delivery id.',
  schema: { type: 'string' },
};

const WebhookDeliveryStatusQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Only deliveries with this status.',
  schema: { $ref: '#/components/schemas/WebhookDeliveryStatus' },
};

const TriggerStatusFilterQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Filter to triggers at a specific status. Values: `active | paused`.',
  schema: { $ref: '#/components/schemas/TriggerStatus' },
};

const AdapterKindFilterQueryParam: ParameterSpec = {
  name: 'kind',
  in: 'query',
  required: false,
  description:
    'Filter to a specific adapter kind. Values: `model | model-provider | embedding | blob | sandbox | eval-judge`.',
  schema: { $ref: '#/components/schemas/AdapterKind' },
};

const AdapterStatusFilterQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Filter to adapters at a specific status. Values: `active | degraded | error`.',
  schema: { $ref: '#/components/schemas/AdapterStatus' },
};

// Admin plane — policies.

const PolicyIdPathParam: ParameterSpec = {
  name: 'policyId',
  in: 'path',
  required: true,
  description: 'PolicyId — stable string chosen by the caller (e.g. `acme.model-routing`).',
  schema: { type: 'string', minLength: 1 },
};

const PolicyVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'Semver version string of the policy (e.g. `1.2.0`).',
  schema: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
};

const PolicyKindFilterQueryParam: ParameterSpec = {
  name: 'kind',
  in: 'query',
  required: false,
  description:
    'Filter to policies of a single kind. Values: `access-control | model-routing | adapter-allowlist | rate-limit | retention | compliance | tool-errors | hitl`.',
  schema: { $ref: '#/components/schemas/PolicyKind' },
};

const PolicyNameFilterQueryParam: ParameterSpec = {
  name: 'name',
  in: 'query',
  required: false,
  description: 'Prefix match on `Policy.id`. Dotted namespaces are the natural filter shape.',
  schema: { type: 'string' },
};

// Admin plane — retention.

const RetentionDomainQueryParam: ParameterSpec = {
  name: 'domain',
  in: 'query',
  required: false,
  description: 'Only this domain. Absent: every domain.',
  schema: { $ref: '#/components/schemas/RetentionDomain' },
};

const RetentionPastGraceOnlyQueryParam: ParameterSpec = {
  name: 'pastGraceOnly',
  in: 'query',
  required: false,
  description: '`true`: only rows past their grace, the ones a sweep would purge now.',
  schema: { type: 'boolean', default: false },
};

const RetentionDomainPathParam: ParameterSpec = {
  name: 'domain',
  in: 'path',
  required: true,
  description: 'The domain to sweep (not `*`).',
  schema: { $ref: '#/components/schemas/RetentionDomain' },
};

// Admin plane — test sets.

const TestSetIdPathParam: ParameterSpec = {
  name: 'testSetId',
  in: 'path',
  required: true,
  description: 'TestSetId — stable string chosen by the caller (e.g. `acme.drafting-accuracy`).',
  schema: { type: 'string', minLength: 1 },
};

const TestSetVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'Semver version string of the test set (e.g. `1.2.0`).',
  schema: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
};

const TestSetKindFilterQueryParam: ParameterSpec = {
  name: 'kind',
  in: 'query',
  required: false,
  description:
    'Filter to test sets of a single kind. Values: `accuracy | pairwise | regression | human-review | benchmark | custom | corrections`.',
  schema: { $ref: '#/components/schemas/EvalKind' },
};

const TestSetNameFilterQueryParam: ParameterSpec = {
  name: 'name',
  in: 'query',
  required: false,
  description: 'Prefix match on `TestSet.id`. Dotted namespaces are the natural filter shape.',
  schema: { type: 'string' },
};

const BlockIdPathParam: ParameterSpec = {
  name: 'blockId',
  in: 'path',
  required: true,
  description: 'Block id: dotted lowercase (e.g. `acme.intake-prompt`).',
  schema: { type: 'string', minLength: 1 },
};

const BlockVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'Exact block version (`major.minor.patch`).',
  schema: { type: 'string', minLength: 1 },
};

const BlockKindFilterQueryParam: ParameterSpec = {
  name: 'kind',
  in: 'query',
  required: false,
  description: 'Only blocks of this kind: `prompt` or `settings`.',
  schema: { $ref: '#/components/schemas/BlockKind' },
};

const BlockNameFilterQueryParam: ParameterSpec = {
  name: 'name',
  in: 'query',
  required: false,
  description: 'Prefix match on the block id.',
  schema: { type: 'string' },
};

// Admin plane — test-run data plane.

const TestRunIdPathParam: ParameterSpec = {
  name: 'testRunId',
  in: 'path',
  required: true,
  description: 'TestRunId — opaque branded UUID.',
  schema: { type: 'string', format: 'uuid' },
};

const TestRunTestSetIdFilterQueryParam: ParameterSpec = {
  name: 'testSetId',
  in: 'query',
  required: false,
  description: 'Filter to runs against the test set with this id.',
  schema: { type: 'string' },
};

const TestRunStatusFilterQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Filter to a single TestRunStatus.',
  schema: { $ref: '#/components/schemas/TestRunStatus' },
};

const TestRunAgentIdFilterQueryParam: ParameterSpec = {
  name: 'agentId',
  in: 'query',
  required: false,
  description: 'Filter to runs targeting a specific agent id.',
  schema: { type: 'string' },
};

const TestRunFlowIdFilterQueryParam: ParameterSpec = {
  name: 'flowId',
  in: 'query',
  required: false,
  description: 'Filter to runs targeting a specific flow id.',
  schema: { type: 'string' },
};

const TestRunFromFilterQueryParam: ParameterSpec = {
  name: 'from',
  in: 'query',
  required: false,
  description: 'ISO-8601 lower bound on `startedAt` (inclusive).',
  schema: { type: 'string', format: 'date-time' },
};

const TestRunToFilterQueryParam: ParameterSpec = {
  name: 'to',
  in: 'query',
  required: false,
  description: 'ISO-8601 upper bound on `startedAt` (inclusive).',
  schema: { type: 'string', format: 'date-time' },
};

// ------- Env + Secrets -------

const EnvNameQueryParam: ParameterSpec = {
  name: 'envName',
  in: 'query',
  required: true,
  description: '`[a-z][a-z0-9-]{0,62}`. Required on every env + secrets route.',
  schema: { $ref: '#/components/schemas/EnvName' },
};

const ScopeKindRequiredQueryParam: ParameterSpec = {
  name: 'scopeKind',
  in: 'query',
  required: true,
  description:
    'Required on every env + secrets route. Tenant carries no `scopeId`; org / project require `scopeId`.',
  schema: { $ref: '#/components/schemas/ScopeKind' },
};

// `POST /v1/secrets/:name/rotate` takes `envName` and the scope from the
// body or from these query parameters.
const RotateEnvNameQueryParam: ParameterSpec = {
  name: 'envName',
  in: 'query',
  required: false,
  description:
    'Alternative to body `envName`. When both are present they must match (400 `env-name-mismatch`).',
  schema: { $ref: '#/components/schemas/EnvName' },
};

const RotateScopeKindQueryParam: ParameterSpec = {
  name: 'scopeKind',
  in: 'query',
  required: false,
  description:
    'Alternative to body `scope` (with `scopeId`). When both are present they must name the same scope (400 `scope-mismatch`).',
  schema: { $ref: '#/components/schemas/ScopeKind' },
};

const NamePrefixQueryParam: ParameterSpec = {
  name: 'namePrefix',
  in: 'query',
  required: false,
  description: 'Prefix match on entry name.',
  schema: { type: 'string' },
};

const EnvEntryNamePathParam: ParameterSpec = {
  name: 'name',
  in: 'path',
  required: true,
  description: 'Env entry name (opaque string within the tenant + envName).',
  schema: { type: 'string', minLength: 1 },
};

const SecretNamePathParam: ParameterSpec = {
  name: 'name',
  in: 'path',
  required: true,
  description: 'Secret name (opaque string within the tenant + envName).',
  schema: { type: 'string', minLength: 1 },
};

// ---------------- corrections + corrector groups: parameters ----------------

const CorrectionIdPathParam: ParameterSpec = {
  name: 'correctionId',
  in: 'path',
  required: true,
  description: 'Correction id.',
  schema: { type: 'string', minLength: 1 },
};

const CorrectorGroupIdPathParam: ParameterSpec = {
  name: 'correctorGroupId',
  in: 'path',
  required: true,
  description: 'Corrector group id.',
  schema: { type: 'string', minLength: 1 },
};

const correctionQuery = (name: string, description: string, schema: JsonSchema): ParameterSpec => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
});

const CorrectionListQueryParams: readonly ParameterSpec[] = [
  correctionQuery('runId', 'Only corrections of this run.', { type: 'string', minLength: 1 }),
  correctionQuery('agentId', 'Only corrections of runs of this agent.', {
    type: 'string',
    minLength: 1,
  }),
  correctionQuery(
    'agentVersion',
    'Only corrections of runs of this agent version. Needs `agentId`.',
    {
      type: 'string',
      minLength: 1,
    },
  ),
  correctionQuery('flowId', 'Only corrections of runs of this flow.', {
    type: 'string',
    minLength: 1,
  }),
  correctionQuery('verdict', 'Only corrections with this verdict.', {
    type: 'string',
    enum: ['yes', 'no'],
  }),
  correctionQuery('correctorGroupId', 'Only corrections recorded under this corrector group.', {
    type: 'string',
    minLength: 1,
  }),
  correctionQuery('participantId', "Only corrections made for this app end user's opaque id.", {
    type: 'string',
    minLength: 1,
  }),
];

const CorrectorGroupScopeKindQueryParam: ParameterSpec = correctionQuery(
  'scopeKind',
  'Only groups of this scope kind. `project` and `agent` need `projectId`; `agent` also needs `agentId`.',
  { type: 'string', enum: ['tenant', 'project', 'agent'] },
);

const ScheduleProjectIdQueryParam: ParameterSpec = {
  name: 'projectId',
  in: 'query',
  required: false,
  description:
    "Only this project's schedules. A runtime before Kindgi 0.1.6 ignores it and lists every project's.",
  schema: { type: 'string', format: 'uuid' },
};

const CorrectorGroupProjectIdQueryParam: ParameterSpec = correctionQuery(
  'projectId',
  'Project of the scope, for `scopeKind=project|agent`.',
  { type: 'string', minLength: 1 },
);

const CorrectorGroupAgentIdQueryParam: ParameterSpec = correctionQuery(
  'agentId',
  'Agent of the scope, for `scopeKind=agent`.',
  { type: 'string', minLength: 1 },
);

// ---------------- shared responses ----------------

const ErrorResponse = (description: string): ResponseSpec => ({
  description,
  schema: ref('WireError'),
});

/**
 * A request that publishes schemas, refused by its tenant's compile
 * budget before it stored anything.
 */
const SCHEMA_COMPILE_BUDGET_TEXT =
  '`rate-limit-exceeded` with `details.limit: "schema-compile-time"`, on a server with a compile budget (Kindgi Cloud): this tenant\'s schemas spent `details.budgetMs` compiling in the last 60 seconds. Nothing was stored; `Retry-After` says when to send it again.';
const SCHEMA_COMPILE_BUDGET = ErrorResponse(SCHEMA_COMPILE_BUDGET_TEXT);

/**
 * A publish through the API into a later environment of an environment
 * order, refused before anything is written; each publish's 409 names it.
 */
const TAKES_PROMOTIONS =
  "Or `environment-takes-promotions`: the project is a later environment of an environment order, which takes builds only by promotion from the one before it; publish in the order's first environment instead (`details.firstProjectId`, when you can read that project; `details.position`, the project's place from 0). Nothing is written.";

const CommonAuthErrors: Readonly<Record<string, ResponseSpec>> = {
  '401': ErrorResponse('Missing / malformed / expired / revoked bearer token.'),
};

const CommonMutationErrors: Readonly<Record<string, ResponseSpec>> = {
  ...CommonAuthErrors,
  '400': ErrorResponse('Malformed request body.'),
  '409': ErrorResponse(
    'Idempotency-Key was reused with a different body, or resource-state conflict.',
  ),
  '500': ErrorResponse('Server error (unmapped domain code or framework crash).'),
};

/** A change a schedule's owner rule refuses (`trigger-owners.ts`). */
const ScheduleChangeRefused: ResponseSpec = ErrorResponse(
  "`permission-denied`: the schedule is personal and the caller is neither its owner nor a project admin (the message names the owner), or it's shared and changing what it runs takes a project admin. A caller without `write` on its project is refused first, and learns nothing of its owner.",
);

/** A change a webhook trigger's owner rule refuses (`trigger-owners.ts`). */
const WebhookChangeRefused: ResponseSpec = ErrorResponse(
  "`permission-denied`: the trigger is personal and the caller is neither its owner nor a project admin (the message names the owner), or it's shared and changing what it runs takes a project admin. A caller without `write` on its project is refused first, and learns nothing of its owner.",
);

/** A read of a tenant-wide setting (`tenantResourceAccess`): a tenant member's; without an authorization store, anyone's. */
const TenantSettingReadErrors: Readonly<Record<string, ResponseSpec>> = {
  '403': ErrorResponse(
    'Not a member of the tenant (`permission-denied`). Without an authorization store, anyone reads it.',
  ),
};

/** Who a tenant admin is on a runtime without an authorization store, ending a 403's text. */
const WITHOUT_STORE_ADMIN =
  "Without an authorization store, a tenant admin is the deployment's API token, an admin key, or a console signed in with either.";

/**
 * A change to a tenant-wide setting (`tenantResourceAccess`), and every
 * call to one only a tenant admin uses (`tenantAdminAccess`: webhook
 * endpoints, compliance): a tenant admin's, with an authorization store or
 * without one.
 */
const TenantAdminErrors: Readonly<Record<string, ResponseSpec>> = {
  '403': ErrorResponse(`Not a tenant admin (\`permission-denied\`). ${WITHOUT_STORE_ADMIN}`),
};

/**
 * A secrets store's external provider (the router's), answering a read or a
 * write: each at its own status. Each operation that spreads it is a write
 * that takes an `Idempotency-Key`, so its 503 names that store's too.
 */
const SecretProviderErrors: Readonly<Record<string, ResponseSpec>> = {
  '429': ErrorResponse(
    "`secret-provider-rate-limited`: the secrets store's external provider is limiting the runtime's requests.",
  ),
  '502': ErrorResponse(
    "`secret-provider-unauthorized`: the secrets store's external provider refused the runtime's credentials.",
  ),
  '503': ErrorResponse(
    "`secret-provider-unavailable`: the secrets store's external provider can't be reached. `idempotency-store-unavailable` (with `Retry-After`): the `Idempotency-Key` store couldn't be read before the request ran, so nothing was changed.",
  ),
};

/** A secret's value written: a body that fails validation, a name or value the store refuses (the caller's), or its provider's answer. */
const SecretWriteErrors: Readonly<Record<string, ResponseSpec>> = {
  '400': ErrorResponse(
    "A body that fails validation (`bad-input`), or a secret the store refuses for its name or its value: `reserved-name-prefix`, `secret-name-invalid` (a new name that isn't 1 to 255 ASCII letters, digits, `.`, `-` and `_` starting with a letter, digit or `_`, with any `.` between two non-`.` characters, or, under `kindgi dev`, isn't capital letters, digits and underscores, starts with a digit, or is `KINDGI_*`; the message says the rule), `secret-value-too-large`, or `secret-value-invalid` (under `kindgi dev`, a value no env-file quoting can hold so that it reads back unchanged; the message says why).",
  ),
  ...SecretProviderErrors,
};

/**
 * `env-not-served` for a value: on a runtime that keeps every value under
 * the env it serves (`refuseOtherEnvs`), one under another env.
 */
const ENV_NOT_SERVED_VALUE =
  "`env-not-served`: this runtime keeps every value under the env it serves (whoami's `servedEnv`, with `refusesOtherEnvs`), so a value under another env would never be read. `details.envName` is the env asked for, `details.servedEnv` the one to use. A secret that a provider, MCP endpoint or webhook endpoint registered before names under that env, at the scope it's read at, is still written: it's read there. Nothing is stored otherwise.";

/** `env-not-served` for a registration that names its secret under another env. */
const ENV_NOT_SERVED_REFERENCE =
  "`env-not-served`: this runtime keeps every value under the env it serves (whoami's `servedEnv`, with `refusesOtherEnvs`), and the secret reference names another. Name it under `details.servedEnv`. Nothing is stored.";

/** The 409 a write answers anyway, and `env-not-served`. */
function conflictOrEnvNotServed(text: string): ResponseSpec {
  return ErrorResponse(
    `Idempotency-Key was reused with a different body, or resource-state conflict. Or ${text}`,
  );
}

/** A change to the tenant's identity providers: not a tenant admin, or the operator manages sign-in. */
const ProviderChangeRefused: ResponseSpec = ErrorResponse(
  `Not a tenant admin (\`permission-denied\`). ${WITHOUT_STORE_ADMIN} Or this deployment's operator manages sign-in (\`identity-providers-operator-managed\`, \`KINDGI_AUTH_TENANT_PROVIDERS=off\`): only the deployment's own token can change its providers.`,
);

/**
 * Reads that never reach the storage backend, so they can't answer
 * `503 database-busy`: the liveness probe (`GET /health`) and the spec
 * document (`GET /v1/openapi.json`). Every other served `GET`/`HEAD`
 * declares the shared 503 — see `buildOperation` in `generate.ts`.
 */
export const READS_WITHOUT_STORAGE: ReadonlySet<string> = new Set([
  'system.health',
  'system.openapi',
]);

/**
 * Whether a served operation can answer `503 database-busy`: a `GET` or
 * `HEAD` that isn't one of the storage-free reads. The spec generator
 * injects the 503 for these (unless the operation declares a 503 of its
 * own), and a test holds every one of them to it, so a new read can't miss
 * it.
 */
export function answersDatabaseBusy(op: OperationSpec): boolean {
  return (
    (op.method === 'get' || op.method === 'head') && !READS_WITHOUT_STORAGE.has(op.operationId)
  );
}

/**
 * Whether a served operation can answer `503 idempotency-store-unavailable`:
 * a write that takes an `Idempotency-Key`, which `idempotencyMiddleware`
 * answers so when the key's store fails before the write runs. The spec
 * generator injects the 503 for these (unless the operation declares a 503
 * of its own, which then names it too), and a test holds every one of them
 * to it.
 */
export function answersIdempotencyStoreUnavailable(op: OperationSpec): boolean {
  return (
    op.method !== 'get' &&
    op.method !== 'head' &&
    (op.parameters ?? []).some((p) => p.in === 'header' && p.name === IdempotencyKeyParam.name)
  );
}

/** Adding or changing a provider: the usual conflicts, or a deployment without a secrets store. */
function providerChangeConflict(text: string): ResponseSpec {
  return ErrorResponse(
    `Idempotency-Key was reused with a different body, or resource-state conflict${text}. Or this deployment has no secrets store (\`identity-providers-need-secrets-store\`, \`KINDGI_SECRETS_BACKEND\`): a provider's client secret and keys are references into one, so no provider is added or changed until it has one.`,
  );
}

// ---------------- operation registry ----------------

function usageQueryParams(groupBy: string): ParameterSpec[] {
  return [
    {
      name: 'from',
      in: 'query',
      required: true,
      description:
        'Records at or after this time: a time with a zone, such as `2026-11-01T00:00:00Z`.',
      schema: { type: 'string', format: 'date-time' },
    },
    {
      name: 'to',
      in: 'query',
      required: true,
      description: 'Records before this time. At most 92 days after `from`.',
      schema: { type: 'string', format: 'date-time' },
    },
    {
      name: 'groupBy',
      in: 'query',
      required: false,
      description: groupBy,
      schema: { type: 'string' },
    },
    {
      name: 'kind',
      in: 'query',
      required: false,
      description:
        'Only these kinds, comma-separated (`run.started`, `run.ended`, `approval.requested`, `approval.decided`, `llm.inference`, `llm.embedding`, `project.production`).',
      schema: { type: 'string' },
    },
    {
      name: 'class',
      in: 'query',
      required: false,
      description:
        'Only these run classes, comma-separated (`production`, `staging`, `dry-run`, `replay`, `eval`, `child`).',
      schema: { type: 'string' },
    },
    {
      name: 'state',
      in: 'query',
      required: false,
      description:
        "Only these states, comma-separated: `on`, `off` (`project.production`); `completed`, `failed`, `cancelled` (`run.ended`); `escalation` (`approval.requested`, an escalation's next tier); `approved`, `rejected`, `withdrawn`, `escalated`, `expired` (`approval.decided`).",
      schema: { type: 'string' },
    },
    {
      name: 'limit',
      in: 'query',
      required: false,
      description: 'Groups a page: 1 to 10000, default 1000.',
      schema: { type: 'integer', minimum: 1, maximum: 10000 },
    },
    {
      name: 'cursor',
      in: 'query',
      required: false,
      description: "The previous page's `nextCursor`.",
      schema: { type: 'string' },
    },
  ];
}

// ---------------- pinned versions (flows, tools) ----------------

const PinProjectQueryParam: ParameterSpec = {
  name: 'projectId',
  in: 'query',
  required: false,
  description:
    "The project to resolve for; omit → only the org's pin (with `orgId`) and the tenant-wide pin apply.",
  schema: { type: 'string', format: 'uuid' },
};

const PinOrgQueryParam: ParameterSpec = {
  name: 'orgId',
  in: 'query',
  required: false,
  description:
    "The project's org, when it has one. A runtime may look it up from `projectId` itself.",
  schema: { type: 'string', format: 'uuid' },
};

/** What the pin operations say about one kind of item. */
interface PinKindSpec {
  /** `flow` or `tool`: the error codes' prefix, and the noun in the text. */
  readonly noun: string;
  readonly tag: string;
  readonly idParam: ParameterSpec;
  /** `/v1/flows/{flowId}` */
  readonly openapiBase: string;
  /** `/v1/flows/:flowId` */
  readonly honoBase: string;
  /** What a pin does, in a sentence. */
  readonly acts: string;
  /** What `…/pinned` answers when no pin covers. */
  readonly latest: string;
  /** The pin write's own 400s and 409s, after the shared ones. */
  readonly pin400: string;
  readonly pin409: string;
}

const FLOW_PINS: PinKindSpec = {
  noun: 'flow',
  tag: 'flows',
  idParam: FlowIdPathParam,
  openapiBase: '/v1/flows/{flowId}',
  honoBase: '/v1/flows/:flowId',
  acts: "A run that names no flow version takes the version pinned for its project (the project's own pin, then its org's, then the tenant's), else the newest version the project reaches. A run that names its version isn't affected, and a run already started keeps its version.",
  latest:
    "else the newest version the project reaches, as a run that names no version takes it. A pin whose version doesn't reach the project is passed over, as a run passes it over.",
  pin400: '',
  pin409: '',
};

const TOOL_PINS: PinKindSpec = {
  noun: 'tool',
  tag: 'tools',
  idParam: ToolIdPathParam,
  openapiBase: '/v1/tools/{toolId}',
  honoBase: '/v1/tools/:toolId',
  acts: "An agent or flow version made in a project the pin covers (the project's own pin, then its org's, then the tenant's) locks the tool at the pinned version: a flow's tool step always, an agent's tool reference when the pinned version is in its range. A version already made keeps its lock; a pin reaches an agent or flow through its next version.",
  latest:
    'else the newest active version, the one a flow version made now would lock its tool step to.',
  pin400:
    " Or `tool-not-pinnable`: the tool follows its server (an MCP endpoint's catalog lists it; its metadata has the catalog's `kindgi.mcp` key) or the runtime (a tool the runtime ships), so a pin couldn't keep it still; reference it with a range.",
  pin409:
    " Or `environment-takes-promotions`: the project is a later environment of an environment order, where no agent or flow version is made, so a pin there would never act; pin the tool in the order's first environment (`details.firstProjectId`).",
};

/** The five pin operations of a flow or a tool (`routes/pinned-versions.ts`). */
function pinnedVersionOperations(kind: PinKindSpec): readonly OperationSpec[] {
  const { noun, tag, idParam } = kind;
  const notFound = `\`${noun}-not-found\`: no ${noun} with that id, or the version isn't registered or was unregistered.`;
  const readOnly =
    " Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.";
  return [
    {
      method: 'get',
      honoPath: `${kind.honoBase}/pinned`,
      openapiPath: `${kind.openapiBase}/pinned`,
      operationId: `${tag}.pinned.resolve`,
      summary: 'The version in use for a project',
      description: `Resolves the version in use for a project (or an org, or the whole tenant): the most specific pin covering it (the project, its org, then the tenant) whose version is still active, ${kind.latest} \`via\` says which; \`pinnedScope\` names the pin that matched.`,
      tags: [tag],
      security: 'bearer',
      parameters: [idParam, PinProjectQueryParam, PinOrgQueryParam],
      responses: {
        '200': { description: 'The version in use.', schema: ref('PinnedVersionResolution') },
        ...CommonAuthErrors,
        '400': ErrorResponse('A malformed project or org id.'),
        '404': ErrorResponse(
          `\`${noun}-not-found\`: no ${noun} with that id, or no version of it for that project.`,
        ),
      },
    },
    {
      method: 'get',
      honoPath: `${kind.honoBase}/pinned-versions`,
      openapiPath: `${kind.openapiBase}/pinned-versions`,
      operationId: `${tag}.pinned.list`,
      summary: `List a ${noun}'s pinned versions`,
      description: 'Every scope with a version pinned, and the change that set it.',
      tags: [tag],
      security: 'bearer',
      parameters: [idParam],
      responses: {
        '200': { description: 'The pins.', schema: ref('PinnedVersionList') },
        ...CommonAuthErrors,
      },
    },
    {
      method: 'post',
      honoPath: `${kind.honoBase}/pinned/pin`,
      openapiPath: `${kind.openapiBase}/pinned/pin`,
      operationId: `${tag}.pinned.pin`,
      summary: 'Pin a version for a scope',
      description: `Pins \`version\` for \`scope\` (the tenant, an org or a project), or moves the scope's pin to it. ${kind.acts} The version must be registered and active. Pinning the version the scope already pins changes nothing and answers the change that set it. Every change is recorded, with who asked and why. Needs \`pin\` on the ${noun}.`,
      tags: [tag],
      security: 'bearer',
      parameters: [idParam, IdempotencyKeyParam],
      requestBody: { required: true, schema: ref('PinVersionBody') },
      responses: {
        '200': { description: 'Pinned.', schema: ref('PinnedVersionChange') },
        ...CommonMutationErrors,
        '400': ErrorResponse(
          `Malformed request body. Or \`scope-invalid\`: a segment scope, since ${noun}s pin per project, org or tenant. Or \`reference-out-of-scope\`: a project scope whose project doesn't reach the ${noun === 'flow' ? 'version' : noun} (\`details.issues\`).${kind.pin400}`,
        ),
        '404': ErrorResponse(notFound),
        '409': ErrorResponse(
          `Idempotency-Key was reused with a different body. Or \`pin-scope-spans-environments\`: the ${noun} has a project in an environment order, and a tenant- or org-wide pin would act in every environment of the order at once; pin it per project instead.${kind.pin409}${readOnly}`,
        ),
        '410': ErrorResponse(`\`${noun}-gone\`: the ${noun} has no active version left.`),
      },
    },
    {
      method: 'post',
      honoPath: `${kind.honoBase}/pinned/unpin`,
      openapiPath: `${kind.openapiBase}/pinned/unpin`,
      operationId: `${tag}.pinned.unpin`,
      summary: "Remove a scope's pin",
      description: `Removes the scope's own pin: the scope then follows the next scope up (its org's pin, then the tenant's), or, with none above, takes what it would if it had never been pinned. Recorded like a pin. Needs \`pin\` on the ${noun}.`,
      tags: [tag],
      security: 'bearer',
      parameters: [idParam, IdempotencyKeyParam],
      requestBody: { required: true, schema: ref('UnpinVersionBody') },
      responses: {
        '200': { description: 'Unpinned.', schema: ref('PinnedVersionChange') },
        ...CommonMutationErrors,
        '400': ErrorResponse(
          `Malformed request body. Or \`scope-invalid\`: a segment scope, since ${noun}s pin per project, org or tenant.`,
        ),
        '404': ErrorResponse(`\`${noun}-not-found\`: no ${noun} with that id.`),
        '409': ErrorResponse(
          `Idempotency-Key was reused with a different body. Or \`not-pinned\`: the scope has no pin of its own.${readOnly}`,
        ),
      },
    },
    {
      method: 'get',
      honoPath: `${kind.honoBase}/pin-history`,
      openapiPath: `${kind.openapiBase}/pin-history`,
      operationId: `${tag}.pinned.history`,
      summary: `List a ${noun}'s pin changes`,
      description:
        'Every pin and unpin of the item, newest first: what each scope pinned before and after, who asked and why.',
      tags: [tag],
      security: 'bearer',
      parameters: [idParam, LimitQueryParam, CursorQueryParam],
      responses: {
        '200': { description: 'Page of pin changes.', schema: ref('PinnedVersionChangePage') },
        ...CommonAuthErrors,
      },
    },
  ];
}

export const OPERATIONS: readonly OperationSpec[] = [
  // ---------- health ----------
  {
    method: 'get',
    honoPath: '/health',
    openapiPath: '/health',
    operationId: 'system.health',
    summary: 'Liveness probe',
    description: 'Public. Returns `{ ok: true }` when the process is reachable.',
    tags: ['system'],
    security: 'public',
    responses: {
      '200': { description: 'Alive.', schema: ref('HealthResult') },
    },
  },

  // ---------- openapi ----------
  {
    method: 'get',
    honoPath: '/v1/openapi.json',
    openapiPath: '/v1/openapi.json',
    operationId: 'system.openapi',
    summary: 'OpenAPI 3.1 spec document',
    description:
      'Public. Returns the machine-readable spec for this deployment. Used by SDK codegen (a snapshot ships in the `@kindgi/api` package as `@kindgi/api/openapi.json`).',
    tags: ['system'],
    security: 'public',
    responses: {
      '200': {
        description: 'OpenAPI 3.1 document.',
        schema: { type: 'object', additionalProperties: true },
      },
    },
  },

  // ---------- runs ----------
  {
    method: 'post',
    honoPath: '/v1/runs',
    openapiPath: '/v1/runs',
    operationId: 'runs.start',
    summary: 'Start a run',
    description:
      'One primitive, discriminated subject (`agent` XOR `flow`). When the deployment issues public run tokens, the response carries `publicAccessToken`: a read-only token for this run (15 minutes by default) to hand to a browser, which follows the run with it on `GET /v1/runs/{runId}/progress` and its stream.',
    tags: ['runs'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('StartRunBody') },
    responses: {
      '201': { description: 'Run finished, failed or suspended.', schema: ref('Run') },
      '202': {
        description: 'Run started (`options.wait: false`); poll `GET /v1/runs/{runId}`.',
        schema: ref('Run'),
      },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        "Agent or flow not found; or `projectId` names no project of this tenant (`project-not-found`); or `input.conversationId` names no conversation of this tenant (`conversation-not-found`), answered before any turn starts, with `options.wait: false` too. A caller who can't read the conversation gets the same answer, byte for byte, in place of the 409 for a turn naming another project, of the 403 for a turn into it they may not add (a conversation with no participant, or `participant-not-allowed` for its stored participant), or of the 409 for a closed conversation they may not add a turn to.",
      ),
      '403': ErrorResponse(
        "No `execute` on the agent or flow; or, for one more than one project serves run in one of its projects (the one named, else the conversation's, else a project-scoped key's when it is one of them, else its first), no `call` there for an agent (`caller` or `editor`) or `execute` there for a flow (`executor` or `editor`), asked in place of its own `execute` and of `write` on a named project; otherwise, naming a `projectId` without `write` on it; or a turn run as a participant whose memory the caller may not read (`participant-not-allowed`; for a conversation's stored participant, only to a caller who can read the conversation). A turn runs with its participant's memory (the conversation's stored participant, else `input.participantId`), so running as one takes being them (a person, by their user id) or `write` on the turn's project, as reading their memory does. A turn into a conversation with no participant takes having opened it (the caller `?openedBy=me` names) or `write` on its project (on its agent, for a conversation from before projects): `permission-denied`, with `details.resource` the conversation, to a caller who can read it.",
      ),
      '422': ErrorResponse('Guardrail violation or budget exceeded.'),
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body; or `projectId` names a project other than `input.conversationId`'s (`conversation-project-mismatch`, with `details.projectId` and `details.conversationProjectId`): a conversation belongs to one project, so name its own or omit `projectId`; or an erasure of the turn's person (its conversation or its `participantId`) is in progress (`erasure-in-progress`): no new turn starts for them until it completes; or the run's project is suspended (`project-suspended`): no run starts in it until it's restored; or `input.conversationId` names a closed conversation (`conversation-closed`, with `details.conversationId`): it takes no new turns, so start a new one. It's answered before a run is made, with `options.wait: false` too, and only once the caller may add the turn: the 404 and 403 rules come first.",
      ),
      '400': ErrorResponse(
        "Malformed request body, or the body's `projectId` isn't a project id (a UUID). Or `reference-out-of-scope`: the agent or flow isn't registered in the named `projectId`'s project, its org or the tenant (`details.issues`).",
      ),
      '429': ErrorResponse(
        "A limit of the tenant's (set by the runtime's operator): past its limit on runs waiting to start, `rate-limit-exceeded` with `details.limit: 'runs-pending'`, with the limit in `details.runsPending`; a turn whose gate asked for an approval past its limit on approvals waiting for a decision, `approvals-pending-limit` (`details.approvalsPending`), when the call waits for the run (with `options.wait: false`, the call answers 202 and the run fails with that code). On a server with budgets kept per tenant (Kindgi Cloud), also `rate-limit-exceeded` when work the agent's turn needed was refused, because this tenant's work of that kind took `details.budgetMs` in the last 60 seconds: `details.limit` names the budget, `template-render-time` (rendering instructions templates) or `schema-compile-time` (compiling schemas). The turn's run failed with this error (`details.runId`); `Retry-After` says when to start the turn again.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runs',
    openapiPath: '/v1/runs',
    operationId: 'runs.list',
    summary: 'List runs',
    description: 'Cursor-paginated. Fixed sort order: `createdAt desc, id desc`.',
    tags: ['runs'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      ParentRunIdQueryParam,
      TopLevelQueryParam,
      RunAgentIdQueryParam,
      RunReplaysQueryParam,
      RunTestRunIdQueryParam,
      RunTriggerIdQueryParam,
      RunIncludeQueryParam,
      RunStatusQueryParam,
      RunCreatedAfterQueryParam,
      RunCreatedBeforeQueryParam,
      RunAgentVersionQueryParam,
      RunFlowIdQueryParam,
      RunFlowVersionQueryParam,
    ],
    responses: {
      '200': { description: 'Page of runs.', schema: ref('RunCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed cursor, filter or scope.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runs/failures',
    openapiPath: '/v1/runs/failures',
    operationId: 'runs.failures',
    summary: "A project's failed runs, grouped by cause and version",
    description:
      "Counts from the server, never from a page: per group, how many runs failed, when the first and the latest failed in the window, and the latest run. People's decisions (`hitl-*`: an approval rejected, cancelled or timed out) come apart as `outcomes`, never as failures. Runs that failed before their cause was recorded come apart as `unrecorded`, by subject and version only. Replays, test runs' runs and dry runs aren't counted; a child run counts under its own agent or flow. Failed runs go with their retention, so a window can hold fewer than happened. Needs `read` on the project.",
    tags: ['runs'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'query',
        required: true,
        description: 'The project whose runs are counted.',
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'from',
        in: 'query',
        required: true,
        description: 'Runs that failed at or after this time (ISO 8601).',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'to',
        in: 'query',
        required: true,
        description: 'Runs that failed before this time (ISO 8601). At most 90 days after `from`.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'agentId',
        in: 'query',
        required: false,
        description: "Only this agent's turns. Not with `flowId`.",
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'flowId',
        in: 'query',
        required: false,
        description: "Only this flow's runs. Not with `agentId`.",
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'groupBy',
        in: 'query',
        required: false,
        description:
          'What failures are grouped by: `code`, `version`, or `code,version` (the default).',
        schema: { type: 'string' },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        description:
          'The most groups in each list, the most failures first: 1 to 200, 50 by default.',
        schema: { type: 'integer', minimum: 1, maximum: 200 },
      },
    ],
    responses: {
      '200': { description: 'The groups.', schema: ref('RunFailureGroups') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'A missing or malformed `projectId`, `from`, `to`, `groupBy` or `limit`; a window over 90 days; both `agentId` and `flowId`.',
      ),
      '501': ErrorResponse(
        '`run-failures-not-supported`: this deployment cannot group failed runs by cause.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runs/:runId',
    openapiPath: '/v1/runs/{runId}',
    operationId: 'runs.get',
    summary: 'Fetch a run',
    tags: ['runs'],
    security: 'bearer',
    parameters: [RunIdPathParam],
    responses: {
      '400': ErrorResponse('`runId` is not a run id (a UUID).'),
      '200': { description: 'Run row.', schema: ref('Run') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No run with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/runs/:runId/cancel',
    openapiPath: '/v1/runs/{runId}/cancel',
    operationId: 'runs.cancel',
    summary: 'Cancel a run',
    description:
      'Cancelling a run that already reached a terminal state returns `409 run-already-terminal`.',
    tags: ['runs'],
    security: 'bearer',
    parameters: [RunIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Updated run row.', schema: ref('Run') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No run with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/runs/:runId/resume',
    openapiPath: '/v1/runs/{runId}/resume',
    operationId: 'runs.resume',
    summary: "Answer a run's wait for another system",
    description:
      "Answers a run paused on a tool call until another system answers (a pack tool that declares `pauses`; its waitpoint id starts with `pause:`, as the run's `waitingFor.tokens` lists it), as that system would through the wait token's link, and resumes the run in the same request. `value` is the tool's output, checked against its output schema; absent, `{}`. Answering stands in for the other system, and the run acts on the answer, so it needs `write` on the run's project and `execute` on the agent or flow it runs, as starting it does. The same answer again is accepted again, even after the run has ended; a different one to a wait that's over is `409 wait-token-closed`. Every other waitpoint belongs to an approval or to the runtime itself, and is `422 run-resume-not-supported`: a run waiting for an approval continues when a reviewer decides it (`POST /v1/approvals/{approvalId}/complete`).",
    tags: ['runs'],
    security: 'bearer',
    parameters: [RunIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('ResumeRunBody') },
    responses: {
      '200': {
        description:
          'The run after the answer: running again, finished, or waiting at its next wait (`waitingFor`).',
        schema: ref('Run'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "`bad-input`: no `waitpointId`, or a field the body doesn't take. `wait-token-output-invalid` (`details.issues`): the value doesn't fit the tool's output schema, and the wait stays open.",
      ),
      '404': ErrorResponse(
        '`run-not-found`: no run with that id under this tenant. `wait-token-not-found`: the run has no such wait.',
      ),
      '409': ErrorResponse(
        "`wait-token-closed` (`details.state`): the wait is over (`completed`, `timed-out`, `cancelled`, `unused`), or holds a different answer the run hasn't taken yet (`answered`). `project-suspended`: nothing runs in the run's project, and the suspension cancels its runs, so the value wasn't taken. Or an `Idempotency-Key` reused with a different body.",
      ),
      '422': ErrorResponse(
        "`run-resume-not-supported`: a waitpoint that isn't a pause, or a runtime that pauses no run.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runs/:runId/journal',
    openapiPath: '/v1/runs/{runId}/journal',
    operationId: 'runs.journal',
    summary: 'Read the durable journal for a run',
    description:
      'Returns raw `JournalEntry` values from the run journal (`@kindgi/runtime`), in sequence order. Distinct from the SSE wire enum — see `docs/API-ROUTE-CONVENTIONS.md` §6. Paging is opt-in: with `limit`, at most that many entries and a `nextCursor` while more remain; without it, the whole journal in one answer.',
    tags: ['runs'],
    security: 'bearer',
    parameters: [RunIdPathParam, JournalSinceQueryParam, JournalLimitQueryParam, CursorQueryParam],
    responses: {
      '400': ErrorResponse(
        '`runId` is not a run id (a UUID), `limit` is not a whole number of 1 or more, or `cursor` is malformed.',
      ),
      '200': { description: 'Journal page.', schema: ref('RunJournalPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No run with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runs/:runId/stream',
    openapiPath: '/v1/runs/{runId}/stream',
    operationId: 'runs.stream',
    summary: 'Server-Sent Events stream of RunEvent frames',
    description:
      "Each SSE frame is one `RunEvent` per `@kindgi/specs/run-event.schema.json`. Reconnect via `Last-Event-Id: <runId>:<sequence>`. The server ends the stream after the run's terminal event, or after 5 minutes: reconnect with `Last-Event-Id` to continue.",
    tags: ['runs'],
    security: 'bearer',
    parameters: [RunIdPathParam, LastEventIdParam],
    responses: {
      '400': ErrorResponse('`runId` is not a run id (a UUID).'),
      '200': {
        description: 'text/event-stream. Each frame is one RunEvent.',
        contentType: 'text/event-stream',
        schema: ref('RunEvent'),
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No run with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runs/:runId/progress',
    openapiPath: '/v1/runs/{runId}/progress',
    operationId: 'runs.progress',
    summary: "A run's progress (status and timing, no data)",
    description:
      "The run's status and timing, without its input, output or failure message: safe to show in a browser. Accepts an API token, or a public run token (`kgi_pt_…`) that names the run or one of its ancestors.",
    tags: ['runs'],
    security: 'bearer-or-public-run',
    parameters: [RunIdPathParam],
    responses: {
      '400': ErrorResponse('`runId` is not a run id (a UUID).'),
      '200': { description: "The run's progress.", schema: ref('RunProgress') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No run with that id that the token may read.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runs/:runId/progress/stream',
    openapiPath: '/v1/runs/{runId}/progress/stream',
    operationId: 'runs.progressStream',
    summary: "Server-Sent Events stream of a run's progress",
    description:
      "Each SSE frame is one `RunProgressEvent`: what happened, on which node, when — no payloads. Accepts an API token, or a public run token that names the run or one of its ancestors. Reconnect via `Last-Event-Id`; the server ends the stream after the run's terminal event, or after 5 minutes.",
    tags: ['runs'],
    security: 'bearer-or-public-run',
    parameters: [RunIdPathParam, LastEventIdParam],
    responses: {
      '400': ErrorResponse('`runId` is not a run id (a UUID).'),
      '200': {
        description: 'text/event-stream. Each frame is one RunProgressEvent.',
        contentType: 'text/event-stream',
        schema: ref('RunProgressEvent'),
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No run with that id that the token may read.'),
    },
  },

  // ---------- signing keys (the deployment trust list) ----------
  {
    method: 'post',
    honoPath: '/v1/signing-keys',
    openapiPath: '/v1/signing-keys',
    operationId: 'signingKeys.trust',
    summary: 'Trust a signing key',
    description:
      "Adds a public key to the tenant's trust list: deployments it signs verify. Needs the `signing-keys:write` capability. Trusting the same key again answers `200`; a known `keyId` with a different public key is `409 signing-key-conflict` (rotate under a new id). Mounted when the deployment supplies a signing-key registry.",
    tags: ['signing-keys'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('TrustSigningKeyBody') },
    responses: {
      '201': { description: 'Trusted.', schema: ref('TrustedSigningKey') },
      '200': { description: 'Already trusted.', schema: ref('TrustedSigningKey') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        `Not a tenant admin, or the key doesn't carry the \`signing-keys:write\` capability (\`permission-denied\`). ${WITHOUT_STORE_ADMIN}`,
      ),
      '409': ErrorResponse(
        '`keyId` is already trusted with a different public key (`signing-key-conflict`), or was revoked (`signing-key-revoked`: revocation is final).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/signing-keys',
    openapiPath: '/v1/signing-keys',
    operationId: 'signingKeys.list',
    summary: 'List trusted signing keys',
    description:
      'Cursor-paginated. Active keys only unless `?includeRevoked=true`; `?label=` is a prefix match on the label.',
    tags: ['signing-keys'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'includeRevoked',
        in: 'query',
        required: false,
        description: '`true` lists revoked keys too.',
        schema: { type: 'string', enum: ['true', 'false'] },
      },
      {
        name: 'label',
        in: 'query',
        required: false,
        description: 'Prefix match on the key label.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Page of trusted keys.', schema: ref('TrustedSigningKeyPage') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/signing-keys/:keyId',
    openapiPath: '/v1/signing-keys/{keyId}',
    operationId: 'signingKeys.get',
    summary: 'Get a signing key',
    description: 'Revoked keys too (with `revokedAt`), for audit.',
    tags: ['signing-keys'],
    security: 'bearer',
    parameters: [SigningKeyIdPathParam],
    responses: {
      '200': { description: 'The key.', schema: ref('TrustedSigningKey') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No signing key with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/signing-keys/:keyId/revoke',
    openapiPath: '/v1/signing-keys/{keyId}/revoke',
    operationId: 'signingKeys.revoke',
    summary: 'Revoke a signing key',
    description:
      'Deployments it signed stay on record; it verifies no new ones. Needs the `signing-keys:write` capability. Idempotent: `revoked` is `false` when the key was unknown or already revoked.',
    tags: ['signing-keys'],
    security: 'bearer',
    parameters: [SigningKeyIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('RevokeSigningKeyBody') },
    responses: {
      '200': {
        description: 'Revoked (or already not trusted).',
        schema: ref('RevokeSigningKeyResult'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        `Not a tenant admin, or the key doesn't carry the \`signing-keys:write\` capability (\`permission-denied\`). ${WITHOUT_STORE_ADMIN}`,
      ),
    },
  },

  // ---------- tokens ----------
  {
    method: 'post',
    honoPath: '/v1/tokens',
    openapiPath: '/v1/tokens',
    operationId: 'tokens.mint',
    summary: 'Mint an API key',
    description:
      "An API key acts for one principal (`for`: a person or a service account; default the caller), with that principal's grants. Its `role` is a ceiling under them and its `projectId` a limit. Returns the plaintext token exactly once. A person or a service account's key mints its own keys; only a tenant admin mints for someone else, or an `admin` key. A caller can only grant capabilities it holds, and a key limited to a project mints only keys limited to it. A key that expires mints only keys that expire no later than it, and a session opened by token sign-in mints as the key it was opened with. Only mounted when the deployment supplies a `TokenAdmin`.",
    tags: ['tokens'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('MintTokenBody') },
    responses: {
      '201': { description: 'Token minted.', schema: ref('MintTokenResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "`for` names a project's own service account, which has no keys (`service-account-project-owned`). Or Idempotency-Key reused with a different body (`idempotency-key-body-mismatch`), or a retry of a request that succeeded: its answer carried a secret, which isn't kept (`idempotency-key-replay-withheld`, with its `status` and `at`).",
      ),
      '403': ErrorResponse(
        "Not a tenant admin where one is needed, or a capability the caller does not hold (`permission-denied`); an `admin` key for a principal that isn't a tenant admin (`role-exceeds-principal`); a key limited to a project minting for another (`key-project-mismatch`); a key that would outlive the key minting it, with an `expiresAt` later than that key's or none (`token-expiry-exceeds-minter`, its `details.latestExpiresAt` the latest allowed); a session limited to a project or a role, which mints no keys (`limited-session-cannot-mint`); a key for a person a site signs in, whose access is only the sessions their site gives (`site-person-grants-managed`).",
      ),
      '400': ErrorResponse(
        "Malformed request body, or the body's `projectId` isn't a project id (a UUID).",
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`), or `for` names no person or service account (`principal-not-found`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/tokens',
    openapiPath: '/v1/tokens',
    operationId: 'tokens.list',
    summary: 'List API keys',
    description:
      "Newest first. Never returns secrets. A tenant admin sees every key (`?principal=` for one principal's); anyone else sees their own.",
    tags: ['tokens'],
    security: 'bearer',
    parameters: [
      CursorQueryParam,
      LimitQueryParam,
      {
        name: 'principal',
        in: 'query',
        required: false,
        description:
          "Tenant admins: only this principal's keys, `user:<id>` or `service-account:<id>`.",
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'A page of keys.', schema: ref('ApiTokenPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed cursor or `principal`.'),
      '403': ErrorResponse('A caller with no keys of its own that is not a tenant admin.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/tokens/:tokenId',
    openapiPath: '/v1/tokens/{tokenId}',
    operationId: 'tokens.get',
    summary: 'Read an API key',
    description:
      "Never returns the secret. A tenant admin reads any key; anyone else only their own (someone else's reads as missing).",
    tags: ['tokens'],
    security: 'bearer',
    parameters: [TokenIdPathParam],
    responses: {
      '200': { description: 'The key.', schema: ref('ApiToken') },
      ...CommonAuthErrors,
      '403': ErrorResponse('A caller with no keys of its own that is not a tenant admin.'),
      '404': ErrorResponse('No token with that id that the caller may see.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/tokens/:tokenId/revoke',
    openapiPath: '/v1/tokens/{tokenId}/revoke',
    operationId: 'tokens.revoke',
    summary: 'Revoke an API key',
    description:
      'Takes effect on the next request. A tenant admin revokes any key; anyone else only their own.',
    tags: ['tokens'],
    security: 'bearer',
    parameters: [TokenIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Revoked.', schema: ref('RevokeTokenResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse('A caller with no keys of its own that is not a tenant admin.'),
      '404': ErrorResponse('No token with that id that the caller may see.'),
    },
  },
  // ---------- system keys ----------
  {
    method: 'post',
    honoPath: '/v1/system/keys',
    openapiPath: '/v1/system/keys',
    operationId: 'systemKeys.mint',
    summary: 'Mint a system key',
    description:
      "A system key (`kgi_sy_…`) is the operator's, for a service that acts for it (sign-up, the orchestrator, billing, the license renewal), with the least scope that service needs. It acts in no tenant: it reaches `/v1/system/*` and the deployment's license, and every other route refuses it (`system-key-on-tenant-route`). Every request it makes is recorded. Only the full system capability (`kindgi:system`: the deployment's own token, or a full system key) mints one, and a key can't outlive the key minting it. Returns the plaintext token exactly once. On a runtime serving one tenant, only the deployment's own token reaches the system keys, and a key holds `system:license` alone: it reads `GET /v1/license` and `GET /v1/license/usage`, for the license renewal, and every other route refuses it.",
    tags: ['system-keys'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('MintSystemKeyBody') },
    responses: {
      '201': { description: 'System key minted.', schema: ref('MintSystemKeyResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'Malformed request body: no scopes, one that is not a system scope, a scope twice, `kindgi:system` beside another, a past `expiresAt`, or an empty label; on a runtime serving one tenant, any scope but `system:license`.',
      ),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`); a scoped system key (`system-scope-missing`, `details.scope` `kindgi:system`; on a runtime serving one tenant, `system-key-scope-not-served` for one holding anything but `system:license`); a key that would outlive the key minting it (`token-expiry-exceeds-minter`, its `details.latestExpiresAt` the latest allowed); a full key minted by another system key without `expiresAt` (`system-key-expiry-required`: only the deployment's own token mints one that never expires).",
      ),
      '409': ErrorResponse(
        "Idempotency-Key reused with a different body (`idempotency-key-body-mismatch`), or a retry of a request that succeeded: its answer carried a secret, which isn't kept (`idempotency-key-replay-withheld`).",
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`): a request that changes something is recorded before it acts. Or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`), so nothing was changed.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/keys',
    openapiPath: '/v1/system/keys',
    operationId: 'systemKeys.list',
    summary: 'List system keys',
    description:
      "The operator's system keys (`kgi_sy_…`): each acts in no tenant, for one service, with the scopes it was minted with. Newest first, revoked ones too. Never returns secrets. Only the full system capability (`kindgi:system`: the deployment's own token, or a full system key) lists them; on a runtime serving one tenant, the deployment's own token alone.",
    tags: ['system-keys'],
    security: 'bearer',
    responses: {
      '200': { description: 'The system keys.', schema: ref('SystemKeyList') },
      ...CommonAuthErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a scoped system key (`system-scope-missing`; on a runtime serving one tenant, `system-key-scope-not-served` for one holding anything but `system:license`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/system/keys/:keyId/revoke',
    openapiPath: '/v1/system/keys/{keyId}/revoke',
    operationId: 'systemKeys.revoke',
    summary: 'Revoke a system key',
    description:
      "Revokes one of the operator's system keys (`kgi_sy_…`) and every key minted from it, however deep (`alsoRevoked`): they stop working on the next request. Revoking a revoked key keeps the first time. Only the full system capability (`kindgi:system`: the deployment's own token, or a full system key) revokes them; on a runtime serving one tenant, the deployment's own token alone.",
    tags: ['system-keys'],
    security: 'bearer',
    parameters: [
      {
        name: 'keyId',
        in: 'path',
        required: true,
        description: "The system key's id (a UUID).",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': {
        description: 'Revoked, with every key minted from it.',
        schema: ref('RevokeSystemKeyResult'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a scoped system key (`system-scope-missing`; on a runtime serving one tenant, `system-key-scope-not-served` for one holding anything but `system:license`).",
      ),
      '400': ErrorResponse('`keyId` is not a system key id (a UUID).'),
      '404': ErrorResponse('No system key with that id (`system-key-not-found`).'),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  // ---------- system: tenants ----------
  {
    method: 'post',
    honoPath: '/v1/system/tenants',
    openapiPath: '/v1/system/tenants',
    operationId: 'systemTenants.create',
    summary: 'Create a tenant',
    description:
      "Creates a tenant on a runtime serving many tenants, with its setup (its default project, its authorization store). Safe to retry with the same slug: if the setup didn't finish, the tenant waits, frozen, and the same request (the same name, slug, settings and first admin, under any Idempotency-Key) finishes it and answers as the first would have; another request naming that slug is `tenant-slug-taken`. A repeat of a create that finished is `tenant-slug-taken` too, unless it carries the first request's Idempotency-Key: then it gets the first answer again, or `409 idempotency-key-replay-withheld` when that answer held the admin key, which is never sent twice (send an Idempotency-Key with every create, so a lost answer can be told from another tenant's slug). With `firstAdmin`, that person becomes its admin and member by email, with every capability but `secrets:reveal`, and the runtime's own sign-in finds them; the answer carries no key. Without it, the answer carries the tenant's first admin key, shown once, and that takes the full system capability (`kindgi:system`), as does a `test` tenant. Takes `system:tenants:create` (sign-up's) or `system:tenants`. A tenant created here starts with production blocked; `productionAllowed: true` takes `system:tenants:production`, and `imagePrefix` takes `system:tenants:image-prefix`. Asking for more than the key's scopes is refused naming the scope, never dropped. An Idempotency-Key retry answers the same tenant, with the admin key withheld.",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateSystemTenantBody') },
    responses: {
      '201': {
        description: 'The tenant, and its first admin.',
        schema: ref('CreateSystemTenantResult'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'Malformed body: a name, slug, image prefix or first admin that is refused, or an unknown field.',
      ),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`); a system key without `system:tenants:create` or `system:tenants`, or asking for what its scopes don't give: production (`system:tenants:production`), an image prefix (`system:tenants:image-prefix`), an admin key or a test tenant (`kindgi:system`) (`system-scope-missing`, `details.scope` naming it).",
      ),
      '409': ErrorResponse(
        "Another tenant has the slug, or a create whose setup is pending holds it with another request (`tenant-slug-taken`); or its image prefix overlaps another tenant's (`image-prefix-taken`); or an Idempotency-Key reused with another body; or that key's replay, when the first answer held the admin key (`idempotency-key-replay-withheld`).",
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/tenants',
    openapiPath: '/v1/system/tenants',
    operationId: 'systemTenants.list',
    summary: 'List tenants',
    description:
      "Newest first; purged tenants are left out. Takes `system:tenants`. Never a tenant's content.",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'The tenants.', schema: ref('SystemTenantList') },
      ...CommonAuthErrors,
      '400': ErrorResponse('A `limit` out of range, or a `cursor` this route did not give.'),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants` (`system-scope-missing`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/tenants/:tenantId',
    openapiPath: '/v1/system/tenants/{tenantId}',
    operationId: 'systemTenants.get',
    summary: 'Read a tenant',
    description: 'Its state, switch, image prefix and dates. Takes `system:tenants`.',
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': { description: 'The tenant.', schema: ref('SystemTenant') },
      ...CommonAuthErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/system/tenants/:tenantId',
    openapiPath: '/v1/system/tenants/{tenantId}',
    operationId: 'systemTenants.update',
    summary: 'Rename a tenant',
    description:
      "Changes its name, its slug, or both, as the tenant's own admins can (`PATCH /v1/tenant`); a field left out stays as it is. Its id stays. The same values again change nothing. Takes `system:tenants`. A closing tenant is refused (`409 tenant-closing`). A runtime whose tenant-hierarchy binding can't rename tenants doesn't serve this route.",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('TenantPatch') },
    responses: {
      '204': { description: 'Renamed, or already so. No body.' },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'A malformed body or a field out of its rules (`bad-input`), or a field other than `name` and `slug` (`unknown-field`).',
      ),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
      '409': ErrorResponse(
        "Another tenant has the slug (`tenant-slug-taken`); the server's verified sign-in domains name the tenant by its current slug, or name the new one (`tenant-slug-in-config`); the tenant is closing (`tenant-closing`); its setup hasn't finished (`tenant-setup-pending`); or an Idempotency-Key reused with another body.",
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/system/tenants/:tenantId/close',
    openapiPath: '/v1/system/tenants/{tenantId}/close',
    operationId: 'systemTenants.close',
    summary: 'Close a tenant',
    description:
      'Starts the end of its contract: the tenant becomes `closing`. Its own keys and sessions still read and export it for its window; nothing runs (its unfinished runs, waiting ones included, are cancelled), and nothing is written but deletes. One-way: the purge follows the window. A second close keeps the first. Takes `system:tenants`.',
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': { description: 'The tenant, closing.', schema: ref('SystemTenant') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/suspended',
    openapiPath: '/v1/system/tenants/{tenantId}/suspended',
    operationId: 'systemTenants.setSuspended',
    summary: 'Suspend a tenant, or restore it',
    description:
      "Reversible: a suspended tenant's own keys and sessions still read and export it; nothing runs (its unfinished runs, waiting ones included, are cancelled), and nothing is written but deletes. Its schedules and triggers are skipped, not changed, so restoring resumes exactly what was on. Nothing that came due meanwhile runs late: at the restore, a fire whose run or Improve run hadn't started is recorded `skipped` (`tenant-suspended`), and a schedule that's on fires next at its first occurrence after the restore, whatever its `catchUp`. A second suspend keeps the first one's time and reason; restoring clears both. Takes `system:suspend`, which no other scope includes. A closing tenant is refused (`409 tenant-closing`).",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('SetTenantSuspendedBody') },
    responses: {
      '200': { description: 'The tenant now.', schema: ref('SystemTenant') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:suspend` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
      '409': ErrorResponse(
        'The tenant is closing (`tenant-closing`); or an Idempotency-Key reused with another body.',
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/image-prefix',
    openapiPath: '/v1/system/tenants/{tenantId}/image-prefix',
    operationId: 'systemTenants.setImagePrefix',
    summary: "Set the repository a tenant's images must sit in",
    description:
      "Each tenant may deploy only images at or under its own repository: `<host>/<path>`, matched on a path boundary, with no trailing slash. On a runtime serving many tenants, a tenant without one can't register a deployment. Takes `system:tenants:image-prefix`, the key that binds the tenant's slot; changing a prefix that's already set takes the full system capability. A closing tenant is refused (`409 tenant-closing`).",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('SetTenantImagePrefixBody') },
    responses: {
      '200': { description: 'The tenant now.', schema: ref('SystemTenant') },
      ...CommonMutationErrors,
      '400': ErrorResponse('A prefix that is not `<host>/<path>`.'),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants:image-prefix`, or changing a prefix already set without `kindgi:system` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
      '409': ErrorResponse(
        "The tenant is closing (`tenant-closing`); the prefix equals, holds or sits inside another tenant's (`image-prefix-taken`); or an Idempotency-Key reused with another body.",
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/projects/:projectId/suspended',
    openapiPath: '/v1/system/tenants/{tenantId}/projects/{projectId}/suspended',
    operationId: 'systemTenants.setProjectSuspended',
    summary: "Suspend one of a tenant's projects, or restore it",
    description:
      "Reversible: nothing new runs or deploys in the project, its unfinished runs, waiting ones included, are cancelled, and its deployments retired; reads and the rest of the tenant are untouched. Its schedules' fires are recorded `skipped` (`project-suspended`) and don't count toward the auto-pause, so a schedule stays on and fires again once the project is restored. A delivery to one of its webhook triggers is answered `skipped: project-suspended`, and nothing is recorded. A second suspend keeps the first one's time and reason; restoring clears both. Takes `system:suspend`. A closing tenant is refused (`409 tenant-closing`).",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: "The project's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('SetTenantSuspendedBody') },
    responses: {
      '200': { description: 'The project now.', schema: ref('ProjectSuspension') },
      ...CommonMutationErrors,
      '400': ErrorResponse('A malformed project id or body.'),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:suspend` (`system-scope-missing`).",
      ),
      '404': ErrorResponse(
        'No such tenant (`tenant-not-found`), or no such project in it (`project-not-found`).',
      ),
      '409': ErrorResponse(
        'The tenant is closing (`tenant-closing`); or an Idempotency-Key reused with another body.',
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/tenants/:tenantId/admins',
    openapiPath: '/v1/system/tenants/{tenantId}/admins',
    operationId: 'systemTenants.admins',
    summary: "A tenant's admins' contact addresses",
    description:
      "For the operator's service notices (a breach, maintenance, a new sub-processor, a terms change): the tenant's active admins with a primary email, at most 100, and only their id, email and display name. Account contacts, never the tenant's content. Takes its own scope, `system:tenants:contacts`, and every read is recorded.",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': { description: 'The admins.', schema: ref('TenantAdminContacts') },
      ...CommonAuthErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants:contacts` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/system/tenants/:tenantId/purge',
    openapiPath: '/v1/system/tenants/{tenantId}/purge',
    operationId: 'systemTenants.purge',
    summary: 'Purge a closed tenant, for good',
    description:
      "Deletes a `closing` tenant whose 30-day export window has passed: every row of it, its artifacts' bytes and its authorization store. Once nothing of it is left, its purge record is written, so a restore from an older backup purges it again, and it's marked purged: its tenants row stays, and nothing of it signs in or is served. Then, once each server has seen the mark, it deletes again what work under way at the mark wrote meanwhile. Irreversible. `confirm` is the tenant's slug, a second check on the id. It answers when done. Safe to run again: a run that stopped part-way (`complete: false`, or a request that ended before its answer) is finished by the next, and on a tenant already purged it deletes what was written after its mark, leaving its mark and its record as they were. A run again is a new request: a new Idempotency-Key, or none. Takes its own scope, `system:tenants:purge`, which no other scope includes, or `kindgi:system`.",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('PurgeTenantBody') },
    responses: {
      '200': {
        description: 'What it deleted, and what of it is left.',
        schema: ref('SystemTenantPurge'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "No `confirm`, or one that isn't the tenant's slug (`tenant-slug-mismatch`). Nothing was changed.",
      ),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants:purge` (`system-scope-missing`).",
      ),
      '404': ErrorResponse(
        'No tenant with that id (`tenant-not-found`). A purged one is found, for a run again.',
      ),
      '409': ErrorResponse(
        "Nothing was changed: the tenant isn't closing (`tenant-not-closing`), or its export window is still open (`tenant-export-window-open`); the runtime has nowhere set to keep purge records (`purge-record-unset`), or lacks the setting that reaches what the tenant holds (`purge-setting-missing`); or an Idempotency-Key reused with another body.",
      ),
      '501': ErrorResponse("This runtime doesn't purge tenants (`tenant-purge-unsupported`)."),
      '502': ErrorResponse(
        "Deleting the tenant's authorization store failed (`authz-store-delete-failed`): the message says what that left. Run it again.",
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/whoami',
    openapiPath: '/v1/system/whoami',
    operationId: 'systemKeys.whoami',
    summary: 'Which system key this is',
    description:
      "A system key's own id, scopes and expiry, for a service checking its key: any system principal, on a runtime serving many tenants. A tenant's key or session is refused (`system-principal-required`). `GET /v1/identity/whoami` is a tenant route, which refuses a system key. A runtime serving one tenant answers no one here: its own token is that tenant's outside `/v1/system/keys`, and a system key reads the license routes alone.",
    tags: ['system-keys'],
    security: 'bearer',
    responses: {
      '200': { description: 'The key.', schema: ref('SystemWhoami') },
      ...CommonAuthErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`). On a runtime serving one tenant, the deployment's own token too (`system-principal-required`), a system key (`system-scope-missing`), and one holding anything but `system:license` (`system-key-scope-not-served`).",
      ),
    },
  },
  // ---------- system: tenant settings and usage ----------
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/production-allowed',
    openapiPath: '/v1/system/tenants/{tenantId}/production-allowed',
    operationId: 'systemTenants.setProductionAllowed',
    summary: 'Allow a tenant production, or stop it',
    description:
      "The switch the production gate reads: with it off, `PUT /v1/projects/{projectId}/production` refuses to put the tenant's projects in production (`403 production-not-allowed`), and projects already in production stay so. A tenant made by `POST /v1/system/tenants` starts with it off, unless the create says `productionAllowed: true`; the tenant a server makes for itself, and one from before the switch, start with it on. Takes `system:tenants:production`. A closing tenant is frozen: `409 tenant-closing`.",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('ProductionAllowedBody') },
    responses: {
      '200': { description: "The tenant's switch now.", schema: ref('TenantProductionAllowed') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants:production` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
      '409': ErrorResponse(
        'The tenant is closing (`tenant-closing`); or an Idempotency-Key reused with another body.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/tenants/:tenantId/limits',
    openapiPath: '/v1/system/tenants/{tenantId}/limits',
    operationId: 'systemTenants.limits',
    summary: "Read a tenant's limits",
    description:
      "The tenant's limits as stored, in the shape `PUT` takes: to change one, read them, change it and put them all back. A limit that isn't set is absent, and isn't enforced. From a runtime that counts it, `inUse` says how much of each counted limit the tenant uses now (`projectsInProduction`), which can be over a limit lowered below it. Takes `system:tenants:limits`. A closing tenant's limits can be read.",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': { description: "The tenant's limits.", schema: ref('TenantLimitsResult') },
      ...CommonAuthErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants:limits` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/limits',
    openapiPath: '/v1/system/tenants/{tenantId}/limits',
    operationId: 'systemTenants.setLimits',
    summary: "Set a tenant's limits",
    description:
      "Replaces the tenant's limits with exactly these: a limit left out isn't set, and isn't enforced. Each is a whole number from 1 to 1000000. The tenant reads them on `GET /v1/tenant`. Takes `system:tenants:limits`. A closing tenant is frozen: `409 tenant-closing`.",
    tags: ['system-tenants'],
    security: 'bearer',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The tenant's id.",
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('TenantLimits') },
    responses: {
      '200': { description: "The tenant's limits now.", schema: ref('TenantLimitsResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:tenants:limits` (`system-scope-missing`).",
      ),
      '404': ErrorResponse('No tenant with that id, or a purged one (`tenant-not-found`).'),
      '409': ErrorResponse(
        'The tenant is closing (`tenant-closing`); or an Idempotency-Key reused with another body.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/usage',
    openapiPath: '/v1/system/usage',
    operationId: 'systemUsage.read',
    summary: 'Read usage across tenants',
    description:
      "Usage records aggregated by the dimensions in `groupBy`: each group's count, the sum of its quantities, and its first and last times. Never a record's content. Records are counted when the counted thing happens, exactly once (the kinds `kind` lists, each run with its class). `watermark`: every record at or before it is in the answer, so re-read a window until its watermark is past the window's end; every page of one read carries the same watermark. A test tenant's usage, and one whose setup is pending, are never in the answer, even when `tenantId` names one. Takes `system:usage:read`; the access record marks a read across every tenant, or of the one named. A runtime that doesn't count usage (`KINDGI_USAGE_METERING` unset or `off`) answers 404.",
    tags: ['system-usage'],
    security: 'bearer',
    parameters: [
      ...usageQueryParams(
        'Comma-separated, each once: `tenant`, `project`, `agent`, `kind`, `class`, `state`, `day` (the UTC date). Default `tenant,kind`.',
      ),
      {
        name: 'tenantId',
        in: 'query',
        required: false,
        description: 'Only this tenant.',
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': { description: 'A page of groups.', schema: ref('UsagePage') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "A window, filter, `limit` or `cursor` this route can't read (`bad-input`), naming which.",
      ),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:usage:read` (`system-scope-missing`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/usage',
    openapiPath: '/v1/usage',
    operationId: 'usage.read',
    summary: "Read your workspace's usage",
    description:
      "Your workspace's usage records aggregated by the dimensions in `groupBy`: each group's count, the sum of its quantities, and its first and last times. Never a record's content. Over the projects you may read: a tenant admin's covers every project and the records with none; anyone else's, only the projects they may read, and one they can't read is absent rather than an error. `watermark`: every record at or before it is in the answer, so re-read a window until its watermark is past the window's end; every page of one read carries the same watermark. A runtime that doesn't count usage (`KINDGI_USAGE_METERING` unset or `off`) answers 404. Model-call cost is on `/v1/cost`.",
    tags: ['usage'],
    security: 'bearer',
    parameters: [
      ...usageQueryParams(
        'Comma-separated, each once: `project`, `agent`, `kind`, `class`, `state`, `day` (the UTC date). Default `project,kind`.',
      ),
      {
        name: 'projectId',
        in: 'query',
        required: false,
        description: "Only this project. One you can't read gives an empty answer.",
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': { description: 'A page of groups.', schema: ref('UsagePage') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "A window, filter, `limit` or `cursor` this route can't read (`bad-input`), naming which.",
      ),
      '403': ErrorResponse(
        "The projects you may read can't be listed on this deployment, so usage across projects can't be limited to them (`permission-denied`): ask for one with `projectId`.",
      ),
    },
  },
  // ---------- system deployments (per-deployment routing) ----------
  {
    method: 'get',
    honoPath: '/v1/system/deployments',
    openapiPath: '/v1/system/deployments',
    operationId: 'systemDeployments.list',
    summary: 'List deployments that need a pack service, or should lose theirs',
    description:
      "Across tenants, oldest `activatedAt` first. `endpoint=missing`: deployments that need a pack service. Each is routed (the newest deployment with routes for some tool version or pack check), has no endpoint or a cleared one, and nothing about it is closing or suspended. `endpoint=retire`: deployments with an endpoint whose pack service should go, each with its `reason`. Name each service `packServiceName(tenantId, deploymentId)` (`@kindgi/api`). Takes `system:deployments`. Each entry carries the tenant's id and nothing else of it.",
    tags: ['system-deployments'],
    security: 'bearer',
    parameters: [
      {
        name: 'endpoint',
        in: 'query',
        required: true,
        description:
          '`missing`: deployments that need a pack service. `retire`: deployments whose pack service should go.',
        schema: { type: 'string', enum: ['missing', 'retire'] },
      },
      CursorQueryParam,
      LimitQueryParam,
    ],
    responses: {
      '200': { description: 'One page of deployments.', schema: ref('SystemDeploymentPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        '`endpoint` missing or neither `missing` nor `retire`; a `limit` out of range; a cursor refused.',
      ),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:deployments` (`system-scope-missing`).",
      ),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/deployments/:deploymentId/endpoint',
    openapiPath: '/v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint',
    operationId: 'systemDeployments.setEndpoint',
    summary: "Record where a deployment's pack service runs",
    description:
      "Records the endpoint, once every check passes: the URL is `https://<host>` (`endpoint-url-invalid`); its host is on the operator's allowlist (`endpoint-host-not-allowed`); its host names the deployment's own service, `packServiceName(tenantId, deploymentId)` then `-` or `.` (`endpoint-name-mismatch`); the image is in the tenant's repository (`image-not-allowed`); the pack service answers `/v1/info`, with the `kindgi-tenant-id` header, as this deployment (`endpoint-unreachable`, `endpoint-info-mismatch`, with the names of the fields that differed). A refusal is also recorded as the endpoint's `problem`, which the tenant sees as a code. The deployment's endpoint is then `ready`. Refused for a closing or suspended tenant, project or pack, so a sweep can't recreate a service another one retired. Takes `system:deployments`. The same body twice records it once.",
    tags: ['system-deployments'],
    security: 'bearer',
    parameters: [SystemTenantIdPathParam, SystemDeploymentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('SetPackEndpointBody') },
    responses: {
      '200': {
        description: "Recorded: the deployment's endpoint as its tenant sees it.",
        schema: ref('DeploymentEndpoint'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "A malformed body (`bad-input`), or a URL that isn't `https://<host>` (`endpoint-url-invalid`).",
      ),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:deployments` (`system-scope-missing`).",
      ),
      '404': ErrorResponse(
        'No such tenant (`tenant-not-found`), or no such deployment in it (`deployment-not-found`).',
      ),
      '409': ErrorResponse(
        "The tenant is closing or suspended (`tenant-closing`, `tenant-suspended`), or the project or pack is (`project-suspended`, `pack-suspended`); the image is outside the tenant's repository (`image-not-allowed`).",
      ),
      '422': ErrorResponse(
        "The host isn't allowed (`endpoint-host-not-allowed`) or doesn't name the deployment's service (`endpoint-name-mismatch`, with `details.expected`); the pack service didn't answer (`endpoint-unreachable`) or answered as another pack or version (`endpoint-info-mismatch`, with `details.differs`).",
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/pack-env',
    openapiPath: '/v1/system/pack-env',
    operationId: 'systemDeployments.listPackEnvChanged',
    summary: 'List deployments whose pack service runs on values that changed',
    description:
      "Across tenants: deployments with a `ready` pack service, whose pack declares an environment, and whose values changed since the revision their service runs (and weren't held back at this revision, but for one held as `pack-env-update-failed`, listed for an hour after it was first held so it's tried again, and one held for a cause the platform fixes, `pack-env-secret-unreadable` or `pack-env-secrets-unaudited`, listed every time with its `held`, as the revision doesn't move when that's fixed). Read each one's values with `GET …/deployments/{deploymentId}/pack-env`, give them to the service, and record it with `PUT …/pack-env`, sending back the `appliedRevision` it was listed with. Ids, the image and the revision each runs, never a value. Takes `system:pack-env`.",
    tags: ['system-deployments'],
    security: 'bearer',
    parameters: [CursorQueryParam, LimitQueryParam],
    responses: {
      '200': { description: 'One page of deployments.', schema: ref('SystemPackEnvPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('A `limit` out of range, or a cursor refused.'),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:pack-env` (`system-scope-missing`).",
      ),
      '501': ErrorResponse(
        "The server doesn't give a pack service its declared env: its pack services take theirs from how they're run (`pack-env-unsupported`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/system/tenants/:tenantId/deployments/:deploymentId/pack-env',
    openapiPath: '/v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env',
    operationId: 'systemDeployments.getPackEnv',
    summary: "Read the env a deployment's pack service is to be given",
    description:
      "For whatever runs the deployment's pack service: where each name its pack declares is set (at the deployment's project, then its org, then the tenant, at the env the server serves), and the values when nothing stands in the way. A name set both ways (`pack-env-ambiguous`), a required one set nowhere (`pack-env-missing`), or one set only as a secret whose value wasn't asked for (`pack-env-secret-not-yet`) is a `problem`, and then no value is given. With `secrets=values`, each name set only as a secret is given in `secrets`, read at the version its revision names; a secret that can't be read for a reason the platform fixes is `pack-env-secret-unreadable`, and then no value is given. Each value given out is on the audit record, a secret's written before the answer. Refused for a retired deployment (`endpoint-retired`) and a closing or suspended tenant. On a key of its own, `system:pack-env`: `system:deployments` reads no value, and `kindgi:system` no secret's.",
    tags: ['system-deployments'],
    security: 'bearer',
    parameters: [SystemTenantIdPathParam, SystemDeploymentIdPathParam, PackEnvSecretsQueryParam],
    responses: {
      '200': {
        description: 'Where each name is set, and the values when there is no problem.',
        schema: ref('SystemPackEnv'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('A `secrets` other than `values` (`bad-input`).'),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), a system key without `system:pack-env` (`system-scope-missing`), or with `secrets=values`, a key that doesn't hold `system:pack-env` itself, `kindgi:system` included (`system-scope-missing`).",
      ),
      '404': ErrorResponse(
        'No such tenant (`tenant-not-found`), or no such deployment in it (`deployment-not-found`).',
      ),
      '409': ErrorResponse(
        "The tenant is closing or suspended (`tenant-closing`, `tenant-suspended`), or the deployment's pack service was retired (`endpoint-retired`).",
      ),
      '501': ErrorResponse(
        "The server doesn't give a pack service its declared env: its pack services take theirs from how they're run (`pack-env-unsupported`). Or, with `secrets=values`, it has nowhere to audit a secret given out, so it gives none (`pack-env-secrets-unaudited`).",
      ),
      '503': ErrorResponse(
        "With `secrets=values`: the secret store is out, a secret changed while it was read, twice, or the secrets' audit rows weren't written. Nothing is given: try again (`pack-env-unavailable`). Or the database was too busy to answer in time (`database-busy`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/deployments/:deploymentId/pack-env',
    openapiPath: '/v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env',
    operationId: 'systemDeployments.recordPackEnv',
    summary: "Record the env revision a deployment's pack service runs",
    description:
      "After giving a `ready` pack service its values: the `revision` it now runs. Or, with `held`, that this revision's values couldn't be given (a required one was removed, say), or were given and its new revision didn't start (`pack-env-update-failed`): the service keeps what it runs, and the tenant sees the code on the endpoint (`packEnvProblem`) until a later revision is given. The same code for the same revision keeps the time it was first recorded. Compare-and-set: `appliedRevision` is the one the service was found running, and another recorded since is `pack-env-conflict`. A new service's revision goes with its endpoint instead (`packEnvRevision`). Takes `system:pack-env`.",
    tags: ['system-deployments'],
    security: 'bearer',
    parameters: [SystemTenantIdPathParam, SystemDeploymentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RecordPackEnvBody') },
    responses: {
      '200': {
        description: "Recorded: the deployment's endpoint as its tenant sees it.",
        schema: ref('DeploymentEndpoint'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse('A malformed body, or a `held` code not on the list (`bad-input`).'),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:pack-env` (`system-scope-missing`).",
      ),
      '404': ErrorResponse(
        'No such tenant (`tenant-not-found`), or no such deployment in it (`deployment-not-found`).',
      ),
      '409': ErrorResponse(
        "The tenant is closing (`tenant-closing`); the endpoint isn't `ready` (`endpoint-not-ready`, with `details.status`); another revision was recorded since (`pack-env-conflict`, with `details.appliedRevision`).",
      ),
      '501': ErrorResponse(
        "The server doesn't give a pack service its declared env: its pack services take theirs from how they're run (`pack-env-unsupported`).",
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/system/tenants/:tenantId/deployments/:deploymentId/endpoint',
    openapiPath: '/v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint',
    operationId: 'systemDeployments.clearEndpoint',
    summary: "Clear a deployment's endpoint",
    description:
      "Clears the endpoint before its pack service is deleted: the deployment's endpoint is `cleared`, and calls to its tools fail closed (`pack-endpoint-cleared`), never going to another deployment. Works for a closing or suspended tenant too: that's how its services are retired. Clearing twice keeps the first time. Takes `system:deployments`.",
    tags: ['system-deployments'],
    security: 'bearer',
    parameters: [SystemTenantIdPathParam, SystemDeploymentIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': {
        description: "Cleared: the deployment's endpoint as its tenant sees it.",
        schema: ref('DeploymentEndpoint'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:deployments` (`system-scope-missing`).",
      ),
      '404': ErrorResponse(
        'No such tenant (`tenant-not-found`), or no such deployment in it (`deployment-not-found`).',
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/deployments/:deploymentId/endpoint/problem',
    openapiPath: '/v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint/problem',
    operationId: 'systemDeployments.recordProblem',
    summary: 'Record why a deployment has no pack service yet',
    description:
      "For whatever creates the pack services: records why a deployment waiting for one has none yet (`pending`, or `cleared` and `waiting`, as after a suspension is lifted), as one of the fixed codes (`tenant-not-provisioned`, `capacity-unavailable`, `service-start-failed`, `image-not-allowed`, and the endpoint checks'). The tenant sees the code and when, so a deploy waiting for `ready` can say why at once. Takes `system:deployments`.",
    tags: ['system-deployments'],
    security: 'bearer',
    parameters: [SystemTenantIdPathParam, SystemDeploymentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RecordDeploymentProblemBody') },
    responses: {
      '200': {
        description: "Recorded: the deployment's endpoint as its tenant sees it.",
        schema: ref('DeploymentEndpoint'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse('A malformed body, or a `code` not on the list (`bad-input`).'),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:deployments` (`system-scope-missing`).",
      ),
      '404': ErrorResponse(
        'No such tenant (`tenant-not-found`), or no such deployment in it (`deployment-not-found`).',
      ),
      '409': ErrorResponse(
        "The deployment's endpoint isn't waiting for a pack service: `ready`, or `cleared` and not `waiting` (`endpoint-not-pending`, with `details.status`).",
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/system/tenants/:tenantId/deployments/:deploymentId/suspended',
    openapiPath: '/v1/system/tenants/{tenantId}/deployments/{deploymentId}/suspended',
    operationId: 'systemDeployments.setSuspended',
    summary: "Suspend a deployment's pack, or restore it",
    description:
      "Suspended, the pack's calls fail closed (`pack-suspended`), never going to an older deployment of the same tool version; its endpoint can't be set again; and it lists to retire as `pack-suspended`. Restored, it serves again from the endpoint recorded for it; if that endpoint is pending or was cleared meanwhile, it lists as needing a pack service. Nothing is deleted. Refused for a closing tenant; a suspended tenant's pack can still be suspended or restored. Takes `system:suspend`, which the orchestrator's key doesn't hold; `system:deployments` is refused.",
    tags: ['system-deployments'],
    security: 'bearer',
    parameters: [SystemTenantIdPathParam, SystemDeploymentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('SetPackSuspendedBody') },
    responses: {
      '200': { description: 'Set.', schema: ref('PackSuspension') },
      ...CommonMutationErrors,
      '400': ErrorResponse('A malformed body (`bad-input`).'),
      '403': ErrorResponse(
        "A tenant's key or session (`system-principal-required`), or a system key without `system:suspend` (`system-scope-missing`).",
      ),
      '404': ErrorResponse(
        'No such tenant (`tenant-not-found`), or no such deployment in it (`deployment-not-found`).',
      ),
      '409': ErrorResponse(
        'The tenant is closing (`tenant-closing`): closing is one-way, and its deployments already list to retire.',
      ),
      '503': ErrorResponse(
        "The operator's access record can't be written, so nothing was done (`access-record-unavailable`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  // ---------- service accounts ----------
  {
    method: 'post',
    honoPath: '/v1/service-accounts',
    openapiPath: '/v1/service-accounts',
    operationId: 'serviceAccounts.create',
    summary: 'Create a service account',
    description:
      "A named, non-human principal with its first grants, written before it is returned. It isn't a tenant member unless a grant makes it one (`{kind: 'tenant-member'}`: read the tenant's settings); give it only what its job needs. Mint its keys at `POST /v1/tokens` with `for`. Tenant admins only. Mounted when the deployment supplies a `ServiceAccountBinding`.",
    tags: ['service-accounts'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateServiceAccountBody') },
    responses: {
      '201': { description: 'Created.', schema: ref('ServiceAccount') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('A grant names no project of this tenant (`project-not-found`).'),
      '409': ErrorResponse(
        'An active service account has the name (`service-account-name-taken`), or an idempotency conflict.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/service-accounts',
    openapiPath: '/v1/service-accounts',
    operationId: 'serviceAccounts.list',
    summary: 'List service accounts',
    description:
      'Oldest first; active only unless `?includeUnregistered=true`. Tenant admins only.',
    tags: ['service-accounts'],
    security: 'bearer',
    parameters: [
      CursorQueryParam,
      LimitQueryParam,
      {
        name: 'includeUnregistered',
        in: 'query',
        required: false,
        description: '`true`: unregistered accounts too.',
        schema: { type: 'string', enum: ['true', 'false'] },
      },
    ],
    responses: {
      '200': { description: 'A page of service accounts.', schema: ref('ServiceAccountPage') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/service-accounts/:serviceAccountId',
    openapiPath: '/v1/service-accounts/{serviceAccountId}',
    operationId: 'serviceAccounts.get',
    summary: 'Read a service account',
    description: 'Unregistered ones too. Tenant admins only.',
    tags: ['service-accounts'],
    security: 'bearer',
    parameters: [ServiceAccountIdPathParam],
    responses: {
      '200': { description: 'The service account.', schema: ref('ServiceAccount') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No such service account (`service-account-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/service-accounts/:serviceAccountId/grant',
    openapiPath: '/v1/service-accounts/{serviceAccountId}/grant',
    operationId: 'serviceAccounts.grant',
    summary: 'Grant a service account',
    description:
      "Tenant admin, or a role on a project (replacing the account's role there). Written before the call answers. Tenant admins only.",
    tags: ['service-accounts'],
    security: 'bearer',
    parameters: [ServiceAccountIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('ServiceAccountGrantBody') },
    responses: {
      '200': { description: 'The account, with its grants.', schema: ref('ServiceAccount') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse(
        'No such service account (`service-account-not-found`), or no such project (`project-not-found`).',
      ),
      '409': ErrorResponse(
        "The account is unregistered (`service-account-unregistered`), or a project's own account, whose grant is fixed (`service-account-project-owned`), or an idempotency conflict.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/service-accounts/:serviceAccountId/ungrant',
    openapiPath: '/v1/service-accounts/{serviceAccountId}/ungrant',
    operationId: 'serviceAccounts.ungrant',
    summary: 'Remove a grant from a service account',
    description: 'A no-op when the account does not hold it. Tenant admins only.',
    tags: ['service-accounts'],
    security: 'bearer',
    parameters: [ServiceAccountIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('ServiceAccountUngrantBody') },
    responses: {
      '200': { description: 'The account, with its grants.', schema: ref('ServiceAccount') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No such service account (`service-account-not-found`).'),
      '409': ErrorResponse(
        "A project's own account, whose grant is fixed (`service-account-project-owned`), or an idempotency conflict.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/service-accounts/:serviceAccountId/unregister',
    openapiPath: '/v1/service-accounts/{serviceAccountId}/unregister',
    operationId: 'serviceAccounts.unregister',
    summary: 'Unregister a service account',
    description:
      "A tombstone: its grants go and its keys stop working; it stays readable. Idempotent. Tenant admins only. Unregistering a project's own account stops the triggers that run as it until an admin takes each over; the next `runAsProject` makes a new one.",
    tags: ['service-accounts'],
    security: 'bearer',
    parameters: [ServiceAccountIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'The unregistered account.', schema: ref('ServiceAccount') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No such service account (`service-account-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/tokens/public',
    openapiPath: '/v1/tokens/public',
    operationId: 'tokens.mintPublic',
    summary: 'Mint a public run token',
    description:
      'A short-lived, read-only token for up to 50 runs (and their descendants), to hand to a browser: it can only call `GET /v1/runs/{runId}/progress` and `GET /v1/runs/{runId}/progress/stream`. Stateless: it cannot be revoked one by one, so keep lifetimes short. Mounted when the deployment issues public run tokens.',
    tags: ['tokens'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('MintPublicRunTokenBody') },
    responses: {
      '201': { description: 'Token minted.', schema: ref('MintPublicRunTokenResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key reused with a different body (`idempotency-key-body-mismatch`), or a retry of a request that succeeded: its answer carried a secret, which isn't kept (`idempotency-key-replay-withheld`, with its `status` and `at`).",
      ),
      '400': ErrorResponse('Malformed body, or `expiresInSeconds` above the deployment maximum.'),
      '403': ErrorResponse('The caller may not read one of the runs (`permission-denied`).'),
      '404': ErrorResponse('A run does not exist under this tenant (`run-not-found`).'),
    },
  },

  // ---------- approvals (HITL) ----------
  {
    method: 'get',
    honoPath: '/v1/approvals',
    openapiPath: '/v1/approvals',
    operationId: 'approvals.list',
    summary: 'List approvals visible to the caller',
    description:
      "Requires a reviewer: a token that carries a `reviewerRole`, or whose user is a registered reviewer (the roster gives the role). With authorization on, a person who is the tenant's admin (through a session or an `admin` key not limited to a project) reads at every tier: with no roster entry, as an `admin` reviewer; with a lower role, their own tier, and any tier they ask for with `requiredRole`. The roster doesn't show such a reader, but the access audit records the tenant-admin check (`authz-decision`), made only where it changes what the roster gives. Role-scoped: reviewers only see approvals whose `requiredRole` rank ≤ their rank (standard < senior < admin). With authorization on, only approvals whose project the caller may read. `scopeKind`/`scopeId` narrow to one project's approvals, or every project's in an org; approvals from before Kindgi 0.1.3 have no project and are listed only without a scope.",
    tags: ['approvals'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      ApprovalStatusQueryParam,
      ApprovalAssignedToQueryParam,
      ApprovalDecidedByQueryParam,
      ApprovalOrderQueryParam,
      ApprovalRequiredRoleQueryParam,
      CreatedAfterQueryParam,
      WaitTokenIdQueryParam,
      {
        name: 'runId',
        in: 'query',
        required: false,
        description: 'Only the approvals this run asked for.',
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'includeDescendants',
        in: 'query',
        required: false,
        description:
          "With `runId`: also the approvals its child runs asked for, at any depth (a flow's agent steps).",
        schema: { type: 'boolean' },
      },
    ],
    responses: {
      '200': { description: 'Page of approvals.', schema: ref('ApprovalCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter or scope.'),
      '403': ErrorResponse(
        "The caller isn't a reviewer or the tenant's admin, or asked for a tier above its own and isn't the tenant's admin.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/approvals/:approvalId',
    openapiPath: '/v1/approvals/{approvalId}',
    operationId: 'approvals.get',
    summary: 'Fetch a single approval',
    description:
      "Requires a reviewer, or (with authorization on) a person who is the tenant's admin, as the list does; the tenant's admin reads an approval of any tier. Returns 404 for ids that exist but require a higher role than the caller (avoids cross-tier existence leaks — see API-ROUTE-CONVENTIONS.md §2.4), or that are in a project the caller may not read. A decided approval carries its `decision`: what the reviewer decided, why, and who (`decidedBy`, `user:<userId>`).",
    tags: ['approvals'],
    security: 'bearer',
    parameters: [ApprovalIdPathParam],
    responses: {
      '200': { description: 'Approval.', schema: ref('Approval') },
      ...CommonAuthErrors,
      '403': ErrorResponse("The caller isn't a reviewer or the tenant's admin."),
      '404': ErrorResponse('No approval with that id — or the caller cannot see it.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/approvals/:approvalId/complete',
    openapiPath: '/v1/approvals/{approvalId}/complete',
    operationId: 'approvals.complete',
    summary: 'Submit a decision on an approval',
    description:
      "Records the decision (`HitlBinding.submitReview`). When the approval carries a `waitTokenId` and the decision is `approve` or `reject`, also completes the waitpoint so the suspended run resumes, with `{ decided, rationale?, decidedBy, approvalId }`: the run's journal records who decided which approval (`decidedBy` is `user:<userId>`).",
    tags: ['approvals'],
    security: 'bearer',
    parameters: [ApprovalIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CompleteApprovalBody') },
    responses: {
      '200': {
        description: 'Decision recorded.',
        schema: ref('CompleteApprovalResult'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse('Reviewer role too low, or no reviewer row for this user.'),
      '404': ErrorResponse('No approval visible to the caller with that id.'),
    },
  },

  // ---------- reviewers (roster sub-resource under /v1/approvals/reviewers) ----------
  {
    method: 'get',
    honoPath: '/v1/approvals/reviewers',
    openapiPath: '/v1/approvals/reviewers',
    operationId: 'approvals.reviewers.list',
    summary: "List reviewers registered for the caller's tenant",
    description:
      'Cursor-paginated. Optional `?role=` narrows to a specific role class. The roster names people: with authorization on, a tenant admin or a reviewer (a role on the token, or one the roster gives the user) reads it, and anyone else gets `403 permission-denied`.',
    tags: ['approvals'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam, ReviewerRoleQueryParam],
    responses: {
      '200': { description: 'Page of reviewers.', schema: ref('ReviewerCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/approvals/reviewers/:reviewerId',
    openapiPath: '/v1/approvals/reviewers/{reviewerId}',
    operationId: 'approvals.reviewers.get',
    summary: 'Fetch a reviewer',
    description:
      'With authorization on, a tenant admin or a reviewer reads it, as the roster; anyone else gets `403 permission-denied`.',
    tags: ['approvals'],
    security: 'bearer',
    parameters: [ReviewerIdPathParam],
    responses: {
      '200': { description: 'Reviewer.', schema: ref('Reviewer') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No reviewer with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/approvals/reviewers',
    openapiPath: '/v1/approvals/reviewers',
    operationId: 'approvals.reviewers.register',
    summary: 'Register a reviewer',
    description:
      'Idempotent by `(tenantId, userId)`. Re-registering rotates role/displayName rather than inserting a duplicate row.',
    tags: ['approvals'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterReviewerBody') },
    responses: {
      '201': { description: 'Reviewer registered.', schema: ref('Reviewer') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "With authorization enforced, the caller is not an admin of the tenant; or the person is one a site signs in, whose reviewer role is their site's to give (`site-person-grants-managed`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/approvals/reviewers/:reviewerId/unregister',
    openapiPath: '/v1/approvals/reviewers/{reviewerId}/unregister',
    operationId: 'approvals.reviewers.unregister',
    summary: 'Unregister (soft-delete) a reviewer',
    description:
      'Soft-delete so the audit trail survives — reviewer stops receiving new approvals but historical decisions still resolve.',
    tags: ['approvals'],
    security: 'bearer',
    parameters: [ReviewerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterReviewerResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No reviewer with that id under this tenant.'),
      '403': ErrorResponse(
        'With authorization enforced, the caller is not an admin of the tenant; or the person is one a site signs in, whose grants their site gives back at their next sign-in: remove the person, change their role on the site, or pause the site instead (`site-person-grants-managed`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/approvals/:approvalId/audit-bundle',
    openapiPath: '/v1/approvals/{approvalId}/audit-bundle',
    operationId: 'approvals.auditBundle',
    summary: 'Export a signed audit bundle for a decided approval',
    description:
      "Signs the approval, its decision and its evidence with the deployment's export key, and records the export (an `export-signed` audit event). The same envelope as the other signed exports, so one verifier reads all three; check `publicKey` against `GET /v1/export-signing-keys`. For a decided approval only (approved, rejected, escalated, expired, withdrawn): a pending one is `409 approval-not-decided`. A deployment with no export key answers `404 signing-not-configured`.",
    tags: ['approvals'],
    security: 'bearer',
    parameters: [ApprovalIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('ExportAuditBundleBody') },
    responses: {
      '200': { description: 'Signed audit bundle.', schema: ref('ExportAuditBundleResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse("The caller isn't a reviewer."),
      '404': ErrorResponse(
        'Approval not found, signing key id unknown, or signing not configured on this deployment.',
      ),
    },
  },

  // ---------- agents ----------
  {
    method: 'get',
    honoPath: '/v1/agents',
    openapiPath: '/v1/agents',
    operationId: 'agents.list',
    summary: 'List agents',
    description:
      'Cursor-paginated list of the latest version per agent id. Optional `?name=` filters by prefix on agent id. A retired agent (every version unregistered) is listed only with `?includeRetired=true`, as its highest version with `unregisteredAt`, so it can be found and a version reinstated.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      AgentNameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
      IncludeRetiredQueryParam,
    ],
    responses: {
      '200': { description: 'Page of agents.', schema: ref('AgentCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId',
    openapiPath: '/v1/agents/{agentId}',
    operationId: 'agents.get',
    summary: 'Fetch the latest version of an agent',
    description: NEWEST_VISIBLE_DESCRIPTION,
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, ItemProjectQueryParam],
    responses: {
      '200': { description: 'Agent.', schema: ref('Agent') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`projectId` is not a project id (a UUID).'),
      '404': ErrorResponse('No agent with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/projects',
    openapiPath: '/v1/agents/{agentId}/projects',
    operationId: 'agents.projects',
    summary: 'List the projects an agent runs in',
    description:
      'The project the agent was first published in, then each other project a version of it can run in: one that a deployment which is not retired shipped a version into, an unregistered version included. A change to the agent reaches each of them. Only the projects the caller can read are named, its first project included. A retired agent still answers. Without environment orders, an agent has one project. Under `kindgi dev`, whose pack names no project, the list is empty.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam],
    responses: {
      '200': { description: 'The projects.', schema: ref('AgentProjectList') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No agent with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/versions',
    openapiPath: '/v1/agents/{agentId}/versions',
    operationId: 'agents.listVersions',
    summary: 'List versions of an agent',
    description:
      'Cursor-paginated. Sort order is binding-defined (built-in registry: semver asc). Defaults to active versions only. Pass `?includeTombstoned=true` to include unregistered versions too, each with `unregisteredAt`: a retired agent (every version unregistered) answers too, with its versions to reinstate.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, LimitQueryParam, CursorQueryParam, IncludeTombstonedQueryParam],
    responses: {
      '200': { description: 'Page of agent versions.', schema: ref('AgentCollectionPage') },
      '400': ErrorResponse("`bad-input`: a `cursor` this list didn't issue."),
      ...CommonAuthErrors,
      '404': ErrorResponse('No agent was ever registered with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/versions',
    openapiPath: '/v1/agents/{agentId}/versions',
    operationId: 'agents.deriveVersion',
    summary: 'Derive an agent version with data-block pins swapped',
    description:
      "An expert's edit, without a code change: a new agent version that is `from`'s bag with some prompt or settings pins swapped (`derivedFrom: { version, reason: 'edited', label, by }`), numbered the next free patch after the agent's highest version. Only blocks `from` already references swap, to a published, active version of the right kind (model settings for the model-settings block); tool pins come from code. Needs `publish` on the agent. In a tenant with environment orders, the new version is made in the first environment of the agent's project's order, and reaches the later ones when a build of the agent is promoted; the agent's project doesn't change.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('DeriveAgentVersionBody') },
    responses: {
      '200': {
        description:
          'An active version already holds this definition and these pins (the same swap derived before, or a deploy that registered it): that version, unchanged.',
        schema: ref('Agent'),
      },
      '201': { description: 'The derived agent version.', schema: ref('Agent') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `agent-project-mismatch`: the agent belongs to another project than the body's `projectId` (agents never move; the message doesn't name the project). Or `environment-takes-promotions`: the body's `projectId` is a later environment of an environment order, where no new version is made; leave it out, or name the order's first environment (`details.firstProjectId`, when you can read that project; `details.position`, the project's place from 0). Nothing is written. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '400': ErrorResponse(
        "`validation-failed`: `from` has no pins, a swap names a block it doesn't reference, or a version that isn't published, active or the right kind (see `details.issues`); or `projectId` isn't a project id (a UUID).",
      ),
      '404': ErrorResponse(
        '`agent-not-found`: no agent at `from`; or `projectId` names no project of this tenant (`project-not-found`).',
      ),
      '429': SCHEMA_COMPILE_BUDGET,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/versions/:version',
    openapiPath: '/v1/agents/{agentId}/versions/{version}',
    operationId: 'agents.getVersion',
    summary: 'Fetch a specific agent version',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, AgentVersionPathParam],
    responses: {
      '200': { description: 'Agent version.', schema: ref('Agent') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No agent at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents',
    openapiPath: '/v1/agents',
    operationId: 'agents.publish',
    summary: 'Publish an agent definition',
    description:
      'Body is a full `defineAgent` spec. Server validates via `@kindgi/agents.defineAgent` before persisting.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PublishAgentBody') },
    responses: {
      '201': { description: 'Agent published.', schema: ref('PublishAgentResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID). Or `reference-out-of-scope`: a tool, guardrail or data block it names isn't registered in its project, its org or the tenant (`details.issues`, each with `path`, `kind` and `id`).",
      ),
      '409': ErrorResponse(
        `\`agent-already-registered\`: that (id, version) is taken. Or \`agent-project-mismatch\`: the agent's versions live in another project (an agent belongs to the project its first version was published into and never moves, though in a tenant with environment orders a version may be made in another project of that project's order; the message doesn't name the project). ${TAKES_PROMOTIONS} Or \`registry-read-only\`: this registry takes no writes (under \`kindgi dev\`, the pack's files are the source); the message says what to do instead.`,
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '429': SCHEMA_COMPILE_BUDGET,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/versions/:version/unregister',
    openapiPath: '/v1/agents/{agentId}/versions/{version}/unregister',
    operationId: 'agents.unregister',
    summary: 'Unregister a specific agent version',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, AgentVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterAgentResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead. Or `agent-version-pinned`: the version is the pinned version of the scopes in `details.scopes`; unpin, or pin another version there first.",
      ),
      '404': ErrorResponse('No agent at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/versions/:version/reinstate',
    openapiPath: '/v1/agents/{agentId}/versions/{version}/reinstate',
    operationId: 'agents.reinstateVersion',
    summary: 'Reinstate a specific tombstoned agent version',
    description:
      'Un-tombstones a previously-unregistered version: clears the tombstone on that version and recomputes the latest active version. Restores the manifest bytes verbatim (semver hygiene: reinstate never mutates). Idempotent — reinstating an active version is a no-op (returns `wasTombstoned: false`). Reinstating any version of a fully-retired agent reactivates the identity: subsequent GETs return 200, invocations succeed. Publish is always allowed regardless of retirement state — this verb is for restoring previously-unregistered bytes, not for reactivating a retired identity (a fresh publish does that).',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, AgentVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Reinstated.', schema: ref('ReinstateAgentVersionResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "`reference-out-of-scope`: the retired version names an item its project doesn't reach (`details.issues`), as publishing it would be refused; it stays retired.",
      ),
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No agent at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/pinned',
    openapiPath: '/v1/agents/{agentId}/pinned',
    operationId: 'agents.pinned.resolve',
    summary: 'The version a run would use',
    description:
      "Resolves the version a run of this agent would use for a project and segment path: the most specific pinned version (segment path, project, org, tenant), else the latest registered. A run that names its version, or a follow-up turn in a conversation, isn't resolved this way.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, AgentPinProjectQueryParam, SegmentQueryParam],
    responses: {
      '200': { description: 'The resolved version.', schema: ref('AgentPinnedVersionResolution') },
      ...CommonAuthErrors,
      '400': ErrorResponse('A malformed project id or segment, or a segment without a project.'),
      '404': ErrorResponse('No agent with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/pinned-versions',
    openapiPath: '/v1/agents/{agentId}/pinned-versions',
    operationId: 'agents.pinned.list',
    summary: "List an agent's pinned versions",
    description: 'Every scope with a pinned version, and the pin change that set it.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam],
    responses: {
      '200': { description: 'The pins.', schema: ref('AgentPinnedVersionList') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/pinned/pin',
    openapiPath: '/v1/agents/{agentId}/pinned/pin',
    operationId: 'agents.pinned.pin',
    summary: 'Pin a version for a scope',
    description:
      "Pins `version` for `scope`: runs in that scope that don't name a version use it, from the next run. Open conversations keep their version. The version must be registered and active. Every pin is recorded, with who asked and why. Needs `pin` on the agent.\n\nWith a gate policy for the scope (`GET …/gate-policy`), the pin is checked first against the comparison named by `testRunId`: `201` pinned; `202` the gate passed and the policy wants a reviewer's approval (a HITL approval, subject `agent-pin`; the pinned version moves once it's approved, if nothing changed meanwhile); `422 gate-failed` with `details.changeId`, `details.policy` and every check in `details.checks`. A refused pin is recorded too.\n\nA pin in place skips the gate: when the scope has no pinned version of its own and already serves exactly `version` (from a scope above, or as the latest), pinning it there changes nothing any run gets, so it is pinned (`201`) with one passing `pinInPlace` check, no comparison and no approval, its reason starting `pin-in-place`. It is re-checked as it is written; if the scope moved meanwhile, `409 pin-superseded`: check again.\n\nUnder `kindgi dev`, nothing is pinned, since the pack's files are what runs: pinning a version writes the data blocks it changes into the pack's own files (each block's new version and content, and a prompt's template into its template file), and the dev server reloads them. Only for the whole tenant, which the pack's files serve. If one of those files changed since the version was made (the changed block's file holds another version than the one its suggested change changed, or another block's file a version not older), or the block left the pack, `409 pin-superseded`, and the message names the file; an approval's decision settles it `superseded` the same way.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('AgentPinBody') },
    responses: {
      '201': { description: 'Pinned.', schema: ref('Pin') },
      '202': {
        description: 'The gate passed; the pin waits for an approval (`approvalId`).',
        schema: ref('Pin'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed request body. Or `reference-out-of-scope`: a project scope whose project doesn't reach the agent (`details.issues`).",
      ),
      '404': ErrorResponse(
        'The version is not registered, or was unregistered; or the test run is not found.',
      ),
      '409': ErrorResponse(
        "`pin-superseded`: the scope's pinned version changed while the gate ran; check again. `gate-policy-descendant-unpinned`: the change would also move a narrower scope a gate policy applies to, which has no pinned version of its own and so follows this scope, without its gate; the message names each one: pin it at its current version first. `pin-scope-spans-environments`: the agent has a project in an environment order, and a tenant- or org-wide pin would act in every environment of the order at once; pin a project (or a segment of it) instead. Under `kindgi dev`, `pin-superseded` also when a pack file the version's data blocks go into changed since the version was made, or the block left the pack; the message names the file. Or `registry-read-only`: under `kindgi dev`, a scope narrower than the whole tenant, since the pack's files serve every scope.",
      ),
      '422': ErrorResponse(
        '`gate-failed`: the gate refused it. `details.checks` has every check; the refusal is recorded (`details.changeId`).',
      ),
      '429': ErrorResponse(
        "`approvals-pending-limit`: the gate wants an approval, and the tenant's approvals waiting for a decision are at its limit (set by the runtime's operator). Nothing is recorded.",
      ),
      '501': ErrorResponse(
        "`pin-gate-unsupported`: a gate policy applies, and the deployment can't record a gated pin.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/pinned/check',
    openapiPath: '/v1/agents/{agentId}/pinned/check',
    operationId: 'agents.pinned.check',
    summary: 'Check a pin against its gate',
    description:
      'What `POST …/pinned/pin` with the same body would do, with nothing recorded: `would-pin`, `needs-approval` (with the approval it needs) or `gate-failed`, with every check. For a pipeline: evaluate, check, pin. Needs `read` on the agent.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam],
    requestBody: { required: true, schema: ref('AgentPinBody') },
    responses: {
      '200': { description: "The gate's answer.", schema: ref('PinCheck') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "Malformed body, or the test run is not a finished comparison. Or `reference-out-of-scope`: a project scope whose project doesn't reach the agent (`details.issues`).",
      ),
      '404': ErrorResponse('The version, the agent or the test run is not found.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/gate-policy',
    openapiPath: '/v1/agents/{agentId}/gate-policy',
    operationId: 'agents.gatePolicy.resolve',
    summary: 'The gate policy for a scope',
    description:
      "The gate policy a promotion of the agent for the scope would be checked against: the most specific scope with an active policy (a segment path's longer prefixes first, then its project, the project's org, the tenant), at its latest active version. `policy: null` when none applies.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, PinScopeKindQueryParam, ScopeIdQueryParam, SegmentQueryParam],
    responses: {
      '200': { description: 'The policy, or null.', schema: ref('GatePolicyResolution') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/gate-policies',
    openapiPath: '/v1/gate-policies',
    operationId: 'gatePolicies.list',
    summary: 'List gate policies',
    description:
      "Each gate policy's latest active version. `agentId` narrows it to one agent's; `scopeKind` (with `scopeId` and `segment`) to one scope's.",
    tags: ['gate-policies'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'agentId',
        in: 'query',
        required: false,
        description: 'Only the policies gating this agent.',
        schema: { type: 'string' },
      },
      PinScopeKindQueryParam,
      ScopeIdQueryParam,
      SegmentQueryParam,
    ],
    responses: {
      '200': { description: 'Page of gate policies.', schema: ref('GatePolicyPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed scope or cursor.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/gate-policies',
    openapiPath: '/v1/gate-policies',
    operationId: 'gatePolicies.publish',
    summary: 'Publish a gate policy',
    description:
      "Registers a gate policy, or a new version of one: what a promotion of `agentId` for `scope` must show. One policy per agent and scope: another policy id for a scope that has one is refused with `409 gate-policy-scope-taken` (`details.heldBy` names it; publish a new version of that one instead), and a new version can't change the agent or scope (`409 gate-policy-scope-changed`). The `spec` is checked strictly: an unknown key is refused (`400 validation-failed`, `details.issues`). Needs `admin` on the tenant: whoever may promote can't loosen their own gate.",
    tags: ['gate-policies'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PublishGatePolicyBody') },
    responses: {
      '201': { description: 'Gate policy published.', schema: ref('GatePolicy') },
      ...CommonMutationErrors,
      '400': ErrorResponse('Validation failed (see `details.issues`).'),
      '409': ErrorResponse(
        '`gate-policy-already-registered`: that (id, version) exists. `gate-policy-scope-taken`: another policy gates the agent for the scope (`details.heldBy`). `gate-policy-scope-changed`: the version would change the agent or scope. `gate-policy-scope-unpinned`: the scope has no pinned version of its own; a gated scope holds its own pin (a pin above it is not enough, since a promotion there would change this scope ungated), so pin a version for the scope first.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/gate-policies/:policyId',
    openapiPath: '/v1/gate-policies/{policyId}',
    operationId: 'gatePolicies.get',
    summary: 'Get a gate policy',
    description: "The policy's latest active version.",
    tags: ['gate-policies'],
    security: 'bearer',
    parameters: [GatePolicyIdPathParam],
    responses: {
      '200': { description: 'The gate policy.', schema: ref('GatePolicy') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No active gate policy with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/gate-policies/:policyId/versions',
    openapiPath: '/v1/gate-policies/{policyId}/versions',
    operationId: 'gatePolicies.versions.list',
    summary: "List a gate policy's versions",
    description: 'Every version, oldest first, unregistered ones too (with `unregisteredAt`).',
    tags: ['gate-policies'],
    security: 'bearer',
    parameters: [GatePolicyIdPathParam],
    responses: {
      '200': { description: 'The versions.', schema: ref('GatePolicyPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No gate policy with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/gate-policies/:policyId/versions/:version',
    openapiPath: '/v1/gate-policies/{policyId}/versions/{version}',
    operationId: 'gatePolicies.versions.get',
    summary: 'Get a gate policy version',
    tags: ['gate-policies'],
    security: 'bearer',
    parameters: [GatePolicyIdPathParam, GatePolicyVersionPathParam],
    responses: {
      '200': { description: 'The version.', schema: ref('GatePolicy') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such version.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/gate-policies/:policyId/versions/:version/unregister',
    openapiPath: '/v1/gate-policies/{policyId}/versions/{version}/unregister',
    operationId: 'gatePolicies.versions.unregister',
    summary: 'Unregister a gate policy version',
    description:
      "The version stops applying; the policy's latest remaining active version applies, or, with none, the scope above's policy. Promotions keep the version they were checked against. Needs `admin` on the tenant.",
    tags: ['gate-policies'],
    security: 'bearer',
    parameters: [GatePolicyIdPathParam, GatePolicyVersionPathParam],
    responses: {
      '200': { description: 'The unregistered version.', schema: ref('GatePolicy') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such version.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/gate-policies/:policyId/versions/:version/reinstate',
    openapiPath: '/v1/gate-policies/{policyId}/versions/{version}/reinstate',
    operationId: 'gatePolicies.versions.reinstate',
    summary: 'Reinstate a gate policy version',
    description: 'Needs `admin` on the tenant.',
    tags: ['gate-policies'],
    security: 'bearer',
    parameters: [GatePolicyIdPathParam, GatePolicyVersionPathParam],
    responses: {
      '200': { description: 'The reinstated version.', schema: ref('GatePolicy') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such version.'),
      '409': ErrorResponse(
        '`gate-policy-scope-taken`: another policy gates the agent for the scope now (`details.heldBy`). `gate-policy-scope-unpinned`: the scope has no pinned version of its own; pin one first.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/pin-history',
    openapiPath: '/v1/agents/{agentId}/pin-history',
    operationId: 'agents.pinned.history',
    summary: "List an agent's pin history",
    description:
      'The history of pinned-version changes (pins and unpins), newest first. `scopeKind` (`tenant`, `org`, `project`, `segment`) with `scopeId` and `segment` narrows it to one scope.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [
      AgentIdPathParam,
      LimitQueryParam,
      CursorQueryParam,
      PinScopeKindQueryParam,
      ScopeIdQueryParam,
      SegmentQueryParam,
    ],
    responses: {
      '200': { description: 'Page of pin changes.', schema: ref('PinPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed scope or cursor.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/pin-history/:changeId',
    openapiPath: '/v1/agents/{agentId}/pin-history/{changeId}',
    operationId: 'agents.pinned.getChange',
    summary: 'Get a pin change',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, PinChangeIdPathParam],
    responses: {
      '200': { description: 'The pin change.', schema: ref('Pin') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such pin change for this agent.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/pinned/unpin',
    openapiPath: '/v1/agents/{agentId}/pinned/unpin',
    operationId: 'agents.pinned.unpin',
    summary: "Remove a scope's pinned version",
    description:
      "Removes the scope's own pin: its runs use the next scope up (and the latest when nothing is pinned). Recorded like a pin. Needs `pin` on the agent.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('AgentUnpinBody') },
    responses: {
      '200': { description: 'Unpinned.', schema: ref('Pin') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "`not-pinned`: the scope has no pin of its own. `gate-policy-needs-pin`: the scope has a gate policy of its own, and a gated scope keeps its own pin; unregister the policy first, or pin another version instead. `gate-policy-descendant-unpinned`: the change would also move a narrower scope a gate policy applies to, which has no pinned version of its own and so follows this scope, without its gate; the message names each one: pin it at its current version first. Or `registry-read-only`: under `kindgi dev`, a pinned version was written into the pack's files; undo it there, with git.",
      ),
    },
  },

  // ---------- flows ----------
  {
    method: 'get',
    honoPath: '/v1/flows',
    openapiPath: '/v1/flows',
    operationId: 'flows.list',
    summary: 'List flows',
    description:
      'Cursor-paginated list of the latest version per flow id. Optional `?name=` filters by prefix on flow id. A retired flow (every version unregistered) is listed only with `?includeRetired=true`, as its highest version with `unregisteredAt`, so it can be found and a version reinstated.',
    tags: ['flows'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      FlowNameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
      IncludeRetiredQueryParam,
    ],
    responses: {
      '200': { description: 'Page of flows.', schema: ref('FlowCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/flows/:flowId',
    openapiPath: '/v1/flows/{flowId}',
    operationId: 'flows.get',
    summary: 'Fetch the latest version of a flow',
    description: NEWEST_VISIBLE_DESCRIPTION,
    tags: ['flows'],
    security: 'bearer',
    parameters: [FlowIdPathParam, ItemProjectQueryParam],
    responses: {
      '200': { description: 'Flow.', schema: ref('Flow') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`projectId` is not a project id (a UUID).'),
      '404': ErrorResponse('No flow with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/flows/:flowId/versions',
    openapiPath: '/v1/flows/{flowId}/versions',
    operationId: 'flows.listVersions',
    summary: 'List versions of a flow',
    description:
      'Cursor-paginated. Sort order is binding-defined (for example semver asc). Defaults to active versions only. Pass `?includeTombstoned=true` to include unregistered versions too, each with `unregisteredAt`: a retired flow (every version unregistered) answers too, with its versions to reinstate.',
    tags: ['flows'],
    security: 'bearer',
    parameters: [FlowIdPathParam, LimitQueryParam, CursorQueryParam, IncludeTombstonedQueryParam],
    responses: {
      '200': { description: 'Page of flow versions.', schema: ref('FlowCollectionPage') },
      '400': ErrorResponse("`bad-input`: a `cursor` this list didn't issue."),
      ...CommonAuthErrors,
      '404': ErrorResponse('No flow was ever registered with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/flows/:flowId/versions/:version',
    openapiPath: '/v1/flows/{flowId}/versions/{version}',
    operationId: 'flows.getVersion',
    summary: 'Fetch a specific flow version',
    tags: ['flows'],
    security: 'bearer',
    parameters: [FlowIdPathParam, FlowVersionPathParam],
    responses: {
      '200': { description: 'Flow version.', schema: ref('Flow') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No flow at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/flows',
    openapiPath: '/v1/flows',
    operationId: 'flows.publish',
    summary: 'Publish a flow definition',
    description:
      'Body is a full flow JSON. Server validates via `@kindgi/flow.loadFlow` before persisting. Node handler code is not uploaded through this route.',
    tags: ['flows'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PublishFlowBody') },
    responses: {
      '201': { description: 'Flow published.', schema: ref('PublishFlowResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID). Or `reference-out-of-scope`: a tool, agent or subflow it names isn't registered in its project, its org or the tenant (`details.issues`, each with `path`, `kind` and `id`).",
      ),
      '409': ErrorResponse(
        `\`flow-already-registered\`: that (id, version) is taken. Or \`flow-project-mismatch\`: the flow's versions live in another project (a flow belongs to the project its first version was published into and never moves, though in a tenant with environment orders a version may be made in another project of that project's order; the message doesn't name the project). ${TAKES_PROMOTIONS} Or \`registry-read-only\`: this registry takes no writes (under \`kindgi dev\`, the pack's files are the source); the message says what to do instead.`,
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '429': SCHEMA_COMPILE_BUDGET,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/flows/:flowId/versions/:version/unregister',
    openapiPath: '/v1/flows/{flowId}/versions/{version}/unregister',
    operationId: 'flows.unregister',
    summary: 'Unregister a specific flow version',
    tags: ['flows'],
    security: 'bearer',
    parameters: [FlowIdPathParam, FlowVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterFlowResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `flow-version-pinned`: the version is pinned in one or more scopes (`details.scopes`); move those pins to another version, or unpin them, first. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No flow at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/flows/:flowId/versions/:version/reinstate',
    openapiPath: '/v1/flows/{flowId}/versions/{version}/reinstate',
    operationId: 'flows.reinstateVersion',
    summary: 'Reinstate a specific tombstoned flow version',
    description:
      'Un-tombstones a previously-unregistered version: clears the tombstone on that version and recomputes the latest active version. Restores the manifest bytes verbatim (semver hygiene). Idempotent — reinstating an active version returns `wasTombstoned: false`. Reactivates a fully-retired flow identity when applicable. Publish is always allowed regardless of retirement state — this verb restores previously-published bytes; a fresh publish is the way to bring a flow back with new bytes.',
    tags: ['flows'],
    security: 'bearer',
    parameters: [FlowIdPathParam, FlowVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Reinstated.', schema: ref('ReinstateFlowVersionResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "`reference-out-of-scope`: the retired version names an item its project doesn't reach (`details.issues`), as publishing it would be refused; it stays retired.",
      ),
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No flow at that (id, version) under this tenant.'),
    },
  },
  ...pinnedVersionOperations(FLOW_PINS),

  // ---------- tools ----------
  {
    method: 'get',
    honoPath: '/v1/tools',
    openapiPath: '/v1/tools',
    operationId: 'tools.list',
    summary: 'List tools',
    description:
      'Cursor-paginated list of registered tool manifests. Optional `?name=` filters by prefix on tool id. A retired tool (every version unregistered) is listed only with `?includeRetired=true`, as its highest version with `unregisteredAt`, so it can be found and a version reinstated.',
    tags: ['tools'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      NameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
      IncludeRetiredQueryParam,
    ],
    responses: {
      '200': { description: 'Page of tools.', schema: ref('ToolCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/tools/:toolId',
    openapiPath: '/v1/tools/{toolId}',
    operationId: 'tools.get',
    summary: 'Fetch a tool manifest (latest active version)',
    description: `Returns the latest active version of the tool. When all versions are unregistered (retired), the head row still exists but has no active version — the response is 410 tool-gone with the id, distinct from 404 tool-not-found (never registered). ${NEWEST_VISIBLE_DESCRIPTION}`,
    tags: ['tools'],
    security: 'bearer',
    parameters: [ToolIdPathParam, ItemProjectQueryParam],
    responses: {
      '200': { description: 'Tool manifest.', schema: ref('Tool') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`projectId` is not a project id (a UUID).'),
      '404': ErrorResponse('No tool with that id under this tenant.'),
      '410': ErrorResponse('Tool retired (all versions unregistered).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/tools/:toolId/versions',
    openapiPath: '/v1/tools/{toolId}/versions',
    operationId: 'tools.listVersions',
    summary: 'List all versions of a tool',
    description:
      'Cursor-paginated list of tool versions. Defaults to active versions only. Pass `?includeTombstoned=true` to include soft-tombstoned rows too; tombstoned rows carry `unregisteredAt` (ISO string), active rows do not.',
    tags: ['tools'],
    security: 'bearer',
    parameters: [ToolIdPathParam, LimitQueryParam, CursorQueryParam, IncludeTombstonedQueryParam],
    responses: {
      '200': { description: 'Page of tool versions.', schema: ref('ToolVersionCollectionPage') },
      '400': ErrorResponse("`bad-input`: a `cursor` this list didn't issue."),
      ...CommonAuthErrors,
      '404': ErrorResponse('No tool with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/tools/:toolId/versions/:version',
    openapiPath: '/v1/tools/{toolId}/versions/{version}',
    operationId: 'tools.getVersion',
    summary: 'Fetch a specific tool version',
    tags: ['tools'],
    security: 'bearer',
    parameters: [ToolIdPathParam, ToolVersionPathParam],
    responses: {
      '200': { description: 'Tool manifest at the requested version.', schema: ref('Tool') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No tool at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/tools',
    openapiPath: '/v1/tools',
    operationId: 'tools.register',
    summary: 'Register a tool manifest',
    description:
      "Body is a `ToolManifest` (Tool minus its runtime handler). Server validates via `@kindgi/tools.validateToolManifest`. Metadata only: the handler is not uploaded through this route and must already be available to the runtime. A tool never gets a model provider's key: one that declares (`needsSpec.secrets`) or sends (`spec.authorization.secretRef`) a secret a provider registration of the tenant names, in any env, is refused. Where each secret it names is read is recorded on the version (`secretScopes`): the first of its own scope, its project's org and the tenant that has the secret and that the caller administers, else the broadest they administer; the runtime reads it there only.",
    tags: ['tools'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterToolBody') },
    responses: {
      '201': { description: 'Tool registered.', schema: ref('RegisterToolResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID). Or `provider-key-refused`: the tool names a model provider's key (`details.secret`, `details.providerId`); store the key it needs under its own name (the same value is fine) and name that. Or `reserved-name-prefix`: the tool names a secret under the reserved `kindgi.` prefix (`details.secret`); those are Kindgi's own. Or `validation-failed` for a `metadata` key under `kindgi.`: those are the runtime's own (`details.issues`, at `/metadata/<key>`).",
      ),
      '409': ErrorResponse(
        `\`tool-already-registered\`: that (id, version) is taken. Or \`tool-project-mismatch\`: the tool's versions live in another project (a tool belongs to the project its first version was published into and never moves, though in a tenant with environment orders a version may be made in another project of that project's order; the message doesn't name the project). Or \`tool-kind-mismatch\`: the tool's active versions are of another kind, an MCP endpoint's tool (\`details.endpointId\`) where this version is published here, or the other way round; a tool's active versions are all one kind, and nothing was written (\`details.toolId\`, \`details.version\`). ${TAKES_PROMOTIONS} Or \`registry-read-only\`: this registry takes no writes (under \`kindgi dev\`, the pack's files are the source); the message says what to do instead.`,
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '429': SCHEMA_COMPILE_BUDGET,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/tools/:toolId/versions/:version/unregister',
    openapiPath: '/v1/tools/{toolId}/versions/{version}/unregister',
    operationId: 'tools.unregister',
    summary: 'Unregister a specific tool version',
    tags: ['tools'],
    security: 'bearer',
    parameters: [ToolIdPathParam, ToolVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterToolResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `tool-version-pinned`: the version is pinned in one or more scopes (`details.scopes`); move those pins to another version, or unpin them, first. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No tool at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/tools/:toolId/versions/:version/reinstate',
    openapiPath: '/v1/tools/{toolId}/versions/{version}/reinstate',
    operationId: 'tools.reinstateVersion',
    summary: 'Reinstate a specific tombstoned tool version',
    description:
      'Un-tombstones a previously-unregistered version: clears the tombstone on that version and recomputes the latest active version. Restores the manifest bytes verbatim (semver hygiene: reinstate never mutates). Idempotent — reinstating an active version is a no-op (returns `wasTombstoned: false`). Reinstating any version of a fully-retired tool reactivates the identity: subsequent GETs return 200, dispatch succeeds. Publish is always allowed regardless of retirement state — this verb is for restoring previously-unregistered bytes, not for reactivating a retired identity (a fresh publish does that).',
    tags: ['tools'],
    security: 'bearer',
    parameters: [ToolIdPathParam, ToolVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Reinstated.', schema: ref('ReinstateToolVersionResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `tool-kind-mismatch`: the tool's active versions are of another kind than this one, an MCP endpoint's tool (`details.endpointId`) or tools published here, so it stays unregistered (`details.toolId`, `details.version`). Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No tool at that (id, version) under this tenant.'),
      '400': ErrorResponse(
        "`provider-key-refused`: the version declares or sends a model provider's key (`details.secret`, `details.providerId`), or `reserved-name-prefix`: it names a secret under the reserved `kindgi.` prefix (`details.secret`); either way it stays retired; publish a version that names a key of its own.",
      ),
    },
  },

  ...pinnedVersionOperations(TOOL_PINS),

  // ---------- guardrails ----------
  {
    method: 'get',
    honoPath: '/v1/guardrails',
    openapiPath: '/v1/guardrails',
    operationId: 'guardrails.list',
    summary: 'List guardrails',
    description:
      'Cursor-paginated list of registered guardrails. Optional `?name=` filters by prefix on guardrail id.',
    tags: ['guardrails'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      NameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
    ],
    responses: {
      '200': { description: 'Page of guardrails.', schema: ref('GuardrailCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/guardrails/:guardrailId',
    openapiPath: '/v1/guardrails/{guardrailId}',
    operationId: 'guardrails.get',
    summary: 'Fetch an guardrail',
    tags: ['guardrails'],
    security: 'bearer',
    parameters: [GuardrailIdPathParam],
    responses: {
      '200': { description: 'Guardrail.', schema: ref('Guardrail') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No guardrail with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/guardrails/:guardrailId/outcomes',
    openapiPath: '/v1/guardrails/{guardrailId}/outcomes',
    operationId: 'guardrails.outcomes',
    summary: "What a guardrail's checks came to in a project",
    description:
      "Counts from the server, over a window: how many of the guardrail's checks on agent turns in the project `passed`, were `violated` (the answer went through: `log-only`, `noop`, or an action handed back; or a `retry` sent it back for a new one), `blocked` (a `halt` failed the turn, or a `retry` whose attempts had run out) or `errored` (the check couldn't run; a `halt` guardrail's error fails the turn too, and is counted here). The same counts per agent version, and the window's latest blocked turns, by run id and time only: a blocked answer stays behind its run's page. A guardrail whose scope didn't match a turn wasn't checked on it. A check is counted per answer it judged: a guardrail judges a turn's final answer, and, in a turn with a `retry` guardrail, its `halt` and `retry` guardrails judge each answer. Replays and dry runs aren't counted. Outcomes go with their run's retention, so a window can hold fewer than asked; `recordedSince` says how far back they go. A guardrail no longer registered still has its outcomes. Needs `read` on the guardrail and on the project.",
    tags: ['guardrails'],
    security: 'bearer',
    parameters: [
      GuardrailIdPathParam,
      {
        name: 'projectId',
        in: 'query',
        required: true,
        description: 'The project whose agent turns are counted.',
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'from',
        in: 'query',
        required: true,
        description: 'Checks at or after this time (ISO 8601).',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'to',
        in: 'query',
        required: true,
        description: 'Checks before this time (ISO 8601). At most 90 days after `from`.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'recent',
        in: 'query',
        required: false,
        description: 'How many of the latest blocked turns to name: 0 to 50, 10 by default.',
        schema: { type: 'integer', minimum: 0, maximum: 50 },
      },
    ],
    responses: {
      '200': { description: 'The outcomes.', schema: ref('GuardrailOutcomes') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'A missing or malformed `projectId`, `from`, `to` or `recent`; a window over 90 days.',
      ),
      '501': ErrorResponse(
        "`guardrail-outcomes-not-supported`: this deployment doesn't record guardrail outcomes.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/guardrails',
    openapiPath: '/v1/guardrails',
    operationId: 'guardrails.register',
    summary: 'Register an guardrail',
    description:
      'Body is a full `Guardrail` shape. Server validates via `@kindgi/guardrails.validateGuardrailSpec`. The `check` id must reference an implementation already available to the runtime; check code is not uploaded through this route.',
    tags: ['guardrails'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterGuardrailBody') },
    responses: {
      '201': { description: 'Guardrail registered.', schema: ref('RegisterGuardrailResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID). Or `reference-out-of-scope`: a pack check it names isn't registered in its project, its org or the tenant (`details.issues`); a built-in check is every project's.",
      ),
      '409': ErrorResponse(
        `Guardrail already registered at that id. ${TAKES_PROMOTIONS} Or \`registry-read-only\`: this registry takes no writes (under \`kindgi dev\`, the pack's files are the source); the message says what to do instead.`,
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '422': ErrorResponse(
        "`guardrail-config-invalid`: the guardrail's `config` breaks the `configSchema` of the check it names (a pack check's, or a built-in's), which would refuse it on every call. `details.issues` lists each problem, `{ path, message }` with `path` a JSON pointer into the guardrail (`/config/maxChars`); the message names the guardrail, the check and the setting. Checked when the check's deployment carries its schema.",
      ),
      '429': SCHEMA_COMPILE_BUDGET,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/guardrails/:guardrailId/unregister',
    openapiPath: '/v1/guardrails/{guardrailId}/unregister',
    operationId: 'guardrails.unregister',
    summary: 'Unregister an guardrail',
    tags: ['guardrails'],
    security: 'bearer',
    parameters: [GuardrailIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterGuardrailResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No guardrail with that id under this tenant.'),
    },
  },

  // ---------- conversations ----------
  {
    method: 'get',
    honoPath: '/v1/conversations',
    openapiPath: '/v1/conversations',
    operationId: 'conversations.list',
    summary: 'List conversations',
    description:
      "Cursor-paginated. Fixed sort: `openedAt desc, id desc`. Filters: `?agentId=`, `?status=open|closed`, `?openedBy=me` (the caller's own), `?replays=exclude|include|only` (default `exclude`: a comparison's replay conversations are left out), and `scopeKind`/`scopeId` for one project's conversations, or every project's in an org. Conversations from before Kindgi 0.1.3 have no project and are listed only without a scope.",
    tags: ['conversations'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      AgentIdQueryParam,
      ConversationStatusQueryParam,
      ConversationReplaysQueryParam,
      ConversationOpenedByQueryParam,
    ],
    responses: {
      '200': {
        description: 'Page of conversations.',
        schema: ref('ConversationCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter or scope.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/conversations/:conversationId',
    openapiPath: '/v1/conversations/{conversationId}',
    operationId: 'conversations.get',
    summary: 'Fetch a conversation',
    tags: ['conversations'],
    security: 'bearer',
    parameters: [ConversationIdPathParam],
    responses: {
      '200': { description: 'Conversation.', schema: ref('Conversation') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`conversationId` is not a conversation id (a UUID).'),
      '404': ErrorResponse(
        "No conversation with that id under this tenant, or one the caller can't read (`read` on its project, or on its agent for one from before projects): the same answer, byte for byte.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/conversations',
    openapiPath: '/v1/conversations',
    operationId: 'conversations.open',
    summary: 'Open a conversation',
    description:
      'Pins `(agentId, agentVersion)` at open time. `title` defaults to `"Untitled conversation"` when omitted; `projectId` puts it in a project, which must reach the agent (lists filter by it; omitted, the agent\'s own project, as for a run, or the Default project for an agent filed under none); `scope` accepts arbitrary JSON.',
    tags: ['conversations'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('OpenConversationBody') },
    responses: {
      '201': { description: 'Conversation opened.', schema: ref('Conversation') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed request body, or `projectId` names no project of this tenant. Or `reference-out-of-scope`: the agent isn't registered in the conversation's project, its org or the tenant, or `agentVersion` isn't a version that project runs, such as one made in an earlier environment and not yet promoted (`details.issues`, at `/agentId`, whose message names the version). Nothing is opened.",
      ),
      '403': ErrorResponse(
        "No `execute` on the agent, or, for an agent more than one project serves opened in one of its projects, no `call` there (`caller` or `editor`); or, otherwise, naming a `projectId` without `write` on it (its turns land there, as a run naming one does); or a `participantId` whose memory the caller may not read (`participant-not-allowed`): its turns run with that participant's memory, so opening it for someone takes being them (a person, by their user id) or `write` on its project. The rights on the agent and on a named project are checked before `projectId` is looked up, so they answer the same whether or not it names a project.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/conversations/:conversationId/close',
    openapiPath: '/v1/conversations/{conversationId}/close',
    operationId: 'conversations.close',
    summary: 'Close a conversation',
    description:
      'Idempotent: closing an already-closed conversation returns 200 with the current row (no timestamp bump).',
    tags: ['conversations'],
    security: 'bearer',
    parameters: [ConversationIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': {
        description: 'Conversation row (open→closed, or already closed).',
        schema: ref('Conversation'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse('`conversationId` is not a conversation id (a UUID).'),
      '403': ErrorResponse(
        "The caller can read the conversation, and has no `execute` on its agent or, for an agent more than one project serves, no `call` on the conversation's project (`caller` or `editor`). Closing one doesn't take reading it.",
      ),
      '404': ErrorResponse(
        "No conversation with that id under this tenant, or one the caller may not close and can't read: the same answer, byte for byte.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/conversations/:conversationId/unregister',
    openapiPath: '/v1/conversations/{conversationId}/unregister',
    operationId: 'conversations.unregister',
    summary: 'Unregister a conversation',
    description:
      "A tombstone: from now on no read, list or recall of earlier conversations returns it, and no message can be added. The retention sweep removes it after the tenant's grace.",
    tags: ['conversations'],
    security: 'bearer',
    parameters: [ConversationIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': {
        description: 'The conversation, with `unregisteredAt`.',
        schema: ref('Conversation'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse('`conversationId` is not a conversation id (a UUID).'),
      '403': ErrorResponse(
        'The caller can read the conversation, and has no `write` on its project (on its agent, for one from before projects).',
      ),
      '404': ErrorResponse(
        "No conversation with that id under this tenant, or it is unregistered already, or the caller may not unregister it and can't read it: the same answer, byte for byte.",
      ),
      '501': ErrorResponse(
        "`conversation-unregister-unsupported`: this runtime can't unregister conversations.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/conversations/:conversationId/messages',
    openapiPath: '/v1/conversations/{conversationId}/messages',
    operationId: 'conversations.messages',
    summary: 'Read conversation messages',
    description:
      'Cursor-paginated. Sort is `sequence asc` (natural conversation reading order) — distinct from most list endpoints, which use `createdAt desc`.',
    tags: ['conversations'],
    security: 'bearer',
    parameters: [ConversationIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': {
        description: 'Page of messages.',
        schema: ref('ConversationMessageCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'Malformed cursor, or `conversationId` is not a conversation id (a UUID).',
      ),
      '404': ErrorResponse(
        "No conversation with that id under this tenant, or one the caller can't read (`read` on its project, or on its agent for one from before projects): the same answer, byte for byte.",
      ),
    },
  },

  // ---------- memory ----------
  {
    method: 'get',
    honoPath: '/v1/memory/facts',
    openapiPath: '/v1/memory/facts',
    operationId: 'memory.listFacts',
    summary: 'List facts',
    description:
      "Cursor-paginated: the current revision of each fact the caller may see. That is tenant-wide facts, the projects they may read (with those projects' orgs), their own user facts, and every end user's and conversation's facts in the projects they may write; a tenant admin sees every fact. Filters: `?type=` (exact match on `Fact.type`), `?scope=` (URL-encoded JSON partial memory `Scope`), `?scopeKind + ?scopeId + ?inherit` (discriminated `PlatformScope` triplet — threaded into the binding as `platformScope`; both fields coexist), `?asOf=` (memory as it stood then). Sort order is binding-defined.",
    tags: ['memory'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      FactTypeQueryParam,
      FactScopeQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
      FactAsOfQueryParam,
    ],
    responses: {
      '200': { description: 'Page of facts.', schema: ref('FactCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'Malformed query parameter (e.g. `scope` not valid JSON, `asOf` not a time).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/memory/facts/:factId',
    openapiPath: '/v1/memory/facts/{factId}',
    operationId: 'memory.getFact',
    summary: 'Fetch a fact',
    description:
      'Its current revision; `?version=` reads one revision, `?asOf=` the revision current at that time. A fact the caller may not see is not found.',
    tags: ['memory'],
    security: 'bearer',
    parameters: [FactIdPathParam, FactVersionQueryParam, FactAsOfQueryParam],
    responses: {
      '200': { description: 'Fact.', schema: ref('Fact') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`version` is not a revision number, or `asOf` not a time.'),
      '404': ErrorResponse('No fact with that id the caller may see (or no such revision).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/memory/facts/:factId/revisions',
    openapiPath: '/v1/memory/facts/{factId}/revisions',
    operationId: 'memory.listFactRevisions',
    summary: "List a fact's revisions",
    description:
      'Every revision of the fact, newest first, superseded and deleted ones included: who changed it, when and why (`invalidatedBy`, `invalidatedAt`, `invalidationReason`).',
    tags: ['memory'],
    security: 'bearer',
    parameters: [FactIdPathParam],
    responses: {
      '200': { description: 'The revisions.', schema: ref('FactRevisionList') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No fact with that id the caller may see.'),
      '501': ErrorResponse(
        "`memory-operation-unsupported`: this runtime's memory doesn't keep fact history.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/memory/facts',
    openapiPath: '/v1/memory/facts',
    operationId: 'memory.writeFact',
    summary: 'Write a fact',
    description:
      "Persists a new fact. `type` selects the retrieval policy (which indexes populate). Semantic-indexed types require an embedding provider bound on the deployment; if unavailable, the route returns `400 bad-input`. The caller needs write where the scope says: `write` on its project (an end user's or a conversation's fact included), `write` on its conversation outside a project, `admin` on its org for an org-wide fact, being that user for a user's fact, and tenant `admin` for a tenant-wide fact. The fact records who wrote it (`attributedTo`).",
    tags: ['memory'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('WriteFactBody') },
    responses: {
      '201': { description: 'Fact written.', schema: ref('Fact') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'Malformed body, or the fact type requires semantic indexing and no embedding provider is bound.',
      ),
      '403': ErrorResponse("`permission-denied`: the caller may not write in the fact's scope."),
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body; or an erasure of the fact's person (by scope or subject) or conversation is in progress (`erasure-in-progress`): nothing new is stored for them until it completes.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/memory/facts/:factId/supersede',
    openapiPath: '/v1/memory/facts/{factId}/supersede',
    operationId: 'memory.supersedeFact',
    summary: "Change a fact's content",
    description:
      'Writes the next revision (same fact id, `version` one more) and closes the current one; the old revision stays readable with `?version=`, `?asOf=` and in the history until the retention sweep removes it. `expectVersion` refuses if someone changed it first.',
    tags: ['memory'],
    security: 'bearer',
    parameters: [FactIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('SupersedeFactBody') },
    responses: {
      '200': { description: 'The new revision.', schema: ref('Fact') },
      ...CommonMutationErrors,
      '403': ErrorResponse("`permission-denied`: the caller may not write in the fact's scope."),
      '404': ErrorResponse('No fact with that id the caller may see, or it was deleted.'),
      '409': ErrorResponse(
        '`fact-changed`: the current revision is not `expectVersion` (`details.currentVersion`); `legal-hold`: the fact is under legal hold.',
      ),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/memory/facts/:factId',
    openapiPath: '/v1/memory/facts/{factId}',
    operationId: 'memory.deleteFact',
    summary: 'Delete a fact',
    description:
      'Closes the current revision (`invalidationReason: deleted`): the fact is no longer listed, fetched or retrieved, and its history stays readable until the retention sweep removes it.',
    tags: ['memory'],
    security: 'bearer',
    parameters: [FactIdPathParam, FactExpectVersionQueryParam],
    responses: {
      '200': { description: 'The closed revision.', schema: ref('Fact') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`expectVersion` is not a revision number.'),
      '403': ErrorResponse("`permission-denied`: the caller may not write in the fact's scope."),
      '404': ErrorResponse('No fact with that id the caller may see, or it was deleted.'),
      '409': ErrorResponse(
        '`fact-changed`: the current revision is not `expectVersion`; `legal-hold`: the fact is under legal hold.',
      ),
      '501': ErrorResponse(
        "`memory-operation-unsupported`: this runtime's memory can't delete facts.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/memory/facts/:factId/verify',
    openapiPath: '/v1/memory/facts/{factId}/verify',
    operationId: 'memory.verifyFact',
    summary: 'Mark a fact verified',
    description:
      'A person who may write in its scope checked it: the next revision has `trust: verified`, `verifiedBy` and `verifiedAt`, and the same content.',
    tags: ['memory'],
    security: 'bearer',
    parameters: [FactIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('VerifyFactBody') },
    responses: {
      '200': { description: 'The verified revision.', schema: ref('Fact') },
      ...CommonMutationErrors,
      '403': ErrorResponse("`permission-denied`: the caller may not write in the fact's scope."),
      '404': ErrorResponse('No fact with that id the caller may see, or it was deleted.'),
      '409': ErrorResponse(
        '`fact-changed`: the current revision is not `expectVersion`; `legal-hold`: the fact is under legal hold.',
      ),
      '501': ErrorResponse(
        "`memory-operation-unsupported`: this runtime's memory can't verify facts.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/memory/retrieve',
    openapiPath: '/v1/memory/retrieve',
    operationId: 'memory.retrieve',
    summary: 'Retrieve facts by intent',
    description:
      'Retrieval over the facts the caller may see (as for listing), current revisions only. `mode`: `list` (newest first, no query), `keyword` (full-text), `semantic` (by meaning), or `both` (the two searches fused by rank: reciprocal rank fusion). Searching by meaning needs embeddings on the deployment (`KINDGI_MEMORY_EMBEDDINGS`); without them `semantic` and `both` answer `422 semantic-unavailable`.',
    tags: ['memory'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RetrieveMemoryBody') },
    responses: {
      '200': { description: 'Retrieval results.', schema: ref('RetrieveMemoryResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse('Malformed intent.'),
      '422': ErrorResponse(
        '`semantic-unavailable`: `semantic` or `both` asked to search by meaning, and the deployment has no embeddings (`KINDGI_MEMORY_EMBEDDINGS`).',
      ),
      '501': ErrorResponse(
        "`memory-operation-unsupported`: this runtime's memory can't retrieve by intent.",
      ),
    },
  },

  // ---------- memory erasures (a person's words) ----------
  {
    method: 'post',
    honoPath: '/v1/memory/erasures',
    openapiPath: '/v1/memory/erasures',
    operationId: 'memory.createErasure',
    summary: "Erase a person's words",
    description:
      "Starts erasing, in the background, one fact (`factId`), a person (`subject`: an app's end user `participant`, or an `external` subject facts name) or one conversation (`conversationId`): their facts, conversations (messages, recall rows), the runs that served them (input, output, journal, snapshots) and the free text they left in provenance; facts written from them go to review. Answers `202` with the erasure; follow it with `GET /v1/memory/erasures/{erasureId}`. A completed erasure keeps no identifier, only a keyed hash for a replay after a backup restore; `warnings` says when this deployment can't keep one (`erasure-unmatchable`: no erasure ledger key, `KINDGI_ERASURE_LEDGER_KEY`). Requires `admin` on the tenant.",
    tags: ['memory'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateMemoryErasureBody') },
    responses: {
      '202': { description: 'Started.', schema: ref('MemoryErasureCreated') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Not exactly one of `factId`, `subject` or `conversationId`; or a `subject` of kind `user` (erasing a Kindgi user isn't offered).",
      ),
      '403': ErrorResponse('Not a tenant admin.'),
      '409': ErrorResponse(
        '`legal-hold`: a fact it reaches is under legal hold (`details.factIds`); nothing started.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/memory/erasures',
    openapiPath: '/v1/memory/erasures',
    operationId: 'memory.listErasures',
    summary: 'List erasures',
    description:
      'Cursor-paginated, newest first: each erasure, how far it got and what it cleared. A completed one shows no selector. Requires `admin` on the tenant.',
    tags: ['memory'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of erasures.', schema: ref('MemoryErasurePage') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '400': ErrorResponse('`cursor` is not one this list issued.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/memory/erasures/export',
    openapiPath: '/v1/memory/erasures/export',
    operationId: 'memory.exportErasures',
    summary: 'Export the erasure ledger',
    description:
      "The whole ledger, oldest first, content-free: each erasure's selector kind, the keyed hash of whom it erased, who asked and when. Keep it off-box: restoring a backup rolls the ledger back too, and `POST /v1/memory/erasures/replay` with it runs the erasures again. Requires `admin` on the tenant.",
    tags: ['memory'],
    security: 'bearer',
    responses: {
      '200': { description: 'The ledger.', schema: ref('MemoryErasureLedger') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/memory/erasures/replay',
    openapiPath: '/v1/memory/erasures/replay',
    operationId: 'memory.replayErasures',
    summary: 'Replay erasures after a backup restore',
    description:
      "Takes the ledger `GET /v1/memory/erasures/export` gave, puts back the rows the restore lost, and finds each erasure's person (or fact, or conversation) again by its keyed hash: those run again (`replayed`); ones nothing in the tenant matches are only restored (`restored`); ones with no keyed hash, or a key this deployment doesn't hold, are `unmatched`. Requires `admin` on the tenant.",
    tags: ['memory'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('ReplayMemoryErasuresBody') },
    responses: {
      '200': { description: 'What was replayed.', schema: ref('ReplayMemoryErasuresResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse('Not `{erasures: [...]}` as the export gave them.'),
      '403': ErrorResponse('Not a tenant admin.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/memory/erasures/:erasureId/resume',
    openapiPath: '/v1/memory/erasures/{erasureId}/resume',
    operationId: 'memory.resumeErasure',
    summary: 'Resume an erasure',
    description:
      "Tries an unfinished erasure again now. With `force: true`, an erasure `waiting-on-run` (a turn of the person's in a flow that serves other people) stops waiting: the run is cancelled and the erasure goes on; without it, it waits until its deadline (`waitingOn.until`). A finished erasure comes back as it is. Requires `admin` on the tenant.",
    tags: ['memory'],
    security: 'bearer',
    parameters: [ErasureIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('ResumeMemoryErasureBody') },
    responses: {
      '200': { description: 'The erasure.', schema: ref('MemoryErasure') },
      ...CommonMutationErrors,
      '400': ErrorResponse('The body is `{force?: boolean}`.'),
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No such erasure in this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/memory/erasures/:erasureId',
    openapiPath: '/v1/memory/erasures/{erasureId}',
    operationId: 'memory.getErasure',
    summary: 'Get an erasure',
    description:
      'One erasure: its status (`pending`, `running`, `completed`, `failed`), phase, what each store cleared (`counts`), and `lastError` (a code, or `not-yet:<reason>` while it waits for a run to finish). Requires `admin` on the tenant.',
    tags: ['memory'],
    security: 'bearer',
    parameters: [ErasureIdPathParam],
    responses: {
      '200': { description: 'The erasure.', schema: ref('MemoryErasure') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No such erasure in this tenant.'),
    },
  },

  // ---------- suggested changes ----------
  {
    method: 'get',
    honoPath: '/v1/suggested-changes',
    openapiPath: '/v1/suggested-changes',
    operationId: 'suggestedChanges.list',
    summary: 'List suggested changes',
    description:
      'Newest first, cursor-paginated, only the suggested changes of agents the caller can read. Filters: `?agentId=`, `?tier=`, `?status=` (statuses are derived, so a page filtered by status can hold fewer rows than `limit`), and the pin scope a suggested change is for (`scopeKind`, `scopeId`, `segment`, exactly as the pin history takes it).',
    tags: ['suggested-changes'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      SuggestedChangeStatusQueryParam,
      AgentIdQueryParam,
      SuggestedChangeTierQueryParam,
      PinScopeKindQueryParam,
      ScopeIdQueryParam,
      SegmentQueryParam,
    ],
    responses: {
      '200': {
        description: 'Page of suggested changes.',
        schema: ref('SuggestedChangeCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('A malformed query parameter.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/improve-runs',
    openapiPath: '/v1/improve-runs',
    operationId: 'improveRuns.start',
    summary: 'Start an Improve run',
    description:
      "The runtime looks for better values for the version's tunable settings (keys its settings blocks' schemas mark `x-kindgi-tunable`) on the test set, within the budget, and writes its best candidate as a suggested change, which waits for a reviewer when requested. It answers at once with the Improve run, `running`. The Improve run works in one project, as an improve schedule does: `projectId`, else the scope's project, else (a tenant or org scope) the agent version's. The test set must be one that project reaches, and the Improve run's test runs run there; its suggested change's version is made where the agent's versions are. Checked first: the version is active and has something for the Improve run to work on (`400 validation-failed`, with `details.reason`): for a settings Improve run, a settings block with tunable keys (else `no-tunable-keys`), and for a prompt Improve run, instructions from a pinned prompt block (else `no-pinned-prompt-block`); the agent registry takes the versions an Improve run makes (`409 registry-read-only`; under `kindgi dev`, only for the whole tenant, since the pack's files serve every scope), and the agent has a pinned version for the whole tenant (`409 suggested-change-needs-pin`). No Improve run starts in a suspended project (`409 project-suspended`), and an Improve run going when it is ends `cancelled`, with the reason in `cancelReason`. Needs `publish` on the agent, and `write` on the Improve run's project when it isn't the version's. Without Improve runs in this runtime, `501 improve-unsupported`.",
    tags: ['improve-runs'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('StartImproveRunBody') },
    responses: {
      '202': { description: 'The Improve run, running.', schema: ref('ImproveRun') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed request body, `validation-failed` (with `details.reason` when the version has nothing for the Improve run to work on: `no-tunable-keys` or `no-pinned-prompt-block`), or a project or segment scope that isn't in `projectId`. Or `reference-out-of-scope`: a project or segment scope doesn't reach the agent, the version doesn't reach the Improve run's project (`/fromVersion`), or the test set isn't one that project reaches (`details.issues`).",
      ),
      '404': ErrorResponse(
        "`fromVersion` (or the version serving the scope) is not an active version; or the body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '409': ErrorResponse(
        "`registry-read-only` (under `kindgi dev`, also a scope narrower than the whole tenant), `suggested-change-needs-pin`, or `project-suspended`: the Improve run's project is suspended. Or Idempotency-Key was reused with a different body.",
      ),
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no Improve runs.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/improve-runs/check',
    openapiPath: '/v1/improve-runs/check',
    operationId: 'improveRuns.check',
    summary: 'Check an Improve run',
    description:
      "What an Improve run this input would start is estimated to cost, before you start it. The body is the start body of `POST /v1/improve-runs`, resolved and reach-checked the same way: an unknown or inactive `fromVersion` (or the version serving the scope) answers `404 agent-version-not-found`, and a test set or scope the Improve run's project doesn't reach answers `400 reference-out-of-scope`, exactly as starting one would. `estimatedCostUsd` is `min(budget.maxCostUsd, the replay count times the version's mean cost over its recent completed runs)` — clamped to the budget cap — and is absent when the version has no cost history; `basis` gives the unclamped inputs: the replay count, and that mean when there is one. The estimate prices every replay at that one mean, so a candidate whose prompt or settings cost more or less per run isn't captured, and the estimate leaves out a prompt Improve run's one-off drafting of its templates — an Improve run can cost more than the estimate. Because `estimatedCostUsd` is clamped to `budget.maxCostUsd`, an estimate at the cap means the Improve run is expected to spend its whole budget; the Improve run checks its cost before each comparison, so the one already running can take it a little over, and it starts no more once the cost reaches `budget.maxCostUsd`. It changes nothing (no Improve run starts) and takes no Idempotency-Key. Needs `publish` on the agent, and `write` on the Improve run's project when it isn't the version's. Without Improve runs in this runtime, `501 improve-unsupported`.",
    tags: ['improve-runs'],
    security: 'bearer',
    requestBody: { required: true, schema: ref('StartImproveRunBody') },
    responses: {
      '200': { description: 'The estimated cost.', schema: ref('ImproveRunCheck') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "Malformed request body (`bad-input`), or a project or segment scope that isn't in `projectId`. Or `reference-out-of-scope`: a project or segment scope doesn't reach the agent, the version doesn't reach the Improve run's project (`/fromVersion`), or the test set isn't one that project reaches (`details.issues`).",
      ),
      '404': ErrorResponse(
        "`fromVersion` (or the version serving the scope) is not an active version (`agent-version-not-found`); or the body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no Improve runs.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/suggested-changes/:suggestedChangeId',
    openapiPath: '/v1/suggested-changes/{suggestedChangeId}',
    operationId: 'suggestedChanges.get',
    summary: 'Fetch a suggested change',
    description: 'Needs `read` on its agent.',
    tags: ['suggested-changes'],
    security: 'bearer',
    parameters: [SuggestedChangeIdPathParam],
    responses: {
      '200': { description: 'The suggested change.', schema: ref('SuggestedChange') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such suggested change (or none the caller can read).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/suggested-changes',
    openapiPath: '/v1/suggested-changes',
    operationId: 'suggestedChanges.create',
    summary: 'Suggest new content for a data block',
    description:
      'A hand-written suggested change: new settings values or a new prompt template for a block `fromVersion` pins, for a pin scope. Checked as publishing that block version would be (its schema carries over), and refused when it equals the pinned content. The same change from the same version for the same scope is one suggested change: answered `200` with `X-Suggested-Change-Deduped: true`. Needs `publish` on the agent.',
    tags: ['suggested-changes'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateSuggestedChangeBody') },
    responses: {
      '201': { description: 'The suggested change, a `draft`.', schema: ref('SuggestedChange') },
      '200': {
        description: 'The same suggested change, made before.',
        schema: ref('SuggestedChange'),
      },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: under `kindgi dev`, a scope narrower than the whole tenant, since the pack's files serve every scope.",
      ),
      '400': ErrorResponse(
        "Malformed request body, or the change fails validation. Or `reference-out-of-scope`: a project or segment scope whose project doesn't reach the agent, or a block the agent's project doesn't reach (`details.issues`).",
      ),
      '404': ErrorResponse(
        "`fromVersion` isn't an active version of the agent (`agent-version-not-found`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/suggested-changes/:suggestedChangeId/evaluate',
    openapiPath: '/v1/suggested-changes/{suggestedChangeId}/evaluate',
    operationId: 'suggestedChanges.evaluate',
    summary: 'Compare a suggested change on a test set',
    description:
      "The first evaluation publishes the block version and derives the agent version (`derivedFrom.suggestedChangeId`); they serve no scope until a pin makes them serve. Then a comparison test run replays that version on the test set, against the recorded outputs (`baseline: 'recorded'`). Needs `publish` on the agent, and a pinned version of it for the whole tenant: an agent with none serves its latest version wherever nothing is pinned, so a new version would serve there at once (`409 suggested-change-needs-pin`). Allowed from `draft`, `evaluated`, `not-better`, `evaluation-failed`, `refused`, `superseded` and `expired`.",
    tags: ['suggested-changes'],
    security: 'bearer',
    parameters: [SuggestedChangeIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('EvaluateSuggestedChangeBody') },
    responses: {
      '202': { description: 'The suggested change, `evaluating`.', schema: ref('SuggestedChange') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed request body. Or `reference-out-of-scope`: the test set isn't registered in the agent's project, its org or the tenant (`details.issues`).",
      ),
      '404': ErrorResponse('No such suggested change, or no such test set.'),
      '409': ErrorResponse(
        "`suggested-change-needs-pin`: the agent has no pinned version for the whole tenant. `suggested-change-invalid-state-transition`: the suggested change's status doesn't allow it. `registry-read-only`: the agent registry takes no writes, not even the version a suggested change makes; or, under `kindgi dev`, the suggested change's scope is narrower than the whole tenant, since the pack's files serve every scope.",
      ),
      '429': SCHEMA_COMPILE_BUDGET,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/suggested-changes/:suggestedChangeId/rescore',
    openapiPath: '/v1/suggested-changes/{suggestedChangeId}/rescore',
    operationId: 'suggestedChanges.rescore',
    summary: "Rescore a suggested change's latest evaluation",
    description:
      "After people correct a comparison's new answers on its replay runs (`perCase[].changes.new`, `runIds`), a new comparison test run scores the same replays again, counting those corrections, as `POST /v1/test-runs/{testRunId}/rescore` does: same test set version and settings, `comparison.rescoreOf`, nothing replayed. It becomes the suggested change's evaluation, so the suggested change is `evaluating`, then `evaluated` or `not-better` as the rescore says; the run rescored stays as it was. Takes no body fields. Needs `publish` on the agent. Allowed from `evaluated`, `not-better`, `refused`, `superseded` and `expired`.",
    tags: ['suggested-changes'],
    security: 'bearer',
    parameters: [SuggestedChangeIdPathParam, IdempotencyKeyParam],
    responses: {
      '202': { description: 'The suggested change, `evaluating`.', schema: ref('SuggestedChange') },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'No such suggested change, or its candidate version is unregistered (`agent-version-not-found`).',
      ),
      '409': ErrorResponse(
        "`suggested-change-invalid-state-transition`: the suggested change's status doesn't allow it. `test-run-not-rescorable`: the latest evaluation isn't a completed comparison.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/suggested-changes/:suggestedChangeId/pin',
    openapiPath: '/v1/suggested-changes/{suggestedChangeId}/pin',
    operationId: 'suggestedChanges.pin',
    summary: "Pin a suggested change's version for its scope",
    description:
      "A pin of the candidate for the suggested change's scope, with its evaluation's comparison, through the scope's gate: as `POST /v1/agents/{agentId}/pinned/pin` answers. Needs `pin` on the agent. Allowed from `evaluated`, `not-better` (the gate decides), `refused`, `superseded` and `expired`.",
    tags: ['suggested-changes'],
    security: 'bearer',
    parameters: [SuggestedChangeIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('SuggestedChangeReasonBody') },
    responses: {
      '201': {
        description: 'Pinned: the suggested change, `pinned`.',
        schema: ref('SuggestedChange'),
      },
      '202': {
        description: 'The gate passed and an approval is open: the suggested change, `in-review`.',
        schema: ref('SuggestedChange'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed request body. Or `reference-out-of-scope`: the suggested change's project or segment scope no longer reaches the agent (`details.issues`).",
      ),
      '404': ErrorResponse('No such suggested change.'),
      '409': ErrorResponse(
        "The suggested change's status doesn't allow it. Or `pin-scope-spans-environments`: the agent has a project in an environment order, and the suggested change's tenant- or org-wide scope would act in every environment of the order at once; a suggested change for a project (or a segment of it) can be pinned.",
      ),
      '422': ErrorResponse(
        '`gate-failed`: the gate refused it (the error carries the checks and `suggestedChangeId`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/suggested-changes/:suggestedChangeId/withdraw',
    openapiPath: '/v1/suggested-changes/{suggestedChangeId}/withdraw',
    operationId: 'suggestedChanges.withdraw',
    summary: 'Withdraw a suggested change',
    description:
      "Closes it. Not while it's in review (decide its approval instead), nor once pinned, rejected or rolled back. Needs `publish` on the agent.",
    tags: ['suggested-changes'],
    security: 'bearer',
    parameters: [SuggestedChangeIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('WithdrawSuggestedChangeBody') },
    responses: {
      '200': { description: 'The suggested change, `withdrawn`.', schema: ref('SuggestedChange') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such suggested change.'),
      '409': ErrorResponse("The suggested change's status doesn't allow it."),
    },
  },

  // ---------- Improve runs ----------
  {
    method: 'get',
    honoPath: '/v1/improve-runs',
    openapiPath: '/v1/improve-runs',
    operationId: 'improveRuns.list',
    summary: 'List Improve runs',
    description:
      'Newest first, only the Improve runs of agents the caller can read. `?agentId=` narrows them.',
    tags: ['improve-runs'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam, AgentIdQueryParam],
    responses: {
      '200': { description: 'Page of Improve runs.', schema: ref('ImproveRunCollectionPage') },
      ...CommonAuthErrors,
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no Improve runs.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/improve-runs/:improveRunId',
    openapiPath: '/v1/improve-runs/{improveRunId}',
    operationId: 'improveRuns.get',
    summary: 'Fetch an Improve run',
    description:
      'Its status, the candidates it compared and what they cost, and once it ends, what it found. Needs `read` on its agent.',
    tags: ['improve-runs'],
    security: 'bearer',
    parameters: [ImproveRunIdPathParam],
    responses: {
      '200': { description: 'The Improve run.', schema: ref('ImproveRun') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such Improve run (or none the caller can read).'),
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no Improve runs.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/improve-runs/:improveRunId/cancel',
    openapiPath: '/v1/improve-runs/{improveRunId}/cancel',
    operationId: 'improveRuns.cancel',
    summary: 'Cancel an Improve run',
    description:
      'A running Improve run stops and ends `cancelled`, writing no suggested change. Needs `publish` on its agent.',
    tags: ['improve-runs'],
    security: 'bearer',
    parameters: [ImproveRunIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'The Improve run, cancelled.', schema: ref('ImproveRun') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such Improve run.'),
      '409': ErrorResponse('`improve-run-finished`: it has ended already.'),
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no Improve runs.'),
    },
  },

  // ---------- provenance ----------
  {
    method: 'get',
    honoPath: '/v1/provenance',
    openapiPath: '/v1/provenance',
    operationId: 'provenance.list',
    summary: 'List provenance records',
    description:
      "Cursor-paginated. Metadata rows only — clients fetch the DAG payload via `GET /v1/provenance/{runId}`. Fixed sort: `createdAt desc, id desc`. Filters: `?runId=`, `?agentId=`, `?flowId=`, `?createdAfter=`, and `scopeKind`/`scopeId` for one project's records, or every project's in an org (records from before Kindgi 0.1.3 have no project and are listed only without a scope).",
    tags: ['provenance'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      ProvenanceRunIdQueryParam,
      ProvenanceAgentIdQueryParam,
      ProvenanceFlowIdQueryParam,
      ProvenanceCreatedAfterQueryParam,
    ],
    responses: {
      '200': { description: 'Page of records.', schema: ref('ProvenanceCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed cursor, `createdAfter` timestamp or scope.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/provenance/:runId',
    openapiPath: '/v1/provenance/{runId}',
    operationId: 'provenance.get',
    summary: 'Fetch the full provenance DAG for a run',
    description:
      "Returns the full DAG (nodes + edges) plus record metadata: an agent turn's record, or a flow run's. A flow run's record is written just after the run ends. From the run's end until it is, the answer is 404 `provenance-not-found` with `error.details.recordState: being-written`; if writing it failed, `recordState: failed` and `error.details.reason`, a code. More states and codes may come. 404 with neither when the run has no record: a run still running, a dry run, an erased run, a run from before records were kept for it, or a deployment that doesn't write them.",
    tags: ['provenance'],
    security: 'bearer',
    parameters: [RunIdPathParam],
    responses: {
      '200': { description: 'Full provenance record.', schema: ref('ProvenanceRecord') },
      ...CommonAuthErrors,
      '404': ErrorResponse(
        'No provenance record for that run under this tenant (`provenance-not-found`; `error.details.recordState` says when it is still being written, or failed).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/license',
    openapiPath: '/v1/license',
    operationId: 'license.get',
    summary: "Where the deployment's license key stands",
    description:
      "Whose key, which use, until when and how many days are left, and from 30 days before it expires how to get the next one, as the runtime's startup banner says it. Never the key itself. `mode: development` when the runtime runs with `KINDGI_DEV` and needs no key. The license is the deployment's: its own token (`KINDGI_API_TOKEN`), or a system key holding `system:license` (the renewal job's), reads all of it, `renew` with where the deployment keeps its key included. Where the deployment serves exactly one tenant, that tenant's admins read the countdown only (`mode`, `standing`, `expiresAt`, `startsUntil`, `daysLeft`, `renewBy`): never whose key it is or where it's kept. Anyone else is refused: `GET /v1/identity/me/permissions` says so before asking (`licenseOperatorOnly`, with `tenant.admin`). A deployment that doesn't report it answers 404.",
    tags: ['system'],
    security: 'bearer',
    responses: {
      '200': { description: 'The license status.', schema: ref('LicenseStatus') },
      ...CommonAuthErrors,
      '403': ErrorResponse(
        "Not the deployment's own token, a system key holding `system:license`, or an admin of the one tenant it serves (`license-operator-only`). On a runtime serving one tenant, a system key holding anything but `system:license` (`system-key-scope-not-served`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runtime',
    openapiPath: '/v1/runtime',
    operationId: 'runtime.get',
    summary: 'Which runtime answers',
    description:
      "Its version, how many tenants it serves and whether it runs in development mode: what a client says about the runtime it's connected to. Any caller of a tenant reads it; no right is asked. A runtime that doesn't report it answers 404.",
    tags: ['system'],
    security: 'bearer',
    responses: {
      '200': { description: 'Which runtime answers.', schema: ref('RuntimeInfo') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/license/usage',
    openapiPath: '/v1/license/usage',
    operationId: 'license.usage',
    summary: 'How much the deployment was used since a time',
    description:
      "What a free license key's renewal carries (`kindgi license renew --runtime`): the runs started since `since` (not dry runs, replays, evals or child runs), the distinct people who started runs or decided approvals (counted in each tenant and summed, so a person in two tenants counts twice), the projects in production when the runtime can put projects in production (`PUT /v1/projects/{projectId}/production`), and the runtime's version. Counts only: no content, names or ids. Only the deployment's own token (`KINDGI_API_TOKEN`), or a system key holding `system:license`, reads it; anyone else is refused (`license-operator-only`), and the refusal recorded, before `since` is read. A deployment that doesn't report it answers 404.",
    tags: ['system'],
    security: 'bearer',
    parameters: [LicenseUsageSinceQueryParam],
    responses: {
      '200': { description: 'The counts.', schema: ref('LicenseUsage') },
      '400': ErrorResponse(
        "`since` is missing, not a time with a zone, or more than five minutes ahead of the runtime's clock (`bad-input`).",
      ),
      ...CommonAuthErrors,
      '403': ErrorResponse(
        "Not the deployment's own token or a system key holding `system:license` (`license-operator-only`). On a runtime serving one tenant, a system key holding anything but `system:license` (`system-key-scope-not-served`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/export-signing-keys',
    openapiPath: '/v1/export-signing-keys',
    operationId: 'exportSigningKeys.list',
    summary: 'List the keys this deployment signs exports with',
    description:
      "The public keys of the deployment's export signing key, active first: what a verifier pins. An export's embedded `publicKey` only proves its bytes weren't changed; this list says who signed them. Empty when the deployment doesn't sign exports. Any authenticated caller may read it.",
    tags: ['export-signing-keys'],
    security: 'bearer',
    responses: {
      '200': { description: 'The keys.', schema: ref('ExportSigningKeyList') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/provenance/:runId/export',
    openapiPath: '/v1/provenance/{runId}/export',
    operationId: 'provenance.export',
    summary: 'Export a signed provenance bundle for a run',
    description:
      "Signs the run's provenance (and, when asked, its messages) with the deployment's export key, and records the export (an `export-signed` audit event). The same envelope as the other signed exports; check `publicKey` against `GET /v1/export-signing-keys`. A deployment with no export key answers `404 signing-not-configured`.",
    tags: ['provenance'],
    security: 'bearer',
    parameters: [RunIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('ExportProvenanceBody') },
    responses: {
      '200': { description: 'Signed bundle.', schema: ref('ExportProvenanceResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'Provenance not found, signing key id unknown, or signing not configured on this deployment.',
      ),
    },
  },

  // ---------- artifacts (blob storage) ----------
  {
    method: 'get',
    honoPath: '/v1/artifacts',
    openapiPath: '/v1/artifacts',
    operationId: 'artifacts.list',
    summary: 'List artifact metadata',
    description:
      'Cursor-paginated. Metadata rows only (no bytes). Filters: `?ownerRunId=`, `?projectId=`, `?contentType=`, `?tag.<key>=<value>` (repeatable — every provided tag must match as AND). Sort order is binding-defined (typically `createdAt desc, blobId desc`). With authorization on, only artifacts in projects the caller can read are listed.',
    tags: ['artifacts'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'ownerRunId',
        in: 'query',
        required: false,
        description: 'Filter to blobs produced by this RunId.',
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'contentType',
        in: 'query',
        required: false,
        description: 'Filter by exact content-type match.',
        schema: { type: 'string' },
      },
      {
        name: 'projectId',
        in: 'query',
        required: false,
        description: 'Filter to the artifacts of one project.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Page of blob metadata.', schema: ref('ArtifactCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter (e.g. empty `tag.` key).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/artifacts',
    openapiPath: '/v1/artifacts',
    operationId: 'artifacts.upload',
    summary: 'Upload an artifact',
    description:
      "Multipart upload. `file` part carries the bytes; other form fields carry metadata (`name`, `contentType`, `tags` (JSON), `ownerRunId`, `projectId`, `expectedHash`). Framework computes sha256 and returns it in `BlobMeta.hash`. If `expectedHash` was supplied and diverges, response is `400 blob-hash-mismatch`. Content-type sniffing is NOT performed server-side — the framework trusts the caller. The artifact belongs to its owner run's project, else `projectId`, else the project the caller's API key is limited to, else the tenant's default project; uploading needs `write` there, and a key limited to a project uploads into that project only. An upload over the runtime's cap (default 100 MiB) is `413 artifact-too-large`.",
    tags: ['artifacts'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: {
      required: true,
      contentType: 'multipart/form-data',
      schema: ref('UploadArtifactBody'),
      encoding: {
        file: { contentType: 'application/octet-stream' },
        tags: { contentType: 'application/json' },
      },
    },
    responses: {
      '201': { description: 'Upload accepted; metadata returned.', schema: ref('BlobMeta') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed multipart body, bad tag JSON, hash mismatch, declared size mismatch, or a `projectId` that isn't the owner run's.",
      ),
      '403': ErrorResponse(
        "No `write` on the project (`permission-denied`), or the caller's API key is limited to another project (`key-project-mismatch`).",
      ),
      '404': ErrorResponse('No such owner run (`run-not-found`).'),
      '413': ErrorResponse(
        'Over the upload cap (`artifact-too-large`; `details.maxBytes` says how much).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/artifacts/:blobId',
    openapiPath: '/v1/artifacts/{blobId}',
    operationId: 'artifacts.download',
    summary: 'Download an artifact (stream)',
    description:
      "Streams raw bytes, as a download. Response headers: `Content-Type` (as declared at upload when it is a well-formed media type of at most 255 characters, else `application/octet-stream`), `Content-Disposition` (`attachment`, with the name), `X-Content-Type-Options: nosniff`, `Content-Security-Policy` (`default-src 'none'; sandbox`), `Content-Length`, `X-Kindgi-Blob-Hash` (sha256 hex), `X-Kindgi-Blob-Name` (URI-encoded caller name).",
    tags: ['artifacts'],
    security: 'bearer',
    parameters: [
      {
        name: 'blobId',
        in: 'path',
        required: true,
        description: 'ArtifactId — opaque branded string (a UUID).',
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': {
        description: 'Raw bytes. See headers for metadata.',
        contentType: 'application/octet-stream',
        schema: { type: 'string', format: 'binary' },
      },
      ...CommonAuthErrors,
      '404': ErrorResponse(
        "No blob with that id under this tenant, or one in a project the caller can't read.",
      ),
    },
  },
  {
    method: 'head',
    honoPath: '/v1/artifacts/:blobId',
    openapiPath: '/v1/artifacts/{blobId}',
    operationId: 'artifacts.head',
    summary: 'Fetch artifact metadata (no body)',
    description:
      'Same headers as GET, empty body. 200 when the blob exists, 404 when unknown. The response headers are the authoritative payload.',
    tags: ['artifacts'],
    security: 'bearer',
    parameters: [
      {
        name: 'blobId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': {
        description: 'Metadata headers only.',
      },
      ...CommonAuthErrors,
      '404': {
        description: 'No blob with that id under this tenant.',
      },
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/artifacts/:blobId',
    openapiPath: '/v1/artifacts/{blobId}',
    operationId: 'artifacts.delete',
    summary: 'Delete an artifact',
    description:
      'Idempotent: first call returns `{ deleted: true }`, subsequent calls return `{ deleted: false }` (already gone). The route responds 200 either way — 404 only when the id was never known (structurally impossible after `list` returned it).',
    tags: ['artifacts'],
    security: 'bearer',
    parameters: [
      {
        name: 'blobId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': { description: 'Delete acknowledged.', schema: ref('DeleteArtifactResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse('No `write` on its project (`permission-denied`).'),
      '404': ErrorResponse("An artifact in a project the caller can't read (`blob-not-found`)."),
    },
  },

  // ---------- observations (supervisor) ----------
  {
    method: 'get',
    honoPath: '/v1/observations',
    openapiPath: '/v1/observations',
    operationId: 'observations.list',
    summary: 'Query supervisor observations',
    description:
      'Cursor-paginated. Any authenticated caller can read observations for their tenant.',
    tags: ['observations'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ObservationStatusQueryParam,
      AgentIdQueryParam,
      ObservationAgentVersionQueryParam,
      SupervisorIdQueryParam,
      ObservationConversationIdQueryParam,
      ObservationSinceQueryParam,
      ObservationUntilQueryParam,
    ],
    responses: {
      '200': {
        description: 'Page of observations.',
        schema: ref('ObservationCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },

  // ---------- capabilities (admin plane) ----------
  {
    method: 'get',
    honoPath: '/v1/capabilities',
    openapiPath: '/v1/capabilities',
    operationId: 'capabilities.list',
    summary: 'List capability descriptors',
    description:
      'Cursor-paginated. Read-only — capabilities are framework-declared + deployment-extended at boot time, not tenant-created via HTTP. Optional `?feature=` filters by prefix on `feature`.',
    tags: ['capabilities'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam, FeatureFilterQueryParam],
    responses: {
      '200': {
        description: 'Page of capability descriptors.',
        schema: ref('CapabilityCollectionPage'),
      },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/capabilities/:capabilityId',
    openapiPath: '/v1/capabilities/{capabilityId}',
    operationId: 'capabilities.get',
    summary: 'Fetch a capability descriptor',
    tags: ['capabilities'],
    security: 'bearer',
    parameters: [CapabilityIdPathParam],
    responses: {
      '200': { description: 'Capability descriptor.', schema: ref('CapabilityDescriptor') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No capability with that id under this tenant.'),
    },
  },

  // ---------- providers (admin plane) ----------
  {
    method: 'get',
    honoPath: '/v1/providers',
    openapiPath: '/v1/providers',
    operationId: 'providers.list',
    summary: 'List model providers',
    description:
      'Cursor-paginated. Optional `?feature=` filters to providers whose `metadata.features` includes the given feature (exact match).',
    tags: ['providers'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam, FeatureFilterQueryParam],
    responses: {
      '200': { description: 'Page of providers.', schema: ref('ProviderCollectionPage') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/providers/:providerId',
    openapiPath: '/v1/providers/{providerId}',
    operationId: 'providers.get',
    summary: 'Fetch a provider',
    description:
      'Returns the wire-safe `ProviderMetadata` (routing metadata only — secrets never cross the wire).',
    tags: ['providers'],
    security: 'bearer',
    parameters: [ProviderIdPathParam],
    responses: {
      '200': { description: 'Provider metadata.', schema: ref('ProviderMetadata') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No provider with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/providers/:providerId/capabilities',
    openapiPath: '/v1/providers/{providerId}/capabilities',
    operationId: 'providers.capabilities',
    summary: 'List capabilities a provider satisfies',
    description:
      'Sub-resource: returns the catalog capability descriptors the provider fulfils. Empty array = known provider with no matches; 404 = unknown provider.',
    tags: ['providers'],
    security: 'bearer',
    parameters: [ProviderIdPathParam],
    responses: {
      '200': {
        description: 'Capability descriptors satisfied by this provider.',
        schema: ref('ProviderCapabilitiesResult'),
      },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No provider with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/providers/:providerId/check',
    openapiPath: '/v1/providers/{providerId}/check',
    operationId: 'providers.check',
    summary: "Check a provider's registration",
    description:
      "Runs the provider's adapter check over its stored registration (its `adapter_config`, its metadata, whether it names a `secret_ref`): the check `POST /v1/providers` runs before it stores one. Static: no network call, no secret read. `issues` lists what would keep the runtime from building the provider, each with a JSON-pointer `path`; an adapter this runtime doesn't have is one (`/adapter_id`). `warnings` lists the `adapter_config` keys its adapter doesn't take: the runtime builds it without reading them. `checked` is false when this runtime has no check for the provider's adapter and the adapter declares no keys.",
    tags: ['providers'],
    security: 'bearer',
    parameters: [ProviderIdPathParam],
    responses: {
      '200': { description: 'The check.', schema: ref('ProviderCheckResult') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No provider with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/providers',
    openapiPath: '/v1/providers',
    operationId: 'providers.register',
    summary: 'Register a model provider',
    description:
      "Body is a full `ProviderMetadata`. Server validates shape: provider-level `id` + `region` non-empty; `models[]` non-empty with unique `name` per entry; per-model `contextWindow` positive integer; per-model `features` against the closed enum; per-model `cost` non-negative; optional per-model `p95LatencyMs` / `maxOutputTokens` well-shaped; optional `labels` within their limits — same rules as `@kindgi/capabilities.createProviderRegistry`. Secrets (API keys, endpoints) are NOT part of the wire shape; deployments store them inside the binding. When the runtime has the adapter the body names, that adapter checks the registration first (its `adapter_config`, the metadata and the presence of `secret_ref`; static: no network, no secret read): a problem refuses it with `422 provider-config-invalid`. A model provider's key is used by its provider only: a `secret_ref` naming a secret that a tool, an MCP endpoint or a webhook endpoint already uses is refused (`409 provider-key-in-use`), and from then on the name is refused to tools and endpoints.",
    tags: ['providers'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterProviderBody') },
    responses: {
      '201': { description: 'Provider registered.', schema: ref('RegisterProviderResult') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '400': ErrorResponse(
        'Validation failed (see `details.reason`), a `secret_ref.name` under the reserved `kindgi.` prefix among them (`bad-input`).',
      ),
      '409': ErrorResponse(
        `Provider already registered at that id. Or \`provider-key-in-use\`: \`secret_ref\` names a secret that a tool (its current version), an MCP endpoint, a webhook endpoint or a webhook trigger uses; \`details.usedBy\` lists each (\`kind\`, \`id\`, a tool's \`version\`). Store the provider's key under its own name. Nothing is stored. Or ${ENV_NOT_SERVED_REFERENCE}`,
      ),
      '422': ErrorResponse(
        "`provider-config-invalid`: a `send_traceparent` that isn't a boolean, or the provider's adapter refuses the registration (its `adapter_config`, its metadata, or a missing `secret_ref`); `details.issues` lists each (`path`, a JSON pointer, and `message`), the registration's own fields first, as other validation errors do. Nothing is stored.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/providers/:providerId/unregister',
    openapiPath: '/v1/providers/{providerId}/unregister',
    operationId: 'providers.unregister',
    summary: 'Unregister a model provider',
    description:
      'A tombstone, not an erase: from then on the provider is gone from list, get and capabilities, and the router never picks it. Its id is free to register again. A retention policy on the `provider` domain purges the row.',
    tags: ['providers'],
    security: 'bearer',
    parameters: [ProviderIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterProviderResult') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '404': ErrorResponse('No provider with that id under this tenant, or already unregistered.'),
    },
  },

  // ---------- corrections ----------
  {
    method: 'post',
    honoPath: '/v1/corrections',
    openapiPath: '/v1/corrections',
    operationId: 'corrections.create',
    summary: "Correct an item of a run's output",
    description:
      "Records yes or no, with an optional reason, about one item of a finished run's output, optionally under a corrector group that applies to the run's project or agent (unclassified corrections count with weight 1). `item.pointer` (a JSON Pointer) must resolve in the run's output; its value is kept as `itemValue`. The first correction of a run also stores a copy of the run's input and output. `assertedBy` is the authenticated caller, never the body. A second correction by the same caller for the same run, item key and `participantId` supersedes the earlier one. Needs `write` on the run's project.",
    tags: ['corrections'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateCorrectionBody') },
    responses: {
      '201': { description: 'Correction recorded.', schema: ref('Correction') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'Malformed body, or `item-not-found` (the pointer resolves to nothing in the output), or `corrector-group-not-applicable`.',
      ),
      '403': ErrorResponse(
        '`permission-denied`: not allowed to correct this run. `corrector-group-not-allowed`: the corrector group is restricted (`assertableBy`) and the caller may not assert it.',
      ),
      '404': ErrorResponse('`run-not-found`.'),
      '409': ErrorResponse('`run-not-finished`: the run has no output to correct yet.'),
      '410': ErrorResponse(
        "`run-erased`: an erasure cleared the run's content (a person's words were removed); there's nothing to correct.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/corrections',
    openapiPath: '/v1/corrections',
    operationId: 'corrections.list',
    summary: 'List corrections',
    description:
      'Live corrections (not removed or superseded), newest first, cursor-paginated. Filter by run, agent (and version), flow, verdict, corrector group or participant; `?scopeKind + ?scopeId` narrow to a project.',
    tags: ['corrections'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ...CorrectionListQueryParams,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
    ],
    responses: {
      '200': { description: 'Page of corrections.', schema: ref('CorrectionCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/corrections/:correctionId',
    openapiPath: '/v1/corrections/{correctionId}',
    operationId: 'corrections.get',
    summary: 'Fetch a correction with its copies',
    description:
      "Returns the correction (live or not) with the stored copy of the run's input and output and, when the correction pointed at an item, its value.",
    tags: ['corrections'],
    security: 'bearer',
    parameters: [CorrectionIdPathParam],
    responses: {
      '200': { description: 'Correction with copies.', schema: ref('CorrectionWithCopies') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No correction with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/corrections/:correctionId/remove',
    openapiPath: '/v1/corrections/{correctionId}/remove',
    operationId: 'corrections.remove',
    summary: 'Remove a correction',
    description:
      'Soft delete: the correction stops listing; retention policy decides when it is purged.',
    tags: ['corrections'],
    security: 'bearer',
    parameters: [CorrectionIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Removed.', schema: ref('RemoveCorrectionResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse('`permission-denied`.'),
      '404': ErrorResponse('No live correction with that id under this tenant.'),
    },
  },

  // ---------- corrector groups ----------
  {
    method: 'post',
    honoPath: '/v1/corrector-groups',
    openapiPath: '/v1/corrector-groups',
    operationId: 'correctorGroups.create',
    summary: 'Create a corrector group',
    description:
      'A named kind of person who corrects with a weight, scoped to the tenant, a project, or an agent in a project. Names are unique among the live groups of a scope. Needs `admin` on the tenant (tenant scope) or the project.',
    tags: ['corrector-groups'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateCorrectorGroupBody') },
    responses: {
      '201': { description: 'Corrector group created.', schema: ref('CorrectorGroup') },
      ...CommonMutationErrors,
      '403': ErrorResponse('`permission-denied`.'),
      '409': ErrorResponse('`corrector-group-name-taken`, or an idempotency conflict.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/corrector-groups',
    openapiPath: '/v1/corrector-groups',
    operationId: 'correctorGroups.list',
    summary: 'List corrector groups',
    description:
      'Live groups, newest first, cursor-paginated. `?scopeKind=tenant|project|agent` (with `projectId` / `agentId`) narrows to one scope.',
    tags: ['corrector-groups'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      CorrectorGroupScopeKindQueryParam,
      CorrectorGroupProjectIdQueryParam,
      CorrectorGroupAgentIdQueryParam,
    ],
    responses: {
      '200': {
        description: 'Page of corrector groups.',
        schema: ref('CorrectorGroupCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed scope parameters.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/corrector-groups/:correctorGroupId',
    openapiPath: '/v1/corrector-groups/{correctorGroupId}',
    operationId: 'correctorGroups.get',
    summary: 'Fetch a corrector group',
    description:
      'Also returns a retired group (`unregisteredAt` set): corrections keep naming theirs.',
    tags: ['corrector-groups'],
    security: 'bearer',
    parameters: [CorrectorGroupIdPathParam],
    responses: {
      '200': { description: 'Corrector group.', schema: ref('CorrectorGroup') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No corrector group with that id under this tenant.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/corrector-groups/:correctorGroupId',
    openapiPath: '/v1/corrector-groups/{correctorGroupId}',
    operationId: 'correctorGroups.update',
    summary: "Change a corrector group's weight or description",
    tags: ['corrector-groups'],
    security: 'bearer',
    parameters: [CorrectorGroupIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('UpdateCorrectorGroupBody') },
    responses: {
      '200': { description: 'Updated corrector group.', schema: ref('CorrectorGroup') },
      ...CommonMutationErrors,
      '403': ErrorResponse('`permission-denied`.'),
      '404': ErrorResponse('No live corrector group with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/corrector-groups/:correctorGroupId/unregister',
    openapiPath: '/v1/corrector-groups/{correctorGroupId}/unregister',
    operationId: 'correctorGroups.unregister',
    summary: 'Retire a corrector group',
    description: 'No new corrections may name it; existing corrections keep it.',
    tags: ['corrector-groups'],
    security: 'bearer',
    parameters: [CorrectorGroupIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Retired.', schema: ref('UnregisterCorrectorGroupResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse('`permission-denied`.'),
      '404': ErrorResponse('No live corrector group with that id under this tenant.'),
    },
  },

  // ---------- mcp (interop plane) ----------
  {
    method: 'get',
    honoPath: '/v1/mcp/endpoints',
    openapiPath: '/v1/mcp/endpoints',
    operationId: 'mcp.endpoints.list',
    summary: 'List MCP endpoints',
    description:
      'Cursor-paginated. Optional `?transport=` narrows to a single variant (`stdio | http-sse | streamable-http`). `?scopeKind + ?scopeId + ?inherit` narrow to a specific scope; `inherit` is LOAD-BEARING here (policy/config-scoped binding — controls the upward-hierarchy walk).',
    tags: ['mcp'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      MCPTransportFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
    ],
    responses: {
      '200': { description: 'Page of MCP endpoints.', schema: ref('MCPEndpointCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/mcp/endpoints/:endpointId',
    openapiPath: '/v1/mcp/endpoints/{endpointId}',
    operationId: 'mcp.endpoints.get',
    summary: 'Fetch an MCP endpoint',
    description:
      'Returns the wire-safe `MCPEndpoint` (secrets never cross the wire — `secretRef` names a secret the runtime resolves inside the deployment).',
    tags: ['mcp'],
    security: 'bearer',
    parameters: [MCPEndpointIdPathParam],
    responses: {
      '200': { description: 'MCP endpoint.', schema: ref('MCPEndpoint') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No MCP endpoint with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/mcp/endpoints',
    openapiPath: '/v1/mcp/endpoints',
    operationId: 'mcp.endpoints.register',
    summary: 'Register an MCP endpoint',
    description:
      "Body is a full `MCPEndpoint` plus the scope to register it in (`scopeKind` + `scopeId`); authorization checks that scope. Server validates the closed transport enum + the `config.transport` matches `transport` guardrail + per-variant required fields (`command` for stdio; `url` for http-sse / streamable-http), and refuses unknown fields. `secretRef` names a secret in the deployment's store — plaintext secrets never cross the wire — and never a model provider's key (`400 provider-key-refused`). Where each secret it names is read is recorded on it now (`secretScopes`): the first of its own scope, its project's org and the tenant that has the secret and that the caller administers, else the broadest they administer; the runtime reads it there only. A deployment with `KINDGI_TENANT_HOST_ACCESS=deployed` (the default outside development) refuses a `stdio` endpoint, which would run a command on the server's host: `403 host-access-denied`.",
    tags: ['mcp'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterMCPEndpointBody') },
    responses: {
      '201': {
        description: 'MCP endpoint registered.',
        schema: ref('RegisterMCPEndpointResult'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.reason`). Or `provider-key-refused`: `secretRef` names a model provider's key (`details.secret`, `details.providerId`). Or `reserved-name-prefix`: it names a secret under the reserved `kindgi.` prefix (`details.secret`).",
      ),
      '403': ErrorResponse(
        '`host-access-denied`: a `stdio` endpoint on a deployment that refuses commands on its host (`KINDGI_TENANT_HOST_ACCESS=deployed` or `isolated`); or `authz-denied`.',
      ),
      '409': ErrorResponse(
        `MCP endpoint already registered at that id. Or ${ENV_NOT_SERVED_REFERENCE}`,
      ),
      '429': SCHEMA_COMPILE_BUDGET,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/mcp/endpoints/:endpointId/unregister',
    openapiPath: '/v1/mcp/endpoints/{endpointId}/unregister',
    operationId: 'mcp.endpoints.unregister',
    summary: 'Unregister an MCP endpoint',
    tags: ['mcp'],
    security: 'bearer',
    parameters: [MCPEndpointIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterMCPEndpointResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No MCP endpoint with that id under this tenant.'),
    },
  },

  // ---------- mcp resources + prompts (interop plane) ----------
  {
    method: 'get',
    honoPath: '/v1/mcp/endpoints/:endpointId/resources',
    openapiPath: '/v1/mcp/endpoints/{endpointId}/resources',
    operationId: 'mcp.endpoints.resources.list',
    summary: 'List resources at a remote MCP endpoint',
    description:
      'Bootstraps a per-request MCP client against the endpoint, calls `resources/list`, and returns the descriptors verbatim.',
    tags: ['mcp'],
    security: 'bearer',
    parameters: [MCPEndpointIdPathParam],
    responses: {
      '200': { description: 'MCP resource descriptors.', schema: ref('MCPResourceCollection') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No MCP endpoint with that id under this tenant.'),
      '502': ErrorResponse('Remote MCP endpoint failed to serve resources/list.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/mcp/endpoints/:endpointId/resources/:uri',
    openapiPath: '/v1/mcp/endpoints/{endpointId}/resources/{uri}',
    operationId: 'mcp.endpoints.resources.read',
    summary: 'Read a single resource at a remote MCP endpoint',
    description:
      'URI path segment is URL-encoded — decoded server-side before dispatch to the endpoint. Returns exactly one content payload (`text` XOR `blob` per MCP spec).',
    tags: ['mcp'],
    security: 'bearer',
    parameters: [MCPEndpointIdPathParam, MCPResourceUriPathParam],
    responses: {
      '200': { description: 'MCP resource content.', schema: ref('MCPResourceContent') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No MCP endpoint or resource with that id.'),
      '502': ErrorResponse('Remote MCP endpoint failed to serve resources/read.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/mcp/endpoints/:endpointId/prompts',
    openapiPath: '/v1/mcp/endpoints/{endpointId}/prompts',
    operationId: 'mcp.endpoints.prompts.list',
    summary: 'List prompts at a remote MCP endpoint',
    description:
      'Bootstraps a per-request MCP client against the endpoint, calls `prompts/list`, and returns the descriptors verbatim.',
    tags: ['mcp'],
    security: 'bearer',
    parameters: [MCPEndpointIdPathParam],
    responses: {
      '200': { description: 'MCP prompt descriptors.', schema: ref('MCPPromptCollection') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No MCP endpoint with that id under this tenant.'),
      '502': ErrorResponse('Remote MCP endpoint failed to serve prompts/list.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/mcp/endpoints/:endpointId/prompts/:name',
    openapiPath: '/v1/mcp/endpoints/{endpointId}/prompts/{name}',
    operationId: 'mcp.endpoints.prompts.get',
    summary: 'Resolve a prompt template at a remote MCP endpoint',
    description:
      'Body carries `{ arguments?: Record<string, string> }`. Returns the ordered message list the endpoint produced.',
    tags: ['mcp'],
    security: 'bearer',
    parameters: [MCPEndpointIdPathParam, MCPPromptNamePathParam],
    requestBody: { required: false, schema: ref('GetMCPPromptBody') },
    responses: {
      '200': { description: 'Rendered prompt messages.', schema: ref('GetMCPPromptResult') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed body.'),
      '404': ErrorResponse('No MCP endpoint or prompt with that name.'),
      '502': ErrorResponse('Remote MCP endpoint failed to serve prompts/get.'),
    },
  },

  // ---------- cost (admin plane) ----------
  {
    method: 'get',
    honoPath: '/v1/cost/records',
    openapiPath: '/v1/cost/records',
    operationId: 'cost.records.list',
    summary: 'List cost records',
    description:
      "Cursor-paginated. Filters (all AND): `runId` (with `includeDescendants`, its whole subtree), `rootRunId`, `flowId`, `agentId`, `conversationId`, `category`, `providerId`, `model`, `servedModel`, `from`, `to`. Sort order is fixed: `occurredAt desc, id desc`. Records represent one accounted resource event each — a model call (`category` `llm.inference`: one record per call, with its model, usage and what the vendor said about it), tool invocation, storage write, sandbox execution, etc. `include=rawUsage` adds each model call's usage as the vendor reported it.",
    tags: ['cost'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      CostRunIdQueryParam,
      CostAgentIdQueryParam,
      CostConversationIdQueryParam,
      CostCategoryQueryParam,
      CostProviderIdQueryParam,
      CostModelQueryParam,
      CostServedModelQueryParam,
      CostRootRunIdQueryParam,
      CostFlowIdQueryParam,
      CostIncludeDescendantsQueryParam,
      CostFromQueryParam,
      CostToQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
      CostIncludeQueryParam,
    ],
    responses: {
      '200': { description: 'Page of cost records.', schema: ref('CostRecordCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/cost/records/:recordId',
    openapiPath: '/v1/cost/records/{recordId}',
    operationId: 'cost.records.get',
    summary: 'Fetch a cost record',
    tags: ['cost'],
    security: 'bearer',
    parameters: [CostRecordIdPathParam, CostIncludeQueryParam],
    responses: {
      '200': { description: 'Cost record.', schema: ref('CostRecord') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No cost record with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/cost/aggregate',
    openapiPath: '/v1/cost/aggregate',
    operationId: 'cost.aggregate',
    summary: 'Aggregate cost across a time window',
    description:
      "Primary consumer path for dashboards. `groupBy` is required (comma-separated dimensions from the closed set); time range is required (both `from` and `to`, or both omitted for the default last-30-days window echoed back in `timeRange`). Filters compose on top of the time window. `?scopeKind + ?scopeId` narrow the aggregate to a scope: `org` covers every project in the org, so one call sums an org's spend. It needs `read` on the scope, and across projects (no scope, the tenant, or an org) it counts only the projects the caller may read, and records with no project; a tenant admin's counts every project. Each group, and the total, carries its cost and its token sums (`tokens`). `groups` is ordered by `totalUsd`, highest first (ties by key), and capped at `limit` (default 1000): `truncated` and `totalGroups` say when there were more, and the totals still cover every record. For every record, page through `/v1/cost/records`. `inherit` has no effect on cost records, which always belong to a project.",
    tags: ['cost'],
    security: 'bearer',
    parameters: [
      CostGroupByQueryParam,
      CostAggregateLimitQueryParam,
      CostFromQueryParam,
      CostToQueryParam,
      CostCategoryQueryParam,
      CostProviderIdQueryParam,
      CostAgentIdQueryParam,
      CostRunIdQueryParam,
      CostConversationIdQueryParam,
      CostModelQueryParam,
      CostServedModelQueryParam,
      CostRootRunIdQueryParam,
      CostFlowIdQueryParam,
      CostIncludeDescendantsQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
    ],
    responses: {
      '200': { description: 'Aggregate rollup.', schema: ref('CostAggregateResult') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'Missing / malformed `groupBy`, unknown dimension, missing one endpoint of the time range, or `from > to`.',
      ),
    },
  },

  // ---------- adapters (admin plane) ----------
  {
    method: 'get',
    honoPath: '/v1/adapters',
    openapiPath: '/v1/adapters',
    operationId: 'adapters.list',
    summary: 'List wired adapters',
    description:
      'Cursor-paginated. Optional `?kind=` / `?status=` filters narrow the result. Adapters are the concrete bridges the runtime uses to talk to outside systems (model providers, embedding providers, blob storage, sandbox providers, eval judges); the deployment aggregates the ones it wired at boot time.',
    tags: ['adapters'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      AdapterKindFilterQueryParam,
      AdapterStatusFilterQueryParam,
    ],
    responses: {
      '200': { description: 'Page of adapters.', schema: ref('AdapterCollectionPage') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '400': ErrorResponse('Malformed query parameter (unknown `kind` or `status`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/adapters/:adapterId',
    openapiPath: '/v1/adapters/{adapterId}',
    operationId: 'adapters.get',
    summary: 'Fetch a wired adapter',
    description:
      'Returns the redacted-config `Adapter` shape. Secrets never cross the wire (bindings may expose non-sensitive routing hints like `{ region }` but never credentials).',
    tags: ['adapters'],
    security: 'bearer',
    parameters: [AdapterIdPathParam],
    responses: {
      '200': { description: 'Adapter descriptor.', schema: ref('Adapter') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No adapter with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/adapters/:adapterId/test',
    openapiPath: '/v1/adapters/{adapterId}/test',
    operationId: 'adapters.test',
    summary: 'Run a kind-specific smoke probe against an adapter',
    description:
      "Body is optional — when absent the binding runs the default kind-specific probe (blob: put/get/hash/delete; sandbox: `1 + 1`; model: minimal ping completion; embedding: `'ping'`; eval-judge: pass-through). Probe failures return HTTP 200 with `ok: false` — a failed probe is a valid observation about the adapter's state, not a server error. Idempotency-Key applies (retried probes replay the cached outcome).",
    tags: ['adapters'],
    security: 'bearer',
    parameters: [AdapterIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('TestAdapterBody') },
    responses: {
      '200': { description: 'Probe outcome.', schema: ref('AdapterTestOutcome') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '404': ErrorResponse('No adapter with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/adapters/:adapterId/prepare',
    openapiPath: '/v1/adapters/{adapterId}/prepare',
    operationId: 'adapters.prepare',
    summary: 'Stream adapter preparation events (SSE)',
    description:
      "SSE stream (`text/event-stream`). Iterates the adapter factory's `prepare(params)` async generator and emits each yielded `PrepareEvent` as an SSE `data:` frame — used for warmup progress on in-process adapters (model download, cache priming, etc.). Body carries adapter-specific `params` and is passed through unchanged. Returns 404 when the adapter id is unknown to the in-process factory registry, and 400 `bad-input` when the adapter has no `prepare()` implementation (e.g. remote model providers with nothing to download) or the deployment did not wire an `adapterFactories` binding.",
    tags: ['adapters'],
    security: 'bearer',
    parameters: [AdapterIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: { type: 'object', additionalProperties: true } },
    responses: {
      '200': {
        description: 'SSE stream of `PrepareEvent` frames — adapter-specific payload shape.',
        schema: { type: 'string' },
      },
      ...CommonAuthErrors,
      ...TenantAdminErrors,
      '400': ErrorResponse(
        'Adapter has no prepare() implementation, or adapter factories not wired.',
      ),
      '404': ErrorResponse('No adapter registered with that id.'),
    },
  },

  // ---------- policies (admin plane) ----------
  {
    method: 'get',
    honoPath: '/v1/policies',
    openapiPath: '/v1/policies',
    operationId: 'policies.list',
    summary: 'List tenant policies',
    description:
      'Cursor-paginated. Optional `?kind=` narrows to a single policy kind (exact match); optional `?name=` is a prefix match on `Policy.id`. Sort order: policy id ascending. Latest version per id.',
    tags: ['policies'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      PolicyKindFilterQueryParam,
      PolicyNameFilterQueryParam,
    ],
    responses: {
      '200': { description: 'Page of policies.', schema: ref('PolicyCollectionPage') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '400': ErrorResponse('Malformed query parameter (unknown `kind`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/policies/:policyId',
    openapiPath: '/v1/policies/{policyId}',
    operationId: 'policies.get',
    summary: 'Fetch a policy (latest version)',
    tags: ['policies'],
    security: 'bearer',
    parameters: [PolicyIdPathParam],
    responses: {
      '200': { description: 'Latest policy version.', schema: ref('Policy') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No policy with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/policies/:policyId/versions',
    openapiPath: '/v1/policies/{policyId}/versions',
    operationId: 'policies.versions.list',
    summary: 'List versions of a policy',
    description:
      'Cursor-paginated list of policy versions. Defaults to active-only. Pass `?includeTombstoned=true` to include soft-tombstoned rows too; tombstoned rows carry `unregisteredAt` (ISO string), active rows do not.',
    tags: ['policies'],
    security: 'bearer',
    parameters: [PolicyIdPathParam, LimitQueryParam, CursorQueryParam, IncludeTombstonedQueryParam],
    responses: {
      '200': {
        description: 'Page of policy versions.',
        schema: ref('PolicyVersionCollectionPage'),
      },
      '400': ErrorResponse("`bad-input`: a `cursor` this list didn't issue."),
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No policy with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/policies/:policyId/versions/:version',
    openapiPath: '/v1/policies/{policyId}/versions/{version}',
    operationId: 'policies.versions.get',
    summary: 'Fetch a specific policy version',
    description: 'An unregistered version is returned too, with `unregisteredAt`.',
    tags: ['policies'],
    security: 'bearer',
    parameters: [PolicyIdPathParam, PolicyVersionPathParam],
    responses: {
      '200': { description: 'Policy at that version.', schema: ref('PolicyVersionRow') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No policy at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/policies',
    openapiPath: '/v1/policies',
    operationId: 'policies.publish',
    summary: 'Publish a policy',
    description:
      "Body is a full `Policy` — the server validates top-level shape (id, tenantId, semver version, kind ∈ closed enum, spec is an object), and `spec` for `tool-errors`, `hitl` and `retention` (a retention policy with an unknown domain or `mode: archive` is refused with `400 validation-failed`, naming the field). Other kinds' specs are their runtime consumer's to validate. Re-publishing an existing `(policyId, version)` returns `409 policy-already-registered`. A tenant has one retention policy per domain, plus one for `*`: a second policy id for a covered domain is refused with `409 policy-scope-taken` (`details.heldBy` names the policy that covers it; publish a new version of that one instead), and a new version can't move a policy to another domain (`409 policy-scope-changed`). Where this server has a retention limit for a domain, a policy for that domain that keeps its rows longer, or holds them (`graceSeconds: -1`), is refused with `400 retention-over-limit` (`details.limitSeconds` is the limit); a `*` policy isn't, as the server caps each limited domain when it sweeps. A known kind that no runtime consumer applies yet (`access-control`, `adapter-allowlist`, `rate-limit`, `compliance`) is refused with `400 kind-not-applied` (`details.appliedKinds` lists the ones that are): publishing it would change nothing. Idempotency-Key applies (retries with the same key replay the original 201).",
    tags: ['policies'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PublishPolicyBody') },
    responses: {
      '201': { description: 'Policy published.', schema: ref('PublishPolicyResult') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.issues`); `kind-not-applied`: no runtime consumer applies that kind yet; or `retention-over-limit`: the retention policy keeps its domain's rows longer than this server's limit, or holds them (`details.limitSeconds`).",
      ),
      '409': ErrorResponse(
        '`policy-already-registered`: that (id, version) exists. `policy-scope-taken`: another policy covers the retention domain (`details.heldBy`). `policy-scope-changed`: the version would move the policy to another domain.',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/policies/:policyId/versions/:version/unregister',
    openapiPath: '/v1/policies/{policyId}/versions/{version}/unregister',
    operationId: 'policies.versions.unregister',
    summary: 'Unregister a policy version',
    tags: ['policies'],
    security: 'bearer',
    parameters: [PolicyIdPathParam, PolicyVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterPolicyResult') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '404': ErrorResponse('No policy at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/policies/:policyId/versions/:version/reinstate',
    openapiPath: '/v1/policies/{policyId}/versions/{version}/reinstate',
    operationId: 'policies.reinstateVersion',
    summary: 'Reinstate a specific tombstoned policy version',
    description:
      "Un-tombstones a previously-unregistered version: clears the tombstone on that version and recomputes the latest active version (and refreshes `policyKind` to match). Restores manifest bytes verbatim (semver hygiene). Idempotent. Reactivates a fully-retired policy identity when applicable. Publish is always allowed regardless of retirement state. A version whose retention policy keeps its domain's rows longer than this server's limit, or holds them, stays retired (`400 retention-over-limit`).",
    tags: ['policies'],
    security: 'bearer',
    parameters: [PolicyIdPathParam, PolicyVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Reinstated.', schema: ref('ReinstatePolicyVersionResult') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '400': ErrorResponse(
        "`retention-over-limit`: the version's retention policy keeps its domain's rows longer than this server's limit, or holds them (`details.limitSeconds`); it stays retired.",
      ),
      '404': ErrorResponse('No policy at that (id, version) under this tenant.'),
      '409': ErrorResponse(
        "`policy-scope-taken`: another policy now covers the version's retention domain (`details.heldBy`); unregister it first. `policy-scope-changed`: the version covers a different domain from the policy's other versions.",
      ),
    },
  },

  // ---------- retention (admin plane) ----------
  {
    method: 'get',
    honoPath: '/v1/retention/scheduled',
    openapiPath: '/v1/retention/scheduled',
    operationId: 'retention.scheduled',
    summary: 'List deleted rows scheduled for purging',
    description:
      "Tombstoned rows in every domain a retention policy or this server's retention limit covers, with when each is purged (`purgeAt`) and what decides it: the policy (`policyId`), or the limit (`limitApplied`) when no policy covers the domain or its policy keeps rows longer. `domainsMissingAdapter` names the covered domains this deployment can't purge; `unpolicedDomains` the ones neither covers, whose tombstones are kept; `conflicts` the domains two policies cover (stored before one policy per domain was enforced). `limit` caps the rows **per domain**; `hasMore` says some domain has more than it returned, and `nextCursor` (when the runtime can continue) is the `cursor` for the next page. Requires `admin` on the tenant.",
    tags: ['retention'],
    security: 'bearer',
    parameters: [
      RetentionDomainQueryParam,
      RetentionPastGraceOnlyQueryParam,
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': { description: 'Scheduled rows.', schema: ref('RetentionScheduledPage') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '400': ErrorResponse('Unknown `domain`.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/retention/sweep',
    openapiPath: '/v1/retention/sweep',
    operationId: 'retention.sweep',
    summary: 'Purge the deleted rows past their grace',
    description:
      "Purges, for good, every tombstoned row past its grace (or only `domain`'s): the grace of the retention policy that covers its domain, or this server's limit for the domain when no policy covers it or the policy keeps rows longer (`limitApplied`), up to `maxPerDomain` per domain; `remaining` counts what is left for the next call. Nothing sweeps on its own: call this (or `POST /v1/retention/sweep/{domain}`) from a schedule. A hold (`graceSeconds: -1`) keeps its domain's rows, unless the domain has a limit. Idempotent: a second call purges nothing new. Requires `admin` on the tenant.",
    tags: ['retention'],
    security: 'bearer',
    requestBody: { required: false, schema: ref('RetentionSweepBody') },
    responses: {
      '200': { description: 'What was purged, per domain.', schema: ref('RetentionSweepResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '400': ErrorResponse('Unknown `domain`, or `maxPerDomain` outside 1..10000.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/retention/sweep/:domain',
    openapiPath: '/v1/retention/sweep/{domain}',
    operationId: 'retention.sweepDomain',
    summary: "Purge one domain's deleted rows past their grace",
    description: 'As `POST /v1/retention/sweep`, for one domain. Requires `admin` on the tenant.',
    tags: ['retention'],
    security: 'bearer',
    parameters: [RetentionDomainPathParam],
    requestBody: { required: false, schema: ref('RetentionSweepDomainBody') },
    responses: {
      '200': { description: 'What was purged.', schema: ref('RetentionSweepResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '400': ErrorResponse('Unknown `domain` (or `*`), or `maxPerDomain` outside 1..10000.'),
    },
  },

  // ---------- test sets (admin plane) ----------
  {
    method: 'get',
    honoPath: '/v1/test-sets',
    openapiPath: '/v1/test-sets',
    operationId: 'testSets.list',
    summary: 'List tenant test sets',
    description:
      'Cursor-paginated. Optional `?kind=` narrows to a single eval kind (exact match); optional `?name=` is a prefix match on `TestSet.id`. Sort order: test set id ascending. Latest version per id. A retired test set (every version unregistered) is listed only with `?includeRetired=true`, as its highest version with `unregisteredAt`, so it can be found and a version reinstated.',
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      TestSetKindFilterQueryParam,
      TestSetNameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
      IncludeRetiredQueryParam,
    ],
    responses: {
      '200': { description: 'Page of test sets.', schema: ref('TestSetCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter (unknown `kind`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/test-sets/:testSetId',
    openapiPath: '/v1/test-sets/{testSetId}',
    operationId: 'testSets.get',
    summary: 'Fetch a test set (latest version)',
    description: NEWEST_VISIBLE_DESCRIPTION,
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [TestSetIdPathParam, ItemProjectQueryParam],
    responses: {
      '200': { description: 'Latest test set version.', schema: ref('TestSet') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`projectId` is not a project id (a UUID).'),
      '404': ErrorResponse('No test set with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/test-sets/:testSetId/versions',
    openapiPath: '/v1/test-sets/{testSetId}/versions',
    operationId: 'testSets.versions.list',
    summary: 'List versions of a test set',
    description:
      'Cursor-paginated. Sort order is binding-defined (for example ascending semver). Defaults to active versions only. Pass `?includeTombstoned=true` to include unregistered versions too, each with `unregisteredAt`: a retired test set (every version unregistered) answers too, with its versions to reinstate.',
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [
      TestSetIdPathParam,
      LimitQueryParam,
      CursorQueryParam,
      IncludeTombstonedQueryParam,
    ],
    responses: {
      '200': {
        description: 'Page of test set versions.',
        schema: ref('TestSetCollectionPage'),
      },
      '400': ErrorResponse("`bad-input`: a `cursor` this list didn't issue."),
      ...CommonAuthErrors,
      '404': ErrorResponse('No test set was ever registered with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/test-sets/:testSetId/versions/:version',
    openapiPath: '/v1/test-sets/{testSetId}/versions/{version}',
    operationId: 'testSets.versions.get',
    summary: 'Fetch a specific test set version',
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [TestSetIdPathParam, TestSetVersionPathParam],
    responses: {
      '200': { description: 'Test set at that version.', schema: ref('TestSet') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No test set at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/test-sets',
    openapiPath: '/v1/test-sets',
    operationId: 'testSets.publish',
    summary: 'Publish a test set',
    description:
      "Body is a full `TestSet` — the server validates top-level shape (id, tenantId, semver version, kind ∈ closed enum, spec is an object). Deeper `spec` validation is the runtime consumer's responsibility per kind (eval-judge adapter for `accuracy`/`pairwise`/`regression`, HITL bridge for `human-review`, sandbox handler for `custom`). Re-publishing an existing `(testSetId, version)` returns `409 test-set-already-registered`. Idempotency-Key applies (retries with the same key replay the original 201).",
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PublishTestSetBody') },
    responses: {
      '201': { description: 'Test set published.', schema: ref('PublishTestSetResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID).",
      ),
      '409': ErrorResponse(
        "`test-set-already-registered`: that (id, version) is taken. Or `test-set-project-mismatch`: the test set's versions live in another project (a test set belongs to the project its first version was published into and never moves; the message doesn't name the project).",
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/test-sets/:testSetId/versions/from-corrections',
    openapiPath: '/v1/test-sets/{testSetId}/versions/from-corrections',
    operationId: 'testSets.buildFromCorrections',
    summary: 'Build a test set from corrections',
    description:
      "Publishes a `corrections` test set version whose cases are copies of corrected runs of one agent (optionally one version) or flow, newest first, at most 1000. Each case holds the run's input, what the turn read (`context`), the corrected output, and each item's corrections summed up: yes and no counts, the weight behind yes and behind all corrections (an unclassified correction counts 1), and the reasons. `correctorGroupIds` counts only corrections of those classes; `minCorrections` leaves out runs with fewer; `segments` keeps only runs started in that segment path or below it. Needs `admin` on the project.",
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [TestSetIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('BuildCorrectedTestSetBody') },
    responses: {
      '201': { description: 'Version published.', schema: ref('BuildCorrectedTestSetResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse("Malformed body; or `projectId` isn't a project id (a UUID)."),
      '403': ErrorResponse('`permission-denied`.'),
      '409': ErrorResponse(
        "`test-set-already-registered`: that (id, version) is taken. Or `test-set-project-mismatch`: the test set belongs to another project than the body's `projectId` (testSets never move).",
      ),
      '501': ErrorResponse('`test-sets-not-supported`: this deployment cannot build test sets.'),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/test-sets/:testSetId/versions/:version/cases',
    openapiPath: '/v1/test-sets/{testSetId}/versions/{version}/cases',
    operationId: 'testSets.listCases',
    summary: 'List the cases of a corrections test set version',
    description:
      'Cursor-paginated, in the order the cases were stored (newest corrected run first).',
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [TestSetIdPathParam, TestSetVersionPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of cases.', schema: ref('CorrectedEvalCaseCollectionPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No test set with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/test-sets/:testSetId/versions/:version/unregister',
    openapiPath: '/v1/test-sets/{testSetId}/versions/{version}/unregister',
    operationId: 'testSets.versions.unregister',
    summary: 'Unregister a test set version',
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [TestSetIdPathParam, TestSetVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterTestSetResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No test set at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/test-sets/:testSetId/versions/:version/reinstate',
    openapiPath: '/v1/test-sets/{testSetId}/versions/{version}/reinstate',
    operationId: 'testSets.reinstateVersion',
    summary: 'Reinstate a specific tombstoned test set version',
    description:
      'Un-tombstones a previously-unregistered version: clears the tombstone on that version and recomputes the latest active version (refreshes `testSetKind` to match). Restores manifest bytes verbatim (semver hygiene). Idempotent. Publish is always allowed regardless of retirement state.',
    tags: ['test-sets'],
    security: 'bearer',
    parameters: [TestSetIdPathParam, TestSetVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Reinstated.', schema: ref('ReinstateTestSetVersionResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No test set at that (id, version) under this tenant.'),
    },
  },

  // ---------- test runs (data plane) ----------
  {
    method: 'get',
    honoPath: '/v1/blocks',
    openapiPath: '/v1/blocks',
    operationId: 'blocks.list',
    summary: 'List data blocks (latest version of each)',
    description:
      'Cursor-paginated. Only the blocks of projects the caller can read. `?kind=` narrows to prompts or settings, `?name=` is a prefix match on the id, and `?scopeKind=` + `?scopeId=` narrow to a project or an org, as the other lists do.',
    tags: ['blocks'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      BlockKindFilterQueryParam,
      BlockNameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
    ],
    responses: {
      '200': { description: 'Page of blocks.', schema: ref('BlockCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'Malformed query parameter: an unknown `kind`, or `scope-invalid` for a malformed scope.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/blocks/:blockId',
    openapiPath: '/v1/blocks/{blockId}',
    operationId: 'blocks.get',
    summary: 'Fetch a data block (latest version)',
    description: NEWEST_VISIBLE_DESCRIPTION,
    tags: ['blocks'],
    security: 'bearer',
    parameters: [BlockIdPathParam, ItemProjectQueryParam],
    responses: {
      '200': { description: 'Latest active version.', schema: ref('Block') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`projectId` is not a project id (a UUID).'),
      '404': ErrorResponse(
        "`block-not-found`: no such block, or one in a project the caller can't read.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/blocks/:blockId/versions',
    openapiPath: '/v1/blocks/{blockId}/versions',
    operationId: 'blocks.versions.list',
    summary: 'List versions of a data block',
    description:
      'Newest published first. `?includeTombstoned=true` includes unregistered versions, each with `unregisteredAt`.',
    tags: ['blocks'],
    security: 'bearer',
    parameters: [BlockIdPathParam, LimitQueryParam, CursorQueryParam, IncludeTombstonedQueryParam],
    responses: {
      '200': { description: 'Page of versions.', schema: ref('BlockCollectionPage') },
      '400': ErrorResponse("`bad-input`: a `cursor` this list didn't issue."),
      ...CommonAuthErrors,
      '404': ErrorResponse('`block-not-found`.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/blocks/:blockId/versions/:version',
    openapiPath: '/v1/blocks/{blockId}/versions/{version}',
    operationId: 'blocks.versions.get',
    summary: 'Fetch a specific data block version',
    description: 'An unregistered version is returned too, with `unregisteredAt`.',
    tags: ['blocks'],
    security: 'bearer',
    parameters: [BlockIdPathParam, BlockVersionPathParam],
    responses: {
      '200': { description: 'The block at that version.', schema: ref('Block') },
      ...CommonAuthErrors,
      '404': ErrorResponse('`block-not-found`.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/blocks',
    openapiPath: '/v1/blocks',
    operationId: 'blocks.publish',
    summary: 'Publish a data block version',
    description:
      "Needs `write` on the project. A prompt's template must parse as Liquid; a settings block's `values` must satisfy its `schema` and the latest version's. A taken version is `409 block-already-registered` (versions never change); a block keeps its kind, and its versions stay in its first version's project, or another project of that project's environment order (`409 block-project-mismatch`). A later environment of an order takes no publishes (`409 environment-takes-promotions`). Idempotency-Key applies.",
    tags: ['blocks'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PublishBlockBody') },
    responses: {
      '201': { description: 'Published.', schema: ref('PublishBlockResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "`validation-failed` (see `details.issues`), or an unknown `projectId`; or `projectId` isn't a project id (a UUID).",
      ),
      '403': ErrorResponse('`permission-denied`: no `write` on the project.'),
      '409': ErrorResponse(
        `\`block-already-registered\` or \`block-project-mismatch\`. ${TAKES_PROMOTIONS} Or \`registry-read-only\`: this registry takes no writes (under \`kindgi dev\`, the pack's files are the source); the message says what to do instead.`,
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '429': SCHEMA_COMPILE_BUDGET,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/blocks/:blockId/versions/:version/unregister',
    openapiPath: '/v1/blocks/{blockId}/versions/{version}/unregister',
    operationId: 'blocks.versions.unregister',
    summary: 'Unregister a data block version',
    description:
      'Soft: no range picks it any more, but the agent versions that pin it keep running it, and GET still reads it. Needs `write` on the project.',
    tags: ['blocks'],
    security: 'bearer',
    parameters: [BlockIdPathParam, BlockVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterBlockResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '403': ErrorResponse('`permission-denied`: no `write` on the project.'),
      '404': ErrorResponse('`block-not-found`, or already unregistered.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/blocks/:blockId/versions/:version/reinstate',
    openapiPath: '/v1/blocks/{blockId}/versions/{version}/reinstate',
    operationId: 'blocks.versions.reinstate',
    summary: 'Reinstate an unregistered data block version',
    description: 'Unchanged, as published. Idempotent. Needs `write` on the project.',
    tags: ['blocks'],
    security: 'bearer',
    parameters: [BlockIdPathParam, BlockVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Reinstated.', schema: ref('ReinstateBlockResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '403': ErrorResponse('`permission-denied`: no `write` on the project.'),
      '404': ErrorResponse('`block-not-found`.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/test-sets/:testSetId/runs',
    openapiPath: '/v1/test-sets/{testSetId}/runs',
    operationId: 'testRuns.start',
    summary: 'Start a test run against a test set',
    description:
      'Dispatches a test run against the latest version of the test set. Exactly one of `agentRef` / `flowRef` is required — the subject the test set evaluates. Dispatch is per-kind: `accuracy` runs the subject once per case and grades via a configured judge; other kinds return `422 dispatcher-not-registered` unless the deployment registers a dispatcher for them. Nothing starts in a suspended project (`409 project-suspended`), and a run going when its project or tenant stops taking new runs ends `cancelled` at the next case, with the reason in `cancelReason`. Idempotency-Key applies.',
    tags: ['test-runs'],
    security: 'bearer',
    parameters: [TestSetIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('StartTestRunBody') },
    responses: {
      '201': { description: 'Test run started.', schema: ref('StartTestRunResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed body (both / neither of `agentRef` / `flowRef`, dispatcher-input-invalid); or `projectId` isn't a project id (a UUID). Or `reference-out-of-scope`: the test set, the agent or flow, or an agent or tool a flow candidate's `versions` names, isn't registered in `projectId`'s project, its org or the tenant; or a version named (by `agentRef`, `flowRef` or `versions.agents`) isn't one `projectId`'s project runs (`details.issues`, each at the path it was named, whose message names the version). Nothing runs.",
      ),
      '404': ErrorResponse(
        'No test set with that id under this tenant; or `projectId` names no project of this tenant (`project-not-found`).',
      ),
      '409': ErrorResponse(
        '`project-suspended`: the project is suspended, so no test run starts in it. Or Idempotency-Key was reused with a different body.',
      ),
      '422': ErrorResponse('No dispatcher registered for the test set kind.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/test-runs',
    openapiPath: '/v1/test-runs',
    operationId: 'testRuns.list',
    summary: 'List test runs',
    description:
      'Cursor-paginated. Filters: `?testSetId=` / `?status=` / `?agentId=` / `?flowId=` / `?from=` / `?to=`. Sort order: startedAt descending, runId descending as tie-breaker.',
    tags: ['test-runs'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      TestRunTestSetIdFilterQueryParam,
      TestRunStatusFilterQueryParam,
      TestRunAgentIdFilterQueryParam,
      TestRunFlowIdFilterQueryParam,
      TestRunFromFilterQueryParam,
      TestRunToFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
    ],
    responses: {
      '200': { description: 'Page of test runs.', schema: ref('TestRunCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter (unknown `status`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/test-runs/:testRunId',
    openapiPath: '/v1/test-runs/{testRunId}',
    operationId: 'testRuns.get',
    summary: 'Fetch a test run',
    tags: ['test-runs'],
    security: 'bearer',
    parameters: [TestRunIdPathParam],
    responses: {
      '200': { description: 'Test run.', schema: ref('TestRun') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No test run with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/test-runs/:testRunId/cancel',
    openapiPath: '/v1/test-runs/{testRunId}/cancel',
    operationId: 'testRuns.cancel',
    summary: 'Cancel a test run',
    description: 'Best-effort cancel. Returns 409 when the run is already terminal.',
    tags: ['test-runs'],
    security: 'bearer',
    parameters: [TestRunIdPathParam],
    responses: {
      '200': { description: 'Cancel accepted.', schema: ref('TestRun') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No test run with that id under this tenant.'),
      '409': ErrorResponse('Run already terminal.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/test-runs/:testRunId/rescore',
    openapiPath: '/v1/test-runs/{testRunId}/rescore',
    operationId: 'testRuns.rescore',
    summary: 'Rescore a comparison test run',
    description:
      "Starts a new comparison test run of the same test set version, candidate and settings that replays nothing: it scores the run's replays again, with the corrections recorded on them since (a changed answer corrected on the replay itself; `changes.new` lists the items to correct). The run rescored stays as it was; the new one names it (`comparison.rescoreOf`, `summary.rescoreOf`). A case whose replays can't be read again keeps its scores (`rescored: false`). Needs `admin` on the run's test set and `write` on its project.",
    tags: ['test-runs'],
    security: 'bearer',
    parameters: [TestRunIdPathParam],
    requestBody: { required: false, schema: ref('RescoreTestRunBody') },
    responses: {
      '201': { description: 'The rescore started.', schema: ref('StartTestRunResult') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "`bad-input`: `projectId` is required (this runtime doesn't record the run's project), or isn't a project here. `dispatcher-input-invalid`: this runtime can't rescore (it doesn't read replays and their corrections again).",
      ),
      '404': ErrorResponse('No test run with that id under this tenant.'),
      '409': ErrorResponse(
        '`test-run-not-rescorable`: only a completed comparison of a test set can be rescored.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/test-runs/:testRunId/events',
    openapiPath: '/v1/test-runs/{testRunId}/events',
    operationId: 'testRuns.events',
    summary: 'Stream test-run events (SSE)',
    description:
      'Server-Sent Events. Per-case progress events (`test-run.case-completed` / `test-run.case-failed`) followed by a terminal event (`test-run.completed` / `test-run.failed` / `test-run.cancelled`) carrying the aggregate result. Mirrors `/v1/runs/:runId/stream` structurally.',
    tags: ['test-runs'],
    security: 'bearer',
    parameters: [TestRunIdPathParam, LastEventIdParam],
    responses: {
      '200': {
        description: 'Server-Sent Event stream (`text/event-stream`).',
        contentType: 'text/event-stream',
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No test run with that id under this tenant.'),
    },
  },

  // ---------- auth ----------
  {
    method: 'get',
    honoPath: '/v1/auth/providers',
    openapiPath: '/v1/auth/providers',
    operationId: 'auth.providers.list',
    summary: 'List identity providers configured for the tenant',
    description:
      "Returns the tenant's identity providers (OIDC, SAML), each with `signIn` when the deployment sets it. Secrets appear only as REFERENCES (`clientSecretRef`, `spSigningKeyRef`…); a plaintext secret is never on the wire.",
    tags: ['auth'],
    security: 'bearer',
    responses: {
      '200': {
        description: 'Page of provider configs.',
        schema: ref('IdentityProviderCollectionPage'),
      },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/auth/sign-in-options',
    openapiPath: '/v1/auth/sign-in-options',
    operationId: 'auth.signInOptions',
    summary: 'How a person can sign in',
    description:
      'Public: nobody is signed in yet. With `email`, the ways in for that email\'s domain: the identity providers of the one tenant the domain is verified for (an unverified domain offers none), then any the deployment offers everyone it has added (`owner: deployment`, "Continue with Google"); without, an empty list: sign-in is email first, so nothing is offered before an email. `methods` says which ways in the deployment allows: identity providers, an API token (`POST /v1/auth/token-sign-in`), and an emailed sign-in link (`emailLink`, with a captcha site key when it needs one); `identityProviders` and `apiToken` both `false` when nobody can sign in to the console. Always mounted. The answer depends only on the domain: two people at the same domain get the same answer, whether or not either has an account. Lookups with an email are rate-limited per client (`429 rate-limit-exceeded`, with `Retry-After`); a read without one, the same for everyone, isn\'t counted.',
    tags: ['auth'],
    security: 'public',
    parameters: [
      {
        name: 'email',
        in: 'query',
        required: false,
        schema: { type: 'string', minLength: 3 },
        description: 'The email the person typed; only its domain is used.',
      },
    ],
    responses: {
      '200': { description: 'The ways to sign in (possibly none).', schema: ref('SignInOptions') },
      '400': ErrorResponse('`email` is not an email address.'),
      '429': ErrorResponse('Too many lookups from this client.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/token-sign-in',
    openapiPath: '/v1/auth/token-sign-in',
    operationId: 'auth.tokenSignIn',
    summary: 'Sign in to the console with an API token',
    description:
      "The API token in `Authorization` is exchanged once for a browser session in the session cookie (HttpOnly; the same as a sign-in with an identity provider), so the browser never keeps the token. Only a person's full key opens a session: a service account's key, or a narrowed one (a `member` role, or one project), is refused `403 token-sign-in-not-allowed`. The session ends after its lifetime, when the key expires if sooner, or when the key is revoked: each request on it reads the key, and one revoked or gone answers `401 auth-revoked`. `403 token-sign-in-off` when the deployment doesn't allow it, or can't read its API keys to check such a session (always mounted, so a console gets that answer); `400 token-sign-in-needs-an-api-token` when the request is already signed in by a session. `403 second-factor-required` in a workspace that requires a second factor at sign-in, which a token can't give.",
    tags: ['auth'],
    security: 'bearer',
    responses: {
      '200': {
        description: 'Signed in: the session cookie is set.',
        schema: ref('TokenSignInResult'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'Signed in by a session, not an API token (`token-sign-in-needs-an-api-token`).',
      ),
      '403': ErrorResponse(
        "Not allowed here (`token-sign-in-off`: the deployment doesn't allow it, or can't read its API keys), or not this key (`token-sign-in-not-allowed`): a service account's, or a narrowed one; or the workspace requires a second factor (`second-factor-required`).",
      ),
      '409': ErrorResponse(
        "A retry with the Idempotency-Key of a sign-in that succeeded: its session was in the cookie, which isn't kept (`idempotency-key-replay-withheld`). Sign in again without the key.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/providers',
    openapiPath: '/v1/auth/providers',
    operationId: 'auth.providers.register',
    summary: 'Register an identity provider (OIDC or SAML)',
    description:
      'Unique per tenant on `providerId`: re-registering a known provider returns `409 identity-provider-already-registered`; change it with `PATCH /v1/auth/providers/{providerId}`, which keeps its sign-in URLs. Secrets are given by reference (`clientSecretRef`, `spSigningKeyRef`…); a `clientSecret` (or a raw key) is refused with `400 invalid-provider-config`, as is `allowedRedirectUris`, which nothing would enforce (sign-in runs in the deployment, at its own callback URL). The deployment may check the configuration (OIDC discovery, SAML metadata): `422 identity-provider-invalid` says what failed. The answer carries the stored provider when the deployment returns it, with `signIn`: what to give the identity provider.',
    tags: ['auth'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterIdentityProviderBody') },
    responses: {
      '201': {
        description: 'Provider registered.',
        schema: ref('RegisterIdentityProviderResult'),
      },
      ...CommonMutationErrors,
      '403': ProviderChangeRefused,
      '409': providerChangeConflict(
        ' (`identity-provider-already-registered`: a provider with this id is registered)',
      ),
      '422': ErrorResponse(
        'The deployment could not use the configuration, or `kind` is `oauth2`, a plain OAuth 2.0 provider, which sign-in does not use (`identity-provider-invalid`).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/auth/providers/:providerId',
    openapiPath: '/v1/auth/providers/{providerId}',
    operationId: 'auth.providers.get',
    summary: 'Get one identity provider',
    description:
      'The provider as stored, with `signIn` when the deployment sets it. Secrets appear only as references.',
    tags: ['auth'],
    security: 'bearer',
    parameters: [
      {
        name: 'providerId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
    ],
    responses: {
      '200': { description: 'The provider.', schema: ref('GetIdentityProviderResult') },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '404': ErrorResponse('No identity provider registered with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/auth/providers/:providerId/sign-in',
    openapiPath: '/v1/auth/providers/{providerId}/sign-in',
    operationId: 'auth.providers.signIn',
    summary: 'What to give the identity provider, before or after registering',
    description:
      "The redirect URI (OIDC) or the ACS URL, entity ID and metadata URL (SAML) a provider under this `providerId` gets: the same before it's registered, after, and after an unregister and a new registration. So an admin sets up the identity provider's side first, then registers with what it gives back. `kind` is required until the provider is registered. Not mounted when the deployment can't say.",
    tags: ['auth'],
    security: 'bearer',
    parameters: [
      {
        name: 'providerId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'kind',
        in: 'query',
        required: false,
        schema: { $ref: '#/components/schemas/IdentityProviderKind' },
        description: "The provider's kind; default: the registered provider's.",
      },
    ],
    responses: {
      '200': {
        description: 'What to give the identity provider.',
        schema: ref('IdentityProviderSignInUrls'),
      },
      ...CommonAuthErrors,
      ...TenantSettingReadErrors,
      '400': ErrorResponse(
        "`kind` missing for a provider that isn't registered, or a kind this deployment doesn't sign in with (`bad-input`).",
      ),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/auth/providers/:providerId',
    openapiPath: '/v1/auth/providers/{providerId}',
    operationId: 'auth.providers.update',
    summary: 'Change an identity provider, keeping its sign-in URLs',
    description:
      "Merges the changes into the stored provider and checks the result as a registration is (`400 invalid-provider-config`; `422 identity-provider-invalid` when the deployment can't use it). The provider keeps its `signIn`, so nothing changes on the identity provider's side. Not mounted when the deployment can't update providers.",
    tags: ['auth'],
    security: 'bearer',
    parameters: [
      {
        name: 'providerId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('UpdateIdentityProviderBody') },
    responses: {
      '200': { description: 'Updated.', schema: ref('UpdateIdentityProviderResult') },
      ...CommonMutationErrors,
      '403': ProviderChangeRefused,
      '404': ErrorResponse('No identity provider registered with that id under this tenant.'),
      '409': providerChangeConflict(''),
      '422': ErrorResponse(
        'The deployment could not use the configuration (`identity-provider-invalid`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/providers/:providerId/unregister',
    openapiPath: '/v1/auth/providers/{providerId}/unregister',
    operationId: 'auth.providers.unregister',
    summary: 'Unregister an identity provider',
    tags: ['auth'],
    security: 'bearer',
    parameters: [
      {
        name: 'providerId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': {
        description: 'Unregistered.',
        schema: ref('UnregisterIdentityProviderResult'),
      },
      ...CommonMutationErrors,
      '403': ProviderChangeRefused,
      '404': ErrorResponse('No identity provider registered with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/auth/settings',
    openapiPath: '/v1/auth/settings',
    operationId: 'auth.settings.get',
    summary: "The workspace's sign-in settings",
    description:
      "Whether signing in takes a second factor, and how many people's keys are still on the deployment's previous sign-in secret, or on neither. Tenant admins only. Mounted when the deployment keeps second factors (from 0.1.9).",
    tags: ['auth'],
    security: 'bearer',
    responses: {
      '200': { description: 'The settings.', schema: ref('AuthSettings') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/auth/settings',
    openapiPath: '/v1/auth/settings',
    operationId: 'auth.settings.update',
    summary: 'Require a second factor at sign-in',
    description:
      "Covers signing in by the deployment's own ways in (the emailed link, and providers like Google, Microsoft and GitHub). Signing in through the workspace's own identity provider is exempt: it owns MFA there. A site's people sign in through the site, which owns their second factor, so the setting doesn't apply to them. Once required, a session made without a second factor ends at its next request, and signing in to the console with an API token is refused. API keys aren't covered: keep them to service accounts, and rotate them. From a session, turning it on takes a session made with your own second factor (`409 second-factor-enroll-first`): it would end yours. Audited. Tenant admins only. Mounted when the deployment keeps second factors (from 0.1.9).",
    tags: ['auth'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('AuthSettingsPatch') },
    responses: {
      '200': { description: 'The settings, after.', schema: ref('AuthSettings') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '409': ErrorResponse(
        'Turned on from a session made without a second factor (`second-factor-enroll-first`), or an idempotency conflict.',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/refresh',
    openapiPath: '/v1/auth/refresh',
    operationId: 'auth.refresh',
    summary: 'Refresh the current session token',
    description:
      'Requires a session token (`kgi_sk_*`); bearer tokens are managed via `/v1/tokens`. The session token rotates: the new session keeps the person, scopes and expiry, and the provider is not called. OAuth 2.1 BCP refresh-token rotation: the OLD session token is invalidated (marked rotated) — reusing it after refresh returns `401 refresh-token-invalid` so compliant clients can retry with the fresh token instead of prompting a re-auth. A browser session (the session cookie) is not refreshed: `400 cookie-session-not-refreshable`, so a new token never reaches page scripts; it ends at its TTL. Nor is a session limited to a project or a role: `400 limited-session-not-refreshable`; get a new one where you got this one.',
    tags: ['auth'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    responses: {
      '200': { description: 'New session token.', schema: ref('RefreshResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key reused with a different body (`idempotency-key-body-mismatch`), or a retry of a request that succeeded: its answer carried a secret, which isn't kept (`idempotency-key-replay-withheld`, with its `status` and `at`).",
      ),
      '400': ErrorResponse(
        'Caller presented a bearer token (refresh is session-only), a browser session (cookie), or a session limited to a project or a role (`limited-session-not-refreshable`).',
      ),
      '404': ErrorResponse('Session no longer exists.'),
      '422': ErrorResponse('Refresh with the provider failed.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/logout',
    openapiPath: '/v1/auth/logout',
    operationId: 'auth.logout',
    summary: 'Revoke the current session',
    description:
      'Requires a session token (`kgi_sk_*`); bearer tokens are managed via `/v1/tokens`. Idempotent — revoking an already-revoked session returns `{ revoked: false }`. A browser session (the session cookie) also gets its cookie cleared (`Set-Cookie` with `Max-Age=0`).',
    tags: ['auth'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    responses: {
      '200': { description: 'Revoked.', schema: ref('LogoutResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse('Caller presented a bearer token; logout is session-only.'),
    },
  },
  // ---------- identity (`whoami` consolidated here) ----------
  {
    method: 'get',
    honoPath: '/v1/identity/users',
    openapiPath: '/v1/identity/users',
    operationId: 'identity.users.list',
    summary: 'List users in the tenant',
    description:
      'Cursor-paginated list of tenant users (sort order is binding-defined), for tenant admins only. Optional `?query=` is a prefix match on `displayName` — the natural filter shape for a "search users" surface. `primaryEmail` may be redacted per tenant policy. Anyone else adds a person to a project by their email or id (`POST /v1/projects/{projectId}/memberships`).',
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'query',
        in: 'query',
        required: false,
        description: 'Prefix match on `displayName`.',
        schema: { type: 'string' },
      },
      {
        name: 'includeUnregistered',
        in: 'query',
        required: false,
        description: 'With `true`, people who were removed (`unregisteredAt`) too.',
        schema: { type: 'boolean' },
      },
      {
        name: 'pending',
        in: 'query',
        required: false,
        description:
          "With `true`, only people with an open invitation (`invite`: pending or expired), who haven't signed in yet. An older runtime ignores it and lists everyone (from 0.1.9).",
        schema: { type: 'boolean' },
      },
      {
        name: 'include',
        in: 'query',
        required: false,
        description:
          "Extra fields, comma-separated. `grants`: each person's grants, as `GET /v1/identity/users/{userId}/grants` answers them, in this one read. A runtime that doesn't read grants (no authorization store) leaves `grants` out, as an older one does.",
        schema: { type: 'string', enum: ['grants'] },
      },
    ],
    responses: {
      '200': { description: 'Page of users.', schema: ref('UserCollectionPage') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/users',
    openapiPath: '/v1/identity/users',
    operationId: 'identity.users.create',
    summary: 'Add a person',
    description:
      "Adds a person to the tenant as a tenant member, written before it answers: they can read the tenant's settings (providers, policies, adapters, signing keys, deployments), not its projects. Give them a role to work (project or team membership, or tenant admin), then mint their first API key at `POST /v1/tokens` with `for`. A person added with an email is invited (`invite`): they sign in within 7 days, or a tenant admin renews it (`POST /v1/identity/users/{userId}/invite`); the invitation is emailed where the deployment sends email, and `inviteEmail` says whether it was. Tenant admins only. Mounted when the identity directory can add people.",
    tags: ['identity'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateUserBody') },
    responses: {
      '201': {
        description: 'The new person, and whether their invitation was emailed.',
        schema: ref('UserCreated'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '409': ErrorResponse(
        'Another person of the tenant has the email (`identity-user-email-taken`), or an idempotency conflict.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/identity/users/:userId',
    openapiPath: '/v1/identity/users/{userId}',
    operationId: 'identity.users.get',
    summary: 'Get a user by id',
    description: 'A tenant admin, or the person themselves.',
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
    ],
    responses: {
      '200': { description: 'User record.', schema: ref('UserRecord') },
      ...CommonAuthErrors,
      '403': ErrorResponse("Someone else's record, and not a tenant admin."),
      '404': ErrorResponse('No user with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/identity/users/:userId/sessions',
    openapiPath: '/v1/identity/users/{userId}/sessions',
    operationId: 'identity.users.listSessions',
    summary: 'List active sessions for a user',
    description:
      'A tenant admin, or the person themselves. Returns the wire-safe `IdentitySessionSummary` shape — provider access-token + refresh-token never cross the wire, even to admins. Unknown user id returns an empty list (call `GET /v1/identity/users/:userId` first to distinguish "no sessions" from "no user").',
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
    ],
    responses: {
      '200': { description: 'Page of sessions.', schema: ref('IdentitySessionCollectionPage') },
      ...CommonAuthErrors,
      '403': ErrorResponse("Someone else's sessions, and not a tenant admin."),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/users/:userId/unregister',
    openapiPath: '/v1/identity/users/{userId}/unregister',
    operationId: 'identity.users.unregister',
    summary: 'Remove a person',
    description:
      "Removes a person from the tenant, in one step: they're marked removed (`unregisteredAt`; their record stays, so their history still says who they were), every API key and session of theirs is revoked, and every grant and membership they hold is taken away, all before it answers. Their keys get `401` at once. Their email is free again: adding it makes a new person. Removing someone already removed changes nothing. Refused for yourself and the deployment's seed user (`identity-user-unregister-refused`), and for the only tenant admin (`last-tenant-admin`). Tenant admins only. Mounted when the identity directory can remove people.",
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': {
        description: 'The removed person, and what removing them took away.',
        schema: ref('UnregisterUserResult'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No user with that id under this tenant (`identity-user-not-found`).'),
      '409': ErrorResponse(
        'Yourself or the seed user (`identity-user-unregister-refused`, `details.reason`), the only tenant admin (`last-tenant-admin`), or an idempotency conflict.',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/users/:userId/invite',
    openapiPath: '/v1/identity/users/{userId}/invite',
    operationId: 'identity.users.resendInvite',
    summary: "Renew a person's invitation",
    description:
      "For a person who hasn't signed in yet (`invite` pending or expired): a new expiry, 7 days on, and the invitation emailed again where the deployment sends email (`inviteEmail` says whether it was). A person who has signed in, was added before invitations, or has no email gets `409 identity-user-not-invited`. Renewing one person again within a minute, more than 5 times in 24 hours, or past the invitation emails the workspace, or the whole deployment, may send in 24 hours, gets `429 invite-capped` with `Retry-After`, and changes nothing. To revoke an invitation, remove the person (`POST /v1/identity/users/{userId}/unregister`). Tenant admins only. Mounted when the identity directory invites people (from 0.1.9).",
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': {
        description: 'The person, with the new expiry, and whether the invitation was emailed.',
        schema: ref('InviteRenewed'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse(
        'No user with that id under this tenant, or one who was removed (`identity-user-not-found`).',
      ),
      '409': ErrorResponse(
        'They have signed in, were added before invitations, or have no email (`identity-user-not-invited`), or an idempotency conflict.',
      ),
      '429': ErrorResponse(
        '`invite-capped`: renewed again too soon for this person, or past the invitation emails the workspace, or the whole deployment, may send in 24 hours. Nothing changed; `Retry-After` says when to try again.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/identity/me/second-factor',
    openapiPath: '/v1/identity/me/second-factor',
    operationId: 'identity.me.secondFactor',
    summary: 'My second factor',
    description:
      'Whether you have a second factor set up (an authenticator app), since when, how many recovery codes are left, and whether your workspace requires one. From a session only: `400 auth-not-session-token` with an API key. Mounted when the deployment keeps second factors (from 0.1.9).',
    tags: ['identity'],
    security: 'bearer',
    responses: {
      '200': { description: 'Your second factor.', schema: ref('SecondFactorStatus') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Not a session (`auth-not-session-token`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/me/second-factor',
    openapiPath: '/v1/identity/me/second-factor',
    operationId: 'identity.me.startSecondFactor',
    summary: 'Start setting up a second factor',
    description:
      'A new key for an authenticator app, shown this once: nothing changes until a code from it is confirmed (`POST /v1/identity/me/second-factor/confirm`), within the hour. With one set up already, a code from it (or a recovery code) is needed, and the new key replaces it at the confirm. From a session only. Mounted when the deployment keeps second factors (from 0.1.9).',
    tags: ['identity'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('SecondFactorProof') },
    responses: {
      '200': { description: 'The new key.', schema: ref('SecondFactorKey') },
      ...CommonMutationErrors,
      '400': ErrorResponse('Not a session (`auth-not-session-token`), or a malformed body.'),
      '403': ErrorResponse(
        "The code isn't right (`second-factor-invalid`), or the key can't be opened any more (`second-factor-unusable`: a recovery code still works).",
      ),
      '429': ErrorResponse(
        'Too many wrong codes lately (`second-factor-locked`): nothing is checked until `Retry-After`.',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/me/second-factor/confirm',
    openapiPath: '/v1/identity/me/second-factor/confirm',
    operationId: 'identity.me.confirmSecondFactor',
    summary: 'Confirm a new second factor',
    description:
      'A code from the new key sets it up, and answers the 10 recovery codes, this once. Your sessions stay as they are; your next sign-in asks for a code. From a session only. Mounted when the deployment keeps second factors (from 0.1.9).',
    tags: ['identity'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('SecondFactorConfirmBody') },
    responses: {
      '200': {
        description: 'Set up: the recovery codes.',
        schema: ref('SecondFactorRecoveryCodes'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse('Not a session (`auth-not-session-token`), or a malformed body.'),
      '403': ErrorResponse("The code isn't right (`second-factor-invalid`)."),
      '409': ErrorResponse(
        'No new key to confirm, or it is over an hour old (`second-factor-not-started`), or an idempotency conflict.',
      ),
      '429': ErrorResponse(
        'Too many wrong codes lately (`second-factor-locked`): nothing is checked until `Retry-After`.',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/me/second-factor/recovery-codes',
    openapiPath: '/v1/identity/me/second-factor/recovery-codes',
    operationId: 'identity.me.newRecoveryCodes',
    summary: 'New recovery codes',
    description:
      '10 new recovery codes, shown this once; the old ones stop working. Takes a code from your app, or a recovery code. From a session only. Mounted when the deployment keeps second factors (from 0.1.9).',
    tags: ['identity'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('SecondFactorProof') },
    responses: {
      '200': { description: 'The new recovery codes.', schema: ref('SecondFactorRecoveryCodes') },
      ...CommonMutationErrors,
      '400': ErrorResponse('Not a session (`auth-not-session-token`), or a malformed body.'),
      '403': ErrorResponse(
        "The code isn't right (`second-factor-invalid`), or the key can't be opened any more (`second-factor-unusable`: a recovery code still works).",
      ),
      '429': ErrorResponse(
        'Too many wrong codes lately (`second-factor-locked`): nothing is checked until `Retry-After`.',
      ),
      '409': ErrorResponse(
        'No second factor set up (`second-factor-not-set-up`), or an idempotency conflict.',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/me/second-factor/remove',
    openapiPath: '/v1/identity/me/second-factor/remove',
    operationId: 'identity.me.removeSecondFactor',
    summary: 'Take my second factor off',
    description:
      'Off, with a code from your app or a recovery code: the key is deleted and the recovery codes stop working. Refused while your workspace requires one (`403 second-factor-required`): replace it instead, or ask a tenant admin. From a session only. Mounted when the deployment keeps second factors (from 0.1.9).',
    tags: ['identity'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('SecondFactorProof') },
    responses: {
      '200': { description: 'Removed.', schema: ref('SecondFactorRemoved') },
      ...CommonMutationErrors,
      '400': ErrorResponse('Not a session (`auth-not-session-token`), or a malformed body.'),
      '403': ErrorResponse(
        "The workspace requires one (`second-factor-required`), the code isn't right (`second-factor-invalid`), or the key can't be opened any more (`second-factor-unusable`: a recovery code still works).",
      ),
      '409': ErrorResponse(
        'No second factor set up (`second-factor-not-set-up`), or an idempotency conflict.',
      ),
      '429': ErrorResponse(
        'Too many wrong codes lately (`second-factor-locked`): nothing is checked until `Retry-After`.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/identity/users/:userId/second-factor',
    openapiPath: '/v1/identity/users/{userId}/second-factor',
    operationId: 'identity.users.secondFactor',
    summary: "A person's second factor",
    description:
      'Whether they have a second factor set up, since when, how many recovery codes are left, and whether it can still be used. Never a key or a code. Tenant admins only. Mounted when the deployment keeps second factors (from 0.1.9).',
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
    ],
    responses: {
      '200': { description: 'Their second factor.', schema: ref('SecondFactorStatus') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No user with that id under this tenant (`identity-user-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/users/:userId/second-factor/remove',
    openapiPath: '/v1/identity/users/{userId}/second-factor/remove',
    operationId: 'identity.users.removeSecondFactor',
    summary: "Remove a person's second factor",
    description:
      "For a lost phone, or lost recovery codes: their key is deleted, their recovery codes stop working, they're told by email where the deployment sends it, and it's audited. Their sessions stay: removing one gives no one access. Where the workspace requires one, they set one up at their next sign-in. `removed: false` when they had none. Tenant admins only, for anyone but themselves: an admin's own is taken off at `POST /v1/identity/me/second-factor/remove`, with a code from it (`403 permission-denied` here). Mounted when the deployment keeps second factors (from 0.1.9).",
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': { description: 'Removed, or none to remove.', schema: ref('SecondFactorRemoved') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "Not a tenant admin, or the caller's own (taken off at `/v1/identity/me/second-factor/remove`).",
      ),
      '404': ErrorResponse('No user with that id under this tenant (`identity-user-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/users/:userId/revoke-sessions',
    openapiPath: '/v1/identity/users/{userId}/revoke-sessions',
    operationId: 'identity.users.revokeSessions',
    summary: 'Revoke every active session for a user',
    description:
      "A tenant admin revokes anyone's sessions; anyone else only their own. Idempotent. Under the hood, deployments typically delegate to `SessionStoreBinding.revokeAllForUser`. Returns `{ revokedCount: 0 }` when the user was already fully signed out.",
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': { description: 'Revocation outcome.', schema: ref('RevokeSessionsResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse("Another person's sessions, and not a tenant admin."),
      '500': ErrorResponse('Session revocation failed inside the caller-plugged binding.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/identity/me/permissions',
    openapiPath: '/v1/identity/me/permissions',
    operationId: 'identity.me.permissions',
    summary: 'What I may do',
    description:
      "What the caller may do, so a client can hide what it can't: tenant admin, its reviewer role and the roles it decides, its API key's limits and capabilities, the projects it may read with its role in each and every way it holds it (directly, a team, an org it administers, tenant admin), its orgs and teams, and what each project role allows (from the runtime's authorization model). The key's limits are applied: a `member` key is never tenant admin, and a key limited to a project sees that project alone. Whether the deployment's license is held back from the caller whatever its role (`licenseOperatorOnly`), so a console doesn't ask `GET /v1/license`. Only what the caller may see. The server still checks every call. `501 permissions-unsupported` on a runtime without an authorization store: read whoami's `tenantAdmin` and `reviewerRole` instead.",
    tags: ['identity'],
    security: 'bearer',
    responses: {
      '200': { description: 'What the caller may do.', schema: ref('MyPermissions') },
      ...CommonAuthErrors,
      '501': ErrorResponse(
        'The runtime has no authorization store (`permissions-unsupported`): read whoami instead.',
      ),
      '503': ErrorResponse(
        "The authorization store couldn't be read (`authz-backend-unavailable`), or the database was too busy to answer in time (`database-busy`, with `Retry-After`): try again.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/identity/users/:userId/grants',
    openapiPath: '/v1/identity/users/{userId}/grants',
    operationId: 'identity.users.grants',
    summary: "Read a person's grants",
    description:
      "What the person may do, as granted directly: tenant admin, project and team roles, the reviewer roster. A tenant admin reads anyone's; anyone else only their own.",
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
    ],
    responses: {
      '200': { description: "The person's grants.", schema: ref('PersonGrants') },
      ...CommonAuthErrors,
      '403': ErrorResponse("Another person's grants, and not a tenant admin."),
      '404': ErrorResponse('No user with that id under this tenant (`identity-user-not-found`).'),
      '501': ErrorResponse('The runtime has no authorization store (`person-grants-unsupported`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/users/:userId/grant',
    openapiPath: '/v1/identity/users/{userId}/grant',
    operationId: 'identity.users.grant',
    summary: 'Make a person a tenant admin',
    description:
      "Written before the call answers, so the person's next request holds it. A no-op when held. Tenant admins only.",
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('PersonGrantBody') },
    responses: {
      '200': { description: "The person's grants, after.", schema: ref('PersonGrants') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "Not a tenant admin; or the person is one a site signs in, who holds only the grants their site's sign-in writes (`site-person-grants-managed`).",
      ),
      '404': ErrorResponse('No user with that id under this tenant (`identity-user-not-found`).'),
      '409': ErrorResponse(
        'The person was removed from the tenant (`identity-user-unregistered`), or an idempotency conflict.',
      ),
      '501': ErrorResponse('The runtime has no authorization store (`person-grants-unsupported`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/identity/users/:userId/ungrant',
    openapiPath: '/v1/identity/users/{userId}/ungrant',
    operationId: 'identity.users.ungrant',
    summary: 'Remove tenant admin from a person',
    description:
      'A no-op when not held. Refused for the only person who is a tenant admin (`last-tenant-admin`: make someone else one first), and for the seed user, whom the runtime makes tenant admin at every boot (`seed-user-admin`: unset `KINDGI_SEED_USER_ID` and restart it first). Tenant admins only.',
    tags: ['identity'],
    security: 'bearer',
    parameters: [
      { name: 'userId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('PersonGrantBody') },
    responses: {
      '200': { description: "The person's grants, after.", schema: ref('PersonGrants') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No user with that id under this tenant (`identity-user-not-found`).'),
      '409': ErrorResponse(
        'The only person who is a tenant admin (`last-tenant-admin`), the seed user (`seed-user-admin`), or an idempotency conflict.',
      ),
      '501': ErrorResponse('The runtime has no authorization store (`person-grants-unsupported`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/identity/whoami',
    openapiPath: '/v1/identity/whoami',
    operationId: 'identity.whoami',
    summary: "Self — the caller's user + tenant + session context",
    description:
      "Reflects the auth middleware's attached context: `tenantId` + `scopes` always; `userId` / `sessionId` / `providerId` / `expiresAt` when the caller is on a session token; the fuller `UserRecord` under `user` when a `userId` is present and the `IdentityDirectoryBinding` resolves it. Always mounted — the `/users/*` routes only mount when the directory binding is wired.",
    tags: ['identity'],
    security: 'bearer',
    responses: {
      '200': { description: 'Auth + user context.', schema: ref('WhoamiResult') },
      ...CommonAuthErrors,
    },
  },

  // ---------- deployments ----------
  {
    method: 'post',
    honoPath: '/v1/deployments',
    openapiPath: '/v1/deployments',
    operationId: 'deployments.register',
    summary: 'Register a signed deployment',
    description:
      "Atomic transaction: check the signing key against the tenant's trust list (the `signingKeyRegistry` binding), verify the Ed25519 signature over the canonical envelope, read the image's `/app/index.json` and verify it hashes to the signed `indexHash` and names the signed `artifactVersion` (`ImageRegistryBinding`), validate every tool / guardrail / agent / flow / data block it declares (the image's index is what registers; the request carries none), upsert into the corresponding registries (in the body's `projectId`, one project per client, else the tenant's Default project), then record the deployment. The pack's data blocks (the index's `blocks`) are published first, as `POST /v1/blocks` publishes a version: a version the runtime holds with the same content is kept, and the agents' block ranges pin over the runtime's versions and the pack's, the newest in range. Its tools are checked the same way before anything is written: a tool version the runtime holds is kept only with the same definition (`409 tool-already-registered`). A runtime that does this lists `deploy-publishes-pack-blocks` in `info[\"x-kindgi-capabilities\"]` of `/v1/openapi.json`. Where each tool's secrets are read is recorded on its version (`RecordedSecretScope`); one set nowhere yet is read where this deployment's secrets sync writes (`POST /v1/deployments/{deploymentId}/secrets`), the scope this route needs `admin` on. All-or-nothing rollback on any failure. Idempotency: same `imageDigest` re-submitted returns 200 with the existing record (no new version bump). `Idempotency-Key` also applies at the HTTP layer.",
    tags: ['deployments'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('DeploymentRegistrationBody') },
    responses: {
      '201': { description: 'Deployment registered.', schema: ref('DeploymentRecord') },
      '200': {
        description: 'Digest replay — same imageDigest already recorded; returns existing record.',
        schema: ref('DeploymentRecord'),
      },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or, on a runtime serving many tenants (`KINDGI_TENANCY=multi`), where each tenant deploys only its own images: `image-not-allowed`, the image is outside the tenant's repository (`details.imagePrefix`, its own), or `image-prefix-unset`, the tenant has no repository set yet; both are checked before any registry read, and never on a runtime serving one tenant. Or `tool-project-mismatch`, `agent-project-mismatch`, `flow-project-mismatch` or `block-project-mismatch`: one of the image's tools, agents, flows or data blocks belongs to another project (`details.primitive`, `details.id`; the message doesn't name the project); nothing was deployed, even when it was unchanged. Or `block-already-registered`: the runtime holds one of the pack's data block versions with other content, and a version never changes; or holds versions of the pack's blocks unregistered, by hand or by the rollback of a deploy that failed after publishing them, and a deploy never reinstates one (`details.primitive` is `block`, `details.id` is `<id>@<version>`, the first such block); the message says to give it a new version, or names each unregistered one with the command that reinstates it; nothing was deployed. Or `tool-already-registered`: the runtime holds one of the pack's tool versions, active or unregistered, with another definition, and a version never changes (`details.primitive` is `tool`, `details.id` is `<id>@<version>`, `details.fields` the fields of its definition that differ: the manifest's top-level fields, and `modulePath` for where its code lives in the pack). A new image of the same tool isn't another definition: its image and artifact version aren't compared. The message says to give the tool a new version; nothing was deployed. Or `tool-kind-mismatch`: one of the image's tools has the id of an MCP endpoint's tool (`details.endpointId`; `details.primitive`, `details.id`), whose active versions are all the endpoint's; nothing was deployed. Or `project-suspended`: the project the deploy goes into (the named one, or the Default for a tenant-wide deploy) is suspended, and nothing deploys into it until it's restored. Or `environment-takes-promotions`: the project the deploy goes into is a later environment of an environment order, which takes builds only by promotion from the one before it; deploy into the order's first environment and promote the build from there (`details.firstProjectId`, when you can read that project; `details.position`, the project's place from 0). Nothing is written. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '400': ErrorResponse(
        "Signature invalid, image unverifiable, or deployment-validation-failed with per-primitive `details[]`. When `image-unverifiable` comes from a failed registry read, `details.cause` names why: `image-not-found`, `image-file-not-found`, `image-registry-unreachable`, `image-registry-unauthorized`, `image-unreadable` (a layer that isn't a readable archive), or `image-limit-exceeded`, with the bound in `details.limit` (`manifest`, `file`, `layer`, `read` or `unpack`: the image's own, so the same image is refused again). The tenant's hour of image reads passes, so it answers `429`. A tool that declares or sends a model provider's key, or a secret under the reserved `kindgi.` prefix, is one such issue (`path` `/secrets/<name>`): a tool never gets a model provider's key or one of Kindgi's own secrets. An agent's `output.schema`, or a flow's loop, fanout branch or subgraph `outputSchema` or its `output.schema`, that doesn't compile is one too (`path` where it sits, such as `/output/schema` or `/nodes/<i>/branches/<k>/outputSchema`), as `defineAgent` and the flow loader refuse it: every turn or run would. A tool whose `metadata` has a key under `kindgi.` (the runtime's own) is a `validation-failed` detail at `/metadata/<key>`. Or `reference-out-of-scope`: an agent or flow names a tool, agent, flow, guardrail or data block that neither the deployment brings nor its project reaches (`details.issues`, at `/agents/<i>/…` or `/flows/<i>/…`); nothing is registered.",
      ),
      '403': ErrorResponse(
        "Signer key not on the tenant's trust list. Or, with `projectId`, no admin on that project (`forbidden`), or a key limited to another project (`key-project-mismatch`); without it, no admin on the tenant.",
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '429': ErrorResponse(
        `${SCHEMA_COMPILE_BUDGET_TEXT} Or \`details.limit: "tenant-unpack-hour"\`, on a server that bounds each tenant's image reads (Kindgi Cloud): this tenant's image reads unpacked as much as they may in an hour. Nothing was deployed; \`Retry-After\` says when there's room again.`,
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/deployments',
    openapiPath: '/v1/deployments',
    operationId: 'deployments.list',
    summary: 'List signed deployments',
    description:
      "Cursor-paginated. Sort order: `activatedAt` descending (binding-defined tiebreak on `deploymentId`). Only the deployments in projects the caller reads are listed (a deployment naming no project is the Default project's), so a page can hold fewer than `limit` with `hasMore` true: page by `nextCursor`, not by count. Optional `?imageRefPrefix=` narrows to deployments whose `imageRef` starts with the prefix; `?signerKeyId=` narrows to a specific signing key (useful for revocation audits); `?projectId=` to one environment (the Default also finds those naming no project); `?packId=` to one pack.",
    tags: ['deployments'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'imageRefPrefix',
        in: 'query',
        required: false,
        description: 'Prefix match on `Deployment.imageRef`.',
        schema: { type: 'string' },
      },
      {
        name: 'signerKeyId',
        in: 'query',
        required: false,
        description: 'Filter to deployments signed by this key id.',
        schema: { type: 'string' },
      },
      {
        name: 'projectId',
        in: 'query',
        required: false,
        description:
          "Filter to one environment's deployments. The tenant's Default project also finds those that name no project. Needs `read` on that project.",
        schema: { type: 'string' },
      },
      {
        name: 'packId',
        in: 'query',
        required: false,
        description: "Filter to one pack's deployments (`packId`).",
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': {
        description: 'Page of deployments.',
        schema: ref('DeploymentCollectionPage'),
      },
      ...CommonAuthErrors,
      '403': ErrorResponse(
        "No `read` on the tenant, or a `projectId` naming a project the caller doesn't read, or one that isn't there (the tenant admin too, so it tells no one what exists).",
      ),
      '500': ErrorResponse('List failed inside the caller-plugged binding.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/deployments/:deploymentId',
    openapiPath: '/v1/deployments/{deploymentId}',
    operationId: 'deployments.get',
    summary: 'Fetch a signed deployment record',
    tags: ['deployments'],
    security: 'bearer',
    parameters: [
      {
        name: 'deploymentId',
        in: 'path',
        required: true,
        description: 'Deployment id assigned by the ledger at register time.',
        schema: { type: 'string', minLength: 1 },
      },
    ],
    responses: {
      '200': { description: 'Deployment record.', schema: ref('DeploymentRecord') },
      ...CommonAuthErrors,
      '404': ErrorResponse(
        "No deployment with that id under this tenant, or one in a project the caller doesn't read (`deployment-not-found`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/deployments/:deploymentId/pack-env',
    openapiPath: '/v1/deployments/{deploymentId}/pack-env',
    operationId: 'deployments.packEnv',
    summary: "Show where each name a deployment's pack declares is set",
    description:
      "On a server that runs a pack service per deployment and gives it the env its pack declares: each declared name, where it's set (the deployment's project, then its org, then the tenant, at the env the server serves) and why it can't be given, if it can't. Never a value. A name set only as a secret can't be given into the pack service's environment yet: a tool reads it per call (`ctx.secrets`).",
    tags: ['deployments'],
    security: 'bearer',
    parameters: [
      {
        name: 'deploymentId',
        in: 'path',
        required: true,
        description: 'Deployment id assigned by the ledger at register time.',
        schema: { type: 'string', minLength: 1 },
      },
    ],
    responses: {
      '200': { description: 'Where each declared name is set.', schema: ref('PackEnvNames') },
      ...CommonAuthErrors,
      '404': ErrorResponse(
        "No deployment with that id under this tenant, or one in a project the caller doesn't read (`deployment-not-found`).",
      ),
      '501': ErrorResponse(
        "The server's pack services take their env from how they're run, not from the env store (`pack-env-not-served`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/deployments/:deploymentId/secrets',
    openapiPath: '/v1/deployments/{deploymentId}/secrets',
    operationId: 'deployments.syncSecrets',
    summary: 'Sync secrets against a deployment',
    description:
      'Deployment-scoped bulk secret sync. Body carries `{ envName, secrets: Array<{ name, ref } | { name, value }> }`. `{ name, ref }` entries validate against `SecretBinding.get` — no bytes cross the wire; missing → 404 `secret-not-found`. `{ name, value }` entries write via `SecretBinding.set` with `writeMode: add-version` + `tags.deployment = deploymentId` and return the created reference. The write scope is derived from the deployment record itself (tenant scope, or project scope when the deployment carries a `projectId`) and CANNOT be overridden on the wire. A secret the tools of this deployment name that was set nowhere when a deploy or a promotion published them is read at that scope, when whoever published them administers it: a deploy needs `admin` there, while a promotion into the Default project needs it only on that project. Requires the `secrets:write` capability. Idempotency-Key applies.',
    tags: ['deployments'],
    security: 'bearer',
    parameters: [
      {
        name: 'deploymentId',
        in: 'path',
        required: true,
        description: 'Deployment id assigned by the ledger at register time.',
        schema: { type: 'string', minLength: 1 },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('DeploymentSecretsSyncRequest') },
    responses: {
      '200': {
        description: 'Sync complete.',
        schema: ref('DeploymentSecretsSyncResponse'),
      },
      ...CommonMutationErrors,
      ...SecretWriteErrors,
      '403': ErrorResponse(
        "Bearer token missing `secrets:write` capability, or no `admin` on the scope it writes: the deployment's project, else the tenant.",
      ),
      '404': ErrorResponse(
        "No deployment with that id, or one in a project the caller doesn't read, or referenced secret does not exist.",
      ),
      '409': conflictOrEnvNotServed(ENV_NOT_SERVED_VALUE),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/deployments/:deploymentId/values',
    openapiPath: '/v1/deployments/{deploymentId}/values',
    operationId: 'deployments.values.list',
    summary: 'List the values a deployment needs in a project',
    description:
      "Every value the deployment needs set in the project before it serves there: each tool's secrets and env values with no default, a model key for each agent version it ships or carries, and the pack service's own env. Each is read where a run in that project reads it, under the env the runtime serves: `foundAt` says where it's set, and `problem` why it isn't ready. Names only, never a value. In the deployment's own project, a value is found wherever it's set. In another project, the one a promotion would take it to, a tool's secret counts only at a scope the caller administers, as a promotion by the caller would record it, so the list says what that promotion's check would say. Needs what listing secrets in that project needs (`admin` on it), `read` on the project the deployment serves, and `read` on the tenant, as every deployments route does.",
    tags: ['deployments'],
    security: 'bearer',
    parameters: [
      {
        name: 'deploymentId',
        in: 'path',
        required: true,
        description: 'Deployment id assigned by the ledger at register time.',
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'projectId',
        in: 'query',
        required: false,
        description:
          "The project the values are needed in. Default: the deployment's own project (the tenant's Default project for a tenant-wide deployment).",
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': {
        description: 'The values, names only.',
        schema: ref('DeploymentValueList'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "A `projectId` that isn't a project id, or none for a deployment whose project this runtime doesn't record (`bad-input`).",
      ),
      '403': ErrorResponse('No `admin` on the project, or no `read` on the tenant.'),
      '404': ErrorResponse(
        "No deployment with that id under this tenant, or one in a project the caller doesn't read (`deployment-not-found`), or `projectId` names no project of this tenant (`project-not-found`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/deployments/:deploymentId/promotions',
    openapiPath: '/v1/deployments/{deploymentId}/promotions',
    operationId: 'deployments.promote',
    summary: 'Promote a deployment to the next environment',
    description:
      "Moves the exact build a deployment runs into the next environment of its environment order: a new deployment of the target project with the same image, signature, signer and contents, and `promotedFromDeploymentId`. Nothing is built again and no registry is written. The edits of the build's agents and flows (versions made from a version it ships) move with it (`moved.agents[].carried`); edits made from a version it doesn't ship stay (`leftBehind`). Needs `read` on the deployment's project and `admin` on the target. Refused, with nothing written, when the target isn't the next environment, the deployment (or the target's copy) no longer serves, its signer is no longer trusted or its signature doesn't verify, or a value the build needs isn't ready in the target. The target having this build already answers `200` with its deployment, and records the edits made since.",
    tags: ['deployments'],
    security: 'bearer',
    parameters: [
      {
        name: 'deploymentId',
        in: 'path',
        required: true,
        description: 'The deployment to promote: one serving an environment of an order.',
        schema: { type: 'string', minLength: 1 },
      },
    ],
    requestBody: { required: true, schema: ref('DeploymentPromotionBody') },
    responses: {
      '201': {
        description: 'Promoted: a new deployment in the target.',
        schema: ref('DeploymentPromotion'),
      },
      '200': {
        description:
          'The target has this build already: its deployment, with the edits made since recorded.',
        schema: ref('DeploymentPromotion'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "Malformed body (`bad-input`). Or `signature-invalid`: the deployment's signature doesn't verify over the fields it keeps.",
      ),
      '403': ErrorResponse(
        "No `admin` on the target project. Or `key-project-mismatch`: the API key or session is limited to a project, and a promotion reads one project and writes another (`details.keyProjectId`, `details.projectId`). Or `signer-not-trusted`: the key that signed the build is no longer on the tenant's trust list (`details.signerKeyId`).",
      ),
      '404': ErrorResponse(
        "`deployment-not-found`: no deployment with that id in this tenant, or one in a project you don't read.",
      ),
      '409': ErrorResponse(
        "`promotion-not-next-environment`: the target isn't the next environment of the deployment's order, or the deployment's environment is last or in no order (`details.position`, the next environment's place; `details.nextProjectId`, when you can read it). `promotion-values-not-ready`: values the build needs aren't ready in the target, each in `details.values` (`DeploymentValue`). `deployment-superseded`: the deployment no longer serves its environment, or the target's copy no longer serves there: newer deployments serve every tool version it ships (`details.environment`, `source` or `target`; `details.newerDeploymentId`). `project-suspended`, `pack-suspended`, `tenant-suspended` or `tenant-closing`: a suspension of the source or the target (`details.environment`). Nothing is written.",
      ),
      '500': ErrorResponse('Server error (unmapped domain code or framework crash).'),
      '501': ErrorResponse(
        "`promotions-unsupported`: this runtime's deployment ledger can't promote.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/deployments/:deploymentId/promotions/check',
    openapiPath: '/v1/deployments/{deploymentId}/promotions/check',
    operationId: 'deployments.promoteCheck',
    summary: 'Check a promotion without making it',
    description:
      "Runs every check a promotion makes and writes nothing: what would move, the next environment, and each value with a problem in the target (where a promotion refuses with `promotion-values-not-ready`). Refused as the promotion is for every other check. Needs `read` on the deployment's project and `admin` on the target.",
    tags: ['deployments'],
    security: 'bearer',
    parameters: [
      {
        name: 'deploymentId',
        in: 'path',
        required: true,
        description: 'The deployment to promote: one serving an environment of an order.',
        schema: { type: 'string', minLength: 1 },
      },
    ],
    requestBody: { required: true, schema: ref('DeploymentPromotionCheckBody') },
    responses: {
      '200': {
        description: 'What a promotion would move, and the values not ready in the target.',
        schema: ref('DeploymentPromotionCheck'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "Malformed body (`bad-input`). Or `signature-invalid`: the deployment's signature doesn't verify over the fields it keeps.",
      ),
      '403': ErrorResponse(
        "No `admin` on the target project. Or `key-project-mismatch`: the API key or session is limited to a project, which a promotion's check is refused as the promotion is. Or `signer-not-trusted`: the key that signed the build is no longer trusted.",
      ),
      '404': ErrorResponse(
        "`deployment-not-found`: no deployment with that id in this tenant, or one in a project you don't read.",
      ),
      '409': ErrorResponse(
        '`promotion-not-next-environment`, `deployment-superseded`, or a suspension of the source or the target, as on the promotion.',
      ),
      '500': ErrorResponse('Server error (unmapped domain code or framework crash).'),
    },
  },

  // ---------- compliance ----------
  {
    method: 'get',
    honoPath: '/v1/compliance/evidence',
    openapiPath: '/v1/compliance/evidence',
    operationId: 'compliance.evidence.list',
    summary: 'List compliance-evidence records',
    description:
      'Cursor-paginated. Filters: `?runId=` / `?agentId=` / `?flowId=` / `?kind=` / `?from=` / `?to=` (all AND-composed). Fixed sort: `timestamp asc, id asc` — deterministic even when two records share a timestamp. Only mounted when `CreateAppInput.auditEvents` + `CreateAppInput.complianceClassifier` are both wired.',
    tags: ['compliance'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'runId',
        in: 'query',
        required: false,
        description:
          'Filter to evidence records tied to this run id (exact match on `provenanceRef.runId`).',
        schema: { type: 'string' },
      },
      {
        name: 'agentId',
        in: 'query',
        required: false,
        description: 'Filter to evidence records whose payload references this agent id.',
        schema: { type: 'string' },
      },
      {
        name: 'flowId',
        in: 'query',
        required: false,
        description: 'Filter to evidence records whose payload references this flow id.',
        schema: { type: 'string' },
      },
      {
        name: 'kind',
        in: 'query',
        required: false,
        description:
          'Filter by evidence kind (any `EvidenceKind`). A kind the classifier does not mark exportable yields an empty page.',
        schema: { $ref: '#/components/schemas/EvidenceKind' },
      },
      {
        name: 'from',
        in: 'query',
        required: false,
        description: 'ISO 8601 lower bound (inclusive) on `timestamp`.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'to',
        in: 'query',
        required: false,
        description: 'ISO 8601 upper bound (inclusive) on `timestamp`.',
        schema: { type: 'string', format: 'date-time' },
      },
    ],
    responses: {
      '200': {
        description: 'Page of compliance-evidence records.',
        schema: ref('ComplianceEvidenceCollectionPage'),
      },
      ...CommonAuthErrors,
      ...TenantAdminErrors,
      '400': ErrorResponse('Malformed cursor, `from`, or `to`.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/compliance/evidence/:evidenceId',
    openapiPath: '/v1/compliance/evidence/{evidenceId}',
    operationId: 'compliance.evidence.get',
    summary: 'Fetch one compliance-evidence record',
    description:
      "Returns the full evidence record. 404 `compliance-evidence-not-found` when the id is unknown within the tenant scope (never leaks the existence of another tenant's records).",
    tags: ['compliance'],
    security: 'bearer',
    parameters: [
      {
        name: 'evidenceId',
        in: 'path',
        required: true,
        description: 'ComplianceEvidenceId — caller-supplied semantic id.',
        schema: { type: 'string', minLength: 1 },
      },
    ],
    responses: {
      '200': { description: 'Full evidence record.', schema: ref('ComplianceEvidence') },
      ...CommonAuthErrors,
      ...TenantAdminErrors,
      '404': ErrorResponse('No evidence record with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/compliance/evidence/export',
    openapiPath: '/v1/compliance/evidence/export',
    operationId: 'compliance.evidence.export',
    summary: 'Export a signed compliance-evidence bundle',
    description:
      "Signs the evidence the filter matches (exportable kinds only) with the deployment's export key, and records the export (an `export-signed` audit event). The same envelope as the other signed exports; check `publicKey` against `GET /v1/export-signing-keys`. A deployment with no export key answers `404 signing-not-configured`.",
    tags: ['compliance'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('ExportComplianceEvidenceBody') },
    responses: {
      '200': {
        description: 'Signed evidence bundle.',
        schema: ref('SignedComplianceEvidenceBundle'),
      },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '404': ErrorResponse('Signing key id unknown, or signing not configured on this deployment.'),
    },
  },

  // ---------- audit query surface (unified audit substrate) ----------
  {
    method: 'get',
    honoPath: '/v1/audit/sign-ins',
    openapiPath: '/v1/audit/sign-ins',
    operationId: 'audit.signIns.list',
    summary: 'List sign-in audit events',
    description:
      "The tenant's sign-in history: who signed in and out, how (`method`), when and from where (`clientAddress`), what was refused and why, and emailed links sent or capped. `?userId=` narrows to one person's own sign-ins and sign-outs. Oldest first; `?order=desc` for newest first. A tenant admin's to read (403 `permission-denied` otherwise). Only mounted when `CreateAppInput.auditEvents` is wired.",
    tags: ['audit'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'userId',
        in: 'query',
        required: false,
        description: "One person's own sign-ins and sign-outs.",
        schema: { type: 'string' },
      },
      {
        name: 'kind',
        in: 'query',
        required: false,
        description: 'One kind of event.',
        schema: {
          type: 'string',
          enum: [
            'signed-in',
            'signed-out',
            'sign-in-refused',
            'sign-in-link-sent',
            'sign-in-link-capped',
            'sessions-revoked',
            'sessions-ended',
          ],
        },
      },
      {
        name: 'from',
        in: 'query',
        required: false,
        description: 'Inclusive lower bound on `timestamp`.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'to',
        in: 'query',
        required: false,
        description: 'Inclusive upper bound on `timestamp`.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'order',
        in: 'query',
        required: false,
        description:
          '`asc` (the default): oldest first. `desc`: newest first. `nextCursor` continues in the same order.',
        schema: { type: 'string', enum: ['asc', 'desc'] },
      },
    ],
    responses: {
      '200': {
        description: 'A page of sign-in audit events.',
        schema: {
          type: 'object',
          required: ['data', 'hasMore'],
          properties: {
            data: { type: 'array', items: ref('SignInEvent') },
            hasMore: { type: 'boolean' },
            nextCursor: { type: 'string' },
          },
        },
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed cursor, `kind`, `from`, `to`, or `order`.'),
      '403': ErrorResponse('Not a tenant admin (`permission-denied`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/audit/authz',
    openapiPath: '/v1/audit/authz',
    operationId: 'audit.authz.list',
    summary: 'List authz decision audit events',
    description:
      'Cursor-paginated read of `authz-decision` audit events for the tenant. Filters (all AND-composed): `?actorSubject=` / `?onBehalfOf=` / `?action=` / `?resource=` / `?outcome=` / `?runId=` / `?from=` / `?to=`. Oldest first; `?order=desc` for newest first. Admin@tenant only. Only mounted when `CreateAppInput.auditEvents` is wired.',
    tags: ['audit'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'actorSubject',
        in: 'query',
        required: false,
        description: 'Filter to decisions issued for this actor (`user:...` / `agent:...`).',
        schema: { type: 'string' },
      },
      {
        name: 'onBehalfOf',
        in: 'query',
        required: false,
        description: 'Filter to delegated decisions on-behalf-of this subject.',
        schema: { type: 'string' },
      },
      {
        name: 'action',
        in: 'query',
        required: false,
        description: 'Filter by action verb (`read` | `write` | `admin` | `execute` | ...).',
        schema: { type: 'string' },
      },
      {
        name: 'resource',
        in: 'query',
        required: false,
        description: 'Filter to decisions on this fully-qualified resource (`type:id`).',
        schema: { type: 'string' },
      },
      {
        name: 'outcome',
        in: 'query',
        required: false,
        description: 'Restrict to `allowed` or `denied` decisions.',
        schema: { type: 'string', enum: ['allowed', 'denied'] },
      },
      {
        name: 'runId',
        in: 'query',
        required: false,
        description: 'Filter to decisions issued inside this run.',
        schema: { type: 'string' },
      },
      {
        name: 'from',
        in: 'query',
        required: false,
        description: 'ISO 8601 lower bound (inclusive) on `timestamp`.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'to',
        in: 'query',
        required: false,
        description: 'ISO 8601 upper bound (inclusive) on `timestamp`.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'order',
        in: 'query',
        required: false,
        description:
          '`asc` (the default): oldest first. `desc`: newest first. `nextCursor` continues in the same order.',
        schema: { type: 'string', enum: ['asc', 'desc'] },
      },
    ],
    responses: {
      '200': {
        description: 'Page of authz decision audit events.',
        schema: {
          type: 'object',
          required: ['data', 'hasMore'],
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                required: [
                  'id',
                  'tenantId',
                  'timestamp',
                  'actorSubject',
                  'action',
                  'resource',
                  'outcome',
                  'reason',
                ],
                properties: {
                  id: { type: 'string' },
                  tenantId: { type: 'string' },
                  timestamp: { type: 'string', format: 'date-time' },
                  actorSubject: { type: 'string' },
                  onBehalfSubject: { type: 'string' },
                  action: { type: 'string' },
                  resource: { type: 'string' },
                  outcome: { type: 'string', enum: ['allowed', 'denied'] },
                  reason: { type: 'string' },
                  failing: { type: 'string' },
                  evidence: { type: 'object', additionalProperties: true },
                  correlationId: { type: 'string' },
                  runId: { type: 'string' },
                  latencyMs: { type: 'number' },
                },
              },
            },
            hasMore: { type: 'boolean' },
            nextCursor: { type: 'string' },
          },
        },
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed cursor, `from`, `to`, `outcome`, or `order`.'),
    },
  },

  // ---------- orgs ----------
  {
    method: 'get',
    honoPath: '/v1/orgs',
    openapiPath: '/v1/orgs',
    operationId: 'orgs.list',
    summary: "List orgs in the caller's tenant",
    description:
      'Cursor-paginated list of orgs. Optional `?nameContains=` narrows by substring match on `Org.name`.',
    tags: ['orgs'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'nameContains',
        in: 'query',
        required: false,
        description: 'Substring match on `Org.name`.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Page of orgs.', schema: ref('OrgCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/orgs',
    openapiPath: '/v1/orgs',
    operationId: 'orgs.create',
    summary: 'Create an org',
    tags: ['orgs'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('OrgSpec') },
    responses: {
      '201': { description: 'Org created.', schema: ref('CreateResourceResult') },
      ...CommonMutationErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/orgs/:orgId',
    openapiPath: '/v1/orgs/{orgId}',
    operationId: 'orgs.get',
    summary: 'Fetch an org by id',
    tags: ['orgs'],
    security: 'bearer',
    parameters: [
      {
        name: 'orgId',
        in: 'path',
        required: true,
        description: 'OrgId — opaque branded string.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Org.', schema: ref('Org') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No org with that id under this tenant.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/orgs/:orgId',
    openapiPath: '/v1/orgs/{orgId}',
    operationId: 'orgs.update',
    summary: 'Partially update an org',
    tags: ['orgs'],
    security: 'bearer',
    parameters: [
      {
        name: 'orgId',
        in: 'path',
        required: true,
        description: 'OrgId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('OrgPatch') },
    responses: {
      '204': { description: 'Updated. No body.' },
      ...CommonMutationErrors,
      '404': ErrorResponse('No org with that id under this tenant.'),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/orgs/:orgId',
    openapiPath: '/v1/orgs/{orgId}',
    operationId: 'orgs.delete',
    summary: 'Delete an org (idempotent)',
    description:
      "A tombstone, not an erase: from then on the org is gone from get and list, and its slug is free for a new org. Its projects and teams stay, without an org; when one of those projects has the slug of a project that has none, nothing is deleted: `409 slug-conflict` names the slugs (rename or move those projects first). When the org is the parent of an environment order, nothing is deleted either: `409 org-has-environment-order` names the order (a tenant admin clears it first). In the Kindgi runtime, the org's own secrets and secret mappings are deleted with it, for good, and its own environments and MCP endpoints are unregistered. A retention policy on the `org` domain purges the org's row. Idempotent: deleting an unknown or already-deleted org returns 204.",
    tags: ['orgs'],
    security: 'bearer',
    parameters: [
      {
        name: 'orgId',
        in: 'path',
        required: true,
        description: 'OrgId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '204': { description: 'Deleted (or already absent). No body.' },
      ...CommonAuthErrors,
      '409': ErrorResponse(
        "`slug-conflict`: the org's projects would leave it with slugs that projects without an org already have. Or `org-has-environment-order`: the org is the parent of an environment order, so it can't be deleted — a tenant admin clears the order first.",
      ),
    },
  },

  // ---------- teams ----------
  {
    method: 'get',
    honoPath: '/v1/teams',
    openapiPath: '/v1/teams',
    operationId: 'teams.list',
    summary: "List teams in the caller's tenant",
    description:
      'Cursor-paginated. Optional `?orgId=` narrows to a specific org (absent = every team, including teams with no org). `?nameContains=` substring-matches on `Team.name`.',
    tags: ['teams'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'orgId',
        in: 'query',
        required: false,
        description: 'Narrow to teams belonging to a specific org.',
        schema: { type: 'string' },
      },
      {
        name: 'nameContains',
        in: 'query',
        required: false,
        description: 'Substring match on `Team.name`.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Page of teams.', schema: ref('TeamCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/teams',
    openapiPath: '/v1/teams',
    operationId: 'teams.create',
    summary: 'Create a team',
    tags: ['teams'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('TeamSpec') },
    responses: {
      '201': { description: 'Team created.', schema: ref('CreateResourceResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'org-not-found: `orgId` names no org of the tenant (it never existed, or it was deleted).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/teams/:teamId',
    openapiPath: '/v1/teams/{teamId}',
    operationId: 'teams.get',
    summary: 'Fetch a team by id',
    tags: ['teams'],
    security: 'bearer',
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        description: 'TeamId — opaque branded string.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Team.', schema: ref('Team') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No team with that id under this tenant.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/teams/:teamId',
    openapiPath: '/v1/teams/{teamId}',
    operationId: 'teams.update',
    summary: 'Partially update a team',
    tags: ['teams'],
    security: 'bearer',
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        description: 'TeamId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('TeamPatch') },
    responses: {
      '204': { description: 'Updated. No body.' },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'team-not-found: no team with that id under this tenant; or org-not-found: `orgId` names no org of the tenant (it never existed, or it was deleted).',
      ),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/teams/:teamId',
    openapiPath: '/v1/teams/{teamId}',
    operationId: 'teams.delete',
    summary: 'Delete a team (idempotent, cascades memberships)',
    description:
      "With authorization on, the team's tuples go with it: its members' roles and its project grants, so nobody keeps access through a team that's gone (501 `authz-membership-unsupported` from a runtime that can't do that).",
    tags: ['teams'],
    security: 'bearer',
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        description: 'TeamId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '204': { description: 'Deleted (or already absent). No body.' },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/teams/:teamId/memberships',
    openapiPath: '/v1/teams/{teamId}/memberships',
    operationId: 'teams.memberships.list',
    summary: 'List memberships of a team',
    description:
      "Cursor-paginated. Sort order is binding-defined (for example `joinedAt` ascending). For the team's admins (and tenant admins): a plain member sees the team, not who else is in it, and reads their own roles through `GET /v1/identity/users/{userId}/grants`.",
    tags: ['teams'],
    security: 'bearer',
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        description: 'TeamId — opaque branded string.',
        schema: { type: 'string' },
      },
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': {
        description: 'Page of team memberships.',
        schema: ref('TeamMembershipCollectionPage'),
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No team with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/teams/:teamId/memberships',
    openapiPath: '/v1/teams/{teamId}/memberships',
    operationId: 'teams.memberships.add',
    summary: 'Add a user to a team',
    description:
      'Someone who is not a person of this tenant, or was removed from it, is refused with 404 `identity-user-not-found`. Adding a role the member already holds answers 201 with the existing record; another role, 409 `membership-exists` naming the role they hold (`details.role`), which is kept: use PATCH to change it.',
    tags: ['teams'],
    security: 'bearer',
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        description: 'TeamId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('AddTeamMembershipBody') },
    responses: {
      '201': { description: 'Membership added.', schema: ref('AddTeamMembershipResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "The person is one a site signs in, who holds only the grants their site's sign-in writes (`site-person-grants-managed`).",
      ),
      '404': ErrorResponse(
        'No team with that id under this tenant (`team-not-found`), or the person named is not a member of this tenant (`identity-user-not-found`).',
      ),
      '409': ErrorResponse(
        'A member already, with another role (`membership-exists`, `details.role`); or an Idempotency-Key reused with another body.',
      ),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/teams/:teamId/memberships/:userId',
    openapiPath: '/v1/teams/{teamId}/memberships/{userId}',
    operationId: 'teams.memberships.remove',
    summary: 'Remove a user from a team (idempotent)',
    tags: ['teams'],
    security: 'bearer',
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        description: 'TeamId — opaque branded string.',
        schema: { type: 'string' },
      },
      {
        name: 'userId',
        in: 'path',
        required: true,
        description: 'UserId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '403': ErrorResponse(
        'The person is one a site signs in, whose grants their site gives back at their next sign-in: remove the person, change their role on the site, or pause the site instead (`site-person-grants-managed`).',
      ),
      '204': { description: 'Removed (or already absent). No body.' },
      ...CommonAuthErrors,
      '501': ErrorResponse(
        "With authorization enforced, a runtime whose tenant-hierarchy binding can't change the membership together with its authorization tuple refuses with `authz-membership-unsupported`; nothing is changed.",
      ),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/teams/:teamId/memberships/:userId',
    openapiPath: '/v1/teams/{teamId}/memberships/{userId}',
    operationId: 'teams.memberships.updateRole',
    summary: "Change an existing member's role",
    tags: ['teams'],
    security: 'bearer',
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        description: 'TeamId — opaque branded string.',
        schema: { type: 'string' },
      },
      {
        name: 'userId',
        in: 'path',
        required: true,
        description: 'UserId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('UpdateTeamMembershipBody') },
    responses: {
      '204': { description: 'Role updated. No body.' },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "The person is one a site signs in, who holds only the grants their site's sign-in writes (`site-person-grants-managed`).",
      ),
      '404': ErrorResponse(
        'No membership for that (team, user) pair, or no such team under this tenant.',
      ),
      '501': ErrorResponse(
        "With authorization enforced, a runtime whose tenant-hierarchy binding can't change the membership together with its authorization tuple refuses with `authz-membership-unsupported`; nothing is changed.",
      ),
    },
  },

  // ---------- projects ----------
  {
    method: 'get',
    honoPath: '/v1/projects/default',
    openapiPath: '/v1/projects/default',
    operationId: 'projects.getDefault',
    summary: "Fetch the tenant's Default project",
    description:
      'Returns the row where `Project.isDefault = true` (exactly one per tenant), to a caller who can read it, as `GET /v1/projects/{projectId}` checks. Returns 404 `project-not-found` when no Default has been provisioned.',
    tags: ['projects'],
    security: 'bearer',
    responses: {
      '200': { description: 'Default project.', schema: ref('Project') },
      ...CommonAuthErrors,
      '403': ErrorResponse("The caller can't read the Default project."),
      '404': ErrorResponse('Tenant has no Default project.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects',
    openapiPath: '/v1/projects',
    operationId: 'projects.list',
    summary: "List projects in the caller's tenant",
    description:
      'Cursor-paginated. Optional `?orgId=` narrows to a specific org (projects may have no org; absent = all); `?nameContains=` substring-matches on `Project.name`.',
    tags: ['projects'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'orgId',
        in: 'query',
        required: false,
        description: 'Narrow to projects belonging to a specific org.',
        schema: { type: 'string' },
      },
      {
        name: 'nameContains',
        in: 'query',
        required: false,
        description: 'Substring match on `Project.name`.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Page of projects.', schema: ref('ProjectCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects',
    openapiPath: '/v1/projects',
    operationId: 'projects.create',
    summary: 'Create a project',
    description:
      "A project's slug is unique within its org, and a project without an org's among the tenant's projects without one: two orgs may each have a project with the same slug. A taken slug answers `409 slug-conflict`; a second Default, `409 project-default-already-exists`.",
    tags: ['projects'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('ProjectSpec') },
    responses: {
      '201': { description: 'Project created.', schema: ref('CreateResourceResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'org-not-found: `orgId` names no org of the tenant (it never existed, or it was deleted).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId',
    openapiPath: '/v1/projects/{projectId}',
    operationId: 'projects.get',
    summary: 'Fetch a project by id',
    tags: ['projects'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Project.', schema: ref('Project') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No project with that id under this tenant.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/projects/:projectId',
    openapiPath: '/v1/projects/{projectId}',
    operationId: 'projects.update',
    summary: 'Partially update a project',
    description:
      'A new `slug`, or a move to another org (`orgId`, or `null` for none), answers `409 slug-conflict` when the slug is taken where the project ends up.',
    tags: ['projects'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('ProjectPatch') },
    responses: {
      '204': { description: 'Updated. No body.' },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "A reused `Idempotency-Key` with a different body; `slug-conflict` when the `slug` is taken where the project ends up; or `project-in-environment-order` — the project is a member of an environment order, so it can't be moved to another parent (clear it from the order first).",
      ),
      '404': ErrorResponse(
        'project-not-found: no project with that id under this tenant; or org-not-found: `orgId` names no org of the tenant (it never existed, or it was deleted).',
      ),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/projects/:projectId',
    openapiPath: '/v1/projects/{projectId}',
    operationId: 'projects.delete',
    summary: 'Delete a project (idempotent)',
    description:
      "Once the project is deleted, its own service account (`runAsProject`), if it has one, is unregistered. That's best effort: a failure is logged, and the delete still answers 204.",
    tags: ['projects'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '204': { description: 'Deleted (or already absent). No body.' },
      ...CommonAuthErrors,
      '409': ErrorResponse(
        "`project-in-environment-order`: the project is a member of an environment order, so it can't be deleted — clear it from the order first.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/queue-rules',
    openapiPath: '/v1/projects/{projectId}/queue-rules',
    operationId: 'projects.queueRules.list',
    summary: "List a project's queue rules",
    description:
      "The live rules (their latest versions), oldest first. A rule says which of the project's runs to queue for a person's correction when they end. Needs `read` on the project.",
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': { description: 'A page of rules.', schema: ref('QueueRulePage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No project with that id (`project-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/queue-rules',
    openapiPath: '/v1/projects/{projectId}/queue-rules',
    operationId: 'projects.queueRules.create',
    summary: 'Create a queue rule',
    description:
      "Version 1 of a rule. From then on, a top-level run of the project that matches `when` as it ends (and falls in `sample`, while the rule has fewer than `maxOpen` open items) is queued for a person's correction; replays never are. A rule only lists runs: it never starts a model. Needs `write` on the project.",
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('QueueRuleSpec') },
    responses: {
      '201': { description: 'The rule, version 1.', schema: ref('QueueRule') },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'No project with that id (`project-not-found`), or no live corrector group `correctorGroupId` (`corrector-group-not-found`).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/queue-rules/preview',
    openapiPath: '/v1/projects/{projectId}/queue-rules/preview',
    operationId: 'projects.queueRules.preview',
    summary: 'What a rule would have queued',
    description:
      'Among the project\'s last `last` top-level runs (not replays), how many a rule with these fields (and its `sample`) would have queued. The rule editor\'s "would have added N of the last 100". Lists are comma-separated. Needs `read` on the project.',
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      {
        name: 'agentIds',
        in: 'query',
        required: false,
        description: 'Comma-separated.',
        schema: { type: 'string' },
      },
      {
        name: 'flowIds',
        in: 'query',
        required: false,
        description: 'Comma-separated.',
        schema: { type: 'string' },
      },
      {
        name: 'versions',
        in: 'query',
        required: false,
        description: 'Comma-separated; `pinned` for the pinned version.',
        schema: { type: 'string' },
      },
      {
        name: 'status',
        in: 'query',
        required: false,
        description: 'Comma-separated: completed, failed, cancelled.',
        schema: { type: 'string' },
      },
      {
        name: 'includeDryRuns',
        in: 'query',
        required: false,
        description: '`true` to count dry runs.',
        schema: { type: 'boolean' },
      },
      {
        name: 'sample',
        in: 'query',
        required: false,
        description: '0 < sample ≤ 1. Default 1.',
        schema: { type: 'number' },
      },
      {
        name: 'last',
        in: 'query',
        required: false,
        description: 'How many recent runs to look at, 1 to 500. Default 100.',
        schema: { type: 'integer', minimum: 1, maximum: 500 },
      },
      {
        name: 'ruleId',
        in: 'query',
        required: false,
        description:
          "An existing rule's id, to sample as that rule does: `matched` is then exactly the runs it would take. Without it, `matched` is an estimate.",
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'The preview.', schema: ref('QueueRulePreview') },
      ...CommonAuthErrors,
      '400': ErrorResponse('A malformed field (`bad-input`).'),
      '404': ErrorResponse('No project with that id (`project-not-found`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/queue-rules/:ruleId',
    openapiPath: '/v1/projects/{projectId}/queue-rules/{ruleId}',
    operationId: 'projects.queueRules.get',
    summary: 'Fetch a queue rule',
    description: 'Its latest version. Needs `read` on the project.',
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      { name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } },
    ],
    responses: {
      '200': { description: 'The rule.', schema: ref('QueueRule') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such rule in the project (`queue-rule-not-found`).'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/projects/:projectId/queue-rules/:ruleId',
    openapiPath: '/v1/projects/{projectId}/queue-rules/{ruleId}',
    operationId: 'projects.queueRules.update',
    summary: 'Change a queue rule',
    description:
      'A new version with these fields changed (`when` is replaced whole). Earlier versions are kept: `…/versions` shows who changed what, when. Needs `write` on the project.',
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      { name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } },
    ],
    requestBody: { required: true, schema: ref('QueueRulePatch') },
    responses: {
      '200': { description: 'The new version.', schema: ref('QueueRule') },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'No such rule (`queue-rule-not-found`), or no live corrector group `correctorGroupId` (`corrector-group-not-found`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/queue-rules/:ruleId/unregister',
    openapiPath: '/v1/projects/{projectId}/queue-rules/{ruleId}/unregister',
    operationId: 'projects.queueRules.unregister',
    summary: 'Stop a queue rule',
    description:
      'It queues nothing more; its versions and the items it queued stay. `unregistered: false` when it was already stopped. Needs `write` on the project.',
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      { name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } },
    ],
    responses: {
      '200': {
        description: 'Whether it was stopped now.',
        schema: ref('QueueRuleUnregisterResult'),
      },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such rule (`queue-rule-not-found`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/queue-rules/:ruleId/versions',
    openapiPath: '/v1/projects/{projectId}/queue-rules/{ruleId}/versions',
    operationId: 'projects.queueRules.versions',
    summary: "A queue rule's versions",
    description:
      'Every version, newest first: who wrote it, when, and what it said. Needs `read` on the project.',
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      { name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } },
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': { description: 'A page of versions.', schema: ref('QueueRulePage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such rule (`queue-rule-not-found`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/queue-rules/:ruleId/results',
    openapiPath: '/v1/projects/{projectId}/queue-rules/{ruleId}/results',
    operationId: 'projects.queueRules.results',
    summary: "A queue rule's results",
    description:
      "By the rule's version and the agent's: the runs it queued (open, corrected, dismissed, erased), the ones its `maxOpen` skipped, and the live corrections on them, with their group-weighted `yes` share and a count by group. Never pooled with another rule's, or across a rule's versions: each is a sample of its own `when`. Needs `read` on the project.",
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      { name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } },
      {
        name: 'since',
        in: 'query',
        required: false,
        description: 'Only runs queued from this time on.',
        schema: { type: 'string', format: 'date-time' },
      },
    ],
    responses: {
      '200': { description: 'The results.', schema: ref('QueueRuleResults') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such rule (`queue-rule-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/queue-rules/:ruleId/queue-recent',
    openapiPath: '/v1/projects/{projectId}/queue-rules/{ruleId}/queue-recent',
    operationId: 'projects.queueRules.queueRecent',
    summary: "Queue a rule's recent matches",
    description:
      "Catch a rule up on runs that ended before it was there: among the project's recent runs — `last` of them (newest first) and/or those completed at or after `since` — queue the ones it matches, sampled as the rule samples, deduped per `(rule, run)` as run-end matching is. `maxOpen` isn't applied. The answer splits the matches into `queued` (newly added), `alreadyQueued` (this rule already had them) and `alreadyReviewed` (their run was already corrected or dismissed, so they're left as they are); an erased run is no longer a match. At least one of `last`, `since` is given. Needs `write` on the project.",
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      { name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } },
    ],
    requestBody: { required: true, schema: ref('ExpertQueueRecentInput') },
    responses: {
      '200': {
        description: 'The matches, split into queued, already queued and already reviewed.',
        schema: ref('ExpertQueueRecentQueued'),
      },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such rule (`queue-rule-not-found`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/expert-queue',
    openapiPath: '/v1/projects/{projectId}/expert-queue',
    operationId: 'projects.expertQueue.list',
    summary: "The project's expert queue",
    description:
      "Queued runs, oldest first: never a run's content, only what it was, which rules queued it, whose correction they want and the corrections so far, and what the caller may do with it (`can`). An item closes as `corrections` once every rule that queued it has the correction it wants. `forMe=true`: the items any correction closes, or that want a group the caller may assert. `limit=0` answers only the `total`. Needs `read` on the project.",
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      {
        name: 'state',
        in: 'query',
        required: false,
        description: 'open, corrected, dismissed or erased.',
        schema: { $ref: '#/components/schemas/ExpertQueueState' },
      },
      {
        name: 'agentId',
        in: 'query',
        required: false,
        description: 'Only this agent.',
        schema: { type: 'string' },
      },
      {
        name: 'ruleId',
        in: 'query',
        required: false,
        description: 'Only items this rule queued.',
        schema: { type: 'string' },
      },
      {
        name: 'correctorGroupId',
        in: 'query',
        required: false,
        description: 'Only items that want this group.',
        schema: { type: 'string' },
      },
      {
        name: 'forMe',
        in: 'query',
        required: false,
        description: '`true`: what the caller is asked to correct.',
        schema: { type: 'boolean' },
      },
      {
        name: 'addedAfter',
        in: 'query',
        required: false,
        description: 'Queued from this time on.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        name: 'closedAfter',
        in: 'query',
        required: false,
        description: 'Closed from this time on.',
        schema: { type: 'string', format: 'date-time' },
      },
      {
        ...LimitQueryParam,
        description: 'Page size; `0` for the `total` alone.',
        schema: { ...LimitQueryParam.schema, minimum: 0 },
      },
      CursorQueryParam,
    ],
    responses: {
      '200': { description: 'A page of queued runs.', schema: ref('ExpertQueuePage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('A malformed filter (`bad-input`).'),
      '404': ErrorResponse('No project with that id (`project-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/expert-queue/:runId/dismiss',
    openapiPath: '/v1/projects/{projectId}/expert-queue/{runId}/dismiss',
    operationId: 'projects.expertQueue.dismiss',
    summary: 'Dismiss a queued run',
    description:
      'Not worth correcting: it leaves the open queue, with who dismissed it and why. `reopen` undoes it. Needs `write` on the project, as correcting the run does.',
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
    ],
    requestBody: { required: false, schema: ref('ExpertQueueDismissBody') },
    responses: {
      '200': { description: 'The item, dismissed.', schema: ref('ExpertQueueItem') },
      ...CommonMutationErrors,
      '404': ErrorResponse("The run isn't in the project's queue (`expert-queue-item-not-found`)."),
      '409': ErrorResponse("The item isn't open (`expert-queue-item-not-open`)."),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/expert-queue/:runId/reopen',
    openapiPath: '/v1/projects/{projectId}/expert-queue/{runId}/reopen',
    operationId: 'projects.expertQueue.reopen',
    summary: 'Reopen a dismissed run',
    description:
      'Back in the open queue. Only a dismissed item reopens: a corrected one was closed by its corrections. Needs `write` on the project.',
    tags: ['expert-queue'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
    ],
    responses: {
      '200': { description: 'The item, open again.', schema: ref('ExpertQueueItem') },
      ...CommonMutationErrors,
      '404': ErrorResponse("The run isn't in the project's queue (`expert-queue-item-not-found`)."),
      '409': ErrorResponse("The item wasn't dismissed (`expert-queue-item-not-open`)."),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/memberships',
    openapiPath: '/v1/projects/{projectId}/memberships',
    operationId: 'projects.memberships.list',
    summary: 'List direct memberships of a project',
    description:
      "Cursor-paginated. Direct-grant memberships only — team-mediated grants are resolved through the FGA store per tenant. For the project's editors and admins (`write`): a viewer sees the project, not who else is in it, and reads their own roles through `GET /v1/identity/users/{userId}/grants`.",
    tags: ['projects'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': {
        description: 'Page of project memberships.',
        schema: ref('ProjectMembershipCollectionPage'),
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No project with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/memberships',
    openapiPath: '/v1/projects/{projectId}/memberships',
    operationId: 'projects.memberships.add',
    summary: 'Add a user directly to a project',
    description:
      'Names the person by exactly one of `userId` and `email` (matched as the runtime matches emails when it adds a person); someone who is not a person of this tenant, or was removed from it, is refused with 404 `identity-user-not-found`. Adding a role the member already holds answers 201 with the existing record; another role, 409 `membership-exists` naming the role they hold (`details.role`), which is kept: use PATCH to change it.',
    tags: ['projects'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('AddProjectMembershipBody') },
    responses: {
      '201': {
        description: 'Membership added.',
        schema: ref('AddProjectMembershipResult'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "The person is one a site signs in, who holds only the grants their site's sign-in writes (`site-person-grants-managed`).",
      ),
      '404': ErrorResponse(
        'No project with that id under this tenant (`project-not-found`), or the person named is not a member of this tenant (`identity-user-not-found`).',
      ),
      '409': ErrorResponse(
        'A member already, with another role (`membership-exists`, `details.role`); or an Idempotency-Key reused with another body.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/access',
    openapiPath: '/v1/projects/{projectId}/access',
    operationId: 'projects.access.list',
    summary: 'Who has access to a project, and how',
    description:
      "Everyone the authorization store lets into the project (people and service accounts), each with their effective role and every way in: a direct role, a team's grant, an admin of the project's org, a tenant admin. For the project's editors and admins (`write`): a viewer sees the project, not who else works in it. Emails show to the project's admins only. Ordered by role (owner first), then name. 501 `project-access-unsupported` from a runtime without an authorization store.",
    tags: ['projects'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of who has access.', schema: ref('ProjectAccessPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No project with that id under this tenant.'),
      '501': ErrorResponse(
        'The runtime has no authorization store (`project-access-unsupported`).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/pinned-versions',
    openapiPath: '/v1/projects/{projectId}/pinned-versions',
    operationId: 'projects.pinnedVersions.list',
    summary: 'List the pinned versions that cover a project',
    description:
      "Every agent's pinned versions that cover the project: the tenant's, the project's org's, the project's own and its segments', ordered by agent id, then scope. A run in the project takes the most specific one that covers it, else its agent's latest version. For readers of the project (`read`), and only the pins of agents and versions the caller can read, as `GET /v1/agents/{agentId}/pinned-versions` shows them. A page can hold fewer pins than `limit`, or none, with `hasMore` true: page on `nextCursor`, not the count. 501 `pinned-versions-not-supported` from a runtime that can't list them.",
    tags: ['projects'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': {
        description: 'Page of pinned versions.',
        schema: ref('ProjectPinnedVersionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('A malformed project id or cursor.'),
      '404': ErrorResponse('No project with that id under this tenant.'),
      '501': ErrorResponse(
        "The runtime can't list a project's pinned versions (`pinned-versions-not-supported`).",
      ),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/projects/:projectId/production',
    openapiPath: '/v1/projects/{projectId}/production',
    operationId: 'projects.production.set',
    summary: 'Put a project in production, or take it out',
    description:
      "A run in a project in production is a production run; a run anywhere else is staging. For tenant admins (`admin` on the tenant), both ways. Setting what's already set answers 200 unchanged and keeps the first `productionSince`. With the runtime's production gate on, putting a project in production is refused with 403 `production-not-allowed` while the tenant isn't allowed it, with `details.next` naming where to go to be allowed when the runtime names one; a project already in production stays so. With the tenant's `projectsInProduction` limit set, putting another project in production is refused with 403 `production-limit-reached` while that many of its projects are in production, or more; taking one out is never refused. 501 `production-unsupported` from a runtime whose projects can't be put in production.",
    tags: ['projects'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('ProjectProductionBody') },
    responses: {
      '200': {
        description: 'The project is now as asked.',
        schema: ref('ProjectProduction'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "Not a tenant admin (`permission-denied`); the tenant isn't allowed to put projects in production (`production-not-allowed`, `details.projectId`, `details.next` when the runtime names one); or its projects in production are at its limit (`production-limit-reached`, `details.limit` `projects-in-production`, `details.projectsInProduction` the limit, `details.inProduction` the count, `details.projectId`, `details.next` when the runtime names one).",
      ),
      '404': ErrorResponse('No project with that id under this tenant (`project-not-found`).'),
      '501': ErrorResponse(
        "The runtime's projects can't be put in production (`production-unsupported`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/team-grants',
    openapiPath: '/v1/projects/{projectId}/team-grants',
    operationId: 'projects.teamGrants.list',
    summary: 'List the teams with a role on a project',
    description:
      "Every member of a team holds its role on the project. For the project's editors and admins (`write`). Each grant names its team and project.",
    tags: ['projects'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of team grants.', schema: ref('TeamProjectGrantCollectionPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No project with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/team-grants',
    openapiPath: '/v1/projects/{projectId}/team-grants',
    operationId: 'projects.teamGrants.add',
    summary: 'Give a team a role on a project',
    description:
      "Every member of the team (its admins included) then holds the role on the project. Takes `admin` on the project and `read` on the team: a project is given only to a team you can read. A team's role is `viewer`, `editor` or `admin`: a team never owns a project. Adding a role the team already holds answers 201 with the existing grant; another role, 409 `team-grant-exists` naming the one it holds (`details.role`): use PATCH to change it.",
    tags: ['projects'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('AddTeamProjectGrantBody') },
    responses: {
      '201': {
        description: 'The team holds the role: given now, or already (the existing grant).',
        schema: ref('TeamProjectGrant'),
      },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'No project (`project-not-found`) or team (`team-not-found`) with that id under this tenant.',
      ),
      '409': ErrorResponse(
        'The team holds another role on the project (`team-grant-exists`, `details.role`); or an Idempotency-Key reused with another body.',
      ),
      '501': ErrorResponse(
        "The runtime can't keep permissions in step with the change (`authz-membership-unsupported`).",
      ),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/projects/:projectId/team-grants/:teamId',
    openapiPath: '/v1/projects/{projectId}/team-grants/{teamId}',
    operationId: 'projects.teamGrants.updateRole',
    summary: "Change a team's role on a project",
    tags: ['projects'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, TeamIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('UpdateTeamProjectGrantBody') },
    responses: {
      '204': { description: 'Changed. No body.' },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'No project with that id (`project-not-found`), or the team has no role on it (`team-grant-not-found`).',
      ),
      '501': ErrorResponse(
        "The runtime can't keep permissions in step with the change (`authz-membership-unsupported`).",
      ),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/projects/:projectId/team-grants/:teamId',
    openapiPath: '/v1/projects/{projectId}/team-grants/{teamId}',
    operationId: 'projects.teamGrants.remove',
    summary: "Take a team's role on a project away (idempotent)",
    tags: ['projects'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, TeamIdPathParam, IdempotencyKeyParam],
    responses: {
      '204': { description: 'Removed (or there was none). No body.' },
      ...CommonAuthErrors,
      '501': ErrorResponse(
        "The runtime can't keep permissions in step with the change (`authz-membership-unsupported`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/teams/:teamId/project-grants',
    openapiPath: '/v1/teams/{teamId}/project-grants',
    operationId: 'teams.projectGrants.list',
    summary: 'List the projects a team holds a role on',
    description:
      "For the team's admins (and tenant admins). Each grant names its team and project.",
    tags: ['teams'],
    security: 'bearer',
    parameters: [TeamIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of team grants.', schema: ref('TeamProjectGrantCollectionPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No team with that id under this tenant.'),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/projects/:projectId/memberships/:userId',
    openapiPath: '/v1/projects/{projectId}/memberships/{userId}',
    operationId: 'projects.memberships.remove',
    summary: 'Remove a user from a project (idempotent)',
    tags: ['projects'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      {
        name: 'userId',
        in: 'path',
        required: true,
        description: 'UserId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '403': ErrorResponse(
        'The person is one a site signs in, whose grants their site gives back at their next sign-in: remove the person, change their role on the site, or pause the site instead (`site-person-grants-managed`).',
      ),
      '204': { description: 'Removed (or already absent). No body.' },
      ...CommonAuthErrors,
      '501': ErrorResponse(
        "With authorization enforced, a runtime whose tenant-hierarchy binding can't change the membership together with its authorization tuple refuses with `authz-membership-unsupported`; nothing is changed.",
      ),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/projects/:projectId/memberships/:userId',
    openapiPath: '/v1/projects/{projectId}/memberships/{userId}',
    operationId: 'projects.memberships.updateRole',
    summary: "Change an existing project member's role",
    tags: ['projects'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'ProjectId — opaque branded string.',
        schema: { type: 'string' },
      },
      {
        name: 'userId',
        in: 'path',
        required: true,
        description: 'UserId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('UpdateProjectMembershipBody') },
    responses: {
      '204': { description: 'Role updated. No body.' },
      ...CommonMutationErrors,
      '403': ErrorResponse(
        "The person is one a site signs in, who holds only the grants their site's sign-in writes (`site-person-grants-managed`).",
      ),
      '404': ErrorResponse(
        'No membership for that (project, user) pair, or no such project under this tenant.',
      ),
      '501': ErrorResponse(
        "With authorization enforced, a runtime whose tenant-hierarchy binding can't change the membership together with its authorization tuple refuses with `authz-membership-unsupported`; nothing is changed.",
      ),
    },
  },

  // ---------- tenant ----------
  {
    method: 'get',
    honoPath: '/v1/tenant',
    openapiPath: '/v1/tenant',
    operationId: 'tenant.get',
    summary: "Fetch the caller's tenant",
    description:
      "Returns the tenant the bearer token authenticates as. There is no `/v1/tenants` collection — tenants are the sovereignty boundary, not a listable resource under a tenant. A runtime that gates production adds `productionAllowed` (and `productionNext` while it's `false`), one that sets limits adds the tenant's `limits`, and a deployment that publishes where its calls come from adds `egress`.",
    tags: ['tenant'],
    security: 'bearer',
    responses: {
      '200': { description: 'Tenant.', schema: ref('Tenant') },
      ...CommonAuthErrors,
      '404': ErrorResponse('The tenant id on the token does not resolve to a stored row.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/tenant',
    openapiPath: '/v1/tenant',
    operationId: 'tenant.update',
    summary: "Rename the caller's tenant",
    description:
      "Changes its name, its slug, or both; a field left out stays as it is. Its id stays, so whatever names it by its id keeps working. The console's addresses carry the slug: after a new one, links with the old one stop opening the tenant, and another tenant may take the old one. The same values again change nothing. Takes `admin` on the tenant. A runtime whose tenant-hierarchy binding can't rename tenants doesn't serve this route.",
    tags: ['tenant'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('TenantPatch') },
    responses: {
      '204': { description: 'Renamed, or already so. No body.' },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'A malformed body or a field out of its rules (`bad-input`), or a field other than `name` and `slug` (`unknown-field`).',
      ),
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('The tenant id on the token does not resolve to a stored row.'),
      '409': ErrorResponse(
        "Another tenant has the slug (`tenant-slug-taken`); the server's verified sign-in domains name the tenant by its current slug, or name the new one (`tenant-slug-in-config`); the tenant is closing (`tenant-closing`); its setup hasn't finished (`tenant-setup-pending`); or an Idempotency-Key reused with another body.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/tenant/config',
    openapiPath: '/v1/tenant/config',
    operationId: 'tenant.config.list',
    summary: "List the tenant's config entries",
    description:
      'Cursor-paginated: the env entries (in the env binding order), then the `config` entries when they live apart from them, then the secret entries (in the secrets binding order); a page holds at most `limit` entries and `nextCursor` resumes where it ended. Optional `?kind=` narrows to one slot (env / config / secret); `?keyPrefix=` matches on entry key. `env` and `secret` entries are the ones under the env the runtime serves (`servedEnv` in whoami), where its tools read them; `config` entries, the tenant settings, are under `default` whatever it serves. On a runtime that serves none, all of them are under `default`. **Secret values are ALWAYS redacted on this admin surface** — the dispatch path is the only reader that receives raw material.',
    tags: ['tenant'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'kind',
        in: 'query',
        required: false,
        description: 'Restrict to one slot: env, config, or secret.',
        schema: { $ref: '#/components/schemas/TenantConfigKind' },
      },
      {
        name: 'keyPrefix',
        in: 'query',
        required: false,
        description: 'Prefix match on entry key.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': {
        description: 'Page of tenant-config entries.',
        schema: ref('TenantConfigCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/tenant/config',
    openapiPath: '/v1/tenant/config',
    operationId: 'tenant.config.upsert',
    summary: 'Upsert a tenant-config entry',
    description:
      'Set / update an entry keyed by `(kind, key)`. An `env` or `secret` entry (or one sent with `sensitive: true`) is stored under the env the runtime serves (`servedEnv` in whoami), where its tools read it; a `config` entry, a tenant setting, under `default` whatever it serves. On a runtime that serves none, both are under `default`. Optional `ifRevision` provides optimistic-concurrency: the write fails with `tenant-config-revision-conflict` (409) unless the stored revision matches. Omit for last-write-wins.',
    tags: ['tenant'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('UpsertTenantConfigBody') },
    responses: {
      '200': {
        description: 'Entry upserted.',
        schema: ref('UpsertTenantConfigResult'),
      },
      ...CommonMutationErrors,
      ...SecretWriteErrors,
      '409': ErrorResponse('`ifRevision` was set and did not match the stored revision.'),
    },
  },

  // ---------- environment orders ----------
  {
    method: 'get',
    honoPath: '/v1/environment-orders',
    openapiPath: '/v1/environment-orders',
    operationId: 'environmentOrders.list',
    summary: "List the tenant's environment orders",
    description:
      "The order a tenant runs a project through on its way to live — its environments: the tenant's own order and each org's. An order is listed when the caller can read a project in it; a project the caller can't read is named by its position alone, without its id.",
    tags: ['environments'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of environment orders.', schema: ref('EnvironmentOrderPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse("`cursor` isn't one this list gave (`bad-input`)."),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/environment-orders/tenant',
    openapiPath: '/v1/environment-orders/tenant',
    operationId: 'environmentOrders.getTenant',
    summary: "Get the tenant's environment order",
    description:
      "The tenant's own environment order; empty when it was never set or was cleared. A project the caller can't read is named by its position alone.",
    tags: ['environments'],
    security: 'bearer',
    responses: {
      '200': { description: 'The order.', schema: ref('EnvironmentOrder') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'put',
    honoPath: '/v1/environment-orders/tenant',
    openapiPath: '/v1/environment-orders/tenant',
    operationId: 'environmentOrders.setTenant',
    summary: "Set the tenant's environment order",
    description:
      'Replace the order with the projects given, in order; send `[]` to clear it. For a tenant admin. An order needs two or more projects, no project named twice, and each project live in the tenant and in no other order. A write that changes nothing is a no-op. Removing a project from the order or reordering leaves running deployments where they are; a project in no order takes builds directly, as before.',
    tags: ['environments'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('EnvironmentOrderSetRequest') },
    responses: {
      '200': { description: 'The order as it now stands.', schema: ref('EnvironmentOrder') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Only a tenant admin sets an environment order (`permission-denied`).'),
      '409': ErrorResponse(
        'A project in the order already belongs to another one (`project-in-another-order`).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/environment-orders/orgs/:orgId',
    openapiPath: '/v1/environment-orders/orgs/{orgId}',
    operationId: 'environmentOrders.getOrg',
    summary: "Get an org's environment order",
    description:
      "An org's environment order; empty when it was never set or was cleared. A project the caller can't read is named by its position alone.",
    tags: ['environments'],
    security: 'bearer',
    parameters: [
      {
        name: 'orgId',
        in: 'path',
        required: true,
        description: 'OrgId — opaque branded string.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'The order.', schema: ref('EnvironmentOrder') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'put',
    honoPath: '/v1/environment-orders/orgs/:orgId',
    openapiPath: '/v1/environment-orders/orgs/{orgId}',
    operationId: 'environmentOrders.setOrg',
    summary: "Set an org's environment order",
    description:
      "Replace the org's order with the projects given, in order; send `[]` to clear it. For a tenant admin. An order needs two or more projects, no project named twice, and each project live under this org and in no other order. A write that changes nothing is a no-op. Removing a project from the order or reordering leaves running deployments where they are; a project in no order takes builds directly, as before.",
    tags: ['environments'],
    security: 'bearer',
    parameters: [
      {
        name: 'orgId',
        in: 'path',
        required: true,
        description: 'OrgId — opaque branded string.',
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('EnvironmentOrderSetRequest') },
    responses: {
      '200': { description: 'The order as it now stands.', schema: ref('EnvironmentOrder') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Only a tenant admin sets an environment order (`permission-denied`).'),
      '409': ErrorResponse(
        'A project in the order already belongs to another one (`project-in-another-order`).',
      ),
    },
  },

  // ---------- env ----------
  {
    method: 'get',
    honoPath: '/v1/environments',
    openapiPath: '/v1/environments',
    operationId: 'environments.list',
    summary: "List the tenant's env names",
    description:
      "The env names the tenant holds an env value or a secret under, at any scope, each once, in byte order: the `envName` that `GET /v1/env` and `GET /v1/secrets` take. A revoked secret doesn't count. For a tenant admin. 501 `environments-unsupported` from a runtime whose env or secret store can't list its env names.",
    tags: ['env'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of env names.', schema: ref('EnvironmentPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse("`cursor` isn't one this list gave (`bad-input`)."),
      '501': ErrorResponse(
        "The runtime's env or secret store can't list its env names (`environments-unsupported`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/env',
    openapiPath: '/v1/env',
    operationId: 'env.list',
    summary: 'List env entries',
    description:
      'Cursor-paginated list of env entries at the given `(scope, envName)`. `value` is present (env is non-sensitive by definition).',
    tags: ['env'],
    security: 'bearer',
    parameters: [
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
      LimitQueryParam,
      CursorQueryParam,
      NamePrefixQueryParam,
    ],
    responses: {
      '200': { description: 'Page of env entries.', schema: ref('EnvCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope / envName.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/env/:name',
    openapiPath: '/v1/env/{name}',
    operationId: 'env.get',
    summary: 'Get one env entry',
    tags: ['env'],
    security: 'bearer',
    parameters: [
      EnvEntryNamePathParam,
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
    ],
    responses: {
      '200': { description: 'Env record.', schema: ref('EnvRecord') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope / envName.'),
      '404': ErrorResponse('No env entry at this key.'),
    },
  },
  {
    method: 'put',
    honoPath: '/v1/env/:name',
    openapiPath: '/v1/env/{name}',
    operationId: 'env.put',
    summary: 'Upsert an env entry',
    description:
      "Requires the `env:write` capability. Every write bumps `revision`; optional `ifRevision` guards against concurrent updates (409 `env-write-conflict`). Env values aren't secret: they're recorded with each run that uses them. A credential goes in `/v1/secrets`.",
    tags: ['env'],
    security: 'bearer',
    parameters: [
      EnvEntryNamePathParam,
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
      IdempotencyKeyParam,
    ],
    requestBody: { required: true, schema: ref('EnvSetRequest') },
    responses: {
      '200': { description: 'Env record.', schema: ref('EnvRecord') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Bearer token missing `env:write` capability.'),
      '409': ErrorResponse(
        `\`ifRevision\` mismatch (env-write-conflict). Or ${ENV_NOT_SERVED_VALUE}`,
      ),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/env/:name',
    openapiPath: '/v1/env/{name}',
    operationId: 'env.delete',
    summary: 'Delete an env entry',
    description:
      'Requires the `env:write` capability. Idempotent — unknown key returns `{ deleted: false }`.',
    tags: ['env'],
    security: 'bearer',
    parameters: [
      EnvEntryNamePathParam,
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
    ],
    responses: {
      '200': { description: 'Delete outcome.', schema: ref('EnvDeleteResult') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope / envName.'),
      '403': ErrorResponse('Bearer token missing `env:write` capability.'),
    },
  },

  // ---------- secrets ----------
  {
    method: 'get',
    honoPath: '/v1/secrets',
    openapiPath: '/v1/secrets',
    operationId: 'secrets.list',
    summary: 'List secret metadata',
    description:
      'Cursor-paginated list of secret metadata at the given `(scope, envName)`, in name order, with `nextCursor` while more remain. Live secrets only unless `?includeRevoked=true`. Names that start with `kindgi.` are reserved for Kindgi and never listed. `value` is ALWAYS absent (structural redaction).',
    tags: ['secrets'],
    security: 'bearer',
    parameters: [
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
      LimitQueryParam,
      CursorQueryParam,
      NamePrefixQueryParam,
      {
        name: 'includeRevoked',
        in: 'query',
        required: false,
        description:
          '`true` lists revoked secrets too, with their `revokedAt` and `revokeReason`. Metadata only, never a value.',
        schema: { type: 'string', enum: ['true', 'false'] },
      },
    ],
    responses: {
      '200': {
        description: 'Page of secret metadata.',
        schema: ref('SecretCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "Missing or malformed scope / envName, or a `cursor` this list didn't issue.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/secrets/:name',
    openapiPath: '/v1/secrets/{name}',
    operationId: 'secrets.get',
    summary: 'Get secret metadata',
    tags: ['secrets'],
    security: 'bearer',
    parameters: [
      SecretNamePathParam,
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
    ],
    responses: {
      '200': { description: 'Secret metadata.', schema: ref('SecretRecord') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope / envName.'),
      '404': ErrorResponse('No secret at this key.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/secrets/:name/versions',
    openapiPath: '/v1/secrets/{name}/versions',
    operationId: 'secrets.listVersions',
    summary: 'List secret versions',
    description:
      'Cursor-paginated version metadata for a single secret. `value` is ALWAYS null on the wire.',
    tags: ['secrets'],
    security: 'bearer',
    parameters: [
      SecretNamePathParam,
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': {
        description: 'Page of version metadata.',
        schema: ref('SecretVersionCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        "Missing or malformed scope / envName, or a `cursor` this list didn't issue.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/secrets/:name/versions/:versionId',
    openapiPath: '/v1/secrets/{name}/versions/{versionId}',
    operationId: 'secrets.getVersion',
    summary: 'Get one secret-version record',
    tags: ['secrets'],
    security: 'bearer',
    parameters: [
      SecretNamePathParam,
      {
        name: 'versionId',
        in: 'path',
        required: true,
        description: 'Positive integer version id.',
        schema: { type: 'integer', minimum: 1 },
      },
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
    ],
    responses: {
      '200': {
        description: 'Version metadata (value=null on the wire).',
        schema: ref('SecretVersionRecord'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope / envName.'),
      '404': ErrorResponse('No version at this key.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/secrets',
    openapiPath: '/v1/secrets',
    operationId: 'secrets.set',
    summary: 'Create a secret or add a version',
    description:
      'Accepts a plaintext `value` (as do `POST /v1/secrets/:name/rotate` via `newValue` and `POST /v1/deployments/:deploymentId/secrets`); every other secrets route is metadata-only. Requires the `secrets:write` capability. `writeMode: create-new` returns 201 with the record; `add-version` returns 200. Existing-secret conflicts on `create-new` return 409 `secret-write-conflict`.',
    tags: ['secrets'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('SecretSetRequest') },
    responses: {
      '201': {
        description: 'Secret created (create-new).',
        schema: ref('SecretSetResponse'),
      },
      '200': {
        description: 'Version added (add-version).',
        schema: ref('SecretSetResponse'),
      },
      ...CommonMutationErrors,
      ...SecretWriteErrors,
      '403': ErrorResponse('Bearer token missing `secrets:write` capability.'),
      '409': conflictOrEnvNotServed(ENV_NOT_SERVED_VALUE),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/secrets/:name/rotate',
    openapiPath: '/v1/secrets/{name}/rotate',
    operationId: 'secrets.rotate',
    summary: 'Rotate a secret (sync or async)',
    description:
      'Requires the `secrets:rotate` capability. The scope comes from body `scope`, else from `scopeKind` + `scopeId` in the query; one of them is required, and when both are present they must name the same scope. Authorization checks that scope. Sync providers return 201 with `{ kind: "sync", newVersionId, oldVersionId, oldVersionRevokedAt? }`. Async providers return 202 with `{ kind: "async", rotationId, statusUrl, eventsUrl }`; poll via `GET /v1/secrets/:name/rotations/:rotationId` or subscribe via SSE at the events URL. `kind` is the discriminant.',
    tags: ['secrets'],
    security: 'bearer',
    parameters: [
      SecretNamePathParam,
      RotateEnvNameQueryParam,
      RotateScopeKindQueryParam,
      ScopeIdQueryParam,
      IdempotencyKeyParam,
    ],
    requestBody: { required: false, schema: ref('SecretRotateRequest') },
    responses: {
      '201': {
        description: 'Sync rotation complete.',
        schema: ref('SecretRotateResponseSync'),
      },
      '202': {
        description: 'Async rotation accepted; poll or subscribe.',
        schema: ref('SecretRotateResponseAsync'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'A body that fails validation (`bad-input`), or a rotation the store refuses as it would the write: `secret-value-too-large` for a new value over its size limit, or `reserved-name-prefix` for a `kindgi.` name.',
      ),
      ...SecretProviderErrors,
      '403': ErrorResponse('Bearer token missing `secrets:rotate` capability.'),
      '404': ErrorResponse('Unknown secret.'),
      '409': conflictOrEnvNotServed(ENV_NOT_SERVED_VALUE),
      '501': ErrorResponse(
        "The store doesn't rotate (`secret-operation-unsupported`): under `kindgi dev` secrets live in the env files and have no versions; the message says what to do instead.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/secrets/:name/rotations/:rotationId',
    openapiPath: '/v1/secrets/{name}/rotations/{rotationId}',
    operationId: 'secrets.getRotationStatus',
    summary: 'Get async rotation status',
    tags: ['secrets'],
    security: 'bearer',
    parameters: [
      SecretNamePathParam,
      {
        name: 'rotationId',
        in: 'path',
        required: true,
        description: 'UUID minted at rotate time.',
        schema: { type: 'string', format: 'uuid' },
      },
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
    ],
    responses: {
      '200': { description: 'Rotation status.', schema: ref('RotationStatus') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope / envName.'),
      '404': ErrorResponse('Unknown rotation id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/secrets/:name/rotations/:rotationId/events',
    openapiPath: '/v1/secrets/{name}/rotations/{rotationId}/events',
    operationId: 'secrets.rotationEvents',
    summary: 'Subscribe to async rotation events (SSE)',
    description:
      '`text/event-stream` — one `rotation-update` frame per status change; a `ping` heartbeat every 15s keeps proxies from timing the stream out; the stream closes on terminal state.',
    tags: ['secrets'],
    security: 'bearer',
    parameters: [
      SecretNamePathParam,
      {
        name: 'rotationId',
        in: 'path',
        required: true,
        description: 'UUID minted at rotate time.',
        schema: { type: 'string', format: 'uuid' },
      },
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
    ],
    responses: {
      '200': { description: 'SSE stream.', contentType: 'text/event-stream' },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope / envName.'),
      '404': ErrorResponse('Unknown rotation id.'),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/secrets/:name',
    openapiPath: '/v1/secrets/{name}',
    operationId: 'secrets.revoke',
    summary: 'Revoke a secret',
    description:
      "Requires the `secrets:revoke` capability (soft-revoke), or `secrets:revoke:hard` when `?hard=true`: that erases the value at Kindgi and hard-deletes it in a secret manager, and can't be undone. Backups, and a secret manager's own retention, may keep copies for a time. If your secret manager keeps a recoverable copy, the answer's `recoverableUntil` says until when. Optional `?reason=<text>` records the revoke reason.",
    tags: ['secrets'],
    security: 'bearer',
    parameters: [
      SecretNamePathParam,
      EnvNameQueryParam,
      ScopeKindRequiredQueryParam,
      ScopeIdQueryParam,
      {
        name: 'hard',
        in: 'query',
        required: false,
        description:
          "Set to `true` to erase the value, which can't be undone. Backups, and a secret manager's own retention, may keep copies for a time. If your secret manager keeps a recoverable copy, the answer's `recoverableUntil` says until when.",
        schema: { type: 'boolean' },
      },
      {
        name: 'reason',
        in: 'query',
        required: false,
        description: 'Human-readable revoke reason retained in the tombstone.',
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': { description: 'Revoke outcome.', schema: ref('SecretRevokeResult') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'Missing or malformed scope / envName, or `reserved-name-prefix` for a `kindgi.` name.',
      ),
      '403': ErrorResponse('Bearer token missing revoke capability.'),
      '404': ErrorResponse('Unknown secret.'),
      '501': ErrorResponse(
        "The store doesn't revoke (`secret-operation-unsupported`): under `kindgi dev` secrets live in the env files; the message says to remove the name there.",
      ),
    },
  },

  // ---------- schedules (trigger surface) ----------
  {
    method: 'post',
    honoPath: '/v1/schedules',
    openapiPath: '/v1/schedules',
    operationId: 'schedules.register',
    summary: 'Register a cron schedule',
    description:
      "Registers a `kind=cron` trigger. `nextFireAt` is precomputed from the cron expression at register time; the cron scheduler in the runtime fires due triggers. Malformed cron expressions return 400 `trigger-invalid-config` without registering. `toolsAllowedUnattended` names the tools whose calls in its runs needn't wait for a person's yes, though a tool asks for one in a run no person started: naming it takes `admin` on the schedule's project, each id must be a tool what it runs calls, and it's audited (`trigger-tools-allowed-unattended-set`).",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterScheduleBody') },
    responses: {
      '201': { description: 'Schedule registered.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed request body, or `runAsProject` with `runAsServiceAccountId`, or for a schedule with no project (`bad-input`). Or `reference-out-of-scope`: what it runs isn't registered in the schedule's project, its org or the tenant, or the version it names (`flowVersion`, or `agentVersion` when given) isn't one that project runs (`details.issues`, at `/target`, whose message names the version). Nothing is registered.",
      ),
      '403': ErrorResponse(
        "`permission-denied`: no `write` on the schedule's project or no `execute` on what it runs; or no `admin` on the project where it's needed, for `toolsAllowedUnattended` or `runAsProject`; or no `act_as` on the account `runAsServiceAccountId` names.",
      ),
      '409': ErrorResponse(
        "`runAsServiceAccountId` names an unregistered account (`service-account-unregistered`), a project's own account (`service-account-project-owned`: name it with `runAsProject`), or one that can't run what the schedule runs (`trigger-owner-cannot-run-target`). Or, with `runAsProject`, the project's own account can't run what the schedule runs either (`trigger-owner-cannot-run-target`; the account stays, for the next `runAsProject`), or an active account someone made already has the project account's name, `project-<projectId>` (`service-account-name-taken`: a tenant admin can unregister it). Or an idempotency conflict.",
      ),
      '501': ErrorResponse(
        "`trigger-operation-unsupported`: `runAsProject` on a runtime that can't make a project's own account.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/schedules',
    openapiPath: '/v1/schedules',
    operationId: 'schedules.list',
    summary: 'List cron schedules',
    description:
      "Cursor-paginated. Tombstoned rows excluded. Optional `?status=active|paused` and `?projectId=` (one project's schedules) filters. Each schedule's `owner.displayName` is the owner's name now (the person's or the service account's), when it can be read.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      TriggerStatusFilterQueryParam,
      ScheduleProjectIdQueryParam,
    ],
    responses: {
      '200': { description: 'Page of schedules.', schema: ref('ScheduleCollectionPage') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/schedules/:triggerId',
    openapiPath: '/v1/schedules/{triggerId}',
    operationId: 'schedules.get',
    summary: 'Fetch a cron schedule',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [
      TriggerIdPathParam,
      {
        name: 'upcoming',
        in: 'query',
        required: false,
        description: 'Include the next N occurrences (`upcoming`), 1 to 20.',
        schema: { type: 'integer', minimum: 1, maximum: 20 },
      },
    ],
    responses: {
      '200': { description: 'Schedule record.', schema: ref('ScheduleRecord') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No cron trigger with that id, or the row was tombstoned.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/schedules/:triggerId',
    openapiPath: '/v1/schedules/{triggerId}',
    operationId: 'schedules.update',
    summary: 'Update a cron schedule',
    description:
      "Partial merge on `config`. If `config.cronExpression` changes, `nextFireAt` is recomputed. `label: null` clears the label; omit to leave unchanged. Malformed cron expressions return 400 `trigger-invalid-config`. `toolsAllowedUnattended` replaces the list (`[]` clears it; absent keeps it): naming it takes `admin` on the schedule's project, and every change is audited. A new target (another flow or agent) while the list isn't empty must name it again, as it is or `[]`, else 400; a new version alone keeps it. A schedule is personal or shared, and no change moves its owner: only `POST /v1/schedules/{triggerId}/owner` does. So with an authorization store, a new target (another flow or agent, or an Improve run) must be one the owner can run, a person or a service account, else `409 trigger-owner-cannot-run-target`; that's not checked when the caller is the owner, nor for an owner that was unregistered or removed. A schedule a person owns is personal: only they (holding `write` on its project) or a project admin may change it. A schedule a service account owns is shared: changing its target or version, its input or `toolsAllowedUnattended` takes `admin` on its project, and the project's writers may change its label, cron line and policies. Without an authorization store, a project admin here is a tenant-admin key. A change by anyone but a personal schedule's owner is audited as `trigger-changed-for-owner`, naming the fields changed and the schedule's version after it, never their values.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PatchScheduleBody') },
    responses: {
      '200': { description: 'Updated schedule.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed request body, or `trigger-invalid-config`. Or `reference-out-of-scope`: a new target isn't registered in the schedule's project, its org or the tenant, or the version it names isn't one that project runs (`details.issues`, at `/target`, whose message names the version). Nothing changes.",
      ),
      '403': ScheduleChangeRefused,
      '404': ErrorResponse('No cron trigger with that id.'),
      '409': ErrorResponse(
        "A new target the schedule's owner can't run (`trigger-owner-cannot-run-target`), with an authorization store. Or an Idempotency-Key reused with a different body.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/schedules/:triggerId/pause',
    openapiPath: '/v1/schedules/{triggerId}/pause',
    operationId: 'schedules.pause',
    summary: 'Pause a cron schedule',
    description:
      "Idempotent-per-state: pausing an already-paused row returns 409 `trigger-already-in-state`. A personal schedule's owner or a project admin pauses it; a shared one, any writer of its project.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Paused schedule.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
      '403': ScheduleChangeRefused,
      '404': ErrorResponse('No cron trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/schedules/:triggerId/resume',
    openapiPath: '/v1/schedules/{triggerId}/resume',
    operationId: 'schedules.resume',
    summary: 'Resume a cron schedule',
    description:
      "Recomputes `nextFireAt` so the scheduler picks up the resumed row on its next tick. A personal schedule's owner or a project admin resumes it; a shared one, any writer of its project.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Resumed schedule.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
      '403': ScheduleChangeRefused,
      '404': ErrorResponse('No cron trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/schedules/:triggerId/unregister',
    openapiPath: '/v1/schedules/{triggerId}/unregister',
    operationId: 'schedules.unregister',
    summary: 'Soft-delete a cron schedule (tombstone)',
    description:
      "Tombstones the schedule; the cron scheduler ignores tombstoned triggers. Retention may hard-remove tombstoned triggers after the tombstone window. A personal schedule's owner or a project admin deletes it; a shared one, any writer of its project.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Tombstone outcome.', schema: ref('ScheduleUnregisterResult') },
      ...CommonMutationErrors,
      '403': ScheduleChangeRefused,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/schedules/:triggerId/fires',
    openapiPath: '/v1/schedules/{triggerId}/fires',
    operationId: 'schedules.fires',
    summary: "A schedule's fire history",
    description:
      'Newest first: each occurrence (and `run-now`) the schedule fired for, and what came of it: the run it started, or why it was skipped, refused or failed.',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of fires.', schema: ref('ScheduleFirePage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No cron trigger with that id.'),
      '501': ErrorResponse(
        '`trigger-operation-unsupported`: this deployment keeps no fire history.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/schedules/:triggerId/versions',
    openapiPath: '/v1/schedules/{triggerId}/versions',
    operationId: 'schedules.listVersions',
    summary: "A schedule's versions",
    description:
      "Newest first: each version of the schedule, what it was from `createdAt` on, who made it (`createdBy`) and why (`cause`). Registering makes version 1, and each change makes the next (a PATCH that alters it, or a take-over to another owner): a PATCH that changes nothing makes none, nor do pausing, resuming or deleting. A version never changes once made. A fire's run uses the newest when it starts, and keeps it whatever later edits make (the run's `trigger.version`). A schedule from before versions has none until its next change or its first fire. The versions keep every input the schedule has had, so a secret pasted into its input stays in an earlier version after you edit it out: rotate it. Whoever can read the schedule can read its versions.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of versions, newest first.', schema: ref('ScheduleVersionPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No cron trigger with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/schedules/:triggerId/versions/:version',
    openapiPath: '/v1/schedules/{triggerId}/versions/{version}',
    operationId: 'schedules.getVersion',
    summary: 'Fetch one version of a schedule',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, TriggerVersionPathParam],
    responses: {
      '200': { description: 'The version.', schema: ref('ScheduleVersion') },
      '400': ErrorResponse("`version` isn't a positive integer (`bad-input`, `details.field`)."),
      ...CommonAuthErrors,
      '404': ErrorResponse(
        'No cron trigger with that id (`trigger-not-found`), or it has no version with that number (`trigger-version-not-found`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/schedules/:triggerId/run-now',
    openapiPath: '/v1/schedules/{triggerId}/run-now',
    operationId: 'schedules.runNow',
    summary: 'Run a schedule now',
    description:
      "One fire outside the schedule (`manual: true` in its history), starting one run as the schedule's owner. The schedule's next occurrence is unchanged. A personal schedule's owner or a project admin fires it; a shared one, any writer of its project.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '202': {
        description: 'The fire; its run starts in the background.',
        schema: ref('ScheduleFire'),
      },
      ...CommonMutationErrors,
      '403': ScheduleChangeRefused,
      '404': ErrorResponse('No cron trigger with that id.'),
      '501': ErrorResponse('`trigger-operation-unsupported`: this deployment has no run-now.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/schedules/:triggerId/owner',
    openapiPath: '/v1/schedules/{triggerId}/owner',
    operationId: 'schedules.takeOwnership',
    summary: 'Take over a schedule',
    description:
      "The caller becomes the schedule's owner, so its runs act as the caller from the next run that starts. Needs `admin` on the schedule's project (without an authorization store, a tenant-admin key) and `execute` on what it runs. For a schedule whose owner left or lost access, or to make one shared or personal. It's the one way a schedule's owner changes, audited as `trigger-owner-set`, naming the schedule's version after it; a person it's taken from is told, where the server tells owners. Name `runAsServiceAccountId` instead to make a service account the owner: that needs `act_as` on the account (a tenant admin's), and the account must itself hold the access the schedule's target needs. With an authorization store, that's checked when the account is named: an account that can't is refused (`409 trigger-owner-cannot-run-target`). Or name `runAsProject: true` to make the project's own service account the owner, made the first time with the `editor` role on the project, so the schedule is shared and runs as the project. It runs only what the project's editors can, and is checked the same way. The schedule keeps its `toolsAllowedUnattended`, now for the new owner's runs; a body naming it is refused (change it with PATCH).",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('TakeTriggerOwnerBody') },
    responses: {
      '200': { description: 'The schedule, with its new owner.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'A malformed body, or `runAsProject` with `runAsServiceAccountId`, or a body naming `toolsAllowedUnattended` (`bad-input`).',
      ),
      '403': ErrorResponse(
        "`permission-denied`: not an admin of the schedule's project, or no `execute` on what it runs, or no `act_as` on the account named.",
      ),
      '404': ErrorResponse('No cron trigger with that id, or no such service account.'),
      '409': ErrorResponse(
        "`runAsServiceAccountId` names an unregistered account (`service-account-unregistered`), a project's own account (`service-account-project-owned`: name it with `runAsProject`), or one that can't run what the schedule runs (`trigger-owner-cannot-run-target`). Or, with `runAsProject`, the project's own account can't run what the schedule runs either (`trigger-owner-cannot-run-target`; the account stays, for the next `runAsProject`), or an active account someone made already has the project account's name, `project-<projectId>` (`service-account-name-taken`: a tenant admin can unregister it). Or an idempotency conflict.",
      ),
      '501': ErrorResponse(
        "`trigger-operation-unsupported`: this deployment can't change a schedule's owner, or can't make a project's own account (`runAsProject`).",
      ),
    },
  },

  // ---------- event-triggers (trigger surface) ----------
  {
    method: 'post',
    honoPath: '/v1/event-triggers',
    openapiPath: '/v1/event-triggers',
    operationId: 'eventTriggers.register',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: 'Register an event trigger',
    description:
      'Registers a `kind=event` trigger. The event-trigger scheduler in the runtime subscribes on the deployment event bus for the given `eventKind`; matching events start a flow run.',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterEventTriggerBody') },
    responses: {
      '201': { description: 'Event trigger registered.', schema: ref('EventTriggerRecord') },
      ...CommonMutationErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/event-triggers',
    openapiPath: '/v1/event-triggers',
    operationId: 'eventTriggers.list',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: 'List event triggers',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam, TriggerStatusFilterQueryParam],
    responses: {
      '200': { description: 'Page of event triggers.', schema: ref('EventTriggerCollectionPage') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/event-triggers/:triggerId',
    openapiPath: '/v1/event-triggers/{triggerId}',
    operationId: 'eventTriggers.get',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: 'Fetch an event trigger',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam],
    responses: {
      '200': { description: 'Event trigger record.', schema: ref('EventTriggerRecord') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No event trigger with that id, or the row was tombstoned.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/event-triggers/:triggerId',
    openapiPath: '/v1/event-triggers/{triggerId}',
    operationId: 'eventTriggers.update',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: 'Update an event trigger',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PatchEventTriggerBody') },
    responses: {
      '200': { description: 'Updated event trigger.', schema: ref('EventTriggerRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No event trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/event-triggers/:triggerId/pause',
    openapiPath: '/v1/event-triggers/{triggerId}/pause',
    operationId: 'eventTriggers.pause',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: 'Pause an event trigger',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Paused event trigger.', schema: ref('EventTriggerRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No event trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/event-triggers/:triggerId/resume',
    openapiPath: '/v1/event-triggers/{triggerId}/resume',
    operationId: 'eventTriggers.resume',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: 'Resume an event trigger',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Resumed event trigger.', schema: ref('EventTriggerRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No event trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/event-triggers/:triggerId/unregister',
    openapiPath: '/v1/event-triggers/{triggerId}/unregister',
    operationId: 'eventTriggers.unregister',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: 'Soft-delete an event trigger (tombstone)',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Tombstone outcome.', schema: ref('EventTriggerUnregisterResult') },
      ...CommonMutationErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/event-triggers/:triggerId/versions',
    openapiPath: '/v1/event-triggers/{triggerId}/versions',
    operationId: 'eventTriggers.listVersions',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: "An event trigger's versions",
    description:
      "Newest first: each version of the event trigger, what it was from `createdAt` on, who made it (`createdBy`) and why (`cause`). Registering makes version 1, and each change makes the next: a PATCH that changes nothing makes none, nor do pausing, resuming or deleting. A version never changes once made. A fire's run uses the newest when it starts, and keeps it whatever later edits make (the run's `trigger.version`). An event trigger from before versions has none until its next change or its first fire. The versions keep every input the event trigger has had, so a secret pasted into its input stays in an earlier version after you edit it out: rotate it. Whoever can read the event trigger can read its versions.",
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': {
        description: 'Page of versions, newest first.',
        schema: ref('EventTriggerVersionPage'),
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No event trigger with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/event-triggers/:triggerId/versions/:version',
    openapiPath: '/v1/event-triggers/{triggerId}/versions/{version}',
    operationId: 'eventTriggers.getVersion',
    unserved: "Event triggers aren't served yet: the runtime fires schedules only.",
    summary: 'Fetch one version of an event trigger',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, TriggerVersionPathParam],
    responses: {
      '200': { description: 'The version.', schema: ref('EventTriggerVersion') },
      '400': ErrorResponse("`version` isn't a positive integer (`bad-input`, `details.field`)."),
      ...CommonAuthErrors,
      '404': ErrorResponse(
        'No event trigger with that id (`trigger-not-found`), or it has no version with that number (`trigger-version-not-found`).',
      ),
    },
  },

  // ---------- webhooks (trigger surface) ----------
  {
    method: 'post',
    honoPath: '/v1/webhooks',
    openapiPath: '/v1/webhooks',
    operationId: 'webhooks.register',
    summary: 'Register a webhook trigger',
    description:
      "A signed request to the trigger's `receiveUrl` (`POST /v1/hooks/{tenantId}/{webhookId}`) starts a run of its flow, as its owner: the caller, until an admin takes it over. The route mints `webhookId` (a random UUID). The signing secret is written first (`POST /v1/secrets`), and `hmacSecretName` names it; a model provider's key is refused (`400 provider-key-refused`). Where it's read is recorded on the trigger (`hmacSecretScope`): the first of its project, the project's org and the tenant that has it and that the caller administers, else the broadest they administer; the receiver reads it there only. Or `generateSecret: true`: the server makes it, stores it as `hmacSecretName` in the trigger's own project (a name the project already has is refused, `409 secret-write-conflict`), and returns it once as `signingSecret`. `signature` says how the sender signs (default: a hex HMAC-SHA256 of the raw body in `X-Kindgi-Signature`); `deliveryIdHeader` names the header whose value, with the body, dedupes deliveries. A trigger that names no `projectId` goes in the tenant's Default project. Needs `write` on the project and `execute` on the flow. `toolsAllowedUnattended` names the tools whose calls in its runs needn't wait for a person's yes, though a tool asks for one in a run no person started: naming it takes `admin` on the project, each id must be a tool the flow calls, and it's audited (`trigger-tools-allowed-unattended-set`).",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterWebhookTriggerBody') },
    responses: {
      '201': { description: 'Webhook registered.', schema: ref('WebhookTriggerRecord') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "A body that fails validation (`bad-input`), `runAsProject` with `runAsServiceAccountId` or for a trigger with no project (`bad-input`), or `provider-key-refused`: `hmacSecretName` is a model provider's key, or `reserved-name-prefix`: it's under the reserved `kindgi.` prefix. Or `reference-out-of-scope`: the flow isn't registered in the trigger's project, its org or the tenant, or `flowVersion` isn't a version that project runs (`details.issues`, at `/flowId`, whose message names the version), and nothing is registered. Or, with `generateSecret`, a name the secrets store can't write, refused before anything is stored: `secret-name-invalid` (a name that isn't 1 to 255 ASCII letters, digits, `.`, `-` and `_` starting with a letter, digit or `_`, with any `.` between two non-`.` characters, or, under `kindgi dev`, isn't capital letters, digits and underscores, starts with a digit, or is `KINDGI_*`; the message says the rule).",
      ),
      '409': ErrorResponse(
        "`secret-write-conflict`: with `generateSecret`, the trigger's project already has a secret of that name (it's never overwritten, and no trigger is left). Or `runAsServiceAccountId` names an unregistered account (`service-account-unregistered`), a project's own account (`service-account-project-owned`: name it with `runAsProject`), or one that can't run the flow (`trigger-owner-cannot-run-target`). Or, with `runAsProject`, the project's own account can't run the flow either (`trigger-owner-cannot-run-target`; the account stays, for the next `runAsProject`), or an active account someone made already has the project account's name, `project-<projectId>` (`service-account-name-taken`: a tenant admin can unregister it). Or the route-minted webhookId collided (astronomically rare).",
      ),
      '501': ErrorResponse(
        "`trigger-operation-unsupported`: `runAsProject` on a runtime that can't make a project's own account.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhooks',
    openapiPath: '/v1/webhooks',
    operationId: 'webhooks.list',
    summary: 'List webhook triggers',
    description:
      "The tenant's webhook triggers whose project the caller may read; with `projectId`, that project's only (which needs `read` on it).",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      TriggerStatusFilterQueryParam,
      {
        name: 'projectId',
        in: 'query',
        required: false,
        description: "Only this project's webhook triggers.",
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': {
        description: 'Page of webhook triggers.',
        schema: ref('WebhookTriggerCollectionPage'),
      },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhooks/:triggerId',
    openapiPath: '/v1/webhooks/{triggerId}',
    operationId: 'webhooks.get',
    summary: 'Fetch a webhook trigger',
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam],
    responses: {
      '200': { description: 'Webhook record.', schema: ref('WebhookTriggerRecord') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No webhook trigger with that id, or the row was tombstoned.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/webhooks/:triggerId',
    openapiPath: '/v1/webhooks/{triggerId}',
    operationId: 'webhooks.update',
    summary: 'Update a webhook trigger',
    description:
      "Changes the flow version (which needs `execute` on the flow, and must be a version the trigger's project runs), the input, the label, which secret signs (`hmacSecretName`, never a model provider's key), the signature scheme, the delivery-id header, the body cap or the rate (`null` clears the last three). The flow itself stays: register another trigger for another flow. Rotating the secret's value goes through `POST /v1/secrets/{name}/rotate`. `toolsAllowedUnattended` replaces the list (`[]` clears it; absent keeps it, a new flow version too): naming it takes `admin` on the trigger's project, it's checked against the flow at the version the trigger will run, and every change is audited. A webhook trigger is personal or shared, and no change moves its owner: only `POST /v1/webhooks/{triggerId}/owner` does. A trigger a person owns is personal: only they (holding `write` on its project) or a project admin may change it. A trigger a service account owns is shared: changing its flow version, its input, its `toolsAllowedUnattended` or `hmacSecretName` takes `admin` on its project, and the project's writers may change its label and delivery settings. Without an authorization store, a project admin here is a tenant-admin key. A change by anyone but a personal trigger's owner is audited as `trigger-changed-for-owner`, naming the fields changed (and the signing secret's name before and after) and the trigger's version after it, never their values.",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PatchWebhookTriggerBody') },
    responses: {
      '200': { description: 'Updated webhook trigger.', schema: ref('WebhookTriggerRecord') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "A body that fails validation (`bad-input`), or `provider-key-refused`: `hmacSecretName` is a model provider's key, or `reserved-name-prefix`: it's under the reserved `kindgi.` prefix. Or `reference-out-of-scope`: the new `flowVersion` isn't a version the trigger's project runs, such as one made in an earlier environment and not yet promoted (`details.issues`, at `/flowVersion`, whose message names the version). Nothing changes.",
      ),
      '403': WebhookChangeRefused,
      '404': ErrorResponse('No webhook trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhooks/:triggerId/pause',
    openapiPath: '/v1/webhooks/{triggerId}/pause',
    operationId: 'webhooks.pause',
    summary: 'Pause a webhook trigger',
    description:
      "While paused, a signed delivery is answered `202` and recorded as a `skipped` fire, and no run starts: **its event is dropped**. Senders such as WooCommerce never resend, so resuming doesn't bring those events back. A personal trigger's owner or a project admin pauses it; a shared one, any writer of its project.",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Paused webhook.', schema: ref('WebhookTriggerRecord') },
      ...CommonMutationErrors,
      '403': WebhookChangeRefused,
      '404': ErrorResponse('No webhook trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhooks/:triggerId/resume',
    openapiPath: '/v1/webhooks/{triggerId}/resume',
    operationId: 'webhooks.resume',
    summary: 'Resume a webhook trigger',
    description:
      "A personal trigger's owner or a project admin resumes it; a shared one, any writer of its project.",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Resumed webhook.', schema: ref('WebhookTriggerRecord') },
      ...CommonMutationErrors,
      '403': WebhookChangeRefused,
      '404': ErrorResponse('No webhook trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhooks/:triggerId/unregister',
    openapiPath: '/v1/webhooks/{triggerId}/unregister',
    operationId: 'webhooks.unregister',
    summary: 'Soft-delete a webhook trigger (tombstone)',
    description:
      "A personal trigger's owner or a project admin deletes it; a shared one, any writer of its project.",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Tombstone outcome.', schema: ref('WebhookTriggerUnregisterResult') },
      ...CommonMutationErrors,
      '403': WebhookChangeRefused,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhooks/:triggerId/fires',
    openapiPath: '/v1/webhooks/{triggerId}/fires',
    operationId: 'webhooks.fires',
    summary: "A webhook trigger's deliveries",
    description:
      "Newest first: each delivery the trigger received and what came of it: the run it started (`started`, or `pending` while it starts), or why it was `skipped` (paused, its project or tenant suspended, or its tenant closing) or `refused` (`detail`: `signature-missing`, `signature-invalid`, `stale`, `secret-unavailable`, `unregistered`, `rate-limited`, `body-too-large`, `body-not-json`, `body-too-deep`, or the owner's lost access). A delivery that repeated an earlier one's dedupe key counts on that one (`duplicates`). A fire keeps the event only until its run starts. Refusals and skipped deliveries past 20 a minute only count (the trigger's `suppressedRefusals`).",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of deliveries.', schema: ref('WebhookFirePage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No webhook trigger with that id.'),
      '501': ErrorResponse(
        '`trigger-operation-unsupported`: this deployment keeps no delivery history.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhooks/:triggerId/versions',
    openapiPath: '/v1/webhooks/{triggerId}/versions',
    operationId: 'webhooks.listVersions',
    summary: "A webhook trigger's versions",
    description:
      "Newest first: each version of the webhook trigger, what it was from `createdAt` on, who made it (`createdBy`) and why (`cause`). Registering makes version 1, and each change makes the next (a PATCH that alters it, or a take-over to another owner): a PATCH that changes nothing makes none, nor do pausing, resuming or deleting. A version never changes once made. A delivery's run uses the newest when it starts, and keeps it whatever later edits make (the run's `trigger.version`). A webhook trigger from before versions has none until its next change or its first fire. The versions keep every input the webhook trigger has had, so a secret pasted into its input stays in an earlier version after you edit it out: rotate it. Whoever can read the webhook trigger can read its versions.",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': {
        description: 'Page of versions, newest first.',
        schema: ref('WebhookTriggerVersionPage'),
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No webhook trigger with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhooks/:triggerId/versions/:version',
    openapiPath: '/v1/webhooks/{triggerId}/versions/{version}',
    operationId: 'webhooks.getVersion',
    summary: 'Fetch one version of a webhook trigger',
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, TriggerVersionPathParam],
    responses: {
      '200': { description: 'The version.', schema: ref('WebhookTriggerVersion') },
      '400': ErrorResponse("`version` isn't a positive integer (`bad-input`, `details.field`)."),
      ...CommonAuthErrors,
      '404': ErrorResponse(
        'No webhook trigger with that id (`trigger-not-found`), or it has no version with that number (`trigger-version-not-found`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhooks/:triggerId/owner',
    openapiPath: '/v1/webhooks/{triggerId}/owner',
    operationId: 'webhooks.takeOwnership',
    summary: 'Take over a webhook trigger',
    description:
      "The caller becomes the trigger's owner, so its runs act as the caller from the next delivery. Needs `admin` on the trigger's project (without an authorization store, a tenant-admin key) and `execute` on its flow. For a trigger whose owner left or lost access, or to make one shared or personal. It's the one way a trigger's owner changes, audited as `trigger-owner-set`, naming the trigger's version after it; a person it's taken from is told, where the server tells owners. Name `runAsServiceAccountId` instead to make a service account the owner: that needs `act_as` on the account (a tenant admin's), and the account must itself hold `execute` on the flow. With an authorization store, that's checked when the account is named: an account that can't is refused (`409 trigger-owner-cannot-run-target`). Or name `runAsProject: true` to make the project's own service account the owner, made the first time with the `editor` role on the project, so the trigger is shared and runs as the project. It runs only what the project's editors can, and is checked the same way. The trigger keeps its `toolsAllowedUnattended`, now for the new owner's runs; a body naming it is refused (change it with PATCH).",
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('TakeTriggerOwnerBody') },
    responses: {
      '200': {
        description: 'The trigger, with its new owner.',
        schema: ref('WebhookTriggerRecord'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'A malformed body, or `runAsProject` with `runAsServiceAccountId`, or a body naming `toolsAllowedUnattended` (`bad-input`).',
      ),
      '403': ErrorResponse(
        "`permission-denied`: not an admin of the trigger's project, or no `execute` on its flow, or no `act_as` on the account named.",
      ),
      '404': ErrorResponse('No webhook trigger with that id, or no such service account.'),
      '409': ErrorResponse(
        "`runAsServiceAccountId` names an unregistered account (`service-account-unregistered`), a project's own account (`service-account-project-owned`: name it with `runAsProject`), or one that can't run the flow (`trigger-owner-cannot-run-target`). Or, with `runAsProject`, the project's own account can't run the flow either (`trigger-owner-cannot-run-target`; the account stays, for the next `runAsProject`), or an active account someone made already has the project account's name, `project-<projectId>` (`service-account-name-taken`: a tenant admin can unregister it). Or an idempotency conflict.",
      ),
      '501': ErrorResponse(
        "`trigger-operation-unsupported`: this deployment can't change a trigger's owner, or can't make a project's own account (`runAsProject`).",
      ),
    },
  },
  // ---------- mail triggers (trigger surface) ----------
  {
    method: 'post',
    honoPath: '/v1/mail-triggers',
    openapiPath: '/v1/mail-triggers',
    operationId: 'mailTriggers.register',
    summary: 'Register a mail trigger',
    description:
      "Each new mail in the mailbox's folder starts a run of the trigger's agent or flow, with the mail as the run's input, as the trigger's owner. A trigger on a person's mailbox (`config.mailbox.as: person`) reads the caller's own mail through their connection, so the caller owns it: it needs `write` on the project, and a service account can't own it. One on the company's mailbox (`company`) reads it through the company's connection and needs `admin` on the project; `runAsServiceAccountId` makes it shared, owned by that service account (which needs `act_as` on it), and `runAsProject` makes it shared, owned by the project's own account (made the first time, with the `editor` role on the project). Both need `execute` on what it runs. A trigger that names no `projectId` goes in the tenant's Default project. In its runs, every call that changes something, or uses the run's own mailbox, waits for a person's yes, unless `toolsAllowedUnattended` names it: naming it takes `admin` on the project, each id must be a tool the target calls, and it's audited (`trigger-tools-allowed-unattended-set`).",
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterMailTriggerBody') },
    responses: {
      '201': { description: 'Mail trigger registered.', schema: ref('MailTriggerRecord') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "A body that fails validation (`bad-input`): no target or two, a `config` with anything but `mailbox`, `folder`, `pollSeconds` and `runsPerHour`, a service account named or calling or `runAsProject` for a person's mailbox, or `runAsProject` with `runAsServiceAccountId` or with no project. Or `reference-out-of-scope`: what it runs isn't the project's to reach (`details.issues`, at `/target`), and nothing is registered.",
      ),
      '409': ErrorResponse(
        "`runAsServiceAccountId` names an unregistered account (`service-account-unregistered`), a project's own account (`service-account-project-owned`: name it with `runAsProject`), or one that can't run what the trigger runs (`trigger-owner-cannot-run-target`). Or, with `runAsProject`, the project's own account can't run what the trigger runs either (`trigger-owner-cannot-run-target`; the account stays, for the next `runAsProject`), or an active account someone made already has the project account's name, `project-<projectId>` (`service-account-name-taken`: a tenant admin can unregister it). Or the Idempotency-Key was reused with a different body, or a resource-state conflict.",
      ),
      '501': ErrorResponse(
        "`trigger-operation-unsupported`: `runAsProject` on a runtime that can't make a project's own account.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/mail-triggers',
    openapiPath: '/v1/mail-triggers',
    operationId: 'mailTriggers.list',
    summary: 'List mail triggers',
    description:
      "The tenant's mail triggers whose project the caller may read; with `projectId`, that project's only (which needs `read` on it).",
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      TriggerStatusFilterQueryParam,
      {
        name: 'projectId',
        in: 'query',
        required: false,
        description: "Only this project's mail triggers.",
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    responses: {
      '200': { description: 'Page of mail triggers.', schema: ref('MailTriggerCollectionPage') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/mail-triggers/:triggerId',
    openapiPath: '/v1/mail-triggers/{triggerId}',
    operationId: 'mailTriggers.get',
    summary: 'Fetch a mail trigger',
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam],
    responses: {
      '200': { description: 'Mail trigger record.', schema: ref('MailTriggerRecord') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No mail trigger with that id, or the row was tombstoned.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/mail-triggers/:triggerId',
    openapiPath: '/v1/mail-triggers/{triggerId}',
    operationId: 'mailTriggers.update',
    summary: 'Update a mail trigger',
    description:
      "Changes what it runs (which needs `execute` on the new target, and must be the project's to reach), its mailbox (replaced whole), folder, pace or label (`null` clears it). To watch the inbox again, name it as the folder: `INBOX` on Gmail, `inbox` on Outlook. No edit moves the owner: a personal trigger's change is its owner's (who needs `write` on the project) or a project admin's, a shared one's is a project admin's, and the company's mailbox, before or after, takes a project admin. Only a personal trigger's owner chooses what it reads from a person's mailbox, another of their mailboxes or another folder: anyone else, a project admin included, gets a `403`, and may take the trigger over to watch their own. A project admin's other changes to a person's trigger, such as what it runs, its pace or a move to the company's mailbox, keep its owner, so its runs go on acting as that person, and they're audited as `trigger-changed-for-owner`, naming the trigger's version after each. Since no edit moves the owner, with an authorization store a new target (another flow or agent) must be one the owner can run, a person or a service account, else `409 trigger-owner-cannot-run-target`; that's not checked when the caller is the owner, nor for an owner that was unregistered or removed. `toolsAllowedUnattended` replaces the list (`[]` clears it; absent keeps it, a new version too), and a new target or mailbox while it lists any must name it again. Naming a list takes `admin` on the project; a personal trigger's owner may name `[]` with their own new target or mailbox.",
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PatchMailTriggerBody') },
    responses: {
      '200': { description: 'Updated mail trigger.', schema: ref('MailTriggerRecord') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "A body that fails validation (`bad-input`): `runAsServiceAccountId` or `runAsProject` (the owner changes only by `POST …/owner`), a person's mailbox for a shared trigger, or a new target or mailbox without the list it holds. Or `reference-out-of-scope`: the new target isn't the project's to reach. Nothing changes.",
      ),
      '404': ErrorResponse('No mail trigger with that id.'),
      '409': ErrorResponse(
        "A new target the trigger's owner can't run (`trigger-owner-cannot-run-target`), with an authorization store. Or an Idempotency-Key reused with a different body.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/mail-triggers/:triggerId/pause',
    openapiPath: '/v1/mail-triggers/{triggerId}/pause',
    operationId: 'mailTriggers.pause',
    summary: 'Pause a mail trigger',
    description:
      "A paused trigger doesn't poll. A personal trigger's pause is its owner's or a project admin's; a shared one's needs `write` on the project.",
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Paused mail trigger.', schema: ref('MailTriggerRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No mail trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/mail-triggers/:triggerId/resume',
    openapiPath: '/v1/mail-triggers/{triggerId}/resume',
    operationId: 'mailTriggers.resume',
    summary: 'Resume a mail trigger',
    description:
      "It starts afresh: mail that came while it was paused doesn't start runs. Who may resume it is as for a pause.",
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Resumed mail trigger.', schema: ref('MailTriggerRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No mail trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/mail-triggers/:triggerId/unregister',
    openapiPath: '/v1/mail-triggers/{triggerId}/unregister',
    operationId: 'mailTriggers.unregister',
    summary: 'Soft-delete a mail trigger (tombstone)',
    description: 'Who may unregister it is as for a pause.',
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Tombstone outcome.', schema: ref('WebhookTriggerUnregisterResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No mail trigger with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/mail-triggers/:triggerId/fires',
    openapiPath: '/v1/mail-triggers/{triggerId}/fires',
    operationId: 'mailTriggers.fires',
    summary: "A mail trigger's mail",
    description:
      'Newest first: each mail the trigger found and what came of it (`MailFire`): the run it started, why it waits (`thread-busy:`), or why it was skipped, refused or failed.',
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: "Page of the trigger's mail.", schema: ref('MailFirePage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No mail trigger with that id.'),
      '501': ErrorResponse(
        '`trigger-operation-unsupported`: this deployment keeps no fire history.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/mail-triggers/:triggerId/versions',
    openapiPath: '/v1/mail-triggers/{triggerId}/versions',
    operationId: 'mailTriggers.listVersions',
    summary: "A mail trigger's versions",
    description:
      "Newest first: each version of the mail trigger, what it was from `createdAt` on, who made it (`createdBy`) and why (`cause`). Registering makes version 1, and each change makes the next (a PATCH that alters it, or a take-over to another owner): a PATCH that changes nothing makes none, nor do pausing, resuming or deleting. A version never changes once made. A new mail's run uses the newest when it starts, and keeps it whatever later edits make (the run's `trigger.version`). A mail trigger from before versions has none until its next change or its next look at the mailbox. Whoever can read the mail trigger can read its versions.",
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': {
        description: 'Page of versions, newest first.',
        schema: ref('MailTriggerVersionPage'),
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No mail trigger with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/mail-triggers/:triggerId/versions/:version',
    openapiPath: '/v1/mail-triggers/{triggerId}/versions/{version}',
    operationId: 'mailTriggers.getVersion',
    summary: 'Fetch one version of a mail trigger',
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, TriggerVersionPathParam],
    responses: {
      '200': { description: 'The version.', schema: ref('MailTriggerVersion') },
      '400': ErrorResponse("`version` isn't a positive integer (`bad-input`, `details.field`)."),
      ...CommonAuthErrors,
      '404': ErrorResponse(
        'No mail trigger with that id (`trigger-not-found`), or it has no version with that number (`trigger-version-not-found`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/mail-triggers/:triggerId/owner',
    openapiPath: '/v1/mail-triggers/{triggerId}/owner',
    operationId: 'mailTriggers.takeOwnership',
    summary: 'Take over a mail trigger',
    description:
      "The only way a mail trigger's owner changes. The caller becomes it, so its runs act as the caller, with the caller's connections, from the next poll; on a person's mailbox, the mailbox becomes the caller's own, and the next poll starts afresh. Needs `admin` on the trigger's project and `execute` on its target. On the company's mailbox, name `runAsServiceAccountId` instead to make a service account the owner: that needs `act_as` on the account, and the account must itself hold what its target needs. With an authorization store, that's checked when the account is named: an account that can't is refused (`409 trigger-owner-cannot-run-target`). Or name `runAsProject: true` to make the project's own service account the owner, made the first time with the `editor` role on the project. It runs only what the project's editors can, and is checked the same way. The trigger keeps its `toolsAllowedUnattended`; a body naming it is refused (change it with PATCH).",
    tags: ['mail-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('TakeTriggerOwnerBody') },
    responses: {
      '200': { description: 'The trigger, with its new owner.', schema: ref('MailTriggerRecord') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "`bad-input`: a body naming `toolsAllowedUnattended`, a service account or `runAsProject` for a person's mailbox, or `runAsProject` with `runAsServiceAccountId`.",
      ),
      '404': ErrorResponse('No mail trigger with that id, or no such service account.'),
      '409': ErrorResponse(
        "`runAsServiceAccountId` names an unregistered account (`service-account-unregistered`), a project's own account (`service-account-project-owned`: name it with `runAsProject`), or one that can't run what the trigger runs (`trigger-owner-cannot-run-target`). Or, with `runAsProject`, the project's own account can't run what the trigger runs either (`trigger-owner-cannot-run-target`; the account stays, for the next `runAsProject`), or an active account someone made already has the project account's name, `project-<projectId>` (`service-account-name-taken`: a tenant admin can unregister it). Or the Idempotency-Key was reused with a different body, or a resource-state conflict.",
      ),
      '501': ErrorResponse(
        "`trigger-operation-unsupported`: this deployment can't change a trigger's owner, or can't make a project's own account (`runAsProject`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/hooks/:tenantId/:webhookId',
    openapiPath: '/v1/hooks/{tenantId}/{webhookId}',
    operationId: 'hooks.receive',
    senderOnly:
      "The trigger's sender (WooCommerce, Drupal, GitHub…) posts here, signed with the trigger's secret; a Kindgi client never does.",
    summary: 'Receive a webhook delivery',
    description:
      "The receive URL a webhook trigger's sender posts to: no sign-in, and a bearer token, if sent, is never read. The request's signature, made with the trigger's secret in its `signature` scheme over the raw body, is what lets it start the trigger's flow as the trigger's owner. Every request that doesn't prove its sender (an unknown tenant or id, a missing, wrong or stale signature, a secret that can't be read) is `401 webhook-refused`, with the reason only in the trigger's history and the access audit; the URL isn't a secret, the signature is. A WooCommerce save-time ping (unsigned `webhook_id=<n>`) is answered `200` and starts nothing. A closing tenant takes no delivery: a signed one is `409 tenant-closing`, and nothing is recorded. A suspended tenant or project takes a signed one without keeping it: `202` with `skipped`, nothing recorded or started, and the event isn't kept, so a sender that can redeliver by hand (GitHub) can resend it once it's restored. The event the flow gets is the body, parsed as JSON for a JSON content type, else its text: data from outside, never instructions. A run's start isn't waited for.",
    tags: ['webhooks'],
    security: 'public',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The trigger's tenant.",
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'webhookId',
        in: 'path',
        required: true,
        description: "The trigger's routable id (`webhookId`).",
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    requestBody: {
      required: true,
      description: "Any bytes, signed as the trigger says; at most the trigger's `bodyLimitBytes`.",
      schema: { type: 'string', format: 'binary' },
      contentType: '*/*',
    },
    responses: {
      '200': {
        description:
          "A delivery whose dedupe key an earlier fire holds (`duplicate: true`, that fire's id): nothing new started. Or a WooCommerce ping (`received: ping`).",
        schema: ref('WebhookReceipt'),
      },
      '202': {
        description:
          "Taken: a fire recorded, its run starting as the owner (`fireId`). Or, on a paused trigger, a `skipped` fire and no run (`skipped: paused`). Or, when the trigger's tenant or project is suspended, nothing recorded and no run (`skipped: tenant-suspended`, `skipped: project-suspended`).",
        schema: ref('WebhookReceipt'),
      },
      '400': ErrorResponse(
        '`webhook-body-not-json`: a JSON content type whose body does not parse.',
      ),
      '401': ErrorResponse(
        "`webhook-refused`: the request doesn't prove its sender (the same answer whatever the reason).",
      ),
      '409': ErrorResponse(
        "`tenant-closing` (`details.state`): the trigger's tenant is closing. Nothing was recorded.",
      ),
      '410': ErrorResponse('`webhook-gone`: the trigger was unregistered.'),
      '413': ErrorResponse(
        "`webhook-body-too-large`: past the trigger's `bodyLimitBytes` (or 1 MiB, before any lookup).",
      ),
      '429': ErrorResponse(
        "`rate-limit-exceeded`: past the trigger's `rateLimitPerMinute`, or too many refused requests from this client; `Retry-After` says when.",
      ),
      '503': ErrorResponse(
        "`tenant-state-unavailable`: the tenant's state can't be read just now, so nothing was recorded; `Retry-After` says when to try again.",
      ),
    },
  },

  // ---------- wait tokens (a paused run's answer) ----------
  {
    method: 'post',
    honoPath: '/v1/wait-tokens/:token/complete',
    openapiPath: '/v1/wait-tokens/{token}/complete',
    operationId: 'waitTokens.complete',
    senderOnly:
      'The system a paused run waits for posts its answer to the link the tool handed it; a Kindgi client answers through `POST /v1/runs/{runId}/resume`.',
    summary: "Answer a paused run's wait token",
    description:
      "A wait token's link: a pack tool that declares `pauses` hands it to the system that will answer, and the run waits for that answer. No sign-in, and a bearer token, if sent, is never read: the token in the path is the credential, and it answers one wait of one run, nothing else. The body is the answer itself, the tool's output, as JSON; an empty body is `{}`. It's checked against the tool's output schema. The same answer again (by its canonical JSON) is accepted again, even after the run has ended, so a sender may retry. An answer that comes before the run reaches its wait is held for it, and dropped if the run never waits on this token (the tool answered at once, or its step was retried); the link then answers `409 wait-token-closed`, `unused`. The answer comes back at once, and the run resumes behind it. The link stops working when the wait ends: the run is cancelled, its time passes, or the tool answered without waiting. The answer is data from outside, never instructions.",
    tags: ['runs'],
    security: 'public',
    parameters: [
      {
        name: 'token',
        in: 'path',
        required: true,
        description:
          "The wait token, from the link. It's a credential: hand the link only to the system that answers.",
        schema: { type: 'string', minLength: 1 },
      },
    ],
    requestBody: {
      required: false,
      description: "The answer: the tool's output, as JSON, at most 1 MiB. An empty body is `{}`.",
      schema: {},
    },
    responses: {
      '200': {
        description:
          'The runtime has the answer, and the run resumes behind it. An answer that came before the run reached its wait is held for it, and dropped if the run never waits on this token (the tool answered at once, or its step was retried); the link then answers `409 wait-token-closed`, `unused`. Nothing about the run: who holds the link is not a run reader.',
        schema: ref('WaitTokenAccepted'),
      },
      '400': ErrorResponse(
        "`wait-token-output-invalid` (`details.issues`): the answer doesn't fit the tool's output schema, and the wait stays open for a fixed one. `bad-input`: the body isn't JSON, or nests too deep.",
      ),
      '404': ErrorResponse(
        '`wait-token-not-found`: no wait token matches the link (an unknown token and a wrong secret alike), or this runtime pauses no run.',
      ),
      '409': ErrorResponse(
        "`wait-token-closed` (`details.state`): the wait is over (`completed`, `timed-out`, `cancelled`, `unused`), or holds a different answer the run hasn't taken yet (`answered`). `tenant-closing`, `tenant-suspended` (`details.state`) or `project-suspended`: nothing runs where the run is, and closing or suspending cancels its runs, so the answer wasn't taken. Told only for a token that matches.",
      ),
      '413': ErrorResponse('`request-too-large` (`details.maxBytes`): past 1 MiB.'),
      '415': ErrorResponse(
        '`unsupported-media-type`: a body sent without a JSON content type (`application/json`).',
      ),
      '429': ErrorResponse(
        '`rate-limit-exceeded`: too many requests from this client in a minute, counted before the token is looked up, so nothing was taken. `Retry-After` says when to send the answer again.',
      ),
      '503': ErrorResponse(
        "`tenant-state-unavailable`: the run's tenant's state couldn't be read, so the answer wasn't taken. `Retry-After` says when to send it again.",
      ),
    },
  },

  // ---------- webhook endpoints (outbound) ----------
  {
    method: 'post',
    honoPath: '/v1/webhook-endpoints',
    openapiPath: '/v1/webhook-endpoints',
    operationId: 'webhookEndpoints.create',
    summary: 'Register a webhook endpoint',
    description:
      'Registers a URL the platform sends signed events to. The signing secret is shared with the receiver, so it lives in your secrets (`.env` in development, the secrets store in production) and the endpoint references it by name (`secretRef`). Store it first; `POST /v1/webhook-endpoints/generate-secret` makes a strong one. Deliveries are signed in the Standard Webhooks format (`webhook-id`, `webhook-timestamp`, `webhook-signature`); verify with `verifyWebhook` from `@kindgi/crypto` or any Standard Webhooks library. The event bodies are described under `webhooks` in this document.',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateWebhookEndpointBody') },
    responses: {
      '201': { description: 'Endpoint registered.', schema: ref('WebhookEndpoint') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '400': ErrorResponse(
        "Malformed body or unknown field; the deployment refuses the URL (`webhook-url-refused`); the referenced secret does not exist (`webhook-secret-not-found`) or is too weak (`webhook-secret-too-weak`), it's a model provider's key (`provider-key-refused`), or it's under the reserved `kindgi.` prefix (`reserved-name-prefix`).",
      ),
      '404': ErrorResponse('`filter.projectId` names no project (`project-not-found`).'),
      '409': conflictOrEnvNotServed(ENV_NOT_SERVED_REFERENCE),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhook-endpoints/generate-secret',
    openapiPath: '/v1/webhook-endpoints/generate-secret',
    operationId: 'webhookEndpoints.generateSecret',
    summary: 'Generate a webhook signing secret',
    description:
      'Returns a new strong secret (`whsec_` + base64 of 32 random bytes). Nothing is stored: put it in your secrets, then register the endpoint with its name. Sent with an `Idempotency-Key`, a retry gets `409 idempotency-key-replay-withheld`, not the secret again.',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    responses: {
      '200': { description: 'A new secret.', schema: ref('GeneratedWebhookSecret') },
      ...CommonAuthErrors,
      ...TenantAdminErrors,
      '409': ErrorResponse(
        "A retry with the Idempotency-Key of a request that succeeded: the secret isn't kept (`idempotency-key-replay-withheld`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhook-endpoints',
    openapiPath: '/v1/webhook-endpoints',
    operationId: 'webhookEndpoints.list',
    summary: 'List webhook endpoints',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of endpoints.', schema: ref('WebhookEndpointCollectionPage') },
      ...CommonAuthErrors,
      ...TenantAdminErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhook-endpoints/:endpointId',
    openapiPath: '/v1/webhook-endpoints/{endpointId}',
    operationId: 'webhookEndpoints.get',
    summary: 'Fetch a webhook endpoint',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    parameters: [WebhookEndpointIdPathParam],
    responses: {
      '200': { description: 'The endpoint.', schema: ref('WebhookEndpoint') },
      ...CommonAuthErrors,
      ...TenantAdminErrors,
      '404': ErrorResponse('No endpoint with that id, or it was unregistered.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/webhook-endpoints/:endpointId',
    openapiPath: '/v1/webhook-endpoints/{endpointId}',
    operationId: 'webhookEndpoints.update',
    summary: 'Update a webhook endpoint',
    description:
      'To rotate the signing secret, rotate the secret in your secrets store (`POST /v1/secrets/{name}/rotate`); point `secretRef` at another secret to switch.',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    parameters: [WebhookEndpointIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PatchWebhookEndpointBody') },
    responses: {
      '200': { description: 'The updated endpoint.', schema: ref('WebhookEndpoint') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '400': ErrorResponse(
        "Malformed body or unknown field; the deployment refuses the URL (`webhook-url-refused`); the referenced secret does not exist or is too weak, it's a model provider's key (`provider-key-refused`), or it's under the reserved `kindgi.` prefix (`reserved-name-prefix`).",
      ),
      '404': ErrorResponse('No endpoint with that id, or `filter.projectId` names no project.'),
      '409': conflictOrEnvNotServed(ENV_NOT_SERVED_REFERENCE),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhook-endpoints/:endpointId/unregister',
    openapiPath: '/v1/webhook-endpoints/{endpointId}/unregister',
    operationId: 'webhookEndpoints.unregister',
    summary: 'Unregister a webhook endpoint (soft delete)',
    description:
      'The endpoint stops receiving events; its pending deliveries are abandoned (`failed`). Idempotent.',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    parameters: [WebhookEndpointIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Outcome.', schema: ref('WebhookEndpointUnregisterResult') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhook-endpoints/:endpointId/deliveries',
    openapiPath: '/v1/webhook-endpoints/{endpointId}/deliveries',
    operationId: 'webhookEndpoints.listDeliveries',
    summary: "List a webhook endpoint's deliveries",
    description: 'Newest first. Each delivery carries the event it delivers.',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    parameters: [
      WebhookEndpointIdPathParam,
      WebhookDeliveryStatusQueryParam,
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': { description: 'Page of deliveries.', schema: ref('WebhookDeliveryCollectionPage') },
      ...CommonAuthErrors,
      ...TenantAdminErrors,
      '400': ErrorResponse('Unknown `status`.'),
      '404': ErrorResponse('No endpoint with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhook-endpoints/:endpointId/deliveries/:deliveryId/redeliver',
    openapiPath: '/v1/webhook-endpoints/{endpointId}/deliveries/{deliveryId}/redeliver',
    operationId: 'webhookEndpoints.redeliver',
    summary: 'Redeliver an event',
    description: 'Queues the delivery again now, whatever its status; its attempts start over.',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    parameters: [WebhookEndpointIdPathParam, WebhookDeliveryIdPathParam, IdempotencyKeyParam],
    responses: {
      '202': { description: 'Queued.', schema: ref('WebhookDelivery') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '404': ErrorResponse('No endpoint, or no delivery with that id for it.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhook-endpoints/:endpointId/test',
    openapiPath: '/v1/webhook-endpoints/{endpointId}/test',
    operationId: 'webhookEndpoints.sendTest',
    summary: 'Send a test event to a webhook endpoint',
    description:
      'Queues a `webhook.test` event, signed like any other, to check the receiver end to end. Follow it in the delivery log.',
    tags: ['webhook-endpoints'],
    security: 'bearer',
    parameters: [WebhookEndpointIdPathParam, IdempotencyKeyParam],
    responses: {
      '202': { description: 'Queued.', schema: ref('WebhookDelivery') },
      ...CommonMutationErrors,
      ...TenantAdminErrors,
      '404': ErrorResponse('No endpoint with that id.'),
    },
  },
  // ---------- connections (accounts at other apps that tools act with) ----------
  {
    method: 'get',
    honoPath: '/v1/connection-entries',
    openapiPath: '/v1/connection-entries',
    operationId: 'connectionEntries.list',
    summary: 'List the apps this server can connect to',
    description:
      'Each app with who may own a connection to it, how a person signs in, the permissions a tool may ask for (in plain words, and whether each changes anything) and the guide an admin follows to register the app. Any signed-in member. Mounted when the deployment supplies a `ConnectionBinding`.',
    tags: ['connections'],
    security: 'bearer',
    responses: {
      '200': { description: 'The apps.', schema: ref('ConnectionEntryList') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/connection-apps',
    openapiPath: '/v1/connection-apps',
    operationId: 'connectionApps.list',
    summary: "List the tenant's app registrations",
    description:
      "The tenant's own registrations of its client at an app: its client id, and its secrets by reference. Tenant admins only. Removed registrations are listed only with `includeRemoved=true`.",
    tags: ['connections'],
    security: 'bearer',
    parameters: [
      {
        name: 'includeRemoved',
        in: 'query',
        required: false,
        description: '`true` lists removed registrations too.',
        schema: { type: 'boolean', default: false },
      },
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': { description: 'Page of registrations.', schema: ref('ConnectionAppPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('An `includeRemoved` other than `true` or `false` (`bad-input`).'),
      '403': ErrorResponse('Not a tenant admin (`permission-denied`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/connection-apps',
    openapiPath: '/v1/connection-apps',
    operationId: 'connectionApps.create',
    summary: 'Register an app',
    description:
      "Registers the tenant's own client at an app. Store its secrets first; the registration references them by name. The response gives the `redirectUrl` and `noticesUrl` to enter at the app. Tenant admins only.",
    tags: ['connections'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateConnectionAppBody') },
    responses: {
      '201': { description: 'App registered.', schema: ref('ConnectionApp') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed body or unknown field (`bad-input`, `details.field`); a registration that doesn't fit its entry, or that would serve a project another registration of the app serves (`connection-app-invalid`, `details.field`); no such app (`connection-app-unknown-entry`); a model provider's key named as a secret (`provider-key-refused`); or a secret under the reserved `kindgi.` prefix (`reserved-name-prefix`).",
      ),
      '403': ErrorResponse('Not a tenant admin (`permission-denied`).'),
      '409': conflictOrEnvNotServed(ENV_NOT_SERVED_REFERENCE),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/connection-apps/:appId',
    openapiPath: '/v1/connection-apps/{appId}',
    operationId: 'connectionApps.get',
    summary: 'Fetch an app registration',
    tags: ['connections'],
    security: 'bearer',
    parameters: [ConnectionAppIdPathParam],
    responses: {
      '200': { description: 'The registration.', schema: ref('ConnectionApp') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`appId` is not a UUID (`bad-input`).'),
      '403': ErrorResponse('Not a tenant admin (`permission-denied`).'),
      '404': ErrorResponse('No registration with that id (`connection-app-not-found`).'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/connection-apps/:appId',
    openapiPath: '/v1/connection-apps/{appId}',
    operationId: 'connectionApps.update',
    summary: 'Update an app registration',
    description:
      'Changes the label, the client or the projects that may use its connections. The app itself cannot change: register the other app on its own. Tenant admins only.',
    tags: ['connections'],
    security: 'bearer',
    parameters: [ConnectionAppIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('UpdateConnectionAppBody') },
    responses: {
      '200': { description: 'The updated registration.', schema: ref('ConnectionApp') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed body, unknown field or an `app` (`bad-input`, `details.field`); a registration that doesn't fit its entry, that would serve a project another registration of the app serves, or a change of its client (`oauth2.clientId`, `oauth2.tenant`, `githubApp.appNumber` or `githubApp.clientId`) while it has live connections: disconnect them first (`connection-app-invalid`, `details.field`); a model provider's key named as a secret (`provider-key-refused`); or a secret under the reserved `kindgi.` prefix (`reserved-name-prefix`).",
      ),
      '403': ErrorResponse('Not a tenant admin (`permission-denied`).'),
      '404': ErrorResponse('No registration with that id (`connection-app-not-found`).'),
      '409': conflictOrEnvNotServed(ENV_NOT_SERVED_REFERENCE),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/connection-apps/:appId',
    openapiPath: '/v1/connection-apps/{appId}',
    operationId: 'connectionApps.remove',
    summary: 'Remove an app registration',
    description:
      'Without `withConnections=true`, a registration that still has live connections is refused (`connection-app-in-use`). With it, those connections are removed too. Tenant admins only.',
    tags: ['connections'],
    security: 'bearer',
    parameters: [
      ConnectionAppIdPathParam,
      {
        name: 'withConnections',
        in: 'query',
        required: false,
        description: 'Remove its live connections too. Default `false`.',
        schema: { type: 'boolean', default: false },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': { description: 'Removed.', schema: ref('ConnectionAppRemoved') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        '`appId` is not a UUID, or `withConnections` is not a boolean (`bad-input`).',
      ),
      '403': ErrorResponse('Not a tenant admin (`permission-denied`).'),
      '404': ErrorResponse('No registration with that id (`connection-app-not-found`).'),
      '409': ErrorResponse(
        'Idempotency-Key was reused with a different body, or the registration still has live connections (`connection-app-in-use`).',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/connections',
    openapiPath: '/v1/connections',
    operationId: 'connections.list',
    summary: 'List connections',
    description:
      'A member sees their own; a tenant admin sees every one, unless `owner=me`. Removed connections are listed only with `state=removed`, or with the others under `includeRemoved=true`.',
    tags: ['connections'],
    security: 'bearer',
    parameters: [
      {
        name: 'projectId',
        in: 'query',
        required: false,
        description: 'Only those whose registration allows this project.',
        schema: { type: 'string' },
      },
      {
        name: 'app',
        in: 'query',
        required: false,
        description: "Only this app's (its entry id).",
        schema: { type: 'string' },
      },
      {
        name: 'owner',
        in: 'query',
        required: false,
        description: "`me`: only the caller's own, even for a tenant admin.",
        schema: { type: 'string', enum: ['me'] },
      },
      {
        name: 'ownerKind',
        in: 'query',
        required: false,
        description: "Only those a member owns, or only the company's.",
        schema: { type: 'string', enum: ['member', 'company'] },
      },
      {
        name: 'state',
        in: 'query',
        required: false,
        description: 'Only those in this state.',
        schema: { $ref: '#/components/schemas/ConnectionState' },
      },
      {
        name: 'includeRemoved',
        in: 'query',
        required: false,
        description: '`true` lists removed connections too.',
        schema: { type: 'boolean', default: false },
      },
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': { description: 'Page of connections.', schema: ref('ConnectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse(
        'An unknown `app`, `owner`, `ownerKind` or `state`, or an `includeRemoved` other than `true` or `false` (`bad-input`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/connections',
    openapiPath: '/v1/connections',
    operationId: 'connections.connect',
    summary: 'Start a connect',
    description:
      "Makes a connect request for the caller's own account (`for: 'me'`, the default; signed in as a person) or the company's (`for: 'company'`; a tenant admin only). Send the person to the request's `connectUrl`, or call `POST /v1/connections/requests/{requestId}/start` for the app's consent page. A run that needs a connection it lacks makes its own request and waits for it (`waitingFor.connections` on the run).",
    tags: ['connections'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateConnectRequestBody') },
    responses: {
      '201': { description: 'Connect request made.', schema: ref('ConnectRequest') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed body or unknown field (`bad-input`, `details.field`); `for: 'me'` from a credential that is not a person (`bad-input`); or no registration that fits (`connection-app-invalid`, `connection-app-unknown-entry`).",
      ),
      '403': ErrorResponse(
        "`for: 'company'` from a caller who is not a tenant admin (`permission-denied`).",
      ),
      '404': ErrorResponse('No registration with that `appId` (`connection-app-not-found`).'),
      '409': ErrorResponse(
        'Idempotency-Key was reused with a different body; or the connection is still being disconnected: disconnect it again to finish, then connect (`connection-removing`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/connections/finish',
    openapiPath: '/v1/connections/finish',
    operationId: 'connections.finish',
    summary: 'Finish a connect',
    description:
      "Takes what the app sent back to the callback page (`state` and `code`, with `installationId` and `setupAction` from a GitHub App; or `error`). Only whoever started the request may finish it. Exchanges the code, learns the account, compares what was granted with what was asked and stores the connection; a run that waits goes on. A person who declined, or who granted less than asked, gets `kind: 'declined'` and the request's `missing` permissions. A GitHub App's attaches an installation only if the person's GitHub account reaches it: the one GitHub sent back, the one they picked at the start, or the only one they reach. When they reach several and picked none, it answers `kind: 'pick-installation'`: the request stays `pending` with its `installations` to pick from (start it again with `installationId`, or `newInstallation`).",
    tags: ['connections'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('FinishConnectBody') },
    responses: {
      '200': { description: 'The outcome.', schema: ref('ConnectFinish') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'Malformed body, unknown field or no `state`; or neither `code` nor `error` (`bad-input`, `details.field`).',
      ),
      '403': ErrorResponse(
        "Someone other than whoever started the request (`connection-not-yours`); or a GitHub App's person whose GitHub account doesn't reach the installation, or any (`connection-installation-unreachable`, with `details.connectRequestId`: start that request again with `newInstallation` to install the app on their account).",
      ),
      '404': ErrorResponse('No request for that state (`connection-request-not-found`).'),
      '409': ErrorResponse(
        'Idempotency-Key was reused with a different body; the request was finished already (`connection-request-used`); a reconnect signed in to another account (`connection-account-mismatch`); or the connection is still being disconnected: disconnect it again to finish, then connect (`connection-removing`).',
      ),
      '410': ErrorResponse(
        'The request expired (`connection-request-expired`), or the sign-in took longer than its state lives: start again (`connection-state-expired`).',
      ),
      '502': ErrorResponse(
        "The app wouldn't give a token for the code: its client id, secret or redirect URL (`connection-app-refused`).",
      ),
      '503': ErrorResponse(
        "The connection couldn't be stored just now (`connection-store-failed`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/connections/requests/:requestId',
    openapiPath: '/v1/connections/requests/{requestId}',
    operationId: 'connections.requests.get',
    summary: 'Fetch a connect request',
    description:
      "A member's request is the member's alone; the company's is a tenant admin's. Anyone else gets the `404` of a request that doesn't exist.",
    tags: ['connections'],
    security: 'bearer',
    parameters: [ConnectRequestIdPathParam],
    responses: {
      '200': { description: 'The request.', schema: ref('ConnectRequest') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`requestId` is not a UUID (`bad-input`).'),
      '404': ErrorResponse(
        "No request with that id, or not the caller's (`connection-request-not-found`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/connections/requests/:requestId/start',
    openapiPath: '/v1/connections/requests/{requestId}/start',
    operationId: 'connections.requests.start',
    summary: 'Start a connect request',
    description:
      "Makes a fresh sign-in state, good for 10 minutes, and returns the app's consent page to send the person to. Records who started it: only they may finish it. A repeat starts again and never gets the first answer back: with an `Idempotency-Key`, a retry gets `409 idempotency-key-replay-withheld`. A GitHub App's goes to the app's install page while the app has no installation, or with `newInstallation`; otherwise to GitHub's authorization, and the finish attaches the installation picked with `installationId`, one of the request's `installations`.",
    tags: ['connections'],
    security: 'bearer',
    parameters: [ConnectRequestIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('StartConnectBody') },
    responses: {
      '200': { description: 'Where to send the person.', schema: ref('ConnectStart') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        '`requestId` is not a UUID; a malformed body or unknown field; both `installationId` and `newInstallation`; or either on a request whose app is not a GitHub App (`bad-input`, `details.field`).',
      ),
      '404': ErrorResponse(
        "No request with that id, or not the caller's (`connection-request-not-found`).",
      ),
      '409': ErrorResponse(
        'Idempotency-Key was reused with a different body, or a retry of one that succeeded (`idempotency-key-replay-withheld`); or the request was finished already (`connection-request-used`).',
      ),
      '410': ErrorResponse('The request expired (`connection-request-expired`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/connections/:connectionId',
    openapiPath: '/v1/connections/{connectionId}',
    operationId: 'connections.get',
    summary: 'Fetch a connection',
    description:
      "A member's connection is its owner's or a tenant admin's. Anyone else gets the `404` of a connection that doesn't exist.",
    tags: ['connections'],
    security: 'bearer',
    parameters: [ConnectionIdPathParam],
    responses: {
      '200': { description: 'The connection.', schema: ref('Connection') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`connectionId` is not a UUID (`bad-input`).'),
      '404': ErrorResponse(
        "No connection with that id, or not the caller's (`connection-not-found`).",
      ),
    },
  },
  {
    method: 'delete',
    honoPath: '/v1/connections/:connectionId',
    openapiPath: '/v1/connections/{connectionId}',
    operationId: 'connections.disconnect',
    summary: 'Disconnect',
    description:
      'Withdraws access at the app where it can, destroys the token and removes the connection (`withdrawn` says what the app did). Its owner or a tenant admin. Repeating it on a connection still `removing` carries on from the withdrawal.',
    tags: ['connections'],
    security: 'bearer',
    parameters: [ConnectionIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'The connection, removed.', schema: ref('Connection') },
      ...CommonMutationErrors,
      '400': ErrorResponse('`connectionId` is not a UUID (`bad-input`).'),
      '404': ErrorResponse(
        "No connection with that id, or not the caller's (`connection-not-found`).",
      ),
      '503': ErrorResponse(
        "The removal couldn't be stored just now (`connection-store-failed`), or the `Idempotency-Key` store couldn't be read before the request ran (`idempotency-store-unavailable`, with `Retry-After`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/connection-notices/:tenantId/:appId',
    openapiPath: '/v1/connection-notices/{tenantId}/{appId}',
    operationId: 'connectionNotices.receive',
    senderOnly:
      'The app (GitHub, Google…) posts here, signed its own way; a Kindgi client never does.',
    summary: 'Receive an app notice',
    description:
      "Where an app reports a removal (an uninstall, a revoke at the app): the registration's `noticesUrl`. No sign-in, and a bearer token, if sent, is never read. The app's own signature over the body's exact bytes is what the server checks: a JSON webhook from GitHub, or a security event token from Google. Every notice not accepted (an unknown tenant or id, a bad signature, a body over the cap) is the same `400 connection-notice-invalid`. A client past its refusals this minute gets `429`. If the server couldn't check or apply the notice just now, `503 connection-notice-unavailable`: the app may send it again.",
    tags: ['connections'],
    security: 'public',
    parameters: [
      {
        name: 'tenantId',
        in: 'path',
        required: true,
        description: "The registration's tenant.",
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'appId',
        in: 'path',
        required: true,
        description: 'The registration id (`appId`).',
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    requestBody: {
      required: true,
      description:
        "The app's signed notice, any content type: a JSON webhook from GitHub, or a security event token from Google.",
      schema: { type: 'string', format: 'binary' },
      contentType: '*/*',
    },
    responses: {
      '202': { description: 'Accepted. No body.' },
      '400': ErrorResponse(
        '`connection-notice-invalid`: the notice was not accepted (the same answer whatever the reason).',
      ),
      '429': ErrorResponse(
        '`rate-limit-exceeded`: too many refused notices from this client; `Retry-After` says when.',
      ),
      '503': ErrorResponse(
        "`connection-notice-unavailable`: the notice couldn't be handled just now; the app may send it again.",
      ),
    },
  },
  // ---------- sites (a site signs its own people in to one project) ----------
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/sites',
    openapiPath: '/v1/projects/{projectId}/sites',
    operationId: 'projects.sites.list',
    summary: "List the project's sites",
    description:
      'The sites that sign their own people in to this project. Tenant admins only: a site creates people in the tenant. `includeUnregistered=true` lists unregistered ones too. Mounted when the deployment supplies a `SiteBinding`.',
    tags: ['sites'],
    security: 'bearer',
    parameters: [
      ProjectIdPathParam,
      LimitQueryParam,
      CursorQueryParam,
      {
        name: 'includeUnregistered',
        in: 'query',
        required: false,
        description: 'With `true`, unregistered sites too.',
        schema: { type: 'boolean' },
      },
    ],
    responses: {
      '200': { description: 'A page of sites.', schema: ref('SiteCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('`projectId` is not a project id (a UUID), or a malformed query.'),
      '403': ErrorResponse('Not a tenant admin.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/sites',
    openapiPath: '/v1/projects/{projectId}/sites',
    operationId: 'projects.sites.register',
    summary: 'Register a site',
    description:
      'A site that will sign its own people in to this project, and a one-time enrollment code for it, shown once: the site posts it with its public key (`POST /v1/auth/sites/enroll`). Until then it has no key and signs nobody in. A role map gives no reviewer role above `reviewerCeiling`, and names only `allowedRoles`; nothing it gives reaches above the project. Tenant admins only.',
    tags: ['sites'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterSiteBody') },
    responses: {
      '201': {
        description: 'The site, and its enrollment code.',
        schema: ref('RegisterSiteResult'),
      },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "A setting the site can't have (`site-invalid`, `details.field`): an origin that isn't https, an approvals URL on another origin, a role map above the ceiling or over a role that isn't allowed.",
      ),
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No project with that id (`project-not-found`).'),
      '409': ErrorResponse(
        "Idempotency-Key reused with a different body (`idempotency-key-body-mismatch`), or a retry of a request that succeeded: its answer carried a secret, which isn't kept (`idempotency-key-replay-withheld`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/sites/:siteId',
    openapiPath: '/v1/projects/{projectId}/sites/{siteId}',
    operationId: 'projects.sites.get',
    summary: 'Read a site',
    description: 'Its settings and its keys (ids and thumbprints only). Tenant admins only.',
    tags: ['sites'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, SiteIdPathParam],
    responses: {
      '200': { description: 'The site.', schema: ref('Site') },
      ...CommonAuthErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No site with that id in this project (`site-not-found`).'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/projects/:projectId/sites/:siteId',
    openapiPath: '/v1/projects/{projectId}/sites/{siteId}',
    operationId: 'projects.sites.update',
    summary: "Change a site's settings",
    description:
      "The settings given; the rest stay. A person's grants follow the new settings the next time the site signs them in. Tenant admins only.",
    tags: ['sites'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, SiteIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('UpdateSiteBody') },
    responses: {
      '200': { description: 'The site.', schema: ref('Site') },
      ...CommonMutationErrors,
      '400': ErrorResponse("A setting the site can't have (`site-invalid`, `details.field`)."),
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No site with that id in this project (`site-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/sites/:siteId/pause',
    openapiPath: '/v1/projects/{projectId}/sites/{siteId}/pause',
    operationId: 'projects.sites.pause',
    summary: "Stop a site's sign-ins",
    description:
      "The site's statements are refused until it's resumed, and its live sessions end now. Tenant admins only.",
    tags: ['sites'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, SiteIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'The site, paused.', schema: ref('Site') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No site with that id in this project (`site-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/sites/:siteId/resume',
    openapiPath: '/v1/projects/{projectId}/sites/{siteId}/resume',
    operationId: 'projects.sites.resume',
    summary: "Start a paused site's sign-ins again",
    description: 'Tenant admins only.',
    tags: ['sites'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, SiteIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'The site.', schema: ref('Site') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No site with that id in this project (`site-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/sites/:siteId/unregister',
    openapiPath: '/v1/projects/{projectId}/sites/{siteId}/unregister',
    operationId: 'projects.sites.unregister',
    summary: 'Unregister a site',
    description:
      'Tombstoned: its sign-ins stop and its live sessions end. The people it signed in stay, with their records. Tenant admins only.',
    tags: ['sites'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, SiteIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'The site, unregistered.', schema: ref('Site') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No site with that id in this project (`site-not-found`).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/sites/:siteId/enrollment-codes',
    openapiPath: '/v1/projects/{projectId}/sites/{siteId}/enrollment-codes',
    operationId: 'projects.sites.enrollmentCode',
    summary: 'A new enrollment code for a site',
    description:
      "How a site's key is replaced: the site posts a new key with this code, which replaces every key it had and ends its live sessions. An earlier unused code stops working. Shown once. Tenant admins only.",
    tags: ['sites'],
    security: 'bearer',
    parameters: [ProjectIdPathParam, SiteIdPathParam, IdempotencyKeyParam],
    responses: {
      '201': { description: 'The code.', schema: ref('SiteEnrollmentCode') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse('No site with that id in this project (`site-not-found`).'),
      '409': ErrorResponse(
        "A retry of a request that succeeded: its answer carried a secret, which isn't kept (`idempotency-key-replay-withheld`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/sites/:siteId/keys/:kid/revoke',
    openapiPath: '/v1/projects/{projectId}/sites/{siteId}/keys/{kid}/revoke',
    operationId: 'projects.sites.revokeKey',
    summary: "Revoke one of a site's keys",
    description:
      "Statements signed with it are refused from now on, and the site's live sessions end. Tenant admins only.",
    tags: ['sites'],
    security: 'bearer',
    parameters: [
      ProjectIdPathParam,
      SiteIdPathParam,
      {
        name: 'kid',
        in: 'path',
        required: true,
        description: "The key's id.",
        schema: { type: 'string' },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': { description: 'The site, without the key.', schema: ref('Site') },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse(
        'No site with that id in this project, or no key with that id (`site-not-found`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/projects/:projectId/sites/:siteId/people/:userId/restore',
    openapiPath: '/v1/projects/{projectId}/sites/{siteId}/people/{userId}/restore',
    operationId: 'projects.sites.restorePerson',
    summary: 'Let a person removed in Kindgi back in, through their site',
    description:
      "For one of the site's people removed in Kindgi (`POST /v1/identity/users/{userId}/unregister`) while the site still knows them: they're in the tenant again, the same person, with their history, and their next sign-in through the site is theirs again. Their grants come back with that sign-in, from the site's role map then; their API keys and sessions stay gone. Refused, with nothing changed (`409 site-person-restore-refused`, `details.reason`): `not-removed` for someone in the tenant whose site still knows them; `left` when their site said they left it, removed in Kindgi too or not: a site forgets a person who leaves, and signs them in as a new person if they come back; `linked-elsewhere` when they also sign in another way (through another site, or the tenant's own sign-in), which letting them back in would open too: add them again instead, as a new person. A paused site's people can be let back in; an unregistered site's can't. Tenant admins only. Mounted when the deployment's site binding can let people back in.",
    tags: ['sites'],
    security: 'bearer',
    parameters: [
      ProjectIdPathParam,
      SiteIdPathParam,
      {
        name: 'userId',
        in: 'path',
        required: true,
        description: "The person's id.",
        schema: { type: 'string', minLength: 1 },
      },
      IdempotencyKeyParam,
    ],
    responses: {
      '200': {
        description: 'The person, in the tenant again.',
        schema: ref('SitePersonRestoreResult'),
      },
      ...CommonMutationErrors,
      '403': ErrorResponse('Not a tenant admin.'),
      '404': ErrorResponse(
        'No site with that id in this project (`site-not-found`), or the site has no link to that person (`site-person-not-found`).',
      ),
      '409': ErrorResponse(
        'Refused, with nothing changed (`site-person-restore-refused`, `details.reason`: `not-removed`, `left` or `linked-elsewhere`), or an idempotency conflict.',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/sites/enroll',
    openapiPath: '/v1/auth/sites/enroll',
    operationId: 'auth.sites.enroll',
    summary: 'A site posts its public key with its enrollment code',
    description:
      "Public: the code is the credential. The site keeps its private key; Kindgi stores the public one, and answers the site's id (its statements' `iss`) and the audience (their `aud`). A wrong, used or expired code, or one for a paused or unregistered site, gets one answer: `401 site-enrollment-refused`. Failures are limited per client (`429 rate-limit-exceeded`, with `Retry-After`). The body is at most 4096 bytes.",
    tags: ['sites'],
    security: 'public',
    requestBody: { required: true, schema: ref('EnrollSiteBody') },
    responses: {
      '200': {
        description: "The site's id and its statements' audience.",
        schema: ref('EnrollSiteResult'),
      },
      '400': ErrorResponse(
        "A malformed body, or a public key that isn't an Ed25519 JWK with a `kid`, or has a private part (`site-key-invalid`); it's checked before the code.",
      ),
      '401': ErrorResponse('The code was refused (`site-enrollment-refused`).'),
      '413': ErrorResponse('The body is over 4096 bytes (`site-request-too-large`).'),
      '429': ErrorResponse('Too many failures from this client.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/site-sign-in',
    openapiPath: '/v1/auth/site-sign-in',
    operationId: 'auth.siteSignIn',
    summary: 'A site signs one of its people in',
    description:
      "Public: the statement is the credential. A registered site's statement that a person is signed in there, exchanged for a session limited to the site's project: it reads nothing above the project, mints no keys, isn't refreshed, and ends early when the site is paused or unregistered, or one of its keys revoked. The person is the one the site created for that `sub` (a first statement creates them; never matched by email), with the grants the site's role map gives their roles. Every refusal is `401 site-sign-in-refused`, with `details.reason`. A statement whose signature wasn't verified gets `not-verified` alone, whatever was wrong (the site, the key, the signature, the format), since its sender has proved nothing; after a verified signature: `site-paused`, `site-not-vouching`, `wrong-audience`, `expired`, `issued-in-the-future`, `too-long-lived`, `replayed`, `role-not-allowed`, `person-removed` or `people-cap`. Rate-limited per client and per site (`429 rate-limit-exceeded`, with `Retry-After`). The body is at most 4096 bytes.",
    tags: ['sites'],
    security: 'public',
    requestBody: { required: true, schema: ref('SiteSignInBody') },
    responses: {
      '200': { description: 'A session for the person.', schema: ref('SiteSignInResult') },
      '400': ErrorResponse("A malformed body, or a statement that isn't a compact JWS."),
      '401': ErrorResponse('The statement was refused (`site-sign-in-refused`, `details.reason`).'),
      '413': ErrorResponse('The body is over 4096 bytes (`site-request-too-large`).'),
      '429': ErrorResponse('Too many requests from this client or for this site.'),
    },
  },
] as const;

/** Utility used by both the generator and the drift test. */
export function honoToOpenapiPath(honoPath: string): string {
  return honoPath.replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g, '{$1}');
}

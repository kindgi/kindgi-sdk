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
}

// ---------------- shared parameters ----------------

const IdempotencyKeyParam: ParameterSpec = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    "Caller-supplied idempotency key, scoped to the caller: the same key from someone else in the tenant is their own request (from 0.1.5). Retries with the same key return the original response byte-identical (per `docs/API-ROUTE-CONVENTIONS.md` §3.1). A retry sent while the first request still runs is answered `409 idempotency-key-in-flight` with `Retry-After`, on a runtime whose store holds keys (from 0.1.5); retry after it, and you get the first request's answer. An answer that carries a secret (a new API key or public run token, a session token, a generated signing secret) isn't kept: a retry gets `409 idempotency-key-replay-withheld`, with the first request's status and when it succeeded (from 0.1.5).",
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

const CursorQueryParam: ParameterSpec = {
  name: 'cursor',
  in: 'query',
  required: false,
  description: 'Opaque cursor from a prior response. Absent → first page.',
  schema: { type: 'string' },
};

const LimitQueryParam: ParameterSpec = {
  name: 'limit',
  in: 'query',
  required: false,
  description: '1..100. Default 25.',
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
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
    'Replay runs (an eval run re-running a past run). `exclude` (default) leaves them out; `include` lists them with the other runs; `only` lists just them.',
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

const RunEvalRunIdQueryParam: ParameterSpec = {
  name: 'evalRunId',
  in: 'query',
  required: false,
  description:
    'Only the replay runs of this eval run. Implies replays are included; cannot be combined with `replays=exclude`.',
  schema: { type: 'string', minLength: 1 },
};

const RunTriggerIdQueryParam: ParameterSpec = {
  name: 'triggerId',
  in: 'query',
  required: false,
  description: 'Only the runs this trigger started (`Run.trigger.triggerId`).',
  schema: { type: 'string', format: 'uuid' },
};

const LiveProjectQueryParam: ParameterSpec = {
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

const PromotionScopeKindQueryParam: ParameterSpec = {
  name: 'scopeKind',
  in: 'query',
  required: false,
  description:
    'Only one scope: `tenant`, `org` or `project` (with `scopeId`), or `segment` (with `scopeId` and `segment`).',
  schema: { type: 'string', enum: ['tenant', 'org', 'project', 'segment'] },
};

const PromotionIdPathParam: ParameterSpec = {
  name: 'promotionId',
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
  description: 'Filter by approval status.',
  schema: { $ref: '#/components/schemas/ApprovalStatus' },
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

const ImprovementPassIdPathParam: ParameterSpec = {
  name: 'passId',
  in: 'path',
  required: true,
  description: 'The improvement pass id (a UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ProposalIdPathParam: ParameterSpec = {
  name: 'proposalId',
  in: 'path',
  required: true,
  description: 'The proposal id (a UUID).',
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

const ProvenanceCreatedAfterQueryParam: ParameterSpec = {
  name: 'createdAfter',
  in: 'query',
  required: false,
  description: 'ISO 8601 timestamp; return records created strictly after this.',
  schema: { type: 'string', format: 'date-time' },
};

const ProposalStatusQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Only proposals with this (derived) status.',
  schema: { $ref: '#/components/schemas/FixProposalStatus' },
};

const ProposalTierQueryParam: ParameterSpec = {
  name: 'tier',
  in: 'query',
  required: false,
  description: 'Only proposals of this tier.',
  schema: { $ref: '#/components/schemas/ProposalTier' },
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

const WebhookEndpointIdPathParam: ParameterSpec = {
  name: 'endpointId',
  in: 'path',
  required: true,
  description: 'The webhook endpoint id.',
  schema: { type: 'string' },
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

// Admin plane — eval suites.

const EvalSuiteIdPathParam: ParameterSpec = {
  name: 'suiteId',
  in: 'path',
  required: true,
  description: 'EvalSuiteId — stable string chosen by the caller (e.g. `acme.drafting-accuracy`).',
  schema: { type: 'string', minLength: 1 },
};

const EvalSuiteVersionPathParam: ParameterSpec = {
  name: 'version',
  in: 'path',
  required: true,
  description: 'Semver version string of the eval suite (e.g. `1.2.0`).',
  schema: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
};

const EvalSuiteKindFilterQueryParam: ParameterSpec = {
  name: 'kind',
  in: 'query',
  required: false,
  description:
    'Filter to eval suites of a single kind. Values: `accuracy | pairwise | regression | human-review | benchmark | custom | judged`.',
  schema: { $ref: '#/components/schemas/EvalKind' },
};

const EvalSuiteNameFilterQueryParam: ParameterSpec = {
  name: 'name',
  in: 'query',
  required: false,
  description: 'Prefix match on `EvalSuite.id`. Dotted namespaces are the natural filter shape.',
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

// Admin plane — eval-run data plane.

const EvalRunIdPathParam: ParameterSpec = {
  name: 'runId',
  in: 'path',
  required: true,
  description: 'EvalRunId — opaque branded UUID.',
  schema: { type: 'string', format: 'uuid' },
};

const EvalRunSuiteIdFilterQueryParam: ParameterSpec = {
  name: 'suiteId',
  in: 'query',
  required: false,
  description: 'Filter to runs against a specific suite id.',
  schema: { type: 'string' },
};

const EvalRunStatusFilterQueryParam: ParameterSpec = {
  name: 'status',
  in: 'query',
  required: false,
  description: 'Filter to a single EvalRunStatus.',
  schema: { $ref: '#/components/schemas/EvalRunStatus' },
};

const EvalRunAgentIdFilterQueryParam: ParameterSpec = {
  name: 'agentId',
  in: 'query',
  required: false,
  description: 'Filter to runs targeting a specific agent id.',
  schema: { type: 'string' },
};

const EvalRunFlowIdFilterQueryParam: ParameterSpec = {
  name: 'flowId',
  in: 'query',
  required: false,
  description: 'Filter to runs targeting a specific flow id.',
  schema: { type: 'string' },
};

const EvalRunFromFilterQueryParam: ParameterSpec = {
  name: 'from',
  in: 'query',
  required: false,
  description: 'ISO-8601 lower bound on `startedAt` (inclusive).',
  schema: { type: 'string', format: 'date-time' },
};

const EvalRunToFilterQueryParam: ParameterSpec = {
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

// ---------------- judgments + judge classes: parameters ----------------

const JudgmentIdPathParam: ParameterSpec = {
  name: 'judgmentId',
  in: 'path',
  required: true,
  description: 'Judgment id.',
  schema: { type: 'string', minLength: 1 },
};

const JudgeClassIdPathParam: ParameterSpec = {
  name: 'judgeClassId',
  in: 'path',
  required: true,
  description: 'Judge class id.',
  schema: { type: 'string', minLength: 1 },
};

const judgmentQuery = (name: string, description: string, schema: JsonSchema): ParameterSpec => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
});

const JudgmentListQueryParams: readonly ParameterSpec[] = [
  judgmentQuery('runId', 'Only judgments of this run.', { type: 'string', minLength: 1 }),
  judgmentQuery('agentId', 'Only judgments of runs of this agent.', {
    type: 'string',
    minLength: 1,
  }),
  judgmentQuery('agentVersion', 'Only judgments of runs of this agent version. Needs `agentId`.', {
    type: 'string',
    minLength: 1,
  }),
  judgmentQuery('flowId', 'Only judgments of runs of this flow.', { type: 'string', minLength: 1 }),
  judgmentQuery('verdict', 'Only judgments with this verdict.', {
    type: 'string',
    enum: ['yes', 'no'],
  }),
  judgmentQuery('judgeClassId', 'Only judgments recorded under this judge class.', {
    type: 'string',
    minLength: 1,
  }),
  judgmentQuery('participantId', "Only judgments made for this app end user's opaque id.", {
    type: 'string',
    minLength: 1,
  }),
];

const JudgeClassScopeKindQueryParam: ParameterSpec = judgmentQuery(
  'scopeKind',
  'Only classes of this scope kind. `project` and `agent` need `projectId`; `agent` also needs `agentId`.',
  { type: 'string', enum: ['tenant', 'project', 'agent'] },
);

const JudgeClassProjectIdQueryParam: ParameterSpec = judgmentQuery(
  'projectId',
  'Project of the scope, for `scopeKind=project|agent`.',
  { type: 'string', minLength: 1 },
);

const JudgeClassAgentIdQueryParam: ParameterSpec = judgmentQuery(
  'agentId',
  'Agent of the scope, for `scopeKind=agent`.',
  { type: 'string', minLength: 1 },
);

// ---------------- shared responses ----------------

const ErrorResponse = (description: string): ResponseSpec => ({
  description,
  schema: ref('WireError'),
});

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

// ---------------- operation registry ----------------

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
        'Agent or flow not found; or `projectId` names no project of this tenant (`project-not-found`).',
      ),
      '422': ErrorResponse('Guardrail violation or budget exceeded.'),
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body; or an erasure of the turn's person (its conversation or its `participantId`) is in progress (`erasure-in-progress`): no new turn starts for them until it completes.",
      ),
      '400': ErrorResponse(
        "Malformed request body, or the body's `projectId` isn't a project id (a UUID).",
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
      RunEvalRunIdQueryParam,
      RunTriggerIdQueryParam,
      RunIncludeQueryParam,
    ],
    responses: {
      '200': { description: 'Page of runs.', schema: ref('RunCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed cursor, filter or scope.'),
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
    summary: 'Resume a suspended run at a waitpoint (not available in this release)',
    description:
      'Not available in this release: always `422 run-resume-not-supported`, and no waitpoint is completed. Every waitpoint a run can wait at belongs to an approval or to the runtime itself. A run waiting for an approval continues when a reviewer decides it: `POST /v1/approvals/{approvalId}/complete`.',
    tags: ['runs'],
    security: 'bearer',
    parameters: [RunIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('ResumeRunBody') },
    responses: {
      ...CommonMutationErrors,
      '422': ErrorResponse('`run-resume-not-supported`: not available in this release.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/runs/:runId/journal',
    openapiPath: '/v1/runs/{runId}/journal',
    operationId: 'runs.journal',
    summary: 'Read the durable journal for a run',
    description:
      'Returns raw `JournalEntry` values from the run journal (`@kindgi/runtime`). Distinct from the SSE wire enum — see `docs/API-ROUTE-CONVENTIONS.md` §6.',
    tags: ['runs'],
    security: 'bearer',
    parameters: [RunIdPathParam, JournalSinceQueryParam],
    responses: {
      '400': ErrorResponse('`runId` is not a run id (a UUID).'),
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
      "An API key acts for one principal (`for`: a person or a service account; default the caller), with that principal's grants. Its `role` is a ceiling under them and its `projectId` a limit. Returns the plaintext token exactly once. A person or a service account's key mints its own keys; only a tenant admin mints for someone else, or an `admin` key. A caller can only grant capabilities it holds, and a key limited to a project mints only keys limited to it. Only mounted when the deployment supplies a `TokenAdmin`.",
    tags: ['tokens'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('MintTokenBody') },
    responses: {
      '201': { description: 'Token minted.', schema: ref('MintTokenResult') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        "Idempotency-Key reused with a different body (`idempotency-key-body-mismatch`), or a retry of a request that succeeded: its answer carried a secret, which isn't kept (`idempotency-key-replay-withheld`, with its `status` and `at`).",
      ),
      '403': ErrorResponse(
        "Not a tenant admin where one is needed, or a capability the caller does not hold (`permission-denied`); an `admin` key for a principal that isn't a tenant admin (`role-exceeds-principal`); a key limited to a project minting for another (`key-project-mismatch`).",
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
        'The account is unregistered (`service-account-unregistered`), or an idempotency conflict.',
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
    },
  },
  {
    method: 'post',
    honoPath: '/v1/service-accounts/:serviceAccountId/unregister',
    openapiPath: '/v1/service-accounts/{serviceAccountId}/unregister',
    operationId: 'serviceAccounts.unregister',
    summary: 'Unregister a service account',
    description:
      'A tombstone: its grants go and its keys stop working; it stays readable. Idempotent. Tenant admins only.',
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
      "Requires a reviewer: a token that carries a `reviewerRole`, or whose user is a registered reviewer (the roster gives the role). Role-scoped: reviewers only see approvals whose `requiredRole` rank ≤ their rank (standard < senior < admin). `scopeKind`/`scopeId` narrow to one project's approvals, or every project's in an org; approvals from before Kindgi 0.1.3 have no project and are listed only without a scope.",
    tags: ['approvals'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      ApprovalStatusQueryParam,
      ApprovalRequiredRoleQueryParam,
      CreatedAfterQueryParam,
      WaitTokenIdQueryParam,
    ],
    responses: {
      '200': { description: 'Page of approvals.', schema: ref('ApprovalCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter or scope.'),
      '403': ErrorResponse("The caller isn't a reviewer, or asked for a tier above its own."),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/approvals/:approvalId',
    openapiPath: '/v1/approvals/{approvalId}',
    operationId: 'approvals.get',
    summary: 'Fetch a single approval',
    description:
      'Returns 404 for ids that exist but require a higher role than the caller (avoids cross-tier existence leaks — see API-ROUTE-CONVENTIONS.md §2.4). A decided approval carries its `decision`: what the reviewer decided, why, and who (`decidedBy`, `user:<userId>`).',
    tags: ['approvals'],
    security: 'bearer',
    parameters: [ApprovalIdPathParam],
    responses: {
      '200': { description: 'Approval.', schema: ref('Approval') },
      ...CommonAuthErrors,
      '403': ErrorResponse("The caller isn't a reviewer."),
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
        'With authorization enforced, the caller is not an admin of the tenant.',
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
        'With authorization enforced, the caller is not an admin of the tenant.',
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
      'Cursor-paginated list of the latest version per agent id. Optional `?name=` filters by prefix on agent id.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      AgentNameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
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
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam],
    responses: {
      '200': { description: 'Agent.', schema: ref('Agent') },
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
    description: 'Cursor-paginated. Sort order is binding-defined (built-in registry: semver asc).',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of agent versions.', schema: ref('AgentCollectionPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No agent with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/versions',
    openapiPath: '/v1/agents/{agentId}/versions',
    operationId: 'agents.deriveVersion',
    summary: 'Derive an agent version with data-block pins swapped',
    description:
      "An expert's edit, without a code change: a new agent version that is `from`'s bag with some prompt or settings pins swapped (`derivedFrom: { version, reason: 'edited', label, by }`), numbered the next free patch after the agent's highest version. Only blocks `from` already references swap, to a published, active version of the right kind (model settings for the model-settings block); tool pins come from code. Needs `publish` on the agent.",
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
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `agent-project-mismatch`: the agent belongs to another project than the body's `projectId` (agents never move; the message doesn't name the project). Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '400': ErrorResponse(
        "`validation-failed`: `from` has no pins, a swap names a block it doesn't reference, or a version that isn't published, active or the right kind (see `details.issues`); or `projectId` isn't a project id (a UUID).",
      ),
      '404': ErrorResponse(
        '`agent-not-found`: no agent at `from`; or `projectId` names no project of this tenant (`project-not-found`).',
      ),
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
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID).",
      ),
      '409': ErrorResponse(
        "`agent-already-registered`: that (id, version) is taken. Or `agent-project-mismatch`: the agent's versions live in another project (an agent belongs to the project its first version was published into and never moves; the message doesn't name the project). Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
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
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead. Or `agent-version-live`: the version is the live version of the scopes in `details.scopes`; roll back, unpin, or promote another version there first.",
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
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No agent at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/live',
    openapiPath: '/v1/agents/{agentId}/live',
    operationId: 'agents.live.resolve',
    summary: 'The version a run would use',
    description:
      "Resolves the version a run of this agent would use for a project and segment path: the most specific live version (segment path, project, org, tenant), else the latest registered. A run that names its version, or a follow-up turn in a conversation, isn't resolved this way.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, LiveProjectQueryParam, SegmentQueryParam],
    responses: {
      '200': { description: 'The resolved version.', schema: ref('LiveVersionResolution') },
      ...CommonAuthErrors,
      '400': ErrorResponse('A malformed project id or segment, or a segment without a project.'),
      '404': ErrorResponse('No agent with that id.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/live-versions',
    openapiPath: '/v1/agents/{agentId}/live-versions',
    operationId: 'agents.live.list',
    summary: "List an agent's live versions",
    description: 'Every scope with a live version pinned, and the promotion that set it.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam],
    responses: {
      '200': { description: 'The pins.', schema: ref('LivePinList') },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/promotions',
    openapiPath: '/v1/agents/{agentId}/promotions',
    operationId: 'agents.promotions.create',
    summary: 'Make a version live for a scope',
    description:
      "Pins `version` live for `scope`: runs in that scope that don't name a version use it, from the next run. Open conversations keep their version. The version must be registered and active. Every promotion is recorded, with who asked and why. Needs `promote` on the agent.\n\nWith a gate policy for the scope (`GET …/gate-policy`), the promotion is checked first against the comparison named by `evalRunId`: `201` promoted; `202` the gate passed and the policy wants a reviewer's approval (a HITL approval, subject `agent-promotion`; the live version moves once it's approved, if nothing changed meanwhile); `422 gate-failed` with `details.promotionId`, `details.policy` and every check in `details.checks`. A refused promotion is recorded too.\n\nA pin in place skips the gate: when the scope has no live version of its own and already serves exactly `version` (from a scope above, or as the latest), pinning it there changes nothing any run gets, so it is promoted (`201`) with one passing `pinInPlace` check, no comparison and no approval, its reason starting `pin-in-place`. It is re-checked as it is written; if the scope moved meanwhile, `409 promotion-superseded`: check again.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PromoteBody') },
    responses: {
      '201': { description: 'Promoted.', schema: ref('Promotion') },
      '202': {
        description: 'The gate passed; the promotion waits for an approval (`approvalId`).',
        schema: ref('Promotion'),
      },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        'The version is not registered, or was unregistered; or the eval run is not found.',
      ),
      '409': ErrorResponse(
        "`promotion-superseded`: the scope's live version changed while the gate ran; check again. `gate-policy-descendant-unpinned`: the change would also move a narrower scope a gate policy applies to, which has no live version of its own and so follows this scope, without its gate; the message names each one: pin it at its current version first.",
      ),
      '422': ErrorResponse(
        '`gate-failed`: the gate refused it. `details.checks` has every check; the refusal is recorded (`details.promotionId`).',
      ),
      '501': ErrorResponse(
        "`promotion-gate-unsupported`: a gate policy applies, and the deployment can't record a gated promotion.",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/promotions/check',
    openapiPath: '/v1/agents/{agentId}/promotions/check',
    operationId: 'agents.promotions.check',
    summary: 'Check a promotion against its gate',
    description:
      'What `POST …/promotions` with the same body would do, with nothing recorded: `would-promote`, `needs-approval` (with the approval it needs) or `gate-failed`, with every check. For a pipeline: evaluate, check, promote. Needs `read` on the agent.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam],
    requestBody: { required: true, schema: ref('PromoteBody') },
    responses: {
      '200': { description: "The gate's answer.", schema: ref('PromotionCheck') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed body, or the eval run is not a finished comparison.'),
      '404': ErrorResponse('The version, the agent or the eval run is not found.'),
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
    parameters: [
      AgentIdPathParam,
      PromotionScopeKindQueryParam,
      ScopeIdQueryParam,
      SegmentQueryParam,
    ],
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
      PromotionScopeKindQueryParam,
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
        '`gate-policy-already-registered`: that (id, version) exists. `gate-policy-scope-taken`: another policy gates the agent for the scope (`details.heldBy`). `gate-policy-scope-changed`: the version would change the agent or scope. `gate-policy-scope-unpinned`: the scope has no live version of its own; a gated scope holds its own pin (a pin above it is not enough, since a promotion there would change this scope ungated), so pin a version for the scope first.',
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
        '`gate-policy-scope-taken`: another policy gates the agent for the scope now (`details.heldBy`). `gate-policy-scope-unpinned`: the scope has no live version of its own; pin one first.',
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/promotions',
    openapiPath: '/v1/agents/{agentId}/promotions',
    operationId: 'agents.promotions.list',
    summary: "List an agent's promotions",
    description:
      'The history of live-version changes (promotions, rollbacks, unpins), newest first. `scopeKind` (`tenant`, `org`, `project`, `segment`) with `scopeId` and `segment` narrows it to one scope.',
    tags: ['agents'],
    security: 'bearer',
    parameters: [
      AgentIdPathParam,
      LimitQueryParam,
      CursorQueryParam,
      PromotionScopeKindQueryParam,
      ScopeIdQueryParam,
      SegmentQueryParam,
    ],
    responses: {
      '200': { description: 'Page of promotions.', schema: ref('PromotionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed scope or cursor.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/agents/:agentId/promotions/:promotionId',
    openapiPath: '/v1/agents/{agentId}/promotions/{promotionId}',
    operationId: 'agents.promotions.get',
    summary: 'Get a promotion',
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, PromotionIdPathParam],
    responses: {
      '200': { description: 'The promotion.', schema: ref('Promotion') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such promotion for this agent.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/live/rollback',
    openapiPath: '/v1/agents/{agentId}/live/rollback',
    operationId: 'agents.live.rollback',
    summary: 'Roll a scope back to its previous live version',
    description:
      "Back to the scope's previous live version, or `toVersion`. Recorded like a promotion. Needs `promote` on the agent.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RollbackBody') },
    responses: {
      '200': { description: 'Rolled back.', schema: ref('Promotion') },
      ...CommonMutationErrors,
      '404': ErrorResponse('`toVersion` is not registered, or was unregistered.'),
      '409': ErrorResponse(
        '`not-pinned`: the scope has no pin of its own. `nothing-to-roll-back`: no earlier version to go back to. `gate-policy-descendant-unpinned`: the change would also move a narrower scope a gate policy applies to, which has no live version of its own and so follows this scope, without its gate; the message names each one: pin it at its current version first.',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/agents/:agentId/live/unpin',
    openapiPath: '/v1/agents/{agentId}/live/unpin',
    operationId: 'agents.live.unpin',
    summary: "Remove a scope's live version",
    description:
      "Removes the scope's own pin: its runs use the next scope up (and the latest when nothing is pinned). Recorded like a promotion. Needs `promote` on the agent.",
    tags: ['agents'],
    security: 'bearer',
    parameters: [AgentIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('UnpinBody') },
    responses: {
      '200': { description: 'Unpinned.', schema: ref('Promotion') },
      ...CommonMutationErrors,
      '409': ErrorResponse(
        '`not-pinned`: the scope has no pin of its own. `gate-policy-needs-pin`: the scope has a gate policy of its own, and a gated scope keeps its own pin; unregister the policy first, or roll back instead. `gate-policy-descendant-unpinned`: the change would also move a narrower scope a gate policy applies to, which has no live version of its own and so follows this scope, without its gate; the message names each one: pin it at its current version first.',
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
      'Cursor-paginated list of the latest version per flow id. Optional `?name=` filters by prefix on flow id.',
    tags: ['flows'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      FlowNameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
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
    tags: ['flows'],
    security: 'bearer',
    parameters: [FlowIdPathParam],
    responses: {
      '200': { description: 'Flow.', schema: ref('Flow') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No flow with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/flows/:flowId/versions',
    openapiPath: '/v1/flows/{flowId}/versions',
    operationId: 'flows.listVersions',
    summary: 'List versions of a flow',
    description: 'Cursor-paginated. Sort order is binding-defined (for example semver asc).',
    tags: ['flows'],
    security: 'bearer',
    parameters: [FlowIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': { description: 'Page of flow versions.', schema: ref('FlowCollectionPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No flow with that id under this tenant.'),
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
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID).",
      ),
      '409': ErrorResponse(
        "`flow-already-registered`: that (id, version) is taken. Or `flow-project-mismatch`: the flow's versions live in another project (a flow belongs to the project its first version was published into and never moves; the message doesn't name the project). Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
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
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
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
      '409': ErrorResponse(
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No flow at that (id, version) under this tenant.'),
    },
  },

  // ---------- tools ----------
  {
    method: 'get',
    honoPath: '/v1/tools',
    openapiPath: '/v1/tools',
    operationId: 'tools.list',
    summary: 'List tools',
    description:
      'Cursor-paginated list of registered tool manifests. Optional `?name=` filters by prefix on tool id.',
    tags: ['tools'],
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
    description:
      'Returns the latest active version of the tool. When all versions are unregistered (retired), the head row still exists but has no active version — the response is 410 tool-gone with the id, distinct from 404 tool-not-found (never registered).',
    tags: ['tools'],
    security: 'bearer',
    parameters: [ToolIdPathParam],
    responses: {
      '200': { description: 'Tool manifest.', schema: ref('Tool') },
      ...CommonAuthErrors,
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
      'Body is a `ToolManifest` (Tool minus its runtime handler). Server validates via `@kindgi/tools.validateToolManifest`. Metadata only: the handler is not uploaded through this route and must already be available to the runtime.',
    tags: ['tools'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterToolBody') },
    responses: {
      '201': { description: 'Tool registered.', schema: ref('RegisterToolResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID).",
      ),
      '409': ErrorResponse(
        "`tool-already-registered`: that (id, version) is taken. Or `tool-project-mismatch`: the tool's versions live in another project (a tool belongs to the project its first version was published into and never moves; the message doesn't name the project). Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
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
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
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
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse('No tool at that (id, version) under this tenant.'),
    },
  },

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
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID).",
      ),
      '409': ErrorResponse(
        "Guardrail already registered at that id. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
      '422': ErrorResponse(
        "`guardrail-config-invalid`: the guardrail's `config` breaks the `configSchema` of the pack check it names, which the pack service would refuse on every call. `details.issues` lists each problem, `{ path, message }` with `path` a JSON pointer into the guardrail (`/config/maxChars`); the message names the guardrail, the check and the setting. Checked when the check's deployment carries its schema.",
      ),
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
      "Cursor-paginated. Fixed sort: `openedAt desc, id desc`. Filters: `?agentId=`, `?status=open|closed`, `?replays=exclude|include|only` (default `exclude`: a comparison's replay conversations are left out), and `scopeKind`/`scopeId` for one project's conversations, or every project's in an org. Conversations from before Kindgi 0.1.3 have no project and are listed only without a scope.",
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
      '404': ErrorResponse('No conversation with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/conversations',
    openapiPath: '/v1/conversations',
    operationId: 'conversations.open',
    summary: 'Open a conversation',
    description:
      'Pins `(agentId, agentVersion)` at open time. `title` defaults to `"Untitled conversation"` when omitted; `projectId` puts it in a project (lists filter by it; omitted, the Default project); `scope` accepts arbitrary JSON.',
    tags: ['conversations'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('OpenConversationBody') },
    responses: {
      '201': { description: 'Conversation opened.', schema: ref('Conversation') },
      ...CommonMutationErrors,
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
      '404': ErrorResponse('No conversation with that id under this tenant.'),
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
      '404': ErrorResponse(
        'No conversation with that id under this tenant, or it is unregistered already.',
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
      '404': ErrorResponse('No conversation with that id under this tenant.'),
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

  // ---------- improvement proposals ----------
  {
    method: 'get',
    honoPath: '/v1/proposals',
    openapiPath: '/v1/proposals',
    operationId: 'proposals.list',
    summary: 'List improvement proposals',
    description:
      'Newest first, cursor-paginated, only the proposals of agents the caller can read. Filters: `?agentId=`, `?tier=`, `?status=` (statuses are derived, so a page filtered by status can hold fewer rows than `limit`), and the live scope a proposal is for (`scopeKind`, `scopeId`, `segment`, exactly as the promotions history takes it).',
    tags: ['proposals'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ProposalStatusQueryParam,
      AgentIdQueryParam,
      ProposalTierQueryParam,
      PromotionScopeKindQueryParam,
      ScopeIdQueryParam,
      SegmentQueryParam,
    ],
    responses: {
      '200': { description: 'Page of proposals.', schema: ref('FixProposalCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('A malformed query parameter.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/proposals/improve',
    openapiPath: '/v1/proposals/improve',
    operationId: 'proposals.improve',
    summary: 'Start an improvement pass',
    description:
      "The runtime looks for better values for the version's tunable settings (keys its settings blocks' schemas mark `x-kindgi-tunable`) on the test set, within the budget, and writes its best candidate as an improvement proposal, which waits for a reviewer when requested. It answers at once with the pass, `running`. Checked first: the version is active and pins a settings block with tunable keys (`400 validation-failed`), the agent registry takes writes (`409 registry-read-only`), and the agent has a live version for the whole tenant (`409 proposal-needs-pin`). Needs `publish` on the agent. Without improvement passes in this runtime, `501 improve-unsupported`.",
    tags: ['proposals'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('ImproveBody') },
    responses: {
      '202': { description: 'The pass, running.', schema: ref('ImprovementPass') },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        '`fromVersion` (or the version serving the scope) is not an active version.',
      ),
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no improvement passes.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/proposals/:proposalId',
    openapiPath: '/v1/proposals/{proposalId}',
    operationId: 'proposals.get',
    summary: 'Fetch an improvement proposal',
    description: 'Needs `read` on its agent.',
    tags: ['proposals'],
    security: 'bearer',
    parameters: [ProposalIdPathParam],
    responses: {
      '200': { description: 'The proposal.', schema: ref('FixProposal') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such proposal (or none the caller can read).'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/proposals',
    openapiPath: '/v1/proposals',
    operationId: 'proposals.create',
    summary: 'Propose new content for a data block',
    description:
      'A hand-written proposal: new settings values or a new prompt template for a block `fromVersion` pins, for a live scope. Checked as publishing that block version would be (its schema carries over), and refused when it equals the pinned content. The same change from the same version for the same scope is one proposal: answered `200` with `X-Proposal-Deduped: true`. Needs `publish` on the agent.',
    tags: ['proposals'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateProposalBody') },
    responses: {
      '201': { description: 'The proposal, a `draft`.', schema: ref('FixProposal') },
      '200': { description: 'The same proposal, made before.', schema: ref('FixProposal') },
      ...CommonMutationErrors,
      '404': ErrorResponse(
        "`fromVersion` isn't an active version of the agent (`agent-version-not-found`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/proposals/:proposalId/evaluate',
    openapiPath: '/v1/proposals/{proposalId}/evaluate',
    operationId: 'proposals.evaluate',
    summary: 'Compare a proposal on a test set',
    description:
      "The first evaluation publishes the block version and derives the agent version (`derivedFrom.proposalId`); they serve no scope until a promotion makes them live. Then a comparison eval run replays that version on the test set, against the recorded outputs (`baseline: 'recorded'`). Needs `publish` on the agent, and a live version of it for the whole tenant: an agent with none serves its latest version wherever nothing is pinned, so a new version would go live there at once (`409 proposal-needs-pin`). Allowed from `draft`, `evaluated`, `not-better`, `evaluation-failed`, `refused`, `superseded` and `expired`.",
    tags: ['proposals'],
    security: 'bearer',
    parameters: [ProposalIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('EvaluateProposalBody') },
    responses: {
      '202': { description: 'The proposal, `evaluating`.', schema: ref('FixProposal') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such proposal, or no such test set.'),
      '409': ErrorResponse(
        "`proposal-needs-pin`: the agent has no live version for the whole tenant. `proposal-invalid-state-transition`: the proposal's status doesn't allow it. `registry-read-only`: the agent registry takes no writes (under `kindgi dev`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/proposals/:proposalId/request',
    openapiPath: '/v1/proposals/{proposalId}/request',
    operationId: 'proposals.request',
    summary: "Request a proposal's promotion for its scope",
    description:
      "A promotion of the candidate for the proposal's scope, with its evaluation's comparison, through the scope's gate: as `POST /v1/agents/{agentId}/promotions` answers. Needs `promote` on the agent. Allowed from `evaluated`, `not-better` (the gate decides), `refused`, `superseded` and `expired`.",
    tags: ['proposals'],
    security: 'bearer',
    parameters: [ProposalIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('ProposalReasonBody') },
    responses: {
      '201': { description: 'Promoted: the proposal, `promoted`.', schema: ref('FixProposal') },
      '202': {
        description: 'The gate passed and an approval is open: the proposal, `in-review`.',
        schema: ref('FixProposal'),
      },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such proposal.'),
      '409': ErrorResponse("The proposal's status doesn't allow it."),
      '422': ErrorResponse(
        '`gate-failed`: the gate refused it (the error carries the checks and `proposalId`).',
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/proposals/:proposalId/rollback',
    openapiPath: '/v1/proposals/{proposalId}/rollback',
    operationId: 'proposals.rollback',
    summary: 'Roll back a promoted proposal',
    description:
      "The scope goes back to the version its own pin held before the proposal's promotion (or, with none, falls back to the scope above). Only while the proposal's version still serves the scope. Needs `promote` on the agent.",
    tags: ['proposals'],
    security: 'bearer',
    parameters: [ProposalIdPathParam, IdempotencyKeyParam],
    requestBody: { required: false, schema: ref('ProposalReasonBody') },
    responses: {
      '200': { description: 'The proposal, `rolled-back`.', schema: ref('FixProposal') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such proposal.'),
      '409': ErrorResponse("It isn't promoted, or its version doesn't serve the scope anymore."),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/proposals/:proposalId/withdraw',
    openapiPath: '/v1/proposals/{proposalId}/withdraw',
    operationId: 'proposals.withdraw',
    summary: 'Withdraw a proposal',
    description:
      "Closes it. Not while it's in review (decide its approval instead), nor once promoted, rejected or rolled back. Needs `publish` on the agent.",
    tags: ['proposals'],
    security: 'bearer',
    parameters: [ProposalIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('WithdrawProposalBody') },
    responses: {
      '200': { description: 'The proposal, `withdrawn`.', schema: ref('FixProposal') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such proposal.'),
      '409': ErrorResponse("The proposal's status doesn't allow it."),
    },
  },

  // ---------- improvement passes ----------
  {
    method: 'get',
    honoPath: '/v1/improvement-passes',
    openapiPath: '/v1/improvement-passes',
    operationId: 'improvementPasses.list',
    summary: 'List improvement passes',
    description:
      'Newest first, only the passes of agents the caller can read. `?agentId=` narrows them.',
    tags: ['proposals'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam, AgentIdQueryParam],
    responses: {
      '200': { description: 'Page of passes.', schema: ref('ImprovementPassCollectionPage') },
      ...CommonAuthErrors,
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no improvement passes.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/improvement-passes/:passId',
    openapiPath: '/v1/improvement-passes/{passId}',
    operationId: 'improvementPasses.get',
    summary: 'Fetch an improvement pass',
    description:
      'Its status, the candidates it compared and what they cost, and once it ends, what it found. Needs `read` on its agent.',
    tags: ['proposals'],
    security: 'bearer',
    parameters: [ImprovementPassIdPathParam],
    responses: {
      '200': { description: 'The pass.', schema: ref('ImprovementPass') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No such pass (or none the caller can read).'),
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no improvement passes.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/improvement-passes/:passId/cancel',
    openapiPath: '/v1/improvement-passes/{passId}/cancel',
    operationId: 'improvementPasses.cancel',
    summary: 'Cancel an improvement pass',
    description:
      'A running pass stops and ends `cancelled`, writing no proposal. Needs `publish` on its agent.',
    tags: ['proposals'],
    security: 'bearer',
    parameters: [ImprovementPassIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'The pass, cancelled.', schema: ref('ImprovementPass') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No such pass.'),
      '409': ErrorResponse('`improvement-pass-finished`: it has ended already.'),
      '501': ErrorResponse('`improve-unsupported`: this runtime runs no improvement passes.'),
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
      "Cursor-paginated. Metadata rows only — clients fetch the DAG payload via `GET /v1/provenance/{runId}`. Fixed sort: `createdAt desc, id desc`. Filters: `?runId=`, `?agentId=`, `?createdAfter=`, and `scopeKind`/`scopeId` for one project's records, or every project's in an org (records from before Kindgi 0.1.3 have no project and are listed only without a scope).",
    tags: ['provenance'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      ProvenanceRunIdQueryParam,
      ProvenanceAgentIdQueryParam,
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
      'Returns the full DAG (nodes + edges) plus record metadata. 404 when no provenance was emitted for the run (e.g. the deployment does not run the emitter, or the run was pre-provenance).',
    tags: ['provenance'],
    security: 'bearer',
    parameters: [RunIdPathParam],
    responses: {
      '200': { description: 'Full provenance record.', schema: ref('ProvenanceRecord') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No provenance record for that run under this tenant.'),
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
      "Multipart upload. `file` part carries the bytes; other form fields carry metadata (`name`, `contentType`, `tags` (JSON), `ownerRunId`, `projectId`, `expectedHash`). Framework computes sha256 and returns it in `BlobMeta.hash`. If `expectedHash` was supplied and diverges, response is `400 blob-hash-mismatch`. Content-type sniffing is NOT performed server-side — the framework trusts the caller. The artifact belongs to its owner run's project, else `projectId`, else the tenant's default project; uploading needs `write` there. An upload over the runtime's cap (default 100 MB) is `413 artifact-too-large`.",
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
      '403': ErrorResponse('No `write` on the project (`permission-denied`).'),
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
      'Streams raw bytes. Response headers: `Content-Type` (as declared at upload), `Content-Length`, `X-Kindgi-Blob-Hash` (sha256 hex), `X-Kindgi-Blob-Name` (URI-encoded caller name).',
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
      "Runs the provider's adapter check over its stored registration (its `adapter_config`, its metadata, whether it names a `secret_ref`): the check `POST /v1/providers` runs before it stores one. Static: no network call, no secret read. `issues` lists what would keep the runtime from building the provider, each with a JSON-pointer `path`; an adapter this runtime doesn't have is one (`/adapter_id`). `checked` is false when this runtime has no check for the provider's adapter.",
    tags: ['providers'],
    security: 'bearer',
    parameters: [ProviderIdPathParam],
    responses: {
      '200': { description: 'The check.', schema: ref('ProviderCheckResult') },
      ...CommonAuthErrors,
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
      'Body is a full `ProviderMetadata`. Server validates shape: provider-level `id` + `region` non-empty; `models[]` non-empty with unique `name` per entry; per-model `contextWindow` positive integer; per-model `features` against the closed enum; per-model `cost` non-negative; optional per-model `p95LatencyMs` / `maxOutputTokens` well-shaped; optional `labels` within their limits — same rules as `@kindgi/capabilities.createProviderRegistry`. Secrets (API keys, endpoints) are NOT part of the wire shape; deployments store them inside the binding. When the runtime has the adapter the body names, that adapter checks the registration first (its `adapter_config`, the metadata and the presence of `secret_ref`; static: no network, no secret read): a problem refuses it with `422 provider-config-invalid`.',
    tags: ['providers'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterProviderBody') },
    responses: {
      '201': { description: 'Provider registered.', schema: ref('RegisterProviderResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse('Validation failed (see `details.reason`).'),
      '409': ErrorResponse('Provider already registered at that id.'),
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
      '404': ErrorResponse('No provider with that id under this tenant, or already unregistered.'),
    },
  },

  // ---------- judgments ----------
  {
    method: 'post',
    honoPath: '/v1/judgments',
    openapiPath: '/v1/judgments',
    operationId: 'judgments.create',
    summary: "Judge an item of a run's output",
    description:
      "Records yes or no, with an optional reason, about one item of a finished run's output, optionally under a judge class that applies to the run's project or agent (unclassified judgments count with weight 1). `item.pointer` (a JSON Pointer) must resolve in the run's output; its value is kept as `itemValue`. The first judgment of a run also stores a copy of the run's input and output. `assertedBy` is the authenticated caller, never the body. Judging again as the same caller for the same run, item key and `participantId` supersedes the earlier judgment. Needs `judge` on the run.",
    tags: ['judgments'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateJudgmentBody') },
    responses: {
      '201': { description: 'Judgment recorded.', schema: ref('Judgment') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'Malformed body, or `item-not-found` (the pointer resolves to nothing in the output), or `judge-class-not-applicable`.',
      ),
      '403': ErrorResponse(
        '`permission-denied`: not allowed to judge this run. `judge-class-not-allowed`: the judge class is restricted (`assertableBy`) and the caller may not assert it.',
      ),
      '404': ErrorResponse('`run-not-found`.'),
      '409': ErrorResponse('`run-not-finished`: the run has no output to judge yet.'),
      '410': ErrorResponse(
        "`run-erased`: an erasure cleared the run's content (a person's words were removed); there's nothing to judge.",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/judgments',
    openapiPath: '/v1/judgments',
    operationId: 'judgments.list',
    summary: 'List judgments',
    description:
      'Live judgments (not removed or superseded), newest first, cursor-paginated. Filter by run, agent (and version), flow, verdict, judge class or participant; `?scopeKind + ?scopeId` narrow to a project.',
    tags: ['judgments'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      ...JudgmentListQueryParams,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
    ],
    responses: {
      '200': { description: 'Page of judgments.', schema: ref('JudgmentCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/judgments/:judgmentId',
    openapiPath: '/v1/judgments/{judgmentId}',
    operationId: 'judgments.get',
    summary: 'Fetch a judgment with its copies',
    description:
      "Returns the judgment (live or not) with the stored copy of the run's input and output and, when the judgment pointed at an item, its value.",
    tags: ['judgments'],
    security: 'bearer',
    parameters: [JudgmentIdPathParam],
    responses: {
      '200': { description: 'Judgment with copies.', schema: ref('JudgmentWithCopies') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No judgment with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/judgments/:judgmentId/unregister',
    openapiPath: '/v1/judgments/{judgmentId}/unregister',
    operationId: 'judgments.unregister',
    summary: 'Remove a judgment',
    description:
      'Soft delete: the judgment stops listing; retention policy decides when it is purged.',
    tags: ['judgments'],
    security: 'bearer',
    parameters: [JudgmentIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Removed.', schema: ref('UnregisterJudgmentResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse('`permission-denied`.'),
      '404': ErrorResponse('No live judgment with that id under this tenant.'),
    },
  },

  // ---------- judge classes ----------
  {
    method: 'post',
    honoPath: '/v1/judge-classes',
    openapiPath: '/v1/judge-classes',
    operationId: 'judgeClasses.create',
    summary: 'Create a judge class',
    description:
      'A named kind of judge with a weight, scoped to the tenant, a project, or an agent in a project. Names are unique among the live classes of a scope. Needs `admin` on the tenant (tenant scope) or the project.',
    tags: ['judge-classes'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateJudgeClassBody') },
    responses: {
      '201': { description: 'Judge class created.', schema: ref('JudgeClass') },
      ...CommonMutationErrors,
      '403': ErrorResponse('`permission-denied`.'),
      '409': ErrorResponse('`judge-class-name-taken`, or an idempotency conflict.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/judge-classes',
    openapiPath: '/v1/judge-classes',
    operationId: 'judgeClasses.list',
    summary: 'List judge classes',
    description:
      'Live classes, newest first, cursor-paginated. `?scopeKind=tenant|project|agent` (with `projectId` / `agentId`) narrows to one scope.',
    tags: ['judge-classes'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      JudgeClassScopeKindQueryParam,
      JudgeClassProjectIdQueryParam,
      JudgeClassAgentIdQueryParam,
    ],
    responses: {
      '200': { description: 'Page of judge classes.', schema: ref('JudgeClassCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed scope parameters.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/judge-classes/:judgeClassId',
    openapiPath: '/v1/judge-classes/{judgeClassId}',
    operationId: 'judgeClasses.get',
    summary: 'Fetch a judge class',
    description:
      'Also returns a retired class (`unregisteredAt` set): judgments keep naming theirs.',
    tags: ['judge-classes'],
    security: 'bearer',
    parameters: [JudgeClassIdPathParam],
    responses: {
      '200': { description: 'Judge class.', schema: ref('JudgeClass') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No judge class with that id under this tenant.'),
    },
  },
  {
    method: 'patch',
    honoPath: '/v1/judge-classes/:judgeClassId',
    openapiPath: '/v1/judge-classes/{judgeClassId}',
    operationId: 'judgeClasses.update',
    summary: "Change a judge class's weight or description",
    tags: ['judge-classes'],
    security: 'bearer',
    parameters: [JudgeClassIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('UpdateJudgeClassBody') },
    responses: {
      '200': { description: 'Updated judge class.', schema: ref('JudgeClass') },
      ...CommonMutationErrors,
      '403': ErrorResponse('`permission-denied`.'),
      '404': ErrorResponse('No live judge class with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/judge-classes/:judgeClassId/unregister',
    openapiPath: '/v1/judge-classes/{judgeClassId}/unregister',
    operationId: 'judgeClasses.unregister',
    summary: 'Retire a judge class',
    description: 'No new judgments may name it; existing judgments keep it.',
    tags: ['judge-classes'],
    security: 'bearer',
    parameters: [JudgeClassIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Retired.', schema: ref('UnregisterJudgeClassResult') },
      ...CommonMutationErrors,
      '403': ErrorResponse('`permission-denied`.'),
      '404': ErrorResponse('No live judge class with that id under this tenant.'),
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
      "Body is a full `MCPEndpoint` plus the scope to register it in (`scopeKind` + `scopeId`); authorization checks that scope. Server validates the closed transport enum + the `config.transport` matches `transport` guardrail + per-variant required fields (`command` for stdio; `url` for http-sse / streamable-http), and refuses unknown fields. `secretRef` names a secret in the deployment's store — plaintext secrets never cross the wire. A deployment with `KINDGI_TENANT_HOST_ACCESS=deployed` (the default outside development) refuses a `stdio` endpoint, which would run a command on the server's host: `403 host-access-denied`.",
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
      '400': ErrorResponse('Validation failed (see `details.reason`).'),
      '403': ErrorResponse(
        '`host-access-denied`: a `stdio` endpoint on a deployment that refuses commands on its host (`KINDGI_TENANT_HOST_ACCESS=deployed`); or `authz-denied`.',
      ),
      '409': ErrorResponse('MCP endpoint already registered at that id.'),
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
      "Cursor-paginated. Filters (all AND): `runId` (with `includeDescendants`, its whole subtree), `rootRunId`, `agentId`, `conversationId`, `category`, `providerId`, `model`, `servedModel`, `from`, `to`. Sort order is fixed: `occurredAt desc, id desc`. Records represent one accounted resource event each — a model call (`category` `llm.inference`: one record per call, with its model, usage and what the vendor said about it), tool invocation, storage write, sandbox execution, etc. `include=rawUsage` adds each model call's usage as the vendor reported it.",
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
      ...CommonAuthErrors,
      '404': ErrorResponse('No policy with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/policies/:policyId/versions/:version',
    openapiPath: '/v1/policies/{policyId}/versions/{version}',
    operationId: 'policies.versions.get',
    summary: 'Fetch a specific policy version',
    tags: ['policies'],
    security: 'bearer',
    parameters: [PolicyIdPathParam, PolicyVersionPathParam],
    responses: {
      '200': { description: 'Policy at that version.', schema: ref('Policy') },
      ...CommonAuthErrors,
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
      "Body is a full `Policy` — the server validates top-level shape (id, tenantId, semver version, kind ∈ closed enum, spec is an object), and `spec` for `tool-errors`, `hitl` and `retention` (a retention policy with an unknown domain or `mode: archive` is refused with `400 validation-failed`, naming the field). Other kinds' specs are their runtime consumer's to validate. Re-publishing an existing `(policyId, version)` returns `409 policy-already-registered`. A tenant has one retention policy per domain, plus one for `*`: a second policy id for a covered domain is refused with `409 policy-scope-taken` (`details.heldBy` names the policy that covers it; publish a new version of that one instead), and a new version can't move a policy to another domain (`409 policy-scope-changed`). A known kind that no runtime consumer applies yet (`access-control`, `adapter-allowlist`, `rate-limit`, `compliance`) is refused with `400 kind-not-applied` (`details.appliedKinds` lists the ones that are): publishing it would change nothing. Idempotency-Key applies (retries with the same key replay the original 201).",
    tags: ['policies'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PublishPolicyBody') },
    responses: {
      '201': { description: 'Policy published.', schema: ref('PublishPolicyResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        'Validation failed (see `details.issues`), or `kind-not-applied`: no runtime consumer applies that kind yet.',
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
      'Un-tombstones a previously-unregistered version: clears the tombstone on that version and recomputes the latest active version (and refreshes `policyKind` to match). Restores manifest bytes verbatim (semver hygiene). Idempotent. Reactivates a fully-retired policy identity when applicable. Publish is always allowed regardless of retirement state.',
    tags: ['policies'],
    security: 'bearer',
    parameters: [PolicyIdPathParam, PolicyVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Reinstated.', schema: ref('ReinstatePolicyVersionResult') },
      ...CommonMutationErrors,
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
      "Tombstoned rows in every domain a retention policy covers, with when each is purged (`purgeAt`) and the policy that decides it. `domainsMissingAdapter` names the covered domains this deployment can't purge; `unpolicedDomains` the ones no policy covers, whose tombstones are kept; `conflicts` the domains two policies cover (stored before one policy per domain was enforced). `limit` caps the rows **per domain**; `hasMore` says some domain has more than it returned, and `nextCursor` (when the runtime can continue) is the `cursor` for the next page. Requires `admin` on the tenant.",
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
      "Purges, for good, every tombstoned row past the grace of the retention policy that covers its domain (or only `domain`'s), up to `maxPerDomain` per domain; `remaining` counts what is left for the next call. Nothing sweeps on its own: call this (or `POST /v1/retention/sweep/{domain}`) from a schedule. A hold (`graceSeconds: -1`) keeps its domain's rows. Idempotent: a second call purges nothing new. Requires `admin` on the tenant.",
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

  // ---------- eval suites (admin plane) ----------
  {
    method: 'get',
    honoPath: '/v1/eval-suites',
    openapiPath: '/v1/eval-suites',
    operationId: 'evalSuites.list',
    summary: 'List tenant eval suites',
    description:
      'Cursor-paginated. Optional `?kind=` narrows to a single eval kind (exact match); optional `?name=` is a prefix match on `EvalSuite.id`. Sort order: suite id ascending. Latest version per id.',
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      EvalSuiteKindFilterQueryParam,
      EvalSuiteNameFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
    ],
    responses: {
      '200': { description: 'Page of eval suites.', schema: ref('EvalSuiteCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter (unknown `kind`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/eval-suites/:suiteId',
    openapiPath: '/v1/eval-suites/{suiteId}',
    operationId: 'evalSuites.get',
    summary: 'Fetch an eval suite (latest version)',
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [EvalSuiteIdPathParam],
    responses: {
      '200': { description: 'Latest eval suite version.', schema: ref('EvalSuite') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No eval suite with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/eval-suites/:suiteId/versions',
    openapiPath: '/v1/eval-suites/{suiteId}/versions',
    operationId: 'evalSuites.versions.list',
    summary: 'List versions of an eval suite',
    description: 'Cursor-paginated. Sort order is binding-defined (for example ascending semver).',
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [EvalSuiteIdPathParam, LimitQueryParam, CursorQueryParam],
    responses: {
      '200': {
        description: 'Page of eval suite versions.',
        schema: ref('EvalSuiteCollectionPage'),
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No eval suite with that id under this tenant.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/eval-suites/:suiteId/versions/:version',
    openapiPath: '/v1/eval-suites/{suiteId}/versions/{version}',
    operationId: 'evalSuites.versions.get',
    summary: 'Fetch a specific eval suite version',
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [EvalSuiteIdPathParam, EvalSuiteVersionPathParam],
    responses: {
      '200': { description: 'Eval suite at that version.', schema: ref('EvalSuite') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No eval suite at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/eval-suites',
    openapiPath: '/v1/eval-suites',
    operationId: 'evalSuites.publish',
    summary: 'Publish an eval suite',
    description:
      "Body is a full `EvalSuite` — the server validates top-level shape (id, tenantId, semver version, kind ∈ closed enum, spec is an object). Deeper `spec` validation is the runtime consumer's responsibility per kind (eval-judge adapter for `accuracy`/`pairwise`/`regression`, HITL bridge for `human-review`, sandbox handler for `custom`). Re-publishing an existing `(suiteId, version)` returns `409 eval-suite-already-registered`. Idempotency-Key applies (retries with the same key replay the original 201).",
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PublishEvalSuiteBody') },
    responses: {
      '201': { description: 'Eval suite published.', schema: ref('PublishEvalSuiteResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Validation failed (see `details.issues`); or `projectId` isn't a project id (a UUID).",
      ),
      '409': ErrorResponse(
        "`eval-suite-already-registered`: that (id, version) is taken. Or `eval-suite-project-mismatch`: the suite's versions live in another project (a suite belongs to the project its first version was published into and never moves; the message doesn't name the project).",
      ),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/eval-suites/:suiteId/versions/from-judgments',
    openapiPath: '/v1/eval-suites/{suiteId}/versions/from-judgments',
    operationId: 'evalSuites.buildFromJudgments',
    summary: 'Build a test set from judgments',
    description:
      "Publishes a `judged` eval suite version whose cases are copies of judged runs of one agent (optionally one version) or flow, newest first, at most 1000. Each case holds the run's input, what the turn read (`context`), the judged output, and each item's judgments summed up: yes and no counts, the weight behind yes and behind all judgments (an unclassified judgment counts 1), and the reasons. `judgeClassIds` counts only judgments of those classes; `minJudgments` leaves out runs with fewer; `segments` keeps only runs started in that segment path or below it. Needs `admin` on the project.",
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [EvalSuiteIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('BuildJudgedSuiteBody') },
    responses: {
      '201': { description: 'Version published.', schema: ref('BuildJudgedSuiteResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse("Malformed body; or `projectId` isn't a project id (a UUID)."),
      '403': ErrorResponse('`permission-denied`.'),
      '409': ErrorResponse(
        "`eval-suite-already-registered`: that (id, version) is taken. Or `eval-suite-project-mismatch`: the suite belongs to another project than the body's `projectId` (suites never move).",
      ),
      '501': ErrorResponse('`test-sets-not-supported`: this deployment cannot build test sets.'),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/eval-suites/:suiteId/versions/:version/cases',
    openapiPath: '/v1/eval-suites/{suiteId}/versions/{version}/cases',
    operationId: 'evalSuites.listCases',
    summary: 'List the cases of a judged eval suite version',
    description: 'Cursor-paginated, in the order the cases were stored (newest judged run first).',
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [
      EvalSuiteIdPathParam,
      EvalSuiteVersionPathParam,
      LimitQueryParam,
      CursorQueryParam,
    ],
    responses: {
      '200': { description: 'Page of cases.', schema: ref('JudgedEvalCaseCollectionPage') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No eval suite with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/eval-suites/:suiteId/versions/:version/unregister',
    openapiPath: '/v1/eval-suites/{suiteId}/versions/{version}/unregister',
    operationId: 'evalSuites.versions.unregister',
    summary: 'Unregister an eval suite version',
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [EvalSuiteIdPathParam, EvalSuiteVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Unregistered.', schema: ref('UnregisterEvalSuiteResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No eval suite at that (id, version) under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/eval-suites/:suiteId/versions/:version/reinstate',
    openapiPath: '/v1/eval-suites/{suiteId}/versions/{version}/reinstate',
    operationId: 'evalSuites.reinstateVersion',
    summary: 'Reinstate a specific tombstoned eval suite version',
    description:
      'Un-tombstones a previously-unregistered version: clears the tombstone on that version and recomputes the latest active version (refreshes `suiteKind` to match). Restores manifest bytes verbatim (semver hygiene). Idempotent. Publish is always allowed regardless of retirement state.',
    tags: ['eval-suites'],
    security: 'bearer',
    parameters: [EvalSuiteIdPathParam, EvalSuiteVersionPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Reinstated.', schema: ref('ReinstateEvalSuiteVersionResult') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No eval suite at that (id, version) under this tenant.'),
    },
  },

  // ---------- eval runs (data plane) ----------
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
    tags: ['blocks'],
    security: 'bearer',
    parameters: [BlockIdPathParam],
    responses: {
      '200': { description: 'Latest active version.', schema: ref('Block') },
      ...CommonAuthErrors,
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
      "Needs `write` on the project. A prompt's template must parse as Liquid; a settings block's `values` must satisfy its `schema` and the latest version's. A taken version is `409 block-already-registered` (versions never change); a block keeps its kind, and its versions stay in its first version's project (`409 block-project-mismatch`). Idempotency-Key applies.",
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
      '409': ErrorResponse('`block-already-registered` or `block-project-mismatch`.'),
      '404': ErrorResponse(
        "The body's `projectId` names no project of this tenant (`project-not-found`).",
      ),
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
      '403': ErrorResponse('`permission-denied`: no `write` on the project.'),
      '404': ErrorResponse('`block-not-found`.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/eval-suites/:suiteId/runs',
    openapiPath: '/v1/eval-suites/{suiteId}/runs',
    operationId: 'evalRuns.start',
    summary: 'Start an eval run against a suite',
    description:
      'Dispatches an eval run against the latest version of the suite. Exactly one of `agentRef` / `flowRef` is required — the subject the suite evaluates. Dispatch is per-kind: `accuracy` runs the subject once per case and grades via a configured judge; other kinds return `422 dispatcher-not-registered` unless the deployment registers a dispatcher for them. Idempotency-Key applies.',
    tags: ['eval-runs'],
    security: 'bearer',
    parameters: [EvalSuiteIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('StartEvalRunBody') },
    responses: {
      '201': { description: 'Eval run started.', schema: ref('StartEvalRunResult') },
      ...CommonMutationErrors,
      '400': ErrorResponse(
        "Malformed body (both / neither of `agentRef` / `flowRef`, dispatcher-input-invalid); or `projectId` isn't a project id (a UUID).",
      ),
      '404': ErrorResponse(
        'No eval suite with that id under this tenant; or `projectId` names no project of this tenant (`project-not-found`).',
      ),
      '422': ErrorResponse('No dispatcher registered for the suite kind.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/eval-runs',
    openapiPath: '/v1/eval-runs',
    operationId: 'evalRuns.list',
    summary: 'List eval runs',
    description:
      'Cursor-paginated. Filters: `?suiteId=` / `?status=` / `?agentId=` / `?flowId=` / `?from=` / `?to=`. Sort order: startedAt descending, runId descending as tie-breaker.',
    tags: ['eval-runs'],
    security: 'bearer',
    parameters: [
      LimitQueryParam,
      CursorQueryParam,
      EvalRunSuiteIdFilterQueryParam,
      EvalRunStatusFilterQueryParam,
      EvalRunAgentIdFilterQueryParam,
      EvalRunFlowIdFilterQueryParam,
      EvalRunFromFilterQueryParam,
      EvalRunToFilterQueryParam,
      ScopeKindQueryParam,
      ScopeIdQueryParam,
      InheritQueryParam,
    ],
    responses: {
      '200': { description: 'Page of eval runs.', schema: ref('EvalRunCollectionPage') },
      ...CommonAuthErrors,
      '400': ErrorResponse('Malformed query parameter (unknown `status`).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/eval-runs/:runId',
    openapiPath: '/v1/eval-runs/{runId}',
    operationId: 'evalRuns.get',
    summary: 'Fetch an eval run',
    tags: ['eval-runs'],
    security: 'bearer',
    parameters: [EvalRunIdPathParam],
    responses: {
      '200': { description: 'Eval run.', schema: ref('EvalRun') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No eval run with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/eval-runs/:runId/cancel',
    openapiPath: '/v1/eval-runs/{runId}/cancel',
    operationId: 'evalRuns.cancel',
    summary: 'Cancel an eval run',
    description: 'Best-effort cancel. Returns 409 when the run is already terminal.',
    tags: ['eval-runs'],
    security: 'bearer',
    parameters: [EvalRunIdPathParam],
    responses: {
      '200': { description: 'Cancel accepted.', schema: ref('EvalRun') },
      ...CommonAuthErrors,
      '404': ErrorResponse('No eval run with that id under this tenant.'),
      '409': ErrorResponse('Run already terminal.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/eval-runs/:runId/events',
    openapiPath: '/v1/eval-runs/{runId}/events',
    operationId: 'evalRuns.events',
    summary: 'Stream eval-run events (SSE)',
    description:
      'Server-Sent Events. Per-case progress events (`eval-run.case-completed` / `eval-run.case-failed`) followed by a terminal event (`eval-run.completed` / `eval-run.failed` / `eval-run.cancelled`) carrying the aggregate result. Mirrors `/v1/runs/:runId/stream` structurally.',
    tags: ['eval-runs'],
    security: 'bearer',
    parameters: [EvalRunIdPathParam, LastEventIdParam],
    responses: {
      '200': {
        description: 'Server-Sent Event stream (`text/event-stream`).',
        contentType: 'text/event-stream',
      },
      ...CommonAuthErrors,
      '404': ErrorResponse('No eval run with that id under this tenant.'),
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
      "Returns the tenant's identity providers (OIDC, SAML, OAuth 2.0), each with `signIn` when the deployment sets it. Secrets appear only as REFERENCES (`clientSecretRef`, `spSigningKeyRef`…); a plaintext secret is never on the wire.",
    tags: ['auth'],
    security: 'bearer',
    responses: {
      '200': {
        description: 'Page of provider configs.',
        schema: ref('IdentityProviderCollectionPage'),
      },
      ...CommonAuthErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/auth/sign-in-options',
    openapiPath: '/v1/auth/sign-in-options',
    operationId: 'auth.signInOptions',
    summary: 'How a person can sign in',
    description:
      'Public: nobody is signed in yet. With `email`, the ways in for that email\'s domain: the identity providers of the one tenant the domain is verified for (an unverified domain offers none), then any the deployment offers everyone it has added (`owner: deployment`, "Continue with Google"); without, an empty list: sign-in is email first, so nothing is offered before an email. `methods` says which ways in the deployment allows: identity providers, an API token (`POST /v1/auth/token-sign-in`), and an emailed sign-in link (`emailLink`, with a captcha site key when it needs one); `identityProviders` and `apiToken` both `false` when nobody can sign in to the console. Always mounted. The answer depends only on the domain: two people at the same domain get the same answer, whether or not either has an account. Rate-limited per client (`429 rate-limit-exceeded`, with `Retry-After`).',
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
      "The API token in `Authorization` is exchanged once for a browser session in the session cookie (HttpOnly; the same as a sign-in with an identity provider), so the browser never keeps the token. Only a person's full key opens a session: a service account's key, or a narrowed one (a `member` role, or one project), is refused `403 token-sign-in-not-allowed`. The session ends after its lifetime, or when the key expires if sooner. `403 token-sign-in-off` when the deployment doesn't allow it (always mounted, so a console gets that answer); `400 token-sign-in-needs-an-api-token` when the request is already signed in by a session.",
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
        "Not allowed here (`token-sign-in-off`), or not this key (`token-sign-in-not-allowed`): a service account's, or a narrowed one.",
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
    summary: 'Register an identity provider (OIDC, SAML or OAuth 2.0)',
    description:
      'Unique per tenant on `providerId`: re-registering a known provider returns `409 identity-provider-already-registered`; change it with `PATCH /v1/auth/providers/{providerId}`, which keeps its sign-in URLs. Secrets are given by reference (`clientSecretRef`, `spSigningKeyRef`…); a `clientSecret` (or a raw key) is refused with `400 invalid-provider-config`. The deployment may check the configuration (OIDC discovery, SAML metadata): `422 identity-provider-invalid` says what failed. The answer carries the stored provider when the deployment returns it, with `signIn`: what to give the identity provider.',
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
      '422': ErrorResponse(
        'The deployment could not use the configuration (`identity-provider-invalid`).',
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
      '404': ErrorResponse('No identity provider registered with that id under this tenant.'),
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
      '404': ErrorResponse('No identity provider registered with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/login/:providerId',
    openapiPath: '/v1/auth/login/{providerId}',
    operationId: 'auth.login',
    summary: 'Initiate OAuth/OIDC login',
    description:
      'Framework generates `state` + PKCE `code_verifier` (S256 challenge). Caller redirects the user-agent to `authorizationUrl`. Provider redirects back to `redirectUri` with `code` + `state`; caller POSTs those to `/v1/auth/callback/:providerId` to complete the flow. When the provider config populated `allowedRedirectUris`, the effective redirect_uri MUST be an exact match — otherwise `400 redirect-uri-not-allowed`.',
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
    requestBody: { required: false, schema: ref('LoginBody') },
    responses: {
      '200': {
        description: 'Authorization URL + PKCE parameters.',
        schema: ref('AuthorizationResponse'),
      },
      ...CommonMutationErrors,
      '404': ErrorResponse('No identity provider registered with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/callback/:providerId',
    openapiPath: '/v1/auth/callback/{providerId}',
    operationId: 'auth.callback',
    summary: 'Complete an OAuth/OIDC callback',
    description:
      "Public — the caller has not yet obtained a session token. Verifies `state`, exchanges `code` for provider tokens via the deployment's `exchangeCode`, fetches userinfo, and persists a session via `SessionStoreBinding`. Returns an opaque `kgi_sk_*` session token the caller uses on subsequent requests. The underlying provider access-token never leaves the server. When the provider config populated `allowedRedirectUris`, the stored redirect_uri is re-checked against the current allowlist — a mismatch (allowlist tightened between login and callback) returns `400 redirect-uri-mismatch`.",
    tags: ['auth'],
    security: 'public',
    parameters: [
      {
        name: 'providerId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
    ],
    requestBody: { required: true, schema: ref('CallbackBody') },
    responses: {
      '201': { description: 'Session created.', schema: ref('CallbackResult') },
      '400': ErrorResponse('Malformed body or `state` unknown/expired/consumed.'),
      '422': ErrorResponse('Code exchange with the provider failed.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/auth/refresh',
    openapiPath: '/v1/auth/refresh',
    operationId: 'auth.refresh',
    summary: 'Refresh the current session token',
    description:
      'Requires a session token (`kgi_sk_*`); bearer tokens are managed via `/v1/tokens`. When the deployment wired a `refreshToken` callback and the provider issued a refresh token, provider tokens rotate too; otherwise only the framework session token rotates. OAuth 2.1 BCP refresh-token rotation: the OLD session token is invalidated (marked rotated) — reusing it after refresh returns `401 refresh-token-invalid` so compliant clients can retry with the fresh token instead of prompting a re-auth. A browser session (the session cookie) is not refreshed: `400 cookie-session-not-refreshable`, so a new token never reaches page scripts; it ends at its TTL.',
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
        'Caller presented a bearer token (refresh is session-only), or a browser session (cookie).',
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
      "Adds a person to the tenant as a tenant member, written before it answers: they can read the tenant's settings (providers, policies, adapters, signing keys, deployments), not its projects. Give them a role to work (project or team membership, or tenant admin), then mint their first API key at `POST /v1/tokens` with `for`. Tenant admins only. Mounted when the identity directory can add people.",
    tags: ['identity'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('CreateUserBody') },
    responses: {
      '201': { description: 'The new person.', schema: ref('UserRecord') },
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
      '403': ErrorResponse('Not a tenant admin.'),
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
      "Atomic transaction: check the signing key against the tenant's trust list (the `signingKeyRegistry` binding), verify the Ed25519 signature over the canonical envelope, read the image's `/app/index.json` and verify it hashes to the signed `indexHash` and names the signed `artifactVersion` (`ImageRegistryBinding`), validate every tool / guardrail / agent / flow it declares (the image's index is what registers; the request carries none), upsert into the corresponding registries, then record the deployment. All-or-nothing rollback on any failure. Idempotency: same `imageDigest` re-submitted returns 200 with the existing record (no new version bump). `Idempotency-Key` also applies at the HTTP layer.",
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
        "Idempotency-Key was reused with a different body, or resource-state conflict. Or `tool-project-mismatch`, `agent-project-mismatch` or `flow-project-mismatch`: one of the image's tools, agents or flows belongs to another project (`details.primitive`, `details.id`; the message doesn't name the project); nothing was deployed, even when it was unchanged. Or `registry-read-only`: this registry takes no writes (under `kindgi dev`, the pack's files are the source); the message says what to do instead.",
      ),
      '400': ErrorResponse(
        'Signature invalid, image unverifiable, or deployment-validation-failed with per-primitive `details[]`.',
      ),
      '403': ErrorResponse("Signer key not on the tenant's trust list."),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/deployments',
    openapiPath: '/v1/deployments',
    operationId: 'deployments.list',
    summary: 'List signed deployments',
    description:
      'Cursor-paginated. Sort order: `activatedAt` descending (binding-defined tiebreak on `deploymentId`). Optional `?imageRefPrefix=` narrows to deployments whose `imageRef` starts with the prefix; `?signerKeyId=` narrows to a specific signing key (useful for revocation audits).',
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
    ],
    responses: {
      '200': {
        description: 'Page of deployments.',
        schema: ref('DeploymentCollectionPage'),
      },
      ...CommonAuthErrors,
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
      '404': ErrorResponse('No deployment with that id under this tenant.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/deployments/:deploymentId/secrets',
    openapiPath: '/v1/deployments/{deploymentId}/secrets',
    operationId: 'deployments.syncSecrets',
    summary: 'Sync secrets against a deployment',
    description:
      'Deployment-scoped bulk secret sync. Body carries `{ envName, secrets: Array<{ name, ref } | { name, value }> }`. `{ name, ref }` entries validate against `SecretBinding.get` — no bytes cross the wire; missing → 404 `secret-not-found`. `{ name, value }` entries write via `SecretBinding.set` with `writeMode: add-version` + `tags.deployment = deploymentId` and return the created reference. The write scope is derived from the deployment record itself (tenant scope, or project scope when the deployment carries a `projectId`) and CANNOT be overridden on the wire. Requires the `secrets:write` capability. Idempotency-Key applies.',
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
      '403': ErrorResponse('Bearer token missing `secrets:write` capability.'),
      '404': ErrorResponse('No deployment with that id, or referenced secret does not exist.'),
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
      '404': ErrorResponse('Signing key id unknown, or signing not configured on this deployment.'),
    },
  },

  // ---------- audit query surface (unified audit substrate) ----------
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
      "A tombstone, not an erase: from then on the org is gone from get and list, and its slug is free for a new org. Its projects and teams stay, without an org; when one of those projects has the slug of a project that has none, nothing is deleted: `409 slug-conflict` names the slugs (rename or move those projects first). In the Kindgi runtime, the org's own secrets and secret mappings are deleted with it, for good, and its own environments and MCP endpoints are unregistered. A retention policy on the `org` domain purges the org's row. Idempotent: deleting an unknown or already-deleted org returns 204.",
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
        "slug-conflict: the org's projects would leave it with slugs that projects without an org already have.",
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
      'Cursor-paginated. Sort order is binding-defined (for example `joinedAt` ascending).',
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
      'Idempotent on `(teamId, userId)` — re-adding an existing member with a different role does NOT overwrite; use PATCH for role changes.',
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
      '404': ErrorResponse('No team with that id under this tenant.'),
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
    },
  },
  {
    method: 'get',
    honoPath: '/v1/projects/:projectId/memberships',
    openapiPath: '/v1/projects/{projectId}/memberships',
    operationId: 'projects.memberships.list',
    summary: 'List direct memberships of a project',
    description:
      'Cursor-paginated. Direct-grant memberships only — team-mediated grants are resolved through the FGA store per tenant.',
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
      'Names the person by exactly one of `userId` and `email` (matched as the runtime matches emails when it adds a person); someone who is not a person of this tenant, or was removed from it, is refused with 404 `identity-user-not-found`. Idempotent on `(projectId, userId)` — re-adding an existing member with a different role does NOT overwrite; use PATCH for role changes.',
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
      '404': ErrorResponse(
        'No project with that id under this tenant (`project-not-found`), or the person named is not a member of this tenant (`identity-user-not-found`).',
      ),
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
      'Returns the tenant the bearer token authenticates as. There is no `/v1/tenants` collection — tenants are the sovereignty boundary, not a listable resource under a tenant.',
    tags: ['tenant'],
    security: 'bearer',
    responses: {
      '200': { description: 'Tenant.', schema: ref('Tenant') },
      ...CommonAuthErrors,
      '404': ErrorResponse('The tenant id on the token does not resolve to a stored row.'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/tenant/config',
    openapiPath: '/v1/tenant/config',
    operationId: 'tenant.config.list',
    summary: "List the tenant's config entries",
    description:
      'Cursor-paginated: the env entries (in the env binding order), then the secret entries (in the secrets binding order); a page holds at most `limit` entries and `nextCursor` resumes where it ended. Optional `?kind=` narrows to one slot (env / config / secret); `?keyPrefix=` matches on entry key. **Secret values are ALWAYS redacted on this admin surface** — the dispatch path is the only reader that receives raw material.',
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
      'Set / update an entry keyed by `(kind, key)`. Optional `ifRevision` provides optimistic-concurrency: the write fails with `tenant-config-revision-conflict` (409) unless the stored revision matches. Omit for last-write-wins.',
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
      '409': ErrorResponse('`ifRevision` was set and did not match the stored revision.'),
    },
  },

  // ---------- env ----------
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
      '409': ErrorResponse('`ifRevision` mismatch (env-write-conflict).'),
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
      'Cursor-paginated list of secret metadata at the given `(scope, envName)`. `value` is ALWAYS absent (structural redaction).',
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
    ],
    responses: {
      '200': {
        description: 'Page of secret metadata.',
        schema: ref('SecretCollectionPage'),
      },
      ...CommonAuthErrors,
      '400': ErrorResponse('Missing or malformed scope / envName.'),
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
      '400': ErrorResponse('Missing or malformed scope / envName.'),
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
      '403': ErrorResponse('Bearer token missing `secrets:write` capability.'),
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
      '403': ErrorResponse('Bearer token missing `secrets:rotate` capability.'),
      '404': ErrorResponse('Unknown secret.'),
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
      'Requires the `secrets:revoke` capability (soft-revoke) or `secrets:revoke:hard` when `?hard=true` (cryptographic erasure). Optional `?reason=<text>` records the revoke reason.',
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
        description: 'Set to `true` to perform cryptographic erasure.',
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
      '400': ErrorResponse('Missing or malformed scope / envName.'),
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
      'Registers a `kind=cron` trigger. `nextFireAt` is precomputed from the cron expression at register time; the cron scheduler in the runtime fires due triggers. Malformed cron expressions return 400 `trigger-invalid-config` without registering.',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterScheduleBody') },
    responses: {
      '201': { description: 'Schedule registered.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
    },
  },
  {
    method: 'get',
    honoPath: '/v1/schedules',
    openapiPath: '/v1/schedules',
    operationId: 'schedules.list',
    summary: 'List cron schedules',
    description:
      'Cursor-paginated. Tombstoned rows excluded. Optional `?status=active|paused` filter.',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam, TriggerStatusFilterQueryParam],
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
      'Partial merge on `config`. If `config.cronExpression` changes, `nextFireAt` is recomputed. `label: null` clears the label; omit to leave unchanged. Malformed cron expressions return 400 `trigger-invalid-config`.',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PatchScheduleBody') },
    responses: {
      '200': { description: 'Updated schedule.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No cron trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/schedules/:triggerId/pause',
    openapiPath: '/v1/schedules/{triggerId}/pause',
    operationId: 'schedules.pause',
    summary: 'Pause a cron schedule',
    description:
      'Idempotent-per-state: pausing an already-paused row returns 409 `trigger-already-in-state`.',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Paused schedule.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
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
      'Recomputes `nextFireAt` so the scheduler picks up the resumed row on its next tick.',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Resumed schedule.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
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
      'Tombstones the schedule; the cron scheduler ignores tombstoned triggers. Retention may hard-remove tombstoned triggers after the tombstone window.',
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Tombstone outcome.', schema: ref('ScheduleUnregisterResult') },
      ...CommonMutationErrors,
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
    method: 'post',
    honoPath: '/v1/schedules/:triggerId/run-now',
    openapiPath: '/v1/schedules/{triggerId}/run-now',
    operationId: 'schedules.runNow',
    summary: 'Run a schedule now',
    description:
      "One fire outside the schedule (`manual: true` in its history), starting one run as the schedule's owner. The schedule's next occurrence is unchanged.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '202': {
        description: 'The fire; its run starts in the background.',
        schema: ref('ScheduleFire'),
      },
      ...CommonMutationErrors,
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
      "The caller becomes the schedule's owner, so its runs act as the caller from the next fire. Needs `admin` on the schedule's project and `execute` on what it runs. For a schedule whose owner left or lost access.",
    tags: ['schedules'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'The schedule, with its new owner.', schema: ref('ScheduleRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No cron trigger with that id.'),
      '501': ErrorResponse(
        "`trigger-operation-unsupported`: this deployment can't change a schedule's owner.",
      ),
    },
  },

  // ---------- event-triggers (trigger surface) ----------
  {
    method: 'post',
    honoPath: '/v1/event-triggers',
    openapiPath: '/v1/event-triggers',
    operationId: 'eventTriggers.register',
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
    summary: 'Soft-delete an event trigger (tombstone)',
    tags: ['event-triggers'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Tombstone outcome.', schema: ref('EventTriggerUnregisterResult') },
      ...CommonMutationErrors,
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
      'Registers a `kind=webhook` trigger. The route mints `webhookId` (a random UUID). Caller must have written the plaintext HMAC secret to `/v1/secrets` first and passes the resulting name as `hmacSecretName` — the trigger never stores the plaintext. Rotation flows through `POST /v1/secrets/:name/rotate`.',
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('RegisterWebhookTriggerBody') },
    responses: {
      '201': { description: 'Webhook registered.', schema: ref('WebhookTriggerRecord') },
      ...CommonMutationErrors,
      '409': ErrorResponse('Route-minted webhookId collided (astronomically rare).'),
    },
  },
  {
    method: 'get',
    honoPath: '/v1/webhooks',
    openapiPath: '/v1/webhooks',
    operationId: 'webhooks.list',
    summary: 'List webhook triggers',
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [LimitQueryParam, CursorQueryParam, TriggerStatusFilterQueryParam],
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
      'HMAC secret rotation is NOT here — rotate via `POST /v1/secrets/:name/rotate` on the referenced secret.',
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    requestBody: { required: true, schema: ref('PatchWebhookTriggerBody') },
    responses: {
      '200': { description: 'Updated webhook trigger.', schema: ref('WebhookTriggerRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No webhook trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhooks/:triggerId/pause',
    openapiPath: '/v1/webhooks/{triggerId}/pause',
    operationId: 'webhooks.pause',
    summary: 'Pause a webhook trigger',
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Paused webhook.', schema: ref('WebhookTriggerRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No webhook trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhooks/:triggerId/resume',
    openapiPath: '/v1/webhooks/{triggerId}/resume',
    operationId: 'webhooks.resume',
    summary: 'Resume a webhook trigger',
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Resumed webhook.', schema: ref('WebhookTriggerRecord') },
      ...CommonMutationErrors,
      '404': ErrorResponse('No webhook trigger with that id.'),
    },
  },
  {
    method: 'post',
    honoPath: '/v1/webhooks/:triggerId/unregister',
    openapiPath: '/v1/webhooks/{triggerId}/unregister',
    operationId: 'webhooks.unregister',
    summary: 'Soft-delete a webhook trigger (tombstone)',
    tags: ['webhooks'],
    security: 'bearer',
    parameters: [TriggerIdPathParam, IdempotencyKeyParam],
    responses: {
      '200': { description: 'Tombstone outcome.', schema: ref('WebhookTriggerUnregisterResult') },
      ...CommonMutationErrors,
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
      '400': ErrorResponse(
        'Malformed body or unknown field; the deployment refuses the URL (`webhook-url-refused`); the referenced secret does not exist (`webhook-secret-not-found`) or is too weak (`webhook-secret-too-weak`).',
      ),
      '404': ErrorResponse('`filter.projectId` names no project (`project-not-found`).'),
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
      '400': ErrorResponse(
        'Malformed body or unknown field; the deployment refuses the URL (`webhook-url-refused`); the referenced secret does not exist or is too weak.',
      ),
      '404': ErrorResponse('No endpoint with that id, or `filter.projectId` names no project.'),
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
      '404': ErrorResponse('No endpoint with that id.'),
    },
  },
] as const;

/** Utility used by both the generator and the drift test. */
export function honoToOpenapiPath(honoPath: string): string {
  return honoPath.replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g, '{$1}');
}

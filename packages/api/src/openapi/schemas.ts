// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * JSON Schemas for every request + response body on the platform API.
 *
 * Authored as plain draft-2020-12 JSON Schema objects — OpenAPI 3.1
 * uses JSON Schema draft-2020-12 as its schema dialect, so these values
 * drop directly into the generated document under `components.schemas`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY TWO SOURCES OF TRUTH FOR DOMAIN SHAPES (@kindgi/specs + this file)
 * ─────────────────────────────────────────────────────────────────────
 *
 * The workspace intentionally keeps two shape sources, at two layers:
 *
 *   1. `@kindgi/specs/*.schema.json` — the CANONICAL DOMAIN shape (Agent, Flow,
 *      Tool, Event, Policy, RunEvent, ...). Language-agnostic JSON
 *      Schema draft-2020-12. Packages that validate against one at runtime
 *      (Ajv) bundle a copy into `src/` for offline validation; a drift test
 *      in each such package enforces equality with `@kindgi/specs`.
 *
 *   2. `packages/api/src/openapi/schemas.ts` (this file) — the WIRE
 *      shape. Includes request/response bodies, collection pages,
 *      pagination envelopes, discriminated error responses, patch
 *      bodies. Some entries are byte-equal MIRRORS of a `@kindgi/specs` shape
 *      (Agent, Flow, Guardrail, EvalSuite, ComplianceEvidence).
 *      Others are LEGITIMATE WIRE-SIDE VARIANTS — e.g. ProvenanceRecord
 *      wraps the DAG in a `dag` field for future-extensibility; Policy
 *      uses a `kind + spec` discriminant broader than the original
 *      access-control-only spec; Tool drops `version` from required[]
 *      because tool refs dispatch via semver ranges, not exact pins.
 *
 * WHY NOT CONSOLIDATE:
 *   - Making `@kindgi/specs` the single source (generate wire from it): the
 *     wire legitimately transforms + adds wire-only shapes (Register
 *     bodies, CollectionPage, patch bodies) that aren't canonical
 *     domain concerns. Codegen from specs would produce a subset.
 *   - Making wire the single source (generate specs from it): specs is
 *     language-agnostic and consumed by non-TS tools + auditors +
 *     bundled at runtime; putting the source in TS pollutes that.
 *   - Zod-as-source (both derive): Zod → JSON Schema fidelity gaps on
 *     `patternProperties`, `$comment` version markers, and long
 *     descriptions.
 *
 * HOW WE PREVENT SILENT DRIFT:
 *   For shapes that appear in BOTH sources, `packages/api/tests/
 *   schema-drift.test.ts` asserts `required[]` matches on aligned
 *   pairs (Agent, ComplianceEvidence, EvalSuite, Flow, Guardrail) and
 *   documents legitimate divergences (Capability, Policy, Provenance,
 *   Tool). Wire-only shapes (Register bodies, CollectionPage, etc.)
 *   live only here and have no `@kindgi/specs` counterpart.
 *
 * WHEN ADDING A NEW SHAPE:
 *   - If it's a canonical domain shape (crosses persistence + runtime
 *     validation): add to `@kindgi/specs/*.schema.json`, bundle
 *     into the owning package, mirror here, add a drift test entry.
 *   - If it's wire-only (Register body, patch body, pagination page):
 *     add here only. No `@kindgi/specs` entry needed.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Routes do not validate request bodies against these objects;
 * per-route parsers in `routes/*.ts` validate ad hoc.
 */

import { EVIDENCE_KINDS } from '@kindgi/compliance';
import { MAX_TOOL_ERROR_RETRIES, POLICY_KINDS, TOOL_ERROR_KINDS } from '@kindgi/policy-contract';

export type JsonSchema = Record<string, unknown>;

// ---------------- shared shapes ----------------

export const WireErrorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'requestId'],
      properties: {
        code: {
          type: 'string',
          description:
            'Stable machine-readable discriminant. Values match domain error codes (see `docs/API-ROUTE-CONVENTIONS.md` §4.3).',
        },
        message: { type: 'string' },
        details: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional, kind-specific.',
        },
        requestId: {
          type: 'string',
          description: 'Server-assigned request id; also echoed via `X-Request-Id` header.',
        },
      },
    },
  },
};

export const HealthResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', const: true },
  },
};

/**
 * `projectId` on a publish / register / start body. The routes require
 * it: the item is stored under that project, and a missing id, or one
 * that isn't a project of the caller's tenant, answers `400 bad-input`.
 */
const ContentProjectIdProperty: JsonSchema = {
  type: 'string',
  format: 'uuid',
  description:
    "Project this belongs to (its content scope). Required: missing, or not a project in the caller's tenant → `400 bad-input`.",
};

// ---------------- run resource ----------------

export const RunStatusSchema: JsonSchema = {
  type: 'string',
  enum: ['pending', 'running', 'suspended', 'completed', 'failed', 'cancelled'],
};

/**
 * The agent a run is a turn of. A component of its own, so generated
 * clients name it `RunAgent` (not after the `agent` property).
 */
export const RunAgentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'conversationId'],
  description:
    "Set on an agent's turn (an agent run, or the turn a flow's agent step started): the agent, the version that ran and the conversation. Absent on other runs, and on turns that ran before Kindgi 0.1.3.",
  properties: {
    id: { type: 'string', description: 'The agent id.' },
    version: { type: 'string', description: 'The agent version that ran (semver).' },
    conversationId: { type: 'string', format: 'uuid' },
  },
};

export const RunSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'tenantId',
    'flowId',
    'flowVersion',
    'status',
    'dryRun',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'RunId.' },
    tenantId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    flowId: { type: 'string' },
    flowVersion: { type: 'string', description: 'Semver.' },
    status: RunStatusSchema,
    dryRun: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
    failureMessage: { type: 'string' },
    output: {
      description:
        "The run's output once it completed. Present on single-run responses; on lists only with `?include=output`.",
    },
    parentRunId: {
      type: 'string',
      format: 'uuid',
      description:
        'Set on a child run (a sub-flow run, or the agent turn an agent step started): the run that started it.',
    },
    parentNodeId: {
      type: 'string',
      description: 'Set on a child run: the node in the parent run that started it.',
    },
    agent: { $ref: '#/components/schemas/RunAgent' },
    replayOf: {
      type: 'string',
      format: 'uuid',
      description: 'Set on a replay run (an eval run re-running a past run): the run it replays.',
    },
    evalRunId: {
      type: 'string',
      description: 'Set on a replay run: the eval run that started it.',
    },
    publicAccessToken: {
      type: 'string',
      description:
        'Only in the response to `POST /v1/runs`, when the deployment issues public run tokens: a read-only token for this run (and its descendants) to hand to a browser, for `GET /v1/runs/{runId}/progress` and its stream.',
    },
    publicAccessTokenExpiresAt: {
      type: 'string',
      format: 'date-time',
      description: 'When `publicAccessToken` stops working.',
    },
  },
};

export const RunProgressSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "A run's progress: status and timing, without its input, output, failure message or tenant. Safe to show in a browser.",
  required: ['id', 'flowId', 'flowVersion', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'RunId.' },
    flowId: { type: 'string' },
    flowVersion: { type: 'string' },
    status: RunStatusSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
    parentRunId: { type: 'string', format: 'uuid' },
  },
};

export const StartRunOptionsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dryRun: {
      type: 'boolean',
      description:
        'When true, the run executes with side-effects mocked; the row is marked `dryRun: true`.',
    },
    wait: {
      type: 'boolean',
      description:
        'When false, respond `202` as soon as the run exists and finish it in the background; poll `GET /v1/runs/{runId}` for its status and output. Default true: respond `201` once the run completes, fails or suspends.',
    },
  },
};

export const StartRunBodySchema: JsonSchema = {
  description:
    'Start a run. Exactly one of `agent` or `flow` MUST be supplied (single Run primitive).',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['agent', 'input'],
      properties: {
        agent: { type: 'string', description: 'AgentId.' },
        agentVersion: { type: 'string', description: 'Semver; omit → latest.' },
        projectId: {
          type: 'string',
          format: 'uuid',
          description: "Project to run under; omit → the tenant's Default project.",
        },
        input: {
          description: 'Opaque payload forwarded to the agent binding.',
        },
        options: StartRunOptionsSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['flow', 'input'],
      properties: {
        flow: { type: 'string', description: 'FlowId.' },
        flowVersion: { type: 'string', description: 'Semver; omit → latest.' },
        projectId: {
          type: 'string',
          format: 'uuid',
          description: "Project to run under; omit → the tenant's Default project.",
        },
        input: {
          description: 'Opaque payload forwarded to the flow runtime.',
        },
        options: StartRunOptionsSchema,
      },
    },
  ],
};

export const ResumeRunBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['waitpointId'],
  properties: {
    waitpointId: {
      type: 'string',
      minLength: 1,
      description:
        'Token id of the pending waitpoint to complete. Ids starting with `child:` are reserved for the runtime. Resuming without a waitpoint id returns `400 bad-input`.',
    },
    value: {
      description: 'Resolved value passed back into the flow handler that suspended.',
    },
  },
};

export const RunCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: RunSchema },
    nextCursor: {
      type: 'string',
      description:
        'Opaque cursor for the next page. Absent when `hasMore: false`. See `docs/API-ROUTE-CONVENTIONS.md` §5.',
    },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- run journal ----------------

export const JournalKindSchema: JsonSchema = {
  type: 'string',
  description:
    'Runtime journal kind (bare — distinct from the SSE-only `run.*-*` wire enum in `@kindgi/specs/run-event.schema.json`).',
};

export const JournalEntrySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'kind', 'timestamp'],
  properties: {
    sequence: { type: 'integer', minimum: 0 },
    kind: JournalKindSchema,
    nodeId: { type: 'string' },
    payload: {},
    timestamp: {
      oneOf: [
        { type: 'string', format: 'date-time' },
        { type: 'string', description: 'ISO 8601 timestamp (Timestamp brand).' },
      ],
    },
  },
};

export const RunJournalPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: JournalEntrySchema },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- SSE (wire) run events ----------------

/**
 * Mirror of `@kindgi/specs/run-event.schema.json` inlined here rather than
 * `$ref`'d to keep the emitted OpenAPI doc self-contained. Kept in sync
 * by the drift test in `tests/openapi.test.ts` — if this ever falls out
 * of step with the file spec, the test fails.
 */
export const RunEventSchema: JsonSchema = {
  type: 'object',
  required: ['eventId', 'runId', 'tenantId', 'timestamp', 'kind'],
  additionalProperties: false,
  properties: {
    eventId: {
      type: 'string',
      minLength: 1,
      description:
        'Monotonic event id within the run. Sent as the SSE `id:` line and echoed back via `Last-Event-Id` on reconnect.',
    },
    runId: { type: 'string', minLength: 1 },
    tenantId: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', format: 'date-time' },
    kind: {
      type: 'string',
      enum: [
        'run.queued',
        'run.started',
        'run.step-started',
        'run.step-completed',
        'run.step-failed',
        'run.step-retry-scheduled',
        'run.iteration-started',
        'run.iteration-completed',
        'run.tool-invoked',
        'run.tool-result',
        'run.model-token',
        'run.artifact-produced',
        'run.guardrail-violated',
        'run.wait-suspended',
        'run.wait-resumed',
        'run.approval-requested',
        'run.approval-completed',
        'run.completed',
        'run.failed',
        'run.cancelled',
      ],
    },
    sequence: { type: 'integer', minimum: 0 },
    nodeId: { type: 'string' },
    payload: {},
  },
};

export const RunProgressEventSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'A run event without its payload: what happened, on which node, when.',
  required: ['eventId', 'runId', 'timestamp', 'kind', 'sequence'],
  properties: {
    eventId: {
      type: 'string',
      minLength: 1,
      description: 'Sent as the SSE `id:` line; echo it back in `Last-Event-Id` to resume.',
    },
    runId: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', format: 'date-time' },
    kind: { type: 'string' },
    sequence: { type: 'integer', minimum: 0 },
    nodeId: { type: 'string' },
  },
};

// ---------------- tokens ----------------

const ApiTokenRoleSchema: JsonSchema = {
  type: 'string',
  enum: ['admin', 'member'],
  description:
    "The key's role in its tenant: `admin` administers the tenant (and manages keys); `member` belongs to it and administers nothing.",
};

const ApiTokenCapabilitiesSchema: JsonSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 100 },
  description:
    'Framework capabilities the key carries (`env:write`, `secrets:write`, …). A caller can only grant capabilities it holds.',
};

export const MintTokenBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: {
      ...ApiTokenRoleSchema,
      description: `${ApiTokenRoleSchema.description} Default \`member\`.`,
    },
    capabilities: {
      ...ApiTokenCapabilitiesSchema,
      description: `${ApiTokenCapabilitiesSchema.description} Default none.`,
    },
    label: { type: 'string', description: 'Optional human-readable label.' },
    expiresAt: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp.' },
    projectId: { type: 'string', format: 'uuid' },
  },
};

export const ApiTokenSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'An API key: a service account in its tenant. Never includes the secret.',
  required: ['tokenId', 'role', 'capabilities', 'createdAt'],
  properties: {
    tokenId: { type: 'string', format: 'uuid' },
    role: ApiTokenRoleSchema,
    capabilities: ApiTokenCapabilitiesSchema,
    label: { type: 'string' },
    projectId: { type: 'string', format: 'uuid' },
    createdBy: {
      type: 'string',
      description: 'Who minted it: `user:<id>` or `service_account:<tokenId>`.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    revokedAt: {
      type: 'string',
      format: 'date-time',
      description: 'Set once revoked; a revoked key never authenticates again.',
    },
    lastUsedAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the key last authenticated a request (updated at most once a minute).',
    },
  },
};

export const MintTokenResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'The new key, plus its secret.',
  required: [...(ApiTokenSchema.required as readonly string[]), 'token'],
  properties: {
    ...(ApiTokenSchema.properties as Record<string, JsonSchema>),
    token: {
      type: 'string',
      description: 'Plaintext bearer token. Returned exactly once at mint time.',
    },
  },
};

export const ApiTokenPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: ApiTokenSchema },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- HITL (approvals) ----------------

export const ReviewerRoleSchema: JsonSchema = {
  type: 'string',
  enum: ['standard', 'senior', 'admin'],
  description: 'Reviewer role class. Hierarchy: standard < senior < admin.',
};

export const ApprovalStatusSchema: JsonSchema = {
  type: 'string',
  enum: [
    'pending',
    'assigned',
    'in_review',
    'approved',
    'rejected',
    'escalated',
    'expired',
    'withdrawn',
  ],
};

export const ReviewDecisionKindSchema: JsonSchema = {
  type: 'string',
  enum: ['approve', 'reject', 'escalate', 'withdraw'],
};

export const ApprovalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'tenantId',
    'subjectKind',
    'subjectRef',
    'requiredRole',
    'status',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    subjectKind: { type: 'string' },
    subjectRef: { type: 'object', additionalProperties: true },
    requiredRole: ReviewerRoleSchema,
    status: ApprovalStatusSchema,
    assignedTo: { type: 'string', format: 'uuid' },
    batchKey: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    context: { type: 'object', additionalProperties: true },
    provenanceRef: {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: {
        runId: { type: 'string', format: 'uuid' },
        provenanceId: { type: 'string', format: 'uuid' },
      },
    },
    waitTokenId: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    decidedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    decision: {
      description:
        "The reviewer's decision, once one is recorded. Absent while the approval is open, and when it ended without one (it expired, or a timeout escalated it).",
      $ref: '#/components/schemas/ApprovalDecisionRecord',
    },
  },
};

export const ApprovalDecisionRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reviewerId', 'reviewerRoleAtDecision', 'decidedAt'],
  properties: {
    decision: ReviewDecisionKindSchema,
    decidedBy: {
      type: 'string',
      description:
        "Who decided, as an actor: `user:<userId>`, the reviewer's user. The run's journal and provenance name the decider the same way. The Kindgi runtime always records it; a deployment whose HITL binding doesn't leaves it out.",
    },
    reviewerId: { type: 'string', format: 'uuid' },
    reviewerRoleAtDecision: ReviewerRoleSchema,
    decidedAt: { type: 'string', format: 'date-time' },
    rationale: { type: 'string' },
  },
};

export const ReviewDecisionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'approvalId', 'reviewerId', 'decision', 'reviewerRoleAtDecision', 'decidedAt'],
  properties: {
    id: { type: 'string' },
    approvalId: { type: 'string', format: 'uuid' },
    reviewerId: { type: 'string', format: 'uuid' },
    decision: ReviewDecisionKindSchema,
    rationale: { type: 'string' },
    reviewerRoleAtDecision: ReviewerRoleSchema,
    decidedAt: { type: 'string', format: 'date-time' },
  },
};

export const ApprovalCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Approval' } },
    nextCursor: {
      type: 'string',
      description:
        'Opaque cursor for the next page. ISO timestamp of the tail row internally; treat as opaque on the client.',
    },
    hasMore: { type: 'boolean' },
  },
};

export const CompleteApprovalBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: ReviewDecisionKindSchema,
    rationale: { type: 'string' },
    value: {
      description:
        "Payload passed to the run waitpoint (`RunBinding.completeToken`) when the approval is linked to a suspended run and the decision is `approve` or `reject`. Refused (400 `bad-input`) for an agent's tool-call or session gate (`tool-call:pending`, `agent-turn:session-hitl-gate`): those resume on the decision alone.",
    },
  },
};

export const ReviewerSchema: JsonSchema = {
  description:
    'Reviewer roster row. Deactivation is soft (audit trail survives offboarding). `deactivatedAt` present → reviewer no longer receives approvals.',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'userId', 'role', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'ReviewerId.' },
    tenantId: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    role: ReviewerRoleSchema,
    displayName: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    deactivatedAt: { type: 'string', format: 'date-time' },
  },
};

export const ReviewerCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Reviewer' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

export const RegisterReviewerBodySchema: JsonSchema = {
  description:
    "Register a reviewer for the caller's tenant. Idempotent w.r.t. `(tenantId, userId)` — re-registering rotates role/displayName rather than inserting a duplicate.",
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'role'],
  properties: {
    userId: { type: 'string', format: 'uuid' },
    role: ReviewerRoleSchema,
    displayName: { type: 'string', minLength: 1 },
  },
};

export const UnregisterReviewerResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reviewerId', 'unregistered'],
  properties: {
    reviewerId: { type: 'string', format: 'uuid' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const ExportAuditBundleBodySchema: JsonSchema = {
  description:
    "Body for `POST /v1/approvals/{approvalId}/audit-bundle`. `signingKeyId` selects the Ed25519 key from the deployment's `signingKey` binding. `includeMessages` optionally hydrates conversation messages tied to the approval's run.",
  type: 'object',
  additionalProperties: false,
  required: ['signingKeyId'],
  properties: {
    signingKeyId: {
      type: 'string',
      minLength: 1,
      description:
        'The `SigningKeyId` the deployment plugs into its `signingKey` binding. Server looks up the private key via `signingKey.getPrivateKey(signingKeyId)` — 404 if unknown.',
    },
    includeMessages: {
      type: 'boolean',
      description:
        "When true, hydrates conversation messages tied to the approval's run (agent turns pin `runId === conversationId`). Empty array for non-agent runs — field always present when requested.",
      default: false,
    },
  },
};

export const ExportAuditBundleResultSchema: JsonSchema = {
  description:
    'Signed exportable audit bundle. Same envelope shape as `ExportProvenanceResult` — clients can reuse the same `verifyEd25519` wrapper for both. `bundle` is base64 of the exact bytes that were signed (sorted-key canonical JSON, no whitespace). Bundle body: `{ bundleVersion, approvalId, tenantId, subjectKind, subjectRef, requiredRole, status, decision, decidedAt?, evidence: { guardrailResults?, messages? }, createdAt, exportedAt }`.',
  type: 'object',
  additionalProperties: false,
  required: [
    'approvalId',
    'bundle',
    'bundleSchemaVersion',
    'algorithm',
    'signingKeyId',
    'signature',
    'publicKey',
    'canonicalization',
    'exportedAt',
  ],
  properties: {
    approvalId: { type: 'string', format: 'uuid' },
    bundle: {
      type: 'string',
      description: 'Base64-encoded canonical JSON of the bundle body.',
    },
    bundleSchemaVersion: {
      type: 'integer',
      description: 'Integer schema version for the bundle body shape. Currently `1`.',
    },
    algorithm: { type: 'string', const: 'ed25519' },
    signingKeyId: { type: 'string' },
    signature: {
      type: 'string',
      description: 'Base64-encoded Ed25519 signature over `bundle` (after base64-decode).',
    },
    publicKey: {
      type: 'string',
      description:
        'PEM-encoded Ed25519 public key (DER SPKI envelope). Pass into `parsePublicKeyPem` for verification.',
    },
    canonicalization: {
      type: 'string',
      const: 'sorted-key-json',
      description:
        'Canonicalization algorithm — sorted-key JSON, no whitespace. Same algorithm as `canonicalize`.',
    },
    exportedAt: { type: 'string', format: 'date-time' },
  },
};

export const CompleteApprovalResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'approval', 'decision', 'waitpointResolved'],
  properties: {
    kind: { type: 'string', enum: ['terminal', 'escalated'] },
    approval: { $ref: '#/components/schemas/Approval' },
    decision: { $ref: '#/components/schemas/ReviewDecision' },
    nextApproval: {
      description: 'Present only when `kind === "escalated"`.',
      $ref: '#/components/schemas/Approval',
    },
    waitpointResolved: {
      type: 'boolean',
      description:
        'True when the approval had a `waitTokenId` + terminal accept/reject and the run waitpoint was completed as part of this call.',
    },
  },
};

// ---------------- agents ----------------

export const PromptParameterSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    type: { type: 'string', enum: ['string', 'number', 'boolean', 'date'] },
    required: { type: 'boolean' },
    default: {
      description: 'Default value used when the caller omits this parameter.',
    },
  },
};

export const RetrievalIntentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['types', 'scope'],
  properties: {
    types: { type: 'array', items: { type: 'string' }, minItems: 1 },
    scope: { type: 'string', enum: ['same-conversation', 'same-project', 'tenant'] },
    limit: { type: 'integer', minimum: 1 },
    mode: { type: 'string', enum: ['keyword', 'semantic', 'both'] },
  },
};

export const ConversationPolicySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    historyLimit: { type: 'integer', minimum: 1 },
    autoCloseAfterInactiveSeconds: { type: 'integer', minimum: 1 },
    hitlAfterTurns: { type: 'integer', minimum: 1 },
  },
};

export const TurnBudgetSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxSteps: { type: 'integer', minimum: 1 },
    maxCostUsd: { type: 'number', minimum: 0 },
    maxWallMs: { type: 'integer', minimum: 1 },
  },
};

export const CapabilitySchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  description:
    'Capability declaration — see `@kindgi/capabilities`. Additional properties are permitted so new capability kinds do not require a wire change.',
};

export const ToolRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  description:
    'Typed tool reference. `version` is a semver **range** (npm-style: `1.2.3` exact pin, `^1.2.3` compatible-updates, `~1.2.3` patch-updates-only, `>=1.0.0 <2.0.0` explicit range). Dispatch resolves the range to a concrete active version via `semver.maxSatisfying` at run start. No implicit "latest" — every tool ref names both id and range.',
  properties: {
    id: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
  },
};

/**
 * A typed agent result: the final answer must be JSON matching
 * `schema`; an invalid answer is sent back to the model with the
 * problems listed, up to `maxRepairs` times, then the turn fails with
 * `output-schema-violation`.
 */
export const AgentOutputSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema'],
  properties: {
    schema: {
      type: 'object',
      description: 'JSON Schema (draft 2020-12) the final answer must match.',
    },
    name: {
      type: 'string',
      minLength: 1,
      description: 'A name for the output, shown to the model and in errors. Default `output`.',
    },
    maxRepairs: {
      type: 'integer',
      minimum: 0,
      description: 'How many times the model is asked to repair an invalid answer. Default 1.',
    },
  },
};

/**
 * What an agent turn does when a tool call fails: the failure goes back
 * to the model as the call's result, up to `maxRetries` times per turn,
 * for the kinds in `retryOn`. Also the spec of a `tool-errors` tenant
 * policy, which caps an agent's.
 */
export const ToolErrorsSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxRetries: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_TOOL_ERROR_RETRIES,
      description: 'Failed calls sent back to the model per turn. Default 1.',
    },
    retryOn: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: [...TOOL_ERROR_KINDS] },
      description:
        "Which failures are sent back: arguments that don't fit the input schema (`invalid-arguments`), a tool the agent doesn't have (`unknown-tool`), a tool that ran and failed (`tool-error`). Default `invalid-arguments`, `unknown-tool`.",
    },
  },
};

export const AgentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'version',
    'name',
    'instructions',
    'capabilities',
    'tools',
    'retrieval',
    'guardrails',
  ],
  properties: {
    id: { type: 'string', description: 'AgentId — dotted namespace (e.g. `acme.drafting`).' },
    version: { type: 'string', description: 'Semver.' },
    name: { type: 'string' },
    description: { type: 'string' },
    instructions: { type: 'string' },
    parameters: { type: 'array', items: { $ref: '#/components/schemas/PromptParameter' } },
    capabilities: { type: 'array', items: { $ref: '#/components/schemas/Capability' } },
    tools: { type: 'array', items: { $ref: '#/components/schemas/ToolRef' } },
    retrieval: { type: 'array', items: { $ref: '#/components/schemas/RetrievalIntent' } },
    guardrails: { type: 'array', items: { type: 'string' } },
    preferredProvider: {
      type: 'string',
      minLength: 1,
      description:
        'Soft hint — the router prefers this provider by id (e.g. `anthropic`) when at least one of its models satisfies `capabilities.needs` + tenant policy. Combine with `preferredModel` to pin the exact (provider, model) tuple. Falls back to capability-based ranking when the pinned provider is unregistered or filtered out.',
    },
    preferredModel: {
      type: 'string',
      minLength: 1,
      description:
        'Soft hint at the model level (`ModelInfo.name`, e.g. `claude-sonnet-4-6`). Combined with `preferredProvider`: both set → promote the exact tuple; only `preferredModel` → promote any provider exposing that model; only `preferredProvider` → promote every model of that provider.',
    },
    conversationPolicy: { $ref: '#/components/schemas/ConversationPolicy' },
    budget: { $ref: '#/components/schemas/TurnBudget' },
    tags: { type: 'array', items: { type: 'string' } },
    output: { $ref: '#/components/schemas/AgentOutputSpec' },
    toolErrors: { $ref: '#/components/schemas/ToolErrorsSpec' },
    pins: { $ref: '#/components/schemas/AgentPins' },
    derivedFrom: { $ref: '#/components/schemas/VersionDerivation' },
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Present only on an unregistered version (`GET …/versions/{version}` reads those too). Unregister stops a version being chosen, not the pins that hold it: a new run naming it is refused, while a resumed run and a published version that pins it still run it.',
    },
    pinsDigest: {
      type: 'string',
      pattern: '^sha256:[0-9a-f]{64}$',
      description:
        "Set by the runtime with `pins`: `sha256:<hex>` of the pins' canonical JSON (sorted keys, no whitespace). Two agent versions with the same digest run the same blocks.",
    },
  },
};

export const VersionDerivationSchema: JsonSchema = {
  description:
    "Set by the runtime on an agent or flow version a deploy registered in place of the definition's version, which was registered already with other pins or content (versions never change). Never in the publish body.",
  type: 'object',
  additionalProperties: false,
  required: ['version', 'reason'],
  properties: {
    version: { type: 'string', description: 'The version the definition names.' },
    reason: {
      type: 'string',
      enum: ['pins-changed', 'unpinned', 'version-taken'],
      description:
        "`pins-changed`: a block it uses has a new version; `unpinned`: the definition's version was published before pins existed; `version-taken`: the definition's version holds another definition.",
    },
  },
};

const PinMapSchema: JsonSchema = {
  type: 'object',
  additionalProperties: { type: 'string' },
};

export const AgentPinsSchema: JsonSchema = {
  description:
    'The exact block versions an agent version runs: its lockfile. Set by the runtime when the version is published, never in the publish body: each tool range resolves once to the version every run of that agent version uses, so a new tool version reaches the agent only through a new agent version. Absent on a version published before pins existed (its ranges resolve per run).',
  type: 'object',
  additionalProperties: false,
  required: ['tools', 'prompts', 'settings'],
  properties: {
    tools: { ...PinMapSchema, description: 'Tool id → exact version.' },
    prompts: { ...PinMapSchema, description: 'Prompt block id → exact version.' },
    settings: { ...PinMapSchema, description: 'Settings block id → exact version.' },
  },
};

export const PublishAgentBodySchema: JsonSchema = {
  description:
    'Full `defineAgent` spec. Validated server-side via `@kindgi/agents.defineAgent` — validation failures return `400 validation-failed` with the issue list under `details.issues`.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'version',
    'name',
    'instructions',
    'capabilities',
    'tools',
    'retrieval',
    'guardrails',
    'projectId',
  ],
  properties: {
    id: { type: 'string' },
    version: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    projectId: ContentProjectIdProperty,
    instructions: { type: 'string' },
    parameters: { type: 'array', items: { $ref: '#/components/schemas/PromptParameter' } },
    capabilities: { type: 'array', items: { $ref: '#/components/schemas/Capability' } },
    tools: { type: 'array', items: { $ref: '#/components/schemas/ToolRef' } },
    retrieval: { type: 'array', items: { $ref: '#/components/schemas/RetrievalIntent' } },
    guardrails: { type: 'array', items: { type: 'string' } },
    preferredProvider: {
      type: 'string',
      minLength: 1,
      description:
        'Soft hint — the router prefers this provider by id (e.g. `anthropic`) when at least one of its models satisfies `capabilities.needs` + tenant policy. Combine with `preferredModel` to pin the exact (provider, model) tuple.',
    },
    preferredModel: {
      type: 'string',
      minLength: 1,
      description:
        'Soft hint at the model level (`ModelInfo.name`). Combined with `preferredProvider` to pin an exact tuple; alone to select a model across every provider that exposes it.',
    },
    conversationPolicy: { $ref: '#/components/schemas/ConversationPolicy' },
    budget: { $ref: '#/components/schemas/TurnBudget' },
    tags: { type: 'array', items: { type: 'string' } },
    output: { $ref: '#/components/schemas/AgentOutputSpec' },
    toolErrors: { $ref: '#/components/schemas/ToolErrorsSpec' },
  },
};

export const PublishAgentResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'version'],
  properties: {
    agentId: { type: 'string' },
    version: { type: 'string' },
  },
};

export const UnregisterAgentResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'version', 'unregistered'],
  properties: {
    agentId: { type: 'string' },
    version: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const ReinstateAgentVersionResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'version', 'wasTombstoned'],
  properties: {
    agentId: { type: 'string' },
    version: { type: 'string' },
    wasTombstoned: {
      type: 'boolean',
      description:
        '`true` when this call un-tombstoned the version; `false` when it was already active (idempotent no-op).',
    },
  },
};

export const AgentCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Agent' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- flows ----------------

/**
 * A flow node is either a leaf (tool/agent), a loop (contains a body
 * sub-flow and iteration semantics), a fanout (N different bodies in
 * parallel with declared convergence), or a subgraph (invokes another
 * registered flow as a full kernel sub-run). Discriminated by `kind`.
 * Kept structural — nested loop bodies pull the same schema
 * (recursively) rather than hard-coding a single depth. Kernel + loader
 * are the source of truth on shape; this OpenAPI schema is descriptive,
 * not enforcing.
 */
export const FlowNodeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['id', 'kind'],
  properties: {
    id: { type: 'string' },
    kind: {
      type: 'string',
      enum: ['tool', 'agent', 'loop', 'fanout', 'subgraph'],
    },
    ref: { type: 'string', description: 'Handler reference for leaf nodes.' },
    config: { type: 'object', additionalProperties: true },
  },
};

export const FlowEdgeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'from', 'to'],
  properties: {
    id: { type: 'string' },
    from: { type: 'string', description: 'Source node id or `$start` sentinel.' },
    to: { type: 'string', description: 'Destination node id or `$end` sentinel.' },
    when: {
      type: 'object',
      additionalProperties: true,
      description:
        'Optional predicate expression evaluated at edge dispatch time (see `@kindgi/flow`).',
    },
    policy: {
      type: 'object',
      additionalProperties: true,
      description: 'Optional per-edge runtime policy (retry, timeoutMs, ...).',
    },
  },
};

export const FlowSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'nodes', 'edges'],
  properties: {
    id: { type: 'string', description: 'FlowId — dotted namespace (e.g. `ingest.contract-pdf`).' },
    version: { type: 'string', description: 'Semver.' },
    name: { type: 'string' },
    description: { type: 'string' },
    nodes: { type: 'array', items: { $ref: '#/components/schemas/FlowNode' } },
    edges: { type: 'array', items: { $ref: '#/components/schemas/FlowEdge' } },
    maxParallelism: { type: 'integer', minimum: 1 },
    metadata: { type: 'object', additionalProperties: true },
    pins: { $ref: '#/components/schemas/FlowPins' },
    pinsDigest: {
      type: 'string',
      pattern: '^sha256:[0-9a-f]{64}$',
      description:
        "Set by the runtime with `pins`: `sha256:<hex>` of the pins' canonical JSON (sorted keys, no whitespace).",
    },
    derivedFrom: { $ref: '#/components/schemas/VersionDerivation' },
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Present only on an unregistered version (`GET …/versions/{version}` reads those too). Unregister stops a version being chosen, not the pins that hold it: a new run naming it is refused, while a resumed run and a published version that pins it still run it.',
    },
  },
};

export const FlowPinsSchema: JsonSchema = {
  description:
    'The exact tool and agent versions a flow version runs: its lockfile. Set by the runtime when the version is published, never in the publish body: each tool the flow runs, and each agent it runs at no named version, resolves once to its latest version then, which every run of that flow version uses. Absent on a version published before pins existed (it binds the latest versions per run).',
  type: 'object',
  additionalProperties: false,
  required: ['tools', 'agents'],
  properties: {
    tools: { ...PinMapSchema, description: 'Tool id → exact version.' },
    agents: {
      ...PinMapSchema,
      description: 'Agent id → exact version, for agent nodes that name no version.',
    },
  },
};

export const PublishFlowBodySchema: JsonSchema = {
  description:
    'Full flow definition. Validated server-side via `@kindgi/flow.loadFlow` — validation failures return `400 validation-failed` with the issue list under `details.issues`.',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'nodes', 'edges', 'projectId'],
  properties: {
    id: { type: 'string' },
    version: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    projectId: ContentProjectIdProperty,
    nodes: { type: 'array', items: { $ref: '#/components/schemas/FlowNode' } },
    edges: { type: 'array', items: { $ref: '#/components/schemas/FlowEdge' } },
    maxParallelism: { type: 'integer', minimum: 1 },
    metadata: { type: 'object', additionalProperties: true },
  },
};

export const PublishFlowResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['flowId', 'version'],
  properties: {
    flowId: { type: 'string' },
    version: { type: 'string' },
  },
};

export const UnregisterFlowResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['flowId', 'version', 'unregistered'],
  properties: {
    flowId: { type: 'string' },
    version: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const ReinstateFlowVersionResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['flowId', 'version', 'wasTombstoned'],
  properties: {
    flowId: { type: 'string' },
    version: { type: 'string' },
    wasTombstoned: {
      type: 'boolean',
      description:
        '`true` when this call un-tombstoned the version; `false` when it was already active (idempotent no-op).',
    },
  },
};

export const FlowCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Flow' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- tools ----------------

export const ToolEffectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: [
        'reads',
        'writes',
        'deletes',
        'network',
        'spawns-run',
        'emits-event',
        'external-side-effect',
        'sensitive-data-egress',
      ],
    },
    resource: { type: 'string' },
    notes: { type: 'string' },
  },
};

export const ToolNeedSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    optional: { type: 'boolean' },
  },
};

// The manifest's additive fields as named components (the `@kindgi/tools`
// type names), and the declarative HTTP tool's shapes (`ToolManifest.spec`,
// kind `http`). Each mirrors `@kindgi/specs/tool.schema.json` — a property,
// or a `$defs` entry — and schema-drift.test.ts holds them equal.

export const ToolSecretRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['envName', 'name'],
  properties: { envName: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 } },
};

export const HttpHeaderSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'value'],
  properties: { name: { type: 'string', minLength: 1 }, value: { type: 'string' } },
};

export const HttpAuthSpecSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'secretRef'],
      properties: {
        kind: { const: 'bearer' },
        secretRef: { $ref: '#/components/schemas/ToolSecretRef' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'headerName', 'secretRef'],
      properties: {
        kind: { const: 'header' },
        headerName: { type: 'string', minLength: 1 },
        secretRef: { $ref: '#/components/schemas/ToolSecretRef' },
      },
    },
  ],
};

export const HttpRequestBodySpecSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'json-input' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'input-passthrough' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'template'],
      properties: { kind: { const: 'text' }, template: { type: 'string' } },
    },
  ],
};

export const HttpToolSpecSchema: JsonSchema = {
  type: 'object',
  description:
    "Declarative HTTP-invocation spec. Attached to `ToolManifest.spec` under the discriminant `kind: 'http'`. The runtime `Tool.handler` is synthesized by the 'http' spec synthesizer to perform URL-template substitution, secret-ref resolution via `ToolContext.resolveSecret`, and the outbound fetch. All fields serialize cleanly to JSON.",
  additionalProperties: false,
  required: ['kind', 'method', 'urlTemplate'],
  properties: {
    kind: { const: 'http' },
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    urlTemplate: {
      type: 'string',
      minLength: 1,
      description:
        "URL template with `{param}` placeholders substituted from the tool's input at invoke time.",
    },
    headers: { type: 'array', items: { $ref: '#/components/schemas/HttpHeaderSpec' } },
    authorization: { $ref: '#/components/schemas/HttpAuthSpec' },
    requestBody: { $ref: '#/components/schemas/HttpRequestBodySpec' },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      description: 'Wall-clock timeout in ms. Default 30000.',
    },
    parseJson: {
      type: 'boolean',
      description:
        'When true (default), the response body is parsed as JSON before returning to the invoker.',
    },
    successStatus: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max'],
      properties: {
        min: { type: 'integer', minimum: 100, maximum: 599 },
        max: { type: 'integer', minimum: 100, maximum: 599 },
      },
    },
  },
};

export const SandboxModeSchema: JsonSchema = {
  type: 'string',
  enum: ['none', 'context-isolated', 'strict'],
  description:
    'Isolation posture the runtime enforces around the handler. Optional additive field.',
};

export const RuntimeLimitsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'Sandbox-enforced resource caps at dispatch. Optional additive field.',
  properties: { memMB: { type: 'integer', minimum: 1 }, cpuMs: { type: 'integer', minimum: 1 } },
  required: ['memMB', 'cpuMs'],
};

export const NetworkPolicySchema: JsonSchema = {
  type: 'object',
  description: 'Network egress policy. Optional additive field. Discriminated on `kind`.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['none', 'unrestricted'] } },
      required: ['kind'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'allowlist' },
        hosts: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
      required: ['kind', 'hosts'],
    },
  ],
};

export const TypedNeedsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Typed discriminated needs (env / secrets / config / capabilities / bindings). Optional additive field.',
  properties: {
    env: { type: 'object', additionalProperties: { type: 'object' } },
    secrets: { type: 'object', additionalProperties: { type: 'object' } },
    config: { type: 'object', additionalProperties: { type: 'object' } },
    capabilities: { type: 'array', items: { type: 'string', minLength: 1 } },
    bindings: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};

export const CodeArtifactRefSchema: JsonSchema = {
  description:
    "Handler-artifact pointer. Discriminated on `kind`: `oci` is the deploy-pipeline shape (image + module path + artifactVersion); `filesystem` is the local-development shape — absolute host path at the pack's on-disk handler file. Production servers SHOULD reject `filesystem`.",
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'oci' },
        imageRef: { type: 'string', minLength: 1 },
        modulePath: { type: 'string', minLength: 1 },
        artifactVersion: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'imageRef', 'modulePath', 'artifactVersion'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { const: 'filesystem' }, modulePath: { type: 'string', minLength: 1 } },
      required: ['kind', 'modulePath'],
    },
  ],
};

export const ToolSpecSchema: JsonSchema = {
  description:
    "Declarative handler spec. Discriminated on `kind`; the framework's synthesizer registry maps kind → runtime handler. Mutually exclusive with an imperative handler at author time.",
  oneOf: [{ $ref: '#/components/schemas/HttpToolSpec' }],
};

export const ToolSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description', 'input', 'output'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      description: 'ToolId — dotted namespace (e.g. `acme.verify-citation`).',
    },
    description: { type: 'string', minLength: 1 },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    input: {
      type: 'object',
      description: 'JSON Schema (Draft 2020-12) for the tool input.',
      additionalProperties: true,
    },
    output: {
      type: 'object',
      description: 'JSON Schema (Draft 2020-12) for the tool output.',
      additionalProperties: true,
    },
    needs: { type: 'array', items: { $ref: '#/components/schemas/ToolNeed' } },
    effects: { type: 'array', items: { $ref: '#/components/schemas/ToolEffect' } },
    transport: { type: 'string', enum: ['auto', 'native', 'mcp'] },
    mcpEndpoint: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
    mutating: {
      type: 'boolean',
      description:
        'Semantic marker: `true` when this tool causes observable side effects (writes state, calls external APIs with mutations, sends messages). Read-only tools set `false`. Absent defaults to `true`. Consumed by the HITL default classifier — a read-only tool passes straight through, a mutating tool asks on first use.',
    },
    sandbox: { $ref: '#/components/schemas/SandboxMode' },
    limits: { $ref: '#/components/schemas/RuntimeLimits' },
    network: { $ref: '#/components/schemas/NetworkPolicy' },
    needsSpec: { $ref: '#/components/schemas/TypedNeeds' },
    codeArtifactRef: { $ref: '#/components/schemas/CodeArtifactRef' },
    spec: { $ref: '#/components/schemas/ToolSpec' },
  },
};

export const RegisterToolBodySchema: JsonSchema = {
  description:
    'ToolManifest — Tool minus its runtime `handler`. Validated server-side via `@kindgi/tools.validateToolManifest`. Metadata-only registration: the handler is not uploaded and must already be available to the runtime.',
  ...ToolSchema,
  required: [...(ToolSchema.required as readonly string[]), 'projectId'],
  properties: {
    ...(ToolSchema.properties as Record<string, JsonSchema>),
    projectId: ContentProjectIdProperty,
  },
};

export const RegisterToolResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['toolId'],
  properties: {
    toolId: { type: 'string' },
  },
};

export const UnregisterToolResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['toolId', 'version', 'unregistered'],
  properties: {
    toolId: { type: 'string' },
    version: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const ReinstateToolVersionResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['toolId', 'version', 'wasTombstoned'],
  properties: {
    toolId: { type: 'string' },
    version: { type: 'string' },
    wasTombstoned: {
      type: 'boolean',
      description:
        '`true` when this call un-tombstoned the version; `false` when it was already active (idempotent no-op).',
    },
  },
};

export const ToolCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Tool' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

/**
 * Row shape returned by `GET /v1/tools/:toolId/versions`. Matches the
 * head-level `Tool` schema plus an optional `unregisteredAt` timestamp
 * that is present iff the version has been soft-tombstoned. Kept as a
 * dedicated schema (rather than sneaking the field onto `Tool`) so the
 * head routes — `get` / `getVersion` / `resolve` — keep their existing
 * response shape locked down under `additionalProperties: false`.
 */
export const ToolVersionRowSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description', 'input', 'output'],
  properties: {
    ...(ToolSchema.properties as Record<string, JsonSchema>),
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'ISO 8601 timestamp — present iff this version has been soft-tombstoned via `POST /versions/:v/unregister`. Absent on active versions.',
    },
  },
};

export const ToolVersionCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ToolVersionRow' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- guardrails ----------------

export const GuardrailActionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['on-violation'],
  properties: {
    'on-violation': {
      type: 'string',
      minLength: 1,
      examples: ['halt', 'retry', 'escalate', 'log-only', 'compensate'],
      description:
        'What happens when the guardrail fires. Open string: the built-in actions are listed in `examples`; any other name needs an action handler registered under it where the guardrail is evaluated.',
    },
    retry: {
      type: 'object',
      additionalProperties: false,
      required: ['maxAttempts'],
      properties: {
        maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
    escalateTo: { type: 'string' },
    compensateWith: { type: 'string' },
  },
};

export const GuardrailScopeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    when: { type: 'string', enum: ['always', 'ci-only', 'runtime-only'] },
    agents: { type: 'array', items: { type: 'string' } },
    flows: { type: 'array', items: { type: 'string' } },
    tenants: { type: 'array', items: { type: 'string' } },
  },
};

export const GuardrailSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'check', 'action'],
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    description: { type: 'string' },
    kind: {
      type: 'string',
      minLength: 1,
      examples: ['zero-llm', 'llm-judge', 'external'],
      description:
        'How the guardrail is checked. Open string: the built-in kinds are listed in `examples`; adapters register strategies for their own kinds.',
    },
    check: {
      type: 'string',
      minLength: 1,
      description: 'Reference to the concrete check implementation registered server-side.',
    },
    config: { type: 'object', additionalProperties: true },
    action: { $ref: '#/components/schemas/GuardrailAction' },
    severity: { type: 'string', enum: ['info', 'warn', 'error', 'critical'] },
    scope: { $ref: '#/components/schemas/GuardrailScope' },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxCostUsd: { type: 'number', minimum: 0 },
        maxLatencyMs: { type: 'integer', minimum: 0 },
      },
    },
    judgeCapabilities: { type: 'object', additionalProperties: true },
  },
};

export const RegisterGuardrailBodySchema: JsonSchema = {
  description:
    'Guardrail spec. Validated server-side via `@kindgi/guardrails.validateGuardrailSpec`. Metadata-only registration: the `check` id must reference an implementation already available to the runtime.',
  ...GuardrailSchema,
  required: [...(GuardrailSchema.required as readonly string[]), 'projectId'],
  properties: {
    ...(GuardrailSchema.properties as Record<string, JsonSchema>),
    projectId: ContentProjectIdProperty,
  },
};

export const RegisterGuardrailResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['guardrailId'],
  properties: {
    guardrailId: { type: 'string' },
  },
};

export const UnregisterGuardrailResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['guardrailId', 'unregistered'],
  properties: {
    guardrailId: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const GuardrailCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Guardrail' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- conversations ----------------

export const ConversationStatusSchema: JsonSchema = {
  type: 'string',
  enum: ['open', 'closed'],
  description: 'Lifecycle status derived from `closedAt`: `open` when null, `closed` otherwise.',
};

export const ConversationSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'tenantId',
    'agentId',
    'agentVersion',
    'title',
    'scope',
    'status',
    'openedAt',
    'turnCount',
  ],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'ConversationId.' },
    tenantId: { type: 'string', format: 'uuid' },
    agentId: { type: 'string' },
    agentVersion: { type: 'string', description: 'Semver.' },
    title: { type: 'string' },
    participantId: { type: 'string' },
    projectId: {
      type: 'string',
      format: 'uuid',
      description:
        "The project the conversation is in: the project of the run that opened it, or `projectId` on open (the tenant's Default project when omitted). Absent on conversations from before Kindgi 0.1.3; those are listed only without a scope.",
    },
    scope: {
      type: 'object',
      additionalProperties: true,
      description:
        'Free-form scope object (currently `{ tenantId }` in tests; enterprises extend with `matterId`, `engagementId`, etc.).',
    },
    status: ConversationStatusSchema,
    openedAt: { type: 'string', format: 'date-time' },
    closedAt: { type: 'string', format: 'date-time' },
    turnCount: { type: 'integer', minimum: 0 },
    lastMessageAt: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', additionalProperties: true },
  },
};

export const ConversationMessageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'role', 'content', 'createdAt'],
  properties: {
    sequence: {
      type: 'integer',
      minimum: 0,
      description: 'Monotonic index within the conversation. Sort order for the list endpoint.',
    },
    role: { type: 'string', enum: ['user', 'agent', 'tool', 'system'] },
    content: {
      description: 'Free-form string OR a structured object (tool results, multi-modal payloads).',
    },
    toolCall: {
      type: 'object',
      additionalProperties: false,
      required: ['toolId', 'invocationId'],
      properties: {
        toolId: { type: 'string' },
        invocationId: { type: 'string' },
      },
    },
    actor: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const OpenConversationBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'agentVersion'],
  properties: {
    agentId: { type: 'string', minLength: 1, description: 'AgentId.' },
    agentVersion: { type: 'string', minLength: 1, description: 'Semver — pinned at open time.' },
    title: {
      type: 'string',
      description: 'Optional. Defaults to `"Untitled conversation"` when omitted.',
    },
    projectId: {
      type: 'string',
      format: 'uuid',
      description:
        "The project the conversation is in; `GET /v1/conversations?scopeKind=project&scopeId=…` lists it. A project of the caller's tenant, else `400 bad-input`. Omitted: the tenant's Default project, as for a run.",
    },
    scope: {
      type: 'object',
      additionalProperties: true,
      description:
        'Structural scope (project id, matter id, etc.). Treated opaquely by the runtime.',
    },
    participantId: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
  },
};

export const ConversationCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Conversation' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

export const ConversationMessageCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ConversationMessage' } },
    nextCursor: {
      type: 'string',
      description:
        'Opaque cursor for the next page. Absent when `hasMore: false`. Sort is `sequence asc`.',
    },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- supervisor (observations) ----------------

export const ObservationStatusSchema: JsonSchema = {
  type: 'string',
  enum: [
    'succeeded',
    'guardrail-violation',
    'guardrail-warning',
    'tool-error',
    'model-error',
    'budget-exceeded',
    'aborted',
    'other',
  ],
};

export const ObservationSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'tenantId',
    'supervisorId',
    'agentId',
    'agentVersion',
    'conversationId',
    'turnNumber',
    'status',
    'violations',
    'durationMs',
    'costUsd',
    'observedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    supervisorId: { type: 'string' },
    agentId: { type: 'string' },
    agentVersion: { type: 'string' },
    conversationId: { type: 'string', format: 'uuid' },
    turnNumber: { type: 'integer', minimum: 0 },
    status: ObservationStatusSchema,
    failureCode: { type: 'string' },
    violations: { type: 'array', items: { type: 'object', additionalProperties: true } },
    failureDetail: { type: 'object', additionalProperties: true },
    durationMs: { type: 'integer', minimum: 0 },
    costUsd: { type: 'string' },
    provider: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'model'],
      properties: {
        id: { type: 'string' },
        model: { type: 'string' },
      },
    },
    provenanceRef: {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: {
        runId: { type: 'string', format: 'uuid' },
        provenanceId: { type: 'string', format: 'uuid' },
      },
    },
    observedAt: { type: 'string', format: 'date-time' },
  },
};

export const ObservationCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Observation' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque ISO-timestamp cursor. Treat as opaque on the client.',
    },
    hasMore: { type: 'boolean' },
  },
};

// ---------------- judgments + judge classes ----------------

export const JudgeClassScopeSchema: JsonSchema = {
  description:
    'Where a judge class applies: the whole tenant, one project, or one agent in a project.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { type: 'string', const: 'tenant' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'projectId'],
      properties: {
        kind: { type: 'string', const: 'project' },
        projectId: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'projectId', 'agentId'],
      properties: {
        kind: { type: 'string', const: 'agent' },
        projectId: { type: 'string', minLength: 1 },
        agentId: { type: 'string', minLength: 1 },
      },
    },
  ],
};

export const JudgeClassSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'scope', 'name', 'weight', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    tenantId: { type: 'string' },
    scope: { $ref: '#/components/schemas/JudgeClassScope' },
    name: {
      type: 'string',
      description: 'The deployment\'s own word for the class: "expert", "user", "arbitrator".',
    },
    weight: {
      type: 'number',
      minimum: 0,
      description: 'How much a judgment of this class counts, relative to the others.',
    },
    description: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description: 'Set when the class was retired.',
    },
  },
};

export const JudgeClassCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/JudgeClass' } },
    nextCursor: { type: 'string', description: 'Opaque cursor. Treat as opaque on the client.' },
    hasMore: { type: 'boolean' },
  },
};

export const CreateJudgeClassBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'name', 'weight'],
  properties: {
    scope: { $ref: '#/components/schemas/JudgeClassScope' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    weight: { type: 'number', minimum: 0 },
    description: { type: 'string' },
  },
};

export const UpdateJudgeClassBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    weight: { type: 'number', minimum: 0 },
    description: { type: 'string' },
  },
};

export const UnregisterJudgeClassResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['judgeClassId', 'unregistered'],
  properties: {
    judgeClassId: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const JudgedSubjectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id', 'version'],
  description: 'What a judged run ran: an agent at a version, or a flow at a version.',
  properties: {
    kind: { type: 'string', enum: ['agent', 'flow'] },
    id: { type: 'string' },
    version: { type: 'string' },
  },
};

export const JudgedItemSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['key'],
  description: "The judged item of a run's output.",
  properties: {
    key: { type: 'string', minLength: 1, description: "The caller's stable id for the item." },
    pointer: {
      type: 'string',
      description:
        'Where the item is in the run\'s output, as a JSON Pointer (RFC 6901), e.g. `/matches/2`. `""` is the whole output.',
    },
    rank: {
      type: 'integer',
      minimum: 0,
      description: "The item's position in a ranked list (0 = first).",
    },
  },
};

export const JudgmentAssertedBySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  description: 'Who asserted a judgment: the authenticated caller, never a typed name.',
  properties: {
    kind: { type: 'string', enum: ['user', 'service'] },
    id: {
      type: 'string',
      description: 'A user id, or for a service token its token or session id.',
    },
  },
};

export const JudgmentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'tenantId',
    'projectId',
    'runId',
    'subject',
    'item',
    'verdict',
    'assertedBy',
    'createdAt',
  ],
  properties: {
    id: { type: 'string' },
    tenantId: { type: 'string' },
    projectId: { type: 'string' },
    runId: { type: 'string' },
    subject: { $ref: '#/components/schemas/JudgedSubject' },
    item: { $ref: '#/components/schemas/JudgedItem' },
    verdict: { type: 'string', enum: ['yes', 'no'] },
    reason: { type: 'string' },
    judgeClassId: {
      type: 'string',
      description:
        'The judge class the judgment is recorded under. Absent when unclassified (counts with weight 1).',
    },
    assertedBy: { $ref: '#/components/schemas/JudgmentAssertedBy' },
    participantId: {
      type: 'string',
      description:
        "The app's opaque id for its end user who judged, when an app judged on their behalf.",
    },
    createdAt: { type: 'string', format: 'date-time' },
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description: 'Set when the judgment was removed or superseded.',
    },
    supersededBy: { type: 'string', description: 'The judgment that replaced this one.' },
  },
};

export const JudgedRunContextSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'What a judged agent turn read besides its input, captured when it was first judged: the conversation before it, what its retrievals returned, and the decision at its session approval gate.',
  properties: {
    history: {
      type: 'array',
      items: {},
      description:
        "The conversation's messages before the turn, oldest first (at most the last 200).",
    },
    historyTruncated: {
      type: 'boolean',
      description: 'Whether older messages were left out of `history`.',
    },
    retrieved: { description: "What the turn's retrievals returned." },
    sessionApproval: {
      type: 'object',
      additionalProperties: false,
      required: ['approved'],
      description:
        "The reviewer's decision at the turn's session approval gate, when the turn waited on one. A replay of the turn follows it.",
      properties: {
        approved: { type: 'boolean' },
        rationale: { type: 'string', description: "The reviewer's reason for a rejection." },
      },
    },
  },
};

export const JudgedRunCopySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'subject', 'input', 'output', 'capturedAt'],
  description:
    "The stored copy of a judged run's input and output, taken when it was first judged.",
  properties: {
    runId: { type: 'string' },
    subject: { $ref: '#/components/schemas/JudgedSubject' },
    input: {},
    context: {
      $ref: '#/components/schemas/JudgedRunContext',
    },
    output: {},
    capturedAt: { type: 'string', format: 'date-time' },
  },
};

export const JudgmentWithCopiesSchema: JsonSchema = {
  description: 'A judgment with the stored copies of what was judged.',
  allOf: [
    { $ref: '#/components/schemas/Judgment' },
    {
      type: 'object',
      required: ['run'],
      properties: {
        run: { $ref: '#/components/schemas/JudgedRunCopy' },
        itemValue: {
          description: "The judged item's value, when the judgment pointed at it.",
        },
      },
    },
  ],
};

export const JudgmentCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Judgment' } },
    nextCursor: { type: 'string', description: 'Opaque cursor. Treat as opaque on the client.' },
    hasMore: { type: 'boolean' },
  },
};

export const CreateJudgmentBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'item', 'verdict'],
  properties: {
    runId: { type: 'string', minLength: 1 },
    item: { $ref: '#/components/schemas/JudgedItem' },
    verdict: { type: 'string', enum: ['yes', 'no'] },
    reason: { type: 'string', maxLength: 4000 },
    judgeClassId: {
      type: 'string',
      minLength: 1,
      description: 'Optional. When given it must exist and apply to the run.',
    },
    participantId: {
      type: 'string',
      minLength: 1,
      description: "An app's opaque id for its end user, when judging on their behalf.",
    },
  },
};

export const UnregisterJudgmentResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['judgmentId', 'unregistered'],
  properties: {
    judgmentId: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const JudgedItemSummarySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'yes', 'no', 'yesWeight', 'totalWeight', 'reasons'],
  description: "The judgments of one item of a case's output, summed up.",
  properties: {
    key: { type: 'string' },
    pointer: { type: 'string' },
    rank: { type: 'integer', minimum: 0 },
    yes: { type: 'integer', minimum: 0, description: 'How many judgments said yes.' },
    no: { type: 'integer', minimum: 0, description: 'How many judgments said no.' },
    yesWeight: {
      type: 'number',
      description: 'The weight behind "yes" (an unclassified judgment counts 1).',
    },
    totalWeight: { type: 'number', description: 'The weight behind all judgments of the item.' },
    reasons: {
      type: 'array',
      description: 'The reasons given, newest first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['verdict', 'reason'],
        properties: {
          verdict: { type: 'string', enum: ['yes', 'no'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

export const JudgedEvalCaseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['caseId', 'subject', 'input', 'output', 'items'],
  description:
    "One case of a `judged` eval suite: a copy of a judged run with its items' judgments summed up.",
  properties: {
    caseId: { type: 'string', description: "The judged run's id." },
    subject: { $ref: '#/components/schemas/JudgedSubject' },
    input: {},
    context: { $ref: '#/components/schemas/JudgedRunContext' },
    output: {},
    items: { type: 'array', items: { $ref: '#/components/schemas/JudgedItemSummary' } },
  },
};

export const JudgedEvalCaseCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/JudgedEvalCase' } },
    nextCursor: { type: 'string', description: 'Opaque cursor. Treat as opaque on the client.' },
    hasMore: { type: 'boolean' },
  },
};

export const BuildJudgedSuiteBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'projectId'],
  description: 'Name the agent (`agentId`) or the flow (`flowId`) whose judged runs to use.',
  properties: {
    version: { type: 'string', description: 'Semver version to publish, e.g. `1.0.0`.' },
    projectId: { type: 'string', minLength: 1 },
    agentId: { type: 'string', minLength: 1 },
    agentVersion: { type: 'string', minLength: 1, description: 'Needs `agentId`.' },
    flowId: { type: 'string', minLength: 1 },
    since: {
      type: 'string',
      format: 'date-time',
      description: 'Runs first judged at or after this time.',
    },
    until: {
      type: 'string',
      format: 'date-time',
      description: 'Runs first judged before this time.',
    },
    judgeClassIds: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Count only judgments recorded under these judge classes.',
    },
    minJudgments: {
      type: 'integer',
      minimum: 1,
      description: 'Leave out runs with fewer counted judgments. Default 1.',
    },
    description: { type: 'string' },
  },
};

export const BuildJudgedSuiteResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['suiteId', 'version', 'kind', 'caseCount', 'truncated'],
  properties: {
    suiteId: { type: 'string' },
    version: { type: 'string' },
    kind: { type: 'string', enum: ['judged'] },
    caseCount: { type: 'integer', minimum: 0 },
    truncated: {
      type: 'boolean',
      description: 'Whether more judged runs matched than the 1000 cases a set holds.',
    },
  },
};

// ---------------- memory ----------------

export const FactScopeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['tenantId'],
  description:
    'Fact scope object. `tenantId` is required; every optional key narrows the fact (`userId`, `orgId`, `projectId`, `threadId`, `sessionId`). Additional keys accepted for forward compatibility.',
  properties: {
    tenantId: { type: 'string' },
    userId: { type: 'string' },
    orgId: { type: 'string' },
    projectId: { type: 'string' },
    threadId: { type: 'string' },
    sessionId: { type: 'string' },
  },
};

export const RetentionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keepUntil: { type: 'string', format: 'date-time' },
    keepDays: { type: 'integer', minimum: 1 },
    legalHold: { type: 'boolean' },
  },
};

export const SourceFreshnessSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ttlSeconds: { type: 'integer', minimum: 0 },
    lastVerifiedAt: { type: 'string', format: 'date-time' },
    etag: { type: 'string' },
    sourceVersion: { type: 'string' },
  },
};

export const SourceRefreshSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy'],
  properties: {
    strategy: { type: 'string', enum: ['on-read', 'background', 'manual'] },
    handler: { type: 'string' },
    priority: { type: 'integer' },
  },
};

export const FactSourceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'freshness', 'refresh'],
  properties: {
    kind: {
      type: 'string',
      enum: ['http-api', 'blob', 'mcp-tool', 'external-db', 'user-input'],
    },
    uri: { type: 'string' },
    freshness: { $ref: '#/components/schemas/SourceFreshness' },
    refresh: { $ref: '#/components/schemas/SourceRefresh' },
  },
};

export const FactSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'scope', 'version', 'createdAt'],
  properties: {
    id: { type: 'string', description: 'FactId.' },
    type: {
      type: 'string',
      description: 'Fact type identifier (pack-defined; a few are framework-standard).',
    },
    scope: { $ref: '#/components/schemas/FactScope' },
    version: {
      type: 'integer',
      minimum: 1,
      description: 'Monotonic version within (scope, id). Supersession increments.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    content: { description: 'Free-form structured payload.' },
    contentRef: {
      type: 'string',
      description: '`blob://<provider>/<bucket>/<key>` when the payload is stored externally.',
    },
    contentHash: { type: 'string' },
    size: { type: 'integer', minimum: 0 },
    embeddingModel: { type: 'string' },
    retention: { $ref: '#/components/schemas/Retention' },
    source: { $ref: '#/components/schemas/FactSource' },
    causedByLogId: { type: 'array', items: { type: 'string' } },
    supersedes: {
      type: 'string',
      description: 'FactId of the predecessor when this row supersedes another.',
    },
  },
};

export const FactCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Fact' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

export const WriteFactBodySchema: JsonSchema = {
  description:
    "Write a fact. `type` selects the retrieval-policy (which indexes populate); `scope.tenantId` MUST match the caller's tenant. Optional `retention` overrides tenant defaults; optional `contentHash` is a caller-supplied idempotence hint (runtime computes its own hash regardless).",
  type: 'object',
  additionalProperties: false,
  required: ['type', 'scope', 'content'],
  properties: {
    type: { type: 'string', minLength: 1 },
    scope: { $ref: '#/components/schemas/FactScope' },
    content: { description: 'Free-form structured payload.' },
    retention: { $ref: '#/components/schemas/Retention' },
    contentHash: { type: 'string' },
  },
};

export const SupersedeFactResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['factId', 'superseded'],
  properties: {
    factId: { type: 'string' },
    superseded: { type: 'boolean', const: true },
  },
};

export const RetrieveIntentSchema: JsonSchema = {
  description:
    'Retrieval intent — mirrors `RetrievalIntent` from `@kindgi/agents`, widened for direct-HTTP use. `mode: "list"` returns a plain scoped list (no query). `mode: "keyword"` runs full-text search. `mode: "semantic"` runs vector similarity search — requires an embedding provider bound on the deployment; if unavailable, the route returns `400 bad-input`. `mode: "both"` unions keyword + semantic results, dedup by fact id.',
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['list', 'keyword', 'semantic', 'both'] },
    query: {
      type: 'string',
      description: 'Required for `keyword` / `semantic` / `both`; ignored for `list`.',
    },
    type: { type: 'string', minLength: 1 },
    scope: { $ref: '#/components/schemas/FactScope' },
    limit: { type: 'integer', minimum: 1 },
    embeddingModel: { type: 'string' },
  },
};

export const RetrieveMemoryBodySchema: JsonSchema = RetrieveIntentSchema;

export const RetrievalHitSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['fact'],
  properties: {
    fact: { $ref: '#/components/schemas/Fact' },
    score: {
      type: 'number',
      description:
        'Relevance score. Keyword mode returns an implementation-defined rank (higher = better). Semantic mode returns cosine similarity in [-1, 1] (higher = better). Absent for `list` mode.',
    },
  },
};

export const RetrieveMemoryResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: { type: 'array', items: { $ref: '#/components/schemas/RetrievalHit' } },
  },
};

export const RevokeTokenResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tokenId', 'revoked'],
  properties: {
    tokenId: { type: 'string', format: 'uuid' },
    revoked: { type: 'boolean', const: true },
  },
};

// ---------------- signing keys (the deployment trust list) ----------------

export const TrustedSigningKeySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['keyId', 'tenantId', 'algorithm', 'publicKey', 'createdAt'],
  description:
    'A public key the tenant trusts to sign deployments (`POST /v1/deployments`). A revoked key stays readable, with `revokedAt`, so the deployments it signed can be audited; it verifies no new ones.',
  properties: {
    keyId: { type: 'string', description: 'The signer key id a deployment envelope names.' },
    tenantId: { type: 'string', format: 'uuid' },
    algorithm: { type: 'string', enum: ['ed25519'] },
    publicKey: {
      type: 'string',
      description: 'Base64 of the raw public-key bytes (32 for Ed25519).',
    },
    label: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    revokedAt: { type: 'string', format: 'date-time' },
    revokedReason: { type: 'string' },
  },
};

export const TrustSigningKeyBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['keyId', 'publicKey'],
  properties: {
    keyId: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
      description:
        'The id deployment envelopes name as `signerKeyId`. Bound to `publicKey` for good: rotate by trusting a new id.',
    },
    algorithm: { type: 'string', enum: ['ed25519'], default: 'ed25519' },
    publicKey: {
      type: 'string',
      description: 'Base64 of the 32 raw bytes of the Ed25519 public key.',
    },
    label: { type: 'string', maxLength: 200 },
  },
};

export const TrustedSigningKeyPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/TrustedSigningKey' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const RevokeSigningKeyBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', description: 'Kept with the key as `revokedReason`.' },
  },
};

export const RevokeSigningKeyResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['keyId', 'revoked'],
  properties: {
    keyId: { type: 'string' },
    revoked: {
      type: 'boolean',
      description: '`false` when the key was unknown or already revoked.',
    },
  },
};

// ---------------- supervisor (fix proposals) ----------------

export const ProposalTierSchema: JsonSchema = {
  type: 'string',
  enum: ['prompt', 'retrieval', 'tool-config'],
};

export const FixProposalStatusSchema: JsonSchema = {
  type: 'string',
  enum: [
    'draft',
    'dry-running',
    'dry-run-passed',
    'dry-run-failed',
    'proposed-for-review',
    'approved',
    'rejected',
    'applied',
    'rolled-back',
    'withdrawn',
  ],
};

export const PatternRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'key', 'count', 'firstSeenAt', 'lastSeenAt', 'sampleConversations'],
  properties: {
    kind: {
      type: 'string',
      enum: ['guardrail-violation', 'tool-error', 'budget-exceeded', 'model-error', 'aborted'],
    },
    key: { type: 'string' },
    count: { type: 'integer', minimum: 1 },
    firstSeenAt: { type: 'string', format: 'date-time' },
    lastSeenAt: { type: 'string', format: 'date-time' },
    sampleConversations: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
    },
  },
};

export const ProposedChangeSchema: JsonSchema = {
  description:
    'Polymorphic change payload. Shape depends on the sibling `tier` on the proposal (prompt / retrieval / tool-config).',
  type: 'object',
  additionalProperties: true,
};

export const FixProposalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'tenantId',
    'supervisorId',
    'agentId',
    'agentVersion',
    'tier',
    'change',
    'patternRefs',
    'hypothesis',
    'proposerRuleId',
    'status',
    'fingerprint',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'FixProposalId.' },
    tenantId: { type: 'string', format: 'uuid' },
    supervisorId: { type: 'string' },
    agentId: { type: 'string' },
    agentVersion: { type: 'string', description: 'Semver of the baseline agent version.' },
    tier: ProposalTierSchema,
    change: ProposedChangeSchema,
    patternRefs: {
      type: 'array',
      items: { $ref: '#/components/schemas/PatternRef' },
    },
    hypothesis: { type: 'string' },
    proposerRuleId: { type: 'string' },
    status: FixProposalStatusSchema,
    fingerprint: {
      type: 'string',
      description: 'sha256(tier + agentId + agentVersion + canonical(change)). Dedup key.',
    },
    resolutionReason: { type: 'string' },
    reviewApprovalId: {
      type: 'string',
      format: 'uuid',
      description: 'HITL approval id created when the proposal was submitted for review.',
    },
    appliedVersion: {
      type: 'string',
      description:
        'Semver of the new agent version the proposal materialized as. Present on `applied` and `rolled-back` proposals.',
    },
    appliedAt: { type: 'string', format: 'date-time' },
    rolledBackAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    resolvedAt: { type: 'string', format: 'date-time' },
  },
};

export const FixProposalCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/FixProposal' } },
    nextCursor: {
      type: 'string',
      description: 'Opaque cursor for the next page. Absent when `hasMore: false`.',
    },
    hasMore: { type: 'boolean' },
  },
};

export const DraftProposalBodySchema: JsonSchema = {
  description:
    'Draft a fix proposal for `(agentId, agentVersion)`. The supervisor context comes from the `X-Supervisor-Id` header; the caller supplies the target agent + change payload + supporting evidence. Duplicate proposals (same `(supervisor, fingerprint)` in a non-terminal state) short-circuit to the pre-existing row and set `X-Proposal-Deduped: true` on the response.',
  type: 'object',
  additionalProperties: false,
  required: [
    'agentId',
    'agentVersion',
    'tier',
    'change',
    'patternRefs',
    'hypothesis',
    'proposerRuleId',
  ],
  properties: {
    agentId: { type: 'string' },
    agentVersion: { type: 'string' },
    tier: ProposalTierSchema,
    change: ProposedChangeSchema,
    patternRefs: {
      type: 'array',
      items: { $ref: '#/components/schemas/PatternRef' },
    },
    hypothesis: { type: 'string', minLength: 1 },
    proposerRuleId: { type: 'string', minLength: 1 },
  },
};

export const PassCriterionSchema: JsonSchema = {
  description:
    'How the dry-run judges whether the candidate is good enough to submit for review. Two kinds: `min-pass-rate` (candidate pass rate ≥ threshold) or `strict-improvement` (candidate pass rate exceeds baseline by ≥ delta).',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'minPassRate'],
      properties: {
        kind: { type: 'string', const: 'min-pass-rate' },
        minPassRate: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'baselinePassRate', 'minDelta'],
      properties: {
        kind: { type: 'string', const: 'strict-improvement' },
        baselinePassRate: { type: 'number', minimum: 0, maximum: 1 },
        minDelta: { type: 'number' },
      },
    },
  ],
};

export const DryRunProposalBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['datasetId', 'datasetVersion', 'criterion'],
  properties: {
    datasetId: { type: 'string', minLength: 1 },
    datasetVersion: { type: 'string', minLength: 1 },
    criterion: PassCriterionSchema,
  },
};

export const DryRunProposalResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['proposal', 'passed'],
  properties: {
    proposal: { $ref: '#/components/schemas/FixProposal' },
    passed: {
      type: 'boolean',
      description:
        'True when the candidate met the criterion — proposal moves to `dry-run-passed`. False → `dry-run-failed` (still a legitimate response, not an error).',
    },
  },
};

export const SubmitReviewProposalBodySchema: JsonSchema = {
  description:
    'Body is optional — omit to accept every default. `requiredRole` overrides the auto-derivation (meta-fixes → senior). `expiresAt` sets the HITL approval deadline.',
  type: 'object',
  additionalProperties: false,
  properties: {
    requiredRole: { $ref: '#/components/schemas/ReviewerRole' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
};

export const SubmitReviewProposalResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['proposal', 'approvalId', 'metaFix'],
  properties: {
    proposal: { $ref: '#/components/schemas/FixProposal' },
    approvalId: { type: 'string', format: 'uuid' },
    metaFix: {
      type: 'boolean',
      description:
        "True when the proposal targets one of the supervisor's own agent ids — reviewer role auto-bumps to `senior` unless overridden.",
    },
  },
};

export const ApplyProposalBodySchema: JsonSchema = {
  description:
    'Body is optional. `newVersion` overrides the auto-derived patch bump of the baseline; omit to let the runtime bump `1.0.0 → 1.0.1`.',
  type: 'object',
  additionalProperties: false,
  properties: {
    newVersion: {
      type: 'string',
      description: 'Semver, strictly greater than the baseline.',
    },
  },
};

export const ApplyProposalResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['proposalId', 'appliedVersion', 'appliedAt'],
  properties: {
    proposalId: { type: 'string', format: 'uuid' },
    appliedVersion: { type: 'string' },
    appliedAt: { type: 'string', format: 'date-time' },
  },
};

export const RollbackProposalBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1 },
  },
};

export const RollbackProposalResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['proposalId', 'rolledBackAt'],
  properties: {
    proposalId: { type: 'string', format: 'uuid' },
    rolledBackAt: { type: 'string', format: 'date-time' },
  },
};

export const WithdrawProposalBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1 },
  },
};

// ---------------- provenance ----------------

export const ProvenanceNodeKindSchema: JsonSchema = {
  type: 'string',
  enum: [
    'input',
    'prompt',
    'retrieval',
    'tool-call',
    'tool-result',
    'model-call',
    'model-output',
    'artifact',
    'guardrail-check',
    'event',
    'policy-decision',
    'memory-read',
    'memory-write',
    'wait',
    'resume',
  ],
};

export const ProvenanceEdgeKindSchema: JsonSchema = {
  type: 'string',
  enum: [
    'caused-by',
    'influenced-by',
    'retrieved-from',
    'invoked',
    'produced',
    'checked-against',
    'waited-on',
    'resumed-from',
  ],
};

export const ProvenanceNodeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'timestamp'],
  properties: {
    id: { type: 'string' },
    kind: ProvenanceNodeKindSchema,
    timestamp: { type: 'string', format: 'date-time' },
    actor: { type: 'string' },
    contentHash: { type: 'string' },
    contentRef: { type: 'string' },
    modelVersion: { type: 'string' },
    policyDecisionId: { type: 'string' },
    attributes: { type: 'object', additionalProperties: true },
  },
};

export const ProvenanceEdgeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'kind'],
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    kind: ProvenanceEdgeKindSchema,
  },
};

export const ProvenanceSignatureSchema: JsonSchema = {
  description:
    'Runtime-side signature attached at emission time (if the deployment signs on write). Independent of the export-time signature returned by the export route.',
  type: 'object',
  additionalProperties: false,
  required: ['algorithm', 'keyId', 'value', 'signedAt'],
  properties: {
    algorithm: { type: 'string', const: 'ed25519' },
    keyId: { type: 'string' },
    value: { type: 'string', description: 'Base64-encoded signature bytes.' },
    signedAt: { type: 'string', format: 'date-time' },
  },
};

export const ProvenanceFlowRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string' },
    version: { type: 'string' },
  },
};

export const ProvenanceRecordMetadataSchema: JsonSchema = {
  description:
    'Lightweight metadata row returned by list. Excludes the full DAG payload — clients fetch the DAG via `GET /v1/provenance/{runId}`.',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'runId', 'tenantId', 'version', 'createdAt', 'signed'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    runId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    version: { type: 'string', description: 'Schema version of the record document (semver).' },
    flowRef: ProvenanceFlowRefSchema,
    signed: {
      type: 'boolean',
      description:
        'True when the emission-time signature is present. Independent of whether the export route can produce a signed bundle.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    projectId: {
      type: 'string',
      format: 'uuid',
      description:
        "The project of the record's run. Absent on records from before Kindgi 0.1.3; those are listed only without a scope.",
    },
  },
};

export const ProvenanceRecordSchema: JsonSchema = {
  description: 'Full provenance record including the DAG payload.',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'runId', 'tenantId', 'version', 'createdAt', 'dag'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    runId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    version: { type: 'string' },
    flowRef: ProvenanceFlowRefSchema,
    dag: {
      type: 'object',
      additionalProperties: false,
      required: ['nodes', 'edges'],
      properties: {
        nodes: { type: 'array', items: ProvenanceNodeSchema },
        edges: { type: 'array', items: ProvenanceEdgeSchema },
      },
    },
    signature: ProvenanceSignatureSchema,
    createdAt: { type: 'string', format: 'date-time' },
    callUsage: {
      type: 'object',
      description:
        "Each model call's usage from the cost ledger, by the `callId` in its `model-call` node's attributes. Joined when read: not part of the signed DAG. A signed export includes it, as it stood when signed.",
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['usage'],
        properties: {
          usage: { $ref: '#/components/schemas/ModelCallTokens' },
          costUsd: { type: 'number', minimum: 0 },
          durationMs: { type: 'integer', minimum: 0 },
          servedModel: { type: 'string' },
        },
      },
    },
  },
};

export const ProvenanceCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ProvenanceRecordMetadata' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const ExportProvenanceBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['signingKeyId'],
  properties: {
    signingKeyId: {
      type: 'string',
      minLength: 1,
      description:
        'The `SigningKeyId` the deployment plugs into its `signingKey` binding. Server looks up the private key via `signingKey.getPrivateKey(signingKeyId)` — 404 if unknown.',
    },
    includeMessages: {
      type: 'boolean',
      description:
        'When true, hydrates conversation messages tied to the run (agent turns pin `runId === conversationId`). Non-agent runs return an empty `messages: []` — the field is still present on the bundle for shape stability.',
      default: false,
    },
  },
};

export const ExportProvenanceResultSchema: JsonSchema = {
  description:
    'Signed exportable bundle. `bundle` is base64 of the exact bytes that were signed (sorted-key canonical JSON, no whitespace); verifiers can pass those bytes directly to `verifyEd25519`. The bundle body itself includes `bundleSchemaVersion`, `runId`, `tenantId`, `dag: { nodes, edges }`, `messages?` (if requested), `callUsage?` (the usage of the model calls, from the cost ledger), etc. See `canonicalization` for the deterministic serialization algorithm.',
  type: 'object',
  additionalProperties: false,
  required: [
    'runId',
    'bundle',
    'bundleSchemaVersion',
    'algorithm',
    'signingKeyId',
    'signature',
    'publicKey',
    'canonicalization',
    'exportedAt',
  ],
  properties: {
    runId: { type: 'string', format: 'uuid' },
    bundle: {
      type: 'string',
      description: 'Base64-encoded canonical JSON of the bundle body.',
    },
    bundleSchemaVersion: {
      type: 'string',
      description:
        "Semver for the shape of the bundle body. Currently `1.1.0`, which adds `callUsage`: each model call's usage from the cost ledger, by call id, as it stood when signed.",
    },
    algorithm: { type: 'string', const: 'ed25519' },
    signingKeyId: { type: 'string' },
    signature: {
      type: 'string',
      description: 'Base64-encoded Ed25519 signature bytes over `bundle` (after base64-decode).',
    },
    publicKey: {
      type: 'string',
      description:
        'PEM-encoded Ed25519 public key (DER SPKI envelope). Callers can pass this straight into `parsePublicKeyPem` for verification.',
    },
    canonicalization: {
      type: 'string',
      const: 'sorted-key-json',
      description:
        'Canonicalization algorithm — sorted-key JSON, no whitespace. Same algorithm as `canonicalize`.',
    },
    exportedAt: { type: 'string', format: 'date-time' },
  },
};

// ---------------- registry (exported to the generator) ----------------

/**
 * Named schemas surfaced under `components.schemas` in the emitted
 * OpenAPI document. Order is preserved in the emitted JSON for
 * reviewer-friendly diffs.
 */
// ---------------- artifacts (blob storage) ----------------

export const BlobMetaSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['blobId', 'tenantId', 'name', 'contentType', 'size', 'hash', 'tags', 'createdAt'],
  properties: {
    blobId: { type: 'string', description: 'ArtifactId — opaque branded string (a UUID).' },
    tenantId: { type: 'string', format: 'uuid' },
    name: { type: 'string', description: 'Caller-supplied filename or logical name.' },
    contentType: {
      type: 'string',
      description:
        'MIME type as declared by the uploader. Framework does NOT sniff content-type server-side.',
    },
    size: { type: 'integer', minimum: 0, description: 'Byte length of the persisted body.' },
    hash: {
      type: 'string',
      description: 'sha256 of the body, hex-encoded, lowercase (64 chars).',
      pattern: '^[0-9a-f]{64}$',
    },
    tags: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Free-form caller-supplied labels. Filterable on list via `?tag.<key>=<value>`.',
    },
    ownerRunId: {
      type: 'string',
      format: 'uuid',
      description: 'Optional back-ref to the RunId that produced this blob.',
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const ArtifactCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: BlobMetaSchema },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const UploadArtifactBodySchema: JsonSchema = {
  type: 'object',
  description:
    'Multipart form. `file` is the byte stream (required). Other fields are optional metadata: `name` (defaults to file part filename), `contentType` (defaults to file part MIME), `tags` (JSON-encoded object), `ownerRunId` (RunId string), `expectedHash` (sha256 hex, framework rejects on mismatch).',
  required: ['file'],
  properties: {
    file: { type: 'string', format: 'binary' },
    name: { type: 'string' },
    contentType: { type: 'string' },
    tags: {
      type: 'string',
      description: 'JSON-encoded `Record<string, string>` — parsed server-side.',
    },
    ownerRunId: { type: 'string', format: 'uuid' },
    expectedHash: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
      description:
        'Caller-computed sha256, hex-encoded, lowercase. Framework verifies + rejects on mismatch with `blob-hash-mismatch` (400).',
    },
  },
};

export const DeleteArtifactResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['blobId', 'deleted'],
  properties: {
    blobId: { type: 'string' },
    deleted: {
      type: 'boolean',
      description:
        '`true` on the first delete; `false` on subsequent calls (already gone). 404 only when the id was never known.',
    },
  },
};

// ---------------- capabilities + providers (admin plane) ----------------

/** Closed enum of feature strings the router matches on. */
export const FeatureSchema: JsonSchema = {
  type: 'string',
  enum: [
    'structured-output',
    'vision',
    'audio-input',
    'audio-output',
    'tool-use',
    'parallel-tool-use',
    'thinking',
    'long-context',
    'code-execution',
    'web-search',
    'file-search',
    'streaming',
    'batch',
  ],
};

/**
 * Descriptor entry in the framework capability catalog. Lean by design:
 * the runtime `Capability` (declarative needs / prefer / budget attached
 * to an agent spec) is a different concept from the *catalog* of features
 * a deployment supports. A descriptor is one row in that catalog.
 */
export const CapabilityDescriptorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'feature', 'description'],
  properties: {
    id: {
      type: 'string',
      description:
        'Stable identifier — e.g. `feature:<feature>`; deployments MAY pick other conventions for extension entries.',
    },
    feature: {
      oneOf: [
        { $ref: '#/components/schemas/Feature' },
        {
          type: 'string',
          description: 'Deployment-declared feature name outside the closed built-in enum.',
        },
      ],
    },
    description: { type: 'string' },
    kind: {
      type: 'string',
      description:
        'Capability kind (`llm-inference`, `embedding`, `gpu-compute`, `sandbox-exec`, `browser-session`, ...). Absent = `llm-inference`.',
    },
    paramsSchema: {
      type: 'object',
      additionalProperties: true,
      description:
        'Optional JSON Schema fragment describing the parameters an agent may attach to `{ feature, params }` in a `Requirement`.',
    },
  },
};

export const CapabilityCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/CapabilityDescriptor' },
    },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const ProviderCostSchema: JsonSchema = {
  type: 'object',
  // Adapters widen the cost table with their own rates (Anthropic's
  // prompt-cache multipliers, Gemini's cached-prompt share and
  // long-context rates); each adapter's README lists them.
  additionalProperties: true,
  required: ['promptUsdPer1kTokens', 'completionUsdPer1kTokens'],
  properties: {
    promptUsdPer1kTokens: { type: 'number', minimum: 0 },
    completionUsdPer1kTokens: { type: 'number', minimum: 0 },
  },
  description:
    "USD per 1K tokens. An adapter may take more rate fields (see the adapter's README).",
};

/**
 * Wire shape for a single model within a provider's `models[]` array.
 * Mirrors `@kindgi/capabilities.ModelInfo`.
 */
export const ModelInfoSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'contextWindow', 'features', 'cost'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      description: 'Vendor-facing model id passed to the SDK (e.g. `claude-sonnet-4-6`).',
    },
    contextWindow: {
      type: 'integer',
      minimum: 1,
      description: 'Context window in tokens.',
    },
    features: {
      type: 'array',
      items: { $ref: '#/components/schemas/Feature' },
      description: 'Features this model supports (tool-use, thinking, structured-output, ...).',
    },
    cost: { $ref: '#/components/schemas/ProviderCost' },
    p95LatencyMs: {
      type: 'number',
      minimum: 0,
      description: 'Best-effort p95 latency estimate in milliseconds. Varies by model.',
    },
    maxOutputTokens: {
      type: 'integer',
      minimum: 1,
      description:
        'Fallback cap on output tokens. Adapters that require `max_tokens` on every request (e.g. Anthropic) use this when `ModelCallInput.maxOutputTokens` is unset.',
    },
    description: {
      type: 'string',
      description: 'Short per-model description surfaced in logs.',
    },
  },
};

/**
 * Wire shape for a registered model provider. Mirrors
 * `@kindgi/capabilities.ProviderMetadata` — routing-relevant metadata
 * only. Provider-level fields describe the connection; per-model
 * fields (context window, cost, features) live under `models[]` so a
 * single connection can expose multiple models (e.g. several models
 * under one API key). Secrets never
 * cross the wire (endpoints, API keys, credentials live inside the
 * binding implementation).
 */
export const ProviderMetadataSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'region', 'models'],
  properties: {
    id: { type: 'string', minLength: 1 },
    region: {
      pattern: '^[a-z][a-z0-9-]{0,62}$',
      type: 'string',
      minLength: 1,
      description:
        "Region the connection routes to. All models on this provider share the region (the same models served from two clouds or regions are separate providers). `'unspecified'` when not region-scoped.",
    },
    models: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/components/schemas/ModelInfo' },
      description:
        'Models this connection exposes. Non-empty. `models[i].name` must be unique within the list.',
    },
    attributes: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Soft attributes for preference-ranking (`local`, `lower-cost`, `higher-accuracy`, ...). Matched by string equality against `Preference.feature`.',
    },
    description: {
      type: 'string',
      description: 'Short human description of the connection.',
    },
    capabilityKind: {
      type: 'string',
      description:
        'Kind of resource this provider fulfils. Absent = `llm-inference`. Adapters for other kinds (embedding, gpu-compute, sandbox-exec, ...) set this explicitly.',
    },
    fallback: {
      type: 'boolean',
      description:
        "A fallback serves a capability only when no other provider satisfies it (e.g. `kindgi dev`'s scripted `dev-echo`); an agent turn routed to one carries a `fallback-provider` warning. Absent = `false`.",
    },
    labels: {
      type: 'object',
      maxProperties: 32,
      propertyNames: { pattern: '^[a-z0-9]([a-z0-9._/-]{0,61}[a-z0-9])?$' },
      additionalProperties: { type: 'string', maxLength: 256 },
      description:
        'Bookkeeping, such as who manages the provider; the router ignores labels. At most 32 keys; a key is 1-63 lowercase letters and digits, with `.`, `-`, `_` or `/` inside; a value is at most 256 characters. The convention key `kindgi.com/managed-by` names the manager (`kindgi-dev`, `kindgi-deploy:<environment>`). Out of bounds: `400 invalid-provider`, reason `invalid-labels`.',
    },
  },
};

export const ProviderCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/ProviderMetadata' },
    },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

/**
 * `POST /v1/providers`: the provider's routing metadata, the adapter
 * that instantiates it, and that adapter's plumbing — a pointer to its
 * credential and its connection settings. The plumbing is stored with
 * the provider and handed to the runtime; `list` / `get` never return it.
 */
export const RegisterProviderBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['metadata', 'adapter_id'],
  properties: {
    metadata: { $ref: '#/components/schemas/ProviderMetadata' },
    adapter_id: {
      type: 'string',
      minLength: 1,
      description:
        'The adapter that instantiates this provider (e.g. `@kindgi/adapter-model-gemini`). Must be registered for the tenant.',
    },
    secret_ref: {
      type: 'object',
      additionalProperties: false,
      required: ['envName', 'name'],
      properties: {
        envName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
      },
      description:
        "The tenant secret holding the adapter's credential (an API key, a service-account key). Absent when the adapter needs none or finds its own (a cloud's default credentials).",
    },
    adapter_config: {
      type: 'object',
      additionalProperties: {
        anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
      },
      description:
        "The adapter's connection settings: flat, non-secret values (a cloud project, a base URL). Each adapter documents its keys. Credentials go in `secret_ref`, never here.",
    },
  },
};

export const RegisterProviderResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId'],
  properties: {
    providerId: { type: 'string' },
  },
};

export const UnregisterProviderResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'unregistered'],
  properties: {
    providerId: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const ProviderCapabilitiesResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/CapabilityDescriptor' },
    },
  },
};

// ---------------- mcp endpoints (interop plane) ----------------

/** Closed transport enum. Additive: extend when a new SDK transport lands. */
export const MCPTransportSchema: JsonSchema = {
  type: 'string',
  enum: ['stdio', 'http-sse', 'streamable-http'],
  description:
    'MCP transport variant. `stdio` — local subprocess (spawn a command). `http-sse` — the older MCP HTTP+SSE transport (separate POST + SSE endpoints). `streamable-http` — the Streamable HTTP transport (single endpoint, session id via header).',
};

export const MCPEndpointSecretRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['envName', 'name'],
  description:
    "The secret an MCP endpoint authenticates with: a name in the deployment's secrets store, resolved at the endpoint's tenant scope when the runtime connects (the shape webhooks and providers use). It is sent as the endpoint's bearer. The endpoint keeps only this reference.",
  properties: {
    envName: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}$' },
    name: { type: 'string', minLength: 1, maxLength: 256 },
  },
};

/**
 * Wire shape for a registered MCP endpoint. Secrets never appear —
 * `secretRef` names a secret in the deployment's store.
 */
export const MCPEndpointSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['endpointId', 'name', 'transport', 'config'],
  properties: {
    endpointId: { type: 'string', minLength: 1 },
    name: {
      type: 'string',
      minLength: 1,
      description: 'Human-readable display name.',
    },
    transport: { $ref: '#/components/schemas/MCPTransport' },
    config: {
      description:
        'Transport-tagged config union. Server enforces `config.transport === transport` at registration.',
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['transport', 'command'],
          properties: {
            transport: { const: 'stdio' },
            command: { type: 'string', minLength: 1 },
            args: { type: 'array', items: { type: 'string' } },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['transport', 'url'],
          properties: {
            transport: { const: 'http-sse' },
            url: { type: 'string', format: 'uri' },
            sseUrl: {
              type: 'string',
              format: 'uri',
              description: 'Optional distinct SSE endpoint if the server splits them.',
            },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['transport', 'url'],
          properties: {
            transport: { const: 'streamable-http' },
            url: { type: 'string', format: 'uri' },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
      ],
    },
    secretRef: { $ref: '#/components/schemas/MCPEndpointSecretRef' },
    instructions: {
      type: 'string',
      description: 'Optional pass-through to the MCP client `serverInfo.instructions`.',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Optional caller-defined metadata bag.',
    },
  },
};

export const MCPEndpointCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/MCPEndpoint' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

/**
 * Register body: the endpoint plus the scope it is registered in, as
 * `scopeKind` + `scopeId` (the pair the list filter takes).
 */
export const RegisterMCPEndpointBodySchema: JsonSchema = {
  ...MCPEndpointSchema,
  required: ['endpointId', 'name', 'transport', 'config', 'scopeKind'],
  properties: {
    ...(MCPEndpointSchema.properties as Record<string, JsonSchema>),
    scopeKind: { $ref: '#/components/schemas/ScopeKind' },
    scopeId: {
      type: 'string',
      minLength: 1,
      description:
        'Required when `scopeKind` is `org` or `project`; absent for `tenant` (implicit from the session).',
    },
  },
};

export const RegisterMCPEndpointResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['endpointId'],
  properties: {
    endpointId: { type: 'string' },
  },
};

export const UnregisterMCPEndpointResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['endpointId', 'unregistered'],
  properties: {
    endpointId: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

// ---------------- mcp resources + prompts (interop plane) ----------------

/**
 * Wire shape for one MCP resource descriptor as advertised via
 * `resources/list`. Verbatim MCP-spec shape — Kindgi adds no extensions.
 */
export const MCPResourceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['uri', 'name'],
  properties: {
    uri: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    mimeType: { type: 'string' },
  },
};

export const MCPResourceCollectionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/MCPResource' } },
  },
};

/**
 * Wire shape for the payload returned from `resources/read`. Exactly one of
 * `text` or `blob` is populated per the MCP spec — blob is base64-encoded.
 */
export const MCPResourceContentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['uri'],
  properties: {
    uri: { type: 'string' },
    mimeType: { type: 'string' },
    text: { type: 'string' },
    blob: { type: 'string', description: 'Base64-encoded binary payload.' },
  },
};

export const MCPPromptArgumentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    required: { type: 'boolean' },
  },
};

export const MCPPromptSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    arguments: {
      type: 'array',
      items: { $ref: '#/components/schemas/MCPPromptArgument' },
    },
  },
};

export const MCPPromptCollectionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/MCPPrompt' } },
  },
};

export const MCPPromptMessageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'content'],
  properties: {
    role: { type: 'string', enum: ['user', 'assistant'] },
    content: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'text'],
          properties: {
            type: { type: 'string', const: 'text' },
            text: { type: 'string' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'data', 'mimeType'],
          properties: {
            type: { type: 'string', const: 'image' },
            data: { type: 'string', description: 'Base64-encoded image bytes.' },
            mimeType: { type: 'string' },
          },
        },
      ],
    },
  },
};

export const GetMCPPromptBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    arguments: {
      type: 'object',
      description:
        'Argument bag for the prompt template. Every value must be a string per MCP spec.',
      additionalProperties: { type: 'string' },
    },
  },
};

export const GetMCPPromptResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['messages'],
  properties: {
    messages: { type: 'array', items: { $ref: '#/components/schemas/MCPPromptMessage' } },
  },
};

// ---------------- cost (admin plane) ----------------

/**
 * Closed set of dimensions the cost aggregate endpoint can group by.
 * Time dimensions (`day` / `month`) bucket by UTC calendar day / month
 * against `occurredAt`. `tenant` always resolves to the caller's
 * tenant id.
 */
export const CostGroupDimensionSchema: JsonSchema = {
  type: 'string',
  enum: [
    'agentId',
    'runId',
    'category',
    'providerId',
    'day',
    'month',
    'tenant',
    'conversationId',
    'model',
    'servedModel',
    'projectId',
    'orgId',
    'rootRunId',
    'flowId',
  ],
};

/** Why a model call failed, as its cost record carries it. */
export const ModelCallErrorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  description: 'Why a model call failed (`status: failed`).',
  properties: { message: { type: 'string' } },
};

/** A model call's tokens, as a cost record and a provenance record carry them. */
export const ModelCallTokensSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['promptTokens', 'completionTokens'],
  description:
    "The call's tokens. `promptTokens` / `completionTokens` are the totals; `cacheReadTokens` / `cacheWriteTokens` are parts of `promptTokens`, `reasoningTokens` of `completionTokens`, present when the provider reports them.",
  properties: {
    promptTokens: { type: 'integer', minimum: 0 },
    completionTokens: { type: 'integer', minimum: 0 },
    cacheReadTokens: { type: 'integer', minimum: 0 },
    cacheWriteTokens: { type: 'integer', minimum: 0 },
    reasoningTokens: { type: 'integer', minimum: 0 },
  },
};

/**
 * Token sums of an aggregate. `prompt` / `completion` are the totals;
 * `cacheRead` / `cacheWrite` are parts of `prompt`, `reasoning` of
 * `completion` (`0` where providers didn't report them).
 */
export const CostTokenTotalsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'completion', 'cacheRead', 'cacheWrite', 'reasoning'],
  properties: {
    prompt: { type: 'integer', minimum: 0 },
    completion: { type: 'integer', minimum: 0 },
    cacheRead: { type: 'integer', minimum: 0 },
    cacheWrite: { type: 'integer', minimum: 0 },
    reasoning: { type: 'integer', minimum: 0 },
  },
};

/**
 * Wire shape for a single cost record: one recorded usage entry,
 * flattened for the wire (`resourceKind` → `category`;
 * `attributes.agentId` / `attributes.conversationId` lifted to top-level
 * when present). Records come from the runtime's LLM / tool / sandbox /
 * storage usage instrumentation.
 */
export const CostRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'category', 'quantity', 'unit', 'occurredAt'],
  properties: {
    id: { type: 'string' },
    tenantId: { type: 'string', format: 'uuid' },
    category: {
      type: 'string',
      description:
        'Free-form resource category (`llm.inference`, `tool.invocation`, `storage.write`, `sandbox.exec`, …). Maps to `resourceKind` in the runtime.',
    },
    providerId: { type: 'string' },
    runId: { type: 'string', format: 'uuid' },
    agentId: { type: 'string' },
    conversationId: { type: 'string', format: 'uuid' },
    quantity: { type: 'number', minimum: 0 },
    unit: { type: 'string', description: 'Metered unit (`tokens`, `seconds`, `bytes`, …).' },
    costUsd: { type: 'number', minimum: 0 },
    occurredAt: { type: 'string', format: 'date-time' },
    metrics: {
      type: 'object',
      additionalProperties: true,
      description: 'Kind-specific counters (e.g. `{ promptTokens, completionTokens }`).',
    },
    attributes: {
      type: 'object',
      additionalProperties: true,
      description: 'Free-form filter/display tags — never counters.',
    },
    callId: {
      type: 'string',
      description:
        "A model call's id (`category` `llm.inference`); its provenance `model-call` node carries it too.",
    },
    projectId: { type: 'string', format: 'uuid' },
    rootRunId: {
      type: 'string',
      format: 'uuid',
      description: "The root of the record's run tree (a flow run, for its agent turns).",
    },
    parentRunId: { type: 'string', format: 'uuid' },
    agentVersion: { type: 'string' },
    flowId: { type: 'string', description: "The flow of the run tree's root." },
    nodeId: { type: 'string', description: 'The step that made the call.' },
    step: { type: 'integer', minimum: 1, description: "The turn's step number." },
    purpose: {
      type: 'string',
      description:
        "What the call was for, beyond the turn's own model step: `guardrail-judge:<guardrail id>`.",
    },
    model: { type: 'string', description: 'The model actually called.' },
    servedModel: {
      type: 'string',
      description: 'The exact model version the vendor reported (vendors alias).',
    },
    fallback: {
      type: 'boolean',
      description: 'The router picked a fallback provider for the turn.',
    },
    status: {
      type: 'string',
      enum: ['ok', 'failed'],
      description: '`ok`: the provider answered. `failed`: the call threw.',
    },
    usage: { $ref: '#/components/schemas/ModelCallTokens' },
    durationMs: { type: 'integer', minimum: 0 },
    finishReason: { type: 'string' },
    providerRequestId: { type: 'string', description: "The vendor's id for the request." },
    attempts: {
      type: 'integer',
      minimum: 1,
      description: "HTTP attempts the call took, the client's retries included.",
    },
    error: { $ref: '#/components/schemas/ModelCallError' },
    rawUsage: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'model', 'usage'],
      description:
        "The vendor's own usage object, exactly as it reported it. Only with `include=rawUsage`.",
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        usage: { type: 'object', additionalProperties: true },
      },
    },
  },
};

export const CostRecordCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/CostRecord' },
    },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const CostAggregateGroupSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'count', 'totalUsd', 'tokens'],
  properties: {
    key: {
      type: 'object',
      additionalProperties: { type: ['string', 'null'] },
      description:
        'One entry per requested `groupBy` dimension. `null` = distinct "unattributed" bucket (records had no value for that dimension).',
    },
    count: { type: 'integer', minimum: 0 },
    totalUsd: { type: 'number', minimum: 0 },
    tokens: { $ref: '#/components/schemas/CostTokenTotals' },
  },
};

export const CostAggregateResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['groups', 'totalUsd', 'totalRecords', 'tokens', 'timeRange', 'groupBy'],
  properties: {
    groups: {
      type: 'array',
      items: { $ref: '#/components/schemas/CostAggregateGroup' },
      description:
        'The most expensive groups first (`totalUsd` descending, ties by key), at most `limit`.',
    },
    totalGroups: {
      type: 'integer',
      minimum: 0,
      description:
        'How many groups there were before the `limit` cap. Absent from a runtime before 0.1.5.',
    },
    truncated: {
      type: 'boolean',
      description:
        '`true` when there were more groups than `limit`: `groups` holds the most expensive ones, and `totalUsd` / `totalRecords` / `tokens` still cover every record. Absent from a runtime before 0.1.5.',
    },
    totalUsd: { type: 'number', minimum: 0 },
    totalRecords: { type: 'integer', minimum: 0 },
    tokens: { $ref: '#/components/schemas/CostTokenTotals' },
    timeRange: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
      },
    },
    groupBy: {
      type: 'array',
      items: { $ref: '#/components/schemas/CostGroupDimension' },
      description:
        'The dimensions the server actually grouped by — echoed so callers can round-trip the response without re-parsing the request URL.',
    },
  },
};

// ---------------- adapters (admin plane) ----------------

/**
 * Closed set of adapter kinds the framework knows about. `model` = an
 * in-process model adapter; `model-provider` = an adapter wrapping a
 * remote provider gateway. New kinds require an additive schema
 * update — enumerated (not open) so UIs render kind-specific columns
 * without guessing.
 */
export const AdapterKindSchema: JsonSchema = {
  type: 'string',
  enum: ['model', 'model-provider', 'embedding', 'blob', 'sandbox', 'eval-judge'],
};

/**
 * Adapter runtime status the wire surface exposes. `active` = wired
 * and last-observed healthy. `degraded` = partial capability loss.
 * `error` = wired but unusable. The binding decides how it derives
 * the value.
 */
export const AdapterStatusSchema: JsonSchema = {
  type: 'string',
  enum: ['active', 'degraded', 'error'],
};

/**
 * Wire shape for a single wired adapter. `config` is REDACTED — no
 * secrets on the wire; bindings may expose non-sensitive routing
 * hints (`{ region: 'us-east-1' }`) but never credentials.
 */
export const AdapterSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['adapterId', 'kind', 'name', 'version', 'capabilities', 'status'],
  properties: {
    adapterId: { type: 'string', minLength: 1 },
    kind: { $ref: '#/components/schemas/AdapterKind' },
    name: {
      type: 'string',
      minLength: 1,
      description:
        'Package name that owns the implementation (e.g. `@kindgi/adapter-model-in-process`).',
    },
    version: {
      type: 'string',
      minLength: 1,
      description: 'Semver of the wired package.',
    },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Kind-specific capability tags — e.g. `['context-isolated']` for a sandbox adapter, `['tool-use', 'streaming']` for a model adapter.",
    },
    config: {
      type: 'object',
      additionalProperties: true,
      description:
        'Redacted routing hints only. No secrets — bindings never surface API keys, endpoints, or credentials.',
    },
    status: { $ref: '#/components/schemas/AdapterStatus' },
    statusReason: {
      type: 'string',
      description: 'Human-readable reason accompanying `degraded` / `error` status.',
    },
  },
};

export const AdapterCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/Adapter' },
    },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

/**
 * Optional body for `POST /v1/adapters/:adapterId/test`. Absent / empty
 * body → the binding runs the default kind-specific probe (see
 * `AdapterRegistryBinding` JSDoc). When supplied, the shape is open —
 * adapter authors extend the probe surface per kind without a schema
 * change.
 */
export const TestAdapterBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
};

/**
 * Result of a probe run. `ok: false` is a valid observation — the route
 * returns HTTP 200 either way. `probe` is kind-specific diagnostic data
 * (e.g. `{ vectorLength: 384 }` for an embedding probe).
 */
export const AdapterTestOutcomeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'latencyMs', 'probe'],
  properties: {
    ok: { type: 'boolean' },
    latencyMs: { type: 'number', minimum: 0 },
    probe: {
      type: 'object',
      additionalProperties: true,
      description: 'Kind-specific diagnostic data. Callers should not depend on its exact shape.',
    },
  },
};

// ---------------- policies (admin plane) ----------------

/**
 * Closed set of policy kinds the framework knows about. Extended
 * additively — new kinds require a spec + validator update in tandem so
 * the registry never accepts a kind no runtime consumer honors.
 */
export const PolicyKindSchema: JsonSchema = {
  type: 'string',
  enum: [...POLICY_KINDS],
};

/**
 * Wire shape for a single tenant policy. `spec` is a JSON object whose
 * shape is dictated by `kind` — the registry treats it as opaque JSON
 * so new kinds can extend the catalog without breaking existing readers.
 * Runtime consumers deserialize `spec` against their own contract.
 */
export const PolicySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'version', 'kind', 'spec'],
  properties: {
    id: { type: 'string', minLength: 1 },
    tenantId: { type: 'string', format: 'uuid' },
    version: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+$',
      description: 'Semver — publishing a modified policy produces a new version.',
    },
    kind: { $ref: '#/components/schemas/PolicyKind' },
    description: { type: 'string' },
    spec: {
      type: 'object',
      additionalProperties: true,
      description:
        "Kind-specific policy body. For `access-control`, matches `@kindgi/specs/policy.schema.json` (rules + defaults). For `model-routing`, matches `TenantPolicy` from `@kindgi/capabilities` (providers.allow / providers.deny / models.allow / models.deny / regionAllow / maxCostPerCallUsd / maxTokensPerCall). For `tool-errors`, `ToolErrorsSpec` (maxRetries / retryOn). For `hitl`, `HitlSpec` from `@kindgi/policy-contract` (maxTimeoutMs / minReviewerRole / tools — per tool id a mode or `{ mode, requiredRole }`); it only tightens an agent's approvals. `tool-errors` and `hitl` specs are validated on publish. For other kinds, the shape is defined by the runtime consumer.",
    },
  },
};

export const PolicyCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/Policy' },
    },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

/**
 * Row shape returned by `GET /v1/policies/:policyId/versions`. Matches
 * `Policy` plus an optional `unregisteredAt` timestamp that is present
 * iff the version has been soft-tombstoned. Kept as a dedicated schema
 * so the head routes (`get` / `getVersion`) keep their existing shape
 * locked down under `additionalProperties: false`.
 */
export const PolicyVersionRowSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'version', 'kind', 'spec'],
  properties: {
    ...(PolicySchema.properties as Record<string, JsonSchema>),
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'ISO 8601 timestamp — present iff this version has been soft-tombstoned via `POST /versions/:v/unregister`. Absent on active versions.',
    },
  },
};

export const PolicyVersionCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/PolicyVersionRow' },
    },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const PublishPolicyBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'kind', 'spec'],
  properties: {
    id: { type: 'string', minLength: 1 },
    tenantId: {
      type: 'string',
      format: 'uuid',
      description:
        'Optional. When present, must match the caller tenant (server-derived from the token). Cross-tenant publish is rejected.',
    },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    kind: { $ref: '#/components/schemas/PolicyKind' },
    description: { type: 'string' },
    spec: { type: 'object', additionalProperties: true },
  },
};

export const PublishPolicyResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['policyId', 'version'],
  properties: {
    policyId: { type: 'string' },
    version: { type: 'string' },
  },
};

export const UnregisterPolicyResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['policyId', 'version', 'unregistered'],
  properties: {
    policyId: { type: 'string' },
    version: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const ReinstatePolicyVersionResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['policyId', 'version', 'wasTombstoned'],
  properties: {
    policyId: { type: 'string' },
    version: { type: 'string' },
    wasTombstoned: { type: 'boolean' },
  },
};

// ---------------- eval suites (admin plane) ----------------

/**
 * Closed set of eval kinds the framework knows about. Extended
 * additively — new kinds require a spec + validator update in tandem so
 * the registry never accepts a kind no runtime consumer honors.
 */
export const EvalKindSchema: JsonSchema = {
  type: 'string',
  enum: ['accuracy', 'pairwise', 'regression', 'human-review', 'benchmark', 'custom', 'judged'],
};

/**
 * Wire shape for a single evaluation suite. `spec` is a JSON object
 * whose shape is dictated by `kind` — the registry treats it as opaque
 * JSON so new kinds can extend the catalog without breaking existing
 * readers. Runtime consumers deserialize `spec` against their own
 * contract (eval-judge adapter for `accuracy` / `pairwise` /
 * `regression`, HITL bridge for `human-review`, sandbox handler for
 * `custom`).
 */
export const EvalSuiteSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'version', 'kind', 'spec'],
  properties: {
    id: { type: 'string', minLength: 1 },
    tenantId: { type: 'string', format: 'uuid' },
    version: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+$',
      description: 'Semver — publishing a modified suite produces a new version.',
    },
    kind: { $ref: '#/components/schemas/EvalKind' },
    description: { type: 'string' },
    spec: {
      type: 'object',
      additionalProperties: true,
      description:
        'Kind-specific suite body. For `accuracy`, typically `{ cases: [{ input, expectedOutput }], grader?: { adapterId, config? } }`. For `pairwise`, typically `{ prompts, variantA, variantB }`. For `regression`, typically `{ baseline, cases }`. For `human-review`, typically `{ rubric, reviewerRole }`. For `benchmark`, typically `{ benchmark: { name, version } }`. For `custom`, typically `{ handler: { modulePath, entrypointPath }, cases }`.',
    },
  },
};

export const EvalSuiteCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/EvalSuite' },
    },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const PublishEvalSuiteBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'kind', 'spec', 'projectId'],
  properties: {
    id: { type: 'string', minLength: 1 },
    projectId: ContentProjectIdProperty,
    tenantId: {
      type: 'string',
      format: 'uuid',
      description:
        'Optional. When present, must match the caller tenant (server-derived from the token). Cross-tenant publish is rejected.',
    },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    kind: { $ref: '#/components/schemas/EvalKind' },
    description: { type: 'string' },
    spec: { type: 'object', additionalProperties: true },
  },
};

export const PublishEvalSuiteResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['suiteId', 'version'],
  properties: {
    suiteId: { type: 'string' },
    version: { type: 'string' },
  },
};

export const UnregisterEvalSuiteResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['suiteId', 'version', 'unregistered'],
  properties: {
    suiteId: { type: 'string' },
    version: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const ReinstateEvalSuiteVersionResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['suiteId', 'version', 'wasTombstoned'],
  properties: {
    suiteId: { type: 'string' },
    version: { type: 'string' },
    wasTombstoned: { type: 'boolean' },
  },
};

// ---------------- data blocks ----------------

export const BlockKindSchema: JsonSchema = {
  type: 'string',
  enum: ['prompt', 'settings'],
  description:
    '`prompt`: a Liquid template an agent renders as its instructions. `settings`: a JSON object tools and templates read.',
};

export const PromptBlockContentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['template'],
  properties: {
    template: {
      type: 'string',
      minLength: 1,
      description:
        "Liquid, rendered as an agent's instructions are (same parameters and auto-injected variables).",
    },
    parameters: { type: 'array', items: { $ref: '#/components/schemas/PromptParameter' } },
  },
};

export const SettingsBlockContentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['values'],
  properties: {
    values: {
      type: 'object',
      additionalProperties: true,
      description:
        'What tools read (`ToolContext.settings[<block id>]`) and templates read (`settings.<block id>.<key>`).',
    },
    schema: {
      type: 'object',
      additionalProperties: true,
      description:
        "JSON Schema (draft 2020-12) the values must satisfy. A later version's values must satisfy the latest version's schema too.",
    },
  },
};

export const BlockSchema: JsonSchema = {
  description:
    'A data block version: a prompt or settings, versioned like a tool (immutable versions, soft unregister). An agent version pins the block versions it uses when it is published. Belongs to one project and is authorized through it.',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'kind', 'content', 'projectId', 'publishedAt'],
  properties: {
    id: { type: 'string', description: 'Dotted lowercase id (e.g. `acme.intake-prompt`).' },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    kind: { $ref: '#/components/schemas/BlockKind' },
    description: { type: 'string' },
    content: {
      oneOf: [
        { $ref: '#/components/schemas/PromptBlockContent' },
        { $ref: '#/components/schemas/SettingsBlockContent' },
      ],
      description: '`PromptBlockContent` for a prompt, `SettingsBlockContent` for settings.',
    },
    projectId: { type: 'string', format: 'uuid' },
    publishedAt: { type: 'string', format: 'date-time' },
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Present only on an unregistered version; agent versions that pin it still read it.',
    },
  },
};

export const BlockCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Block' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const PublishBlockBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'id', 'version', 'kind', 'content'],
  properties: {
    projectId: ContentProjectIdProperty,
    id: { type: 'string', minLength: 1 },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    kind: { $ref: '#/components/schemas/BlockKind' },
    description: { type: 'string' },
    content: {
      oneOf: [
        { $ref: '#/components/schemas/PromptBlockContent' },
        { $ref: '#/components/schemas/SettingsBlockContent' },
      ],
    },
  },
};

export const PublishBlockResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['blockId', 'version'],
  properties: { blockId: { type: 'string' }, version: { type: 'string' } },
};

export const UnregisterBlockResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['blockId', 'version', 'unregistered'],
  properties: {
    blockId: { type: 'string' },
    version: { type: 'string' },
    unregistered: { type: 'boolean', const: true },
  },
};

export const ReinstateBlockResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['blockId', 'version', 'wasTombstoned'],
  properties: {
    blockId: { type: 'string' },
    version: { type: 'string' },
    wasTombstoned: { type: 'boolean' },
  },
};

// ---------------- eval runs (admin plane) ----------------

/**
 * Terminal + pre-terminal statuses for an eval run. Same vocabulary as
 * runs, plus a `pending` state for dispatchers that queue before
 * executing.
 */
export const EvalRunStatusSchema: JsonSchema = {
  type: 'string',
  enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
};

export const EvalRunAgentRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId'],
  properties: {
    agentId: { type: 'string' },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
  },
};

export const EvalRunFlowRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['flowId'],
  properties: {
    flowId: { type: 'string' },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
  },
};

export const EvalBaselineSchema: JsonSchema = {
  description:
    "What a comparison compares the candidate against: `'recorded'` (each case's recorded output, what was judged), a version (`{ agentId, version }`, replayed under the same rules), or the version live in a scope (`{ live: { projectId?, segments? } }`). Only `'recorded'` runs today; the others are refused when the run starts.",
  oneOf: [
    { type: 'string', enum: ['recorded'] },
    {
      type: 'object',
      additionalProperties: false,
      required: ['agentId', 'version'],
      properties: { agentId: { type: 'string' }, version: { type: 'string' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['live'],
      properties: {
        live: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: { type: 'string' },
            segments: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
      },
    },
  ],
};

export const EvalComparisonSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['baseline', 'reads', 'repetitions', 'k'],
  description: "A comparison eval run's settings (a `judged` suite).",
  properties: {
    baseline: { $ref: '#/components/schemas/EvalBaseline' },
    reads: {
      type: 'string',
      enum: ['recorded', 'live'],
      description:
        "Whether replayed reads use the past run's results when it has them (`recorded`), or run live.",
    },
    repetitions: { type: 'integer', minimum: 1, maximum: 10 },
    k: { type: 'integer', minimum: 1, maximum: 100 },
  },
};

export const EvalRunSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'runId',
    'tenantId',
    'suiteId',
    'suiteVersion',
    'kind',
    'status',
    'dryRun',
    'startedAt',
  ],
  properties: {
    runId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    suiteId: { type: 'string' },
    suiteVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    kind: { $ref: '#/components/schemas/EvalKind' },
    agentRef: { $ref: '#/components/schemas/EvalRunAgentRef' },
    flowRef: { $ref: '#/components/schemas/EvalRunFlowRef' },
    status: EvalRunStatusSchema,
    dryRun: { type: 'boolean' },
    startedAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
    result: {
      type: 'object',
      additionalProperties: true,
      description:
        'Kind-specific opaque JSON. For `accuracy`, contains `{ passCount, totalCount, meanScore, perCase[] }`. For `judged` (a comparison), `{ summary, perCase[] }`: the summary has the baseline and candidate, the case counts (`cases`, `diverged`, `refusedWrites`, `errors`), the models that answered, and `metrics` (`weightedYesShare`, `judgedCoverage`, `weightedPrecisionAtK`, each `{ baseline, candidate, delta, n, weight, baselineN, baselineWeight, direction, k?, spread? }`); each case has its replay runs, the scores, the items kept, dropped and new, and the tool calls with what happened to each. Other kinds define their own shapes as their dispatchers ship.',
    },
    error: { type: 'string' },
    correlationId: { type: 'string' },
    comparison: { $ref: '#/components/schemas/EvalComparison' },
  },
};

export const EvalRunCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/EvalRun' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const StartEvalRunBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId'],
  properties: {
    projectId: ContentProjectIdProperty,
    agentRef: { $ref: '#/components/schemas/EvalRunAgentRef' },
    flowRef: { $ref: '#/components/schemas/EvalRunFlowRef' },
    dryRun: { type: 'boolean' },
    correlationId: { type: 'string' },
    baseline: { $ref: '#/components/schemas/EvalBaseline' },
    reads: { type: 'string', enum: ['recorded', 'live'] },
    repetitions: { type: 'integer', minimum: 1, maximum: 10 },
    k: { type: 'integer', minimum: 1, maximum: 100 },
  },
  description:
    "Exactly one of `agentRef` or `flowRef` MUST be supplied. `dryRun: true` returns a plan preview without invoking the subject. For a `judged` suite (a test set), the run is a comparison: `agentRef` with its `version` is the candidate, replayed on each case without doing anything the past run didn't; `baseline` (default `'recorded'`), `reads` (default `recorded`), `repetitions` (default 1) and `k` (default 10) set how.",
};

export const StartEvalRunResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runId'],
  properties: {
    runId: { type: 'string', format: 'uuid' },
    dryRunPreview: { type: 'object', additionalProperties: true },
  },
};

// ---------------- auth ----------------

export const IdentityProviderKindSchema: JsonSchema = {
  type: 'string',
  enum: ['oauth2', 'oidc'],
};

export const ClaimMappingScopesSpecSchema: JsonSchema = {
  description:
    'Claim path + optional delimiter for extracting Kindgi OAuth scopes from provider claims. When absent, scopes come from the token response `scope` field instead.',
  type: 'object',
  additionalProperties: false,
  required: ['claim'],
  properties: {
    claim: { type: 'string', minLength: 1 },
    delimiter: { type: 'string' },
  },
};

export const ClaimMappingSpecSchema: JsonSchema = {
  description:
    'Per-provider claim mapping. All fields optional; closer to OIDC defaults (sub/email/name) → fewer overrides needed.',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1 },
    email: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1 },
    scopes: { $ref: '#/components/schemas/ClaimMappingScopesSpec' },
    metadata: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};

export const IdentityProviderConfigSchema: JsonSchema = {
  description:
    'OAuth 2.0 / OIDC provider configuration registered on a tenant. `clientSecretRef` is a REFERENCE resolved server-side (env-var key, secrets-manager path, KMS handle) — the plaintext client secret never crosses the wire.',
  type: 'object',
  additionalProperties: false,
  required: [
    'providerId',
    'kind',
    'clientId',
    'clientSecretRef',
    'authorizationEndpoint',
    'tokenEndpoint',
    'scopes',
  ],
  properties: {
    providerId: { type: 'string', minLength: 1 },
    kind: IdentityProviderKindSchema,
    clientId: { type: 'string', minLength: 1 },
    clientSecretRef: {
      type: 'string',
      minLength: 1,
      description: 'Opaque reference resolved server-side. Never a plaintext secret.',
    },
    authorizationEndpoint: { type: 'string', format: 'uri' },
    tokenEndpoint: { type: 'string', format: 'uri' },
    userinfoEndpoint: { type: 'string', format: 'uri' },
    scopes: { type: 'array', items: { type: 'string' } },
    allowedRedirectUris: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'OAuth 2.1 BCP redirect-URI allowlist. Exact-string match required at /v1/auth/login. Absent/empty means no redirect-URI allowlist check (pass-through).',
    },
    claimMapping: { $ref: '#/components/schemas/ClaimMappingSpec' },
    metadata: { type: 'object', additionalProperties: true },
  },
};

export const IdentityProviderCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/IdentityProviderConfig' } },
  },
};

export const RegisterIdentityProviderResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId'],
  properties: {
    providerId: { type: 'string', minLength: 1 },
  },
};

export const UnregisterIdentityProviderResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'unregistered'],
  properties: {
    providerId: { type: 'string', minLength: 1 },
    unregistered: { type: 'boolean', const: true },
  },
};

export const LoginBodySchema: JsonSchema = {
  description:
    'Optional body for `POST /v1/auth/login/:providerId`. `redirectUri` overrides `metadata.defaultRedirectUri` on the provider config; at least one MUST be supplied.',
  type: 'object',
  additionalProperties: false,
  properties: {
    redirectUri: { type: 'string', format: 'uri' },
  },
};

export const AuthorizationResponseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['authorizationUrl', 'state', 'codeChallenge', 'codeChallengeMethod'],
  properties: {
    authorizationUrl: {
      type: 'string',
      format: 'uri',
      description:
        'URL the caller redirects the user-agent to. Includes `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`.',
    },
    state: { type: 'string', minLength: 1 },
    codeChallenge: { type: 'string', minLength: 1 },
    codeChallengeMethod: { type: 'string', enum: ['S256'] },
  },
};

export const CallbackBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'state'],
  properties: {
    code: { type: 'string', minLength: 1 },
    state: { type: 'string', minLength: 1 },
  },
};

export const CallbackResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionToken', 'sessionId', 'expiresAt'],
  properties: {
    sessionToken: {
      type: 'string',
      description:
        'Opaque framework-issued session token (`kgi_sk_<sessionId>`). Send as `Authorization: Bearer <sessionToken>` on subsequent requests. The underlying provider access-token never leaves the server.',
    },
    sessionId: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
};

export const RefreshResultSchema: JsonSchema = CallbackResultSchema;

export const LogoutResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'revoked'],
  properties: {
    sessionId: { type: 'string' },
    revoked: { type: 'boolean' },
  },
};

export const WhoamiResultSchema: JsonSchema = {
  description:
    "Introspection of the caller's current authentication context. Always carries `tenantId` and `scopes` (empty for static bearer tokens), plus `userId` when the token carries one; session-token callers additionally see `sessionId`, `providerId`, and `expiresAt`. `user` is the caller's directory record, present when the deployment wires an identity directory and it knows the `userId`. `reviewerRole` is set when the caller is a reviewer — its token carries a reviewer role, or its user is a registered reviewer — so clients can gate reviewer-only UI (the approvals surface) without a second round trip.",
  type: 'object',
  additionalProperties: false,
  required: ['tenantId', 'scopes'],
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    userId: { type: 'string' },
    sessionId: { type: 'string' },
    providerId: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string' } },
    expiresAt: { type: 'string', format: 'date-time' },
    reviewerRole: ReviewerRoleSchema,
    user: { $ref: '#/components/schemas/UserRecord' },
  },
};

export const UserRecordSchema: JsonSchema = {
  description:
    'Tenant-scoped user record (admin plane). `primaryEmail` may be redacted on the wire based on tenant policy (the routes treat it as opaque). `metadata` is free-form JSON — deployments carry IdP claims / provisioning source / roles here.',
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'tenantId', 'createdAt'],
  properties: {
    userId: { type: 'string' },
    tenantId: { type: 'string', format: 'uuid' },
    primaryEmail: { type: 'string' },
    displayName: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    lastActiveAt: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', additionalProperties: true },
  },
};

export const UserCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/UserRecord' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const IdentitySessionSummarySchema: JsonSchema = {
  description:
    'Wire-safe subset of a session. Excludes provider access-token / refresh-token — those never cross the wire, even to admins.',
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'userId', 'providerId', 'createdAt', 'expiresAt', 'scopes'],
  properties: {
    sessionId: { type: 'string' },
    userId: { type: 'string' },
    providerId: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    scopes: { type: 'array', items: { type: 'string' } },
    revokedAt: { type: 'string', format: 'date-time' },
  },
};

export const IdentitySessionCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/IdentitySessionSummary' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const RevokeSessionsResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'revokedCount'],
  properties: {
    userId: { type: 'string' },
    revokedCount: { type: 'integer', minimum: 0 },
  },
};

// ---------------- deployments ----------------

/**
 * Counts of primitives inside a deployment's `index.json`. Populated
 * from the wire index; not authoritative — the image is.
 */
export const DeploymentPrimitiveCountsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tools', 'guardrails', 'agents', 'flows'],
  properties: {
    tools: { type: 'integer', minimum: 0 },
    guardrails: { type: 'integer', minimum: 0 },
    agents: { type: 'integer', minimum: 0 },
    flows: { type: 'integer', minimum: 0 },
  },
};

const DeployedPrimitiveSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string' },
    version: { type: 'string', description: 'Absent for guardrails, which have no version.' },
  },
};

const DeployedVersionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string' },
    version: { type: 'string', description: 'The version the agent is registered as.' },
    authoredVersion: {
      type: 'string',
      description:
        "The version the agent's or flow's definition names, present when it differs from `version`: that version was registered already with other pins or content, and versions never change, so the deploy registered the next free version in its line (or an earlier deploy did).",
    },
    reason: {
      type: 'string',
      enum: ['pins-changed', 'unpinned', 'version-taken'],
      description:
        'Why `version` differs from `authoredVersion`: `pins-changed` (a tool or agent it uses has a new version), `unpinned` (`authoredVersion` was published before pins existed), `version-taken` (`authoredVersion` is registered with other content).',
    },
    newVersion: {
      type: 'boolean',
      description: '`true`: this deploy registered `version`; `false`: an earlier deploy did.',
    },
    pinChanges: {
      type: 'array',
      description: "For `pins-changed`: the pins that differ from `authoredVersion`'s.",
      items: { $ref: '#/components/schemas/PinChange' },
    },
  },
};

export const PinChangeSchema: JsonSchema = {
  description: 'One pin that differs between two versions of an agent or a flow.',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: ['tool', 'prompt', 'setting', 'agent'] },
    id: { type: 'string' },
    from: { type: 'string', description: "The earlier version's pin; absent when it had none." },
    to: { type: 'string', description: "The later version's pin; absent when it has none." },
  },
};

/**
 * Exactly what a deployment shipped. Versions are immutable, so this
 * says which code the deployment made live.
 */
export const DeploymentContentsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tools', 'guardrails', 'agents', 'flows'],
  properties: {
    tools: { type: 'array', items: DeployedPrimitiveSchema },
    guardrails: { type: 'array', items: DeployedPrimitiveSchema },
    agents: { type: 'array', items: DeployedVersionSchema },
    flows: { type: 'array', items: DeployedVersionSchema },
  },
};

/**
 * Immutable, append-only deployment record — the audit anchor. Every field is captured at register time so
 * regulators can re-verify offline against the pinned image bytes.
 */
export const DeploymentRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'deploymentId',
    'tenantId',
    'imageRef',
    'imageDigest',
    'artifactVersion',
    'indexHash',
    'signerKeyId',
    'signerPublicKey',
    'signature',
    'publishedAt',
    'activatedAt',
    'primitives',
    'contents',
  ],
  properties: {
    deploymentId: { type: 'string', minLength: 1 },
    tenantId: { type: 'string', format: 'uuid' },
    imageRef: {
      type: 'string',
      description: 'Full digest-pinned OCI reference: `<host>/<repo>@sha256:<hex>`.',
    },
    imageDigest: {
      type: 'string',
      pattern: '^sha256:[0-9a-f]{64}$',
      description: 'Idempotency key. Extracted from `imageRef` after the `@`.',
    },
    artifactVersion: {
      type: 'string',
      pattern: '^\\d{8}\\.\\d+$',
      description: 'Issuer-supplied `YYYYMMDD.N` — matches what was signed.',
    },
    indexHash: {
      type: 'string',
      pattern: '^sha256:[0-9a-f]{64}$',
      description: 'sha256 of the canonicalised `/app/index.json` inside the image.',
    },
    signerKeyId: { type: 'string', minLength: 1 },
    signerPublicKey: {
      type: 'string',
      description: 'Base64 of the raw Ed25519 public key bytes (32 bytes → 44 chars).',
    },
    signature: {
      type: 'string',
      description: 'Base64 of the raw Ed25519 signature (64 bytes → 88 chars).',
    },
    publishedAt: {
      type: 'string',
      format: 'date-time',
      description: 'Issuer-supplied timestamp inside the signed envelope.',
    },
    activatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'Server-side ledger timestamp — when the register call succeeded.',
    },
    primitives: { $ref: '#/components/schemas/DeploymentPrimitiveCounts' },
    contents: { $ref: '#/components/schemas/DeploymentContents' },
  },
};

/**
 * Wire body for `POST /v1/deployments`. `signerPublicKey` is PEM
 * (`-----BEGIN PUBLIC KEY-----\n…`) per the spec; the server parses to
 * raw bytes for verification and stores as base64 for offline audit.
 * `tenantId` is server-derived from the token — NOT part of the wire —
 * but the signed envelope covers it so the client MUST sign against the
 * tenant they're authenticating as.
 */
export const DeploymentRegistrationBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'imageRef',
    'artifactVersion',
    'indexHash',
    'signerKeyId',
    'signerPublicKey',
    'signature',
    'publishedAt',
  ],
  properties: {
    imageRef: {
      type: 'string',
      description: 'Full digest-pinned OCI reference: `<host>/<repo>@sha256:<hex>`.',
    },
    artifactVersion: {
      type: 'string',
      pattern: '^\\d{8}\\.\\d+$',
      description: 'Issuer-generated `YYYYMMDD.N` — covered by the signature.',
    },
    indexHash: {
      type: 'string',
      pattern: '^sha256:[0-9a-f]{64}$',
      description:
        "sha256 of the image's `/app/index.json`, byte for byte — covered by the signature. The server reads the file from the image, checks it hashes to this, and registers what it declares.",
    },
    signerKeyId: { type: 'string', minLength: 1 },
    signerPublicKey: {
      type: 'string',
      description:
        'PEM-encoded Ed25519 public key (`-----BEGIN PUBLIC KEY-----\\n…`). Parsed to raw bytes for verification.',
    },
    signature: {
      type: 'string',
      description:
        'Base64 of the Ed25519 signature over canonicalise({ imageDigest, artifactVersion, indexHash, tenantId, publishedAt }) with sorted keys, no whitespace, UTF-8.',
    },
    publishedAt: {
      type: 'string',
      format: 'date-time',
      description: 'Issuer-supplied ISO-8601 timestamp — covered by the signature.',
    },
  },
};

export const DeploymentCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/DeploymentRecord' },
    },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

/**
 * Per-primitive validation failure detail. Populated inside
 * `error.details` on `400 deployment-validation-failed`. `primitive`
 * discriminates by primitive kind; `index` positions the failure inside
 * the wire array so a client can point at the exact source file.
 */
export const DeploymentValidationDetailsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['primitive', 'index', 'path', 'message'],
  properties: {
    primitive: { type: 'string', enum: ['tool', 'guardrail', 'agent', 'flow'] },
    index: { type: 'integer', minimum: 0 },
    id: { type: 'string' },
    path: { type: 'string' },
    message: { type: 'string' },
  },
};

// -------- Deployment secrets sync --------

/**
 * Wire body for `POST /v1/deployments/:deploymentId/secrets`. Each
 * entry MUST set exactly one of `ref` (validate against an existing
 * record) or `value` (write a new version). The write scope is
 * derived from the deployment row server-side (CRITICAL) — the
 * body does NOT carry a scope override. `envName` targets which env
 * grouping the entries land in.
 */
export const DeploymentSecretsSyncRequestSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['envName', 'secrets'],
  properties: {
    envName: { $ref: '#/components/schemas/EnvName' },
    secrets: {
      type: 'array',
      description:
        'Zero or more secret entries. Each entry MUST set exactly one of `ref` (validate-only) or `value` (write new version).',
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'ref'],
            properties: {
              name: { type: 'string', minLength: 1 },
              ref: {
                type: 'string',
                minLength: 1,
                description:
                  'Opaque reference to an existing secret record — validated via `SecretBinding.get`; no bytes cross the wire.',
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'value'],
            properties: {
              name: { type: 'string', minLength: 1 },
              value: {
                type: 'string',
                description:
                  'Plaintext secret value written via `SecretBinding.set` with `writeMode: add-version`. The response returns only the framework-generated reference.',
              },
            },
          },
        ],
      },
    },
  },
};

/**
 * Wire response for `POST /v1/deployments/:deploymentId/secrets`.
 * `resolved` counts `{ name, ref }` entries validated against existing
 * records; `added` counts `{ name, value }` entries written as new
 * versions. `references[]` echoes one entry per input entry (in order)
 * with the resolved / freshly-minted reference — the wire NEVER
 * returns plaintext.
 */
export const DeploymentSecretsSyncResponseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['resolved', 'added', 'references'],
  properties: {
    resolved: { type: 'integer', minimum: 0 },
    added: { type: 'integer', minimum: 0 },
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'ref', 'version'],
        properties: {
          name: { type: 'string', minLength: 1 },
          ref: {
            type: 'string',
            minLength: 1,
            description:
              'Opaque reference — either echoed from the request (`{ name, ref }` entries) or freshly minted (`secret:<envName>/<name>#<version>` for `{ name, value }` entries).',
          },
          version: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
};

// ---------------- compliance ----------------

export const EvidenceKindSchema: JsonSchema = {
  type: 'string',
  minLength: 1,
  description:
    'Compliance-relevant event class. Open set: evidence is a classifier lens over the audit stream, and a deployment can mark any audit-event kind exportable. `examples` lists the built-in kinds; clients must tolerate kinds they do not know.',
  examples: [...EVIDENCE_KINDS],
};

export const EvidenceActorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['user', 'agent', 'system', 'admin', 'external'] },
    id: { type: 'string' },
    ipAddress: { type: 'string' },
    userAgent: { type: 'string' },
  },
};

export const EvidenceSubjectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    id: { type: 'string' },
  },
};

export const EvidenceOutcomeSchema: JsonSchema = {
  type: 'string',
  enum: ['allowed', 'denied', 'succeeded', 'failed', 'escalated'],
};

export const EvidenceProvenanceRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
    nodeId: { type: 'string' },
    recordId: { type: 'string' },
  },
};

export const EvidenceSignatureSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['algorithm', 'keyId', 'value', 'signedAt'],
  properties: {
    algorithm: { type: 'string', const: 'ed25519' },
    keyId: { type: 'string' },
    value: {
      type: 'string',
      description: 'Base64-encoded signature bytes.',
    },
    signedAt: { type: 'string', format: 'date-time' },
  },
};

export const ComplianceEvidenceSchema: JsonSchema = {
  description:
    'One evidence record — matches `@kindgi/specs/compliance-evidence.schema.json` (`payload` is a versioned document opaque to the wire schema).',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'kind', 'timestamp', 'payload'],
  properties: {
    id: { type: 'string' },
    tenantId: { type: 'string', format: 'uuid' },
    projectId: {
      type: 'string',
      format: 'uuid',
      description:
        'The project the underlying audit event belongs to. Absent for tenant-level events (e.g. authz decisions).',
    },
    kind: EvidenceKindSchema,
    timestamp: { type: 'string', format: 'date-time' },
    actor: EvidenceActorSchema,
    subject: EvidenceSubjectSchema,
    outcome: EvidenceOutcomeSchema,
    payload: {
      type: 'object',
      additionalProperties: true,
      description:
        'Kind-specific payload document. Always carries `version` for on-read migration; other fields vary by kind.',
    },
    provenanceRef: EvidenceProvenanceRefSchema,
    signature: EvidenceSignatureSchema,
  },
};

export const ComplianceEvidenceCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/ComplianceEvidence' },
    },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const ExportComplianceEvidenceFilterSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Optional filter narrowing the export set. Composition is AND — every populated field must match. Absent / empty filter exports every record for the tenant.',
  properties: {
    runId: { type: 'string' },
    agentId: { type: 'string' },
    flowId: { type: 'string' },
    kind: EvidenceKindSchema,
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
  },
};

export const ExportComplianceEvidenceBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['signingKeyId'],
  properties: {
    signingKeyId: {
      type: 'string',
      minLength: 1,
      description:
        'The `SigningKeyId` the deployment plugs into its `signingKey` binding. Server looks up the private key via `signingKey.getPrivateKey(signingKeyId)` — 404 `signing-key-not-found` if unknown.',
    },
    filter: ExportComplianceEvidenceFilterSchema,
  },
};

export const SignedComplianceEvidenceBundleSchema: JsonSchema = {
  description:
    'Signed exportable bundle. `bundle` is base64 of the exact bytes that were signed (sorted-key canonical JSON, no whitespace); verifiers can pass those bytes directly to `verifyEd25519`. Bundle body: `{ bundleSchemaVersion, tenantId, filter, records, recordCount, exportedAt }`. Envelope shape identical to `ExportProvenanceResult` + audit-bundle — verifiers reuse one `verifyEd25519` wrapper across all three surfaces.',
  type: 'object',
  additionalProperties: false,
  required: [
    'bundleSchemaVersion',
    'tenantId',
    'bundle',
    'algorithm',
    'signingKeyId',
    'signature',
    'publicKey',
    'canonicalization',
    'exportedAt',
  ],
  properties: {
    bundleSchemaVersion: { type: 'string', const: '1.0.0' },
    tenantId: { type: 'string', format: 'uuid' },
    bundle: {
      type: 'string',
      description: 'Base64-encoded canonical JSON of the bundle body.',
    },
    algorithm: { type: 'string', const: 'ed25519' },
    signingKeyId: { type: 'string' },
    signature: {
      type: 'string',
      description: 'Base64-encoded Ed25519 signature bytes over `bundle` (after base64-decode).',
    },
    publicKey: {
      type: 'string',
      description:
        'PEM-encoded Ed25519 public key (DER SPKI envelope). Callers can pass this straight into `parsePublicKeyPem` for verification.',
    },
    canonicalization: {
      type: 'string',
      const: 'sorted-key-json',
      description:
        'Canonicalization algorithm — sorted-key JSON, no whitespace. Same algorithm as `canonicalize`.',
    },
    exportedAt: { type: 'string', format: 'date-time' },
  },
};

// ---------------- platform hierarchy ----------------

/**
 * `Org` — optional structural subdivision within a tenant. Small tenants ignore Orgs entirely.
 */
export const OrgSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'name', 'slug', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', description: 'OrgId — opaque branded string.' },
    tenantId: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export const OrgSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'slug'],
  properties: {
    name: { type: 'string', minLength: 1 },
    slug: { type: 'string', minLength: 1 },
  },
};

export const OrgPatchSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    slug: { type: 'string', minLength: 1 },
  },
};

export const OrgCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Org' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const CreateResourceResultSchema: JsonSchema = {
  description:
    'Shared 201 response body for platform-hierarchy create endpoints — the freshly-assigned id of the created row.',
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string' },
  },
};

/**
 * `Team` — people-group. May optionally live under an Org
 * (nullable `orgId`) or be cross-org.
 */
export const TeamRoleSchema: JsonSchema = {
  type: 'string',
  enum: ['member', 'admin'],
  description: 'Role on a team membership.',
};

export const TeamSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'name', 'slug', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', description: 'TeamId — opaque branded string.' },
    tenantId: { type: 'string' },
    orgId: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export const TeamSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'slug'],
  properties: {
    name: { type: 'string', minLength: 1 },
    slug: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    orgId: { type: 'string' },
  },
};

export const TeamPatchSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    slug: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    orgId: {
      type: ['string', 'null'],
      description: '`null` explicitly re-assigns the team out of any org (cross-org).',
    },
  },
};

export const TeamCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Team' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const TeamMembershipSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['teamId', 'userId', 'role', 'joinedAt'],
  properties: {
    teamId: { type: 'string' },
    userId: { type: 'string' },
    role: { $ref: '#/components/schemas/TeamRole' },
    joinedAt: { type: 'string' },
  },
};

export const TeamMembershipCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/TeamMembership' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const AddTeamMembershipBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'role'],
  properties: {
    userId: { type: 'string', minLength: 1 },
    role: { $ref: '#/components/schemas/TeamRole' },
  },
};

export const UpdateTeamMembershipBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    role: { $ref: '#/components/schemas/TeamRole' },
  },
};

export const AddTeamMembershipResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['teamId', 'userId', 'role'],
  properties: {
    teamId: { type: 'string' },
    userId: { type: 'string' },
    role: { $ref: '#/components/schemas/TeamRole' },
  },
};

/**
 * `Project` — the primary content-scope. `isDefault: true`
 * marks the auto-created tenant Default.
 */
export const ProjectRoleSchema: JsonSchema = {
  type: 'string',
  enum: ['viewer', 'editor', 'owner', 'admin', 'member'],
  description: 'Role on a project membership.',
};

export const ProjectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenantId', 'name', 'slug', 'isDefault', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', description: 'ProjectId — opaque branded string.' },
    tenantId: { type: 'string' },
    orgId: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    isDefault: { type: 'boolean' },
    description: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export const ProjectSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'slug'],
  properties: {
    name: { type: 'string', minLength: 1 },
    slug: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    orgId: { type: 'string' },
    isDefault: { type: 'boolean' },
  },
};

export const ProjectPatchSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    slug: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    orgId: {
      type: ['string', 'null'],
      description: '`null` explicitly re-assigns the project out of any org (cross-org).',
    },
  },
};

export const ProjectCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Project' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const ProjectMembershipSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'userId', 'role', 'joinedAt'],
  properties: {
    projectId: { type: 'string' },
    userId: { type: 'string' },
    role: { $ref: '#/components/schemas/ProjectRole' },
    joinedAt: { type: 'string' },
  },
};

export const ProjectMembershipCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ProjectMembership' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const AddProjectMembershipBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'role'],
  properties: {
    userId: { type: 'string', minLength: 1 },
    role: { $ref: '#/components/schemas/ProjectRole' },
  },
};

export const UpdateProjectMembershipBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    role: { $ref: '#/components/schemas/ProjectRole' },
  },
};

export const AddProjectMembershipResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'userId', 'role'],
  properties: {
    projectId: { type: 'string' },
    userId: { type: 'string' },
    role: { $ref: '#/components/schemas/ProjectRole' },
  },
};

/**
 * `Tenant` — the sovereignty boundary. Wire shape returned by
 * `GET /v1/tenant`.
 */
export const TenantSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'slug', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    slug: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/**
 * Kind enum for the tenant config routes. The values `env` and `config`
 * both route to `EnvBinding`; `secret` routes to `SecretBinding`. The
 * dedicated `/v1/env/*` + `/v1/secrets/*` routes are the primary
 * surface.
 */
export const TenantConfigKindSchema: JsonSchema = {
  type: 'string',
  enum: ['env', 'config', 'secret'],
  description:
    'Slot for a tenant config entry (tenant-scoped). `env` and `config` both address `EnvBinding`; `secret` addresses `SecretBinding`. Prefer `/v1/env/*` + `/v1/secrets/*` for new callers.',
};

export const TenantConfigEntrySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tenantId', 'kind', 'key', 'value', 'sensitive', 'revision', 'updatedAt'],
  properties: {
    tenantId: { type: 'string' },
    kind: { $ref: '#/components/schemas/TenantConfigKind' },
    key: { type: 'string' },
    value: {
      type: 'string',
      description:
        'Entry value. For `kind: "secret"` this is ALWAYS `[redacted]` on this admin surface; use the `/v1/secrets/*` routes and `SecretBinding.resolve` on the dispatch path to read plaintext.',
    },
    sensitive: { type: 'boolean' },
    revision: { type: 'integer', minimum: 0 },
    updatedAt: { type: 'string' },
  },
};

export const TenantConfigCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/TenantConfigEntry' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const UpsertTenantConfigBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'key', 'value'],
  properties: {
    kind: { $ref: '#/components/schemas/TenantConfigKind' },
    key: { type: 'string', minLength: 1 },
    value: { type: 'string' },
    sensitive: {
      type: 'boolean',
      description:
        'When `true`, the write is routed to `SecretBinding` regardless of `kind`. `kind: "secret"` implies `sensitive: true`.',
    },
    ifRevision: {
      type: 'integer',
      minimum: 0,
      description:
        'Optimistic-concurrency guard — the write fails with `tenant-config-revision-conflict` (409) unless the stored revision matches. Omit for last-write-wins.',
    },
  },
};

// -------------------- Env + Secrets --------------------

/**
 * Discriminated `Scope` primitive from `@kindgi/platform` — declared
 * locally because `@kindgi/platform` has no OpenAPI schema module to
 * reference.
 *
 * Source of truth for the type: `packages/platform/src/scope.ts`.
 */
export const ScopeSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'tenantId'],
      properties: {
        kind: { type: 'string', enum: ['tenant'] },
        tenantId: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'tenantId', 'orgId'],
      properties: {
        kind: { type: 'string', enum: ['org'] },
        tenantId: { type: 'string' },
        orgId: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'tenantId', 'projectId'],
      properties: {
        kind: { type: 'string', enum: ['project'] },
        tenantId: { type: 'string' },
        projectId: { type: 'string' },
      },
    },
  ],
  description:
    'Discriminated Scope primitive (Tenant / Org / Project). Source of truth: `Scope` in `@kindgi/platform`.',
};

/** RFC-1035-like envName grammar. */
export const EnvNameSchema: JsonSchema = {
  type: 'string',
  pattern: '^[a-z][a-z0-9-]{0,62}$',
  description: 'Per-environment slug. `[a-z][a-z0-9-]{0,62}` — RFC-1035-like label.',
};

export const EnvRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'envName', 'name', 'value', 'revision', 'createdAt', 'updatedAt'],
  properties: {
    scope: { $ref: '#/components/schemas/Scope' },
    envName: { $ref: '#/components/schemas/EnvName' },
    name: { type: 'string' },
    value: { type: 'string' },
    revision: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    tags: { type: 'object', additionalProperties: { type: 'string' } },
  },
};

export const EnvListPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/EnvRecord' } },
    nextCursor: { type: 'string' },
  },
};

export const EnvSetInputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'envName', 'name', 'value'],
  properties: {
    scope: { $ref: '#/components/schemas/Scope' },
    envName: { $ref: '#/components/schemas/EnvName' },
    name: { type: 'string', minLength: 1 },
    value: { type: 'string' },
    tags: { type: 'object', additionalProperties: { type: 'string' } },
    ifRevision: { type: 'integer', minimum: 0 },
  },
};

export const EnvSetOutcomeSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'record'],
      properties: {
        kind: { type: 'string', enum: ['ok'] },
        record: { $ref: '#/components/schemas/EnvRecord' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'currentRevision'],
      properties: {
        kind: { type: 'string', enum: ['revision-conflict'] },
        currentRevision: { type: 'integer', minimum: 0 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'code', 'message'],
      properties: {
        kind: { type: 'string', enum: ['error'] },
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  ],
};

export const SecretRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'envName', 'name', 'currentVersion', 'createdAt', 'updatedAt'],
  properties: {
    scope: { $ref: '#/components/schemas/Scope' },
    envName: { $ref: '#/components/schemas/EnvName' },
    name: { type: 'string' },
    currentVersion: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    revokedAt: { type: 'string', format: 'date-time' },
    revokeReason: { type: 'string' },
    tags: { type: 'object', additionalProperties: { type: 'string' } },
    rotationDueAt: { type: 'string', format: 'date-time' },
  },
};

export const SecretListPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/SecretRecord' } },
    nextCursor: { type: 'string' },
  },
};

export const SecretVersionRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'envName', 'name', 'versionId', 'createdAt'],
  properties: {
    scope: { $ref: '#/components/schemas/Scope' },
    envName: { $ref: '#/components/schemas/EnvName' },
    name: { type: 'string' },
    versionId: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    value: {
      type: 'string',
      nullable: true,
      description: 'Present + non-null only on `resolve` responses.',
    },
    revokedAt: { type: 'string', format: 'date-time' },
  },
};

export const SecretSetInputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'envName', 'name', 'value', 'writeMode'],
  properties: {
    scope: { $ref: '#/components/schemas/Scope' },
    envName: { $ref: '#/components/schemas/EnvName' },
    name: { type: 'string', minLength: 1 },
    value: { type: 'string' },
    writeMode: { type: 'string', enum: ['create-new', 'add-version'] },
    tags: { type: 'object', additionalProperties: { type: 'string' } },
    rotationDueAt: { type: 'string', format: 'date-time' },
    ifVersion: { type: 'integer', minimum: 0 },
  },
};

export const SecretSetOutcomeSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'record', 'versionId'],
      properties: {
        kind: { type: 'string', enum: ['ok'] },
        record: { $ref: '#/components/schemas/SecretRecord' },
        versionId: { type: 'integer', minimum: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'record'],
      properties: {
        kind: { type: 'string', enum: ['already-exists'] },
        record: { $ref: '#/components/schemas/SecretRecord' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'currentVersion'],
      properties: {
        kind: { type: 'string', enum: ['version-conflict'] },
        currentVersion: { type: 'integer', minimum: 0 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'code', 'message'],
      properties: {
        kind: { type: 'string', enum: ['error'] },
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  ],
};

export const SecretResolveOutcomeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'versionId', 'value'],
  properties: {
    name: { type: 'string' },
    versionId: { type: 'integer', minimum: 1 },
    value: { type: 'string' },
  },
};

/**
 * `SecretBinding.rotate` outcome, discriminated on `kind`. Sync providers
 * return `{ kind: 'ok', … }` inline (mapped to a 201 wire response);
 * async providers return `{ kind: 'rotation-pending', resumeToken,
 * provider }` (mapped to a 202 wire response). The wire-level
 * response bodies are `SecretRotateResponseSync` /
 * `SecretRotateResponseAsync` — this schema mirrors the binding-level
 * discriminant.
 */
export const SecretRotateOutcomeSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'newVersionId', 'oldVersionId'],
      properties: {
        kind: { type: 'string', enum: ['ok'] },
        newVersionId: { type: 'integer', minimum: 1 },
        oldVersionId: { type: 'integer', minimum: 1 },
        oldVersionRevokedAt: { type: 'string', format: 'date-time' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'resumeToken', 'provider'],
      properties: {
        kind: { type: 'string', enum: ['rotation-pending'] },
        resumeToken: { type: 'string' },
        provider: { type: 'string' },
      },
    },
  ],
};

export const SecretRevokeOutcomeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['revoked', 'hard'],
  properties: {
    revoked: { type: 'boolean' },
    hard: { type: 'boolean' },
  },
};

/**
 * `?scopeKind` discriminator. Single reusable enum; `?scopeId` + `?inherit`
 * ride alongside as ParameterSpec definitions in `operations.ts`.
 */
export const ScopeKindSchema: JsonSchema = {
  type: 'string',
  enum: ['tenant', 'org', 'project'],
  description:
    'Discriminator for the ?scopeKind + ?scopeId + ?inherit triplet. Tenant carries no id (implicit from session); org/project require scopeId.',
};

export const UpsertTenantConfigResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['entry'],
  properties: {
    entry: { $ref: '#/components/schemas/TenantConfigEntry' },
  },
};

// -------- Env + Secrets — HTTP wire schemas --------

/** Cursor-paginated list response envelope shared by env + secrets. */
export const EnvCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/EnvRecord' } },
    nextCursor: { type: 'string' },
  },
};

export const EnvSetRequestSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: {
    // scope + envName + name are optional in the body — the route
    // pulls them from the URL / query first, then cross-validates
    // against the body. Missing body = OK (query-only path); mismatch
    // = 400 env-name-mismatch / scope-mismatch.
    scope: { $ref: '#/components/schemas/Scope' },
    envName: { $ref: '#/components/schemas/EnvName' },
    name: { type: 'string', minLength: 1 },
    value: { type: 'string' },
    tags: { type: 'object', additionalProperties: { type: 'string' } },
    ifRevision: { type: 'integer', minimum: 0 },
  },
};

export const EnvDeleteResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['deleted'],
  properties: {
    deleted: { type: 'boolean' },
  },
};

export const SecretCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/SecretRecord' } },
    nextCursor: { type: 'string' },
  },
};

export const SecretVersionCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/SecretVersionRecord' } },
    nextCursor: { type: 'string' },
  },
};

export const SecretSetRequestSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'envName', 'name', 'value', 'writeMode'],
  properties: {
    scope: { $ref: '#/components/schemas/Scope' },
    envName: { $ref: '#/components/schemas/EnvName' },
    name: { type: 'string', minLength: 1 },
    value: { type: 'string' },
    writeMode: { type: 'string', enum: ['create-new', 'add-version'] },
    tags: { type: 'object', additionalProperties: { type: 'string' } },
    rotationDueAt: { type: 'string', format: 'date-time' },
    ifVersion: { type: 'integer', minimum: 0 },
  },
};

export const SecretSetResponseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['record', 'versionId'],
  properties: {
    record: { $ref: '#/components/schemas/SecretRecord' },
    versionId: { type: 'integer', minimum: 1 },
  },
};

export const SecretRotateRequestSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { $ref: '#/components/schemas/Scope' },
    envName: { $ref: '#/components/schemas/EnvName' },
    newValue: { type: 'string' },
    revokeOldAfterMs: { type: 'integer', minimum: 0 },
  },
};

/** Sync-provider rotation response (201 Created). */
export const SecretRotateResponseSyncSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'newVersionId', 'oldVersionId'],
  properties: {
    kind: { type: 'string', enum: ['sync'] },
    newVersionId: { type: 'integer', minimum: 1 },
    oldVersionId: { type: 'integer', minimum: 1 },
    oldVersionRevokedAt: { type: 'string', format: 'date-time' },
  },
};

/** Async-provider rotation response (202 Accepted). */
export const SecretRotateResponseAsyncSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'rotationId', 'statusUrl', 'eventsUrl'],
  properties: {
    kind: { type: 'string', enum: ['async'] },
    rotationId: { type: 'string', format: 'uuid' },
    statusUrl: { type: 'string' },
    eventsUrl: { type: 'string' },
  },
};

export const RotationStatusSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rotationId', 'status', 'startedAt', 'updatedAt'],
  properties: {
    rotationId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['pending', 'succeeded', 'failed'] },
    startedAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    newVersionId: { type: 'integer', minimum: 1 },
    oldVersionId: { type: 'integer', minimum: 1 },
    error: { type: 'string' },
  },
};

export const SecretRevokeResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['revoked', 'hard'],
  properties: {
    revoked: { type: 'boolean' },
    hard: { type: 'boolean' },
  },
};

// -----------------------------------------------------------------------
// Trigger surface — schedules / event-triggers / webhooks.
// -----------------------------------------------------------------------

export const TriggerStatusSchema: JsonSchema = {
  type: 'string',
  enum: ['active', 'paused'],
  description:
    'Lifecycle status. Only `active` triggers fire. Tombstoned rows are excluded from every read path.',
};

// ---------- schedules (cron kind) ----------

export const ScheduleRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'scheduleId',
    'triggerId',
    'flowId',
    'flowVersion',
    'cronExpression',
    'label',
    'status',
    'nextFireAt',
    'lastFiredAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    scheduleId: {
      type: 'string',
      description:
        'Domain-friendly alias for `triggerId` — the trigger id (a UUID). Use interchangeably in admin URLs.',
    },
    triggerId: { type: 'string' },
    flowId: { type: 'string', minLength: 1 },
    flowVersion: { type: 'string', minLength: 1 },
    cronExpression: {
      type: 'string',
      minLength: 1,
      description:
        '5- or 6-field cron expression (croner-compatible). 6-field enables second precision.',
    },
    timezone: {
      type: 'string',
      description: 'IANA timezone (e.g. `UTC`, `America/New_York`). Absent → `UTC`.',
    },
    input: {
      description: 'Static input handed to the flow on every fire. Absent → `{}`.',
    },
    label: { type: ['string', 'null'] },
    status: { $ref: '#/components/schemas/TriggerStatus' },
    nextFireAt: {
      type: ['string', 'null'],
      format: 'date-time',
      description:
        'Wall-clock time of the next scheduled fire. `null` on paused rows if the cron scheduler never re-armed.',
    },
    lastFiredAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const ScheduleCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ScheduleRecord' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const RegisterScheduleBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['flowId', 'flowVersion', 'config'],
  properties: {
    flowId: { type: 'string', minLength: 1 },
    flowVersion: { type: 'string', minLength: 1 },
    config: {
      type: 'object',
      additionalProperties: false,
      required: ['cronExpression'],
      properties: {
        cronExpression: { type: 'string', minLength: 1 },
        timezone: { type: 'string' },
        input: {},
      },
    },
    label: { type: 'string' },
  },
};

export const PatchScheduleBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cronExpression: { type: 'string' },
        timezone: { type: 'string' },
        input: {},
      },
    },
    label: {
      type: ['string', 'null'],
      description: '`null` clears the label; omit to leave unchanged.',
    },
    flowVersion: { type: 'string' },
  },
};

// ---------- event triggers (event kind) ----------

export const EventTriggerRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'eventTriggerId',
    'triggerId',
    'flowId',
    'flowVersion',
    'eventKind',
    'label',
    'status',
    'lastFiredAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    eventTriggerId: {
      type: 'string',
      description: 'Domain-friendly alias for `triggerId`.',
    },
    triggerId: { type: 'string' },
    flowId: { type: 'string', minLength: 1 },
    flowVersion: { type: 'string', minLength: 1 },
    eventKind: {
      type: 'string',
      minLength: 1,
      description: 'Dotted event type this trigger listens for (e.g. `run.completed`).',
    },
    input: {
      description:
        'Override input handed to the flow. Absent → the whole `Event` object is passed.',
    },
    label: { type: ['string', 'null'] },
    status: { $ref: '#/components/schemas/TriggerStatus' },
    lastFiredAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const EventTriggerCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/EventTriggerRecord' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const RegisterEventTriggerBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['flowId', 'flowVersion', 'config'],
  properties: {
    flowId: { type: 'string', minLength: 1 },
    flowVersion: { type: 'string', minLength: 1 },
    config: {
      type: 'object',
      additionalProperties: false,
      required: ['eventKind'],
      properties: {
        eventKind: { type: 'string', minLength: 1 },
        input: {},
      },
    },
    label: { type: 'string' },
  },
};

export const PatchEventTriggerBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        eventKind: { type: 'string' },
        input: {},
      },
    },
    label: { type: ['string', 'null'] },
    flowVersion: { type: 'string' },
  },
};

// ---------- webhook triggers (webhook kind) ----------

export const WebhookTriggerRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'triggerId',
    'webhookId',
    'flowId',
    'flowVersion',
    'hmacSecretName',
    'label',
    'status',
    'lastFiredAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    triggerId: { type: 'string' },
    webhookId: {
      type: 'string',
      description:
        'Routable identifier used in the external receiver URL. Route-minted; unique per tenant.',
    },
    flowId: { type: 'string', minLength: 1 },
    flowVersion: { type: 'string', minLength: 1 },
    input: {
      description: 'Override input; absent → the parsed request body is passed to the flow.',
    },
    hmacSecretName: {
      type: 'string',
      minLength: 1,
      description:
        'Handle into the tenant secrets store. Plaintext HMAC secrets never touch this row — the caller writes plaintext to `/v1/secrets` first, then passes the name here.',
    },
    label: { type: ['string', 'null'] },
    status: { $ref: '#/components/schemas/TriggerStatus' },
    lastFiredAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const WebhookTriggerCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/WebhookTriggerRecord' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const RegisterWebhookTriggerBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['flowId', 'flowVersion', 'hmacSecretName'],
  properties: {
    flowId: { type: 'string', minLength: 1 },
    flowVersion: { type: 'string', minLength: 1 },
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: {},
      },
    },
    hmacSecretName: {
      type: 'string',
      minLength: 1,
      description:
        'Handle into the tenant secrets store. Caller writes plaintext to `/v1/secrets` first and passes the name here.',
    },
    label: { type: 'string' },
  },
};

export const PatchWebhookTriggerBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: {},
      },
    },
    label: { type: ['string', 'null'] },
    flowVersion: { type: 'string' },
  },
};

// ---------- shared lifecycle result (unregister) ----------

export const ScheduleUnregisterResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scheduleId', 'unregistered'],
  properties: {
    scheduleId: { type: 'string' },
    unregistered: {
      type: 'boolean',
      description: '`true` iff this call tombstoned the row; `false` on idempotent re-invocation.',
    },
  },
};

export const EventTriggerUnregisterResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['eventTriggerId', 'unregistered'],
  properties: {
    eventTriggerId: { type: 'string' },
    unregistered: { type: 'boolean' },
  },
};

export const WebhookTriggerUnregisterResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['triggerId', 'unregistered'],
  properties: {
    triggerId: { type: 'string' },
    unregistered: { type: 'boolean' },
  },
};

// ---------- outbound webhook endpoints ----------

export const WebhookEventTypeSchema: JsonSchema = {
  type: 'string',
  enum: ['run.finished'],
  description: 'An event type an endpoint can subscribe to.',
};

export const WebhookEndpointFilterSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Which events reach the endpoint. Every field narrows; absent fields do not. `run.finished` is sent for top-level runs only.',
  properties: {
    projectId: { type: 'string', minLength: 1, description: 'Only runs in this project.' },
    flowIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', minLength: 1, maxLength: 200 },
      description: 'Only runs of these flows (any version).',
    },
    includeDryRuns: {
      type: 'boolean',
      description: 'Dry runs are left out unless this is `true`.',
    },
  },
};

export const WebhookEndpointSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'endpointId',
    'url',
    'events',
    'filter',
    'description',
    'secretRef',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    endpointId: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    events: { type: 'array', items: { $ref: '#/components/schemas/WebhookEventType' } },
    filter: { $ref: '#/components/schemas/WebhookEndpointFilter' },
    description: { type: ['string', 'null'] },
    secretRef: { $ref: '#/components/schemas/WebhookSecretRef' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const WebhookSecretRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['envName', 'name'],
  description:
    "A secret by name in the deployment's secrets store, resolved at tenant scope (the same shape as a provider's `secret_ref`). The value is `whsec_` + base64 of at least 24 random bytes (or that base64 alone); the store keeps it, the endpoint keeps only this reference.",
  properties: {
    envName: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}$' },
    name: { type: 'string', minLength: 1, maxLength: 256 },
  },
};

export const GeneratedWebhookSecretSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['secret'],
  properties: {
    secret: {
      type: 'string',
      description:
        'A new signing secret (`whsec_` + base64 of 32 random bytes). Not stored anywhere: put it in your secrets (`.env` in development, the secrets store in production) and reference it by name.',
    },
  },
};

export const WebhookEndpointCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/WebhookEndpoint' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const CreateWebhookEndpointBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'events', 'secretRef'],
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      maxLength: 2048,
      description:
        'Absolute https URL (http only where the deployment allows it, e.g. development). No credentials in the URL. The deployment may refuse private network addresses (`400 webhook-url-refused`).',
    },
    events: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/components/schemas/WebhookEventType' },
    },
    filter: { $ref: '#/components/schemas/WebhookEndpointFilter' },
    secretRef: { $ref: '#/components/schemas/WebhookSecretRef' },
    description: { type: 'string', maxLength: 500 },
  },
};

export const PatchWebhookEndpointBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'Fields to change; absent fields are kept. `filter` is replaced as a whole.',
  properties: {
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    events: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/components/schemas/WebhookEventType' },
    },
    filter: { $ref: '#/components/schemas/WebhookEndpointFilter' },
    secretRef: { $ref: '#/components/schemas/WebhookSecretRef' },
    description: { type: ['string', 'null'], maxLength: 500, description: '`null` clears it.' },
  },
};

export const WebhookEndpointUnregisterResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['endpointId', 'unregistered'],
  properties: {
    endpointId: { type: 'string' },
    unregistered: {
      type: 'boolean',
      description:
        '`true` iff this call unregistered the endpoint; `false` when it was unknown or already unregistered.',
    },
  },
};

/** A run tree's model calls, as `run.finished` carries them. */
export const RunTreeUsageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['calls', 'costUsd', 'tokens'],
  description:
    "The model calls of the run tree (this run and every run it started) that the cost ledger had recorded when this run finished: a child run still running then isn't in it. `calls` counts failed calls too. Absent when the runtime records no usage.",
  properties: {
    calls: { type: 'integer', minimum: 0 },
    costUsd: { type: 'number', minimum: 0 },
    tokens: { $ref: '#/components/schemas/CostTokenTotals' },
  },
};

export const FinishedRunSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'A finished top-level run: its identity and outcome, never its input or output. Field names match `GET /v1/runs/{runId}`.',
  required: [
    'id',
    'projectId',
    'flowId',
    'flowVersion',
    'status',
    'dryRun',
    'failureMessage',
    'createdAt',
    'completedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'RunId.' },
    projectId: { type: 'string', format: 'uuid' },
    flowId: { type: 'string' },
    flowVersion: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
    dryRun: { type: 'boolean' },
    failureMessage: {
      type: ['string', 'null'],
      description: 'Why the run failed or was cancelled; `null` when it completed.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
    usage: { $ref: '#/components/schemas/RunTreeUsage' },
  },
};

export const RunFinishedEventSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'createdAt', 'data'],
  properties: {
    id: {
      type: 'string',
      description: 'Event id, also sent as the `webhook-id` header; the same on every retry.',
    },
    type: { type: 'string', const: 'run.finished' },
    createdAt: { type: 'string', format: 'date-time' },
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['run'],
      properties: { run: { $ref: '#/components/schemas/FinishedRun' } },
    },
  },
};

export const WebhookTestEventSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'createdAt', 'data'],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'webhook.test' },
    createdAt: { type: 'string', format: 'date-time' },
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['endpointId'],
      properties: { endpointId: { type: 'string' } },
    },
  },
};

export const WebhookEventSchema: JsonSchema = {
  description: 'The JSON body of every webhook request.',
  oneOf: [
    { $ref: '#/components/schemas/RunFinishedEvent' },
    { $ref: '#/components/schemas/WebhookTestEvent' },
  ],
  discriminator: {
    propertyName: 'type',
    mapping: {
      'run.finished': '#/components/schemas/RunFinishedEvent',
      'webhook.test': '#/components/schemas/WebhookTestEvent',
    },
  },
};

export const WebhookDeliveryStatusSchema: JsonSchema = {
  type: 'string',
  enum: ['pending', 'delivered', 'failed'],
  description:
    '`pending`: waiting for its next attempt. `delivered`: the endpoint answered 2xx. `failed`: every attempt failed, or the endpoint was unregistered first; redeliver queues it again.',
};

export const WebhookDeliverySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'deliveryId',
    'endpointId',
    'event',
    'status',
    'attempts',
    'nextAttemptAt',
    'lastAttemptAt',
    'lastResponseStatus',
    'lastError',
    'createdAt',
    'deliveredAt',
  ],
  properties: {
    deliveryId: { type: 'string' },
    endpointId: { type: 'string' },
    event: { $ref: '#/components/schemas/WebhookEvent' },
    status: { $ref: '#/components/schemas/WebhookDeliveryStatus' },
    attempts: { type: 'integer', minimum: 0 },
    nextAttemptAt: { type: ['string', 'null'], format: 'date-time' },
    lastAttemptAt: { type: ['string', 'null'], format: 'date-time' },
    lastResponseStatus: {
      type: ['integer', 'null'],
      description: 'HTTP status of the last attempt; `null` when it got no response.',
    },
    lastError: {
      type: ['string', 'null'],
      description:
        'Why the last attempt failed (`timeout`, `connection-refused`, `url-refused`, …).',
    },
    createdAt: { type: 'string', format: 'date-time' },
    deliveredAt: { type: ['string', 'null'], format: 'date-time' },
  },
};

export const WebhookDeliveryCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/WebhookDelivery' } },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
  },
};

export const MintPublicRunTokenBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runIds'],
  properties: {
    runIds: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { type: 'string', minLength: 1 },
      description: 'The runs the token may read; their descendants are readable too.',
    },
    expiresInSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 86400,
      description: 'Lifetime; the deployment default (15 minutes) when absent.',
    },
  },
};

export const MintPublicRunTokenResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['token', 'expiresAt', 'runIds'],
  properties: {
    token: { type: 'string', description: 'The public run token (`kgi_pt_…`).' },
    expiresAt: { type: 'string', format: 'date-time' },
    runIds: { type: 'array', items: { type: 'string' } },
  },
};

export const COMPONENT_SCHEMAS: ReadonlyArray<readonly [string, JsonSchema]> = [
  ['WireError', WireErrorSchema],
  ['HealthResult', HealthResultSchema],
  ['RunStatus', RunStatusSchema],
  ['RunAgent', RunAgentSchema],
  ['Run', RunSchema],
  ['StartRunOptions', StartRunOptionsSchema],
  ['StartRunBody', StartRunBodySchema],
  ['ResumeRunBody', ResumeRunBodySchema],
  ['RunCollectionPage', RunCollectionPageSchema],
  ['JournalKind', JournalKindSchema],
  ['JournalEntry', JournalEntrySchema],
  ['RunJournalPage', RunJournalPageSchema],
  ['RunEvent', RunEventSchema],
  ['RunProgress', RunProgressSchema],
  ['RunProgressEvent', RunProgressEventSchema],
  ['MintTokenBody', MintTokenBodySchema],
  ['MintTokenResult', MintTokenResultSchema],
  ['ApiToken', ApiTokenSchema],
  ['ApiTokenPage', ApiTokenPageSchema],
  ['RevokeTokenResult', RevokeTokenResultSchema],
  ['TrustedSigningKey', TrustedSigningKeySchema],
  ['TrustSigningKeyBody', TrustSigningKeyBodySchema],
  ['TrustedSigningKeyPage', TrustedSigningKeyPageSchema],
  ['RevokeSigningKeyBody', RevokeSigningKeyBodySchema],
  ['RevokeSigningKeyResult', RevokeSigningKeyResultSchema],
  ['MintPublicRunTokenBody', MintPublicRunTokenBodySchema],
  ['MintPublicRunTokenResult', MintPublicRunTokenResultSchema],
  ['ReviewerRole', ReviewerRoleSchema],
  ['ApprovalStatus', ApprovalStatusSchema],
  ['ReviewDecisionKind', ReviewDecisionKindSchema],
  ['Approval', ApprovalSchema],
  ['ApprovalDecisionRecord', ApprovalDecisionRecordSchema],
  ['ReviewDecision', ReviewDecisionSchema],
  ['ApprovalCollectionPage', ApprovalCollectionPageSchema],
  ['CompleteApprovalBody', CompleteApprovalBodySchema],
  ['CompleteApprovalResult', CompleteApprovalResultSchema],
  ['Reviewer', ReviewerSchema],
  ['ReviewerCollectionPage', ReviewerCollectionPageSchema],
  ['RegisterReviewerBody', RegisterReviewerBodySchema],
  ['UnregisterReviewerResult', UnregisterReviewerResultSchema],
  ['ExportAuditBundleBody', ExportAuditBundleBodySchema],
  ['ExportAuditBundleResult', ExportAuditBundleResultSchema],
  ['ObservationStatus', ObservationStatusSchema],
  ['Observation', ObservationSchema],
  ['ObservationCollectionPage', ObservationCollectionPageSchema],
  ['JudgeClassScope', JudgeClassScopeSchema],
  ['JudgeClass', JudgeClassSchema],
  ['JudgeClassCollectionPage', JudgeClassCollectionPageSchema],
  ['CreateJudgeClassBody', CreateJudgeClassBodySchema],
  ['UpdateJudgeClassBody', UpdateJudgeClassBodySchema],
  ['UnregisterJudgeClassResult', UnregisterJudgeClassResultSchema],
  ['JudgedSubject', JudgedSubjectSchema],
  ['JudgedItem', JudgedItemSchema],
  ['JudgmentAssertedBy', JudgmentAssertedBySchema],
  ['Judgment', JudgmentSchema],
  ['JudgedRunContext', JudgedRunContextSchema],
  ['JudgedRunCopy', JudgedRunCopySchema],
  ['JudgmentWithCopies', JudgmentWithCopiesSchema],
  ['JudgmentCollectionPage', JudgmentCollectionPageSchema],
  ['CreateJudgmentBody', CreateJudgmentBodySchema],
  ['UnregisterJudgmentResult', UnregisterJudgmentResultSchema],
  ['JudgedItemSummary', JudgedItemSummarySchema],
  ['JudgedEvalCase', JudgedEvalCaseSchema],
  ['JudgedEvalCaseCollectionPage', JudgedEvalCaseCollectionPageSchema],
  ['BuildJudgedSuiteBody', BuildJudgedSuiteBodySchema],
  ['BuildJudgedSuiteResult', BuildJudgedSuiteResultSchema],
  ['PromptParameter', PromptParameterSchema],
  ['RetrievalIntent', RetrievalIntentSchema],
  ['ConversationPolicy', ConversationPolicySchema],
  ['TurnBudget', TurnBudgetSchema],
  ['Capability', CapabilitySchema],
  ['ToolRef', ToolRefSchema],
  ['AgentOutputSpec', AgentOutputSpecSchema],
  ['ToolErrorsSpec', ToolErrorsSpecSchema],
  ['Agent', AgentSchema],
  ['AgentPins', AgentPinsSchema],
  ['PinChange', PinChangeSchema],
  ['VersionDerivation', VersionDerivationSchema],
  ['FlowPins', FlowPinsSchema],
  ['PublishAgentBody', PublishAgentBodySchema],
  ['PublishAgentResult', PublishAgentResultSchema],
  ['UnregisterAgentResult', UnregisterAgentResultSchema],
  ['ReinstateAgentVersionResult', ReinstateAgentVersionResultSchema],
  ['AgentCollectionPage', AgentCollectionPageSchema],
  ['FlowNode', FlowNodeSchema],
  ['FlowEdge', FlowEdgeSchema],
  ['Flow', FlowSchema],
  ['PublishFlowBody', PublishFlowBodySchema],
  ['PublishFlowResult', PublishFlowResultSchema],
  ['UnregisterFlowResult', UnregisterFlowResultSchema],
  ['ReinstateFlowVersionResult', ReinstateFlowVersionResultSchema],
  ['FlowCollectionPage', FlowCollectionPageSchema],
  ['ToolEffect', ToolEffectSchema],
  ['ToolNeed', ToolNeedSchema],
  ['ToolSecretRef', ToolSecretRefSchema],
  ['HttpHeaderSpec', HttpHeaderSpecSchema],
  ['HttpAuthSpec', HttpAuthSpecSchema],
  ['HttpRequestBodySpec', HttpRequestBodySpecSchema],
  ['HttpToolSpec', HttpToolSpecSchema],
  ['SandboxMode', SandboxModeSchema],
  ['RuntimeLimits', RuntimeLimitsSchema],
  ['NetworkPolicy', NetworkPolicySchema],
  ['TypedNeeds', TypedNeedsSchema],
  ['CodeArtifactRef', CodeArtifactRefSchema],
  ['ToolSpec', ToolSpecSchema],
  ['Tool', ToolSchema],
  ['RegisterToolBody', RegisterToolBodySchema],
  ['RegisterToolResult', RegisterToolResultSchema],
  ['UnregisterToolResult', UnregisterToolResultSchema],
  ['ReinstateToolVersionResult', ReinstateToolVersionResultSchema],
  ['ToolCollectionPage', ToolCollectionPageSchema],
  ['ToolVersionRow', ToolVersionRowSchema],
  ['ToolVersionCollectionPage', ToolVersionCollectionPageSchema],
  ['GuardrailAction', GuardrailActionSchema],
  ['GuardrailScope', GuardrailScopeSchema],
  ['Guardrail', GuardrailSchema],
  ['RegisterGuardrailBody', RegisterGuardrailBodySchema],
  ['RegisterGuardrailResult', RegisterGuardrailResultSchema],
  ['UnregisterGuardrailResult', UnregisterGuardrailResultSchema],
  ['GuardrailCollectionPage', GuardrailCollectionPageSchema],
  ['ConversationStatus', ConversationStatusSchema],
  ['Conversation', ConversationSchema],
  ['ConversationMessage', ConversationMessageSchema],
  ['OpenConversationBody', OpenConversationBodySchema],
  ['ConversationCollectionPage', ConversationCollectionPageSchema],
  ['ConversationMessageCollectionPage', ConversationMessageCollectionPageSchema],
  ['FactScope', FactScopeSchema],
  ['Retention', RetentionSchema],
  ['SourceFreshness', SourceFreshnessSchema],
  ['SourceRefresh', SourceRefreshSchema],
  ['FactSource', FactSourceSchema],
  ['Fact', FactSchema],
  ['FactCollectionPage', FactCollectionPageSchema],
  ['WriteFactBody', WriteFactBodySchema],
  ['SupersedeFactResult', SupersedeFactResultSchema],
  ['RetrieveIntent', RetrieveIntentSchema],
  ['RetrieveMemoryBody', RetrieveMemoryBodySchema],
  ['RetrievalHit', RetrievalHitSchema],
  ['RetrieveMemoryResult', RetrieveMemoryResultSchema],
  ['ProposalTier', ProposalTierSchema],
  ['FixProposalStatus', FixProposalStatusSchema],
  ['PatternRef', PatternRefSchema],
  ['ProposedChange', ProposedChangeSchema],
  ['FixProposal', FixProposalSchema],
  ['FixProposalCollectionPage', FixProposalCollectionPageSchema],
  ['PassCriterion', PassCriterionSchema],
  ['DraftProposalBody', DraftProposalBodySchema],
  ['DryRunProposalBody', DryRunProposalBodySchema],
  ['DryRunProposalResult', DryRunProposalResultSchema],
  ['SubmitReviewProposalBody', SubmitReviewProposalBodySchema],
  ['SubmitReviewProposalResult', SubmitReviewProposalResultSchema],
  ['ApplyProposalBody', ApplyProposalBodySchema],
  ['ApplyProposalResult', ApplyProposalResultSchema],
  ['RollbackProposalBody', RollbackProposalBodySchema],
  ['RollbackProposalResult', RollbackProposalResultSchema],
  ['WithdrawProposalBody', WithdrawProposalBodySchema],
  ['ProvenanceNodeKind', ProvenanceNodeKindSchema],
  ['ProvenanceEdgeKind', ProvenanceEdgeKindSchema],
  ['ProvenanceNode', ProvenanceNodeSchema],
  ['ProvenanceEdge', ProvenanceEdgeSchema],
  ['ProvenanceFlowRef', ProvenanceFlowRefSchema],
  ['ProvenanceSignature', ProvenanceSignatureSchema],
  ['ProvenanceRecordMetadata', ProvenanceRecordMetadataSchema],
  ['ProvenanceRecord', ProvenanceRecordSchema],
  ['ProvenanceCollectionPage', ProvenanceCollectionPageSchema],
  ['ExportProvenanceBody', ExportProvenanceBodySchema],
  ['ExportProvenanceResult', ExportProvenanceResultSchema],
  ['BlobMeta', BlobMetaSchema],
  ['ArtifactCollectionPage', ArtifactCollectionPageSchema],
  ['UploadArtifactBody', UploadArtifactBodySchema],
  ['DeleteArtifactResult', DeleteArtifactResultSchema],
  ['Feature', FeatureSchema],
  ['CapabilityDescriptor', CapabilityDescriptorSchema],
  ['CapabilityCollectionPage', CapabilityCollectionPageSchema],
  ['ProviderCost', ProviderCostSchema],
  ['ModelInfo', ModelInfoSchema],
  ['ProviderMetadata', ProviderMetadataSchema],
  ['ProviderCollectionPage', ProviderCollectionPageSchema],
  ['RegisterProviderBody', RegisterProviderBodySchema],
  ['RegisterProviderResult', RegisterProviderResultSchema],
  ['UnregisterProviderResult', UnregisterProviderResultSchema],
  ['ProviderCapabilitiesResult', ProviderCapabilitiesResultSchema],
  ['MCPTransport', MCPTransportSchema],
  ['MCPEndpoint', MCPEndpointSchema],
  ['MCPEndpointSecretRef', MCPEndpointSecretRefSchema],
  ['MCPEndpointCollectionPage', MCPEndpointCollectionPageSchema],
  ['RegisterMCPEndpointBody', RegisterMCPEndpointBodySchema],
  ['RegisterMCPEndpointResult', RegisterMCPEndpointResultSchema],
  ['UnregisterMCPEndpointResult', UnregisterMCPEndpointResultSchema],
  ['MCPResource', MCPResourceSchema],
  ['MCPResourceCollection', MCPResourceCollectionSchema],
  ['MCPResourceContent', MCPResourceContentSchema],
  ['MCPPromptArgument', MCPPromptArgumentSchema],
  ['MCPPrompt', MCPPromptSchema],
  ['MCPPromptCollection', MCPPromptCollectionSchema],
  ['MCPPromptMessage', MCPPromptMessageSchema],
  ['GetMCPPromptBody', GetMCPPromptBodySchema],
  ['GetMCPPromptResult', GetMCPPromptResultSchema],
  ['CostGroupDimension', CostGroupDimensionSchema],
  ['CostRecord', CostRecordSchema],
  ['ModelCallTokens', ModelCallTokensSchema],
  ['ModelCallError', ModelCallErrorSchema],
  ['CostTokenTotals', CostTokenTotalsSchema],
  ['CostRecordCollectionPage', CostRecordCollectionPageSchema],
  ['CostAggregateGroup', CostAggregateGroupSchema],
  ['CostAggregateResult', CostAggregateResultSchema],
  ['AdapterKind', AdapterKindSchema],
  ['AdapterStatus', AdapterStatusSchema],
  ['Adapter', AdapterSchema],
  ['AdapterCollectionPage', AdapterCollectionPageSchema],
  ['TestAdapterBody', TestAdapterBodySchema],
  ['AdapterTestOutcome', AdapterTestOutcomeSchema],
  ['PolicyKind', PolicyKindSchema],
  ['Policy', PolicySchema],
  ['PolicyCollectionPage', PolicyCollectionPageSchema],
  ['PolicyVersionRow', PolicyVersionRowSchema],
  ['PolicyVersionCollectionPage', PolicyVersionCollectionPageSchema],
  ['PublishPolicyBody', PublishPolicyBodySchema],
  ['PublishPolicyResult', PublishPolicyResultSchema],
  ['UnregisterPolicyResult', UnregisterPolicyResultSchema],
  ['ReinstatePolicyVersionResult', ReinstatePolicyVersionResultSchema],
  ['EvalKind', EvalKindSchema],
  ['EvalSuite', EvalSuiteSchema],
  ['EvalSuiteCollectionPage', EvalSuiteCollectionPageSchema],
  ['PublishEvalSuiteBody', PublishEvalSuiteBodySchema],
  ['PublishEvalSuiteResult', PublishEvalSuiteResultSchema],
  ['UnregisterEvalSuiteResult', UnregisterEvalSuiteResultSchema],
  ['ReinstateEvalSuiteVersionResult', ReinstateEvalSuiteVersionResultSchema],
  ['BlockKind', BlockKindSchema],
  ['PromptBlockContent', PromptBlockContentSchema],
  ['SettingsBlockContent', SettingsBlockContentSchema],
  ['Block', BlockSchema],
  ['BlockCollectionPage', BlockCollectionPageSchema],
  ['PublishBlockBody', PublishBlockBodySchema],
  ['PublishBlockResult', PublishBlockResultSchema],
  ['UnregisterBlockResult', UnregisterBlockResultSchema],
  ['ReinstateBlockResult', ReinstateBlockResultSchema],
  ['EvalRunStatus', EvalRunStatusSchema],
  ['EvalRunAgentRef', EvalRunAgentRefSchema],
  ['EvalRunFlowRef', EvalRunFlowRefSchema],
  ['EvalBaseline', EvalBaselineSchema],
  ['EvalComparison', EvalComparisonSchema],
  ['EvalRun', EvalRunSchema],
  ['EvalRunCollectionPage', EvalRunCollectionPageSchema],
  ['StartEvalRunBody', StartEvalRunBodySchema],
  ['StartEvalRunResult', StartEvalRunResultSchema],
  ['IdentityProviderKind', IdentityProviderKindSchema],
  ['ClaimMappingScopesSpec', ClaimMappingScopesSpecSchema],
  ['ClaimMappingSpec', ClaimMappingSpecSchema],
  ['IdentityProviderConfig', IdentityProviderConfigSchema],
  ['IdentityProviderCollectionPage', IdentityProviderCollectionPageSchema],
  ['RegisterIdentityProviderResult', RegisterIdentityProviderResultSchema],
  ['UnregisterIdentityProviderResult', UnregisterIdentityProviderResultSchema],
  ['LoginBody', LoginBodySchema],
  ['AuthorizationResponse', AuthorizationResponseSchema],
  ['CallbackBody', CallbackBodySchema],
  ['CallbackResult', CallbackResultSchema],
  ['RefreshResult', RefreshResultSchema],
  ['LogoutResult', LogoutResultSchema],
  ['WhoamiResult', WhoamiResultSchema],
  ['UserRecord', UserRecordSchema],
  ['UserCollectionPage', UserCollectionPageSchema],
  ['IdentitySessionSummary', IdentitySessionSummarySchema],
  ['IdentitySessionCollectionPage', IdentitySessionCollectionPageSchema],
  ['RevokeSessionsResult', RevokeSessionsResultSchema],
  ['DeploymentPrimitiveCounts', DeploymentPrimitiveCountsSchema],
  ['DeploymentContents', DeploymentContentsSchema],
  ['DeploymentRecord', DeploymentRecordSchema],
  ['DeploymentRegistrationBody', DeploymentRegistrationBodySchema],
  ['DeploymentCollectionPage', DeploymentCollectionPageSchema],
  ['DeploymentValidationDetails', DeploymentValidationDetailsSchema],
  ['DeploymentSecretsSyncRequest', DeploymentSecretsSyncRequestSchema],
  ['DeploymentSecretsSyncResponse', DeploymentSecretsSyncResponseSchema],
  ['EvidenceKind', EvidenceKindSchema],
  ['EvidenceActor', EvidenceActorSchema],
  ['EvidenceSubject', EvidenceSubjectSchema],
  ['EvidenceOutcome', EvidenceOutcomeSchema],
  ['EvidenceProvenanceRef', EvidenceProvenanceRefSchema],
  ['EvidenceSignature', EvidenceSignatureSchema],
  ['ComplianceEvidence', ComplianceEvidenceSchema],
  ['ComplianceEvidenceCollectionPage', ComplianceEvidenceCollectionPageSchema],
  ['ExportComplianceEvidenceFilter', ExportComplianceEvidenceFilterSchema],
  ['ExportComplianceEvidenceBody', ExportComplianceEvidenceBodySchema],
  ['SignedComplianceEvidenceBundle', SignedComplianceEvidenceBundleSchema],
  // Platform hierarchy.
  ['Org', OrgSchema],
  ['OrgSpec', OrgSpecSchema],
  ['OrgPatch', OrgPatchSchema],
  ['OrgCollectionPage', OrgCollectionPageSchema],
  ['CreateResourceResult', CreateResourceResultSchema],
  ['TeamRole', TeamRoleSchema],
  ['Team', TeamSchema],
  ['TeamSpec', TeamSpecSchema],
  ['TeamPatch', TeamPatchSchema],
  ['TeamCollectionPage', TeamCollectionPageSchema],
  ['TeamMembership', TeamMembershipSchema],
  ['TeamMembershipCollectionPage', TeamMembershipCollectionPageSchema],
  ['AddTeamMembershipBody', AddTeamMembershipBodySchema],
  ['UpdateTeamMembershipBody', UpdateTeamMembershipBodySchema],
  ['AddTeamMembershipResult', AddTeamMembershipResultSchema],
  ['ProjectRole', ProjectRoleSchema],
  ['Project', ProjectSchema],
  ['ProjectSpec', ProjectSpecSchema],
  ['ProjectPatch', ProjectPatchSchema],
  ['ProjectCollectionPage', ProjectCollectionPageSchema],
  ['ProjectMembership', ProjectMembershipSchema],
  ['ProjectMembershipCollectionPage', ProjectMembershipCollectionPageSchema],
  ['AddProjectMembershipBody', AddProjectMembershipBodySchema],
  ['UpdateProjectMembershipBody', UpdateProjectMembershipBodySchema],
  ['AddProjectMembershipResult', AddProjectMembershipResultSchema],
  ['Tenant', TenantSchema],
  ['TenantConfigKind', TenantConfigKindSchema],
  ['TenantConfigEntry', TenantConfigEntrySchema],
  ['TenantConfigCollectionPage', TenantConfigCollectionPageSchema],
  ['UpsertTenantConfigBody', UpsertTenantConfigBodySchema],
  ['UpsertTenantConfigResult', UpsertTenantConfigResultSchema],
  ['ScopeKind', ScopeKindSchema],
  // Env + Secrets.
  ['Scope', ScopeSchema],
  ['EnvName', EnvNameSchema],
  ['EnvRecord', EnvRecordSchema],
  ['EnvListPage', EnvListPageSchema],
  ['EnvSetInput', EnvSetInputSchema],
  ['EnvSetOutcome', EnvSetOutcomeSchema],
  ['SecretRecord', SecretRecordSchema],
  ['SecretListPage', SecretListPageSchema],
  ['SecretVersionRecord', SecretVersionRecordSchema],
  ['SecretSetInput', SecretSetInputSchema],
  ['SecretSetOutcome', SecretSetOutcomeSchema],
  ['SecretResolveOutcome', SecretResolveOutcomeSchema],
  ['SecretRotateOutcome', SecretRotateOutcomeSchema],
  ['SecretRevokeOutcome', SecretRevokeOutcomeSchema],
  // Env + Secrets — HTTP wire schemas.
  ['EnvCollectionPage', EnvCollectionPageSchema],
  ['EnvSetRequest', EnvSetRequestSchema],
  ['EnvDeleteResult', EnvDeleteResultSchema],
  ['SecretCollectionPage', SecretCollectionPageSchema],
  ['SecretVersionCollectionPage', SecretVersionCollectionPageSchema],
  ['SecretSetRequest', SecretSetRequestSchema],
  ['SecretSetResponse', SecretSetResponseSchema],
  ['SecretRotateRequest', SecretRotateRequestSchema],
  ['SecretRotateResponseSync', SecretRotateResponseSyncSchema],
  ['SecretRotateResponseAsync', SecretRotateResponseAsyncSchema],
  ['RotationStatus', RotationStatusSchema],
  ['SecretRevokeResult', SecretRevokeResultSchema],
  // Trigger surface.
  ['TriggerStatus', TriggerStatusSchema],
  ['ScheduleRecord', ScheduleRecordSchema],
  ['ScheduleCollectionPage', ScheduleCollectionPageSchema],
  ['RegisterScheduleBody', RegisterScheduleBodySchema],
  ['PatchScheduleBody', PatchScheduleBodySchema],
  ['ScheduleUnregisterResult', ScheduleUnregisterResultSchema],
  ['EventTriggerRecord', EventTriggerRecordSchema],
  ['EventTriggerCollectionPage', EventTriggerCollectionPageSchema],
  ['RegisterEventTriggerBody', RegisterEventTriggerBodySchema],
  ['PatchEventTriggerBody', PatchEventTriggerBodySchema],
  ['EventTriggerUnregisterResult', EventTriggerUnregisterResultSchema],
  ['WebhookTriggerRecord', WebhookTriggerRecordSchema],
  ['WebhookTriggerCollectionPage', WebhookTriggerCollectionPageSchema],
  ['RegisterWebhookTriggerBody', RegisterWebhookTriggerBodySchema],
  ['PatchWebhookTriggerBody', PatchWebhookTriggerBodySchema],
  ['WebhookTriggerUnregisterResult', WebhookTriggerUnregisterResultSchema],
  // Outbound webhook endpoints.
  ['WebhookEventType', WebhookEventTypeSchema],
  ['WebhookEndpointFilter', WebhookEndpointFilterSchema],
  ['WebhookEndpoint', WebhookEndpointSchema],
  ['WebhookSecretRef', WebhookSecretRefSchema],
  ['GeneratedWebhookSecret', GeneratedWebhookSecretSchema],
  ['WebhookEndpointCollectionPage', WebhookEndpointCollectionPageSchema],
  ['CreateWebhookEndpointBody', CreateWebhookEndpointBodySchema],
  ['PatchWebhookEndpointBody', PatchWebhookEndpointBodySchema],
  ['WebhookEndpointUnregisterResult', WebhookEndpointUnregisterResultSchema],
  ['RunTreeUsage', RunTreeUsageSchema],
  ['FinishedRun', FinishedRunSchema],
  ['RunFinishedEvent', RunFinishedEventSchema],
  ['WebhookTestEvent', WebhookTestEventSchema],
  ['WebhookEvent', WebhookEventSchema],
  ['WebhookDeliveryStatus', WebhookDeliveryStatusSchema],
  ['WebhookDelivery', WebhookDeliverySchema],
  ['WebhookDeliveryCollectionPage', WebhookDeliveryCollectionPageSchema],
] as const;

/** Convenience `$ref` builder. */
export function ref(componentName: string): JsonSchema {
  return { $ref: `#/components/schemas/${componentName}` };
}

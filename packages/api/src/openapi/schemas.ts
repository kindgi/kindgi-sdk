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

import { OBJECT_ACTIONS, OBJECT_TYPES } from '@kindgi/authz';
import { EVIDENCE_KINDS } from '@kindgi/compliance';
import {
  MAX_TOOL_ERROR_RETRIES,
  POLICY_KINDS,
  RETENTION_DOMAINS,
  TOOL_ERROR_KINDS,
} from '@kindgi/policy-contract';

import { ERROR_CODE_TO_STATUS } from '../errors.js';

export type JsonSchema = Record<string, unknown>;

// ---------------- shared shapes ----------------

export const WireErrorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  // Every code the API answers with, and its HTTP status. Not a closed
  // list for clients (a newer server may add codes); the clients' tests
  // read it to check that each 4xx code maps to a typed error, not to a
  // server error. Generators and validators ignore `x-` keys.
  'x-error-codes': ERROR_CODE_TO_STATUS,
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

/**
 * `projectId` on an agent, flow, tool, test set or guardrail a read
 * returns: the project the registry keeps it in. Optional, so a client
 * handles a record without one (a pack `kindgi dev` serves from disk,
 * or an older runtime).
 */
function recordProjectIdProperty(lead: string): JsonSchema {
  return {
    type: 'string',
    format: 'uuid',
    description: `${lead} Absent when the runtime doesn't record it: a pack \`kindgi dev\` serves from disk, or a runtime before Kindgi 0.1.6.`,
  };
}

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
    via: {
      type: 'string',
      enum: ['explicit', 'flow-pin', 'conversation', 'live', 'latest'],
      description:
        "Why this version ran: named by the caller (`explicit`); held by the flow version a flow's agent step runs in (`flow-pin`: the node's `config.version`, else the version the flow version pinned when it was published); the conversation's own (`conversation`); the version live for the run's scope (`live`); or the latest, nothing being live (`latest`). Absent on runs from before Kindgi 0.1.4.",
    },
    liveScope: {
      $ref: '#/components/schemas/LiveScope',
      description: 'The pin that chose the version, when `via` is `live`.',
    },
  },
};

/**
 * The trigger that started a run. A component of its own, so generated
 * clients name it `RunTrigger`.
 */
export const RunTriggerSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['triggerId', 'kind', 'fireId'],
  description:
    "Set on a run a trigger started: the trigger and the fire that started it. Absent on other runs. The runtime fires schedules only; `event` and `webhook` are kept for event triggers and inbound webhooks, which aren't served yet.",
  properties: {
    triggerId: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: ['schedule', 'event', 'webhook'] },
    fireId: {
      type: 'string',
      description: "The fire that started the run: one entry of the trigger's fire history.",
    },
    scheduledFor: {
      type: 'string',
      format: 'date-time',
      description: "A schedule's fire: the occurrence the run is for.",
    },
  },
};

export const ScopeSegmentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'value'],
  properties: {
    key: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_-]{0,63}$',
      description: 'Lowercase, like an identifier: `company`, `contact-role`.',
    },
    value: { type: 'string', minLength: 1, maxLength: 256 },
  },
};

const liveScopeVariant = (
  kind: string,
  description: string,
  properties: Record<string, JsonSchema>,
): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: ['kind', ...Object.keys(properties)],
  description,
  properties: { kind: { type: 'string', enum: [kind] }, ...properties },
});

export const LiveScopeTenantSchema = liveScopeVariant(
  'tenant',
  "The agent's default for the whole tenant.",
  {},
);
export const LiveScopeOrgSchema = liveScopeVariant('org', "An org's projects.", {
  orgId: { type: 'string', format: 'uuid' },
});
export const LiveScopeProjectSchema = liveScopeVariant('project', 'One project.', {
  projectId: { type: 'string', format: 'uuid' },
});
export const LiveScopeSegmentSchema = liveScopeVariant(
  'segment',
  'A segment path within a project: it covers every run whose path starts with it.',
  {
    projectId: { type: 'string', format: 'uuid' },
    path: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { $ref: '#/components/schemas/ScopeSegment' },
    },
  },
);

export const LiveScopeSchema: JsonSchema = {
  description:
    'Where a live version is pinned, from least to most specific: tenant, org, project, segment path. A run takes the most specific pin that covers it.',
  oneOf: [
    { $ref: '#/components/schemas/LiveScopeTenant' },
    { $ref: '#/components/schemas/LiveScopeOrg' },
    { $ref: '#/components/schemas/LiveScopeProject' },
    { $ref: '#/components/schemas/LiveScopeSegment' },
  ],
  discriminator: { propertyName: 'kind' },
};

export const LiveVersionResolutionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'version', 'via'],
  properties: {
    agentId: { type: 'string' },
    version: { type: 'string', description: 'The version a run would use (semver).' },
    via: {
      type: 'string',
      enum: ['live', 'latest'],
      description: 'A live pin chose it, or nothing is live on the way up and it is the latest.',
    },
    liveScope: { $ref: '#/components/schemas/LiveScope' },
  },
};

export const LivePinSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'scope', 'version', 'promotionId', 'setAt'],
  properties: {
    agentId: { type: 'string' },
    scope: { $ref: '#/components/schemas/LiveScope' },
    version: { type: 'string' },
    promotionId: { type: 'string', format: 'uuid', description: 'The promotion that set it.' },
    setAt: { type: 'string', format: 'date-time' },
  },
};

export const LivePinListSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: { data: { type: 'array', items: { $ref: '#/components/schemas/LivePin' } } },
};

export const PromotionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'agentId',
    'scope',
    'action',
    'fromVersion',
    'toVersion',
    'requestedBy',
    'createdAt',
  ],
  description:
    "One change of a scope's live version, kept for good: what was live before, what is after, who asked and why.",
  properties: {
    id: { type: 'string', format: 'uuid' },
    agentId: { type: 'string' },
    scope: { $ref: '#/components/schemas/LiveScope' },
    action: { type: 'string', enum: ['promote', 'rollback', 'unpin'] },
    fromVersion: {
      type: ['string', 'null'],
      description: "The scope's own pin before; null when it had none.",
    },
    toVersion: {
      type: ['string', 'null'],
      description: "The scope's own pin after; null after an unpin.",
    },
    requestedBy: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: {
        kind: { type: 'string', enum: ['user', 'service'] },
        id: { type: 'string' },
      },
    },
    reason: { type: 'string' },
    evalRunId: { type: 'string', description: 'The comparison the change was judged on.' },
    createdAt: { type: 'string', format: 'date-time' },
    status: {
      type: 'string',
      enum: ['promoted', 'pending-approval', 'refused', 'superseded', 'rejected', 'expired'],
      description:
        "A `promote` row's state: it changes once, from `pending-approval` to its final state. Absent on rollback and unpin rows, and on promotions made before gates (`promoted`).",
    },
    policy: {
      oneOf: [{ $ref: '#/components/schemas/GatePolicyRef' }, { type: 'null' }],
      description: 'The gate policy that applied; null when none did. Absent before gates.',
    },
    checks: { type: 'array', items: { $ref: '#/components/schemas/GateCheck' } },
    approvalId: {
      type: 'string',
      description: 'The approval a `pending-approval` promotion waits on (kept once decided).',
    },
    resolvedAt: {
      type: 'string',
      format: 'date-time',
      description: 'When a `pending-approval` promotion reached its final state.',
    },
  },
};

export const PromotionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/Promotion' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

// ---------------- the promotion gate (evals step 4b) ----------------

export const GateCheckSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'passed', 'message'],
  description: "One of a gate's checks, as the promotion records it.",
  properties: {
    name: {
      type: 'string',
      description:
        'Stable: `comparison.required`, `comparison.status`, `comparison.freshness`, `comparison.suite`, `sameContents`, `baselineIsLive`, `scopeCovered`, `evidence.<metric>.minCases|minWeight|baselineMinCases|baselineMinWeight`, `metric.<metric>.k|minCandidate|maxDrop`, `replay.maxDiverged|maxErrors|maxRefusedWrites|maxStopped`, `classWeights.restrictedOnly`.',
    },
    passed: { type: 'boolean' },
    message: {
      type: 'string',
      description: 'A plain sentence: what was found against what the policy asks.',
    },
    value: { type: ['number', 'string'] },
    threshold: { type: ['number', 'string'] },
  },
};

export const GatePolicyRefSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: { id: { type: 'string' }, version: { type: 'string' } },
};

export const GateApprovalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'count', 'separateApprover'],
  description: 'The approval a passing promotion waits for.',
  properties: {
    role: { type: 'string', enum: ['standard', 'senior', 'admin'] },
    count: { type: 'integer', minimum: 1 },
    separateApprover: {
      type: 'boolean',
      description: 'Whoever asked for the promotion may not approve it.',
    },
  },
};

const GateMetricSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', enum: ['weightedYesShare', 'judgedCoverage', 'weightedPrecisionAtK'] },
    k: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: "`weightedPrecisionAtK` only: the summary's `k` must be this.",
    },
    minCandidate: { type: 'number', minimum: 0, maximum: 1 },
    maxDrop: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'How far the candidate may fall below the baseline (the live version).',
    },
  },
};

export const GatePolicySpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'What a promotion must show. Every part is optional; an empty spec checks nothing. A promotion must name a comparison (`evalRunId`) exactly when the spec has `comparison`, `evidence`, `metrics`, `replay` or `onlyRestrictedClasses`. Unknown keys are refused.',
  properties: {
    comparison: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxAgeHours: { type: 'number', exclusiveMinimum: 0 },
        suite: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string' }, version: { type: 'string' } },
        },
      },
    },
    evidence: {
      type: 'object',
      additionalProperties: false,
      description:
        "The judged evidence behind each gated metric; for a metric with `maxDrop`, the baseline's too.",
      properties: {
        minCases: { type: 'integer', minimum: 0 },
        minWeight: { type: 'number', minimum: 0 },
      },
    },
    metrics: { type: 'array', items: GateMetricSpecSchema },
    replay: {
      type: 'object',
      additionalProperties: false,
      description: 'Each knob left out of the block is 0. No block: no replay checks.',
      properties: {
        maxDiverged: { type: 'integer', minimum: 0 },
        maxErrors: { type: 'integer', minimum: 0 },
        maxRefusedWrites: { type: 'integer', minimum: 0 },
        maxStopped: { type: 'integer', minimum: 0 },
      },
    },
    approvals: {
      type: 'object',
      additionalProperties: false,
      description: 'A passing promotion waits for a reviewer.',
      properties: {
        role: {
          type: 'string',
          enum: ['standard', 'senior', 'admin'],
          description: 'Default `senior`.',
        },
        separateApprover: { type: 'boolean', description: 'Default `true`.' },
      },
    },
    onlyRestrictedClasses: {
      type: 'boolean',
      description:
        "Only restricted judge classes count: the comparison must be weighted `restricted-only`, so a class anyone may assert can't move the gate.",
    },
  },
};

export const GatePolicySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'agentId', 'scope', 'spec', 'createdAt'],
  properties: {
    id: { type: 'string' },
    version: { type: 'string' },
    agentId: { type: 'string' },
    scope: { $ref: '#/components/schemas/LiveScope' },
    spec: { $ref: '#/components/schemas/GatePolicySpec' },
    description: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    unregisteredAt: { type: 'string', format: 'date-time' },
  },
};

export const GatePolicyPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/GatePolicy' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const PublishGatePolicyBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'agentId', 'scope', 'spec'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._-]{0,127}$',
      description: 'Yours to choose, e.g. `acme.drafting-prod`.',
    },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    agentId: { type: 'string' },
    scope: { $ref: '#/components/schemas/LiveScope' },
    spec: { $ref: '#/components/schemas/GatePolicySpec' },
    description: { type: 'string' },
  },
};

export const GatePolicyResolutionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['policy'],
  properties: {
    policy: {
      oneOf: [{ $ref: '#/components/schemas/GatePolicy' }, { type: 'null' }],
      description: 'The policy that gates a promotion for the scope; null when none does.',
    },
  },
};

export const PromotionCheckSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'policy', 'checks'],
  description: 'What the gate would say about a promotion. Nothing is recorded.',
  properties: {
    outcome: { type: 'string', enum: ['would-promote', 'needs-approval', 'gate-failed'] },
    policy: {
      oneOf: [{ $ref: '#/components/schemas/GatePolicyRef' }, { type: 'null' }],
      description: 'The policy that applies; null when none does.',
    },
    checks: { type: 'array', items: { $ref: '#/components/schemas/GateCheck' } },
    approval: { $ref: '#/components/schemas/GateApproval' },
  },
};

export const PromoteBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'scope'],
  properties: {
    version: {
      type: 'string',
      description: 'The agent version to make live (registered, active).',
    },
    scope: { $ref: '#/components/schemas/LiveScope' },
    reason: { type: 'string', maxLength: 2000 },
    evalRunId: { type: 'string', description: 'The comparison this promotion was judged on.' },
  },
};

export const RollbackBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope'],
  properties: {
    scope: { $ref: '#/components/schemas/LiveScope' },
    toVersion: {
      type: 'string',
      description: "An earlier version to go back to; omit → the scope's previous live version.",
    },
    reason: { type: 'string', maxLength: 2000 },
  },
};

export const UnpinBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope'],
  properties: {
    scope: { $ref: '#/components/schemas/LiveScope' },
    reason: { type: 'string', maxLength: 2000 },
  },
};

export const RunFailureSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  description:
    "Why a failed run failed; present only on a `failed` run. An agent turn's failure carries its own code (`budget-exceeded`, `capability-routing-failed`, `model-invocation-failed`, …); any other failure is `run-failed`, with the run's failure message.",
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    cause: {
      description:
        "What the error came from, when it says: e.g. for `capability-routing-failed`, the router's `capability-unsatisfiable` with its reasons, by provider.",
    },
    reason: {
      type: 'string',
      description:
        "The error's own reason, when it gives one: for a turn that ended at its approval (`hitl-cancelled`), `timeout` when nobody decided in time. Absent from an older runtime and from errors without one; read `code` then.",
    },
  },
};

export const FailureSubjectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  description: "Whose runs a failure group counts: an agent's turns, or a flow's runs.",
  properties: {
    kind: { type: 'string', enum: ['agent', 'flow'] },
    id: { type: 'string' },
  },
};

export const FailureGroupSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'count', 'firstSeen', 'lastSeen', 'exampleRunId'],
  description: 'One group of failed runs: the same cause, subject and version.',
  properties: {
    code: {
      type: 'string',
      description:
        "The failure's code (`Run.failure.code`). Absent when not grouped by code, and in `unrecorded`.",
    },
    reason: {
      type: 'string',
      description:
        "The failure's reason (`Run.failure.reason`), when it gives one: a `hitl-*` outcome's, e.g. `timeout`.",
    },
    subject: { $ref: '#/components/schemas/FailureSubject' },
    version: {
      type: 'string',
      description:
        "The agent's or flow's version. Absent when not grouped by version, or not recorded for the run.",
    },
    count: { type: 'integer', minimum: 1 },
    firstSeen: {
      type: 'string',
      format: 'date-time',
      description: 'When the first of them failed, in the window.',
    },
    lastSeen: {
      type: 'string',
      format: 'date-time',
      description: 'When the latest of them failed, in the window.',
    },
    exampleRunId: { type: 'string', format: 'uuid', description: "The group's most recent run." },
  },
};

export const RunFailureGroupsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'groups', 'outcomes', 'unrecorded', 'total'],
  properties: {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    groups: {
      type: 'array',
      items: { $ref: '#/components/schemas/FailureGroup' },
      description: 'The failures, the most first.',
    },
    outcomes: {
      type: 'array',
      items: { $ref: '#/components/schemas/FailureGroup' },
      description:
        "People's decisions, never errors: `hitl-*` codes (an approval rejected, cancelled or timed out), the most first.",
    },
    unrecorded: {
      type: 'array',
      items: { $ref: '#/components/schemas/FailureGroup' },
      description:
        'Runs that failed before their cause was recorded (a runtime from before this): by subject and version only, never by code.',
    },
    total: {
      type: 'integer',
      minimum: 0,
      description: 'Every failed run in the window, across the three lists.',
    },
  },
};

export const RunWaitingApprovalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approvalId', 'status', 'requiredRole', 'createdAt', 'subjectKind'],
  description:
    "An approval the run waits for, as a run reader sees it: its identity and state. Its subject's details, description, context and decision stay on `GET /v1/approvals/{approvalId}`, behind the reviewer gate.",
  properties: {
    approvalId: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      description: 'Still to be decided: `pending`, `assigned`, `in_review` or `escalated`.',
    },
    requiredRole: {
      type: 'string',
      description: 'The reviewer role that may decide it, or above.',
    },
    title: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    subjectKind: {
      type: 'string',
      description: 'What waits: e.g. `tool-call:pending` (a tool call held for review).',
    },
    tool: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'callId'],
      description:
        "For a tool call held for review: which tool and which call. Never the call's arguments.",
      properties: {
        id: { type: 'string', description: 'The tool id.' },
        version: { type: 'string' },
        callId: { type: 'string', description: "The model's id for the call." },
      },
    },
  },
};

export const RunWaitingForSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approvals', 'other'],
  description:
    "Set on a suspended run by `GET /v1/runs/{runId}` (not the list): what it waits for, its journal's open waits. `approvals`: those still to be decided, linked to the waits. `other`: the rest. Absent from a runtime before Kindgi 0.1.6, or when the journal can't be read; `kindgi runs resume` then works it out itself.",
  properties: {
    approvals: { type: 'array', items: { $ref: '#/components/schemas/RunWaitingApproval' } },
    other: {
      type: 'array',
      items: {
        type: 'object',
        required: ['what'],
        description:
          '`child-run` (`childRunId`, `childStatus`, `timesOutAt`): a child run must finish. `decided-approval` (`approvalId`, `approvalStatus`): decided, the runtime continues. `unattributed` (`tokenId`, `timesOutAt`): a wait no approval is linked to. `no-open-wait`: the journal shows none; the runtime picks the run up again.',
        properties: {
          what: {
            type: 'string',
            enum: ['child-run', 'decided-approval', 'unattributed', 'no-open-wait'],
          },
          childRunId: { type: 'string', format: 'uuid' },
          childStatus: { type: 'string' },
          approvalId: { type: 'string', format: 'uuid' },
          approvalStatus: { type: 'string' },
          tokenId: { type: 'string' },
          timesOutAt: { type: 'string', format: 'date-time' },
        },
      },
    },
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
    failureMessage: {
      type: 'string',
      description:
        'The failure as the runtime recorded it. Read `failure` instead: an agent turn records its typed error here in an internal form.',
    },
    failure: { $ref: '#/components/schemas/RunFailure' },
    output: {
      description:
        "The run's output once it completed. Present on single-run responses; on lists only with `?include=output`.",
    },
    contentErasedAt: {
      type: 'string',
      format: 'date-time',
      description:
        "When an erasure cleared the run's content (its input, output, failure message and journal payloads): a person's words were erased. Structure (status, times, ids) stays.",
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
    waitingFor: { $ref: '#/components/schemas/RunWaitingFor' },
    trigger: { $ref: '#/components/schemas/RunTrigger' },
    replayOf: {
      type: 'string',
      format: 'uuid',
      description: 'Set on a replay run (an eval run re-running a past run): the run it replays.',
    },
    evalRunId: {
      type: 'string',
      description: 'Set on a replay run: the eval run that started it.',
    },
    versions: { $ref: '#/components/schemas/FlowVersionOverrides' },
    segments: {
      type: 'array',
      items: { $ref: '#/components/schemas/ScopeSegment' },
      description:
        "The segment path the run was started with (coarse to fine), which picks live agent versions. A child run has its parent's. Absent when there was none.",
    },
    traceId: {
      type: 'string',
      pattern: '^[0-9a-f]{32}$',
      description:
        "The W3C trace id of the request that started the run: the caller's (from its `traceparent`) or one the API minted. The runtime's records about the run carry it; `GET` responses answer `traceresponse` with each request's own. Absent for a run no request started, and on runs from before runs recorded it.",
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
        agentVersion: {
          type: 'string',
          description:
            "Semver. Omit → the conversation's own version for a follow-up turn, else the version live for the run's scope, else the latest.",
        },
        projectId: {
          type: 'string',
          format: 'uuid',
          description: "Project to run under; omit → the tenant's Default project.",
        },
        segments: {
          type: 'array',
          maxItems: 8,
          items: { $ref: '#/components/schemas/ScopeSegment' },
          description:
            "The run's segment path below its project, coarse to fine (an app-defined finer scope, e.g. company then role). A version live on a prefix of it serves the run.",
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
        segments: {
          type: 'array',
          maxItems: 8,
          items: { $ref: '#/components/schemas/ScopeSegment' },
          description:
            "The run's segment path below its project, coarse to fine (an app-defined finer scope, e.g. company then role). A version live on a prefix of it serves the run.",
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
    "The most the key may do, under its principal's grants: an `admin` key may administer the tenant when its principal is a tenant admin; a `member` key takes no admin action on the tenant, whoever it's for; below it, its principal's roles hold (a project admin's member key administers that project).",
};

export const ApiKeyPrincipalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  description: 'Whom an API key acts for: a person, or a service account.',
  properties: {
    kind: { type: 'string', enum: ['user', 'service-account'] },
    id: { type: 'string', minLength: 1, description: 'The user id, or the service account id.' },
  },
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
  description:
    'A new API key. `for` is whom it acts for: the caller by default; only a tenant admin mints for someone else.',
  properties: {
    for: { $ref: '#/components/schemas/ApiKeyPrincipal' },
    role: {
      ...ApiTokenRoleSchema,
      description: `${ApiTokenRoleSchema.description} Default \`member\`; \`admin\` needs a tenant admin minting it.`,
    },
    capabilities: {
      ...ApiTokenCapabilitiesSchema,
      description: `${ApiTokenCapabilitiesSchema.description} Default none.`,
    },
    label: { type: 'string', description: 'Optional human-readable label.' },
    expiresAt: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp.' },
    projectId: {
      type: 'string',
      format: 'uuid',
      description:
        'Limit the key to this project: a request naming another project is refused (`key-project-mismatch`). A key limited to a project mints only keys limited to it.',
    },
  },
};

export const ApiTokenSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'An API key. Never includes the secret. `principal` is whom it acts for; absent on a key that is a service account of its own (`service_account:<tokenId>`), as keys minted before principals are.',
  required: ['tokenId', 'role', 'capabilities', 'createdAt'],
  properties: {
    tokenId: { type: 'string', format: 'uuid' },
    principal: { $ref: '#/components/schemas/ApiKeyPrincipal' },
    role: ApiTokenRoleSchema,
    capabilities: ApiTokenCapabilitiesSchema,
    label: { type: 'string' },
    projectId: {
      type: 'string',
      format: 'uuid',
      description: 'The project the key is limited to.',
    },
    createdBy: {
      type: 'string',
      description: 'Who minted it: `user:<id>` or `service_account:<id>`.',
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

// ---------------- service accounts ----------------

export const ServiceAccountGrantTenantAdminSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  description: 'Tenant admin.',
  properties: { kind: { type: 'string', enum: ['tenant-admin'] } },
};

export const ServiceAccountGrantTenantMemberSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  description:
    "Tenant member: read the tenant's settings (providers, policies, adapters, signing keys, deployments), not its projects. A service account has it only when granted; a person has it from being added.",
  properties: { kind: { type: 'string', enum: ['tenant-member'] } },
};

export const ServiceAccountGrantProjectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'projectId', 'role'],
  description: "A role on one project; it replaces the account's role there.",
  properties: {
    kind: { type: 'string', enum: ['project'] },
    projectId: { type: 'string', format: 'uuid' },
    role: { $ref: '#/components/schemas/ProjectRole' },
  },
};

export const ServiceAccountGrantProjectBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'projectId', 'role'],
  description: "A role to give on one project; it replaces the account's role there.",
  properties: {
    kind: { type: 'string', enum: ['project'] },
    projectId: { type: 'string', format: 'uuid' },
    role: { $ref: '#/components/schemas/AssignableProjectRole' },
  },
};

export const ServiceAccountGrantSchema: JsonSchema = {
  description:
    "What a service account may do: tenant admin, tenant member (read the tenant's settings), or a role on one project.",
  oneOf: [
    { $ref: '#/components/schemas/ServiceAccountGrantTenantAdmin' },
    { $ref: '#/components/schemas/ServiceAccountGrantTenantMember' },
    { $ref: '#/components/schemas/ServiceAccountGrantProject' },
  ],
  discriminator: { propertyName: 'kind' },
};

export const ServiceAccountGrantBodySchema: JsonSchema = {
  description: 'The grant to add: tenant admin, tenant member, or a role on one project.',
  oneOf: [
    { $ref: '#/components/schemas/ServiceAccountGrantTenantAdmin' },
    { $ref: '#/components/schemas/ServiceAccountGrantTenantMember' },
    { $ref: '#/components/schemas/ServiceAccountGrantProjectBody' },
  ],
  discriminator: { propertyName: 'kind' },
};

export const ServiceAccountUngrantProjectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'projectId'],
  description: 'Whatever role the account has on one project.',
  properties: {
    kind: { type: 'string', enum: ['project'] },
    projectId: { type: 'string', format: 'uuid' },
  },
};

export const ServiceAccountUngrantBodySchema: JsonSchema = {
  description: 'The grant to remove: tenant admin, tenant member, or the role on a project.',
  oneOf: [
    { $ref: '#/components/schemas/ServiceAccountGrantTenantAdmin' },
    { $ref: '#/components/schemas/ServiceAccountGrantTenantMember' },
    { $ref: '#/components/schemas/ServiceAccountUngrantProject' },
  ],
  discriminator: { propertyName: 'kind' },
};

export const ServiceAccountSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'A named, non-human principal (`service_account:<id>`) for an app, a pipeline or a schedule. It acts through API keys minted for it.',
  required: ['serviceAccountId', 'name', 'grants', 'createdAt'],
  properties: {
    serviceAccountId: { type: 'string' },
    name: { type: 'string', description: "Unique among the tenant's active accounts." },
    description: { type: 'string' },
    grants: { type: 'array', items: { $ref: '#/components/schemas/ServiceAccountGrant' } },
    createdBy: {
      type: 'string',
      description: 'Who created it: `user:<id>` or `service_account:<id>`.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description: 'Set once unregistered: it has no grants, and its keys no longer work.',
    },
  },
};

export const ServiceAccountPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ServiceAccount' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const CreateServiceAccountBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]{0,62}$',
      description: 'Lowercase letters, digits and hyphens, e.g. `acme-ci`.',
    },
    description: { type: 'string', maxLength: 500 },
    grants: {
      type: 'array',
      // Inline, not a `$ref`: the Python codegen would fold the referenced
      // union into these items and drop its `ServiceAccountGrantBody` class.
      items: ServiceAccountGrantBodySchema,
      description: 'Written before the account is returned, so its first key works at once.',
    },
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
        "The reviewer's decision, once one is recorded. Absent while the approval is open, and when it ended without one (it expired, a timeout escalated it, or its run's end withdrew it).",
      $ref: '#/components/schemas/ApprovalDecisionRecord',
    },
    requestedBy: {
      type: 'string',
      description:
        'Who asked for it, when recorded: `user:<id>`, `service_account:<id>` or `system:<what>`.',
    },
    separateApprover: {
      type: 'boolean',
      description:
        'Whether the person who asked may not approve it (four eyes). A runtime that knows it always sends it, `false` included.',
    },
    withdrawnBecause: {
      type: 'string',
      enum: ['run-cancelled', 'run-ended'],
      description:
        "Why it was withdrawn, when its run's end withdrew it (a reviewer's withdrawal has its `decision` instead).",
    },
    escalatedFrom: {
      type: 'string',
      format: 'uuid',
      description: 'The approval this one was escalated from.',
    },
    escalatedTo: {
      type: 'string',
      format: 'uuid',
      description: 'The approval this one was escalated to.',
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
        'Opaque cursor for the next page, in the same order; treat as opaque on the client.',
    },
    hasMore: { type: 'boolean' },
    order: {
      type: 'string',
      enum: ['asc', 'desc'],
      description:
        'The order the page is in: `asc` (oldest first) or `desc` (newest first). Absent from a runtime before Kindgi 0.1.6, which lists newest first and ignores `order`.',
    },
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

// ---------------- signed exports: one envelope ----------------

const SIGNING_KEY_ID_PROPERTY: JsonSchema = {
  type: 'string',
  minLength: 1,
  description:
    "Optional: sign with this key, one of `GET /v1/export-signing-keys`. Leave it out to sign with the deployment's active key. A key the deployment doesn't sign with is `404 signing-key-not-found`.",
};

/**
 * The envelope every signed export answers (an audit bundle, a run's
 * provenance, compliance evidence): the same fields, so one verifier
 * reads all three. Only the subject field differs.
 */
function signedExportEnvelope(input: {
  readonly description: string;
  readonly kind: 'audit-bundle' | 'provenance' | 'compliance';
  readonly subject: readonly [string, JsonSchema];
  readonly versionDescription: string;
}): JsonSchema {
  const [subjectKey, subjectSchema] = input.subject;
  return {
    description: input.description,
    type: 'object',
    additionalProperties: false,
    required: [
      subjectKey,
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
      [subjectKey]: subjectSchema,
      kind: {
        type: 'string',
        const: input.kind,
        description:
          'Which export this is: `audit-bundle`, `provenance` or `compliance`. Absent from older servers.',
      },
      bundle: {
        type: 'string',
        description:
          'Base64 of the exact bytes that were signed: the body, as sorted-key JSON with no whitespace. Verify these bytes; nothing needs re-serializing.',
      },
      bundleSchemaVersion: { type: 'string', description: input.versionDescription },
      algorithm: {
        type: 'string',
        enum: ['ed25519', 'ecdsa-p256-sha256'],
        description:
          "The signing key's algorithm. `ecdsa-p256-sha256` signatures are IEEE P1363 `r‖s`. A verifier refuses an algorithm it doesn't know.",
      },
      signingKeyId: {
        type: 'string',
        description: 'The key that signed it: one of `GET /v1/export-signing-keys`.',
      },
      signature: {
        type: 'string',
        description:
          "Base64 of the 64-byte signature over the `bundle` bytes: Ed25519's, or ECDSA P-256's as IEEE P1363 `r‖s`.",
      },
      publicKey: {
        type: 'string',
        description:
          "The signing key's public half, PEM SPKI. On its own it only proves the bytes weren't changed; check it against `GET /v1/export-signing-keys` (or a key you pinned) to know who signed them.",
      },
      canonicalization: {
        type: 'string',
        const: 'sorted-key-json',
        description: 'Sorted-key JSON, no whitespace (`canonicalize` in `@kindgi/schema`).',
      },
      exportedAt: {
        type: 'string',
        format: 'date-time',
        description: "When it was signed: the same instant as the signed body's `exportedAt`.",
      },
    },
  };
}

export const ExportSigningKeySchema: JsonSchema = {
  description: 'A public key this deployment signs exports with.',
  type: 'object',
  additionalProperties: false,
  required: ['keyId', 'algorithm', 'publicKeyPem', 'fingerprint', 'active'],
  properties: {
    keyId: {
      type: 'string',
      description:
        'Derived from the public key (`ex_` and 16 base64url characters), so the same key keeps its id.',
    },
    algorithm: {
      type: 'string',
      enum: ['ed25519', 'ecdsa-p256-sha256'],
      description:
        'An Ed25519 key signs `ed25519`; an EC P-256 key (a KMS without Ed25519) signs `ecdsa-p256-sha256`.',
    },
    publicKeyPem: { type: 'string', description: 'PEM SPKI.' },
    fingerprint: {
      type: 'string',
      pattern: '^sha256:[0-9a-f]{64}$',
      description:
        '`sha256:` and the hex SHA-256 of the raw public key: to pin it, or compare by eye.',
    },
    active: { type: 'boolean', description: 'Whether new exports are signed with it.' },
  },
};

export const ExportSigningKeyListSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/ExportSigningKey' },
      description: "Active first. Empty when the deployment doesn't sign exports.",
    },
  },
};

export const ExportAuditBundleBodySchema: JsonSchema = {
  description:
    "Body for `POST /v1/approvals/{approvalId}/audit-bundle`, optional: no body signs with the active key. `includeMessages` adds the conversation messages of the approval's run.",
  type: 'object',
  additionalProperties: false,
  properties: {
    signingKeyId: SIGNING_KEY_ID_PROPERTY,
    includeMessages: {
      type: 'boolean',
      description:
        "When true, hydrates conversation messages tied to the approval's run (agent turns pin `runId === conversationId`). Empty array for non-agent runs — field always present when requested.",
      default: false,
    },
  },
};

export const ExportAuditBundleResultSchema: JsonSchema = signedExportEnvelope({
  description:
    "A decided approval's signed audit bundle. Body: `{ bundleSchemaVersion, approvalId, tenantId, subjectKind, subjectRef, requiredRole, status, createdAt, decidedAt?, decision, evidence: { guardrailResults?, messages? }, exportedAt }`.",
  kind: 'audit-bundle',
  subject: ['approvalId', { type: 'string', format: 'uuid' }],
  versionDescription:
    "The body's version, semver. `2.0.0`: a string like the other exports' (it was the integer `1`), named `bundleSchemaVersion` in the body too, with `exportedAt` signed once.",
});

export const CompleteApprovalResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "A recorded decision, and what it did to the run waiting on the approval. `runStatus` is the run's status when the decision couldn't resolve its waitpoint because the run had already ended (e.g. `cancelled` after the decision was recorded); the decision stands.",
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
        "True when the approval had a `waitTokenId` and this call resolved the run's waitpoint: approve and reject complete it; withdraw cancels it, so the run ends (`failed`, `hitl-withdrawn`).",
    },
    // As `Run.status` has it: the schema inline (a `$ref` to `RunStatus`
    // folds the generated Python client's `RunStatus` class away).
    runStatus: RunStatusSchema,
    resume: {
      description:
        "How the run went on, when this call resumed it (the runtime resumes inline): `ok`, or `failed` with the run's error, e.g. `tool-version-unresolvable` when a tool version the turn started with is gone. The decision stands either way.",
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { type: 'string', const: 'ok' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'code', 'message'],
          properties: {
            kind: { type: 'string', const: 'failed' },
            code: { type: 'string' },
            message: { type: 'string' },
          },
        },
      ],
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
  required: ['scope'],
  properties: {
    source: {
      type: 'string',
      enum: ['facts', 'conversations'],
      description:
        "What it reads: facts (the default), or messages of this agent's earlier conversations, quoted in the turn's `<memory>` block as earlier conversation, never as turns.",
    },
    types: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'The fact types it retrieves: required for facts; not used for conversations.',
    },
    roles: {
      type: 'array',
      items: { type: 'string', enum: ['user', 'agent'] },
      minItems: 1,
      uniqueItems: true,
      description:
        "For conversations: whose messages it recalls. Default `['user']`, the people's own words. Adding `agent` recalls the agent's earlier answers too, which can carry its mistakes: they are quoted as unverified earlier answers, and publishing warns `recall-agent-answers`.",
    },
    scope: {
      type: 'string',
      enum: ['same-conversation', 'same-user', 'same-segment', 'same-project', 'tenant'],
      description:
        "What the intent selects within what the run may see. Facts: this conversation's; the run's end user's only (`same-user`: none when the run names no `participantId`); the run's project's (none without a project); or every fact of the type it may see (`tenant`). Conversations: this end user's other conversations with the agent (`same-user`: none when the run names no `participantId`); this conversation's messages older than the history window (`same-conversation`); conversations in the run's segment path (`same-segment`) or its project (`same-project`), whoever had them: those two quote other people's conversations, so publishing warns and their messages are marked as another person's. `same-segment` is for conversations only, `tenant` for facts only.",
    },
    limit: { type: 'integer', minimum: 1 },
    mode: {
      type: 'string',
      enum: ['keyword', 'semantic', 'both'],
      description:
        "With the user's message as the query: full-text, by meaning (fails the turn with `semantic-unavailable` on a runtime without embeddings), or both fused by rank (without embeddings, the keyword half). Absent: the newest facts.",
    },
  },
};

export const AgentMemoryPolicySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'How the agent uses what it retrieves.',
  properties: {
    instructionTypes: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        "Fact types that are instructions for this agent: a retrieved, verified fact of one of these types goes into the system message under 'Policies (verified)'. Default: none.",
    },
    remember: {
      type: 'object',
      additionalProperties: false,
      required: ['types', 'scope'],
      description:
        'Lets the agent remember: its turns offer the built-in tool `kindgi_remember` (built-in tools are `kindgi_<verb>`; an agent cannot list one in `tools`, and a published tool cannot use the prefix). The model picks the type, the text (up to 2,000 characters), an optional slot `key` and when it stops being true; the scope comes from here and the run. Every remembered fact is `unverified`, attributed to the agent version and the call that wrote it, and expires after `keepDays` unless a person verifies it. A person approves it before any read sees it when the scope is wider than one person (`same-project`, `tenant`) or the text reads like an instruction.',
      properties: {
        types: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
          description: 'The fact types it may write.',
        },
        scope: {
          type: 'string',
          enum: ['same-user', 'same-conversation', 'same-project', 'tenant'],
          description:
            "Where its facts go: the conversation's end user (else the user the run acts for), the conversation, the run's project, or the tenant. Each but `tenant` includes the run's project.",
        },
        keepDays: {
          type: 'integer',
          minimum: 1,
          maximum: 3650,
          description: 'Days an unverified fact is kept. Default 30.',
        },
      },
    },
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
    projectId: recordProjectIdProperty(
      "The agent's project: every version of an agent is in the one project.",
    ),
    name: { type: 'string' },
    description: { type: 'string' },
    instructions: {
      oneOf: [{ type: 'string', minLength: 1 }, { $ref: '#/components/schemas/PromptRef' }],
      description:
        'The system prompt (a Liquid template), or a prompt block by range whose template and parameters are used instead (pinned at publish, `pins.prompts`).',
    },
    parameters: { type: 'array', items: { $ref: '#/components/schemas/PromptParameter' } },
    settings: {
      type: 'array',
      items: { $ref: '#/components/schemas/BlockRef' },
      description:
        'Settings blocks the agent reads, by range: tools read them as `ToolContext.settings[\'<id>\']`, templates as `settings["<id>"]`. Pinned at publish (`pins.settings`).',
    },
    modelSettings: {
      $ref: '#/components/schemas/BlockRef',
      description:
        "A model-settings block by range: its `temperature` and `maxOutputTokens` go into the turn's model calls. Pinned at publish.",
    },
    capabilities: { type: 'array', items: { $ref: '#/components/schemas/Capability' } },
    tools: { type: 'array', items: { $ref: '#/components/schemas/ToolRef' } },
    retrieval: { type: 'array', items: { $ref: '#/components/schemas/RetrievalIntent' } },
    memory: { $ref: '#/components/schemas/AgentMemoryPolicy' },
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
        'Soft hint at the model level (`ModelInfo.name`, e.g. `claude-sonnet-5-5`). Combined with `preferredProvider`: both set → promote the exact tuple; only `preferredModel` → promote any provider exposing that model; only `preferredProvider` → promote every model of that provider.',
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
      enum: ['pins-changed', 'unpinned', 'version-taken', 'edited'],
      description:
        "`pins-changed`: a block it uses has a new version; `unpinned`: the definition's version was published before pins existed; `version-taken`: the definition's version holds another definition; `edited`: derived from `version` with some data-block pins swapped (`POST /v1/agents/{agentId}/versions`).",
    },
    label: { type: 'string', description: 'For `edited`: a short label for the version.' },
    by: { type: 'string', description: 'For `edited`: who derived it (`user:<id>`).' },
    proposalId: {
      type: 'string',
      description:
        'For `edited`: the improvement proposal it was derived for. Such a version serves no scope until a promotion makes it live.',
    },
  },
};

export const DeriveAgentVersionBodySchema: JsonSchema = {
  description:
    "Derive a new agent version from a pinned one with some data-block pins swapped: an expert's edit reaching an agent with no code change.",
  type: 'object',
  additionalProperties: false,
  required: ['from', 'pins'],
  properties: {
    from: { type: 'string', description: 'The version to derive from (it must be pinned).' },
    pins: { $ref: '#/components/schemas/AgentPinSwaps' },
    label: { type: 'string', description: 'A short label for the new version.' },
    projectId: {
      type: 'string',
      format: 'uuid',
      description: "The agent's project, when the runtime doesn't record it on the version.",
    },
  },
};

const PinMapSchema: JsonSchema = {
  type: 'object',
  additionalProperties: { type: 'string' },
};

export const AgentPinSwapsSchema: JsonSchema = {
  description:
    'The data-block pins to swap, by block id → exact version. Only blocks the version already references; tool pins come from code.',
  type: 'object',
  additionalProperties: false,
  properties: {
    prompts: { ...PinMapSchema, description: 'Prompt block id → exact version.' },
    settings: { ...PinMapSchema, description: 'Settings block id → exact version.' },
  },
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

export const PromptRefSchema: JsonSchema = {
  description: "A prompt block an agent's instructions come from, by id and semver range.",
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'version'],
  properties: {
    prompt: { type: 'string', description: 'The prompt block id.' },
    version: { type: 'string', description: 'A semver range (`^1.0.0`, `1.2.0`).' },
  },
};

export const BlockRefSchema: JsonSchema = {
  description: 'A settings block an agent reads, by id and semver range.',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', description: 'The settings block id.' },
    version: { type: 'string', description: 'A semver range (`^1.0.0`, `1.2.0`).' },
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
    instructions: {
      oneOf: [{ type: 'string', minLength: 1 }, { $ref: '#/components/schemas/PromptRef' }],
      description:
        'The system prompt (a Liquid template), or a prompt block by range whose template and parameters are used instead (pinned at publish, `pins.prompts`).',
    },
    parameters: { type: 'array', items: { $ref: '#/components/schemas/PromptParameter' } },
    settings: {
      type: 'array',
      items: { $ref: '#/components/schemas/BlockRef' },
      description:
        'Settings blocks the agent reads, by range: tools read them as `ToolContext.settings[\'<id>\']`, templates as `settings["<id>"]`. Pinned at publish (`pins.settings`).',
    },
    modelSettings: {
      $ref: '#/components/schemas/BlockRef',
      description:
        "A model-settings block by range: its `temperature` and `maxOutputTokens` go into the turn's model calls. Pinned at publish.",
    },
    capabilities: { type: 'array', items: { $ref: '#/components/schemas/Capability' } },
    tools: { type: 'array', items: { $ref: '#/components/schemas/ToolRef' } },
    retrieval: { type: 'array', items: { $ref: '#/components/schemas/RetrievalIntent' } },
    memory: { $ref: '#/components/schemas/AgentMemoryPolicy' },
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
    warnings: {
      type: 'array',
      description:
        "What the agent should know about this deployment before its first turn, e.g. `semantic-unavailable` (a retrieval intent searches by meaning and the deployment has no embeddings), `remember-unavailable` (the agent remembers and the deployment cannot store agent memories), `recall-other-people` (an intent recalls conversations in the run's segment or project, whoever had them) or `recall-unavailable` (the deployment cannot recall earlier conversations).",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
    },
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
    projectId: recordProjectIdProperty(
      "The flow's project: every version of a flow is in the one project.",
    ),
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

export const FlowVersionOverridesSchema: JsonSchema = {
  description:
    "Agents and tools a flow runs at other exact versions than the flow version's pins (\"this flow, with `acme.scorer` at 0.4.0\"), without publishing a new flow version: a comparison's flow candidate (`versions` on the start body and the run's `comparison`), and the flow runs that replay it (a run's `versions`). Each id must be an agent or tool the flow uses.",
  type: 'object',
  additionalProperties: false,
  properties: {
    tools: { ...PinMapSchema, description: 'Tool id → exact version.' },
    agents: {
      ...PinMapSchema,
      description:
        'Agent id → exact version, for agent nodes with or without a version of their own.',
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
    projectId: recordProjectIdProperty(
      "The tool's project: every version of a tool is in the one project.",
    ),
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
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Present only on an unregistered version: a retired tool (every version unregistered) as `GET /v1/tools?includeRetired=true` lists it.',
    },
  },
};

/** `Tool`'s properties but what the registry sets on a read (a register body never carries it). */
const { unregisteredAt: _readOnly, ...toolManifestProperties } = ToolSchema.properties as Record<
  string,
  JsonSchema
>;

export const RegisterToolBodySchema: JsonSchema = {
  description:
    'ToolManifest — Tool minus its runtime `handler`. Validated server-side via `@kindgi/tools.validateToolManifest`. Metadata-only registration: the handler is not uploaded and must already be available to the runtime.',
  ...ToolSchema,
  required: [...(ToolSchema.required as readonly string[]), 'projectId'],
  properties: {
    ...toolManifestProperties,
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
    projectId: recordProjectIdProperty("The guardrail's project."),
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

const outcomeCountProperties = {
  passed: { type: 'integer', minimum: 0, description: 'The check ran and found nothing.' },
  violated: {
    type: 'integer',
    minimum: 0,
    description:
      'The check found something and the answer went through (`log-only`, `noop`, or an action handed back).',
  },
  blocked: {
    type: 'integer',
    minimum: 0,
    description: 'The check found something and its `halt` failed the turn.',
  },
  errored: {
    type: 'integer',
    minimum: 0,
    description:
      "The check couldn't run (no such check, a bad configuration, a judge that couldn't be routed).",
  },
} as const;

export const GuardrailOutcomeCountsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'violated', 'blocked', 'errored'],
  description: "How many of a guardrail's checks came to each outcome.",
  properties: outcomeCountProperties,
};

export const GuardrailOutcomesByAgentVersionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'agentVersion', 'passed', 'violated', 'blocked', 'errored'],
  description: "The counts on one agent version's turns.",
  properties: {
    agentId: { type: 'string' },
    agentVersion: { type: 'string' },
    ...outcomeCountProperties,
  },
};

export const GuardrailBlockedRunSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'at', 'agentId', 'agentVersion'],
  description: 'A turn the guardrail blocked: its run, never its answer.',
  properties: {
    runId: { type: 'string', format: 'uuid' },
    at: { type: 'string', format: 'date-time', description: 'When the guardrail checked.' },
    agentId: { type: 'string' },
    agentVersion: { type: 'string' },
  },
};

export const GuardrailOutcomesSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['guardrailId', 'from', 'to', 'counts', 'byAgentVersion', 'recentBlocked'],
  properties: {
    guardrailId: { type: 'string' },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    counts: { $ref: '#/components/schemas/GuardrailOutcomeCounts' },
    byAgentVersion: {
      type: 'array',
      items: { $ref: '#/components/schemas/GuardrailOutcomesByAgentVersion' },
      description: 'The same counts per agent version, the most checked first, at most 100.',
    },
    recentBlocked: {
      type: 'array',
      items: { $ref: '#/components/schemas/GuardrailBlockedRun' },
      description: "The window's latest blocked turns, newest first, at most `recent`.",
    },
    recordedSince: {
      type: 'string',
      format: 'date-time',
      description:
        "The earliest outcome kept for this guardrail in this project, in any window: nothing before it is counted. Outcomes were first recorded in 0.1.6, and they go with their run's retention. Absent when none is kept.",
    },
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
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'When it was unregistered (`POST /v1/conversations/{conversationId}/unregister`). Only the unregister call returns it: reads no longer do.',
    },
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
      description: 'Opaque cursor for the next page; treat as opaque on the client.',
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

export const JudgeClassAssertableBySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  description:
    'Who may assert the class: every part that is set must hold. A class with one is restricted: a judgment recorded while it is carries `restricted`, and a comparison weighted `restricted-only` counts only those.',
  properties: {
    minReviewerRole: {
      type: 'string',
      enum: ['standard', 'senior', 'admin'],
      description: "The caller's reviewer role is at least this (its token's, or the roster's).",
    },
    principalKinds: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: ['user', 'service'] },
      description: 'Users, service tokens, or both.',
    },
    principalIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', minLength: 1 },
      description: 'Only these principals: user ids, or service token ids.',
    },
  },
};

/**
 * `assertableBy` as a reader sees it. `principalIds` names people and
 * tokens, so only the class's admins get it; everyone gets their count.
 */
export const JudgeClassAssertableByViewSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  description:
    "Who may assert the class, as the caller sees it: every part that is set must hold. `principalIds` is sent only to an admin on the class's scope; `principalCount` to everyone who reads it.",
  properties: {
    minReviewerRole: {
      type: 'string',
      enum: ['standard', 'senior', 'admin'],
      description: "The caller's reviewer role is at least this (its token's, or the roster's).",
    },
    principalKinds: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: ['user', 'service'] },
      description: 'Users, service tokens, or both.',
    },
    principalIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', minLength: 1 },
      description:
        "Only these principals: user ids, or service token ids. Sent only to an admin on the class's scope.",
    },
    principalCount: {
      type: 'integer',
      minimum: 1,
      description:
        'How many principals the class is restricted to (`principalIds`), for every reader. Absent when it names none.',
    },
  },
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
    assertableBy: { $ref: '#/components/schemas/JudgeClassAssertableByView' },
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
    assertableBy: { $ref: '#/components/schemas/JudgeClassAssertableBy' },
  },
};

export const UpdateJudgeClassBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    weight: { type: 'number', minimum: 0 },
    description: { type: 'string' },
    assertableBy: {
      oneOf: [{ $ref: '#/components/schemas/JudgeClassAssertableBy' }, { type: 'null' }],
      description: 'Who may assert the class; `null` lifts the restriction.',
    },
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
    restricted: {
      type: 'boolean',
      enum: [true],
      description:
        "Present (true) when the judge class was restricted (`assertableBy`) when the judgment was recorded, so the judge was checked against it. A restriction added or lifted later doesn't change it.",
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
    'What a judged run needs besides its input to be replayed, captured when it was first judged. For an agent turn: the conversation before it, what its retrievals returned, and the decision at its session approval gate. For a flow run: its tool calls with their results. For both: the env values its tools were sent.',
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
    recalled: {
      description:
        'Messages of earlier conversations the turn recalled (intents over conversations), as quoted to the model.',
    },
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
    flow: {
      type: 'object',
      additionalProperties: false,
      required: ['calls', 'steps'],
      description:
        "For a flow run: what it did, kept at its first judgment so it can be replayed. Every tool call it made with its result (at its tool nodes, in its agent steps' turns and in its sub-flows), at most 500, and its agent steps.",
      properties: {
        calls: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['runId', 'toolId'],
            properties: {
              runId: {
                type: 'string',
                description:
                  "The run that made it: the flow run, a sub-flow's, or an agent step's turn.",
              },
              nodeId: {
                type: 'string',
                description: 'The tool node that made it, or the agent step whose turn did.',
              },
              scope: { type: 'string', description: 'The loop iteration, in a loop body.' },
              toolId: { type: 'string' },
              arguments: {},
              result: {},
            },
          },
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['runId', 'agentId', 'agentVersion'],
            properties: {
              runId: { type: 'string' },
              nodeId: { type: 'string' },
              scope: { type: 'string' },
              agentId: { type: 'string' },
              agentVersion: { type: 'string' },
              retrieved: { description: "What the step's turn retrieved." },
              recalled: {
                description: "Messages of earlier conversations the step's turn recalled.",
              },
            },
          },
        },
        truncated: { type: 'boolean', description: 'More calls were made than were kept.' },
      },
    },
    toolEnv: {
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
      description:
        "The env values each tool's calls were sent (`needsSpec.env`), by tool id: its first call's, as the run recorded them. A replay sends them to a read-only tool it runs live, so the tool reads the config the run saw, not today's. Absent for a run from before env was recorded.",
    },
    replayOf: {
      type: 'string',
      description:
        "When the judged run is a comparison's replay: the run it re-ran, stamped at its first judgment. A test set built from judgments leaves replays out.",
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
    segments: {
      type: 'array',
      items: { $ref: '#/components/schemas/ScopeSegment' },
      description:
        'The segment path the run was started with (empty: none). Absent for runs judged before it was recorded.',
    },
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
    restricted: {
      type: 'object',
      additionalProperties: false,
      required: ['yesWeight', 'totalWeight'],
      description:
        'The same weights, counting only judgments recorded while their class was restricted (`Judgment.restricted`), for a comparison weighted `restricted-only`. Absent from a test set built before restrictions.',
      properties: { yesWeight: { type: 'number' }, totalWeight: { type: 'number' } },
    },
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
          judgeClassId: { type: 'string', description: "The judgment's class, when it had one." },
          restricted: {
            type: 'boolean',
            enum: [true],
            description:
              'Set when the judgment was recorded while its class was restricted (`Judgment.restricted`).',
          },
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
    erased: {
      type: 'boolean',
      const: true,
      description:
        "An erasure cleared this case (a person's words were erased): `input` and `output` are null, `items` empty, and eval runs leave it out (counted as `erased`).",
    },
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
    segments: {
      type: 'array',
      items: { $ref: '#/components/schemas/ScopeSegment' },
      description:
        "Only runs started in this segment path or below it, coarse to fine (e.g. `company=acme`). A run judged before its segments were recorded with its judgments is in no segment, so it's left out.",
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
    'Fact scope object. `tenantId` is required; every optional key narrows the fact (`userId`, `orgId`, `projectId`, `threadId`, `sessionId`, `participantId`). A fact is readable by whoever has every container it names. Additional keys accepted for forward compatibility.',
  properties: {
    tenantId: { type: 'string' },
    userId: { type: 'string' },
    orgId: { type: 'string' },
    projectId: { type: 'string' },
    threadId: { type: 'string' },
    sessionId: { type: 'string' },
    participantId: {
      type: 'string',
      minLength: 1,
      description:
        "An app's end user, by the app's own id: a fact private to that participant's runs. Needs `projectId`.",
    },
  },
};

export const FactSubjectSchema: JsonSchema = {
  description: 'Whom a fact is about: what access and erasure requests by person find.',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: ['participant', 'user', 'external'] },
    id: { type: 'string', minLength: 1 },
  },
};

export const FactAttributionSchema: JsonSchema = {
  description: 'Who asserted a fact, set by the server from the writer.',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: ['user', 'service', 'agent'] },
    id: { type: 'string' },
    agentVersion: { type: 'string' },
  },
};

export const FactGeneratedBySchema: JsonSchema = {
  description: 'The run step that wrote a fact, for one an agent wrote.',
  type: 'object',
  additionalProperties: false,
  required: ['runId'],
  properties: {
    runId: { type: 'string' },
    stepId: { type: 'string' },
    toolCallId: { type: 'string' },
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
    id: {
      type: 'string',
      description:
        'The fact id, kept across revisions (for a fact never superseded, also its one revision id).',
    },
    revisionId: {
      type: 'string',
      description: "This revision's own id; absent where it equals `id`.",
    },
    type: {
      type: 'string',
      description: 'Fact type identifier (pack-defined; a few are framework-standard).',
    },
    scope: { $ref: '#/components/schemas/FactScope' },
    version: {
      type: 'integer',
      minimum: 1,
      description: 'The revision number within the fact: 1, then one more per supersede or verify.',
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
      description: 'The revision this one replaced.',
    },
    trust: {
      type: 'string',
      enum: ['verified', 'asserted', 'unverified'],
      description:
        '`verified`: a person with the right checked it. `asserted`: an app or a person wrote it. `unverified`: an agent remembered it during a conversation. Absent on facts from before trust was recorded: `asserted`.',
    },
    verifiedBy: { type: 'string' },
    verifiedAt: { type: 'string', format: 'date-time' },
    attributedTo: { $ref: '#/components/schemas/FactAttribution' },
    generatedBy: { $ref: '#/components/schemas/FactGeneratedBy' },
    subjects: { type: 'array', items: { $ref: '#/components/schemas/FactSubject' } },
    validFrom: {
      type: 'string',
      format: 'date-time',
      description: 'When the fact starts being true in the world; absent: always.',
    },
    validUntil: {
      type: 'string',
      format: 'date-time',
      description: 'When the fact stops being true in the world; absent: still true.',
    },
    observedAt: { type: 'string', format: 'date-time', description: 'When it was said or seen.' },
    invalidatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'When this revision stopped being current; absent: it is current.',
    },
    invalidatedBy: { type: 'string', description: '`user:<id>` or `service:<id>`.' },
    invalidationReason: {
      type: 'string',
      enum: ['superseded', 'deleted', 'erased', 'expired'],
    },
    review: {
      type: 'string',
      enum: ['pending'],
      description: '`pending` while a person must approve it: a pending fact is never retrieved.',
    },
    expiresAt: {
      type: 'string',
      format: 'date-time',
      description:
        "When this revision stops being readable: from its retention (`keepUntil`, or `keepDays` from the fact's first write), or an agent-remembered fact's unverified window. No read returns it after; absent: it doesn't expire.",
    },
  },
};

export const FactRevisionListSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/Fact' },
      description: 'Every revision, newest first.',
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
    "Write a fact. `type` selects the retrieval-policy (which indexes populate); `scope.tenantId` MUST match the caller's tenant. Optional `retention` overrides tenant defaults; optional `contentHash` is a caller-supplied idempotence hint (runtime computes its own hash regardless). `subjects` names whom it is about; `validFrom`/`validUntil` when it is true in the world; `observedAt` when it was said or seen.",
  type: 'object',
  additionalProperties: false,
  required: ['type', 'scope', 'content'],
  properties: {
    type: { type: 'string', minLength: 1 },
    scope: { $ref: '#/components/schemas/FactScope' },
    content: { description: 'Free-form structured payload.' },
    retention: { $ref: '#/components/schemas/Retention' },
    contentHash: { type: 'string' },
    subjects: {
      type: 'array',
      maxItems: 20,
      items: { $ref: '#/components/schemas/FactSubject' },
    },
    validFrom: { type: 'string', format: 'date-time' },
    validUntil: { type: 'string', format: 'date-time' },
    observedAt: { type: 'string', format: 'date-time' },
  },
};

export const SupersedeFactBodySchema: JsonSchema = {
  description:
    "The fact's next revision: new `content`, and optionally new `retention`, `subjects` and times (absent ones keep their current values). Its scope and type stay. `expectVersion`: only if the current revision is still this one.",
  type: 'object',
  additionalProperties: false,
  required: ['content'],
  properties: {
    content: { description: 'Free-form structured payload.' },
    expectVersion: { type: 'integer', minimum: 1 },
    retention: { $ref: '#/components/schemas/Retention' },
    subjects: {
      type: 'array',
      maxItems: 20,
      items: { $ref: '#/components/schemas/FactSubject' },
    },
    validFrom: { type: 'string', format: 'date-time' },
    validUntil: { type: 'string', format: 'date-time' },
    observedAt: { type: 'string', format: 'date-time' },
  },
};

export const VerifyFactBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    expectVersion: { type: 'integer', minimum: 1 },
  },
};

export const RetrieveIntentSchema: JsonSchema = {
  description:
    'Retrieval intent — mirrors `RetrievalIntent` from `@kindgi/agents`, widened for direct-HTTP use. `mode: "list"` returns a plain scoped list (no query), newest first. `mode: "keyword"` runs full-text search. `mode: "semantic"` searches by meaning — it needs embeddings on the deployment; without them the route answers `422 semantic-unavailable`. `mode: "both"` runs both and fuses them by rank (reciprocal rank fusion), as `semantic` needing embeddings.',
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
        'Relevance score. Keyword mode returns an implementation-defined rank (higher = better). Semantic mode returns cosine similarity in [-1, 1] (higher = better). Both: the fused rank score, `Σ 1/(60 + rank)` (higher = better). Absent for `list` mode.',
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

// ---------------- memory erasures ----------------

const ErasureSelectorKindSchema: JsonSchema = {
  type: 'string',
  enum: ['fact', 'participant', 'external', 'conversation'],
};

const ErasureStatusSchema: JsonSchema = {
  type: 'string',
  enum: ['pending', 'running', 'waiting-on-run', 'completed', 'failed'],
  description:
    "`waiting-on-run`: a turn of the person's sits in a flow that serves other people; the erasure waits for it (`waitingOn`) until its deadline, then cancels it.",
};

/** Erase one fact. */
export const MemoryErasureFactSelectorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['factId'],
  description: 'One fact.',
  properties: { factId: { type: 'string', minLength: 1, maxLength: 256 } },
};

/** Erase a person's words. */
export const MemoryErasureSubjectSelectorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject'],
  description:
    "A person: an app's end user (`participant`), or an `external` subject facts name. Erasing a Kindgi user isn't offered.",
  properties: {
    subject: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: {
        kind: { type: 'string', enum: ['participant', 'external'] },
        id: { type: 'string', minLength: 1, maxLength: 256 },
      },
    },
  },
};

/** Erase one conversation. */
export const MemoryErasureConversationSelectorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conversationId'],
  description: 'One conversation.',
  properties: { conversationId: { type: 'string', minLength: 1, maxLength: 256 } },
};

const MEMORY_ERASURE_SELECTORS = [
  { $ref: '#/components/schemas/MemoryErasureFactSelector' },
  { $ref: '#/components/schemas/MemoryErasureSubjectSelector' },
  { $ref: '#/components/schemas/MemoryErasureConversationSelector' },
];

/** Whose words to erase: exactly one of a fact, a person or a conversation. */
export const MemoryErasureSelectorSchema: JsonSchema = {
  description:
    "Whose words to erase: one fact (`factId`), a person (`subject`: an app's end user `participant`, or an `external` subject facts name), or one conversation (`conversationId`).",
  oneOf: MEMORY_ERASURE_SELECTORS,
};

// Its own schema, used only as the request body: `MemoryErasure` names
// `MemoryErasureSelector` too, and a union other schemas name gets inlined
// away by the Python generator (as `RegisterIdentityProviderBody`).
export const CreateMemoryErasureBodySchema: JsonSchema = {
  description:
    "Whose words to erase: one fact (`factId`), a person (`subject`: an app's end user `participant`, or an `external` subject facts name), or one conversation (`conversationId`).",
  oneOf: MEMORY_ERASURE_SELECTORS,
};

export const MemoryErasureSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'selectorKind',
    'status',
    'phase',
    'requestedBy',
    'matchable',
    'counts',
    'attempts',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    selectorKind: ErasureSelectorKindSchema,
    selector: {
      $ref: '#/components/schemas/MemoryErasureSelector',
      description: 'Only while it runs: a completed or failed erasure keeps no identifier.',
    },
    status: ErasureStatusSchema,
    phase: {
      type: 'string',
      enum: ['seed', 'expand', 'settle', 'erase', 'done'],
      description:
        "Where a running erasure is: `seed`, `expand`, `settle` (the person's unfinished runs end, or it waits for them, before anything is cleared), `erase`, then `done`.",
    },
    requestedBy: { type: 'string', description: '`user:<id>` or `service:<id>`.' },
    matchable: {
      type: 'boolean',
      description:
        'A replay after a backup restore can find this person again: a keyed hash was kept.',
    },
    counts: {
      type: 'object',
      additionalProperties: { type: 'integer', minimum: 0 },
      description: 'What each store cleared or deleted, by store.',
    },
    attempts: { type: 'integer', minimum: 0, description: 'Failed attempts so far.' },
    lastError: {
      type: 'string',
      description: "The last failure's code, or `not-yet:<reason>` while it waits. Never content.",
    },
    waitingOn: {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: {
        runId: { type: 'string', format: 'uuid' },
        until: { type: 'string', format: 'date-time' },
      },
      description:
        'The run it waits (or waited) for, and until when; kept as the record of the wait.',
    },
    forced: { type: 'boolean', const: true, description: 'A tenant admin said not to wait.' },
    settleRoundsCapped: {
      type: 'boolean',
      const: true,
      description:
        "Runs of the person's kept appearing, round after round: the erasure went on to erase after its last round rather than wait any longer. Absent: it didn't.",
    },
    createdAt: { type: 'string', format: 'date-time' },
    startedAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
    replayedAt: { type: 'string', format: 'date-time' },
  },
};

export const ResumeMemoryErasureBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    force: {
      type: 'boolean',
      description:
        "Stop waiting for a run in a flow that serves other people: it's cancelled, and the erasure goes on.",
    },
  },
};

export const MemoryErasureCreatedSchema: JsonSchema = {
  allOf: [
    { $ref: '#/components/schemas/MemoryErasure' },
    {
      type: 'object',
      properties: {
        warnings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: ['erasure-unmatchable'],
                description:
                  "`erasure-unmatchable`: this deployment has no erasure ledger key (`KINDGI_ERASURE_LEDGER_KEY`), so a replay after a restore can't find this person.",
              },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  ],
};

export const MemoryErasurePageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/MemoryErasure' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const MemoryErasureLedgerEntrySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'selectorKind', 'requestedBy', 'status', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    selectorKind: ErasureSelectorKindSchema,
    selectorHmac: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
      description: "HMAC-SHA256 of the selector under the tenant's ledger key; absent without one.",
    },
    keyId: { type: 'string', description: 'Which ledger key made `selectorHmac`.' },
    requestedBy: { type: 'string' },
    status: ErasureStatusSchema,
    createdAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
  },
};

export const MemoryErasureLedgerSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/MemoryErasureLedgerEntry' } },
  },
};

export const ReplayMemoryErasuresBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['erasures'],
  properties: {
    erasures: {
      type: 'array',
      maxItems: 10_000,
      items: { $ref: '#/components/schemas/MemoryErasureLedgerEntry' },
      description: 'The ledger as `GET /v1/memory/erasures/export` gave it.',
    },
  },
};

export const ReplayMemoryErasuresResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['replayed', 'restored', 'unmatched'],
  properties: {
    replayed: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      description: 'Found in the tenant again: run again.',
    },
    restored: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      description: 'Put back in the ledger; nothing in the tenant matches.',
    },
    unmatched: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          reason: { type: 'string', enum: ['no-keyed-hash', 'unknown-key'] },
        },
      },
    },
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

// ---------------- improvement proposals ----------------

export const ProposalTierSchema: JsonSchema = {
  type: 'string',
  enum: ['settings-block', 'prompt-block'],
  description:
    'What a proposal changes: a settings block (new values) or a prompt block (a new template) the agent version pins.',
};

export const FixProposalStatusSchema: JsonSchema = {
  type: 'string',
  enum: [
    'draft',
    'evaluating',
    'evaluated',
    'not-better',
    'evaluation-failed',
    'in-review',
    'promoted',
    'refused',
    'rejected',
    'expired',
    'superseded',
    'rolled-back',
    'withdrawn',
  ],
  description:
    "Where a proposal stands, from its comparison and its promotion (never stored). `draft`: not evaluated yet. `evaluating`: its comparison is queued or running. `evaluated`: the candidate beat the recorded outputs on the objective metric by more than the noise (the spread, with more than one repetition). `not-better`: it didn't. `evaluation-failed`: the comparison failed or was cancelled. `in-review`: requested; the gate passed and an approval is open. `promoted`: live for the scope (`promotion.liveNow` says whether it still serves it). `refused`: the gate refused it. `rejected`: the reviewer rejected it. `expired`: the approval expired undecided. `superseded`: approved after the scope's live version or policy changed. `rolled-back`: rolled back through the proposal. `withdrawn`: withdrawn.",
};

export const ProposalChangeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['blockId', 'fromVersion', 'content'],
  properties: {
    blockId: { type: 'string', description: 'The data block the change is to.' },
    fromVersion: {
      type: 'string',
      description: "The block version the agent version pins: what's being changed.",
    },
    content: {
      type: 'object',
      description:
        'The new content: `{ values }` for a settings block (its schema carries over), `{ template }` for a prompt block (its parameters carry over).',
      additionalProperties: false,
      properties: {
        values: { type: 'object', additionalProperties: true },
        template: { type: 'string' },
      },
    },
  },
};

export const ProposalDrafterSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  description: "Who wrote the proposal: a person, or one of the runtime's drafters.",
  properties: {
    kind: { type: 'string', enum: ['person', 'settings-optimizer', 'prompt-drafter'] },
    by: { type: 'string', description: 'For a person: `user:<id>` (or `service:<id>`).' },
    version: { type: 'string', description: "For a drafter: the drafter's version." },
    model: {
      type: 'object',
      additionalProperties: false,
      required: ['providerId', 'model'],
      description: 'For a drafter that used a model: which.',
      properties: { providerId: { type: 'string' }, model: { type: 'string' } },
    },
    passId: {
      type: 'string',
      description:
        'For a drafter: the improvement pass that drafted it (`GET /v1/improvement-passes/{passId}`).',
    },
  },
};

export const ProposalCandidateSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentVersion', 'blockVersion', 'pinsDigest'],
  description:
    'The versions evaluating the proposal published. They serve no scope until a promotion makes the agent version live.',
  properties: {
    agentVersion: {
      type: 'string',
      description: 'The derived agent version (its `derivedFrom.proposalId` names the proposal).',
    },
    blockVersion: {
      type: 'string',
      description: "The block version published from the proposal's content.",
    },
    pinsDigest: { type: 'string' },
  },
};

export const ProposalEvaluationSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['evalRunId', 'suiteId', 'objective', 'startedAt'],
  description:
    "The comparison the proposal was evaluated with, and what it found on the objective metric (the full summary is the eval run's).",
  properties: {
    evalRunId: { type: 'string', format: 'uuid' },
    suiteId: { type: 'string', description: 'The test set (a judged eval suite).' },
    objective: { type: 'string', enum: ['weightedYesShare', 'weightedPrecisionAtK'] },
    startedAt: { type: 'string', format: 'date-time' },
    runStatus: {
      type: 'string',
      enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
      description: "The eval run's status. Absent when the run can't be read.",
    },
    baseline: {
      type: ['number', 'null'],
      description: "The recorded outputs' score; `null` without judged evidence.",
    },
    candidate: { type: ['number', 'null'], description: "The candidate's score." },
    delta: { type: ['number', 'null'] },
    spread: {
      type: 'number',
      description:
        "With more than one repetition: the candidate's max − min, the noise a delta must beat.",
    },
    cases: { type: 'integer' },
    better: { type: 'boolean', description: 'Set once the comparison finished.' },
  },
};

export const ProposalPromotionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status'],
  description: "The promotion the proposal's request made.",
  properties: {
    id: { type: 'string' },
    status: {
      type: 'string',
      enum: ['promoted', 'pending-approval', 'refused', 'superseded', 'rejected', 'expired'],
    },
    approvalId: { type: 'string', description: 'The approval a request in review waits on.' },
    liveNow: {
      type: 'boolean',
      description: 'For a promoted proposal: whether its version still serves the scope.',
    },
  },
};

export const FixProposalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'An improvement proposal: a change to one data block an agent version pins, for one live scope, taken through the same comparison, gate and promotion as any other version.',
  required: [
    'id',
    'agentId',
    'fromVersion',
    'scope',
    'tier',
    'change',
    'hypothesis',
    'drafter',
    'status',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    agentId: { type: 'string' },
    fromVersion: { type: 'string', description: 'The agent version the change applies to.' },
    scope: { $ref: '#/components/schemas/LiveScope' },
    tier: { $ref: '#/components/schemas/ProposalTier' },
    change: { $ref: '#/components/schemas/ProposalChange' },
    hypothesis: { type: 'string', description: 'What the change should improve, and why.' },
    evidence: {
      type: 'object',
      additionalProperties: false,
      properties: { judgmentIds: { type: 'array', items: { type: 'string' } } },
    },
    drafter: { $ref: '#/components/schemas/ProposalDrafter' },
    status: { $ref: '#/components/schemas/FixProposalStatus' },
    candidate: { $ref: '#/components/schemas/ProposalCandidate' },
    evaluation: { $ref: '#/components/schemas/ProposalEvaluation' },
    promotion: { $ref: '#/components/schemas/ProposalPromotion' },
    rolledBack: {
      type: 'object',
      additionalProperties: false,
      required: ['at', 'promotionId', 'by'],
      properties: {
        at: { type: 'string', format: 'date-time' },
        promotionId: { type: 'string', description: "The rollback's own promotion row." },
        by: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    withdrawn: {
      type: 'object',
      additionalProperties: false,
      required: ['at', 'by', 'reason'],
      properties: {
        at: { type: 'string', format: 'date-time' },
        by: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const FixProposalCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/FixProposal' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const ImprovementBudgetSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['maxCostUsd', 'maxCandidates'],
  properties: {
    maxCostUsd: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 100,
      description: "The most the pass's comparisons may cost, in US dollars.",
    },
    maxCandidates: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'The most candidates it compares.',
    },
  },
};

export const ImprovementPassOutcomeSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  description:
    "What a finished pass found. `proposed`: its best candidate beat the current values on the test set's hold-out part, so it wrote an improvement proposal (`proposalId`) for a reviewer to decide. `nothing-found`: no candidate beat them by more than the noise, or within the budget (`reason`; `holdOut` has the best candidate's numbers when one got that far). `failed`: `message` says why.",
  properties: {
    kind: { type: 'string', enum: ['proposed', 'nothing-found', 'failed'] },
    proposalId: { type: 'string', format: 'uuid' },
    reason: { type: 'string' },
    holdOut: {
      type: 'object',
      additionalProperties: false,
      required: ['baseline', 'candidate', 'delta'],
      properties: {
        baseline: { type: ['number', 'null'] },
        candidate: { type: ['number', 'null'] },
        delta: { type: ['number', 'null'] },
        spread: { type: 'number' },
      },
    },
    message: { type: 'string' },
  },
};

export const ImprovementPassSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "An improvement pass: the runtime looking for better values for an agent version's tunable settings (`x-kindgi-tunable`) on a test set, within a budget. Its best candidate becomes an improvement proposal.",
  required: [
    'id',
    'agentId',
    'fromVersion',
    'scope',
    'suiteId',
    'tiers',
    'objective',
    'budget',
    'requestedBy',
    'status',
    'candidatesEvaluated',
    'costUsd',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    agentId: { type: 'string' },
    fromVersion: { type: 'string', description: 'The version whose settings it tunes.' },
    scope: { $ref: '#/components/schemas/LiveScope' },
    suiteId: { type: 'string', description: 'The test set it searches and proves on.' },
    tiers: { type: 'array', items: { type: 'string', enum: ['settings', 'prompt'] } },
    objective: { type: 'string', enum: ['weightedYesShare', 'weightedPrecisionAtK'] },
    classWeights: {
      type: 'string',
      enum: ['as-recorded', 'restricted-only'],
      description:
        'Which judgments its comparisons count. Absent from older servers: `restricted-only`.',
    },
    model: {
      type: 'object',
      additionalProperties: false,
      required: ['providerId', 'model'],
      description: 'For a prompt pass: the provider and model that drafts the templates.',
      properties: { providerId: { type: 'string' }, model: { type: 'string' } },
    },
    candidates: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: 'For a prompt pass: how many templates it drafts.',
    },
    budget: { $ref: '#/components/schemas/ImprovementBudget' },
    requestedBy: { type: 'string' },
    status: { type: 'string', enum: ['running', 'completed', 'failed', 'cancelled'] },
    candidatesEvaluated: { type: 'integer', minimum: 0 },
    costUsd: { type: 'string', description: 'What its comparisons have cost so far (US dollars).' },
    outcome: { $ref: '#/components/schemas/ImprovementPassOutcome' },
    comparisons: {
      type: 'array',
      description:
        'Its comparisons so far, each an eval run to open: `reference` (the version as it is, on the search part), each `candidate` (the block and the values it changed, on the search part), and the `proof` (the proposal, on the hold-out part). Absent from older servers.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'part'],
        properties: {
          evalRunId: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['reference', 'candidate', 'proof'] },
          part: { type: 'string', enum: ['search', 'hold-out'] },
          blockId: { type: 'string' },
          changed: { type: 'object', additionalProperties: true },
          score: { type: ['number', 'null'] },
          failed: { type: 'string' },
          refused: {
            type: 'array',
            description:
              "For a drafted template that was never compared: why the check refused it (what it reads or names that the agent doesn't have, or its size).",
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'message'],
              properties: { path: { type: 'string' }, message: { type: 'string' } },
            },
          },
          hypothesis: {
            type: 'string',
            description: 'For a drafted template: what the drafter meant it to change.',
          },
        },
      },
    },
    trigger: {
      type: 'object',
      additionalProperties: false,
      required: ['triggerId', 'fireId'],
      description:
        'The improve schedule and fire that started it (`GET /v1/schedules/{triggerId}/fires`); absent for a pass a person started.',
      properties: { triggerId: { type: 'string' }, fireId: { type: 'string' } },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: 'string', format: 'date-time' },
  },
};

export const ImprovementPassCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ImprovementPass' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const ImproveBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'scope', 'suiteId'],
  description: 'Start an improvement pass.',
  properties: {
    agentId: { type: 'string' },
    fromVersion: {
      type: 'string',
      description: 'The version whose settings it tunes. Default: the one serving `scope`.',
    },
    scope: { $ref: '#/components/schemas/LiveScope' },
    suiteId: {
      type: 'string',
      description:
        'The test set (a judged eval suite). The pass splits it into a search part and a hold-out part, and proves its best candidate on the hold-out part.',
    },
    tiers: {
      type: 'array',
      items: { type: 'string', enum: ['settings', 'prompt'] },
      minItems: 1,
      maxItems: 1,
      default: ['settings'],
      description:
        "`['settings']`: values for the tunable settings keys. `['prompt']`: a model drafts templates for the prompt block (needs `model`); a template that reads or names anything the agent doesn't have is refused, and a drafted proposal always waits for a reviewer.",
    },
    model: {
      type: 'object',
      additionalProperties: false,
      required: ['providerId', 'model'],
      description: "For a prompt pass: the tenant's provider and model that drafts the templates.",
      properties: { providerId: { type: 'string' }, model: { type: 'string' } },
    },
    candidates: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      default: 3,
      description: 'For a prompt pass: how many templates it drafts.',
    },
    classWeights: {
      type: 'string',
      enum: ['as-recorded', 'restricted-only'],
      default: 'restricted-only',
      description:
        'Which judgments the pass learns from: by default only those recorded under a restricted (trusted) judge class.',
    },
    objective: {
      type: 'string',
      enum: ['weightedYesShare', 'weightedPrecisionAtK'],
      default: 'weightedYesShare',
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      description: 'Default: $5 and 30 candidates.',
      properties: {
        maxCostUsd: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
        maxCandidates: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
};

export const CreateProposalBodySchema: JsonSchema = {
  description:
    'A hand-written proposal: new content for a data block that `fromVersion` pins, for a live scope. The same change from the same version for the same scope is one proposal (answered with `X-Proposal-Deduped: true`).',
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'fromVersion', 'scope', 'tier', 'change', 'hypothesis'],
  properties: {
    agentId: { type: 'string' },
    fromVersion: { type: 'string', description: 'The agent version the change applies to.' },
    scope: { $ref: '#/components/schemas/LiveScope' },
    tier: { $ref: '#/components/schemas/ProposalTier' },
    change: {
      type: 'object',
      additionalProperties: false,
      required: ['blockId', 'content'],
      properties: {
        blockId: { type: 'string', description: "A block `fromVersion` pins, of the tier's kind." },
        content: {
          type: 'object',
          description:
            '`{ values }` for a settings block (they must satisfy its schema), `{ template }` for a prompt block.',
          additionalProperties: false,
          properties: {
            values: { type: 'object', additionalProperties: true },
            template: { type: 'string' },
          },
        },
      },
    },
    hypothesis: { type: 'string', minLength: 1, maxLength: 2000 },
    evidence: {
      type: 'object',
      additionalProperties: false,
      properties: { judgmentIds: { type: 'array', items: { type: 'string' } } },
    },
  },
};

export const EvaluateProposalBodySchema: JsonSchema = {
  description:
    "Compare the proposal's candidate on a test set. The first evaluation publishes the block version and derives the agent version (both serve nowhere until promoted).",
  type: 'object',
  additionalProperties: false,
  required: ['suiteId'],
  properties: {
    suiteId: { type: 'string', description: 'The test set: a judged eval suite.' },
    objective: {
      type: 'string',
      enum: ['weightedYesShare', 'weightedPrecisionAtK'],
      default: 'weightedYesShare',
      description: 'The metric that says whether the candidate is better.',
    },
    reads: { type: 'string', enum: ['recorded', 'live'] },
    repetitions: { type: 'integer', minimum: 1, maximum: 10 },
    k: { type: 'integer', minimum: 1, maximum: 100 },
    classWeights: { type: 'string', enum: ['as-recorded', 'restricted-only'] },
    sample: { $ref: '#/components/schemas/EvalSample' },
  },
};

export const ProposalReasonBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
  },
};

export const WithdrawProposalBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
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
  description: 'Optional: no body signs with the active key.',
  type: 'object',
  additionalProperties: false,
  properties: {
    signingKeyId: SIGNING_KEY_ID_PROPERTY,
    includeMessages: {
      type: 'boolean',
      description:
        'When true, hydrates conversation messages tied to the run (agent turns pin `runId === conversationId`). Non-agent runs return an empty `messages: []` — the field is still present on the bundle for shape stability.',
      default: false,
    },
  },
};

export const ExportProvenanceResultSchema: JsonSchema = signedExportEnvelope({
  description:
    "A run's signed provenance. Body: `{ bundleSchemaVersion, provenanceId, runId, tenantId, version, createdAt, flowRef?, dag: { nodes, edges }, messages?, callUsage?, exportedAt }`; `callUsage` is each model call's usage from the cost ledger, as it stood when signed.",
  kind: 'provenance',
  subject: ['runId', { type: 'string', format: 'uuid' }],
  versionDescription:
    "The body's version, semver. `1.2.0` adds `exportedAt` to the signed body; `1.1.0` added `callUsage`.",
});

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
    projectId: {
      type: 'string',
      description:
        "The project the artifact belongs to: its owner run's, else the upload's `projectId`, else the tenant's default project. Reading it needs `read` there; deleting it, `write`. Absent on blobs stored before projects were recorded.",
    },
    createdBy: {
      type: 'string',
      description: 'Who uploaded it: `user:<id>` or `service_account:<id>`.',
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
    projectId: {
      type: 'string',
      description:
        "The project it belongs to, when there's no `ownerRunId` (with one, the run's project, and this must agree). Default: the tenant's default project.",
    },
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
    providers: {
      type: 'array',
      items: { $ref: '#/components/schemas/CapabilityProvider' },
      description:
        "The tenant's registered providers with a model that has the feature, and those models. Absent from servers that don't read the provider registry; `[]` when no provider of the tenant has one.",
    },
  },
};

export const CapabilityProviderSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'models'],
  description: 'A provider of the tenant with a model that has the feature.',
  properties: {
    providerId: { type: 'string' },
    models: { type: 'array', items: { type: 'string' }, description: 'Its models that have it.' },
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

/** `ModelInfo.thinking`: how a model thinks, so a judge can ask for its least. */
export const ModelThinkingSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'lowest'],
  description:
    "How the model thinks before it answers, so a call that wants as little as it allows (a judge's) gets it. Absent: it doesn't think, or nothing is known.",
  properties: {
    mode: {
      type: 'string',
      enum: ['adaptive', 'always'],
      description: '`adaptive`: on unless turned down. `always`: on, and it can only be lowered.',
    },
    lowest: {
      type: 'string',
      minLength: 1,
      description:
        "The vendor's own setting for the least thinking: for Anthropic `disabled`, `between_tools` or an effort (`low`); for Gemini a thinking level (`low`, `minimal`); for OpenAI a reasoning effort (`low`, `none`).",
    },
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
      description: 'Vendor-facing model id passed to the SDK (e.g. `claude-sonnet-5-5`).',
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
    sampling: {
      type: 'boolean',
      description:
        "Whether the model takes sampling settings (`temperature`). `false`: its API rejects a non-default value, so the call goes without one and the answer's `warnings` say so (`sampling-unsupported`). Absent: it takes them.",
    },
    thinking: { $ref: '#/components/schemas/ModelThinking' },
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
    defaultModel: {
      type: 'string',
      minLength: 1,
      description:
        "The model to use when an agent doesn't choose: one of `models[].name`. When candidates rank equally, it comes before the provider's other models; without it, ties break by model name. A preset sets it. A runtime before 0.1.4 ignores it.",
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
    send_traceparent: {
      type: 'boolean',
      description:
        "Send each model call's W3C `traceparent` to this provider, as a request header, so its request logs can be matched to the run. Ids only, never content. Default `false`: nothing about a run's trace leaves the deployment unless a registration opts in. The runtime enforces it; an older runtime ignores the field and sends none.",
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

/**
 * One thing an adapter's check finds wrong with a provider registration,
 * in the shape of the API's validation issues.
 */
export const AdapterConfigProblemSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'message'],
  properties: {
    path: {
      type: 'string',
      description:
        'The setting at fault, as a JSON pointer into the registration: `/adapter_config/<key>`, `/secret_ref`, `/metadata/region`, `/metadata/models/<i>/name`, or `/adapter_id` (an adapter this runtime does not have).',
    },
    message: {
      type: 'string',
      description:
        "What's wrong with that setting and what it takes (e.g. `adapter_config.api must be one of responses, chat-completions.`). The error's `message` names the provider and its adapter.",
    },
  },
};

export const ProviderCheckResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'adapterId', 'checked', 'issues'],
  properties: {
    providerId: { type: 'string' },
    adapterId: { type: 'string' },
    checked: {
      type: 'boolean',
      description:
        "False when this runtime has no check for the provider's adapter; `issues` is then empty.",
    },
    issues: {
      type: 'array',
      items: { $ref: '#/components/schemas/AdapterConfigProblem' },
    },
    secretRef: {
      type: 'object',
      additionalProperties: false,
      required: ['envName', 'name'],
      properties: {
        envName: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
      },
      description:
        "The secret the provider's key resolves from, by name only, never its value. Present when the registration has one. Only a caller allowed to check the provider sees it. `kindgi dev` uses it to keep a provider's key out of the pack service's environment. A runtime before 0.1.6 leaves it out.",
    },
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
    sendTraceparent: {
      type: 'boolean',
      description:
        "Send the W3C `traceparent` of the run calling a tool to this endpoint, as a request header, so the server's logs can be matched to the run. Ids only, never content. Default `false`. HTTP transports only: `true` on a `stdio` endpoint is refused (`invalid-mcp-endpoint`, reason `invalid-send-traceparent`). An older runtime ignores it and sends none.",
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
        "Kind-specific policy body. For `access-control`, matches `@kindgi/specs/policy.schema.json` (rules + defaults). For `model-routing`, matches `TenantPolicy` from `@kindgi/capabilities` (providers.allow / providers.deny / models.allow / models.deny / regionAllow / maxCostPerCallUsd / maxTokensPerCall). For `tool-errors`, `ToolErrorsSpec` (maxRetries / retryOn). For `hitl`, `HitlSpec` from `@kindgi/policy-contract` (maxTimeoutMs / minReviewerRole / tools — per tool id a mode or `{ mode, requiredRole }`); it only tightens an agent's approvals. For `retention`, `{ v: 1, doc: RetentionSpec }` from `@kindgi/policy-contract` (domain / graceSeconds / mode, which must be `purge`); a tenant has one retention policy per domain, plus one for `*`. `tool-errors`, `hitl` and `retention` specs are validated on publish. For other kinds, the shape is defined by the runtime consumer.",
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

// ---------------- retention (admin plane) ----------------

/** A tombstoning domain a retention policy can cover; `*` is the tenant-wide default. */
export const RetentionDomainSchema: JsonSchema = {
  type: 'string',
  enum: [...RETENTION_DOMAINS],
  description:
    "The kind of record a retention policy covers. `*` covers every domain without a policy of its own, except `memory` and `conversation`: they hold people's words, so only a policy naming them purges them.",
};

/**
 * A domain more than one retention policy covers. Publishing refuses a
 * second policy for a domain, so only policies stored before that rule
 * can do this.
 */
export const RetentionPolicyConflictSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'policyIds', 'appliedPolicyId'],
  properties: {
    domain: { $ref: '#/components/schemas/RetentionDomain' },
    policyIds: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      description: 'Every policy id that covers the domain, sorted.',
    },
    appliedPolicyId: {
      type: 'string',
      description:
        'The one that applies: the policy whose latest version is highest, and on equal versions the lower policy id. Unregister the others.',
    },
  },
};

export const RetentionScheduledItemSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'domain',
    'id',
    'unregisteredAt',
    'purgeAt',
    'pastGrace',
    'policyId',
    'policyVersion',
    'graceSeconds',
  ],
  properties: {
    domain: { $ref: '#/components/schemas/RetentionDomain' },
    id: { type: 'string', description: "The tombstoned row's id in its domain." },
    unregisteredAt: { type: 'string', format: 'date-time' },
    purgeAt: {
      type: 'string',
      format: 'date-time',
      description: "`unregisteredAt` plus the policy's grace: when a sweep purges the row.",
    },
    pastGrace: {
      type: 'boolean',
      description: 'Whether a sweep would purge the row now.',
    },
    policyId: { type: 'string', description: 'The retention policy that applies.' },
    policyVersion: { type: 'string' },
    graceSeconds: {
      type: 'integer',
      description: "The policy's grace, in seconds (`-1`: a hold, never purged).",
    },
  },
};

export const RetentionScheduledPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'domainsMissingAdapter', 'unpolicedDomains'],
  properties: {
    data: {
      type: 'array',
      items: { $ref: '#/components/schemas/RetentionScheduledItem' },
    },
    hasMore: {
      type: 'boolean',
      description:
        'Some domain has more scheduled rows than this page returned (`limit` is per domain). Always sent from 0.1.4; a runtime before it sends none.',
    },
    nextCursor: {
      type: 'string',
      description:
        'The `cursor` for the next page. Absent when `hasMore: false`, or when the runtime cannot continue a page.',
    },
    domainsMissingAdapter: {
      type: 'array',
      items: { $ref: '#/components/schemas/RetentionDomain' },
      description:
        "Domains a retention policy covers that this deployment can't purge (no adapter is wired).",
    },
    unpolicedDomains: {
      type: 'array',
      items: { $ref: '#/components/schemas/RetentionDomain' },
      description: 'Domains no retention policy covers: their tombstones are kept.',
    },
    conflicts: {
      type: 'array',
      items: { $ref: '#/components/schemas/RetentionPolicyConflict' },
      description: 'Domains more than one retention policy covers. Absent or empty: none.',
    },
  },
};

export const RetentionSweepBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: {
      $ref: '#/components/schemas/RetentionDomain',
      description: 'Sweep only this domain. Absent: every domain.',
    },
    maxPerDomain: {
      type: 'integer',
      minimum: 1,
      maximum: 10000,
      description:
        'The most rows one call purges per domain (default 500); the rest are `remaining`.',
    },
  },
};

export const RetentionSweepDomainBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxPerDomain: {
      type: 'integer',
      minimum: 1,
      maximum: 10000,
      description: 'The most rows this call purges (default 500); the rest are `remaining`.',
    },
  },
};

export const RetentionSweepResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['perDomain', 'totalPurged'],
  properties: {
    perDomain: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['domain', 'purged', 'remaining'],
        properties: {
          domain: { $ref: '#/components/schemas/RetentionDomain' },
          purged: { type: 'integer', minimum: 0 },
          remaining: {
            type: 'integer',
            minimum: 0,
            description: 'Rows past grace this call left (the `maxPerDomain` cap); sweep again.',
          },
          policyId: { type: 'string', description: 'The retention policy that applied.' },
          missingAdapter: {
            type: 'boolean',
            const: true,
            description: "Present when this deployment can't purge the domain (no adapter).",
          },
        },
      },
    },
    totalPurged: { type: 'integer', minimum: 0 },
    conflicts: {
      type: 'array',
      items: { $ref: '#/components/schemas/RetentionPolicyConflict' },
      description: 'Domains more than one retention policy covers. Absent or empty: none.',
    },
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
    projectId: recordProjectIdProperty(
      "The test set's project: every version of a test set is in the one project.",
    ),
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
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Present only on an unregistered version: one `GET …/versions?includeTombstoned=true` lists, or a retired test set (every version unregistered) as `GET /v1/eval-suites?includeRetired=true` lists it.',
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
    "What a comparison compares the candidate against: `'recorded'` (each case's recorded output, what was judged), a version (`{ agentId, version }`, replayed under the same rules), or the version live in a scope (`{ live: { projectId?, segments? } }`, `segments` a path in the project, coarse to fine). Only `'recorded'` runs today; the others are refused when the run starts.",
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
            segments: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopeSegment' },
              maxItems: 8,
              description:
                'A segment path in `projectId`, coarse to fine, as live versions resolve it. Needs `projectId`.',
            },
          },
        },
      },
    },
  ],
};

export const EvalOverridesSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "For an agent candidate: block content its replays run instead of the version's pinned content (an improvement pass's search). `settings`: values by settings block id, each a block the version pins, satisfying its schema. `prompts`: a template for the prompt block the version pins, which reads and names only what the agent has (its parameters, the variables the current template reads, the settings blocks it pins, its tools' and blocks' ids) and is at most twice as long. Anything else is `400 validation-failed`. A comparison with overrides can't gate a promotion.",
  properties: {
    settings: {
      type: 'object',
      maxProperties: 20,
      additionalProperties: { type: 'object', additionalProperties: true },
    },
    prompts: {
      type: 'object',
      maxProperties: 1,
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['template'],
        properties: { template: { type: 'string' } },
      },
    },
  },
};

export const EvalSampleSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['part', 'seed', 'holdOutShare'],
  description:
    'Only part of the test set\'s cases: split once into a hold-out part (about `holdOutShare` of them) and a search part (the rest), stratified by judgment (the cases with a "no" and the others are split on their own, a stratum of two or more giving each part at least one), in the order of a hash of each case id and `seed`. The same seed always splits the same test set the same way. A promotion gate refuses a comparison on the search part (`comparison.sample`).',
  properties: {
    part: { type: 'string', enum: ['search', 'hold-out'] },
    seed: { type: 'string', minLength: 1, maxLength: 200 },
    holdOutShare: { type: 'number', minimum: 0.1, maximum: 0.9 },
  },
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
    versions: { $ref: '#/components/schemas/FlowVersionOverrides' },
    classWeights: {
      type: 'string',
      enum: ['as-recorded', 'restricted-only'],
      description:
        "Which judgments count: each at its class's weight (`as-recorded`, the default), or only those recorded while their class was restricted (`Judgment.restricted`), the others weighing 0 (`restricted-only`).",
    },
    overrides: { $ref: '#/components/schemas/EvalOverrides' },
    sample: { $ref: '#/components/schemas/EvalSample' },
    rescoreOf: {
      type: 'string',
      description:
        "Rescore that comparison eval run instead of replaying: its replays' outputs are scored again, with the judgments recorded on them since (a changed answer judged on the replay itself). Nothing runs, and the run rescored stays as it was. Set by `POST /v1/eval-runs/{runId}/rescore`.",
    },
  },
};

// ---------------- comparison results (a `judged` eval run's `result`) ----------------

const nullableNumber = { type: ['number', 'null'] } as const;

export const ComparisonMetricSchema: JsonSchema = {
  description:
    "One metric, the recorded runs beside the candidate. `null` where a side had no judged evidence; `n` / `weight` are the candidate's evidence (cases with judged items, and the judgment weight behind them), `baselineN` / `baselineWeight` the recorded side's.",
  type: 'object',
  additionalProperties: false,
  required: [
    'baseline',
    'candidate',
    'delta',
    'n',
    'weight',
    'baselineN',
    'baselineWeight',
    'direction',
  ],
  properties: {
    baseline: nullableNumber,
    candidate: nullableNumber,
    delta: nullableNumber,
    n: { type: 'integer', minimum: 0 },
    weight: { type: 'number', minimum: 0 },
    baselineN: { type: 'integer', minimum: 0 },
    baselineWeight: { type: 'number', minimum: 0 },
    direction: { type: 'string', enum: ['higher'] },
    k: {
      type: 'integer',
      minimum: 1,
      description: '`weightedPrecisionAtK`: the ranked items it looked at.',
    },
    spread: {
      type: 'number',
      description: "With more than one repetition: the candidate's max − min across them.",
    },
    freshWeight: {
      type: 'number',
      minimum: 0,
      description:
        "Of `weight`, the part judged on the candidate's replays themselves (a rescore, after people judged a changed answer there). Absent when none. Not on `weightedPrecisionAtK`.",
    },
  },
};

export const ComparisonCandidateSchema: JsonSchema = {
  description:
    'What ran on the cases: an agent version, or a flow version (with any versions it swapped in).',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'agentId', 'version'],
      properties: {
        kind: { type: 'string', enum: ['agent'] },
        agentId: { type: 'string' },
        version: { type: 'string' },
        pinsDigest: {
          type: 'string',
          description:
            "The version's pinsDigest: what it ran, as a promotion gate checks. Absent for a version published before pins, and from a comparison recorded before it.",
        },
        overrides: {
          type: 'object',
          additionalProperties: false,
          description:
            "The blocks whose content the replays replaced (`overrides`): no published version ran, so it can't gate a promotion. Absent otherwise.",
          properties: {
            settings: { type: 'array', items: { type: 'string' } },
            prompts: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'flowId', 'version'],
      properties: {
        kind: { type: 'string', enum: ['flow'] },
        flowId: { type: 'string' },
        version: { type: 'string' },
        versions: { $ref: '#/components/schemas/FlowVersionOverrides' },
      },
    },
  ],
};

export const JudgedComparisonSummarySchema: JsonSchema = {
  description:
    'What a comparison concluded: the candidate beside the recorded runs, the case counts, and the metrics. What a promotion gate reads.',
  type: 'object',
  additionalProperties: false,
  required: [
    'evalRunId',
    'status',
    'completedAt',
    'suite',
    'candidate',
    'baseline',
    'scope',
    'cases',
    'diverged',
    'refusedWrites',
    'errors',
    'stopped',
    'reads',
    'sampling',
    'repetitions',
    'metrics',
  ],
  properties: {
    evalRunId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'partial', 'failed'] },
    completedAt: { type: 'string', format: 'date-time' },
    suite: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: { id: { type: 'string' }, version: { type: 'string' } },
    },
    candidate: { $ref: '#/components/schemas/ComparisonCandidate' },
    baseline: {
      description:
        "What the candidate was compared with: `recorded` (the test set's recorded runs, with the versions that served them), or another version.",
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'versions'],
          properties: {
            kind: { type: 'string', enum: ['recorded'] },
            versions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['version', 'cases'],
                properties: {
                  agentId: { type: 'string' },
                  flowId: { type: 'string' },
                  version: { type: 'string' },
                  cases: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'agentId', 'version', 'via'],
          properties: {
            kind: { type: 'string', enum: ['version'] },
            agentId: { type: 'string' },
            version: { type: 'string' },
            via: { type: 'string', enum: ['explicit', 'live'] },
            liveScope: { type: 'object', additionalProperties: true },
          },
        },
      ],
    },
    scope: {
      type: 'object',
      additionalProperties: false,
      description: "Where the test set's judgments came from.",
      properties: { projectId: { type: 'string' } },
    },
    cases: { type: 'integer', minimum: 0 },
    diverged: {
      type: 'integer',
      minimum: 0,
      description: "Cases where a read with no recording ran live under `reads: 'recorded'`.",
    },
    refusedWrites: {
      type: 'integer',
      minimum: 0,
      description: 'Tool calls refused across the cases (what the candidate would have done).',
    },
    errors: { type: 'integer', minimum: 0, description: 'Cases none of whose repetitions ran.' },
    erased: {
      type: 'integer',
      minimum: 1,
      description:
        "Cases an erasure cleared (a person's words were erased): left out of the run and the metrics. Absent: none.",
    },
    rescoreOf: {
      type: 'string',
      description: 'A rescore: the comparison eval run whose replays it scored again.',
    },
    notRescored: {
      type: 'integer',
      minimum: 1,
      description:
        "A rescore: cases whose replays couldn't be read again (a retention purge, say), kept at their earlier scores. Absent: none.",
    },
    stopped: {
      type: 'integer',
      minimum: 0,
      description:
        "Flow cases that stopped at a write the replay refused: no output to score, so they're left out of the metrics.",
    },
    reads: { type: 'string', enum: ['recorded', 'live'] },
    classWeights: {
      type: 'string',
      enum: ['as-recorded', 'restricted-only'],
      description:
        'Which judgments counted. Absent from a comparison recorded before restricted classes: `as-recorded`.',
    },
    sample: {
      $ref: '#/components/schemas/EvalSample',
      description: 'The part of the test set it ran. Absent: every case.',
    },
    sampling: {
      type: 'object',
      additionalProperties: false,
      required: ['models'],
      properties: {
        models: {
          type: 'array',
          description:
            "The models that answered the candidate's replays, and how many replays each.",
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['providerId', 'model', 'runs'],
            properties: {
              providerId: { type: 'string' },
              model: { type: 'string' },
              runs: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    repetitions: { type: 'integer', minimum: 1 },
    metrics: {
      type: 'object',
      additionalProperties: false,
      required: ['weightedYesShare', 'judgedCoverage', 'weightedPrecisionAtK'],
      properties: {
        weightedYesShare: { $ref: '#/components/schemas/ComparisonMetric' },
        judgedCoverage: { $ref: '#/components/schemas/ComparisonMetric' },
        weightedPrecisionAtK: { $ref: '#/components/schemas/ComparisonMetric' },
      },
    },
  },
};

const outputScore = {
  type: 'object',
  additionalProperties: false,
  required: ['yesWeight', 'totalWeight', 'items', 'judgedItems', 'topK'],
  description:
    "An output's score: Σ yesWeight and Σ totalWeight over its judged items, and over those among the first `k` ranked items.",
  properties: {
    yesWeight: { type: 'number' },
    totalWeight: { type: 'number' },
    items: { type: 'integer', minimum: 0 },
    judgedItems: { type: 'integer', minimum: 0 },
    topK: {
      type: 'object',
      additionalProperties: false,
      required: ['yesWeight', 'totalWeight'],
      properties: { yesWeight: { type: 'number' }, totalWeight: { type: 'number' } },
    },
    fresh: {
      type: 'object',
      additionalProperties: false,
      required: ['yesWeight', 'totalWeight', 'items'],
      description:
        'The part of these sums judged on this output itself (a replay judged after it ran). Absent when none was.',
      properties: {
        yesWeight: { type: 'number' },
        totalWeight: { type: 'number' },
        items: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

export const ComparisonCaseResultSchema: JsonSchema = {
  description:
    "One case of a comparison: its replay runs, the scores, the items kept, dropped and new, the tool calls, and why it didn't run when it didn't.",
  type: 'object',
  additionalProperties: false,
  required: [
    'caseId',
    'runIds',
    'baseline',
    'candidate',
    'diverged',
    'refusedWrites',
    'noContext',
    'approvalSkipped',
  ],
  properties: {
    caseId: { type: 'string' },
    runIds: {
      type: 'array',
      items: { type: 'string' },
      description: "The candidate's replay runs, one per repetition.",
    },
    baseline: outputScore,
    candidate: { type: 'array', items: outputScore, description: 'One per repetition that ran.' },
    changes: {
      type: 'object',
      additionalProperties: false,
      required: ['kept', 'dropped', 'new'],
      description: "The first repetition's items against the judged ones.",
      properties: {
        kept: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key'],
            properties: {
              key: { type: 'string' },
              rankBefore: { type: 'integer' },
              rank: { type: 'integer' },
            },
          },
        },
        dropped: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key'],
            properties: { key: { type: 'string' }, rankBefore: { type: 'integer' } },
          },
        },
        new: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'pointer'],
            properties: {
              key: { type: 'string' },
              pointer: { type: 'string' },
              rank: { type: 'integer' },
              judged: {
                type: 'object',
                additionalProperties: false,
                required: ['yesWeight', 'totalWeight'],
                description:
                  'What people said about this item on the replay itself, once they judged it there.',
                properties: { yesWeight: { type: 'number' }, totalWeight: { type: 'number' } },
              },
            },
          },
        },
      },
    },
    tools: {
      type: 'array',
      description: "The first repetition's tool calls, and what happened to each.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'callId', 'toolId', 'toolVersion', 'arguments', 'source'],
        properties: {
          step: { type: 'integer', minimum: 0 },
          callId: { type: 'string' },
          toolId: { type: 'string' },
          toolVersion: { type: 'string' },
          arguments: {},
          source: { type: 'string', enum: ['live', 'recorded', 'refused'] },
          recomputed: {
            type: 'boolean',
            description:
              "With `source: 'live'`: the call ran again from the same arguments because the compared version pins other settings, and the tool reads from nowhere, so it didn't diverge. Absent from older servers, and otherwise.",
          },
          reason: { type: 'string' },
        },
      },
    },
    diverged: { type: 'boolean' },
    refusedWrites: { type: 'integer', minimum: 0 },
    noContext: { type: 'boolean' },
    approvalSkipped: { type: 'boolean' },
    error: { type: 'string' },
    stopped: {
      type: 'object',
      additionalProperties: false,
      required: ['toolId', 'arguments'],
      description: 'Set when the replay stopped at a refused write: what it would have done.',
      properties: { toolId: { type: 'string' }, arguments: {}, reason: { type: 'string' } },
    },
    rescored: {
      type: 'boolean',
      enum: [false],
      description:
        "Set in a rescore when this case's replays can't be read again: its scores are the run rescored's.",
    },
  },
};

export const RescoreEvalRunBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'Body of `POST /v1/eval-runs/{runId}/rescore`: optional.',
  properties: {
    projectId: {
      type: 'string',
      description:
        "The run's project, needed only from a runtime that doesn't record it on the run.",
    },
  },
};

export const JudgedComparisonResultSchema: JsonSchema = {
  description:
    "A comparison's `result` (a `judged` eval run's): the summary and each case. `EvalRun.result` stays an open object, since each kind has its own; the clients read it as this (TS `comparisonOf(run)`, Python `comparison_of(run)`).",
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'perCase'],
  properties: {
    summary: { $ref: '#/components/schemas/JudgedComparisonSummary' },
    perCase: { type: 'array', items: { $ref: '#/components/schemas/ComparisonCaseResult' } },
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
    projectId: {
      type: 'string',
      format: 'uuid',
      description:
        'The project the eval run is in: the one it was started in. Absent on a runtime before Kindgi 0.1.6.',
    },
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
        'Kind-specific opaque JSON. For `accuracy`, contains `{ passCount, totalCount, meanScore, perCase[] }`. For `judged` (a comparison), `{ summary, perCase[] }`: the summary has the baseline (the versions behind the recorded runs) and the candidate (`{ kind: "agent", agentId, version }` or `{ kind: "flow", flowId, version, versions? }`), the case counts (`cases`, `diverged`, `refusedWrites`, `errors`, and `stopped`: flow cases that stopped at a write the replay refused, left out of the metrics), the models that answered, and `metrics` (`weightedYesShare`, `judgedCoverage`, `weightedPrecisionAtK`, each `{ baseline, candidate, delta, n, weight, baselineN, baselineWeight, direction, k?, spread? }`); each case has its replay runs, the scores, the items kept, dropped and new, the tool calls with what happened to each, and `stopped` (what it would have done) when it stopped. Other kinds define their own shapes as their dispatchers ship.',
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
    versions: { $ref: '#/components/schemas/FlowVersionOverrides' },
    classWeights: {
      type: 'string',
      enum: ['as-recorded', 'restricted-only'],
      description:
        "Which judgments count: each at its class's weight (`as-recorded`, the default), or only those recorded while their class was restricted (`Judgment.restricted`), the others weighing 0 (`restricted-only`).",
    },
    overrides: { $ref: '#/components/schemas/EvalOverrides' },
    sample: { $ref: '#/components/schemas/EvalSample' },
  },
  description:
    "Exactly one of `agentRef` or `flowRef` MUST be supplied. `dryRun: true` returns a plan preview without invoking the subject. For a `judged` suite (a test set), the run is a comparison: `agentRef` or `flowRef` with its `version` is the candidate, replayed on each case without doing anything the past run didn't (a flow stops at a write the replay refuses); `baseline` (default `'recorded'`), `reads` (default `recorded`), `repetitions` (default 1) and `k` (default 10) set how. With `flowRef`, `versions` runs the flow with some of its agents or tools at other versions; an id the flow doesn't use, or a version that isn't published, is refused (`400 validation-failed`, each under `details.issues`).",
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
  enum: ['oidc', 'saml'],
  description:
    '`oidc`: an OpenID Connect identity provider people sign in with (Okta, Entra ID, Google, Keycloak…); its endpoints come from its discovery document. `saml`: a SAML 2.0 identity provider people sign in with.',
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

const IDENTITY_PROVIDER_BASE_PROPERTIES = {
  providerId: { type: 'string', minLength: 1 },
  displayName: {
    type: 'string',
    minLength: 1,
    description: 'The name a sign-in page shows ("Sign in with …"). Default: `providerId`.',
  },
  domains: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    description:
      'The email domains whose people sign in with this provider (lowercase, e.g. `acme.com`): how an email-first sign-in page finds it.',
  },
  join: {
    type: 'string',
    enum: ['invite', 'domain'],
    description:
      'Who may sign in the first time: `invite` (default) only people a tenant admin added; `domain` also anyone from one of `domains`, once the deployment has verified them.',
  },
  signIn: { $ref: '#/components/schemas/IdentityProviderSignIn' },
  metadata: { type: 'object', additionalProperties: true },
} as const;

const CLIENT_SECRET_REF = {
  type: 'string',
  minLength: 1,
  description: 'Opaque reference resolved server-side. Never a plaintext secret.',
} as const;

export const IdentityProviderSignInSchema: JsonSchema = {
  description:
    'What to give the identity provider so it can send people back: set by the deployment on what it returns, ignored on registration. OIDC: `redirectUri`. SAML: `spEntityId`, `acsUrl`, `spMetadataUrl`.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['redirectUri'],
      properties: { redirectUri: { type: 'string', format: 'uri' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['spEntityId', 'acsUrl', 'spMetadataUrl'],
      properties: {
        spEntityId: { type: 'string', minLength: 1 },
        acsUrl: { type: 'string', format: 'uri' },
        spMetadataUrl: { type: 'string', format: 'uri' },
      },
    },
  ],
};

export const OidcIdentityProviderConfigSchema: JsonSchema = {
  description:
    "An OpenID Connect identity provider people sign in with. The endpoints come from the issuer's discovery document when absent, and are returned once the deployment has them.",
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'kind', 'issuer', 'clientId', 'clientSecretRef'],
  properties: {
    ...IDENTITY_PROVIDER_BASE_PROPERTIES,
    kind: { type: 'string', const: 'oidc' },
    issuer: { type: 'string', format: 'uri' },
    clientId: { type: 'string', minLength: 1 },
    clientSecretRef: CLIENT_SECRET_REF,
    scopes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Default `openid email profile`.',
    },
    authorizationEndpoint: { type: 'string', format: 'uri' },
    tokenEndpoint: { type: 'string', format: 'uri' },
    userinfoEndpoint: { type: 'string', format: 'uri' },
    jwksEndpoint: { type: 'string', format: 'uri' },
    claimMapping: { $ref: '#/components/schemas/ClaimMappingSpec' },
  },
};

export const SamlIdentityProviderConfigSchema: JsonSchema = {
  description:
    'A SAML 2.0 identity provider people sign in with: its metadata XML, or its entity ID, single sign-on URL and signing certificates. Keys are given as references, never as keys.',
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'kind'],
  properties: {
    ...IDENTITY_PROVIDER_BASE_PROPERTIES,
    kind: { type: 'string', const: 'saml' },
    idpMetadataXml: { type: 'string', minLength: 1 },
    idpEntityId: { type: 'string', minLength: 1 },
    idpSsoUrl: {
      type: 'string',
      format: 'uri',
      description: "The IdP's single sign-on URL (HTTP-Redirect binding).",
    },
    idpCertificates: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: "The IdP's signing certificates (PEM); several during a rollover.",
    },
    spSigningKeyRef: {
      type: 'string',
      minLength: 1,
      description:
        "Opaque reference to the service provider's signing key, for IdPs that require signed AuthnRequests. Never a plaintext key.",
    },
    spDecryptionKeyRef: {
      type: 'string',
      minLength: 1,
      description:
        'Opaque reference to the key that decrypts encrypted assertions. Never a plaintext key.',
    },
    wantAssertionsSigned: {
      type: 'boolean',
      description: 'Require signed assertions. Default `true`.',
    },
    attributeMapping: {
      type: 'object',
      additionalProperties: false,
      description: 'Assertion attribute names. Defaults: `userId` = the NameID, `email` = `email`.',
      properties: {
        userId: { type: 'string', minLength: 1 },
        email: { type: 'string', minLength: 1 },
        displayName: { type: 'string', minLength: 1 },
      },
    },
  },
};

export const IdentityProviderConfigSchema: JsonSchema = {
  description:
    'An identity provider registered on a tenant, one shape per `kind` (narrow on `kind` before reading kind-specific fields). Secrets are always REFERENCES resolved server-side (`clientSecretRef`, `spSigningKeyRef`, `spDecryptionKeyRef`); a plaintext secret never crosses the wire, and a `clientSecret` field is refused.',
  oneOf: [
    { $ref: '#/components/schemas/OidcIdentityProviderConfig' },
    { $ref: '#/components/schemas/SamlIdentityProviderConfig' },
  ],
  discriminator: {
    propertyName: 'kind',
    mapping: {
      oidc: '#/components/schemas/OidcIdentityProviderConfig',
      saml: '#/components/schemas/SamlIdentityProviderConfig',
    },
  },
};

// Its own schema, used only as the request body: a union that other
// schemas also name gets inlined away by the Python generator, so a body
// naming `IdentityProviderConfig` would fail at call time (the same as
// `ServiceAccountGrantBody`).
export const RegisterIdentityProviderBodySchema: JsonSchema = {
  description:
    'The identity provider to register, one shape per `kind`: `oidc` or `saml`. Secrets by reference only (`clientSecretRef`, `spSigningKeyRef`, `spDecryptionKeyRef`); a `clientSecret` field is refused.',
  oneOf: [
    { $ref: '#/components/schemas/OidcIdentityProviderConfig' },
    { $ref: '#/components/schemas/SamlIdentityProviderConfig' },
  ],
  discriminator: {
    propertyName: 'kind',
    mapping: {
      oidc: '#/components/schemas/OidcIdentityProviderConfig',
      saml: '#/components/schemas/SamlIdentityProviderConfig',
    },
  },
};

// Its own schema too, used only as the answer (see `RegisterIdentityProviderBody`).
export const GetIdentityProviderResultSchema: JsonSchema = {
  description:
    'An identity provider as stored, one shape per `kind`, with `signIn` when the deployment sets it. Secrets appear only as references.',
  oneOf: [
    { $ref: '#/components/schemas/OidcIdentityProviderConfig' },
    { $ref: '#/components/schemas/SamlIdentityProviderConfig' },
  ],
  discriminator: {
    propertyName: 'kind',
    mapping: {
      oidc: '#/components/schemas/OidcIdentityProviderConfig',
      saml: '#/components/schemas/SamlIdentityProviderConfig',
    },
  },
};

export const IdentityProviderCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/IdentityProviderConfig' } },
    hasMore: {
      type: 'boolean',
      description: 'Always `false`: the list comes whole. Absent from older servers.',
    },
    changes: {
      type: 'string',
      enum: ['tenant', 'operator'],
      description:
        "Who may add, change and remove the providers here: `tenant`, its admins; `operator`, only the deployment's own token, because the operator manages sign-in (`KINDGI_AUTH_TENANT_PROVIDERS=off`). The providers there sign people in either way. Absent from older servers: read it as `tenant`.",
    },
  },
};

export const SignInOptionSchema: JsonSchema = {
  description: 'One way to sign in, as a sign-in page shows it.',
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'displayName', 'signInUrl'],
  properties: {
    providerId: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1, description: '"Sign in with …".' },
    signInUrl: {
      type: 'string',
      description: 'Where the browser goes to start signing in with this provider.',
    },
    owner: {
      type: 'string',
      enum: ['tenant', 'deployment'],
      description:
        'Whose it is: a workspace\'s own identity provider (`tenant`), or one the deployment offers everyone it has added ("Continue with Google", `deployment`). A sign-in page shows a workspace\'s own first. Absent: `tenant`.',
    },
  },
};

export const SignInOptionsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/SignInOption' } },
    methods: {
      type: 'object',
      additionalProperties: false,
      required: ['identityProviders', 'apiToken'],
      description:
        'The ways in this deployment allows, for a sign-in page to show. Absent from older servers.',
      properties: {
        identityProviders: {
          type: 'boolean',
          description: "Sign-in with an organization's identity provider (email first).",
        },
        apiToken: {
          type: 'boolean',
          description: 'Sign-in to the console with an API token (`POST /v1/auth/token-sign-in`).',
        },
        sessionCookie: {
          type: 'string',
          enum: ['secure', 'plain'],
          description:
            "The browser session cookie's kind: `secure` (`Secure` and `__Host-`, kept by browsers only over https, and by some on http://localhost), or `plain` (development on a loopback address only, so every browser keeps it there). A sign-in page can check the browser keeps that kind before offering sign-in. Absent from older servers, and where there are no browser sessions: treat as `secure`.",
        },
        emailLink: {
          type: 'object',
          additionalProperties: false,
          description:
            'Present when the deployment emails sign-in links: a sign-in page offers "Email me a sign-in link". With `captchaSiteKey`, the request needs a Cloudflare Turnstile token (`x-captcha-response`).',
          properties: {
            captchaSiteKey: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
};

export const SignInEventSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'timestamp', 'kind', 'outcome'],
  description:
    'One sign-in audit event, flattened: who signed in or out, how, from where, and what was refused.',
  properties: {
    id: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
    kind: {
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
      description:
        '`signed-in` / `signed-out`; `sign-in-refused` (with `reason`); `sign-in-link-sent` / `sign-in-link-capped` (an emailed link, for `userId`; `reason` is the limit that held); `sessions-revoked` ("sign out everywhere", or removing a person); `sessions-ended` (a changed boot token).',
    },
    outcome: { type: 'string', description: '`succeeded` or `denied`.' },
    userId: {
      type: 'string',
      description: 'The person: who signed in or out, or whom a link was for. Absent on a refusal.',
    },
    method: {
      type: 'string',
      description:
        "How: `api-token`, `email-link`, `google`, `microsoft`, `github`, or a workspace identity provider's id.",
    },
    clientAddress: {
      type: 'string',
      description: "The client's address, as the runtime trusts it.",
    },
    reason: { type: 'string', description: 'Why a sign-in was refused, or which limit held.' },
    sessionId: { type: 'string' },
  },
};

export const TokenSignInResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'expiresAt'],
  properties: {
    userId: { type: 'string', minLength: 1, description: 'The person now signed in.' },
    expiresAt: {
      type: 'string',
      format: 'date-time',
      description:
        "When the session ends at the latest: its lifetime, or the key's expiry if sooner.",
    },
  },
};

export const RegisterIdentityProviderResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId'],
  properties: {
    providerId: { type: 'string', minLength: 1 },
    provider: {
      $ref: '#/components/schemas/IdentityProviderConfig',
      description:
        'The provider as stored: discovered endpoints, and `signIn` (what to give the identity provider). Absent from older servers.',
    },
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

const NULLABLE_STRING = { type: ['string', 'null'], minLength: 1 } as const;
const NULLABLE_URI = { type: ['string', 'null'], format: 'uri' } as const;
const NULLABLE_STRINGS = {
  oneOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }],
} as const;

export const UpdateIdentityProviderBodySchema: JsonSchema = {
  description:
    "Changes to a registered identity provider: a field given replaces the stored one, `null` removes an optional one, and anything not given stays. The result must still be a whole provider of its `kind` (the fields `IdentityProviderConfig` requires for it), checked as a registration is. `providerId` and `kind` can't change; `signIn` is the deployment's and is ignored. A new `issuer` drops the endpoints discovered from the old one.",
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    providerId: { type: 'string', minLength: 1, description: 'Must match the path when given.' },
    kind: { $ref: '#/components/schemas/IdentityProviderKind' },
    displayName: NULLABLE_STRING,
    domains: NULLABLE_STRINGS,
    join: { oneOf: [{ type: 'string', enum: ['invite', 'domain'] }, { type: 'null' }] },
    metadata: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    issuer: { type: 'string', format: 'uri' },
    clientId: { type: 'string', minLength: 1 },
    clientSecretRef: CLIENT_SECRET_REF,
    scopes: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    authorizationEndpoint: NULLABLE_URI,
    tokenEndpoint: NULLABLE_URI,
    userinfoEndpoint: NULLABLE_URI,
    jwksEndpoint: NULLABLE_URI,
    claimMapping: {
      oneOf: [{ $ref: '#/components/schemas/ClaimMappingSpec' }, { type: 'null' }],
    },
    idpMetadataXml: NULLABLE_STRING,
    idpEntityId: NULLABLE_STRING,
    idpSsoUrl: NULLABLE_URI,
    idpCertificates: NULLABLE_STRINGS,
    spSigningKeyRef: NULLABLE_STRING,
    spDecryptionKeyRef: NULLABLE_STRING,
    wantAssertionsSigned: { type: ['boolean', 'null'] },
    attributeMapping: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            userId: { type: 'string', minLength: 1 },
            email: { type: 'string', minLength: 1 },
            displayName: { type: 'string', minLength: 1 },
          },
        },
        { type: 'null' },
      ],
    },
  },
};

export const UpdateIdentityProviderResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'provider'],
  properties: {
    providerId: { type: 'string', minLength: 1 },
    provider: {
      $ref: '#/components/schemas/IdentityProviderConfig',
      description: 'The provider as stored now; its `signIn` is unchanged.',
    },
  },
};

export const IdentityProviderSignInUrlsSchema: JsonSchema = {
  description:
    "What to give the identity provider so it can send people back, for a provider under this `providerId`: the same before it's registered, after, and after an unregister and a new registration, so the identity provider's side can be set up first. Not secrets: they're in every sign-in's browser redirects.",
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'kind', 'signIn', 'registered'],
  properties: {
    providerId: { type: 'string', minLength: 1 },
    kind: { $ref: '#/components/schemas/IdentityProviderKind' },
    signIn: { $ref: '#/components/schemas/IdentityProviderSignIn' },
    registered: {
      type: 'boolean',
      description: 'Whether a provider is registered under this `providerId` now.',
    },
  },
};

export const RefreshResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionToken', 'sessionId', 'expiresAt'],
  properties: {
    sessionToken: {
      type: 'string',
      description:
        'Opaque session token (`kgi_sk_…`), shown once: the server keeps only a hash of it. Never parse it. Send as `Authorization: Bearer <sessionToken>` on subsequent requests. The underlying provider access-token never leaves the server.',
    },
    sessionId: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
};

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
    "Introspection of the caller's current authentication context. Always carries `tenantId` and `scopes` (empty for static bearer tokens), plus `userId` when the token carries one; `principal` says whom the caller acts as, and an API key adds `tokenId`, its `role` and the `projectId` it is limited to; session-token callers additionally see `sessionId`, `providerId`, and `expiresAt`. `user` is the caller's directory record, present when the deployment wires an identity directory and it knows the `userId`. `reviewerRole` is set when the caller is a reviewer — its token carries a reviewer role, or its user is a registered reviewer — so clients can gate reviewer-only UI (the approvals surface) without a second round trip.",
  type: 'object',
  additionalProperties: false,
  required: ['tenantId', 'scopes'],
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    actor: {
      type: 'string',
      description:
        "The caller as approvals name a person: `user:<id>` or `service_account:<id>`, the same string as an approval's `requestedBy` and a decision's `decidedBy`.",
    },
    userId: { type: 'string' },
    sessionId: { type: 'string' },
    providerId: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string' } },
    expiresAt: { type: 'string', format: 'date-time' },
    reviewerRole: ReviewerRoleSchema,
    user: { $ref: '#/components/schemas/UserRecord' },
    principal: { $ref: '#/components/schemas/ApiKeyPrincipal' },
    tokenId: { type: 'string', description: "The caller's API key, when it is one." },
    role: {
      ...ApiTokenRoleSchema,
      description: "The caller's API key role, when the key has one.",
    },
    projectId: {
      type: 'string',
      description: "The project the caller's API key is limited to, when it is.",
    },
    tenantAdmin: {
      type: 'boolean',
      description:
        'Whether the caller is a tenant admin, decided as the admin routes decide it: `admin` on the tenant when the runtime authorizes, otherwise the `tenant-admin` scope of a full key (never a `member` key or one limited to a project). A console shows its admin pages by it. Absent from older servers: read `scopes`.',
    },
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
    unregisteredAt: {
      type: 'string',
      format: 'date-time',
      description:
        'When they were removed from the tenant (`POST /v1/identity/users/{userId}/unregister`); absent while they are here.',
    },
    metadata: { type: 'object', additionalProperties: true },
    grants: {
      $ref: '#/components/schemas/PersonGrants',
      description:
        "The person's grants: only on `GET /v1/identity/users?include=grants`, and only from a runtime that reads grants.",
    },
  },
};

export const UnregisterUserResultSchema: JsonSchema = {
  description:
    'A removed person, and what removing them took away (each 0 when they were already removed).',
  type: 'object',
  additionalProperties: false,
  required: ['user', 'keysRevoked', 'sessionsRevoked', 'grantsRemoved'],
  properties: {
    user: { $ref: '#/components/schemas/UserRecord' },
    keysRevoked: { type: 'integer', minimum: 0 },
    sessionsRevoked: { type: 'integer', minimum: 0 },
    grantsRemoved: { type: 'integer', minimum: 0 },
  },
};

export const CreateUserBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['displayName'],
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 200 },
    primaryEmail: { type: 'string', description: "Unique among the tenant's people." },
  },
};

export const PersonGrantsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "What a person may do, as granted directly: tenant admin, a role on a project (its memberships), a role in a team, and the reviewer roster. What a team's or an org's grants imply is not expanded.",
  required: ['userId', 'projects', 'teams'],
  properties: {
    userId: { type: 'string' },
    tenantAdmin: {
      type: 'boolean',
      description:
        'Whether the person is a tenant admin. Absent when the runtime has no authorization store: nothing grants it then.',
    },
    tenantMember: {
      type: 'boolean',
      description:
        "Whether the person is a tenant member: they read the tenant's settings (providers, policies, adapters, signing keys, deployments), not its projects. A person is one from being added. Absent when the runtime has no authorization store, or doesn't report it.",
    },
    projects: {
      type: 'array',
      description: 'Direct project memberships.',
      items: { $ref: '#/components/schemas/PersonProjectRole' },
    },
    teams: {
      type: 'array',
      description: 'Team memberships.',
      items: { $ref: '#/components/schemas/PersonTeamRole' },
    },
    reviewer: { $ref: '#/components/schemas/PersonReviewerRole' },
  },
};

/** A project role as the authorization model holds it, highest first. */
export const AccessRoleSchema: JsonSchema = {
  type: 'string',
  enum: ['owner', 'admin', 'editor', 'viewer'],
  description:
    'A project role, as the authorization model holds it: `owner` > `admin` > `editor` > `viewer` (a membership stored as `member` is `viewer`).',
};

export const AccessPathDirectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'role'],
  properties: {
    kind: { type: 'string', enum: ['direct'] },
    role: { $ref: '#/components/schemas/AccessRole' },
    since: {
      type: 'string',
      format: 'date-time',
      description: 'When the membership was added, when the runtime keeps it.',
    },
  },
};

export const AccessPathTeamSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'teamId', 'teamName', 'role'],
  properties: {
    kind: { type: 'string', enum: ['team'] },
    teamId: { type: 'string' },
    teamName: { type: 'string' },
    role: {
      $ref: '#/components/schemas/AccessRole',
      description: 'The role the team holds on the project.',
    },
    since: {
      type: 'string',
      format: 'date-time',
      description: 'When the caller joined the team, when the runtime keeps it.',
    },
  },
};

export const AccessPathOrgAdminSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'orgId', 'orgName'],
  description: 'An admin of the org the project sits in: admin on the project.',
  properties: {
    kind: { type: 'string', enum: ['org-admin'] },
    orgId: { type: 'string' },
    orgName: { type: 'string' },
  },
};

export const AccessPathTenantAdminSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  description: 'A tenant admin: admin on every project.',
  properties: { kind: { type: 'string', enum: ['tenant-admin'] } },
};

export const AccessPathSchema: JsonSchema = {
  description:
    'One way the caller holds a role on a project: a membership of its own, a team it is in, an org it administers, or tenant admin.',
  oneOf: [
    { $ref: '#/components/schemas/AccessPathDirect' },
    { $ref: '#/components/schemas/AccessPathTeam' },
    { $ref: '#/components/schemas/AccessPathOrgAdmin' },
    { $ref: '#/components/schemas/AccessPathTenantAdmin' },
  ],
  discriminator: { propertyName: 'kind' },
};

export const MyProjectAccessSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'name', 'role', 'via'],
  properties: {
    projectId: { type: 'string' },
    name: { type: 'string' },
    role: {
      $ref: '#/components/schemas/AccessRole',
      description: 'The highest role the caller holds on the project, whichever way.',
    },
    via: {
      type: 'array',
      description: 'Every way the caller holds a role on it (for "My access").',
      items: { $ref: '#/components/schemas/AccessPath' },
    },
  },
};

export const MyOrgAccessSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['orgId', 'name', 'role'],
  properties: {
    orgId: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'member'] },
  },
};

export const MyTeamAccessSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['teamId', 'name', 'role'],
  properties: {
    teamId: { type: 'string' },
    name: { type: 'string' },
    role: { $ref: '#/components/schemas/TeamRole' },
  },
};

export const MyReviewerAccessSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'decides', 'canDecide'],
  properties: {
    role: { $ref: '#/components/schemas/ReviewerRole' },
    id: {
      type: 'string',
      description:
        "The caller's reviewer id, its row on the roster: an approval assigned to the caller names it in `assignedTo`. Absent without a roster row (then `canDecide` is false), and from a runtime before 0.1.6.",
    },
    decides: {
      type: 'array',
      description:
        "The approvals' required roles the caller may decide: its own rank and below, lowest first.",
      items: { $ref: '#/components/schemas/ReviewerRole' },
    },
    canDecide: {
      type: 'boolean',
      description:
        'Whether the caller can decide at all: deciding also needs its user and its row on the reviewer roster. False for a token that carries a reviewer role without them.',
    },
  },
};

/** What a project role allows, by object type, in `OBJECT_TYPES` order with each type's actions. */
const PROJECT_SCOPED_TYPES = OBJECT_TYPES.filter(
  (t) => t !== 'tenant' && t !== 'org' && t !== 'team' && t !== 'user',
);

export const RoleActionsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'What a project role allows on the project and on every object of each type in it, by object type.',
  required: [...PROJECT_SCOPED_TYPES],
  properties: Object.fromEntries(
    PROJECT_SCOPED_TYPES.map((t) => [
      t,
      { type: 'array', items: { type: 'string', enum: [...OBJECT_ACTIONS[t]] } },
    ]),
  ),
};

export const RoleCapabilitiesSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "What each project role allows, worked out by the runtime from its authorization model. A client decides an action as `capabilities[project.role][type]` holding it; the server still checks every call. An object can grant more on itself (an agent's own editor), never less, so this is what the caller may do at the least.",
  required: ['owner', 'admin', 'editor', 'viewer'],
  properties: {
    owner: { $ref: '#/components/schemas/RoleActions' },
    admin: { $ref: '#/components/schemas/RoleActions' },
    editor: { $ref: '#/components/schemas/RoleActions' },
    viewer: { $ref: '#/components/schemas/RoleActions' },
  },
};

export const MyTenantAccessSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['admin'],
  properties: {
    admin: {
      type: 'boolean',
      description:
        "Tenant admin, decided as the admin routes decide it (a `member` key's never is).",
    },
    member: {
      type: 'boolean',
      description:
        "Tenant member: reads the tenant's settings. Absent when the runtime doesn't report it.",
    },
  },
};

export const MyKeyLimitsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tokenId'],
  description: "The caller's API key, when it is one, and what it limits.",
  properties: {
    tokenId: { type: 'string' },
    role: { ...ApiTokenRoleSchema },
    projectId: {
      type: 'string',
      description:
        'The project the key is limited to: `projects` holds it alone, and no org or team is administered through it.',
    },
  },
};

export const MyPermissionsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "What the caller may do, with its API key's limits applied: tenant admin and member, its reviewer role, its key's limits and capabilities, the projects it may read with its role in each and how it holds it, its orgs and teams, and what each project role allows. Only what the caller may see: nothing names a project it can't read, or anyone else's role.",
  required: [
    'tenantId',
    'tenant',
    'tokenCapabilities',
    'projects',
    'orgs',
    'teams',
    'capabilities',
  ],
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    tenant: { $ref: '#/components/schemas/MyTenantAccess' },
    reviewer: {
      $ref: '#/components/schemas/MyReviewerAccess',
      description: 'Present when the caller is a reviewer.',
    },
    key: { $ref: '#/components/schemas/MyKeyLimits' },
    tokenCapabilities: {
      type: 'array',
      items: { type: 'string' },
      description:
        "The framework capabilities the caller's token carries (`env:write`, `secrets:write`, `secrets:rotate`, …), which secret, env and signing-key writes require on top of admin at their scope. A sign-in session carries none; an API key carries those it was minted with (`POST /v1/tokens`, none by default).",
    },
    projects: {
      type: 'array',
      description: 'The projects the caller may read, by name.',
      items: { $ref: '#/components/schemas/MyProjectAccess' },
    },
    orgs: {
      type: 'array',
      description: 'The orgs the caller is a member or admin of, by name.',
      items: { $ref: '#/components/schemas/MyOrgAccess' },
    },
    teams: {
      type: 'array',
      description: 'The teams the caller is a member or admin of, by name.',
      items: { $ref: '#/components/schemas/MyTeamAccess' },
    },
    capabilities: { $ref: '#/components/schemas/RoleCapabilities' },
    readOnlyNotice: {
      type: 'string',
      maxLength: 280,
      description:
        "The line a console shows a caller who may only view a project, as a tenant admin set it in the tenant config (`kind: 'config'`, key `console.readOnlyNotice`). Plain text on one line, at most 280 characters. Absent when none is set: the console shows its own.",
    },
  },
};

// ---------- judging rules and queue ----------

export const JudgingRunStatusSchema: JsonSchema = {
  type: 'string',
  enum: ['completed', 'failed', 'cancelled'],
  description: 'How a run ended.',
};

export const JudgingQueueStateSchema: JsonSchema = {
  type: 'string',
  enum: ['open', 'judged', 'dismissed', 'erased'],
  description:
    "Where a queued run stands. `judged`: every rule that queued it has the judgment it wants. `erased`: the run's content is gone (erased, or the run purged); the item shows nothing of it.",
};

export const JudgingRuleWhenSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "Which of a project's runs a rule matches as they end. Every field narrows; absent fields don't. `agentIds` or `flowIds`, not both. Top-level runs only (an agent's own runs, not its turns as a flow's step); replays never match.",
  properties: {
    agentIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
    flowIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
    versions: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { type: 'string' },
      description:
        "These versions exactly, or `live`: runs that got the agent's live version, not one the caller named. Runs from before the runtime recorded how their version was chosen never match `live`.",
    },
    status: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/components/schemas/JudgingRunStatus' },
      description:
        'How the run ended. Only `completed` today: a judgment needs a completed run, so `failed` and `cancelled` are refused (400). Absent: `completed`.',
    },
    includeDryRuns: { type: 'boolean', description: 'Dry runs are left out unless `true`.' },
  },
};

const JUDGING_RULE_FIELDS: Record<string, JsonSchema> = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  when: { $ref: '#/components/schemas/JudgingRuleWhen' },
  sample: {
    type: 'number',
    exclusiveMinimum: 0,
    maximum: 1,
    description:
      "The share of matching runs queued, decided by the run and rule ids: the same every time and across the rule's versions, so raising it keeps the runs it took before. Default 1.",
  },
  maxOpen: {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    description: 'Queue nothing while this rule has this many open items. Absent: no cap.',
  },
  judgeClassId: {
    type: 'string',
    description: 'Whose judgment it wants: one of this class closes it. Absent: any judgment does.',
  },
  enabled: { type: 'boolean', description: 'Default `true`.' },
};

export const JudgingRuleSpecSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'when'],
  description: 'A judging rule as written. It only lists runs: nothing here starts a model.',
  properties: JUDGING_RULE_FIELDS,
};

export const JudgingRulePatchSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'The fields to change; `when` is replaced whole.',
  properties: {
    ...JUDGING_RULE_FIELDS,
    maxOpen: {
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 10000,
      description:
        'Queue nothing while this rule has this many open items. `null` removes the cap.',
    },
    judgeClassId: {
      type: ['string', 'null'],
      description:
        'Whose judgment it wants: one of this class closes it. `null`: any judgment does.',
    },
  },
};

export const JudgingRuleSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ruleId', 'projectId', 'version', 'name', 'when', 'sample', 'enabled', 'createdAt'],
  description: 'One version of a judging rule; the latest live one applies.',
  properties: {
    ruleId: { type: 'string' },
    projectId: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    ...JUDGING_RULE_FIELDS,
    sample: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    enabled: { type: 'boolean' },
    createdBy: { type: 'string', description: 'Who wrote this version.' },
    createdAt: { type: 'string', format: 'date-time' },
    unregisteredAt: { type: 'string', format: 'date-time' },
  },
};

export const JudgingRulePageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/JudgingRule' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const JudgingRuleUnregisterResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ruleId', 'unregistered'],
  properties: { ruleId: { type: 'string' }, unregistered: { type: 'boolean' } },
};

export const JudgingClassCountSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['judgeClassId', 'count'],
  properties: {
    judgeClassId: { type: ['string', 'null'], description: '`null`: unclassified.' },
    count: { type: 'integer', minimum: 0 },
  },
};

export const JudgingProgressSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['total', 'byClass'],
  description: 'The live judgments on the run so far, by class.',
  properties: {
    total: { type: 'integer', minimum: 0 },
    byClass: { type: 'array', items: { $ref: '#/components/schemas/JudgingClassCount' } },
  },
};

export const JudgingItemCanSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['dismiss', 'reopen'],
  description:
    'What the caller may do with the item, by the check the routes make (`write` on the project, as judging the run needs).',
  properties: { dismiss: { type: 'boolean' }, reopen: { type: 'boolean' } },
};

export const JudgingItemRuleSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ruleId', 'version'],
  properties: { ruleId: { type: 'string' }, version: { type: 'integer', minimum: 1 } },
};

export const JudgingQueueItemSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'runId',
    'projectId',
    'flowId',
    'runStatus',
    'completedAt',
    'rules',
    'wantedClassIds',
    'anyJudgment',
    'progress',
    'addedAt',
    'state',
    'can',
  ],
  description: 'A queued run: never its content, only what it was and where it stands.',
  properties: {
    runId: { type: 'string' },
    projectId: { type: 'string' },
    agentId: { type: 'string' },
    agentVersion: { type: 'string' },
    flowId: { type: 'string' },
    runStatus: { $ref: '#/components/schemas/JudgingRunStatus' },
    completedAt: { type: 'string', format: 'date-time' },
    rules: {
      type: 'array',
      items: { $ref: '#/components/schemas/JudgingItemRule' },
      description: 'The rules that queued it, each at the version that did.',
    },
    wantedClassIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'The judge classes its rules want.',
    },
    anyJudgment: { type: 'boolean', description: 'One of its rules wants any judgment.' },
    progress: { $ref: '#/components/schemas/JudgingProgress' },
    addedAt: { type: 'string', format: 'date-time' },
    state: { $ref: '#/components/schemas/JudgingQueueState' },
    closedAt: { type: 'string', format: 'date-time' },
    closedBy: { type: 'string', description: 'Who dismissed or reopened it last.' },
    reason: { type: 'string', description: 'Why it was dismissed, when they said.' },
    can: { $ref: '#/components/schemas/JudgingItemCan' },
  },
};

export const JudgingQueuePageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore', 'total'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/JudgingQueueItem' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
    total: {
      type: 'integer',
      minimum: 0,
      description: 'Every item the filters match, across pages.',
    },
  },
};

export const JudgingDismissBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { reason: { type: 'string', maxLength: 500 } },
};

export const JudgingClassResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['judgeClassId', 'judgments', 'yes'],
  properties: {
    judgeClassId: { type: ['string', 'null'], description: '`null`: unclassified.' },
    judgments: { type: 'integer', minimum: 0 },
    yes: { type: 'integer', minimum: 0 },
  },
};

export const JudgingResultGroupSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'ruleVersion',
    'agentVersion',
    'added',
    'open',
    'judged',
    'dismissed',
    'erased',
    'skippedByCap',
    'judgments',
    'yesShare',
    'byClass',
  ],
  description:
    "One rule version's runs of one agent version. `added` = `open` + `judged` + `dismissed` + `erased`.",
  properties: {
    ruleVersion: { type: 'integer', minimum: 1 },
    agentVersion: {
      type: ['string', 'null'],
      description: '`null`: a flow run, or one from before versions were recorded.',
    },
    added: { type: 'integer', minimum: 0 },
    open: { type: 'integer', minimum: 0 },
    judged: { type: 'integer', minimum: 0 },
    dismissed: { type: 'integer', minimum: 0 },
    erased: { type: 'integer', minimum: 0 },
    skippedByCap: {
      type: 'integer',
      minimum: 0,
      description:
        "Runs the rule matched and sampled but didn't queue, because `maxOpen` were waiting, even when another rule queued them. Non-zero: the queued runs lean toward quiet times. `added` + `skippedByCap` = every run the rule matched and sampled.",
    },
    judgments: {
      type: 'integer',
      minimum: 0,
      description:
        "Live judgments on the queued runs: each is one person's verdict on one item of a run's output.",
    },
    yesShare: {
      type: ['number', 'null'],
      description:
        'The `yes` share of those judgments, each weighted by its class (unclassified: 1). `null` with none.',
    },
    byClass: {
      type: 'array',
      items: { $ref: '#/components/schemas/JudgingClassResult' },
      description: 'The same judgments by class, unweighted.',
    },
  },
};

export const JudgingRuleResultsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ruleId', 'groups'],
  properties: {
    ruleId: { type: 'string' },
    since: { type: 'string', format: 'date-time' },
    groups: {
      type: 'array',
      items: { $ref: '#/components/schemas/JudgingResultGroup' },
      description:
        "By the rule's version and the agent's, newest rule version first: two versions of a rule are two sampling designs, never pooled.",
    },
  },
};

export const JudgingRulePreviewSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['considered', 'matched'],
  properties: {
    considered: { type: 'integer', minimum: 0, description: 'The recent runs looked at.' },
    matched: {
      type: 'integer',
      minimum: 0,
      description: "Those the rule would have queued, with its `sample` (`maxOpen` isn't applied).",
    },
  },
};

export const PersonProjectRoleSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'role'],
  description: "A person's direct role on a project.",
  properties: {
    projectId: { type: 'string' },
    role: { $ref: '#/components/schemas/ProjectRole' },
  },
};

export const PersonTeamRoleSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['teamId', 'role'],
  description: "A person's role in a team.",
  properties: {
    teamId: { type: 'string' },
    role: { $ref: '#/components/schemas/TeamRole' },
  },
};

export const PersonReviewerRoleSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  description: "A person's active entry on the reviewer roster.",
  properties: { role: { $ref: '#/components/schemas/ReviewerRole' } },
};

export const PersonGrantBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  description:
    "The grant to give or take: tenant admin. A person's project and team roles have their own membership routes.",
  properties: { kind: { type: 'string', enum: ['tenant-admin'] } },
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
  description: 'Optional: no body exports every exportable kind, signed with the active key.',
  type: 'object',
  additionalProperties: false,
  properties: {
    signingKeyId: SIGNING_KEY_ID_PROPERTY,
    filter: ExportComplianceEvidenceFilterSchema,
  },
};

export const SignedComplianceEvidenceBundleSchema: JsonSchema = signedExportEnvelope({
  description:
    'Signed compliance evidence. Body: `{ bundleSchemaVersion, tenantId, filter, records, recordCount, exportedAt }`.',
  kind: 'compliance',
  subject: ['tenantId', { type: 'string', format: 'uuid' }],
  versionDescription: "The body's version, semver: `1.0.0`.",
});

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
  description:
    'Role on a project, as read. `member` is only read, on a role given before it was retired: it grants what `viewer` does, and writes refuse it.',
};

export const AssignableProjectRoleSchema: JsonSchema = {
  type: 'string',
  enum: ['viewer', 'editor', 'owner', 'admin'],
  description:
    'A role to give on a project: `owner`, `admin`, `editor` or `viewer`, each including the ones after it. `member` is refused (400): give `viewer`.',
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
  description: 'Exactly one of `userId` and `email` names the person.',
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    userId: { type: 'string', minLength: 1 },
    email: {
      type: 'string',
      minLength: 1,
      description: "The person's email, as the tenant has it.",
    },
    role: { $ref: '#/components/schemas/AssignableProjectRole' },
  },
};

export const UpdateProjectMembershipBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    role: { $ref: '#/components/schemas/AssignableProjectRole' },
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

export const TeamProjectRoleSchema: JsonSchema = {
  type: 'string',
  enum: ['viewer', 'editor', 'admin'],
  description:
    "A team's role on a project, held by every member of the team: `admin` includes `editor`, which includes `viewer`. A team never owns a project.",
};

export const TeamProjectGrantSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: "A team's role on a project.",
  required: ['teamId', 'projectId', 'role'],
  properties: {
    teamId: { type: 'string' },
    projectId: { type: 'string' },
    role: { $ref: '#/components/schemas/TeamProjectRole' },
    grantedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'When the team was given the role. Absent from a runtime that does not record it.',
    },
    teamName: { type: 'string' },
    projectName: { type: 'string' },
  },
};

export const TeamProjectGrantCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/TeamProjectGrant' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const AddTeamProjectGrantBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['teamId', 'role'],
  properties: {
    teamId: { type: 'string', minLength: 1 },
    role: { $ref: '#/components/schemas/TeamProjectRole' },
  },
};

export const AccessPrincipalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  description: 'Whom access is held by: a person, or a service account.',
  properties: {
    kind: { type: 'string', enum: ['user', 'service-account'] },
    id: { type: 'string', minLength: 1 },
  },
};

export const ProjectAccessDirectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'role'],
  description:
    "The principal's own role on the project. `joinedAt` when a membership stands behind it: only then do the membership routes change or remove it.",
  properties: {
    kind: { type: 'string', enum: ['direct'] },
    role: { $ref: '#/components/schemas/ProjectRole' },
    joinedAt: { type: 'string', format: 'date-time' },
  },
};

export const ProjectAccessTeamSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'teamId', 'role'],
  description: "A team's grant on the project, held by every member of the team.",
  properties: {
    kind: { type: 'string', enum: ['team'] },
    teamId: { type: 'string' },
    teamName: { type: 'string' },
    role: { $ref: '#/components/schemas/TeamProjectRole' },
  },
};

export const ProjectAccessOrgAdminSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'orgId'],
  description: "An admin of the project's org (directly or through a team): admin on the project.",
  properties: {
    kind: { type: 'string', enum: ['org-admin'] },
    orgId: { type: 'string' },
    orgName: { type: 'string' },
  },
};

export const ProjectAccessTenantAdminSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  description: 'A tenant admin: admin on every project.',
  properties: { kind: { type: 'string', enum: ['tenant-admin'] } },
};

export const ProjectAccessPathSchema: JsonSchema = {
  description: 'One way into the project.',
  oneOf: [
    { $ref: '#/components/schemas/ProjectAccessDirect' },
    { $ref: '#/components/schemas/ProjectAccessTeam' },
    { $ref: '#/components/schemas/ProjectAccessOrgAdmin' },
    { $ref: '#/components/schemas/ProjectAccessTenantAdmin' },
  ],
  discriminator: { propertyName: 'kind' },
};

export const ProjectAccessSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['principal', 'role', 'via'],
  description: 'Someone with access to the project, their effective role, and every way in.',
  properties: {
    principal: { $ref: '#/components/schemas/AccessPrincipal' },
    displayName: { type: 'string', description: "A person's name, or a service account's." },
    primaryEmail: {
      type: 'string',
      description: "A person's email: shown to the project's admins only.",
    },
    role: {
      type: 'string',
      enum: ['owner', 'admin', 'editor', 'viewer'],
      description: 'The effective role: the highest any way in gives.',
    },
    via: {
      type: 'array',
      minItems: 1,
      description: 'Every way in, the highest role first.',
      items: { $ref: '#/components/schemas/ProjectAccessPath' },
    },
  },
};

export const ProjectAccessPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ProjectAccess' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const UpdateTeamProjectGrantBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    role: { $ref: '#/components/schemas/TeamProjectRole' },
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
    hasMore: {
      type: 'boolean',
      description:
        "Whether there's another page. Absent from older servers: there is one when `nextCursor` is set.",
    },
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
    hasMore: {
      type: 'boolean',
      description:
        "Whether there's another page. Absent from older servers: there is one when `nextCursor` is set.",
    },
    nextCursor: { type: 'string' },
  },
};

export const SecretVersionCollectionPageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/SecretVersionRecord' } },
    hasMore: {
      type: 'boolean',
      description:
        "Whether there's another page. Absent from older servers: there is one when `nextCursor` is set.",
    },
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
    appEnvFile: {
      type: 'boolean',
      description:
        "Under `kindgi dev` only: write the app's own env file (the last of `dev.envFiles`, `.env.local` by default) instead of Kindgi's `.kindgi/secrets.env`, for a value the app reads too, such as a webhook signing secret. A runtime with a secrets store refuses it with `bad-input`.",
    },
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
  description:
    'A schedule: what it runs (a flow at a version, or an agent), when (a cron expression in a timezone), as whom (its owner), and what it does after a gap or while a run is still going.',
  required: [
    'scheduleId',
    'triggerId',
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
    flowId: {
      type: 'string',
      minLength: 1,
      description: 'A schedule that runs a flow: the flow, at `flowVersion`.',
    },
    flowVersion: { type: 'string', minLength: 1 },
    agentId: {
      type: 'string',
      minLength: 1,
      description:
        "A schedule that runs an agent: the agent, at `agentVersion`, else its version live for the schedule's project (else the latest), as a run that names none.",
    },
    agentVersion: { type: 'string', minLength: 1 },
    improve: {
      $ref: '#/components/schemas/ImproveScheduleTarget',
      description:
        'A schedule that starts improvement passes: on this agent, for this scope, when enough new trusted "no" judgments have come in (`input`: the threshold, the monthly cap and the pass options).',
    },
    projectId: {
      type: 'string',
      format: 'uuid',
      description: "The schedule's project: its runs are this project's.",
    },
    owner: {
      $ref: '#/components/schemas/TriggerOwner',
      description:
        'Who its runs act as: whoever registered it, until an admin takes it over (`POST …/owner`). Checked again at every fire.',
    },
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
      description: 'Static input handed to the run on every fire. Absent → `{}`.',
    },
    catchUp: {
      type: 'string',
      enum: ['latest', 'skip'],
      description:
        'After a gap (the runtime was down, or a fire is later than `startingDeadlineSeconds`): `latest` runs once, for the latest missed occurrence, and its fire says how many it missed; `skip` drops the missed occurrences. Never a run per missed occurrence.',
    },
    overlap: {
      type: 'string',
      enum: ['skip', 'allow'],
      description:
        'When an occurrence comes while the previous run of this schedule is still running: `skip` records the fire as skipped; `allow` starts another run.',
    },
    startingDeadlineSeconds: {
      type: 'integer',
      minimum: 1,
      description:
        'How late a fire may start and still count as on time; past it, `catchUp` applies.',
    },
    label: { type: ['string', 'null'] },
    status: { $ref: '#/components/schemas/TriggerStatus' },
    statusReason: {
      type: 'string',
      description:
        'Why the runtime paused it: repeated fires that were refused (the owner lost access) or failed. Skipped fires (an overlap, an erasure in progress) never count.',
    },
    nextFireAt: {
      type: ['string', 'null'],
      format: 'date-time',
      description:
        'Wall-clock time of the next scheduled fire. `null` on paused rows if the cron scheduler never re-armed.',
    },
    upcoming: {
      type: 'array',
      items: { type: 'string', format: 'date-time' },
      description: 'The next occurrences, when the request asked for them (`?upcoming=N`).',
    },
    lastFiredAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const TriggerOwnerSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: ['user', 'service'] },
    id: { type: 'string' },
    displayName: {
      type: 'string',
      description:
        "The owner's name at the time of the response: the person's display name, or the service account's name. Absent when it can't be read (no directory, a removed account) and from a runtime before Kindgi 0.1.6: show the id then.",
    },
  },
};

export const ImproveScheduleTargetSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'scope'],
  description:
    'What an improve schedule works on: the agent, and the live scope its passes propose for and count judgments in.',
  properties: {
    agentId: { type: 'string', minLength: 1 },
    scope: { $ref: '#/components/schemas/LiveScope' },
  },
};

export const ImproveScheduleInputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'An improve schedule\'s `config.input`. Each fire counts the trusted "no" judgments (recorded under a restricted judge class) on the agent\'s runs in the scope since its last pass. When there are enough, across enough runs and judges, it starts a pass on a fresh test set of those runs; otherwise the fire is `skipped`, saying which count was short. A pass that proposes asks for the review at once.',
  properties: {
    tiers: { type: 'array', items: { type: 'string', enum: ['settings', 'prompt'] } },
    objective: { type: 'string', enum: ['weightedYesShare', 'weightedPrecisionAtK'] },
    classWeights: { type: 'string', enum: ['restricted-only', 'as-recorded'] },
    model: {
      type: 'object',
      additionalProperties: false,
      required: ['providerId', 'model'],
      properties: { providerId: { type: 'string' }, model: { type: 'string' } },
    },
    candidates: { type: 'integer', minimum: 1, maximum: 5 },
    budget: {
      type: 'object',
      additionalProperties: false,
      description:
        "Each pass's budget (default $5 and 30 candidates), never more than what's left of the month's cap.",
      properties: {
        maxCostUsd: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
        maxCandidates: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    threshold: {
      type: 'object',
      additionalProperties: false,
      description: 'Default 5 judgments, across 3 runs, from 2 judges.',
      properties: {
        judgments: { type: 'integer', minimum: 1, maximum: 1000 },
        runs: { type: 'integer', minimum: 1, maximum: 1000 },
        judges: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    monthlyCapUsd: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1000,
      description: 'The most its passes may cost in a calendar month (UTC). Default 20.',
    },
  },
};

export const ScheduleFireSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'One fire of a schedule (an occurrence, or a `run-now`) and what came of it. `pending` while its run is being started.',
  required: ['fireId', 'scheduleId', 'triggerId', 'firedAt', 'outcome'],
  properties: {
    fireId: { type: 'string' },
    scheduleId: { type: 'string' },
    triggerId: { type: 'string' },
    scheduledFor: {
      type: 'string',
      format: 'date-time',
      description: 'The occurrence it is for; absent on a `run-now` fire.',
    },
    firedAt: { type: 'string', format: 'date-time' },
    outcome: {
      type: 'string',
      enum: [
        'pending',
        'started',
        'skipped-overlap',
        'skipped-erasure',
        'skipped',
        'refused',
        'failed',
      ],
      description:
        "`skipped-overlap`: the previous fire's run was still going (`overlap: skip`). `skipped-erasure`: the person the fire acts for is being erased, so no new run starts for them until the erasure completes. `skipped`: what an improve schedule waits for wasn't there (its threshold, or its monthly cap), as `detail` says. None of the skipped outcomes counts toward the auto-pause; `refused` and `failed` do.",
    },
    runId: { type: 'string', format: 'uuid', description: 'The run it started.' },
    passId: {
      type: 'string',
      format: 'uuid',
      description: 'The improvement pass it started (an improve schedule).',
    },
    detail: { type: 'string', description: 'Why it was refused, skipped or failed.' },
    missedCount: {
      type: 'integer',
      minimum: 1,
      description: 'Occurrences this fire stood in for after a gap (`catchUp: latest`).',
    },
    manual: { type: 'boolean', description: 'A `run-now` fire, outside the schedule.' },
  },
};

export const ScheduleFirePageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/ScheduleFire' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
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
  description:
    'Name what it runs: `flowId` with `flowVersion`, `agentId` (with an optional `agentVersion`), or `improve` (improvement passes). Registering needs `write` on the project and `execute` on what it runs (`publish` on the agent for `improve`); its runs act as the caller.',
  required: ['config'],
  properties: {
    flowId: { type: 'string', minLength: 1, description: 'Run a flow (with `flowVersion`).' },
    flowVersion: { type: 'string', minLength: 1 },
    agentId: {
      type: 'string',
      minLength: 1,
      description: 'Run an agent (instead of a flow): at `agentVersion`, else its live version.',
    },
    agentVersion: { type: 'string', minLength: 1 },
    improve: {
      $ref: '#/components/schemas/ImproveScheduleTarget',
      description:
        'Start an improvement pass instead of a run (instead of `flowId` or `agentId`). Its `config.input` is the pass options; registering needs `publish` on the agent.',
    },
    projectId: {
      type: 'string',
      format: 'uuid',
      description: "The schedule's project. Absent → the tenant's default project.",
    },
    config: {
      type: 'object',
      additionalProperties: false,
      required: ['cronExpression'],
      properties: {
        cronExpression: { type: 'string', minLength: 1 },
        timezone: { type: 'string' },
        input: {
          description:
            "What each run gets. An agent schedule's runs take the agent payload, `{ userMessage, parameters? }`, so it needs `userMessage`; a flow's take the flow's input. An improve schedule's is `ImproveScheduleInput`, kept with its defaults applied.",
        },
      },
    },
    catchUp: { type: 'string', enum: ['latest', 'skip'], description: 'Default `latest`.' },
    overlap: { type: 'string', enum: ['skip', 'allow'], description: 'Default `skip`.' },
    startingDeadlineSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 86400,
      description: 'Default 600.',
    },
    label: { type: 'string' },
  },
};

export const PatchScheduleBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Change what it runs (the target fields, as at registration, which also needs `execute` on the new target), when, or its policies.',
  properties: {
    flowId: { type: 'string', minLength: 1, description: 'Run a flow (with `flowVersion`).' },
    flowVersion: { type: 'string', minLength: 1 },
    agentId: {
      type: 'string',
      minLength: 1,
      description: 'Run an agent (instead of a flow): at `agentVersion`, else its live version.',
    },
    agentVersion: { type: 'string', minLength: 1 },
    improve: {
      $ref: '#/components/schemas/ImproveScheduleTarget',
      description:
        'Start an improvement pass instead of a run (instead of `flowId` or `agentId`). Its `config.input` is the pass options; registering needs `publish` on the agent.',
    },
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cronExpression: { type: 'string' },
        timezone: { type: 'string' },
        input: {
          description:
            "What each run gets. An agent schedule's runs take the agent payload, `{ userMessage, parameters? }`, so it needs `userMessage`; a flow's take the flow's input. An improve schedule's is `ImproveScheduleInput`, kept with its defaults applied.",
        },
      },
    },
    catchUp: { type: 'string', enum: ['latest', 'skip'], description: 'Default `latest`.' },
    overlap: { type: 'string', enum: ['skip', 'allow'], description: 'Default `skip`.' },
    startingDeadlineSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 86400,
      description: 'Default 600.',
    },
    label: {
      type: ['string', 'null'],
      description: '`null` clears the label; omit to leave unchanged.',
    },
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

export const WebhookSignatureSchema: JsonSchema = {
  description:
    "How a webhook trigger's sender signs. `hmac-sha256`: an HMAC-SHA256 of the raw body under the secret's UTF-8 bytes, in `header`, `hex` or `base64`, after an optional `prefix` (GitHub and Drupal's Webhooks module: `X-Hub-Signature-256`, hex, `sha256=`; WooCommerce: `X-WC-Webhook-Signature`, base64; Shopify: `X-Shopify-Hmac-Sha256`, base64). No timestamp is signed, so only the trigger's dedupe catches a replay. `standard-webhooks`: the Standard Webhooks format (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>` over `{id}.{timestamp}.{body}`, a `whsec_` secret), refused past `toleranceSeconds` (default 300) from the receiver's clock; it dedupes on its `webhook-id`.",
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'encoding', 'header'],
      properties: {
        kind: { type: 'string', enum: ['hmac-sha256'] },
        encoding: { type: 'string', enum: ['hex', 'base64'] },
        header: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'The header that carries the signature (matched case-insensitively).',
        },
        prefix: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
          description: "Stripped from the header's value before decoding (e.g. `sha256=`).",
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['standard-webhooks'] },
        toleranceSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
      },
    },
  ],
};

export const WebhookTriggerRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'A webhook trigger: a signed request to its `receiveUrl` starts a run of its flow, as its owner. The signing secret is never on it, only its name.',
  required: [
    'triggerId',
    'webhookId',
    'flowId',
    'flowVersion',
    'projectId',
    'owner',
    'hmacSecretName',
    'signature',
    'bodyLimitBytes',
    'rateLimitPerMinute',
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
        'The routable id in the receive URL. Route-minted (a random UUID); unique per tenant. Not a secret: the signature is what a request is checked by.',
    },
    receiveUrl: {
      type: 'string',
      format: 'uri',
      description:
        "Where the sender posts: `{public URL}/v1/hooks/{tenantId}/{webhookId}`. Absent when the deployment has no public URL configured (`KINDGI_PUBLIC_URL`); it's never taken from a request's `Host`.",
    },
    flowId: { type: 'string', minLength: 1 },
    flowVersion: { type: 'string', minLength: 1 },
    projectId: {
      type: 'string',
      format: 'uuid',
      description: "The trigger's project: its runs are this project's.",
    },
    owner: {
      $ref: '#/components/schemas/TriggerOwner',
      description:
        'Who its runs act as: whoever registered it, until an admin takes it over (`POST …/owner`). Checked again at every delivery.',
    },
    input: {
      description:
        "The flow's input on every delivery, in place of the event. Absent: the event (the body, parsed as JSON for a JSON content type, else its text).",
    },
    hmacSecretName: {
      type: 'string',
      minLength: 1,
      description:
        'The signing secret, by name (written with `POST /v1/secrets`). Read in the env the deployment serves.',
    },
    signature: { $ref: '#/components/schemas/WebhookSignature' },
    deliveryIdHeader: {
      type: 'string',
      description:
        "The header whose value, with the body, is a delivery's dedupe key (WooCommerce: `X-WC-Webhook-Delivery-ID`, which is per second, not per event, so the body counts too). Absent: deliveries aren't deduped (`standard-webhooks` dedupes on its own `webhook-id`).",
    },
    bodyLimitBytes: {
      type: 'integer',
      minimum: 1024,
      maximum: 1048576,
      description: 'The largest body it takes (default 262144).',
    },
    rateLimitPerMinute: {
      type: 'integer',
      minimum: 1,
      maximum: 6000,
      description: 'Accepted deliveries a minute (default 600); past it, `429`.',
    },
    label: { type: ['string', 'null'] },
    status: { $ref: '#/components/schemas/TriggerStatus' },
    statusReason: {
      type: 'string',
      description:
        "Why the runtime paused it (repeated refused or failed starts; a sender's failed proofs never count), when it did.",
    },
    suppressedRefusals: {
      type: 'object',
      additionalProperties: false,
      required: ['since', 'count'],
      description:
        'Refusals and skipped deliveries this minute past the 20 recorded in its history, which only counted.',
      properties: {
        since: { type: 'string', format: 'date-time' },
        count: { type: 'integer', minimum: 1 },
      },
    },
    lastFiredAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export const WebhookFireSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "One delivery to a webhook trigger and what came of it. A fire keeps the delivery's event only until its run starts; then only the run has it.",
  required: ['fireId', 'triggerId', 'firedAt', 'outcome'],
  properties: {
    fireId: { type: 'string' },
    triggerId: { type: 'string' },
    firedAt: { type: 'string', format: 'date-time' },
    outcome: {
      type: 'string',
      enum: ['pending', 'started', 'skipped', 'refused', 'failed'],
      description:
        "`pending` while its run starts. `skipped`: the trigger was paused, so the event was dropped. `refused`: `detail` says why. `failed`: the run couldn't start.",
    },
    runId: { type: 'string', format: 'uuid', description: 'The run it started.' },
    detail: {
      type: 'string',
      description:
        "Why it was refused, skipped or failed: `signature-missing`, `signature-invalid`, `stale`, `secret-unavailable`, `unregistered`, `paused`, `rate-limited`, `body-too-large`, `body-not-json`, or the owner's lost access.",
    },
    duplicates: {
      type: 'integer',
      minimum: 1,
      description: 'Later deliveries with the same dedupe key, which started nothing.',
    },
    lastDuplicateAt: { type: 'string', format: 'date-time' },
  },
};

export const WebhookFirePageSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'hasMore'],
  properties: {
    data: { type: 'array', items: { $ref: '#/components/schemas/WebhookFire' } },
    hasMore: { type: 'boolean' },
    nextCursor: { type: 'string' },
  },
};

export const WebhookReceiptSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'What the receiver did with a delivery.',
  properties: {
    fireId: {
      type: 'string',
      description: 'The fire recorded (or, with `duplicate`, the earlier one).',
    },
    duplicate: {
      type: 'boolean',
      description: "An earlier fire holds this delivery's dedupe key: nothing new started.",
    },
    skipped: {
      type: 'string',
      enum: ['paused'],
      description: 'The trigger is paused: no run started, and the event was dropped.',
    },
    received: {
      type: 'string',
      enum: ['ping'],
      description: 'A WooCommerce save-time ping: answered, nothing started.',
    },
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

const WebhookDeliveryProperties: Record<string, JsonSchema> = {
  signature: { $ref: '#/components/schemas/WebhookSignature' },
  deliveryIdHeader: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    description:
      'The header whose value, with the body, dedupes deliveries. Not with `standard-webhooks`, which dedupes on its `webhook-id`.',
  },
  bodyLimitBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
  rateLimitPerMinute: { type: 'integer', minimum: 1, maximum: 6000 },
};

export const RegisterWebhookTriggerBodySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['flowId', 'flowVersion', 'hmacSecretName'],
  properties: {
    flowId: { type: 'string', minLength: 1 },
    flowVersion: { type: 'string', minLength: 1 },
    projectId: {
      type: 'string',
      format: 'uuid',
      description: "The trigger's project; absent: the tenant's Default project.",
    },
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
        "The signing secret, by name: written first with `POST /v1/secrets`. Never a model provider's key. For WooCommerce, use letters and digits only (it HTML-decodes the secret before signing).",
    },
    ...WebhookDeliveryProperties,
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
    flowVersion: { type: 'string', minLength: 1 },
    hmacSecretName: { type: 'string', minLength: 1 },
    signature: WebhookDeliveryProperties.signature as JsonSchema,
    deliveryIdHeader: {
      type: ['string', 'null'],
      maxLength: 100,
      description: '`null` stops deduping.',
    },
    bodyLimitBytes: {
      type: ['integer', 'null'],
      minimum: 1024,
      maximum: 1048576,
      description: '`null`: the default.',
    },
    rateLimitPerMinute: {
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 6000,
      description: '`null`: the default.',
    },
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
  enum: ['run.finished', 'improvement-pass.finished', 'approval.requested'],
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
    agent: {
      $ref: '#/components/schemas/RunAgent',
      description:
        "On an agent's run: the agent, the version that ran and the conversation, as `GET /v1/runs/{runId}` shows them (an agent run's `flowId` is `agent.turn`). Absent on a flow's run, and from a runtime before Kindgi 0.1.6.",
    },
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

export const ImprovementPassFinishedEventSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'createdAt', 'data'],
  description:
    'An improvement pass ended (`completed`, `failed` or `cancelled`): one a person started, or one an `improve` schedule did. Its outcome names the proposal it wrote, if it wrote one.',
  properties: {
    id: {
      type: 'string',
      description: 'Event id, also sent as the `webhook-id` header; the same on every retry.',
    },
    type: { type: 'string', const: 'improvement-pass.finished' },
    createdAt: { type: 'string', format: 'date-time' },
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['pass'],
      properties: {
        pass: {
          $ref: '#/components/schemas/ImprovementPass',
          description: 'The pass, as `GET /v1/improvement-passes/{passId}` shows it.',
        },
      },
    },
  },
};

export const RequestedApprovalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approvalId', 'requiredRole', 'createdAt'],
  description:
    'The approval an `approval.requested` event names. What it is about stays behind sign-in: no `context`, no tool call or run input.',
  properties: {
    approvalId: { type: 'string' },
    projectId: { type: 'string' },
    requiredRole: {
      $ref: '#/components/schemas/ReviewerRole',
      description: 'The least reviewer role that may decide it.',
    },
    title: { type: 'string' },
    assignedTo: { type: 'string', description: 'The one reviewer it is assigned to, when it is.' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    url: {
      type: 'string',
      description: 'Its page in the console, when the runtime knows its public address.',
    },
  },
};

export const ApprovalRequestedEventDataSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approval'],
  properties: { approval: { $ref: '#/components/schemas/RequestedApproval' } },
};

export const ApprovalRequestedEventSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'createdAt', 'data'],
  description:
    "An approval was asked for: a reviewer's decision is waiting. Sent once per approval (an escalation is a new approval). `projectId` in the endpoint's filter narrows it to the approval's project.",
  properties: {
    id: {
      type: 'string',
      description: 'Event id, also sent as the `webhook-id` header; the same on every retry.',
    },
    type: { type: 'string', const: 'approval.requested' },
    createdAt: { type: 'string', format: 'date-time' },
    data: { $ref: '#/components/schemas/ApprovalRequestedEventData' },
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
    { $ref: '#/components/schemas/ImprovementPassFinishedEvent' },
    { $ref: '#/components/schemas/ApprovalRequestedEvent' },
    { $ref: '#/components/schemas/WebhookTestEvent' },
  ],
  discriminator: {
    propertyName: 'type',
    mapping: {
      'run.finished': '#/components/schemas/RunFinishedEvent',
      'improvement-pass.finished': '#/components/schemas/ImprovementPassFinishedEvent',
      'approval.requested': '#/components/schemas/ApprovalRequestedEvent',
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
  ['RunWaitingFor', RunWaitingForSchema],
  ['RunWaitingApproval', RunWaitingApprovalSchema],
  ['RunTrigger', RunTriggerSchema],
  ['ScopeSegment', ScopeSegmentSchema],
  ['LiveScopeTenant', LiveScopeTenantSchema],
  ['LiveScopeOrg', LiveScopeOrgSchema],
  ['LiveScopeProject', LiveScopeProjectSchema],
  ['LiveScopeSegment', LiveScopeSegmentSchema],
  ['LiveScope', LiveScopeSchema],
  ['LiveVersionResolution', LiveVersionResolutionSchema],
  ['LivePin', LivePinSchema],
  ['LivePinList', LivePinListSchema],
  ['Promotion', PromotionSchema],
  ['PromotionPage', PromotionPageSchema],
  ['GateCheck', GateCheckSchema],
  ['GatePolicyRef', GatePolicyRefSchema],
  ['GateApproval', GateApprovalSchema],
  ['GatePolicySpec', GatePolicySpecSchema],
  ['GatePolicy', GatePolicySchema],
  ['GatePolicyPage', GatePolicyPageSchema],
  ['PublishGatePolicyBody', PublishGatePolicyBodySchema],
  ['GatePolicyResolution', GatePolicyResolutionSchema],
  ['PromotionCheck', PromotionCheckSchema],
  ['PromoteBody', PromoteBodySchema],
  ['RollbackBody', RollbackBodySchema],
  ['UnpinBody', UnpinBodySchema],
  ['Run', RunSchema],
  ['RunFailure', RunFailureSchema],
  ['FailureSubject', FailureSubjectSchema],
  ['FailureGroup', FailureGroupSchema],
  ['RunFailureGroups', RunFailureGroupsSchema],
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
  ['ApiKeyPrincipal', ApiKeyPrincipalSchema],
  ['ServiceAccountGrantTenantAdmin', ServiceAccountGrantTenantAdminSchema],
  ['ServiceAccountGrantTenantMember', ServiceAccountGrantTenantMemberSchema],
  ['ServiceAccountGrantProject', ServiceAccountGrantProjectSchema],
  ['ServiceAccountGrantProjectBody', ServiceAccountGrantProjectBodySchema],
  ['ServiceAccountGrant', ServiceAccountGrantSchema],
  ['ServiceAccountGrantBody', ServiceAccountGrantBodySchema],
  ['ServiceAccountUngrantProject', ServiceAccountUngrantProjectSchema],
  ['ServiceAccountUngrantBody', ServiceAccountUngrantBodySchema],
  ['ServiceAccount', ServiceAccountSchema],
  ['ServiceAccountPage', ServiceAccountPageSchema],
  ['CreateServiceAccountBody', CreateServiceAccountBodySchema],
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
  ['ExportSigningKey', ExportSigningKeySchema],
  ['ExportSigningKeyList', ExportSigningKeyListSchema],
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
  ['JudgeClassAssertableBy', JudgeClassAssertableBySchema],
  ['JudgeClassAssertableByView', JudgeClassAssertableByViewSchema],
  ['JudgedEvalCase', JudgedEvalCaseSchema],
  ['JudgedEvalCaseCollectionPage', JudgedEvalCaseCollectionPageSchema],
  ['BuildJudgedSuiteBody', BuildJudgedSuiteBodySchema],
  ['BuildJudgedSuiteResult', BuildJudgedSuiteResultSchema],
  ['PromptParameter', PromptParameterSchema],
  ['RetrievalIntent', RetrievalIntentSchema],
  ['AgentMemoryPolicy', AgentMemoryPolicySchema],
  ['ConversationPolicy', ConversationPolicySchema],
  ['TurnBudget', TurnBudgetSchema],
  ['Capability', CapabilitySchema],
  ['ToolRef', ToolRefSchema],
  ['AgentOutputSpec', AgentOutputSpecSchema],
  ['ToolErrorsSpec', ToolErrorsSpecSchema],
  ['Agent', AgentSchema],
  ['AgentPins', AgentPinsSchema],
  ['PromptRef', PromptRefSchema],
  ['BlockRef', BlockRefSchema],
  ['PinChange', PinChangeSchema],
  ['VersionDerivation', VersionDerivationSchema],
  ['DeriveAgentVersionBody', DeriveAgentVersionBodySchema],
  ['AgentPinSwaps', AgentPinSwapsSchema],
  ['FlowPins', FlowPinsSchema],
  ['FlowVersionOverrides', FlowVersionOverridesSchema],
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
  ['GuardrailOutcomeCounts', GuardrailOutcomeCountsSchema],
  ['GuardrailOutcomesByAgentVersion', GuardrailOutcomesByAgentVersionSchema],
  ['GuardrailBlockedRun', GuardrailBlockedRunSchema],
  ['GuardrailOutcomes', GuardrailOutcomesSchema],
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
  ['FactSubject', FactSubjectSchema],
  ['FactAttribution', FactAttributionSchema],
  ['FactGeneratedBy', FactGeneratedBySchema],
  ['Fact', FactSchema],
  ['FactCollectionPage', FactCollectionPageSchema],
  ['WriteFactBody', WriteFactBodySchema],
  ['SupersedeFactBody', SupersedeFactBodySchema],
  ['VerifyFactBody', VerifyFactBodySchema],
  ['FactRevisionList', FactRevisionListSchema],
  ['RetrieveIntent', RetrieveIntentSchema],
  ['RetrieveMemoryBody', RetrieveMemoryBodySchema],
  ['RetrievalHit', RetrievalHitSchema],
  ['RetrieveMemoryResult', RetrieveMemoryResultSchema],
  ['MemoryErasureFactSelector', MemoryErasureFactSelectorSchema],
  ['MemoryErasureSubjectSelector', MemoryErasureSubjectSelectorSchema],
  ['MemoryErasureConversationSelector', MemoryErasureConversationSelectorSchema],
  ['MemoryErasureSelector', MemoryErasureSelectorSchema],
  ['CreateMemoryErasureBody', CreateMemoryErasureBodySchema],
  ['MemoryErasure', MemoryErasureSchema],
  ['MemoryErasureCreated', MemoryErasureCreatedSchema],
  ['MemoryErasurePage', MemoryErasurePageSchema],
  ['MemoryErasureLedgerEntry', MemoryErasureLedgerEntrySchema],
  ['MemoryErasureLedger', MemoryErasureLedgerSchema],
  ['ReplayMemoryErasuresBody', ReplayMemoryErasuresBodySchema],
  ['ResumeMemoryErasureBody', ResumeMemoryErasureBodySchema],
  ['ReplayMemoryErasuresResult', ReplayMemoryErasuresResultSchema],
  ['ProposalTier', ProposalTierSchema],
  ['FixProposalStatus', FixProposalStatusSchema],
  ['ProposalChange', ProposalChangeSchema],
  ['ProposalDrafter', ProposalDrafterSchema],
  ['ProposalCandidate', ProposalCandidateSchema],
  ['ProposalEvaluation', ProposalEvaluationSchema],
  ['ProposalPromotion', ProposalPromotionSchema],
  ['FixProposal', FixProposalSchema],
  ['FixProposalCollectionPage', FixProposalCollectionPageSchema],
  ['ImprovementBudget', ImprovementBudgetSchema],
  ['ImprovementPassOutcome', ImprovementPassOutcomeSchema],
  ['ImprovementPass', ImprovementPassSchema],
  ['ImprovementPassCollectionPage', ImprovementPassCollectionPageSchema],
  ['ImproveBody', ImproveBodySchema],
  ['CreateProposalBody', CreateProposalBodySchema],
  ['EvaluateProposalBody', EvaluateProposalBodySchema],
  ['ProposalReasonBody', ProposalReasonBodySchema],
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
  ['CapabilityProvider', CapabilityProviderSchema],
  ['CapabilityCollectionPage', CapabilityCollectionPageSchema],
  ['ModelThinking', ModelThinkingSchema],
  ['ProviderCost', ProviderCostSchema],
  ['ModelInfo', ModelInfoSchema],
  ['ProviderMetadata', ProviderMetadataSchema],
  ['ProviderCollectionPage', ProviderCollectionPageSchema],
  ['RegisterProviderBody', RegisterProviderBodySchema],
  ['RegisterProviderResult', RegisterProviderResultSchema],
  ['UnregisterProviderResult', UnregisterProviderResultSchema],
  ['ProviderCapabilitiesResult', ProviderCapabilitiesResultSchema],
  ['AdapterConfigProblem', AdapterConfigProblemSchema],
  ['ProviderCheckResult', ProviderCheckResultSchema],
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
  ['RetentionDomain', RetentionDomainSchema],
  ['RetentionPolicyConflict', RetentionPolicyConflictSchema],
  ['RetentionScheduledItem', RetentionScheduledItemSchema],
  ['RetentionScheduledPage', RetentionScheduledPageSchema],
  ['RetentionSweepBody', RetentionSweepBodySchema],
  ['RetentionSweepDomainBody', RetentionSweepDomainBodySchema],
  ['RetentionSweepResult', RetentionSweepResultSchema],
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
  ['EvalOverrides', EvalOverridesSchema],
  ['EvalSample', EvalSampleSchema],
  ['EvalComparison', EvalComparisonSchema],
  ['ComparisonMetric', ComparisonMetricSchema],
  ['ComparisonCandidate', ComparisonCandidateSchema],
  ['JudgedComparisonSummary', JudgedComparisonSummarySchema],
  ['ComparisonCaseResult', ComparisonCaseResultSchema],
  ['JudgedComparisonResult', JudgedComparisonResultSchema],
  ['EvalRun', EvalRunSchema],
  ['EvalRunCollectionPage', EvalRunCollectionPageSchema],
  ['StartEvalRunBody', StartEvalRunBodySchema],
  ['RescoreEvalRunBody', RescoreEvalRunBodySchema],
  ['StartEvalRunResult', StartEvalRunResultSchema],
  ['IdentityProviderKind', IdentityProviderKindSchema],
  ['ClaimMappingScopesSpec', ClaimMappingScopesSpecSchema],
  ['ClaimMappingSpec', ClaimMappingSpecSchema],
  ['IdentityProviderSignIn', IdentityProviderSignInSchema],
  ['OidcIdentityProviderConfig', OidcIdentityProviderConfigSchema],
  ['SamlIdentityProviderConfig', SamlIdentityProviderConfigSchema],
  ['IdentityProviderConfig', IdentityProviderConfigSchema],
  ['RegisterIdentityProviderBody', RegisterIdentityProviderBodySchema],
  ['GetIdentityProviderResult', GetIdentityProviderResultSchema],
  ['IdentityProviderCollectionPage', IdentityProviderCollectionPageSchema],
  ['SignInOption', SignInOptionSchema],
  ['SignInOptions', SignInOptionsSchema],
  ['TokenSignInResult', TokenSignInResultSchema],
  ['SignInEvent', SignInEventSchema],
  ['RegisterIdentityProviderResult', RegisterIdentityProviderResultSchema],
  ['UnregisterIdentityProviderResult', UnregisterIdentityProviderResultSchema],
  ['UpdateIdentityProviderBody', UpdateIdentityProviderBodySchema],
  ['UpdateIdentityProviderResult', UpdateIdentityProviderResultSchema],
  ['IdentityProviderSignInUrls', IdentityProviderSignInUrlsSchema],
  ['RefreshResult', RefreshResultSchema],
  ['LogoutResult', LogoutResultSchema],
  ['WhoamiResult', WhoamiResultSchema],
  ['UserRecord', UserRecordSchema],
  ['UnregisterUserResult', UnregisterUserResultSchema],
  ['CreateUserBody', CreateUserBodySchema],
  ['PersonGrants', PersonGrantsSchema],
  ['PersonProjectRole', PersonProjectRoleSchema],
  ['PersonTeamRole', PersonTeamRoleSchema],
  ['PersonReviewerRole', PersonReviewerRoleSchema],
  ['PersonGrantBody', PersonGrantBodySchema],
  ['JudgingRunStatus', JudgingRunStatusSchema],
  ['JudgingQueueState', JudgingQueueStateSchema],
  ['JudgingRuleWhen', JudgingRuleWhenSchema],
  ['JudgingRuleSpec', JudgingRuleSpecSchema],
  ['JudgingRulePatch', JudgingRulePatchSchema],
  ['JudgingRule', JudgingRuleSchema],
  ['JudgingRulePage', JudgingRulePageSchema],
  ['JudgingRuleUnregisterResult', JudgingRuleUnregisterResultSchema],
  ['JudgingClassCount', JudgingClassCountSchema],
  ['JudgingProgress', JudgingProgressSchema],
  ['JudgingItemCan', JudgingItemCanSchema],
  ['JudgingItemRule', JudgingItemRuleSchema],
  ['JudgingQueueItem', JudgingQueueItemSchema],
  ['JudgingQueuePage', JudgingQueuePageSchema],
  ['JudgingDismissBody', JudgingDismissBodySchema],
  ['JudgingClassResult', JudgingClassResultSchema],
  ['JudgingResultGroup', JudgingResultGroupSchema],
  ['JudgingRuleResults', JudgingRuleResultsSchema],
  ['JudgingRulePreview', JudgingRulePreviewSchema],
  ['AccessRole', AccessRoleSchema],
  ['AccessPathDirect', AccessPathDirectSchema],
  ['AccessPathTeam', AccessPathTeamSchema],
  ['AccessPathOrgAdmin', AccessPathOrgAdminSchema],
  ['AccessPathTenantAdmin', AccessPathTenantAdminSchema],
  ['AccessPath', AccessPathSchema],
  ['MyProjectAccess', MyProjectAccessSchema],
  ['MyOrgAccess', MyOrgAccessSchema],
  ['MyTeamAccess', MyTeamAccessSchema],
  ['MyReviewerAccess', MyReviewerAccessSchema],
  ['RoleActions', RoleActionsSchema],
  ['RoleCapabilities', RoleCapabilitiesSchema],
  ['MyTenantAccess', MyTenantAccessSchema],
  ['MyKeyLimits', MyKeyLimitsSchema],
  ['MyPermissions', MyPermissionsSchema],
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
  ['AssignableProjectRole', AssignableProjectRoleSchema],
  ['TeamProjectRole', TeamProjectRoleSchema],
  ['TeamProjectGrant', TeamProjectGrantSchema],
  ['TeamProjectGrantCollectionPage', TeamProjectGrantCollectionPageSchema],
  ['AddTeamProjectGrantBody', AddTeamProjectGrantBodySchema],
  ['UpdateTeamProjectGrantBody', UpdateTeamProjectGrantBodySchema],
  ['AccessPrincipal', AccessPrincipalSchema],
  ['ProjectAccessDirect', ProjectAccessDirectSchema],
  ['ProjectAccessTeam', ProjectAccessTeamSchema],
  ['ProjectAccessOrgAdmin', ProjectAccessOrgAdminSchema],
  ['ProjectAccessTenantAdmin', ProjectAccessTenantAdminSchema],
  ['ProjectAccessPath', ProjectAccessPathSchema],
  ['ProjectAccess', ProjectAccessSchema],
  ['ProjectAccessPage', ProjectAccessPageSchema],
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
  ['TriggerOwner', TriggerOwnerSchema],
  ['ScheduleFire', ScheduleFireSchema],
  ['ScheduleFirePage', ScheduleFirePageSchema],
  ['ScheduleCollectionPage', ScheduleCollectionPageSchema],
  ['RegisterScheduleBody', RegisterScheduleBodySchema],
  ['PatchScheduleBody', PatchScheduleBodySchema],
  ['ScheduleUnregisterResult', ScheduleUnregisterResultSchema],
  ['EventTriggerRecord', EventTriggerRecordSchema],
  ['EventTriggerCollectionPage', EventTriggerCollectionPageSchema],
  ['RegisterEventTriggerBody', RegisterEventTriggerBodySchema],
  ['PatchEventTriggerBody', PatchEventTriggerBodySchema],
  ['EventTriggerUnregisterResult', EventTriggerUnregisterResultSchema],
  ['WebhookSignature', WebhookSignatureSchema],
  ['WebhookTriggerRecord', WebhookTriggerRecordSchema],
  ['WebhookFire', WebhookFireSchema],
  ['WebhookFirePage', WebhookFirePageSchema],
  ['WebhookReceipt', WebhookReceiptSchema],
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
  ['ImprovementPassFinishedEvent', ImprovementPassFinishedEventSchema],
  ['RequestedApproval', RequestedApprovalSchema],
  ['ApprovalRequestedEventData', ApprovalRequestedEventDataSchema],
  ['ApprovalRequestedEvent', ApprovalRequestedEventSchema],
  ['ImproveScheduleTarget', ImproveScheduleTargetSchema],
  ['ImproveScheduleInput', ImproveScheduleInputSchema],
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

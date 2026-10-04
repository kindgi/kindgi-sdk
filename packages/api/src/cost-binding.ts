// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import type { Cursor, TenantId, Timestamp } from '@kindgi/types';

/**
 * Caller-plugged surface for the cost readback plane — part of the
 * admin control plane. Read-only: tenants + operators
 * inspect what they've spent across model calls, tool invocations,
 * storage, and sandbox usage. Instrumentation (how records get recorded)
 * lives at the agent / tool / sandbox layers — this surface only reads.
 *
 * The runtime substrate is the cost tracker — usage records carrying
 * `resourceKind`, `providerId`, `runId`, `quantity`, `unit`, `costUsd`,
 * `metrics` and `attributes`, plus a `recordedAt` timestamp. But the wire
 * vocabulary differs enough (`category` instead of `resourceKind`;
 * first-class `agentId` / `conversationId` filters that live in
 * `attributes` at storage time; multi-dim `groupBy` that needs
 * storage-side rollups) that a caller-plugged binding is cleaner than
 * direct storage access — each deployment maps wire fields to whatever
 * storage shape it uses. Trivial in-memory implementations are fine for
 * dev + tests; production implementations run the aggregate rollups in
 * their store.
 *
 * Every method is tenant-scoped. Cursors are opaque — the binding
 * chooses its encoding. The API layer only validates round-trip as a
 * string; it never inspects the payload.
 *
 * Budgets are NOT part of this interface.
 */
export interface CostBinding {
  /**
   * Cursor-paginated list of cost records. Sort order is fixed:
   * `occurredAt desc, id desc`. Filters compose (all AND).
   */
  listRecords(input: CostListRecordsInput): Promise<CostRecordPage>;
  /**
   * Fetch a record by id, or `null` when unknown. The route surfaces
   * `null` as `404 cost-record-not-found`.
   */
  getRecord(input: CostGetRecordInput): Promise<CostRecord | null>;
  /**
   * Multi-dimensional aggregate rollup. `groupBy` may combine any
   * subset of `COST_GROUP_DIMENSIONS`; the binding returns one group per
   * distinct key tuple within the required `from`..`to` window, with its
   * cost and token sums.
   */
  aggregate(input: CostAggregateInput): Promise<CostAggregateResult>;
}

// A binding throws when its store fails: the route answers 500. It never
// answers a failed read with an empty page or zero sums.

// -------- listRecords --------

export interface CostListRecordsInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly filter: CostRecordFilter;
  /**
   * Narrow the list to a specific scope. Absent = no scope narrow
   * (return every row in the tenant the caller can see — admin/audit
   * default).
   *
   * Content-scoped semantics (this binding — cost records attribute
   * to the project whose run produced them):
   * - `{ kind: 'project', projectId }` — rows in that project.
   * - `{ kind: 'org', orgId }` — rows in every project belonging to
   *   that org.
   * - `{ kind: 'tenant', tenantId }` — every row in the tenant.
   *
   * Content rows always belong to a project, so `inherit` has no
   * effect here.
   */
  readonly scope?: Scope;
  /**
   * `false` = literal-at-this-scope only (admin/audit view).
   * `true` (default) = inheritance walk (user-facing view).
   * No-op for content-scoped bindings (rows only exist at
   * project-level — there is no upward hierarchy to walk). Kept for
   * uniformity: scope-aware bindings share one filter shape.
   */
  readonly inherit?: boolean;
  /** Add each record's `rawUsage`: the vendor's own usage object. */
  readonly includeRawUsage?: boolean;
}

export interface CostRecordFilter {
  readonly runId?: string;
  readonly agentId?: string;
  readonly conversationId?: string;
  /**
   * Wire vocabulary for the resource dimension — maps to the runtime's
   * `resourceKind` (`llm.inference`, `tool.invocation`, `storage.write`,
   * `sandbox.exec`, ...). Exact-match; free-form string so deployments
   * can extend without a schema change.
   */
  readonly category?: string;
  readonly providerId?: string;
  /** The model actually called. */
  readonly model?: string;
  /** The exact model version the vendor reported. */
  readonly servedModel?: string;
  /** Every record of the run tree whose root is this run. */
  readonly rootRunId?: string;
  /**
   * With `runId`: that run's records and those of every run it started,
   * at any depth.
   */
  readonly includeDescendants?: boolean;
  /** Inclusive. */
  readonly from?: Date;
  /** Exclusive. */
  readonly to?: Date;
}

export interface CostRecordPage {
  readonly data: readonly CostRecord[];
  readonly nextCursor?: Cursor;
}

// -------- getRecord --------

export interface CostGetRecordInput {
  readonly tenantId: TenantId;
  readonly recordId: string;
  /** Add the record's `rawUsage`: the vendor's own usage object. */
  readonly includeRawUsage?: boolean;
}

// -------- aggregate --------

/**
 * Group dimensions the binding may aggregate over. `day` / `month` are
 * time bucketing on `occurredAt` (UTC calendar day / month). Every call
 * is tenant-scoped, so `tenant` always resolves to the caller's tenant
 * id. `model` is the model actually called; `servedModel` the exact
 * version the vendor reported. `orgId` is the org of the record's
 * project (`null` for a project in no org).
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

export const COST_GROUP_DIMENSIONS: readonly CostGroupDimension[] = [
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
];

export interface CostAggregateInput {
  readonly tenantId: TenantId;
  readonly groupBy: readonly CostGroupDimension[];
  readonly from: Date;
  readonly to: Date;
  readonly filter?: CostRecordFilter;
  /**
   * Narrow the aggregate to a specific scope. Same semantics as
   * `CostListRecordsInput.scope` — content-scoped; an org scope covers
   * the org's projects. Lets `/v1/cost/aggregate` accept the same
   * `?scopeKind + ?scopeId` triplet as `/v1/cost/records`. Without
   * this, an aggregate call after a scoped list would drop the scope
   * silently. `inherit` is a documented no-op for this content-scoped
   * binding.
   */
  readonly scope?: Scope;
  /**
   * `false` = literal-at-this-scope only. `true` (default) = inheritance
   * walk. No-op for content-scoped bindings; passed through for wire
   * shape uniformity.
   */
  readonly inherit?: boolean;
}

/**
 * One row of the aggregate result. `key` maps every requested `groupBy`
 * dimension to its value for this group — `null` when the underlying
 * records had no value for that dimension (e.g. records with no
 * `agentId` when grouping by `agentId`). Downstream consumers treat
 * `null` as a distinct group ("unattributed").
 */
export interface CostAggregateGroup {
  readonly key: Readonly<Record<string, string | null>>;
  readonly count: number;
  readonly totalUsd: number;
  readonly tokens: CostTokenTotals;
}

/**
 * Token sums. `prompt` and `completion` are the totals; `cacheRead` /
 * `cacheWrite` are parts of `prompt`, `reasoning` of `completion`
 * (`0` where providers didn't report them).
 */
export interface CostTokenTotals {
  readonly prompt: number;
  readonly completion: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

export interface CostAggregateResult {
  readonly groups: readonly CostAggregateGroup[];
  readonly totalUsd: number;
  readonly totalRecords: number;
  readonly tokens: CostTokenTotals;
  readonly timeRange: {
    readonly from: Timestamp;
    readonly to: Timestamp;
  };
}

// -------- CostRecord (wire) --------

/**
 * Wire shape for a single cost record. Corresponds 1:1 to a usage
 * record in the runtime's cost tracker, flattened for the wire
 * (`resourceKind` renamed to `category`; `attributes.agentId`
 * / `attributes.conversationId` lifted to top-level fields when
 * present). The binding decides how to reshape the runtime row — this
 * type just describes what the route hands back.
 */
export interface CostRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly category: string;
  readonly providerId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly quantity: number;
  readonly unit: string;
  readonly costUsd?: number;
  readonly occurredAt: Timestamp;
  readonly metrics?: Readonly<Record<string, unknown>>;
  readonly attributes?: Readonly<Record<string, unknown>>;
  // A model call (`category` `llm.inference`):
  /** The call's id; its provenance node carries it too. */
  readonly callId?: string;
  readonly projectId?: string;
  /** The root of the record's run tree. */
  readonly rootRunId?: string;
  readonly parentRunId?: string;
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
  /** The router picked a fallback provider. */
  readonly fallback?: boolean;
  /** `ok`: the provider answered. `failed`: the call threw. */
  readonly status?: 'ok' | 'failed';
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
  };
  readonly durationMs?: number;
  readonly finishReason?: string;
  readonly providerRequestId?: string;
  /** HTTP attempts, the client's retries included. */
  readonly attempts?: number;
  readonly error?: { readonly message: string };
  /** The vendor's own usage object (only when asked for: `include=rawUsage`). */
  readonly rawUsage?: {
    readonly provider: string;
    readonly model: string;
    readonly usage: Readonly<Record<string, unknown>>;
  };
}

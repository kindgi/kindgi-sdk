// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The usage ledger's vocabulary: what a runtime that meters usage
 * (`KINDGI_USAGE_METERING=on`) counts, and the class each counted run is
 * in. The runtime writes one record per counted thing, in the same
 * transaction as the change it counts, unique per counted id, so each is
 * counted exactly once. A tenant reads its own on `GET /v1/usage`, and
 * the operator reads them across tenants on `GET /v1/system/usage`.
 * Model-call cost stays on `/v1/cost/*`.
 */

import type { ProjectId, TenantId } from '@kindgi/types';

/**
 * The class a counted run is in, fixed when the run is created:
 * - `production`: an ordinary run in a project that's in production;
 * - `staging`: an ordinary run in a project that isn't;
 * - `dry-run`, `replay`, `eval`: a dry run, a replay of a run, a run of a
 *   test set's case in a test run, wherever it runs;
 * - `child`: a run started inside another run, which counts as part of it.
 */
export const USAGE_CLASSES = [
  'production',
  'staging',
  'dry-run',
  'replay',
  'eval',
  'child',
] as const;

export type UsageClass = (typeof USAGE_CLASSES)[number];

/**
 * What the ledger counts (a record's `resourceKind`):
 * - `run.started` when a run is created, and `run.ended` when it reaches a
 *   terminal status (its quantity, the wall time in milliseconds);
 * - `approval.requested` and `approval.decided`;
 * - `llm.inference` and `llm.embedding`, a model call;
 * - `project.production`, a project put in production or taken out
 *   (`on` or `off`).
 */
export const USAGE_KINDS = [
  'run.started',
  'run.ended',
  'approval.requested',
  'approval.decided',
  'llm.inference',
  'llm.embedding',
  'project.production',
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * A record's state, by kind:
 * - `project.production`: `on` or `off`;
 * - `run.ended`: how the run ended, `completed`, `failed` or `cancelled`;
 * - `approval.requested`: `escalation` for the next tier an escalation
 *   opened; none for a first approval;
 * - `approval.decided`: how it ended, `approved`, `rejected`, `withdrawn`,
 *   `escalated` or `expired`.
 * Other kinds have none.
 */
export const USAGE_STATES = [
  'on',
  'off',
  'completed',
  'failed',
  'cancelled',
  'escalation',
  'approved',
  'rejected',
  'withdrawn',
  'escalated',
  'expired',
] as const;

export type UsageState = (typeof USAGE_STATES)[number];

/** What usage can be grouped by. `day` is the record's UTC date. */
export const USAGE_GROUP_KEYS = [
  'tenant',
  'project',
  'agent',
  'kind',
  'class',
  'state',
  'day',
] as const;

export type UsageGroupKey = (typeof USAGE_GROUP_KEYS)[number];

/** What a tenant's own read groups by: everything but `tenant`. */
export const TENANT_USAGE_GROUP_KEYS = [
  'project',
  'agent',
  'kind',
  'class',
  'state',
  'day',
] as const satisfies readonly UsageGroupKey[];

/** The longest window one read covers, in days. */
export const USAGE_WINDOW_MAX_DAYS = 92;

/** What a usage read asks a runtime for. */
export interface UsageQuery {
  /** Records at or after this time. */
  readonly from: Date;
  /** Records before this time. */
  readonly to: Date;
  readonly groupBy: readonly UsageGroupKey[];
  /** Only these kinds; absent: every kind. */
  readonly kinds?: readonly UsageKind[];
  /** Only these classes; absent: every class (and kinds with none). */
  readonly classes?: readonly UsageClass[];
  /** Only these states; absent: every state (and kinds with none). */
  readonly states?: readonly UsageState[];
  /**
   * Only these projects; absent: every project, and records with none.
   * Empty: nothing (a caller who may read none of the projects asked for).
   */
  readonly projectIds?: readonly ProjectId[];
  readonly limit: number;
  /** Where the last page stopped (its `nextCursor`), opaque. */
  readonly cursor?: string;
}

/** The operator's read across tenants: one tenant's only, with `tenantId`. */
export interface SystemUsageQuery extends UsageQuery {
  /** Only this tenant; absent: every tenant. */
  readonly tenantId?: TenantId;
}

/** One group: the dimensions grouped by, then counts and sums. */
export interface UsageGroup {
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly kind?: UsageKind;
  readonly class?: UsageClass;
  readonly state?: UsageState;
  /** `YYYY-MM-DD`, the UTC date. */
  readonly day?: string;
  /** Records in the group. */
  readonly count: number;
  /**
   * The sum of their quantities: milliseconds for `run.ended`, tokens for
   * model calls, and 1 for every other record, so a group of those has a
   * quantity equal to its count.
   */
  readonly quantity: number;
  /** The earliest record's time. */
  readonly firstAt: string;
  /** The latest record's time. */
  readonly lastAt: string;
}

export interface UsagePage {
  readonly data: readonly UsageGroup[];
  /**
   * Every record at or before this time is in the answer; a later one may
   * not be yet. A reader re-reads a window until its watermark is past the
   * window's end. Every page of one read carries the same watermark: its
   * cursor holds it.
   */
  readonly watermark: string;
  /** More groups: pass it as `cursor`. Absent on the last page. */
  readonly nextCursor?: string;
}

export type UsageReadResult =
  | { readonly kind: 'ok'; readonly page: UsagePage }
  | { readonly kind: 'cursor-unreadable' };

/**
 * Usage, aggregated: counts, sums and first and last times, never a
 * record's content. A runtime reads each tenant inside that tenant's own
 * row-level security.
 */
export interface UsageBinding {
  /**
   * The operator's read across tenants (`GET /v1/system/usage`). It leaves
   * out a test tenant and one whose setup is pending, even when
   * `tenantId` names one: their usage is never billed.
   */
  acrossTenants(query: SystemUsageQuery): Promise<UsageReadResult>;
  /** One tenant's own usage (`GET /v1/usage`), as its members read it. */
  ofTenant(tenantId: TenantId, query: UsageQuery): Promise<UsageReadResult>;
}

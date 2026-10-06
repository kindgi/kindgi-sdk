// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/agents';
import type { Scope } from '@kindgi/platform';
import type { Cursor, FlowId, ProjectId, RunId, Semver, TenantId, Timestamp } from '@kindgi/types';

import type { EvalKind } from './eval-suite-binding.js';

/**
 * Caller-plugged surface for the evaluation-run data plane — the
 * companion to the eval-suite registry that closes the loop by adding
 * *execution*.
 * Same pattern as every other admin binding: the API package does NOT
 * own persistence. Deployments wire this binding to a runtime that
 * dispatches per `EvalSuite.kind` (see `eval-run-dispatcher.ts` for
 * the reference accuracy dispatcher).
 *
 * The wire shape mirrors the run surface. A durable implementation can
 * make every `EvalRun` a specialized run (started with `runGraph`),
 * inheriting durability, replay, and cancel semantics while adding
 * eval-specific fields (`suiteId`, `suiteVersion`, `kind`, `result`);
 * the in-process reference in `eval-run-dispatcher.ts` keeps runs in
 * memory.
 *
 * `result` is kind-specific opaque JSON on the wire. For the
 * `accuracy` reference dispatcher it is
 * `{ passCount, totalCount, meanScore, perCase[] }`; other kinds define
 * their own shapes.
 */
export interface EvalRunBinding {
  /**
   * Start a new eval run against a specific suite id (the dispatcher
   * resolves the suite version internally — bindings MAY reject with
   * `suite-not-found` when the suiteId is unknown for the tenant).
   */
  start(input: EvalRunStartInput): Promise<EvalRunStartOutcome>;
  /**
   * Fetch a single eval run by id, or `null` if unknown. The route
   * surfaces `null` as `404 eval-run-not-found`.
   */
  get(input: EvalRunGetInput): Promise<EvalRun | null>;
  /**
   * Cursor-paginated list of eval runs. Optional filters — see
   * `EvalRunFilter`. Sort order is fixed: `startedAt` descending, id
   * descending as tie-breaker (same shape as `/v1/runs`).
   */
  list(input: EvalRunListInput): Promise<EvalRunPage>;
  /**
   * Cancel an eval run. Returns `{ cancelled: true }` on success;
   * `{ cancelled: false, reason: 'not-found' | 'already-terminal' }`
   * otherwise — the route flips each `reason` to the appropriate
   * 4xx status.
   */
  cancel(input: EvalRunCancelInput): Promise<EvalRunCancelOutcome>;
}

/**
 * How the caller identifies the eval subject on `start`. Exactly one
 * of `agentRef` / `flowRef` MUST be supplied — the route enforces
 * that mutual exclusion before calling the binding.
 */
export interface AgentRef {
  readonly agentId: AgentId;
  readonly version?: Semver;
}
export interface FlowRef {
  readonly flowId: FlowId;
  readonly version?: Semver;
}

/**
 * Terminal statuses match the run vocabulary. `pending` is a
 * pre-execution state a dispatcher MAY use if it queues the run
 * before starting it; the reference in-process dispatcher goes
 * straight to `running`.
 */
export const EVAL_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

/**
 * Wire shape for a single evaluation run. `result` is kind-specific
 * opaque JSON (accuracy writes `{ passCount, totalCount, meanScore,
 * perCase[] }`; other kinds define their own shapes). `error`
 * carries the failure message when `status === 'failed'`.
 */
export interface EvalRun {
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly kind: EvalKind;
  readonly agentRef?: AgentRef;
  readonly flowRef?: FlowRef;
  readonly status: EvalRunStatus;
  readonly dryRun: boolean;
  readonly startedAt: Timestamp;
  readonly completedAt?: Timestamp;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  readonly correlationId?: string;
  /** A comparison eval run's baseline, reads and repetitions. */
  readonly comparison?: EvalComparison;
}

export interface EvalRunFilter {
  readonly suiteId?: string;
  readonly status?: EvalRunStatus;
  readonly agentId?: AgentId;
  readonly flowId?: FlowId;
  readonly from?: Timestamp;
  readonly to?: Timestamp;
}

/**
 * What a comparison eval run compares the candidate against:
 *   - `'recorded'`: the output each case recorded (what was judged);
 *   - `{ agentId, version }`: that version, replayed under the same rules;
 *   - `{ live }`: the version live in a scope (a project, segments).
 */
export type EvalBaseline =
  | 'recorded'
  | { readonly agentId: AgentId; readonly version: Semver }
  | {
      readonly live: {
        readonly projectId?: ProjectId;
        readonly segments?: Readonly<Record<string, string>>;
      };
    };

/** Whether replayed reads use the past run's results when it has them, or run live. */
export type EvalReads = 'recorded' | 'live';

/** How a comparison eval run runs its cases (absent: the run isn't a comparison). */
export interface EvalComparison {
  readonly baseline: EvalBaseline;
  readonly reads: EvalReads;
  /** How many times each case runs (1–10); with more than 1, the summary shows the spread. */
  readonly repetitions: number;
  /** How many ranked items `weightedPrecisionAtK` looks at (1–100). */
  readonly k: number;
}

export interface EvalRunStartInput {
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor. REQUIRED — every
   * eval-run row is anchored to a project. The caller resolves this at
   * ITS layer; storage adapters treat a missing / bogus id as a
   * `project-not-found` outcome. No silent fallback to a tenant Default here.
   */
  readonly projectId: ProjectId;
  readonly suiteId: string;
  readonly agentRef?: AgentRef;
  readonly flowRef?: FlowRef;
  readonly dryRun?: boolean;
  readonly correlationId?: string;
  /** Set for a comparison eval run (a `judged` suite): its baseline, reads and repetitions. */
  readonly comparison?: EvalComparison;
}

/**
 * `start` outcomes. `ok` returns the newly-minted `runId`; other
 * shapes carry the domain error the route flips to a 4xx.
 */
export type EvalRunStartOutcome =
  | {
      readonly kind: 'ok';
      readonly runId: RunId;
      readonly dryRunPreview?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'suite-not-found'; readonly suiteId: string }
  | { readonly kind: 'dispatcher-not-registered'; readonly evalKind: EvalKind }
  | { readonly kind: 'dispatcher-input-invalid'; readonly message: string }
  | {
      /**
       * The caller-supplied `projectId` does not resolve to a real
       * project row in this tenant. Distinct from
       * `dispatcher-input-invalid` so the route can surface a clean
       * 4xx with the offending id rather than a generic dispatcher
       * error.
       */
      readonly kind: 'project-not-found';
      readonly projectId: ProjectId;
    };

export interface EvalRunGetInput {
  readonly tenantId: TenantId;
  readonly runId: RunId;
}

export interface EvalRunListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly filter?: EvalRunFilter;
  /**
   * Narrow the list to a specific scope. Absent = no scope narrow
   * (return every row in the tenant the caller can see — admin/audit
   * default).
   *
   * Content-scoped semantics (this binding):
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
   * uniformity: scope-aware bindings share one filter shape across the
   * SDK and OpenAPI schemas.
   */
  readonly inherit?: boolean;
}

export interface EvalRunPage {
  readonly data: readonly EvalRun[];
  readonly nextCursor?: Cursor;
}

export interface EvalRunCancelInput {
  readonly tenantId: TenantId;
  readonly runId: RunId;
}

export type EvalRunCancelOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'already-terminal'; readonly status: EvalRunStatus };

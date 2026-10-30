// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/agents';
import type { FlowVersionOverrides } from '@kindgi/flow';
import type { Scope } from '@kindgi/platform';
import type {
  Cursor,
  FlowId,
  ProjectId,
  RunId,
  ScopeSegment,
  Semver,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import type { EvalKind } from './test-set-binding.js';

/**
 * Caller-plugged surface for the evaluation-run data plane — the
 * companion to the test-set registry that closes the loop by adding
 * *execution*.
 * Same pattern as every other admin binding: the API package does NOT
 * own persistence. Deployments wire this binding to a runtime that
 * dispatches per `TestSet.kind` (see `test-run-dispatcher.ts` for
 * the reference accuracy dispatcher).
 *
 * The wire shape mirrors the run surface. A durable implementation can
 * make every `TestRun` a specialized run (started with `runGraph`),
 * inheriting durability, replay, and cancel semantics while adding
 * eval-specific fields (`testSetId`, `testSetVersion`, `kind`, `result`);
 * the in-process reference in `test-run-dispatcher.ts` keeps runs in
 * memory.
 *
 * `result` is kind-specific opaque JSON on the wire. For the
 * `accuracy` reference dispatcher it is
 * `{ passCount, totalCount, meanScore, perCase[] }`; other kinds define
 * their own shapes.
 */
export interface TestRunBinding {
  /**
   * Start a new test run against a specific test set id (the dispatcher
   * resolves the test set version internally — bindings MAY reject with
   * `test-set-not-found` when the testSetId is unknown for the tenant).
   */
  start(input: TestRunStartInput): Promise<TestRunStartOutcome>;
  /**
   * Fetch a single test run by id, or `null` if unknown. The route
   * surfaces `null` as `404 test-run-not-found`.
   */
  get(input: TestRunGetInput): Promise<TestRun | null>;
  /**
   * Cursor-paginated list of test runs. Optional filters — see
   * `TestRunFilter`. Sort order is fixed: `startedAt` descending, id
   * descending as tie-breaker (same shape as `/v1/runs`).
   */
  list(input: TestRunListInput): Promise<TestRunPage>;
  /**
   * Cancel a test run. Returns `{ cancelled: true }` on success;
   * `{ cancelled: false, reason: 'not-found' | 'already-terminal' }`
   * otherwise — the route flips each `reason` to the appropriate
   * 4xx status.
   */
  cancel(input: TestRunCancelInput): Promise<TestRunCancelOutcome>;
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
export const TEST_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

/**
 * Wire shape for a single evaluation run. `result` is kind-specific
 * opaque JSON (accuracy writes `{ passCount, totalCount, meanScore,
 * perCase[] }`; other kinds define their own shapes). `error`
 * carries the failure message when `status === 'failed'`.
 */
export interface TestRun {
  readonly testRunId: RunId;
  readonly tenantId: TenantId;
  readonly testSetId: string;
  readonly testSetVersion: string;
  readonly kind: EvalKind;
  readonly agentRef?: AgentRef;
  readonly flowRef?: FlowRef;
  readonly status: TestRunStatus;
  readonly dryRun: boolean;
  readonly startedAt: Timestamp;
  readonly completedAt?: Timestamp;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  /**
   * Why a `cancelled` run stopped when nobody cancelled it: its project or
   * tenant took no new runs when a case started (`project-suspended`,
   * `tenant-suspended`, `tenant-closing`). Absent when it was cancelled,
   * and from a runtime that doesn't say.
   */
  readonly cancelReason?: string;
  readonly correlationId?: string;
  /** A comparison test run's baseline, reads and repetitions. */
  readonly comparison?: EvalComparison;
  /** The project the run belongs to. Absent from a runtime that doesn't say. */
  readonly projectId?: ProjectId;
}

export interface TestRunFilter {
  readonly testSetId?: string;
  readonly status?: TestRunStatus;
  readonly agentId?: AgentId;
  readonly flowId?: FlowId;
  readonly from?: Timestamp;
  readonly to?: Timestamp;
}

/**
 * What a comparison test run compares the candidate against:
 *   - `'recorded'`: the output each case recorded (what was corrected);
 *   - `{ agentId, version }`: that version, replayed under the same rules;
 *   - `{ pinned }`: the version pinned in a scope: a project, and a segment
 *     path in it (coarse to fine, as pinned versions resolve it).
 */
export type EvalBaseline =
  | 'recorded'
  | { readonly agentId: AgentId; readonly version: Semver }
  | {
      readonly pinned: {
        readonly projectId?: ProjectId;
        /** A segment path in `projectId`, coarse to fine. */
        readonly segments?: readonly ScopeSegment[];
      };
    };

/** Whether replayed reads use the past run's results when it has them, or run live. */
export type EvalReads = 'recorded' | 'live';

/**
 * Which corrections a comparison counts: every correction at its group's
 * weight (`as-recorded`, the default), or only those recorded while their
 * group was restricted (`assertableBy`), the others weighing 0
 * (`experts-only`; T200).
 */
export type EvalGroupWeights = 'as-recorded' | 'experts-only';

/** How a comparison test run runs its cases (absent: the run isn't a comparison). */
export interface EvalComparison {
  readonly baseline: EvalBaseline;
  readonly reads: EvalReads;
  /** How many times each case runs (1–10); with more than 1, the summary shows the spread. */
  readonly repetitions: number;
  /** How many ranked items `weightedPrecisionAtK` looks at (1–100). */
  readonly k: number;
  /**
   * For a flow candidate: agents and tools its replays run at other exact
   * versions than the flow version's pins ("this flow, with `acme.scorer`
   * at 0.4.0"), without publishing a new flow version.
   */
  readonly versions?: FlowVersionOverrides;
  /** Which corrections count (absent: `as-recorded`). */
  readonly groupWeights?: EvalGroupWeights;
  /**
   * For an agent candidate: block content its replays run instead of the
   * version's pinned content (settings values, a prompt template: an
   * Improve run's search). A comparison with overrides can't gate a
   * promotion: it didn't run a published version.
   */
  readonly overrides?: EvalOverrides;
  /** Only part of the test set's cases (absent: all of them). */
  readonly sample?: EvalSample;
  /**
   * Rescore that comparison test run instead of replaying: its replays'
   * outputs are scored again, with the corrections recorded on them since
   * (a changed answer corrected on the replay itself). Nothing runs; the run
   * rescored stays as it was. Same test set version, candidate and sample.
   */
  readonly rescoreOf?: string;
}

/** Block content that replaces a version's pinned content: settings values and prompt templates, by block id. */
export interface EvalOverrides {
  readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly prompts?: Readonly<Record<string, { readonly template: string }>>;
}

/**
 * Part of a test set: its cases split once into a hold-out part (about
 * `holdOutShare` of them) and a search part (the rest), stratified (the
 * cases that carry a correction, then of the others the cases with a
 * "no" and the rest, each split on their own), in the order of a hash of
 * each case id and `seed`. The same seed splits
 * the same test set the same way, so an Improve run searches on one
 * part and proves its candidate on the other. A promotion gate refuses a
 * comparison on the search part.
 */
export interface EvalSample {
  readonly part: 'search' | 'hold-out';
  readonly seed: string;
  /** 0.1 to 0.9. */
  readonly holdOutShare: number;
}

export interface TestRunStartInput {
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor. REQUIRED — every
   * test-run row is anchored to a project. The caller resolves this at
   * ITS layer; storage adapters treat a missing / bogus id as a
   * `project-not-found` outcome. No silent fallback to a tenant Default here.
   */
  readonly projectId: ProjectId;
  readonly testSetId: string;
  /**
   * The test set version to run (absent: the latest). A rescore names the
   * version the run it rescores ran, so the cases are the same. In a
   * tenant with environment orders, a run reaches the versions made in
   * its project or an earlier environment of its order: absent, the
   * latest of those; a named version made in a later environment reads
   * as one the tenant doesn't have (`test-set-not-found`).
   */
  readonly testSetVersion?: string;
  readonly agentRef?: AgentRef;
  readonly flowRef?: FlowRef;
  readonly dryRun?: boolean;
  readonly correlationId?: string;
  /** Set for a comparison test run (a `corrections` test set): its baseline, reads and repetitions. */
  readonly comparison?: EvalComparison;
}

/**
 * `start` outcomes. `ok` returns the newly-minted `testRunId`; other
 * shapes carry the domain error the route flips to a 4xx.
 */
export type TestRunStartOutcome =
  | {
      readonly kind: 'ok';
      readonly testRunId: RunId;
      readonly dryRunPreview?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'test-set-not-found'; readonly testSetId: string }
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

export interface TestRunGetInput {
  readonly tenantId: TenantId;
  readonly testRunId: RunId;
}

export interface TestRunListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly filter?: TestRunFilter;
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

export interface TestRunPage {
  readonly data: readonly TestRun[];
  readonly nextCursor?: Cursor;
}

export interface TestRunCancelInput {
  readonly tenantId: TenantId;
  readonly testRunId: RunId;
}

export type TestRunCancelOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'already-terminal'; readonly status: TestRunStatus };

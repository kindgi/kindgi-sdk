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
  /** The project the run belongs to. Absent from a runtime that doesn't say. */
  readonly projectId?: ProjectId;
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
 *   - `{ live }`: the version live in a scope: a project, and a segment
 *     path in it (coarse to fine, as live versions resolve it).
 */
export type EvalBaseline =
  | 'recorded'
  | { readonly agentId: AgentId; readonly version: Semver }
  | {
      readonly live: {
        readonly projectId?: ProjectId;
        /** A segment path in `projectId`, coarse to fine. */
        readonly segments?: readonly ScopeSegment[];
      };
    };

/** Whether replayed reads use the past run's results when it has them, or run live. */
export type EvalReads = 'recorded' | 'live';

/**
 * Which judgments a comparison counts: every judgment at its class's
 * weight (`as-recorded`, the default), or only those recorded while their
 * class was restricted (`assertableBy`), the others weighing 0
 * (`restricted-only`; T200).
 */
export type EvalClassWeights = 'as-recorded' | 'restricted-only';

/** How a comparison eval run runs its cases (absent: the run isn't a comparison). */
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
  /** Which judgments count (absent: `as-recorded`). */
  readonly classWeights?: EvalClassWeights;
  /**
   * For an agent candidate: block content its replays run instead of the
   * version's pinned content (settings values, a prompt template: an
   * improvement pass's search). A comparison with overrides can't gate a
   * promotion: it didn't run a published version.
   */
  readonly overrides?: EvalOverrides;
  /** Only part of the test set's cases (absent: all of them). */
  readonly sample?: EvalSample;
  /**
   * Rescore that comparison eval run instead of replaying: its replays'
   * outputs are scored again, with the judgments recorded on them since
   * (a changed answer judged on the replay itself). Nothing runs; the run
   * rescored stays as it was. Same suite version, candidate and sample.
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
 * `holdOutShare` of them) and a search part (the rest), stratified by
 * judgment (the cases with a "no" and the others split on their own), in
 * the order of a hash of each case id and `seed`. The same seed splits
 * the same test set the same way, so an improvement pass searches on one
 * part and proves its candidate on the other. A promotion gate refuses a
 * comparison on the search part.
 */
export interface EvalSample {
  readonly part: 'search' | 'hold-out';
  readonly seed: string;
  /** 0.1 to 0.9. */
  readonly holdOutShare: number;
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
  /**
   * The suite version to run (absent: the latest). A rescore names the
   * version the run it rescores ran, so the cases are the same.
   */
  readonly suiteVersion?: string;
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

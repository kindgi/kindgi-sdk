// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TupleEnqueueHook } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the evaluation-harness suite catalog —
 * part of the admin control plane. Registry-only: publish + read; run
 * execution + per-kind grader dispatch are out of scope (see
 * `EvalRunBinding`). Graders — an eval-judge adapter, the HITL bridge,
 * a sandboxed handler — consume suite definitions from this store at
 * their own boundary.
 *
 * Mirrors `PolicyRegistryBinding` 1:1 — same versioned-CRUD shape,
 * same tenant-scoped inputs, same opaque cursors, same "unregister a
 * specific version" semantics.
 *
 * The wire shape is intentionally kind-neutral: `evalKind` selects the
 * shape of `spec`. The route validates the closed set of `kind` values
 * and the required top-level fields; deeper `spec` shape is the runtime
 * consumer's responsibility (each kind's grader knows its own contract).
 *
 * Cursors are opaque — the binding chooses its encoding (index-based,
 * `id@version`, ISO timestamps). The API layer only validates that a
 * cursor round-trips as a string; it never inspects the payload.
 */
export interface EvalSuiteRegistryBinding {
  /**
   * Cursor-paginated list of eval suites (latest version per id, sorted
   * by suite id ascending). Optional filters:
   * - `evalKind` narrows to suites of a single kind (exact match).
   * - `nameFilter` is a prefix match on the suite id — dotted
   *   namespaces are the natural filter shape (`acme.accuracy`).
   */
  list(input: EvalSuiteListInput): Promise<EvalSuitePage>;
  /**
   * Latest version of the given suite id, or `null` if unknown. The
   * route surfaces `null` as `404 eval-suite-not-found`.
   */
  get(input: EvalSuiteGetInput): Promise<EvalSuite | null>;
  /**
   * Specific `(suiteId, version)` lookup, or `null` if unknown.
   * Returns tombstoned versions too (provenance paths).
   */
  getVersion(input: EvalSuiteGetVersionInput): Promise<EvalSuite | null>;
  /**
   * Head-row existence probe. Lets GET distinguish 410 gone from
   * 404 not-found.
   */
  headExists(input: EvalSuiteGetInput): Promise<boolean>;
  /**
   * Cursor-paginated list of versions for a specific suite id. Sort
   * order is binding-defined (for example ascending semver). Returns an empty page (no error) when the id
   * is unknown — the route flips that to `404` via a prior `get`.
   */
  listVersions(input: EvalSuiteListVersionsInput): Promise<EvalSuitePage>;
  /**
   * Publish a validated eval-suite definition. The API route validates
   * the wire shape (id / tenantId / semver version / kind / spec object)
   * before calling — the binding receives a well-formed `EvalSuite`.
   * Bindings MAY reject with `already-registered` when the same
   * `(suiteId, version)` is re-published; the route maps that to `409`.
   */
  publish(input: EvalSuitePublishInput): Promise<EvalSuitePublishOutcome>;
  /**
   * Soft-tombstone a specific `(suiteId, version)`. When this leaves
   * NO active versions, the suite has no latest version — derived
   * "retired" state (GET returns 410 gone). Publish reactivates.
   */
  unregister(input: EvalSuiteUnregisterInput): Promise<EvalSuiteUnregisterOutcome>;
  /**
   * Un-tombstone a specific `(suiteId, version)`. Recomputes the
   * suite's latest version. Restores bytes verbatim (semver hygiene).
   * Idempotent.
   */
  reinstateVersion(
    input: EvalSuiteReinstateVersionInput,
  ): Promise<EvalSuiteReinstateVersionOutcome>;
}

/**
 * Closed set of eval kinds the framework knows about. Extended
 * additively — new kinds require a spec + validator update in tandem so
 * the registry never accepts a kind no runtime consumer honors.
 *
 * - `accuracy` — metric-based grading against ground truth (input →
 *   expectedOutput pairs; grader is an eval-judge adapter).
 * - `pairwise` — A/B comparisons between two agent/flow versions.
 * - `regression` — compare against a stored baseline run.
 * - `human-review` — delegates rubric grading to HITL reviewers.
 * - `benchmark` — reference to a standardized suite (name + version).
 * - `custom` — caller-supplied evaluator handler.
 */
export const EVAL_KINDS = [
  'accuracy',
  'pairwise',
  'regression',
  'human-review',
  'benchmark',
  'custom',
  /** Built from judgments of past runs: cases are copies of judged runs (`EvalCaseStoreBinding`). */
  'judged',
] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

/**
 * Wire shape for a single evaluation suite. `spec` is a JSON object
 * whose shape is dictated by `kind` — the registry treats it as opaque
 * JSON so new kinds can extend the catalog without touching this file.
 * Runtime consumers (the eval-judge adapter for `accuracy` / `pairwise`
 * / `regression`, the HITL bridge for `human-review`, the sandbox
 * handler for `custom`) deserialize `spec` against their own contract.
 *
 * Case data lives IN `spec` (not stored separately) — small enough at
 * registry scale.
 */
export interface EvalSuite {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly version: string;
  readonly kind: EvalKind;
  readonly description?: string;
  readonly spec: Readonly<Record<string, unknown>>;
}

export interface EvalSuiteListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Exact match on `EvalSuite.kind`. Undefined = no filter. */
  readonly evalKind?: EvalKind;
  /** Prefix match on `EvalSuite.id`. Undefined = no filter. */
  readonly nameFilter?: string;
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

export interface EvalSuiteGetInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
}

export interface EvalSuiteGetVersionInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly version: string;
}

export interface EvalSuiteListVersionsInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface EvalSuitePublishInput {
  readonly tenantId: TenantId;
  /**
   * Project the eval suite is published into. REQUIRED. Callers that
   * don't naturally know a projectId
   * resolve the tenant's Default via
   * `projectBinding.getDefault(tenantId)` at THEIR layer and thread
   * the resolved id here — the storage adapter never silently falls
   * back to Default.
   */
  readonly projectId: ProjectId;
  readonly suite: EvalSuite;
  /**
   * REQUIRED. Called inside the binding's write tx after row insert,
   * receiving the business `suiteId`. Returns tuples for the same tx.
   * See `AgentPublishInput.enqueueTuples` for the design rationale.
   */
  readonly enqueueTuples: TupleEnqueueHook;
}

export interface EvalSuiteUnregisterInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly version: string;
}

export interface EvalSuiteReinstateVersionInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly version: string;
}

export interface EvalSuitePage {
  readonly data: readonly EvalSuite[];
  readonly nextCursor?: Cursor;
}

export type EvalSuitePublishOutcome =
  | {
      readonly kind: 'ok';
      readonly suiteId: string;
      readonly version: string;
    }
  | {
      readonly kind: 'already-registered';
      readonly suiteId: string;
      readonly version: string;
    }
  | {
      /**
       * The caller-supplied `projectId` does not resolve to a real
       * project row in this tenant. Distinct from
       * `already-registered` so the route + deployment loop can
       * surface a clean `400 bad-input` (per the route's error
       * contract) rather than the misleading `already-registered`
       * fallback. Implementations detect a missing project at publish
       * time (a SQL store typically from its foreign-key violation).
       */
      readonly kind: 'project-not-found';
      readonly suiteId: string;
      readonly version: string;
      readonly projectId: ProjectId;
    };

export type EvalSuiteUnregisterOutcome = {
  readonly unregistered: boolean;
};

export type EvalSuiteReinstateVersionOutcome =
  | {
      readonly kind: 'ok';
      readonly suiteId: string;
      readonly version: string;
      readonly wasTombstoned: boolean;
    }
  | {
      readonly kind: 'not-found';
      readonly suiteId: string;
      readonly version: string;
    };

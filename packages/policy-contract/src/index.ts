// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the tenant-policy catalog, part of the
 * admin control plane. Registry-only: publish +
 * read; enforcement is out of scope. Every runtime consumer of a policy
 * (for example the capability router for `model-routing`) reads it from
 * this store and applies it at its own boundary.
 *
 * Mirrors `AgentRegistryBinding` / `FlowRegistryBinding` (both in
 * `@kindgi/api`) 1:1 — same
 * versioned-CRUD shape, same tenant-scoped inputs, same opaque cursors,
 * same "unregister a specific version" semantics.
 *
 * The wire shape is intentionally kind-neutral: `policyKind` selects the
 * shape of `spec`. The `@kindgi/api` policies route validates the closed
 * set of `kind` values and the required top-level fields; deeper `spec`
 * shape is the runtime consumer's responsibility (they know the
 * semantics for their kind).
 *
 * Cursors are opaque — the binding chooses its encoding (index-based,
 * `id@version`, ISO timestamps). The API layer only validates that a
 * cursor round-trips as a string; it never inspects the payload.
 */
export interface PolicyRegistryBinding {
  /**
   * Cursor-paginated list of policies (latest version per id, sorted by
   * policy id ascending). Optional filters:
   * - `policyKind` narrows to policies of a single kind (exact match).
   * - `nameFilter` is a prefix match on the policy id — dotted
   *   namespaces are the natural filter shape (`acme.model-routing`).
   */
  list(input: PolicyListInput): Promise<PolicyPage>;
  /**
   * Latest active version of the given policy id, or `null` when there
   * is none. The route surfaces `null` as `410 policy-gone` when
   * `headExists` is true, otherwise as `404 policy-not-found`.
   */
  get(input: PolicyGetInput): Promise<Policy | null>;
  /**
   * Specific `(policyId, version)` lookup, or `null` if unknown.
   * Returns tombstoned versions too (provenance paths).
   */
  getVersion(input: PolicyGetVersionInput): Promise<Policy | null>;
  /**
   * Identity existence probe: `true` once the policy id has been
   * published, even when every version is tombstoned. Lets GET
   * distinguish 410 gone (identity exists, no active version) from
   * 404 not-found.
   */
  headExists(input: PolicyGetInput): Promise<boolean>;
  /**
   * Cursor-paginated list of versions for a specific policy id. Sort
   * order is binding-defined. Returns an empty page (no error) when the
   * id is unknown — the route turns that into `404` by calling
   * `headExists` first.
   *
   * By default returns active versions only. Set
   * `includeTombstoned = true` to include soft-tombstoned rows too;
   * tombstoned rows carry `unregisteredAt` on the wire (ISO string),
   * active rows do not.
   */
  listVersions(input: PolicyListVersionsInput): Promise<PolicyVersionPage>;
  /**
   * Publish a validated policy definition. The API route validates the
   * wire shape (id / tenantId / semver version / kind / spec object)
   * before calling — the binding receives a well-formed `Policy`.
   * Bindings MAY reject with `already-registered` when the same
   * `(policyId, version)` is re-published; the route maps that to `409`.
   */
  publish(input: PolicyPublishInput): Promise<PolicyPublishOutcome>;
  /**
   * Soft-tombstone a specific `(policyId, version)`. When this leaves
   * NO active versions, the policy has no latest version — it enters the
   * derived "retired" state (GET returns 410 gone). Publish reactivates.
   */
  unregister(input: PolicyUnregisterInput): Promise<PolicyUnregisterOutcome>;
  /**
   * Un-tombstone a specific `(policyId, version)`. Recomputes the
   * policy's latest version. Restores the stored definition unchanged
   * (a published version never changes content). Idempotent.
   */
  reinstateVersion(input: PolicyReinstateVersionInput): Promise<PolicyReinstateVersionOutcome>;
}

/**
 * Closed set of policy kinds the framework knows about. Extended
 * additively — new kinds require a spec + validator update in tandem so
 * the registry never accepts a kind no runtime consumer honors.
 *
 * - `access-control` — principal × resource × action allow / deny
 *   rules.
 * - `model-routing` — the tenant routing policy (`TenantPolicy`) that
 *   `route` in `@kindgi/capabilities` applies: provider / model allow
 *   and deny lists, `regionAllow`, per-call cost and token caps.
 * - `adapter-allowlist` — narrows the adapters a tenant can see at the
 *   `/v1/adapters/*` surface.
 * - `rate-limit` — per-tenant, per-key rate caps for a rate-limit
 *   middleware.
 * - `retention` — how long tombstoned rows are kept before hard purge,
 *   per domain (see `RetentionSpec`).
 * - `compliance` — audit / evidence retention + export policies.
 * - `tool-errors` — caps how an agent turn retries failed tool calls
 *   (see `ToolErrorsSpec`): the fewer retries, and only kinds both the
 *   agent and the policy allow.
 * - `hitl` — the human-in-the-loop approval rules every agent is held
 *   to (see `HitlSpec`): the shorter timeout, the higher reviewer role,
 *   and per tool the stricter gate.
 */
export const POLICY_KINDS = [
  'access-control',
  'model-routing',
  'adapter-allowlist',
  'rate-limit',
  'retention',
  'compliance',
  'tool-errors',
  'hitl',
] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/**
 * The policy kinds a runtime consumer applies today: publishing one of
 * these changes what runs. The others (`access-control`,
 * `adapter-allowlist`, `rate-limit`, `compliance`) are known kinds with
 * no consumer yet, so the API refuses to publish them
 * (`kind-not-applied`) until one exists: a policy that silently changes
 * nothing is worse than none. Policies of those kinds already stored stay
 * readable.
 */
export const APPLIED_POLICY_KINDS = [
  'model-routing',
  'retention',
  'tool-errors',
  'hitl',
] as const satisfies readonly PolicyKind[];
export type AppliedPolicyKind = (typeof APPLIED_POLICY_KINDS)[number];

/** Whether a runtime consumer applies `kind` (see `APPLIED_POLICY_KINDS`). */
export function isAppliedPolicyKind(kind: PolicyKind): kind is AppliedPolicyKind {
  return (APPLIED_POLICY_KINDS as readonly PolicyKind[]).includes(kind);
}

/**
 * Wire shape for a single tenant policy. `spec` is a JSON object whose
 * shape is dictated by `kind` — the registry treats it as opaque JSON
 * so new kinds can extend the catalog without touching this file.
 * Runtime consumers deserialize `spec` against their own contract.
 */
export interface Policy {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly version: string;
  readonly kind: PolicyKind;
  readonly description?: string;
  readonly spec: Readonly<Record<string, unknown>>;
}

export interface PolicyListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Exact match on `Policy.kind`. Undefined = no filter. */
  readonly policyKind?: PolicyKind;
  /** Prefix match on `Policy.id`. Undefined = no filter. */
  readonly nameFilter?: string;
}

export interface PolicyGetInput {
  readonly tenantId: TenantId;
  readonly policyId: string;
}

export interface PolicyGetVersionInput {
  readonly tenantId: TenantId;
  readonly policyId: string;
  readonly version: string;
}

export interface PolicyListVersionsInput {
  readonly tenantId: TenantId;
  readonly policyId: string;
  readonly limit: number;
  readonly cursor?: Cursor;
  /**
   * `false` (default) → return only active versions, which is what
   * policy executors consume. `true` → return active + tombstoned rows;
   * tombstoned entries carry `unregisteredAt` on the wire.
   */
  readonly includeTombstoned?: boolean;
}

export interface PolicyPublishInput {
  readonly tenantId: TenantId;
  readonly policy: Policy;
}

export interface PolicyUnregisterInput {
  readonly tenantId: TenantId;
  readonly policyId: string;
  readonly version: string;
}

export interface PolicyReinstateVersionInput {
  readonly tenantId: TenantId;
  readonly policyId: string;
  readonly version: string;
}

export interface PolicyPage {
  readonly data: readonly Policy[];
  readonly nextCursor?: Cursor;
}

/**
 * A single row in a `listVersions` result. Policy fields plus an
 * optional `unregisteredAt` timestamp — present iff the version has
 * been soft-tombstoned via `unregister`. Callers that ignore the
 * extra field see the same shape as `Policy`.
 */
export type PolicyVersionRow = Policy & {
  readonly unregisteredAt?: string;
};

export interface PolicyVersionPage {
  readonly data: readonly PolicyVersionRow[];
  readonly nextCursor?: Cursor;
}

export type PolicyPublishOutcome =
  | {
      readonly kind: 'ok';
      readonly policyId: string;
      readonly version: string;
    }
  | {
      readonly kind: 'already-registered';
      readonly policyId: string;
      readonly version: string;
    };

export type PolicyUnregisterOutcome = {
  readonly unregistered: boolean;
};

export type PolicyReinstateVersionOutcome =
  | {
      readonly kind: 'ok';
      readonly policyId: string;
      readonly version: string;
      readonly wasTombstoned: boolean;
    }
  | {
      readonly kind: 'not-found';
      readonly policyId: string;
      readonly version: string;
    };

export { RETENTION_DOMAINS, validateRetentionSpec } from './retention-spec.js';
export {
  MAX_TOOL_ERROR_RETRIES,
  TOOL_ERROR_KINDS,
  validateToolErrorsSpec,
} from './tool-errors-spec.js';
export type { ToolErrorKind, ToolErrorsSpec, ToolErrorsSpecIssue } from './tool-errors-spec.js';
export {
  REVIEWER_ROLES,
  TOOL_HITL_MODES,
  combineHitlSpecs,
  higherRole,
  stricterToolHitlRule,
  toolHitlRule,
  validateHitlSpec,
} from './hitl-spec.js';
export type {
  HitlSpec,
  HitlSpecIssue,
  ReviewerRole,
  ToolHitlMode,
  ToolHitlRule,
} from './hitl-spec.js';
export { validatePolicySpec } from './validate-policy-spec.js';
export type { PolicySpecIssue } from './validate-policy-spec.js';
export type {
  RetentionDomain,
  RetentionSpec,
  RetentionSpecValidationError,
} from './retention-spec.js';

// -----------------------------------------------------------------------------
// PolicyExecutor / PolicyRegistry — runtime evaluation interfaces.
//
// Executors bind one PolicyKind to the point where it is enforced (the
// capability router, a retention sweeper, a rate-limit middleware, etc.).
// The registry holds executors keyed by kind. This package declares only
// the interfaces — implementations come from the runtime that hosts the
// enforcement points — so authoring code (e.g. @kindgi/agents) can accept
// a bound PolicyRegistry without depending on any implementation.
// -----------------------------------------------------------------------------

/**
 * Context every executor gets from the enforcement point. Executors
 * add extra context via generics as needed — this is the shared minimum.
 */
export interface PolicyEvalContext {
  readonly tenantId: TenantId;
}

/**
 * Executor for one PolicyKind. `TResult` is the executor-specific
 * decision shape (e.g. `TenantPolicy` for model-routing, `boolean`
 * for adapter-allowlist, per-domain `RetentionSpec`s for retention,
 * etc.). Executors are the ONLY code that knows how to interpret a
 * policy `spec`'s shape for its kind — the registry is opaque.
 *
 * The executor is expected to:
 *   1. Fetch policies of `kind` for the tenant (from the caller-plugged
 *      `PolicyRegistryBinding`, cached however it likes)
 *   2. Merge / reduce them into a single decision shape (intersect
 *      allow lists, union deny lists, min-of caps, etc.)
 *   3. Return the shape for the caller to apply
 */
export interface PolicyExecutor<K extends PolicyKind, TCtx extends PolicyEvalContext, TResult> {
  readonly kind: K;
  evaluate(ctx: TCtx): Promise<TResult>;
}

/**
 * Registry of executors keyed by `PolicyKind`. Callers register one
 * executor per kind they want live; unregistered kinds are inert (the
 * stored policies are read-only blobs until someone binds an executor).
 *
 * The registry does NOT own policy fetch or caching — each executor
 * decides.
 */
export interface PolicyRegistry {
  register<K extends PolicyKind, TCtx extends PolicyEvalContext, TResult>(
    executor: PolicyExecutor<K, TCtx, TResult>,
  ): void;
  /**
   * Evaluate the policy for `kind` in the given context. Returns
   * `undefined` when no executor is bound for `kind` — callers use
   * this to fall back to their pre-policy default behavior.
   */
  evaluate<TCtx extends PolicyEvalContext, TResult>(
    kind: PolicyKind,
    ctx: TCtx,
  ): Promise<TResult | undefined>;
  /**
   * Read-only view of the kinds that currently have an executor.
   * Useful for boot-time diagnostics ("we have 3/6 policy kinds live").
   */
  boundKinds(): readonly PolicyKind[];
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TupleEnqueueHook } from '@kindgi/authz';
import type { CodeArtifactRef, Guardrail } from '@kindgi/guardrails';
import type { Scope } from '@kindgi/platform';
import type { Cursor, GuardrailId, ProjectId, TenantId } from '@kindgi/types';

import type { RegistryReadOnly } from './registry-read-only.js';
import type { RegistryRefreshOutcome } from './tool-binding.js';

/**
 * Caller-plugged surface for the guardrail catalog. Same shape as
 * `AgentRegistryBinding` / `ToolRegistryBinding`: the API package does
 * NOT own registry persistence.
 *
 * The surface is metadata-only: a `Guardrail` references a `check` id
 * whose implementation lives server-side (a pure function in the
 * runtime's `CheckRegistry`). The wire body is a full `Guardrail` shape
 * (id + kind + check-id + action); the actual check implementation must
 * already be registered with the runtime. Check code is not uploaded
 * over this surface.
 *
 * Every method is tenant-scoped: callers pass `tenantId` explicitly so
 * multi-tenant deployments can partition storage without exposing the
 * scoping inside the API package.
 *
 * Cursors are opaque — the binding chooses its encoding. The API layer
 * only validates that a cursor round-trips as a string; it never
 * inspects the payload.
 */
export interface GuardrailRegistryBinding {
  /**
   * Set when this registry takes no writes (under `kindgi dev`, the
   * pack's files are the source of its guardrails): every write is refused
   * with `409 registry-read-only` and this reason, before the binding is
   * called. See `RegistryReadOnly`.
   */
  readonly readOnly?: RegistryReadOnly;
  /**
   * Cursor-paginated list of guardrails sorted by id ascending.
   * Optional `nameFilter` is a prefix match on the guardrail id —
   * guardrails often use dotted namespaces (`acme.no-fabricated-quotes`),
   * so prefix matching is the natural filter shape.
   */
  list(input: GuardrailListInput): Promise<GuardrailPage>;
  /**
   * The guardrail for the given id, or `null` if unknown. The route
   * surfaces `null` as `404 guardrail-not-found`.
   */
  get(input: GuardrailGetInput): Promise<Guardrail | null>;
  /**
   * Register a validated guardrail spec. The API route validates shape
   * via `validateGuardrailSpec(...)` before calling — the binding
   * receives a well-formed `Guardrail`. Bindings MAY reject with
   * `already-registered` when the same id is re-registered; the route
   * maps that to `409`.
   */
  register(input: GuardrailRegisterInput): Promise<GuardrailRegisterOutcome>;
  /**
   * Remove a guardrail by id. Returns `{ unregistered: true }` on
   * success; `{ unregistered: false }` when the id was unknown — the
   * route flips the latter to `404`.
   */
  unregister(input: GuardrailUnregisterInput): Promise<GuardrailUnregisterOutcome>;
  /**
   * Optional. Give a guardrail what a new deploy of the same pack derived
   * for it: where its check's code is now (`codeArtifactRef`) and that
   * check's config schema (`configSchema`). What its author declares
   * doesn't change: a deploy keeps a guardrail only when that's equal.
   * Without it, a kept guardrail keeps what its first deploy derived (the
   * pointer is metadata, as pack code runs by check name; the config
   * schema is what a config is checked against).
   */
  refreshDeployedFields?(input: GuardrailRefreshInput): Promise<RegistryRefreshOutcome>;
}

export interface GuardrailRefreshInput {
  readonly tenantId: TenantId;
  readonly guardrailId: GuardrailId;
  /** Where the check's code is now; `null` for none. */
  readonly codeArtifactRef: CodeArtifactRef | null;
  /** The check's config schema now; `null` for none. */
  readonly configSchema: Readonly<Record<string, unknown>> | null;
}

export interface GuardrailListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Prefix match on `Guardrail.id`. Undefined = no filter. */
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
   * uniformity: scope-aware bindings share one filter shape.
   */
  readonly inherit?: boolean;
}

export interface GuardrailGetInput {
  readonly tenantId: TenantId;
  readonly guardrailId: GuardrailId;
}

export interface GuardrailRegisterInput {
  readonly tenantId: TenantId;
  /**
   * Project the guardrail is registered into. REQUIRED. Callers that
   * don't naturally know a projectId
   * (deployment route) resolve the tenant's Default via
   * `projectBinding.getDefault(tenantId)` at THEIR layer and thread
   * the resolved id here — the storage adapter never silently falls
   * back to Default.
   */
  readonly projectId: ProjectId;
  readonly guardrail: Guardrail;
  /**
   * REQUIRED. Called inside the binding's write tx after row insert,
   * receiving the business `guardrailId`. Returns tuples for the tx.
   * See `AgentPublishInput.enqueueTuples` for the design rationale.
   */
  readonly enqueueTuples: TupleEnqueueHook;
}

export interface GuardrailUnregisterInput {
  readonly tenantId: TenantId;
  readonly guardrailId: GuardrailId;
}

export interface GuardrailPage {
  readonly data: readonly Guardrail[];
  readonly nextCursor?: Cursor;
}

export type GuardrailRegisterOutcome =
  | {
      readonly kind: 'ok';
      readonly guardrailId: GuardrailId;
    }
  | {
      readonly kind: 'already-registered';
      readonly guardrailId: GuardrailId;
    }
  | {
      /**
       * The caller-supplied `projectId` does not resolve to a real
       * project row in this tenant. Distinct from
       * `already-registered` so the route + deployment guardrails-loop
       * can surface a clean `400 bad-input` (per their own error
       * contracts) rather than the misleading `already-registered`
       * fallback. Database-backed implementations typically detect this
       * from the foreign-key violation; in-memory implementations check
       * the project id explicitly at register time.
       */
      readonly kind: 'project-not-found';
      readonly guardrailId: GuardrailId;
      readonly projectId: ProjectId;
    };

export type GuardrailUnregisterOutcome = {
  readonly unregistered: boolean;
};

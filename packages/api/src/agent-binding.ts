// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Agent, AgentId } from '@kindgi/agents';
import type { TupleEnqueueHook } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, ProjectId, Semver, TenantId } from '@kindgi/types';

import type { RegistryReadOnly } from './registry-read-only.js';

/**
 * Caller-plugged surface for the agent catalog. Same shape as
 * `TokenAdmin` / `ReviewerBinding` / `RunHandlerBinding`: the API
 * package does NOT own registry persistence. Deployments wire a
 * runtime `AgentRegistry` (from `@kindgi/agents`) — or a durable
 * pack-backed store — through this binding.
 *
 * Every method is tenant-scoped: callers pass `tenantId` explicitly so
 * multi-tenant deployments can partition storage without exposing the
 * scoping inside the API package.
 *
 * Cursors are opaque — the binding chooses its encoding (index-based,
 * `id@version`, ISO timestamps). The API layer only validates that a
 * cursor round-trips as a string; it never inspects the payload.
 */
export interface AgentRegistryBinding {
  /**
   * Set when this registry takes no writes (under `kindgi dev`, the
   * pack's files are the source of its agents): every write is refused
   * with `409 registry-read-only` and this reason, before the binding is
   * called. See `RegistryReadOnly`.
   */
  readonly readOnly?: RegistryReadOnly;
  /**
   * Cursor-paginated list of agents (latest version per id, sorted by
   * agent id ascending). Optional `nameFilter` is a prefix match on the
   * agent id — the runtime uses dotted namespaces (`acme.*`), so
   * prefix matching is the natural filter shape.
   */
  list(input: AgentListInput): Promise<AgentPage>;
  /**
   * Latest version of the given agent id, or `null` if unknown. The
   * route surfaces `null` as `404 agent-not-found`.
   */
  get(input: AgentGetInput): Promise<Agent | null>;
  /**
   * Specific `(agentId, version)` lookup, or `null` if unknown.
   * Returns unregistered (tombstoned) versions too, unlike `list` /
   * `get` which filter them, with `unregisteredAt` set. Unregister stops
   * a version being *chosen*, not the pins that hold it: a resumed run,
   * provenance, and a flow version that pins it read it, while a new run
   * that names it is refused.
   */
  getVersion(input: AgentGetVersionInput): Promise<AgentVersionRecord | null>;
  /**
   * Head-row existence check. Returns `true` iff the agent id has been
   * registered in the tenant (regardless of whether any versions are
   * active). Lets `GET /v1/agents/{id}` distinguish
   * `410 gone` (identity exists, no active version) from `404 not-
   * found` (never registered) — `.get(...)` returns `null` in both
   * cases.
   */
  headExists(input: AgentGetInput): Promise<boolean>;
  /**
   * Cursor-paginated list of versions for a specific agent id. Sort
   * order is binding-defined; the built-in in-memory registry sorts
   * ascending semver. Returns an empty page (no error) when the id is
   * unknown — the route flips that to `404` via a prior `get`.
   */
  listVersions(input: AgentListVersionsInput): Promise<AgentPage>;
  /**
   * Publish a validated agent definition. The API route validates
   * shape via `defineAgent(...)` before calling — the binding receives
   * a well-formed `Agent`. Bindings MAY reject with `already-registered`
   * when the same `(agentId, version)` is re-published; the route
   * maps that to `409`.
   */
  publish(input: AgentPublishInput): Promise<AgentPublishOutcome>;
  /**
   * Soft-tombstone a specific `(agentId, version)`. Returns
   * `{ unregistered: true }` on success; `{ unregistered: false }`
   * when the version was unknown OR already tombstoned — the route
   * flips the latter to `404`. Head row is preserved; when this
   * unregister leaves NO active versions, the agent has no latest
   * version — it enters the derived "retired" state
   * (GET returns 410 gone) but the identity persists. Publish of a
   * new version reactivates.
   */
  unregister(input: AgentUnregisterInput): Promise<AgentUnregisterOutcome>;
  /**
   * Un-tombstone a specific `(agentId, version)` — clears the
   * version's tombstone and recomputes the agent's latest version
   * across active versions. Restores the version's
   * manifest bytes verbatim (semver hygiene: reinstate never mutates
   * the manifest). Idempotent: reinstating an active version is a
   * no-op. `{ kind: 'not-found' }` when the version was never
   * published.
   */
  reinstateVersion(input: AgentReinstateVersionInput): Promise<AgentReinstateVersionOutcome>;
}

/** An agent version as `getVersion` reads it: `unregisteredAt` is set when it's unregistered. */
export type AgentVersionRecord = Agent & {
  /** ISO-8601; present only on an unregistered version. */
  readonly unregisteredAt?: string;
  /** The project the version belongs to, when the store records it (a derived version is published there). */
  readonly projectId?: ProjectId;
};

export interface AgentListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Prefix match on `Agent.id`. Undefined = no filter. */
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

export interface AgentGetInput {
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
}

export interface AgentGetVersionInput {
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly version: Semver;
}

export interface AgentListVersionsInput {
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface AgentPublishInput {
  readonly tenantId: TenantId;
  /**
   * Project the agent is published into. REQUIRED. Callers that
   * don't naturally know a projectId
   * (e.g. the deployments route) resolve the tenant's Default
   * via `projectBinding.getDefault(tenantId)` at THEIR layer and
   * thread the resolved id here — the storage adapter never
   * silently falls back to Default.
   */
  readonly projectId: ProjectId;
  /**
   * The version to store, as given. When the route pinned it, it
   * carries `pins` and `pinsDigest` (the exact block versions its runs
   * use); a binding stores and returns them with the rest.
   */
  readonly agent: Agent;
  /**
   * REQUIRED. Called inside the binding's write transaction after the
   * head + version rows are inserted, receiving the FGA subject id
   * (the business `agentId`). Returns the
   * `TupleIntent[]` to enqueue in the same tx — typically
   * `tuplesForCreate({kind:'agent', id, tenantId, projectId}, creatorUserId)`.
   *
   * Required, not opt-in: a binding that cannot enqueue tuples must fail
   * loudly rather than silently skip.
   */
  readonly enqueueTuples: TupleEnqueueHook;
}

export interface AgentUnregisterInput {
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly version: Semver;
  // No enqueueTuples hook. `unregister` soft-tombstones a version and
  // recomputes the latest version; the head row is PRESERVED, so the
  // agent identity persists in FGA as a retired entity. A method that
  // fully removed the identity would take an `enqueueTuples` parameter
  // for the `tuplesForDelete(...)` cleanup.
}

export interface AgentReinstateVersionInput {
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly version: Semver;
}

export interface AgentPage {
  readonly data: readonly Agent[];
  readonly nextCursor?: Cursor;
}

export type AgentPublishOutcome =
  | {
      readonly kind: 'ok';
      readonly agentId: AgentId;
      readonly version: Semver;
    }
  | {
      readonly kind: 'already-registered';
      readonly agentId: AgentId;
      readonly version: Semver;
    }
  | {
      /**
       * The caller-supplied `projectId` does not resolve to a real
       * project row in this tenant. Distinct from
       * `already-registered` so callers can surface a clean error (the
       * agents route answers `400 bad-input`) rather than the
       * misleading `already-registered` fallback. Implementations
       * detect a missing project at publish time (a SQL store typically
       * from its foreign-key violation).
       */
      readonly kind: 'project-not-found';
      readonly agentId: AgentId;
      readonly version: Semver;
      readonly projectId: ProjectId;
    };

export type AgentUnregisterOutcome = {
  readonly unregistered: boolean;
};

export type AgentReinstateVersionOutcome =
  | {
      readonly kind: 'ok';
      readonly agentId: AgentId;
      readonly version: Semver;
      /** `false` when the version was already active (idempotent no-op). */
      readonly wasTombstoned: boolean;
    }
  | {
      readonly kind: 'not-found';
      readonly agentId: AgentId;
      readonly version: Semver;
    };

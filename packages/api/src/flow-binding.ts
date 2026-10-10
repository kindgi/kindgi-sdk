// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TupleEnqueueHook } from '@kindgi/authz';
import type { Flow } from '@kindgi/flow';
import type { Scope } from '@kindgi/platform';
import type { Cursor, FlowId, ProjectId, TenantId } from '@kindgi/types';

import type { RegistryReadOnly } from './registry-read-only.js';

/**
 * Caller-plugged surface for the flow catalog. Mirrors
 * `AgentRegistryBinding` 1:1 — the API package does NOT own registry
 * persistence. Deployments wire an in-memory `Map`-backed store — or a
 * durable pack-backed store — through this binding.
 *
 * Publish is data-as-code: the route validates the wire body via
 * `loadFlow(...)` from `@kindgi/flow` before calling; the binding
 * receives a well-formed `Flow`. Handler-as-code uploads (a flow
 * carrying inline node handlers) are not supported.
 *
 * Every method is tenant-scoped: callers pass `tenantId` explicitly so
 * multi-tenant deployments can partition storage without exposing the
 * scoping inside the API package.
 *
 * Cursors are opaque — the binding chooses its encoding (index-based,
 * `id@version`, ISO timestamps). The API layer only validates that a
 * cursor round-trips as a string; it never inspects the payload.
 */
export interface FlowRegistryBinding {
  /**
   * Set when this registry takes no writes (under `kindgi dev`, the
   * pack's files are the source of its flows): every write is refused
   * with `409 registry-read-only` and this reason, before the binding is
   * called. See `RegistryReadOnly`.
   */
  readonly readOnly?: RegistryReadOnly;
  /**
   * Cursor-paginated list of flows (latest version per id, sorted by
   * flow id ascending). Optional `nameFilter` is a prefix match on the
   * flow id — the runtime uses dotted namespaces (`ingest.contract-pdf`),
   * so prefix matching is the natural filter shape.
   */
  list(input: FlowListInput): Promise<FlowPage>;
  /**
   * Latest version of the given flow id, or `null` if unknown. The
   * route surfaces `null` as `404 flow-not-found`.
   */
  get(input: FlowGetInput): Promise<FlowVersionRecord | null>;
  /**
   * Specific `(flowId, version)` lookup, or `null` if unknown. Returns
   * unregistered (tombstoned) versions too, with `unregisteredAt` set:
   * a resumed run and provenance read them, while a new run that names
   * one is refused.
   */
  getVersion(input: FlowGetVersionInput): Promise<FlowVersionRecord | null>;
  /**
   * Head-row existence check. Lets `GET /v1/flows/{id}` distinguish
   * `410 gone` (identity exists, no active version) from `404 not-
   * found` (never registered).
   */
  headExists(input: FlowGetInput): Promise<boolean>;
  /**
   * Cursor-paginated list of versions for a specific flow id. Sort
   * order is binding-defined (for example ascending semver). Returns an empty page (no error) when the id
   * is unknown — the route flips that to `404` via a prior `get`.
   */
  listVersions(input: FlowListVersionsInput): Promise<FlowPage>;
  /**
   * Publish a validated flow definition. The API route validates
   * shape via `loadFlow(...)` before calling — the binding receives a
   * well-formed `Flow`. Bindings MAY reject with `already-registered`
   * when the same `(flowId, version)` is re-published; the route maps
   * that to `409`.
   * A version of a flow whose versions live in another project is
   * `project-mismatch` (flows never move between projects; `409 flow-project-mismatch`).
   */
  publish(input: FlowPublishInput): Promise<FlowPublishOutcome>;
  /**
   * Soft-tombstone a specific `(flowId, version)`. When this leaves
   * NO active versions, the flow has no latest version — it enters the
   * derived "retired" state (GET returns 410 gone).
   * Publish of a new version reactivates.
   */
  unregister(input: FlowUnregisterInput): Promise<FlowUnregisterOutcome>;
  /**
   * Un-tombstone a specific `(flowId, version)`. Recomputes the flow's
   * latest version. Restores manifest bytes verbatim (semver
   * hygiene). Idempotent.
   */
  reinstateVersion(input: FlowReinstateVersionInput): Promise<FlowReinstateVersionOutcome>;
}

/**
 * A flow version as the registry reads it (`get`, `getVersion`, `list`
 * and `listVersions`): the definition, the flow's project when the
 * store records it, and `unregisteredAt` on an unregistered version
 * `getVersion` reads.
 */
export type FlowVersionRecord = Flow & {
  /** ISO-8601; present only on an unregistered version. */
  readonly unregisteredAt?: string;
  /**
   * The flow's project, when the store records it: flows never move
   * between projects, so every version reads the same one (a deploy
   * into another project is refused even when it writes nothing).
   */
  readonly projectId?: ProjectId;
};

export interface FlowListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Prefix match on `Flow.id`. Undefined = no filter. */
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

export interface FlowGetInput {
  readonly tenantId: TenantId;
  readonly flowId: FlowId;
}

export interface FlowGetVersionInput {
  readonly tenantId: TenantId;
  readonly flowId: FlowId;
  readonly version: string;
}

export interface FlowListVersionsInput {
  readonly tenantId: TenantId;
  readonly flowId: FlowId;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface FlowPublishInput {
  readonly tenantId: TenantId;
  /**
   * Project the flow is published into. REQUIRED. Callers that
   * don't naturally know a projectId
   * (deployment route) resolve the tenant's Default via
   * `projectBinding.getDefault(tenantId)` at THEIR layer and thread
   * the resolved id here — the storage adapter never silently falls
   * back to Default.
   */
  readonly projectId: ProjectId;
  readonly flow: Flow;
  /**
   * REQUIRED. Called inside the binding's write transaction after the
   * head + version rows are inserted, receiving the FGA subject id
   * (business `flowId`). Returns the `TupleIntent[]` to enqueue in
   * the same tx — typically `tuplesForCreate({kind:'flow', ...})`.
   * See `AgentPublishInput.enqueueTuples` for the design rationale.
   */
  readonly enqueueTuples: TupleEnqueueHook;
}

export interface FlowUnregisterInput {
  readonly tenantId: TenantId;
  readonly flowId: FlowId;
  readonly version: string;
}

export interface FlowReinstateVersionInput {
  readonly tenantId: TenantId;
  readonly flowId: FlowId;
  readonly version: string;
}

export interface FlowPage {
  readonly data: readonly FlowVersionRecord[];
  readonly nextCursor?: Cursor;
}

export type FlowPublishOutcome =
  | {
      readonly kind: 'ok';
      readonly flowId: FlowId;
      readonly version: string;
    }
  | {
      readonly kind: 'already-registered';
      readonly flowId: FlowId;
      readonly version: string;
    }
  | {
      /**
       * The caller-supplied `projectId` does not resolve to a real
       * project row in this tenant. Distinct from
       * `already-registered` so callers can surface a clean error (the
       * flows route answers `400 bad-input`) rather than the
       * misleading `already-registered` fallback. Implementations
       * detect a missing project at publish time (a SQL store typically
       * from its foreign-key violation).
       */
      readonly kind: 'project-not-found';
      readonly flowId: FlowId;
      readonly version: string;
      readonly projectId: ProjectId;
    }
  | {
      /**
       * The flow's versions live in another project: a flow belongs to
       * the project its first version was published into, and never
       * moves. Nothing is written (the route answers `409 flow-project-mismatch`).
       */
      readonly kind: 'project-mismatch';
      readonly flowId: FlowId;
      readonly version: string;
      /** The project the flow belongs to. */
      readonly projectId: ProjectId;
    };

export type FlowUnregisterOutcome = {
  readonly unregistered: boolean;
};

export type FlowReinstateVersionOutcome =
  | {
      readonly kind: 'ok';
      readonly flowId: FlowId;
      readonly version: string;
      readonly wasTombstoned: boolean;
    }
  | {
      readonly kind: 'not-found';
      readonly flowId: FlowId;
      readonly version: string;
    };

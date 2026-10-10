// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TupleEnqueueHook } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { CodeArtifactRef, ToolManifest } from '@kindgi/tools';
import type { Cursor, ProjectId, Semver, TenantId, ToolId } from '@kindgi/types';

import type { RegistryReadOnly } from './registry-read-only.js';

/**
 * Caller-plugged surface for the tool catalog. Versioned CRUD mirroring
 * `AgentRegistryBinding` — the API package does NOT own registry
 * persistence. Deployments wire a `ToolRegistry` (from `@kindgi/tools`)
 * — or a durable store — through this binding.
 *
 * The surface is metadata-only: a `Tool` runtime value carries a
 * `handler` closure, which cannot cross HTTP. The wire body is a
 * `ToolManifest` (Tool minus handler); the actual handler must already
 * be registered with the runtime. Handler code is not uploaded over
 * this surface.
 *
 * `publish` is versioned — each call adds a new `(toolId,
 * version)` row. `get(toolId)` returns the latest active version;
 * agents reference tools via `{ id, version: <semver-range> }` and
 * `resolve(toolId, versionSpec)` walks active versions to pick the
 * highest satisfying via `semver.maxSatisfying`. Retirement follows the
 * versioned soft-tombstone pattern: `unregister(toolId, version)`
 * soft-tombstones one version; `reinstateVersion` un-tombstones; when no
 * active versions remain, the tool has no latest version and
 * `GET /v1/tools/{id}` returns 410 gone (distinct from 404
 * not-found via `headExists`).
 */
export interface ToolRegistryBinding {
  /**
   * Set when this registry takes no writes (under `kindgi dev`, the
   * pack's files are the source of its tools): every write is refused
   * with `409 registry-read-only` and this reason, before the binding is
   * called. See `RegistryReadOnly`.
   */
  readonly readOnly?: RegistryReadOnly;
  /**
   * Cursor-paginated list of tools (latest active version per id).
   * Optional `nameFilter` is a prefix match on the tool id — tools use
   * dotted namespaces (`acme.verify-citation`), so prefix matching is
   * the natural filter shape. Derived-retired tools (no active
   * versions) are hidden from list by default.
   */
  list(input: ToolListInput): Promise<ToolPage>;
  /**
   * The manifest of the LATEST active version for the given tool id,
   * or `null` if the id is unknown OR every version is tombstoned.
   * The route uses `headExists` to distinguish 410 gone from 404
   * not-found.
   */
  get(input: ToolGetInput): Promise<ToolManifest | null>;
  /**
   * Exact `(toolId, version)` lookup, including tombstoned versions.
   * Provenance paths use this to resolve historical run references.
   */
  getVersion(input: ToolGetVersionInput): Promise<ToolManifest | null>;
  /**
   * Cursor-paginated list of versions for a specific tool id. Sort
   * order is binding-defined (for example, publish timestamp
   * descending). Returns an empty page (no
   * error) when the id is unknown — the route flips that to 404 via
   * a prior `headExists`.
   *
   * By default returns only active versions. Set
   * `includeTombstoned = true` to include soft-tombstoned rows too;
   * tombstoned rows carry `unregisteredAt` on the wire (ISO string),
   * active rows do not.
   */
  listVersions(input: ToolListVersionsInput): Promise<ToolVersionPage>;
  /**
   * Head-row existence probe. Lets `GET /v1/tools/{id}` distinguish
   * `410 gone` (identity exists, no active version) from `404 not-
   * found` (never registered). Same shape as
   * `AgentRegistryBinding.headExists`.
   */
  headExists(input: ToolGetInput): Promise<boolean>;
  /**
   * Resolve a semver range against active versions and return the
   * highest satisfying manifest via `semver.maxSatisfying`. When
   * `versionSpec` is absent, returns the latest active version (same
   * as `get`). `not-satisfiable` fires when the range parses but no
   * active version matches. `invalid-range` fires when the range
   * itself is not valid semver grammar. `not-found` fires when the
   * tool id is unknown.
   */
  resolve(input: ToolResolveInput): Promise<ToolResolveOutcome>;
  /**
   * Publish a validated tool manifest. Every publish adds a version
   * row; the tool's latest version is recomputed across active
   * versions. Bindings MAY reject with `already-registered` when the
   * same `(toolId, version)` is re-published; the route maps that to
   * `409`. Semver hygiene: version numbers are single-use even after
   * unregister — reinstate instead of republishing the same bytes.
   * A version of a tool whose versions live in another project is
   * `project-mismatch` (tools never move between projects; `409 tool-project-mismatch`).
   */
  publish(input: ToolPublishInput): Promise<ToolPublishOutcome>;
  /**
   * Soft-tombstone a specific `(toolId, version)`. When this leaves
   * NO active versions, the tool has no latest version — it enters the
   * derived "retired" state (GET returns 410 gone).
   * Publish of a new version reactivates. Version is REQUIRED
   * (there are no bare-tool-id semantics).
   */
  unregister(input: ToolUnregisterInput): Promise<ToolUnregisterOutcome>;
  /**
   * Un-tombstone a specific `(toolId, version)`. Recomputes the tool's
   * latest version across active versions. Restores the manifest
   * bytes verbatim (semver hygiene). Idempotent.
   */
  reinstateVersion(input: ToolReinstateVersionInput): Promise<ToolReinstateVersionOutcome>;
  /**
   * Optional. Point a published version at where its code is now
   * (`codeArtifactRef`): a deploy of the same version from a new image of
   * the pack. Nothing else about the version changes. Without it, the
   * version keeps the pointer its first deploy gave it: metadata only, as
   * pack code runs by tool id and version.
   */
  refreshCodeArtifactRef?(input: ToolRefreshCodeInput): Promise<RegistryRefreshOutcome>;
}

export interface ToolRefreshCodeInput {
  readonly tenantId: TenantId;
  readonly toolId: ToolId;
  readonly version: Semver;
  /** Where the version's code is now; `null` for none. */
  readonly codeArtifactRef: CodeArtifactRef | null;
  /**
   * Compare-and-set: refresh only while the version still points here
   * (`null`: nowhere), else answer `{ refreshed: false }` and change
   * nothing. A deploy's rollback passes what it wrote, so it never undoes
   * a refresh another deploy made since.
   */
  readonly expected?: CodeArtifactRef | null;
}

/** `refreshed: false` when there's no such live row to refresh. */
export interface RegistryRefreshOutcome {
  readonly refreshed: boolean;
}

export interface ToolListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Prefix match on `ToolManifest.id`. Undefined = no filter. */
  readonly nameFilter?: string;
  /**
   * Narrow the list to a specific scope. Absent = no scope narrow
   * (return every row in the tenant the caller can see).
   */
  readonly scope?: Scope;
  /**
   * `false` = literal-at-this-scope only. `true` (default) =
   * inheritance walk — no-op for content-scoped bindings
   * (documented for uniformity).
   */
  readonly inherit?: boolean;
}

export interface ToolGetInput {
  readonly tenantId: TenantId;
  readonly toolId: ToolId;
}

export interface ToolGetVersionInput {
  readonly tenantId: TenantId;
  readonly toolId: ToolId;
  readonly version: Semver;
}

export interface ToolListVersionsInput {
  readonly tenantId: TenantId;
  readonly toolId: ToolId;
  readonly limit: number;
  /**
   * A prior page's `nextCursor`, which the route checks before asking the
   * binding: url-safe base64 of `{ "p": <the last version's publish time as
   * stored>, "i": <its row id> }`, or (a cursor from before) of a bare ISO
   * time. Anything else is `400 bad-input`.
   */
  readonly cursor?: Cursor;
  /**
   * `false` (default) → return only active versions. `true` → return
   * active + tombstoned rows; tombstoned entries carry `unregisteredAt`
   * on the wire, active entries do not. Aligns with the soft-tombstone
   * pattern used by agents / flows / eval suites / policies.
   */
  readonly includeTombstoned?: boolean;
}

export interface ToolResolveInput {
  readonly tenantId: TenantId;
  readonly toolId: ToolId;
  /**
   * Semver range (npm grammar): `'1.2.3'` exact pin, `'^1.2.3'`
   * compatible-updates, `'~1.2.3'` patch-updates, `'>=1.0.0 <2.0.0'`
   * explicit range. Absent = latest active (behaves like `get`).
   */
  readonly versionSpec?: string;
}

export interface ToolPublishInput {
  readonly tenantId: TenantId;
  /**
   * Project the tool is registered into. REQUIRED. Callers
   * that don't naturally know a projectId (deployment
   * route, boot-time dev-echo seed, MCP bridge) resolve the tenant's
   * Default via `projectBinding.getDefault(tenantId)` at THEIR layer.
   */
  readonly projectId: ProjectId;
  readonly tool: ToolManifest;
  /**
   * REQUIRED. Called inside the binding's write tx after row insert,
   * receiving the business `toolId`. Returns tuples for the same tx.
   * See `AgentPublishInput.enqueueTuples` for the design rationale.
   */
  readonly enqueueTuples: TupleEnqueueHook;
}

export interface ToolUnregisterInput {
  readonly tenantId: TenantId;
  readonly toolId: ToolId;
  /** REQUIRED — no bare-id unregister under the versioned model. */
  readonly version: Semver;
}

export interface ToolReinstateVersionInput {
  readonly tenantId: TenantId;
  readonly toolId: ToolId;
  readonly version: Semver;
}

export interface ToolPage {
  readonly data: readonly ToolManifest[];
  readonly nextCursor?: Cursor;
}

/**
 * A single row in a `listVersions` result. Manifest fields plus an
 * optional `unregisteredAt` timestamp — present iff the version has
 * been soft-tombstoned via `unregister`. Callers that ignore the extra
 * field see a plain `ToolManifest`.
 */
export type ToolVersionRow = ToolManifest & {
  readonly unregisteredAt?: string;
};

export interface ToolVersionPage {
  readonly data: readonly ToolVersionRow[];
  readonly nextCursor?: Cursor;
}

export type ToolPublishOutcome =
  | {
      readonly kind: 'ok';
      readonly toolId: ToolId;
      readonly version: Semver;
    }
  | {
      readonly kind: 'already-registered';
      readonly toolId: ToolId;
      readonly version: Semver;
    }
  | {
      readonly kind: 'project-not-found';
      readonly toolId: ToolId;
      readonly version: Semver;
      readonly projectId: ProjectId;
    }
  | {
      /**
       * The tool's versions live in another project: a tool belongs to
       * the project its first version was published into, and never
       * moves. Nothing is written (the route answers `409 tool-project-mismatch`).
       */
      readonly kind: 'project-mismatch';
      readonly toolId: ToolId;
      readonly version: Semver;
      /** The project the tool belongs to. */
      readonly projectId: ProjectId;
    };

export type ToolUnregisterOutcome = {
  readonly unregistered: boolean;
};

export type ToolReinstateVersionOutcome =
  | {
      readonly kind: 'ok';
      readonly toolId: ToolId;
      readonly version: Semver;
      readonly wasTombstoned: boolean;
    }
  | {
      readonly kind: 'not-found';
      readonly toolId: ToolId;
      readonly version: Semver;
    };

export type ToolResolveOutcome =
  | {
      readonly kind: 'ok';
      readonly toolId: ToolId;
      readonly resolvedVersion: Semver;
      readonly manifest: ToolManifest;
    }
  | {
      /** No `(toolId)` head row — tool id was never published. */
      readonly kind: 'not-found';
      readonly toolId: ToolId;
    }
  | {
      /** Head exists but no active versions match the requested range. */
      readonly kind: 'not-satisfiable';
      readonly toolId: ToolId;
      readonly versionSpec: string;
      /** Active semver strings — helps the caller diagnose. */
      readonly candidateVersions: readonly string[];
    }
  | {
      /** `versionSpec` failed `semver.validRange`. */
      readonly kind: 'invalid-range';
      readonly toolId: ToolId;
      readonly versionSpec: string;
    };

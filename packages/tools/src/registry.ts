// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import semver from 'semver';

import type { Result, TenantId, ToolId } from '@kindgi/types';

import type {
  DuplicateToolVersionError,
  InvalidVersionRangeError,
  ToolError,
  ToolNotFoundError,
  ToolVersionNotFoundError,
  ToolVersionUnresolvableError,
} from './errors.js';
import type { AnyTool } from './types.js';
import { pickVersion } from './versions.js';

/**
 * In-process registry mapping (tool id, version) → tool. Multi-version:
 * a single id may carry multiple compiled implementations at different
 * exact semver strings; agent bindings reference tools by (id, range)
 * and dispatch resolves at run start via `resolve(id, range)` (npm-
 * compatible semver grammar, by `pickVersion`'s rule).
 *
 * Not tenant-scoped. Multi-tenant deployments hold one registry per
 * tenant or encode tenancy into tool ids. Cross-tenant tool sharing goes
 * through the policy engine, not through registry design.
 */
export interface ToolRegistry {
  /**
   * Register a tool. Fails with `duplicate-tool-version` if the same
   * `(id, version)` pair is already registered. Distinct versions of the
   * same id may coexist — that's the whole point of the versioned model.
   */
  register(tool: AnyTool): Result<void, ToolError>;
  /**
   * Return the latest active version for an id. "Latest" is defined by
   * `semver.compare` — the highest exact version present. For callers
   * that have no version range to resolve. Prefer `resolve(id, range)`
   * when a range is available.
   */
  get(id: ToolId): Result<AnyTool, ToolError>;
  /** Return a specific `(id, version)` pair. */
  getVersion(id: ToolId, version: string): Result<AnyTool, ToolError>;
  /**
   * Resolve a semver range against the versions registered under `id`.
   * Picks by `pickVersion`'s rule (npm's). Distinct failure modes:
   *   - `tool-not-found`         → id has no versions at all
   *   - `invalid-version-range`  → range string is grammatically broken
   *   - `tool-version-unresolvable` → id is present but no version satisfies
   */
  resolve(id: ToolId, range: string): Result<ToolResolution, ToolError>;
  has(id: ToolId): boolean;
  hasVersion(id: ToolId, version: string): boolean;
  /**
   * Return every registered tool version, sorted by id then by version
   * descending. Callers that want a per-id latest-only view use
   * `.get(id)` per id.
   */
  list(): readonly AnyTool[];
  /** Return every id with at least one registered version. */
  ids(): readonly ToolId[];
  /** Return every version registered under `id`, sorted descending. */
  versions(id: ToolId): readonly string[];
  /**
   * The registry for one tenant: lookups on the returned registry
   * (`get`, `getVersion`, `resolve`, `list`, …) answer for `tenantId`
   * only. Multi-tenant implementations load that tenant's tools (e.g.
   * from a persistent store, cached) and return a view bound to it —
   * never shared per-call state, so concurrent turns of different
   * tenants cannot see each other's tools. A single-tenant registry
   * (like `createToolRegistry`) returns itself. Callers resolve a
   * turn's tools through the returned registry.
   */
  forTenant(tenantId: TenantId): Promise<ToolRegistry>;
  /**
   * Optional cache invalidation. Storage-backed implementations call
   * this from the write path (`POST /v1/tools`, unregister, reinstate)
   * so the next `forTenant(tenantId)` re-reads from the persistent
   * store. Without it, tools published after a tenant was loaded stay
   * invisible to that tenant's cached view. In-memory implementations
   * leave it undefined — there is no cache to invalidate.
   */
  readonly invalidate?: (tenantId: TenantId) => void;
}

/** The outcome of a successful `resolve(id, range)` lookup. */
export interface ToolResolution {
  readonly tool: AnyTool;
  /**
   * The exact version `pickVersion` picked. Callers capture this in
   * provenance + telemetry so a replay can pin against the same version.
   */
  readonly resolvedVersion: string;
}

/**
 * Create an empty tool registry. Seeds are registered in order; the seed
 * throws on duplicate `(id, version)` so accidental clobbers of a
 * running tool fail loud at boot.
 */
export function createToolRegistry(seed: readonly AnyTool[] = []): ToolRegistry {
  // id → version → tool. Nested map so we can iterate versions per id
  // cheaply and cache a sorted-version list.
  const tools = new Map<ToolId, Map<string, AnyTool>>();

  function versionsDesc(id: ToolId): string[] {
    const versions = tools.get(id);
    if (versions === undefined) return [];
    return [...versions.keys()].sort((a, b) => semver.rcompare(a, b));
  }

  const registry: ToolRegistry = {
    register(tool: AnyTool): Result<void, ToolError> {
      let versions = tools.get(tool.id);
      if (versions === undefined) {
        versions = new Map();
        tools.set(tool.id, versions);
      }
      if (versions.has(tool.version)) {
        const dup: DuplicateToolVersionError = {
          code: 'duplicate-tool-version',
          message: `Tool "${tool.id}@${tool.version}" is already registered`,
          id: tool.id,
          version: tool.version,
        };
        return { kind: 'err', error: dup };
      }
      versions.set(tool.version, tool);
      return { kind: 'ok', value: undefined };
    },
    get(id: ToolId): Result<AnyTool, ToolError> {
      const desc = versionsDesc(id);
      if (desc.length === 0) {
        const err: ToolNotFoundError = {
          code: 'tool-not-found',
          message: `No tool registered with id "${id}"`,
          id,
        };
        return { kind: 'err', error: err };
      }
      // desc is sorted desc — desc[0] is highest.
      const latest = tools.get(id)?.get(desc[0]!);
      if (latest === undefined) {
        const err: ToolNotFoundError = {
          code: 'tool-not-found',
          message: `No tool registered with id "${id}"`,
          id,
        };
        return { kind: 'err', error: err };
      }
      return { kind: 'ok', value: latest };
    },
    getVersion(id: ToolId, version: string): Result<AnyTool, ToolError> {
      const found = tools.get(id)?.get(version);
      if (found === undefined) {
        if (tools.get(id) === undefined) {
          const err: ToolNotFoundError = {
            code: 'tool-not-found',
            message: `No tool registered with id "${id}"`,
            id,
          };
          return { kind: 'err', error: err };
        }
        const err: ToolVersionNotFoundError = {
          code: 'tool-version-not-found',
          message: `Tool "${id}" has no version "${version}" registered`,
          id,
          version,
        };
        return { kind: 'err', error: err };
      }
      return { kind: 'ok', value: found };
    },
    resolve(id: ToolId, range: string): Result<ToolResolution, ToolError> {
      const versions = tools.get(id);
      if (versions === undefined || versions.size === 0) {
        const err: ToolNotFoundError = {
          code: 'tool-not-found',
          message: `No tool registered with id "${id}"`,
          id,
        };
        return { kind: 'err', error: err };
      }
      const available = [...versions.keys()];
      const pick = pickVersion(available, range);
      if (pick.kind === 'invalid-range') {
        const err: InvalidVersionRangeError = {
          code: 'invalid-version-range',
          message: `Version range "${range}" for tool "${id}" is not a valid semver range`,
          id,
          range,
        };
        return { kind: 'err', error: err };
      }
      if (pick.kind === 'not-satisfiable') {
        const err: ToolVersionUnresolvableError = {
          code: 'tool-version-unresolvable',
          message: `Tool "${id}" has no version satisfying "${range}" (available: ${available
            .sort((a, b) => semver.rcompare(a, b))
            .join(', ')})`,
          id,
          range,
          availableVersions: available.sort((a, b) => semver.rcompare(a, b)),
        };
        return { kind: 'err', error: err };
      }
      const picked = pick.version;
      const tool = versions.get(picked);
      // pickVersion returned a version we just enumerated — guaranteed
      // to be in the map. The `if (tool === undefined)` branch is a
      // defensive no-op for the type system.
      if (tool === undefined) {
        const err: ToolVersionNotFoundError = {
          code: 'tool-version-not-found',
          message: `Tool "${id}" resolved to "${picked}" but the version is missing (internal)`,
          id,
          version: picked,
        };
        return { kind: 'err', error: err };
      }
      return { kind: 'ok', value: { tool, resolvedVersion: picked } };
    },
    has(id: ToolId): boolean {
      const versions = tools.get(id);
      return versions !== undefined && versions.size > 0;
    },
    hasVersion(id: ToolId, version: string): boolean {
      return tools.get(id)?.has(version) ?? false;
    },
    list(): readonly AnyTool[] {
      const out: AnyTool[] = [];
      const ids = [...tools.keys()].sort();
      for (const id of ids) {
        for (const v of versionsDesc(id)) {
          const tool = tools.get(id)?.get(v);
          if (tool !== undefined) out.push(tool);
        }
      }
      return out;
    },
    ids(): readonly ToolId[] {
      const out: ToolId[] = [];
      for (const [id, versions] of tools) {
        if (versions.size > 0) out.push(id);
      }
      return out;
    },
    versions(id: ToolId): readonly string[] {
      return versionsDesc(id);
    },
    async forTenant(): Promise<ToolRegistry> {
      // Single-tenant: the same registry serves every tenant.
      return registry;
    },
  };

  for (const tool of seed) {
    const r = registry.register(tool);
    if (r.kind === 'err') throw new Error(`seed failed: ${r.error.message}`);
  }
  return registry;
}

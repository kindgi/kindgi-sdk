// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';

import type { AgentAlreadyRegisteredError, AgentNotFoundError } from './errors.js';
import type { Agent, AgentId } from './types.js';

/**
 * In-memory catalog of agent definitions. Keyed by `(id, version)`,
 * because the same agent id at different versions is a different
 * agent for provenance / audit purposes. `getLatest(id)` returns the
 * highest semver registered under that id.
 *
 * The registry is per-tenant at the application layer — callers
 * typically instantiate one registry per tenant boot. The registry
 * itself does not enforce tenancy: it's a substrate primitive, and
 * multi-tenant deployments layer RLS + tenant-scoped registries on
 * top.
 */
export interface AgentRegistry {
  register(agent: Agent): Result<void, AgentAlreadyRegisteredError>;
  /**
   * Look up an agent by id + version. If `version` is omitted, returns
   * the latest semver registered under `id`.
   */
  get(id: AgentId, version?: string): Result<Agent, AgentNotFoundError>;
  /** Enumerate every version of every registered agent. */
  list(): readonly Agent[];
  /** Enumerate all versions registered under a given id, semver-sorted asc. */
  listVersions(id: AgentId): readonly Agent[];
  /**
   * Latest semver for id, or `agent-not-found`.
   */
  getLatest(id: AgentId): Result<Agent, AgentNotFoundError>;
  /**
   * Deregister a specific version. Rare — typically used for
   * pack-uninstall flows. Returns `agent-not-found` on miss.
   */
  unregister(id: AgentId, version: string): Result<void, AgentNotFoundError>;
}

export function createAgentRegistry(seed: readonly Agent[] = []): AgentRegistry {
  const byIdVersion = new Map<string, Agent>();

  function key(id: string, version: string): string {
    return `${id}@${version}`;
  }

  function versionsForId(id: AgentId): Agent[] {
    return [...byIdVersion.values()]
      .filter((a) => a.id === id)
      .sort((a, b) => compareSemver(a.version, b.version));
  }

  for (const agent of seed) byIdVersion.set(key(agent.id, agent.version), agent);

  return {
    register(agent): Result<void, AgentAlreadyRegisteredError> {
      const k = key(agent.id, agent.version);
      if (byIdVersion.has(k)) {
        return {
          kind: 'err',
          error: {
            code: 'agent-already-registered',
            message: `Agent "${agent.id}" version "${agent.version}" is already registered`,
            agentId: agent.id,
            version: agent.version,
          },
        };
      }
      byIdVersion.set(k, agent);
      return { kind: 'ok', value: undefined };
    },
    get(id, version): Result<Agent, AgentNotFoundError> {
      if (version !== undefined) {
        const hit = byIdVersion.get(key(id, version));
        if (hit === undefined) {
          return {
            kind: 'err',
            error: {
              code: 'agent-not-found',
              message: `No agent "${id}" at version "${version}"`,
              agentId: id,
              version,
            },
          };
        }
        return { kind: 'ok', value: hit };
      }
      const versions = versionsForId(id);
      const latest = versions[versions.length - 1];
      if (latest === undefined) {
        return {
          kind: 'err',
          error: {
            code: 'agent-not-found',
            message: `No agent registered with id "${id}"`,
            agentId: id,
          },
        };
      }
      return { kind: 'ok', value: latest };
    },
    list(): readonly Agent[] {
      return [...byIdVersion.values()];
    },
    listVersions(id): readonly Agent[] {
      return versionsForId(id);
    },
    getLatest(id): Result<Agent, AgentNotFoundError> {
      const versions = versionsForId(id);
      const latest = versions[versions.length - 1];
      if (latest === undefined) {
        return {
          kind: 'err',
          error: {
            code: 'agent-not-found',
            message: `No agent registered with id "${id}"`,
            agentId: id,
          },
        };
      }
      return { kind: 'ok', value: latest };
    },
    unregister(id, version): Result<void, AgentNotFoundError> {
      const k = key(id, version);
      if (!byIdVersion.has(k)) {
        return {
          kind: 'err',
          error: {
            code: 'agent-not-found',
            message: `No agent "${id}" at version "${version}" to unregister`,
            agentId: id,
            version,
          },
        };
      }
      byIdVersion.delete(k);
      return { kind: 'ok', value: undefined };
    },
  };
}

/**
 * Compare two semver strings. Returns negative if a < b, positive if
 * a > b, 0 if equal. Handles pre-release tags by treating any tagged
 * version as lower than the equivalent untagged version — matches
 * semver.org §11.
 */
function compareSemver(a: string, b: string): number {
  const [aBase, aPre] = a.split('-', 2);
  const [bBase, bPre] = b.split('-', 2);
  const aParts = (aBase ?? '0.0.0').split('.').map(Number);
  const bParts = (bBase ?? '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre.localeCompare(bPre);
}

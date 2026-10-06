// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import type { OrgId, ProjectId } from '@kindgi/types';

import type { BlockRecord, BlockRegistryBinding } from '../../src/index.js';

/**
 * A `BlockRegistryBinding` in memory, keeping the contract a store keeps:
 * versions never change, a block's versions share its first version's
 * project, unregister is soft, `getVersion` reads an unregistered
 * version (with `unregisteredAt`), and the latest is the highest active
 * version. `orgs` maps a project to its org, for an org-scoped list.
 */
export function inMemoryBlocks(
  knownProjects?: readonly ProjectId[],
  orgs: Readonly<Record<string, OrgId>> = {},
): BlockRegistryBinding & { readonly rows: Map<string, BlockRecord> } {
  const rows = new Map<string, BlockRecord>();
  let clock = Date.parse('2026-10-06T00:00:00.000Z');
  const key = (id: string, version: string) => `${id}@${version}`;
  const versionsOf = (id: string, includeTombstoned = false) =>
    [...rows.values()]
      .filter((b) => b.id === id && (includeTombstoned || b.unregisteredAt === undefined))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const latestOf = (id: string) =>
    versionsOf(id).sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    )[0] ?? null;

  return {
    rows,
    async list({ blockKind, nameFilter, scope }) {
      const ids = [...new Set([...rows.values()].map((b) => b.id))].sort();
      const data = ids
        .map(latestOf)
        .filter((b): b is BlockRecord => b !== null)
        .filter((b) => blockKind === undefined || b.kind === blockKind)
        .filter((b) => nameFilter === undefined || b.id.startsWith(nameFilter))
        .filter((b) => inScope(b.projectId, scope, orgs));
      return { data };
    },
    async get({ blockId }) {
      return latestOf(blockId);
    },
    async getVersion({ blockId, version }) {
      return rows.get(key(blockId, version)) ?? null;
    },
    async listVersions({ blockId, includeTombstoned }) {
      return { data: versionsOf(blockId, includeTombstoned === true) };
    },
    async publish({ projectId, block }) {
      if (knownProjects !== undefined && !knownProjects.includes(projectId)) {
        return { kind: 'project-not-found', blockId: block.id, projectId };
      }
      const owner = versionsOf(block.id, true)[0];
      if (owner !== undefined && owner.projectId !== projectId) {
        return { kind: 'project-mismatch', blockId: block.id, projectId: owner.projectId };
      }
      if (rows.has(key(block.id, block.version))) {
        return { kind: 'already-registered', blockId: block.id, version: block.version };
      }
      clock += 1000;
      rows.set(key(block.id, block.version), {
        ...block,
        projectId,
        publishedAt: new Date(clock).toISOString(),
      });
      return { kind: 'ok', blockId: block.id, version: block.version };
    },
    async unregister({ blockId, version }) {
      const row = rows.get(key(blockId, version));
      if (row === undefined || row.unregisteredAt !== undefined) return { unregistered: false };
      rows.set(key(blockId, version), { ...row, unregisteredAt: new Date(clock).toISOString() });
      return { unregistered: true };
    },
    async reinstateVersion({ blockId, version }) {
      const row = rows.get(key(blockId, version));
      if (row === undefined) return { kind: 'not-found', blockId, version };
      const { unregisteredAt, ...active } = row;
      rows.set(key(blockId, version), active);
      return { kind: 'ok', blockId, version, wasTombstoned: unregisteredAt !== undefined };
    },
  };
}

function inScope(
  projectId: ProjectId,
  scope: Scope | undefined,
  orgs: Readonly<Record<string, OrgId>>,
): boolean {
  if (scope?.kind === 'project') return projectId === scope.projectId;
  if (scope?.kind === 'org') return orgs[projectId as unknown as string] === scope.orgId;
  return true;
}

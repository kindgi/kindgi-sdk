// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `makeInMemoryOrgBinding` — reference in-memory implementation of
 * `OrgBinding`. Used by tests + dev-time defaults. Not durable —
 * production deployments supply their own implementation.
 *
 * Storage: a single `Map<OrgId, Org>` keyed by orgId. Every operation
 * filters by `tenantId` at the row level — a lookup from tenant A
 * against an orgId that exists in tenant B returns `undefined` (not a
 * hit). Cross-tenant leakage is a hard guardrail, asserted by the
 * conformance suite. Slugs are unique within a tenant: `create` and
 * `update` resolve to `slug-conflict` for a slug another org holds.
 * `delete` tombstones: a deleted org reads as unknown and frees its slug.
 */

import type { OrgId, Page, TenantId, Timestamp } from '@kindgi/types';

import type {
  OrgBinding,
  OrgCreateOutcome,
  OrgListFilter,
  OrgUpdateOutcome,
} from '../org-binding.js';
import type { Org, OrgPatch, OrgSpec } from '../types.js';

import { nowTimestamp, paginate } from './util.js';

let orgIdCounter = 0;
function nextOrgId(): OrgId {
  orgIdCounter += 1;
  return `org-${orgIdCounter}` as OrgId;
}

/**
 * Factory for the in-memory `OrgBinding`.
 */
export function makeInMemoryOrgBinding(): OrgBinding {
  const rows = new Map<OrgId, Org>();
  /** Tombstoned orgs: kept, and read as unknown. */
  const deleted = new Set<OrgId>();

  /** The tenant's live org with that id. */
  function live(tenantId: TenantId, orgId: OrgId): Org | undefined {
    const row = rows.get(orgId);
    if (row === undefined || row.tenantId !== tenantId || deleted.has(orgId)) return undefined;
    return row;
  }

  /** Is `slug` held by a live org in the tenant other than `exceptId`? */
  function slugTaken(tenantId: TenantId, slug: string, exceptId?: OrgId): boolean {
    for (const row of rows.values()) {
      if (deleted.has(row.id)) continue;
      if (row.tenantId === tenantId && row.slug === slug && row.id !== exceptId) return true;
    }
    return false;
  }

  return {
    async create(tenantId: TenantId, spec: OrgSpec): Promise<OrgCreateOutcome> {
      if (slugTaken(tenantId, spec.slug)) return { kind: 'slug-conflict', slug: spec.slug };
      const id = nextOrgId();
      const now = nowTimestamp();
      const row: Org = {
        id,
        tenantId,
        name: spec.name,
        slug: spec.slug,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(id, row);
      return { kind: 'ok', orgId: id };
    },

    async get(tenantId: TenantId, orgId: OrgId): Promise<Org | undefined> {
      return live(tenantId, orgId);
    },

    async list(tenantId: TenantId, filter: OrgListFilter): Promise<Page<Org>> {
      const all: Org[] = [];
      for (const row of rows.values()) {
        if (row.tenantId !== tenantId || deleted.has(row.id)) continue;
        if (filter.nameContains !== undefined && !row.name.includes(filter.nameContains)) {
          continue;
        }
        all.push(row);
      }
      // Deterministic ordering by createdAt then id for stable pagination.
      all.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return paginate(all, filter.limit, filter.cursor);
    },

    async update(tenantId: TenantId, orgId: OrgId, patch: OrgPatch): Promise<OrgUpdateOutcome> {
      const row = live(tenantId, orgId);
      if (row === undefined) return { kind: 'org-not-found' };
      if (patch.slug !== undefined && slugTaken(tenantId, patch.slug, orgId)) {
        return { kind: 'slug-conflict', slug: patch.slug };
      }
      const now: Timestamp = nowTimestamp();
      const next: Org = {
        id: row.id,
        tenantId: row.tenantId,
        name: patch.name ?? row.name,
        slug: patch.slug ?? row.slug,
        createdAt: row.createdAt,
        updatedAt: now,
      };
      rows.set(orgId, next);
      return { kind: 'ok' };
    },

    async delete(tenantId: TenantId, orgId: OrgId): Promise<void> {
      // Idempotent: a no-op when absent, already deleted or in another tenant.
      if (live(tenantId, orgId) === undefined) return;
      deleted.add(orgId);
    },
  };
}

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
 * conformance suite.
 */

import type { OrgId, Page, TenantId, Timestamp } from '@kindgi/types';

import type { OrgBinding, OrgListFilter } from '../org-binding.js';
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

  return {
    async create(tenantId: TenantId, spec: OrgSpec): Promise<OrgId> {
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
      return id;
    },

    async get(tenantId: TenantId, orgId: OrgId): Promise<Org | undefined> {
      const row = rows.get(orgId);
      if (row === undefined) return undefined;
      if (row.tenantId !== tenantId) return undefined;
      return row;
    },

    async list(tenantId: TenantId, filter: OrgListFilter): Promise<Page<Org>> {
      const all: Org[] = [];
      for (const row of rows.values()) {
        if (row.tenantId !== tenantId) continue;
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

    async update(tenantId: TenantId, orgId: OrgId, patch: OrgPatch): Promise<void> {
      const row = rows.get(orgId);
      if (row === undefined || row.tenantId !== tenantId) {
        throw new Error(`org-not-found: ${orgId}`);
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
    },

    async delete(tenantId: TenantId, orgId: OrgId): Promise<void> {
      const row = rows.get(orgId);
      if (row === undefined || row.tenantId !== tenantId) {
        // Idempotent delete — no-op when absent or in another tenant.
        return;
      }
      rows.delete(orgId);
    },
  };
}

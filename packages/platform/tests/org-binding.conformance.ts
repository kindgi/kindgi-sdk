// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Conformance suite for `OrgBinding`. Any adapter (the in-memory
 * reference impl; a Postgres impl) invokes
 * `runOrgBindingConformance(makeBinding)` and inherits the full
 * behavioural contract.
 *
 * Cases covered:
 * - CRUD happy paths (create → get → list → update → delete).
 * - Cross-tenant isolation: an Org in tenant A never surfaces in
 *   tenant B's list/get. This is the guardrail, not a feature —
 *   asserted at every reachable read op.
 * - Pagination via `Filter.cursor`.
 * - `nameContains` substring filter.
 * - `get`/`update`/`delete` behaviour on unknown orgIds.
 */

import { describe, expect, it } from 'vitest';

import type { OrgId, TenantId } from '@kindgi/types';

import type { OrgBinding } from '../src/org-binding.js';

const T1 = 'tenant-1' as TenantId;
const T2 = 'tenant-2' as TenantId;

export function runOrgBindingConformance(
  makeBinding: () => OrgBinding,
  label = 'OrgBinding',
): void {
  describe(`${label} — CRUD happy paths`, () => {
    it('creates + gets an Org', async () => {
      const b = makeBinding();
      const id = await b.create(T1, { name: 'Acme', slug: 'acme' });
      const got = await b.get(T1, id);
      expect(got).toBeDefined();
      expect(got?.id).toBe(id);
      expect(got?.tenantId).toBe(T1);
      expect(got?.name).toBe('Acme');
      expect(got?.slug).toBe('acme');
    });

    it('updates an Org partially', async () => {
      const b = makeBinding();
      const id = await b.create(T1, { name: 'Acme', slug: 'acme' });
      await b.update(T1, id, { name: 'Acme Corp' });
      const got = await b.get(T1, id);
      expect(got?.name).toBe('Acme Corp');
      expect(got?.slug).toBe('acme');
    });

    it('deletes an Org', async () => {
      const b = makeBinding();
      const id = await b.create(T1, { name: 'Acme', slug: 'acme' });
      await b.delete(T1, id);
      const got = await b.get(T1, id);
      expect(got).toBeUndefined();
    });

    it('lists orgs (empty tenant)', async () => {
      const b = makeBinding();
      const page = await b.list(T1, {});
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeUndefined();
    });
  });

  describe(`${label} — cross-tenant isolation`, () => {
    it('get on tenant B for tenant-A orgId returns undefined', async () => {
      const b = makeBinding();
      const id = await b.create(T1, { name: 'Acme', slug: 'acme' });
      expect(await b.get(T2, id)).toBeUndefined();
    });

    it('list on tenant B does not surface tenant-A orgs', async () => {
      const b = makeBinding();
      await b.create(T1, { name: 'Acme', slug: 'acme' });
      await b.create(T1, { name: 'Globex', slug: 'globex' });
      const t2Page = await b.list(T2, {});
      expect(t2Page.items).toEqual([]);
    });

    it('update on tenant B for tenant-A orgId errors', async () => {
      const b = makeBinding();
      const id = await b.create(T1, { name: 'Acme', slug: 'acme' });
      await expect(b.update(T2, id, { name: 'X' })).rejects.toThrow();
    });

    it('delete on tenant B for tenant-A orgId is a no-op (does not mutate A)', async () => {
      const b = makeBinding();
      const id = await b.create(T1, { name: 'Acme', slug: 'acme' });
      await b.delete(T2, id); // no-op
      const got = await b.get(T1, id);
      expect(got).toBeDefined();
    });
  });

  describe(`${label} — pagination`, () => {
    it('paginates via Filter.cursor', async () => {
      const b = makeBinding();
      const created: OrgId[] = [];
      for (let i = 0; i < 5; i += 1) {
        created.push(await b.create(T1, { name: `Org${i}`, slug: `org-${i}` }));
      }
      const page1 = await b.list(T1, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await b.list(T1, {
        limit: 2,
        ...(page1.nextCursor !== undefined ? { cursor: page1.nextCursor } : {}),
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBeDefined();

      const page3 = await b.list(T1, {
        limit: 2,
        ...(page2.nextCursor !== undefined ? { cursor: page2.nextCursor } : {}),
      });
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeUndefined();

      const seen = new Set<string>();
      for (const p of [page1, page2, page3]) {
        for (const item of p.items) seen.add(item.id);
      }
      expect(seen.size).toBe(5);
    });
  });

  describe(`${label} — nameContains filter`, () => {
    it('narrows to orgs whose name contains the substring', async () => {
      const b = makeBinding();
      await b.create(T1, { name: 'Litigation', slug: 'lit' });
      await b.create(T1, { name: 'Corporate', slug: 'corp' });
      await b.create(T1, { name: 'Litigation-Sub', slug: 'lit-sub' });

      const page = await b.list(T1, { nameContains: 'Litigation' });
      expect(page.items).toHaveLength(2);
      const names = page.items.map((o) => o.name).sort();
      expect(names).toEqual(['Litigation', 'Litigation-Sub']);
    });
  });

  describe(`${label} — not-found behaviour`, () => {
    const unknown = 'org-unknown' as OrgId;

    it('get on unknown orgId returns undefined', async () => {
      const b = makeBinding();
      expect(await b.get(T1, unknown)).toBeUndefined();
    });

    it('update on unknown orgId errors', async () => {
      const b = makeBinding();
      await expect(b.update(T1, unknown, { name: 'X' })).rejects.toThrow();
    });

    it('delete on unknown orgId is a no-op', async () => {
      const b = makeBinding();
      await expect(b.delete(T1, unknown)).resolves.toBeUndefined();
    });
  });
}

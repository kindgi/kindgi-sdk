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
 * - `get`/`update`/`delete` behaviour on unknown orgIds: `update`
 *   resolves to `org-not-found`.
 * - Slug uniqueness within a tenant: `create` and `update` resolve to
 *   `slug-conflict`; another tenant may reuse the slug.
 * - `delete` (a tombstone in a durable binding): the org is unknown to
 *   every read, its slug is free, and deleting again is a no-op.
 */

import { describe, expect, it } from 'vitest';

import type { OrgId, TenantId } from '@kindgi/types';

import type { OrgBinding } from '../src/org-binding.js';
import type { OrgSpec } from '../src/types.js';

const T1 = 'tenant-1' as TenantId;
const T2 = 'tenant-2' as TenantId;

/** Create an org the test expects to succeed; its id. */
async function createOrg(b: OrgBinding, tenantId: TenantId, spec: OrgSpec): Promise<OrgId> {
  const outcome = await b.create(tenantId, spec);
  if (outcome.kind !== 'ok') throw new Error(`expected the org to be created, got ${outcome.kind}`);
  return outcome.orgId;
}

export function runOrgBindingConformance(
  makeBinding: () => OrgBinding,
  label = 'OrgBinding',
): void {
  describe(`${label} — CRUD happy paths`, () => {
    it('creates + gets an Org', async () => {
      const b = makeBinding();
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      const got = await b.get(T1, id);
      expect(got).toBeDefined();
      expect(got?.id).toBe(id);
      expect(got?.tenantId).toBe(T1);
      expect(got?.name).toBe('Acme');
      expect(got?.slug).toBe('acme');
    });

    it('updates an Org partially', async () => {
      const b = makeBinding();
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      expect(await b.update(T1, id, { name: 'Acme Corp' })).toEqual({ kind: 'ok' });
      const got = await b.get(T1, id);
      expect(got?.name).toBe('Acme Corp');
      expect(got?.slug).toBe('acme');
    });

    it('deletes an Org', async () => {
      const b = makeBinding();
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      await b.delete(T1, id);
      const got = await b.get(T1, id);
      expect(got).toBeUndefined();
    });

    it('a deleted Org is unknown to list and update, and deleting it again is a no-op', async () => {
      const b = makeBinding();
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      const kept = await createOrg(b, T1, { name: 'Kept', slug: 'kept' });
      await b.delete(T1, id);
      const page = await b.list(T1, {});
      expect(page.items.map((o) => o.id)).toEqual([kept]);
      expect(await b.update(T1, id, { name: 'Acme 2' })).toEqual({ kind: 'org-not-found' });
      await b.delete(T1, id);
      expect(await b.get(T1, kept)).toBeDefined();
    });

    it("a deleted Org's slug is free for a new Org", async () => {
      const b = makeBinding();
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      await b.delete(T1, id);
      const again = await createOrg(b, T1, { name: 'Acme again', slug: 'acme' });
      expect(again).not.toBe(id);
      expect((await b.get(T1, again))?.slug).toBe('acme');
      const other = await createOrg(b, T1, { name: 'Other', slug: 'other' });
      expect(await b.update(T1, other, { slug: 'acme' })).toEqual({
        kind: 'slug-conflict',
        slug: 'acme',
      });
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
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      expect(await b.get(T2, id)).toBeUndefined();
    });

    it('list on tenant B does not surface tenant-A orgs', async () => {
      const b = makeBinding();
      await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      await createOrg(b, T1, { name: 'Globex', slug: 'globex' });
      const t2Page = await b.list(T2, {});
      expect(t2Page.items).toEqual([]);
    });

    it('update on tenant B for tenant-A orgId → org-not-found', async () => {
      const b = makeBinding();
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      expect(await b.update(T2, id, { name: 'X' })).toEqual({ kind: 'org-not-found' });
      expect((await b.get(T1, id))?.name).toBe('Acme');
    });

    it('delete on tenant B for tenant-A orgId is a no-op (does not mutate A)', async () => {
      const b = makeBinding();
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
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
        created.push(await createOrg(b, T1, { name: `Org${i}`, slug: `org-${i}` }));
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
      await createOrg(b, T1, { name: 'Litigation', slug: 'lit' });
      await createOrg(b, T1, { name: 'Corporate', slug: 'corp' });
      await createOrg(b, T1, { name: 'Litigation-Sub', slug: 'lit-sub' });

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

    it('update on unknown orgId → org-not-found', async () => {
      const b = makeBinding();
      expect(await b.update(T1, unknown, { name: 'X' })).toEqual({ kind: 'org-not-found' });
    });

    it('delete on unknown orgId is a no-op', async () => {
      const b = makeBinding();
      await expect(b.delete(T1, unknown)).resolves.toBeUndefined();
    });
  });

  describe(`${label} — slug uniqueness`, () => {
    it('create with a slug the tenant already has → slug-conflict', async () => {
      const b = makeBinding();
      await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      expect(await b.create(T1, { name: 'Acme again', slug: 'acme' })).toEqual({
        kind: 'slug-conflict',
        slug: 'acme',
      });
      expect((await b.list(T1, {})).items).toHaveLength(1);
    });

    it('another tenant may use the same slug', async () => {
      const b = makeBinding();
      await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      expect((await b.create(T2, { name: 'Acme', slug: 'acme' })).kind).toBe('ok');
    });

    it("update to another org's slug → slug-conflict; the org is unchanged", async () => {
      const b = makeBinding();
      await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      const id = await createOrg(b, T1, { name: 'Globex', slug: 'globex' });
      expect(await b.update(T1, id, { slug: 'acme' })).toEqual({
        kind: 'slug-conflict',
        slug: 'acme',
      });
      expect((await b.get(T1, id))?.slug).toBe('globex');
    });

    it('update to its own slug → ok', async () => {
      const b = makeBinding();
      const id = await createOrg(b, T1, { name: 'Acme', slug: 'acme' });
      expect(await b.update(T1, id, { name: 'Acme Corp', slug: 'acme' })).toEqual({ kind: 'ok' });
    });
  });
}

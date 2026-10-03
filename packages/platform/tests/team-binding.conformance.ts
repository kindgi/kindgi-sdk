// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Conformance suite for `TeamBinding` + `TeamMembershipBinding`.
 *
 * Cases covered:
 * - CRUD happy paths for both team + membership shapes.
 * - Team creation with + without `orgId` (nullable FK).
 * - Membership `add` idempotency — adding an existing member does not
 *   silently mutate a stored differing role (mutation goes through
 *   `updateRole`).
 * - `listForUser` returns memberships across teams within a tenant.
 * - Cross-tenant isolation on every reachable read.
 */

import { describe, expect, it } from 'vitest';

import type { OrgId, TeamId, TenantId, UserId } from '@kindgi/types';

import type { TeamBinding, TeamMembershipBinding } from '../src/team-binding.js';

const T1 = 'tenant-1' as TenantId;
const T2 = 'tenant-2' as TenantId;
const U1 = 'user-1' as UserId;
const U2 = 'user-2' as UserId;
const ORG_A = 'org-a' as OrgId;

export function runTeamBindingConformance(
  makeBinding: () => {
    readonly teams: TeamBinding;
    readonly memberships: TeamMembershipBinding;
  },
  label = 'TeamBinding',
): void {
  describe(`${label} — team CRUD`, () => {
    it('creates + gets a team with orgId', async () => {
      const { teams } = makeBinding();
      const id = await teams.create(T1, {
        name: 'Litigation',
        slug: 'lit',
        orgId: ORG_A,
      });
      const got = await teams.get(T1, id);
      expect(got).toBeDefined();
      expect(got?.name).toBe('Litigation');
      expect(got?.orgId).toBe(ORG_A);
    });

    it('creates a cross-org team (no orgId)', async () => {
      const { teams } = makeBinding();
      const id = await teams.create(T1, { name: 'Cross', slug: 'cross' });
      const got = await teams.get(T1, id);
      expect(got?.orgId).toBeUndefined();
    });

    it('updates a team; orgId=null clears the FK', async () => {
      const { teams } = makeBinding();
      const id = await teams.create(T1, {
        name: 'Litigation',
        slug: 'lit',
        orgId: ORG_A,
      });
      await teams.update(T1, id, { orgId: null });
      const got = await teams.get(T1, id);
      expect(got?.orgId).toBeUndefined();
    });

    it('lists teams filtered by orgId', async () => {
      const { teams } = makeBinding();
      await teams.create(T1, { name: 'A', slug: 'a', orgId: ORG_A });
      await teams.create(T1, { name: 'B', slug: 'b' });
      const inOrg = await teams.list(T1, { orgId: ORG_A });
      expect(inOrg.items).toHaveLength(1);
      expect(inOrg.items[0]?.name).toBe('A');
    });

    it('deletes a team + cascades memberships', async () => {
      const { teams, memberships } = makeBinding();
      const id = await teams.create(T1, { name: 'X', slug: 'x' });
      await memberships.add(T1, { teamId: id, userId: U1, role: 'member' });
      await teams.delete(T1, id);
      const page = await memberships.listForUser(T1, U1, {});
      expect(page.items).toHaveLength(0);
    });
  });

  describe(`${label} — cross-tenant isolation`, () => {
    it('team get across tenants returns undefined', async () => {
      const { teams } = makeBinding();
      const id = await teams.create(T1, { name: 'X', slug: 'x' });
      expect(await teams.get(T2, id)).toBeUndefined();
    });

    it('team list across tenants does not leak', async () => {
      const { teams } = makeBinding();
      await teams.create(T1, { name: 'X', slug: 'x' });
      const page = await teams.list(T2, {});
      expect(page.items).toEqual([]);
    });

    it('adding a membership under wrong tenant errors', async () => {
      const { teams, memberships } = makeBinding();
      const id = await teams.create(T1, { name: 'X', slug: 'x' });
      await expect(
        memberships.add(T2, { teamId: id, userId: U1, role: 'member' }),
      ).rejects.toThrow();
    });

    it('listForUser across tenants only returns tenant-scoped memberships', async () => {
      const { teams, memberships } = makeBinding();
      const t1Team = await teams.create(T1, { name: 'A', slug: 'a' });
      const t2Team = await teams.create(T2, { name: 'B', slug: 'b' });
      await memberships.add(T1, { teamId: t1Team, userId: U1, role: 'member' });
      await memberships.add(T2, { teamId: t2Team, userId: U1, role: 'member' });
      const t1Page = await memberships.listForUser(T1, U1, {});
      expect(t1Page.items).toHaveLength(1);
      expect(t1Page.items[0]?.teamId).toBe(t1Team);
      const t2Page = await memberships.listForUser(T2, U1, {});
      expect(t2Page.items).toHaveLength(1);
      expect(t2Page.items[0]?.teamId).toBe(t2Team);
    });
  });

  describe(`${label} — membership idempotency`, () => {
    it('add on existing membership is a no-op (does NOT overwrite role)', async () => {
      const { teams, memberships } = makeBinding();
      const id = await teams.create(T1, { name: 'X', slug: 'x' });
      await memberships.add(T1, { teamId: id, userId: U1, role: 'admin' });
      // Re-add with a different role — should be a no-op, not a mutation.
      await memberships.add(T1, { teamId: id, userId: U1, role: 'member' });
      const page = await memberships.list(T1, id, {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.role).toBe('admin');
    });

    it('remove on missing membership is a no-op', async () => {
      const { teams, memberships } = makeBinding();
      const id = await teams.create(T1, { name: 'X', slug: 'x' });
      await expect(memberships.remove(T1, id, U1)).resolves.toBeUndefined();
    });

    it('updateRole on missing membership errors', async () => {
      const { teams, memberships } = makeBinding();
      const id = await teams.create(T1, { name: 'X', slug: 'x' });
      await expect(memberships.updateRole(T1, id, U1, 'admin')).rejects.toThrow();
    });

    it('updateRole on existing membership mutates the role', async () => {
      const { teams, memberships } = makeBinding();
      const id = await teams.create(T1, { name: 'X', slug: 'x' });
      await memberships.add(T1, { teamId: id, userId: U1, role: 'member' });
      await memberships.updateRole(T1, id, U1, 'admin');
      const page = await memberships.list(T1, id, {});
      expect(page.items[0]?.role).toBe('admin');
    });
  });

  describe(`${label} — listForUser across teams`, () => {
    it('returns every team the user belongs to in the tenant', async () => {
      const { teams, memberships } = makeBinding();
      const a = await teams.create(T1, { name: 'A', slug: 'a' });
      const b = await teams.create(T1, { name: 'B', slug: 'b' });
      const c = await teams.create(T1, { name: 'C', slug: 'c' });
      await memberships.add(T1, { teamId: a, userId: U1, role: 'member' });
      await memberships.add(T1, { teamId: b, userId: U1, role: 'admin' });
      await memberships.add(T1, { teamId: c, userId: U2, role: 'member' });
      const page = await memberships.listForUser(T1, U1, {});
      expect(page.items).toHaveLength(2);
      const teamIds = new Set<TeamId>(page.items.map((m) => m.teamId));
      expect(teamIds.has(a)).toBe(true);
      expect(teamIds.has(b)).toBe(true);
    });
  });
}

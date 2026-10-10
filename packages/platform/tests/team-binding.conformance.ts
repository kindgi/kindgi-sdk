// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Conformance suite for `TeamBinding` + `TeamMembershipBinding`.
 *
 * Cases covered:
 * - CRUD happy paths for both team + membership shapes.
 * - Team creation with + without `orgId` (nullable FK).
 * - Membership `add` idempotency — re-adding an existing member with
 *   their role is `ok`; with another role it's `membership-exists`,
 *   naming the role they hold, which is kept (mutation goes through
 *   `updateRole`).
 * - `listForUser` returns memberships across teams within a tenant.
 * - Cross-tenant isolation on every reachable read.
 * - Outcomes: `team-not-found` and `team-membership-not-found` from
 *   writes on a missing row, `slug-conflict` from a slug the tenant
 *   already has (another tenant may reuse it).
 */

import { describe, expect, it } from 'vitest';

import type { OrgId, TeamId, TenantId, UserId } from '@kindgi/types';

import type { TeamBinding, TeamMembershipBinding } from '../src/team-binding.js';
import type { TeamSpec } from '../src/types.js';

const T1 = 'tenant-1' as TenantId;
const T2 = 'tenant-2' as TenantId;
const U1 = 'user-1' as UserId;
const U2 = 'user-2' as UserId;
const ORG_A = 'org-a' as OrgId;
/** An org the binding doesn't know (T220), for the `checksOrgs` cases. */
export const CONFORMANCE_MISSING_ORG = 'org-missing' as OrgId;

/** Create a team the test expects to succeed; its id. */
async function createTeam(teams: TeamBinding, tenantId: TenantId, spec: TeamSpec): Promise<TeamId> {
  const outcome = await teams.create(tenantId, spec);
  if (outcome.kind !== 'ok')
    throw new Error(`expected the team to be created, got ${outcome.kind}`);
  return outcome.teamId;
}

export function runTeamBindingConformance(
  makeBinding: () => {
    readonly teams: TeamBinding;
    readonly memberships: TeamMembershipBinding;
  },
  label = 'TeamBinding',
  options: {
    /** The binding checks that an org exists (`CONFORMANCE_MISSING_ORG` doesn't). */
    readonly checksOrgs?: boolean;
  } = {},
): void {
  describe(`${label} — team CRUD`, () => {
    it('creates + gets a team with orgId', async () => {
      const { teams } = makeBinding();
      const id = await createTeam(teams, T1, {
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
      const id = await createTeam(teams, T1, { name: 'Cross', slug: 'cross' });
      const got = await teams.get(T1, id);
      expect(got?.orgId).toBeUndefined();
    });

    it('updates a team; orgId=null clears the FK', async () => {
      const { teams } = makeBinding();
      const id = await createTeam(teams, T1, {
        name: 'Litigation',
        slug: 'lit',
        orgId: ORG_A,
      });
      expect(await teams.update(T1, id, { orgId: null })).toEqual({ kind: 'ok' });
      const got = await teams.get(T1, id);
      expect(got?.orgId).toBeUndefined();
    });

    it('lists teams filtered by orgId', async () => {
      const { teams } = makeBinding();
      await createTeam(teams, T1, { name: 'A', slug: 'a', orgId: ORG_A });
      await createTeam(teams, T1, { name: 'B', slug: 'b' });
      const inOrg = await teams.list(T1, { orgId: ORG_A });
      expect(inOrg.items).toHaveLength(1);
      expect(inOrg.items[0]?.name).toBe('A');
    });

    it('deletes a team + cascades memberships', async () => {
      const { teams, memberships } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      await memberships.add(T1, { teamId: id, userId: U1, role: 'member' });
      await teams.delete(T1, id);
      const page = await memberships.listForUser(T1, U1, {});
      expect(page.items).toHaveLength(0);
    });
  });

  describe(`${label} — cross-tenant isolation`, () => {
    it('team get across tenants returns undefined', async () => {
      const { teams } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      expect(await teams.get(T2, id)).toBeUndefined();
    });

    it('team list across tenants does not leak', async () => {
      const { teams } = makeBinding();
      await createTeam(teams, T1, { name: 'X', slug: 'x' });
      const page = await teams.list(T2, {});
      expect(page.items).toEqual([]);
    });

    it('adding a membership under wrong tenant → team-not-found', async () => {
      const { teams, memberships } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      expect(await memberships.add(T2, { teamId: id, userId: U1, role: 'member' })).toEqual({
        kind: 'team-not-found',
      });
      expect((await memberships.list(T1, id, {})).items).toEqual([]);
    });

    it('update under wrong tenant → team-not-found', async () => {
      const { teams } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      expect(await teams.update(T2, id, { name: 'Y' })).toEqual({ kind: 'team-not-found' });
      expect((await teams.get(T1, id))?.name).toBe('X');
    });

    it('listForUser across tenants only returns tenant-scoped memberships', async () => {
      const { teams, memberships } = makeBinding();
      const t1Team = await createTeam(teams, T1, { name: 'A', slug: 'a' });
      const t2Team = await createTeam(teams, T2, { name: 'B', slug: 'b' });
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
    it('add on an existing membership keeps its role: `ok` for that role, `membership-exists` for another', async () => {
      const { teams, memberships } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      expect(await memberships.add(T1, { teamId: id, userId: U1, role: 'admin' })).toEqual({
        kind: 'ok',
      });
      expect(await memberships.add(T1, { teamId: id, userId: U1, role: 'admin' })).toEqual({
        kind: 'ok',
      });
      // Re-add with a different role: refused, naming the role held, not a mutation.
      expect(await memberships.add(T1, { teamId: id, userId: U1, role: 'member' })).toEqual({
        kind: 'membership-exists',
        role: 'admin',
      });
      const page = await memberships.list(T1, id, {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.role).toBe('admin');
    });

    it('remove on missing membership is a no-op', async () => {
      const { teams, memberships } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      await expect(memberships.remove(T1, id, U1)).resolves.toBeUndefined();
    });

    it('updateRole on missing membership → team-membership-not-found', async () => {
      const { teams, memberships } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      expect(await memberships.updateRole(T1, id, U1, 'admin')).toEqual({
        kind: 'team-membership-not-found',
      });
    });

    it('updateRole on a team in another tenant → team-not-found', async () => {
      const { teams, memberships } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      await memberships.add(T1, { teamId: id, userId: U1, role: 'member' });
      expect(await memberships.updateRole(T2, id, U1, 'admin')).toEqual({
        kind: 'team-not-found',
      });
    });

    it('updateRole on existing membership mutates the role', async () => {
      const { teams, memberships } = makeBinding();
      const id = await createTeam(teams, T1, { name: 'X', slug: 'x' });
      await memberships.add(T1, { teamId: id, userId: U1, role: 'member' });
      expect(await memberships.updateRole(T1, id, U1, 'admin')).toEqual({ kind: 'ok' });
      const page = await memberships.list(T1, id, {});
      expect(page.items[0]?.role).toBe('admin');
    });
  });

  describe(`${label} — listForUser across teams`, () => {
    it('returns every team the user belongs to in the tenant', async () => {
      const { teams, memberships } = makeBinding();
      const a = await createTeam(teams, T1, { name: 'A', slug: 'a' });
      const b = await createTeam(teams, T1, { name: 'B', slug: 'b' });
      const c = await createTeam(teams, T1, { name: 'C', slug: 'c' });
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

  describe(`${label} — slug uniqueness`, () => {
    it('create with a slug the tenant already has → slug-conflict', async () => {
      const { teams } = makeBinding();
      await createTeam(teams, T1, { name: 'Litigation', slug: 'lit' });
      expect(await teams.create(T1, { name: 'Litigation 2', slug: 'lit' })).toEqual({
        kind: 'slug-conflict',
        slug: 'lit',
      });
      expect((await teams.list(T1, {})).items).toHaveLength(1);
    });

    it('another tenant may use the same slug', async () => {
      const { teams } = makeBinding();
      await createTeam(teams, T1, { name: 'Litigation', slug: 'lit' });
      expect((await teams.create(T2, { name: 'Litigation', slug: 'lit' })).kind).toBe('ok');
    });

    it("update to another team's slug → slug-conflict; the team is unchanged", async () => {
      const { teams } = makeBinding();
      await createTeam(teams, T1, { name: 'A', slug: 'a' });
      const id = await createTeam(teams, T1, { name: 'B', slug: 'b' });
      expect(await teams.update(T1, id, { slug: 'a' })).toEqual({
        kind: 'slug-conflict',
        slug: 'a',
      });
      expect((await teams.get(T1, id))?.slug).toBe('b');
    });
  });

  if (options.checksOrgs === true) {
    describe(`${label} — an org that isn't the tenant's (T220)`, () => {
      it('creating a team in it: org-not-found, and nothing is created', async () => {
        const { teams } = makeBinding();
        expect(
          await teams.create(T1, { name: 'T', slug: 't', orgId: CONFORMANCE_MISSING_ORG }),
        ).toEqual({ kind: 'org-not-found', orgId: CONFORMANCE_MISSING_ORG });
        expect((await teams.list(T1, { orgId: CONFORMANCE_MISSING_ORG })).items).toEqual([]);
      });

      it('moving a team to it: org-not-found, and the team stays where it was', async () => {
        const { teams } = makeBinding();
        const id = await createTeam(teams, T1, { name: 'T', slug: 't', orgId: ORG_A });
        expect(await teams.update(T1, id, { orgId: CONFORMANCE_MISSING_ORG })).toEqual({
          kind: 'org-not-found',
          orgId: CONFORMANCE_MISSING_ORG,
        });
        expect((await teams.get(T1, id))?.orgId).toBe(ORG_A);
      });
    });
  }
}

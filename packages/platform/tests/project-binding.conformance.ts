// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Conformance suite for `ProjectBinding` + `ProjectMembershipBinding`
 * + `TeamProjectGrantBinding` (the three project-related bindings the
 * in-memory reference adapter co-locates in one factory).
 *
 * Cases covered:
 * - CRUD happy paths.
 * - `getDefault` returns the tenant's Default row when `isDefault=true`.
 * - `isDefault` uniqueness guardrail — creating a second Default in
 *   the same tenant rejects (in-memory adapter enforces at write
 *   time; Postgres impl enforces via partial-unique-index).
 * - `listForUser` aggregates memberships across projects.
 * - Cross-tenant isolation on every reachable read.
 */

import { describe, expect, it } from 'vitest';

import type { OrgId, ProjectId, TeamId, TenantId, UserId } from '@kindgi/types';

import type { ProjectBinding, ProjectMembershipBinding } from '../src/project-binding.js';
import type { TeamProjectGrantBinding } from '../src/team-project-grant-binding.js';

const T1 = 'tenant-1' as TenantId;
const T2 = 'tenant-2' as TenantId;
const U1 = 'user-1' as UserId;
const U2 = 'user-2' as UserId;
const TEAM_A = 'team-A' as TeamId;
const TEAM_B = 'team-B' as TeamId;
const ORG_A = 'org-A' as OrgId;

export function runProjectBindingConformance(
  makeBinding: () => {
    readonly projects: ProjectBinding;
    readonly memberships: ProjectMembershipBinding;
    readonly grants: TeamProjectGrantBinding;
  },
  label = 'ProjectBinding',
): void {
  describe(`${label} — project CRUD`, () => {
    it('creates + gets a project', async () => {
      const { projects } = makeBinding();
      const id = await projects.create(T1, { name: 'Matter #1', slug: 'm1' });
      const got = await projects.get(T1, id);
      expect(got?.name).toBe('Matter #1');
      expect(got?.isDefault).toBe(false);
    });

    it('lists projects filtered by orgId', async () => {
      const { projects } = makeBinding();
      await projects.create(T1, { name: 'A', slug: 'a', orgId: ORG_A });
      await projects.create(T1, { name: 'B', slug: 'b' });
      const inOrg = await projects.list(T1, { orgId: ORG_A });
      expect(inOrg.items).toHaveLength(1);
      expect(inOrg.items[0]?.name).toBe('A');
    });

    it('updates a project', async () => {
      const { projects } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      await projects.update(T1, id, { name: 'A-updated' });
      const got = await projects.get(T1, id);
      expect(got?.name).toBe('A-updated');
    });

    it('deletes a project + cascades memberships + grants', async () => {
      const { projects, memberships, grants } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      await memberships.add(T1, { projectId: id, userId: U1, role: 'editor' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'editor' });
      await projects.delete(T1, id);
      const mPage = await memberships.listForUser(T1, U1, {});
      expect(mPage.items).toHaveLength(0);
      const gPage = await grants.listForTeam(T1, TEAM_A, {});
      expect(gPage.items).toHaveLength(0);
    });
  });

  describe(`${label} — Default project`, () => {
    it('getDefault returns undefined before any Default is created', async () => {
      const { projects } = makeBinding();
      expect(await projects.getDefault(T1)).toBeUndefined();
    });

    it('getDefault returns the isDefault=true row', async () => {
      const { projects } = makeBinding();
      const id = await projects.create(T1, {
        name: 'Default',
        slug: 'default',
        isDefault: true,
      });
      const got = await projects.getDefault(T1);
      expect(got).toBeDefined();
      expect(got?.id).toBe(id);
      expect(got?.isDefault).toBe(true);
    });

    it('isDefault uniqueness — a second Default in the same tenant errors', async () => {
      const { projects } = makeBinding();
      await projects.create(T1, { name: 'D1', slug: 'd1', isDefault: true });
      await expect(
        projects.create(T1, { name: 'D2', slug: 'd2', isDefault: true }),
      ).rejects.toThrow();
    });

    it('a Default in tenant A does NOT block a Default in tenant B', async () => {
      const { projects } = makeBinding();
      await projects.create(T1, { name: 'D1', slug: 'd1', isDefault: true });
      const d2 = await projects.create(T2, {
        name: 'D2',
        slug: 'd2',
        isDefault: true,
      });
      const got = await projects.getDefault(T2);
      expect(got?.id).toBe(d2);
    });
  });

  describe(`${label} — cross-tenant isolation`, () => {
    it('project get across tenants returns undefined', async () => {
      const { projects } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      expect(await projects.get(T2, id)).toBeUndefined();
    });

    it('project list across tenants does not leak', async () => {
      const { projects } = makeBinding();
      await projects.create(T1, { name: 'A', slug: 'a' });
      const page = await projects.list(T2, {});
      expect(page.items).toEqual([]);
    });

    it('project-membership add under wrong tenant errors', async () => {
      const { projects, memberships } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      await expect(
        memberships.add(T2, { projectId: id, userId: U1, role: 'editor' }),
      ).rejects.toThrow();
    });

    it('team-project grant add under wrong tenant errors', async () => {
      const { projects, grants } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      await expect(
        grants.add(T2, { teamId: TEAM_A, projectId: id, role: 'editor' }),
      ).rejects.toThrow();
    });

    it('listForUser across tenants only returns tenant-scoped rows', async () => {
      const { projects, memberships } = makeBinding();
      const p1 = await projects.create(T1, { name: 'A', slug: 'a' });
      const p2 = await projects.create(T2, { name: 'B', slug: 'b' });
      await memberships.add(T1, { projectId: p1, userId: U1, role: 'editor' });
      await memberships.add(T2, { projectId: p2, userId: U1, role: 'editor' });
      const t1Page = await memberships.listForUser(T1, U1, {});
      expect(t1Page.items).toHaveLength(1);
      expect(t1Page.items[0]?.projectId).toBe(p1);
    });
  });

  describe(`${label} — membership + grant idempotency`, () => {
    it('project-membership add is idempotent (does not overwrite role)', async () => {
      const { projects, memberships } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      await memberships.add(T1, { projectId: id, userId: U1, role: 'owner' });
      await memberships.add(T1, { projectId: id, userId: U1, role: 'viewer' });
      const page = await memberships.list(T1, id, {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.role).toBe('owner');
    });

    it('grant add is idempotent', async () => {
      const { projects, grants } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'owner' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'viewer' });
      const page = await grants.listForProject(T1, id, {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.role).toBe('owner');
    });

    it('grant updateRole mutates the role', async () => {
      const { projects, grants } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'editor' });
      await grants.updateRole(T1, TEAM_A, id, 'owner');
      const page = await grants.listForTeam(T1, TEAM_A, {});
      expect(page.items[0]?.role).toBe('owner');
    });
  });

  describe(`${label} — listForUser aggregates across projects`, () => {
    it('returns every direct-grant project the user has', async () => {
      const { projects, memberships } = makeBinding();
      const a = await projects.create(T1, { name: 'A', slug: 'a' });
      const b = await projects.create(T1, { name: 'B', slug: 'b' });
      const c = await projects.create(T1, { name: 'C', slug: 'c' });
      await memberships.add(T1, { projectId: a, userId: U1, role: 'editor' });
      await memberships.add(T1, { projectId: b, userId: U1, role: 'viewer' });
      await memberships.add(T1, { projectId: c, userId: U2, role: 'editor' });
      const page = await memberships.listForUser(T1, U1, {});
      expect(page.items).toHaveLength(2);
      const projIds = new Set<ProjectId>(page.items.map((m) => m.projectId));
      expect(projIds.has(a)).toBe(true);
      expect(projIds.has(b)).toBe(true);
    });
  });

  describe(`${label} — grant listForProject + listForTeam`, () => {
    it('listForProject returns every team-grant on the project', async () => {
      const { projects, grants } = makeBinding();
      const id = await projects.create(T1, { name: 'A', slug: 'a' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'editor' });
      await grants.add(T1, { teamId: TEAM_B, projectId: id, role: 'viewer' });
      const page = await grants.listForProject(T1, id, {});
      expect(page.items).toHaveLength(2);
    });

    it('listForTeam returns every project the team has a grant on', async () => {
      const { projects, grants } = makeBinding();
      const a = await projects.create(T1, { name: 'A', slug: 'a' });
      const b = await projects.create(T1, { name: 'B', slug: 'b' });
      await grants.add(T1, { teamId: TEAM_A, projectId: a, role: 'editor' });
      await grants.add(T1, { teamId: TEAM_A, projectId: b, role: 'viewer' });
      const page = await grants.listForTeam(T1, TEAM_A, {});
      expect(page.items).toHaveLength(2);
    });
  });
}

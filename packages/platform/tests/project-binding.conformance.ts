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
 *   the same tenant resolves to `project-default-already-exists`
 *   (in-memory adapter enforces at write time; Postgres impl enforces
 *   via partial-unique-index).
 * - Slug uniqueness within an org (and, for projects without an org,
 *   among those): `create` and `update` (a new slug, or a move to
 *   another org) resolve to `slug-conflict`; another org, or another
 *   tenant, may reuse the slug.
 * - `project-not-found` / `project-membership-not-found` outcomes from
 *   writes on a missing row.
 * - `listForUser` aggregates memberships across projects.
 * - Cross-tenant isolation on every reachable read.
 */

import { describe, expect, it } from 'vitest';

import type { OrgId, ProjectId, TeamId, TenantId, UserId } from '@kindgi/types';

import type { ProjectBinding, ProjectMembershipBinding } from '../src/project-binding.js';
import type { TeamProjectGrantBinding } from '../src/team-project-grant-binding.js';
import type { ProjectSpec } from '../src/types.js';

const T1 = 'tenant-1' as TenantId;
const T2 = 'tenant-2' as TenantId;
const U1 = 'user-1' as UserId;
const U2 = 'user-2' as UserId;
const TEAM_A = 'team-A' as TeamId;
const TEAM_B = 'team-B' as TeamId;
const ORG_A = 'org-A' as OrgId;
const ORG_B = 'org-B' as OrgId;
/**
 * An org the binding doesn't know (T220), for the `checksOrgs` cases: a
 * binding that checks orgs is made so this one isn't the tenant's.
 */
export const CONFORMANCE_MISSING_ORG = 'org-missing' as OrgId;

/** Create a project the test expects to succeed; its id. */
async function createProject(
  projects: ProjectBinding,
  tenantId: TenantId,
  spec: ProjectSpec,
): Promise<ProjectId> {
  const outcome = await projects.create(tenantId, spec);
  if (outcome.kind !== 'ok') {
    throw new Error(`expected the project to be created, got ${outcome.kind}`);
  }
  return outcome.projectId;
}

export function runProjectBindingConformance(
  makeBinding: () => {
    readonly projects: ProjectBinding;
    readonly memberships: ProjectMembershipBinding;
    readonly grants: TeamProjectGrantBinding;
    /**
     * With `productionLimit`: set the tenant's limit on projects in
     * production (`undefined` for none) where this binding reads it.
     */
    readonly setProductionLimit?: (tenantId: TenantId, limit: number | undefined) => Promise<void>;
    /**
     * With `checksEnvironmentOrders`: put the project in an environment order
     * and return that order's id, or clear it from its order. The store backs
     * this however it holds orders — the in-memory adapter a map, the durable
     * one a `project_stages` row — so the one guard suite runs on both.
     */
    readonly putInEnvironmentOrder?: (tenantId: TenantId, projectId: ProjectId) => Promise<string>;
    readonly clearEnvironmentOrder?: (tenantId: TenantId, projectId: ProjectId) => Promise<void>;
  },
  label = 'ProjectBinding',
  options: {
    /**
     * The binding checks that an org exists (`CONFORMANCE_MISSING_ORG`
     * doesn't): a project created in or moved to a missing org is
     * `org-not-found`.
     */
    readonly checksOrgs?: boolean;
    /**
     * The binding implements `setProduction`: a project put in production
     * and taken out, with repeats changing nothing.
     */
    readonly production?: boolean;
    /**
     * Its `setProduction` reads the tenant's limit (set through
     * `setProductionLimit`) and counts against it: only the tenant's own
     * projects, only going in, the limit as it is at the call, and two at
     * once can't both take the last place.
     */
    readonly productionLimit?: boolean;
    /**
     * The binding implements `setRepoConnection`: a connection set, read
     * back on the project, kept by an update, and cleared, with repeats
     * changing nothing.
     */
    readonly repoConnection?: boolean;
    /**
     * The binding refuses to delete, or to move to another parent, a project
     * that is a member of an environment order (`project-in-environment-order`),
     * while allowing a rename or slug change. Needs `putInEnvironmentOrder` +
     * `clearEnvironmentOrder` on the binding.
     */
    readonly checksEnvironmentOrders?: boolean;
  } = {},
): void {
  describe(`${label} — project CRUD`, () => {
    it('creates + gets a project', async () => {
      const { projects } = makeBinding();
      const id = await createProject(projects, T1, { name: 'Matter #1', slug: 'm1' });
      const got = await projects.get(T1, id);
      expect(got?.name).toBe('Matter #1');
      expect(got?.isDefault).toBe(false);
    });

    it('lists projects filtered by orgId', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'A', slug: 'a', orgId: ORG_A });
      await createProject(projects, T1, { name: 'B', slug: 'b' });
      const inOrg = await projects.list(T1, { orgId: ORG_A });
      expect(inOrg.items).toHaveLength(1);
      expect(inOrg.items[0]?.name).toBe('A');
    });

    it('updates a project', async () => {
      const { projects } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      expect(await projects.update(T1, id, { name: 'A-updated' })).toEqual({ kind: 'ok' });
      const got = await projects.get(T1, id);
      expect(got?.name).toBe('A-updated');
    });

    it("sorts end users' corrections only once a patch turns it on, and keeps it through other patches", async () => {
      const { projects } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      expect((await projects.get(T1, id))?.sortEndUserCorrections).toBeUndefined();
      await projects.update(T1, id, { sortEndUserCorrections: true });
      expect((await projects.get(T1, id))?.sortEndUserCorrections).toBe(true);
      await projects.update(T1, id, { name: 'A-renamed' });
      expect((await projects.get(T1, id))?.sortEndUserCorrections).toBe(true);
      await projects.update(T1, id, { sortEndUserCorrections: false });
      expect((await projects.get(T1, id))?.sortEndUserCorrections).toBeUndefined();
    });

    it('deletes a project + cascades memberships + grants', async () => {
      const { projects, memberships, grants } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      await memberships.add(T1, { projectId: id, userId: U1, role: 'editor' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'editor' });
      expect(await projects.delete(T1, id)).toEqual({ kind: 'ok' });
      const mPage = await memberships.listForUser(T1, U1, {});
      expect(mPage.items).toHaveLength(0);
      const gPage = await grants.listForTeam(T1, TEAM_A, {});
      expect(gPage.items).toHaveLength(0);
    });
  });

  if (options.checksEnvironmentOrders === true) {
    describe(`${label} — environment-order guard`, () => {
      function orderOps(binding: ReturnType<typeof makeBinding>) {
        const put = binding.putInEnvironmentOrder;
        const clear = binding.clearEnvironmentOrder;
        if (put === undefined || clear === undefined) {
          throw new Error(
            'checksEnvironmentOrders needs putInEnvironmentOrder + clearEnvironmentOrder',
          );
        }
        return { put, clear };
      }

      it('refuses to delete a project in an environment order; the project stays', async () => {
        const binding = makeBinding();
        const { projects } = binding;
        const { put } = orderOps(binding);
        const id = await createProject(projects, T1, { name: 'Staging', slug: 'staging' });
        const orderId = await put(T1, id);
        expect(await projects.delete(T1, id)).toEqual({
          kind: 'project-in-environment-order',
          orderId,
        });
        expect((await projects.get(T1, id))?.id).toBe(id);
      });

      it('refuses to move a project in an environment order to another parent', async () => {
        const binding = makeBinding();
        const { projects } = binding;
        const { put } = orderOps(binding);
        // A project under the tenant (no org); the move adds a parent, refused.
        const id = await createProject(projects, T1, { name: 'Prod', slug: 'prod' });
        const orderId = await put(T1, id);
        expect(await projects.update(T1, id, { orgId: ORG_A })).toEqual({
          kind: 'project-in-environment-order',
          orderId,
        });
        expect((await projects.get(T1, id))?.orgId).toBeUndefined();
      });

      it('allows a rename or slug change for a project in an environment order', async () => {
        const binding = makeBinding();
        const { projects } = binding;
        const { put } = orderOps(binding);
        const id = await createProject(projects, T1, { name: 'Dev', slug: 'dev' });
        await put(T1, id);
        expect(await projects.update(T1, id, { name: 'Dev-renamed', slug: 'dev-2' })).toEqual({
          kind: 'ok',
        });
        const got = await projects.get(T1, id);
        expect(got?.name).toBe('Dev-renamed');
        expect(got?.slug).toBe('dev-2');
      });

      it("allows a patch naming an org-less project's current (no) org — a no-op move, not a refusal", async () => {
        const binding = makeBinding();
        const { projects } = binding;
        const { put } = orderOps(binding);
        // The project has no org; `orgId: null` names that same parent, so the
        // patch isn't a move and isn't refused — only an actual change of parent
        // is. A form that always sends `orgId` can still rename an ordered project.
        const id = await createProject(projects, T1, { name: 'Staging', slug: 'staging' });
        const orderId = await put(T1, id);
        expect(await projects.update(T1, id, { name: 'Staging-2', orgId: null })).toEqual({
          kind: 'ok',
        });
        const afterNoOrg = await projects.get(T1, id);
        expect(afterNoOrg?.name).toBe('Staging-2');
        expect(afterNoOrg?.orgId).toBeUndefined();
        // Still in its order: an actual move is still refused, naming the order.
        expect(await projects.update(T1, id, { orgId: ORG_A })).toEqual({
          kind: 'project-in-environment-order',
          orderId,
        });
      });

      it("allows a patch naming an org project's current org, and refuses it leaving the order", async () => {
        const binding = makeBinding();
        const { projects } = binding;
        const { put } = orderOps(binding);
        // The project is under ORG_A; `orgId: ORG_A` names that same parent — a
        // no-op move, allowed — while leaving the org (`orgId: null`) is a real
        // move and refused while the project is in the order.
        const id = await createProject(projects, T1, { name: 'Prod', slug: 'prod', orgId: ORG_A });
        const orderId = await put(T1, id);
        expect(await projects.update(T1, id, { name: 'Prod-2', orgId: ORG_A })).toEqual({
          kind: 'ok',
        });
        const afterSameOrg = await projects.get(T1, id);
        expect(afterSameOrg?.name).toBe('Prod-2');
        expect(afterSameOrg?.orgId).toBe(ORG_A);
        expect(await projects.update(T1, id, { orgId: null })).toEqual({
          kind: 'project-in-environment-order',
          orderId,
        });
      });

      it('deletes a project once it is cleared from its order', async () => {
        const binding = makeBinding();
        const { projects } = binding;
        const { put, clear } = orderOps(binding);
        const id = await createProject(projects, T1, { name: 'Staging', slug: 'staging' });
        await put(T1, id);
        await clear(T1, id);
        expect(await projects.delete(T1, id)).toEqual({ kind: 'ok' });
        expect(await projects.get(T1, id)).toBeUndefined();
      });
    });
  }

  if (options.production === true) {
    describe(`${label} — production`, () => {
      function setter(projects: ProjectBinding) {
        const set = projects.setProduction?.bind(projects);
        if (set === undefined) throw new Error('this binding has no setProduction');
        return set;
      }

      it('puts a project in production, then takes it out', async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'Shop', slug: 'shop' });
        const set = setter(projects);
        const on = await set(T1, id, true);
        expect(on.kind).toBe('ok');
        const since = on.kind === 'ok' ? on.productionSince : null;
        expect(typeof since).toBe('string');
        expect(on.kind === 'ok' && on.changed).toBe(true);
        expect((await projects.get(T1, id))?.productionSince).toBe(since);
        expect((await projects.list(T1, {})).items.find((p) => p.id === id)?.productionSince).toBe(
          since,
        );

        expect(await set(T1, id, false)).toEqual({
          kind: 'ok',
          productionSince: null,
          changed: true,
        });
        expect((await projects.get(T1, id))?.productionSince).toBeUndefined();
      });

      it('a repeat changes nothing, and keeps the first productionSince', async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'Shop', slug: 'shop' });
        const set = setter(projects);
        const first = await set(T1, id, true);
        const since = first.kind === 'ok' ? first.productionSince : null;
        expect(await set(T1, id, true)).toEqual({
          kind: 'ok',
          productionSince: since,
          changed: false,
        });
        await set(T1, id, false);
        expect(await set(T1, id, false)).toEqual({
          kind: 'ok',
          productionSince: null,
          changed: false,
        });
      });

      it('an update keeps productionSince', async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'Shop', slug: 'shop' });
        const on = await setter(projects)(T1, id, true);
        expect(await projects.update(T1, id, { name: 'Shop, renamed' })).toEqual({ kind: 'ok' });
        expect((await projects.get(T1, id))?.productionSince).toBe(
          on.kind === 'ok' ? on.productionSince : 'not ok',
        );
      });

      it("an unknown project, or another tenant's: project-not-found, nothing changed", async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'Shop', slug: 'shop' });
        const set = setter(projects);
        expect(await set(T1, 'project-missing' as ProjectId, true)).toEqual({
          kind: 'project-not-found',
        });
        expect(await set(T2, id, true)).toEqual({ kind: 'project-not-found' });
        expect((await projects.get(T1, id))?.productionSince).toBeUndefined();
      });
    });
  }

  if (options.repoConnection === true) {
    describe(`${label} — repo connection`, () => {
      function setter(projects: ProjectBinding) {
        const set = projects.setRepoConnection?.bind(projects);
        if (set === undefined) throw new Error('this binding has no setRepoConnection');
        return set;
      }

      it('sets a connection, reads it back, and clears it', async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'Shop', slug: 'shop' });
        const set = setter(projects);
        expect(await set(T1, id, 'conn-1')).toEqual({
          kind: 'ok',
          repoConnectionId: 'conn-1',
          changed: true,
        });
        expect((await projects.get(T1, id))?.repoConnectionId).toBe('conn-1');
        expect((await projects.list(T1, {})).items.find((p) => p.id === id)?.repoConnectionId).toBe(
          'conn-1',
        );
        expect(await set(T1, id, 'conn-2')).toEqual({
          kind: 'ok',
          repoConnectionId: 'conn-2',
          changed: true,
        });

        expect(await set(T1, id, null)).toEqual({
          kind: 'ok',
          repoConnectionId: null,
          changed: true,
        });
        expect((await projects.get(T1, id))?.repoConnectionId).toBeUndefined();
      });

      it('a repeat changes nothing', async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'Shop', slug: 'shop' });
        const set = setter(projects);
        await set(T1, id, 'conn-1');
        expect(await set(T1, id, 'conn-1')).toEqual({
          kind: 'ok',
          repoConnectionId: 'conn-1',
          changed: false,
        });
        await set(T1, id, null);
        expect(await set(T1, id, null)).toEqual({
          kind: 'ok',
          repoConnectionId: null,
          changed: false,
        });
      });

      it('an update keeps the connection', async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'Shop', slug: 'shop' });
        await setter(projects)(T1, id, 'conn-1');
        expect(await projects.update(T1, id, { name: 'Shop, renamed' })).toEqual({ kind: 'ok' });
        expect((await projects.get(T1, id))?.repoConnectionId).toBe('conn-1');
      });

      it("an unknown project, or another tenant's: project-not-found, nothing changed", async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'Shop', slug: 'shop' });
        const set = setter(projects);
        expect(await set(T1, 'project-missing' as ProjectId, 'conn-1')).toEqual({
          kind: 'project-not-found',
        });
        expect(await set(T2, id, 'conn-1')).toEqual({ kind: 'project-not-found' });
        expect((await projects.get(T1, id))?.repoConnectionId).toBeUndefined();
      });
    });
  }

  if (options.productionLimit === true) {
    describe(`${label} — the limit on projects in production`, () => {
      async function threeProjects(projects: ProjectBinding, tenant: TenantId) {
        const ids: ProjectId[] = [];
        for (const name of ['One', 'Two', 'Three']) {
          ids.push(await createProject(projects, tenant, { name, slug: name.toLowerCase() }));
        }
        return ids as [ProjectId, ProjectId, ProjectId];
      }

      /** A fresh binding, its `setProduction`, and the setter of the tenant's limit. */
      function limited() {
        const made = makeBinding();
        const set = made.projects.setProduction?.bind(made.projects);
        if (set === undefined) throw new Error('this binding has no setProduction');
        const limit = made.setProductionLimit;
        if (limit === undefined) throw new Error('productionLimit needs setProductionLimit');
        return { projects: made.projects, set, limit };
      }

      it('at the limit: limit-reached, and nothing changes', async () => {
        const { projects, set, limit } = limited();
        const [a, b, c] = await threeProjects(projects, T1);
        await limit(T1, 2);
        expect((await set(T1, a, true)).kind).toBe('ok');
        expect((await set(T1, b, true)).kind).toBe('ok');
        expect(await set(T1, c, true)).toEqual({
          kind: 'limit-reached',
          projectsInProduction: 2,
          inProduction: 2,
        });
        expect((await projects.get(T1, c))?.productionSince).toBeUndefined();
      });

      it("only the tenant's own projects count", async () => {
        const { projects, set, limit } = limited();
        const theirs = await threeProjects(projects, T2);
        for (const id of theirs) await set(T2, id, true);
        const [mine] = await threeProjects(projects, T1);
        await limit(T1, 1);
        expect((await set(T1, mine, true)).kind).toBe('ok');
      });

      it('a repeat, and taking one out, are never counted', async () => {
        const { projects, set, limit } = limited();
        const [a, b] = await threeProjects(projects, T1);
        await limit(T1, 1);
        expect((await set(T1, a, true)).kind).toBe('ok');
        expect(await set(T1, a, true)).toMatchObject({ kind: 'ok', changed: false });
        expect(await set(T1, a, false)).toMatchObject({ kind: 'ok', changed: true });
        expect((await set(T1, b, true)).kind).toBe('ok');
      });

      it('the limit as it is at the call: raised, lowered, then unset', async () => {
        const { projects, set, limit } = limited();
        const [a, b, c] = await threeProjects(projects, T1);
        await limit(T1, 1);
        expect((await set(T1, a, true)).kind).toBe('ok');
        expect((await set(T1, b, true)).kind).toBe('limit-reached');
        await limit(T1, 2);
        expect((await set(T1, b, true)).kind).toBe('ok');
        await limit(T1, 1);
        expect(await set(T1, c, true)).toEqual({
          kind: 'limit-reached',
          projectsInProduction: 1,
          inProduction: 2,
        });
        await limit(T1, undefined);
        expect((await set(T1, c, true)).kind).toBe('ok');
      });

      it('a limit below the count refuses the next, and takes none out', async () => {
        const { projects, set, limit } = limited();
        const [a, b, c] = await threeProjects(projects, T1);
        await set(T1, a, true);
        await set(T1, b, true);
        await limit(T1, 1);
        expect(await set(T1, c, true)).toEqual({
          kind: 'limit-reached',
          projectsInProduction: 1,
          inProduction: 2,
        });
        expect((await projects.get(T1, a))?.productionSince).toBeDefined();
        expect((await projects.get(T1, b))?.productionSince).toBeDefined();
      });

      it('two projects put in production at once, with one place left: one goes in', async () => {
        const { projects, set, limit } = limited();
        const [a, b] = await threeProjects(projects, T1);
        await limit(T1, 1);
        const outcomes = await Promise.all([set(T1, a, true), set(T1, b, true)]);
        expect(outcomes.map((o) => o.kind).sort()).toEqual(['limit-reached', 'ok']);
        const live = [await projects.get(T1, a), await projects.get(T1, b)].filter(
          (p) => p?.productionSince !== undefined,
        );
        expect(live).toHaveLength(1);
      });
    });
  }

  describe(`${label} — Default project`, () => {
    it('getDefault returns undefined before any Default is created', async () => {
      const { projects } = makeBinding();
      expect(await projects.getDefault(T1)).toBeUndefined();
    });

    it('getDefault returns the isDefault=true row', async () => {
      const { projects } = makeBinding();
      const id = await createProject(projects, T1, {
        name: 'Default',
        slug: 'default',
        isDefault: true,
      });
      const got = await projects.getDefault(T1);
      expect(got).toBeDefined();
      expect(got?.id).toBe(id);
      expect(got?.isDefault).toBe(true);
    });

    it('isDefault uniqueness — a second Default in the same tenant → project-default-already-exists', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'D1', slug: 'd1', isDefault: true });
      expect(await projects.create(T1, { name: 'D2', slug: 'd2', isDefault: true })).toEqual({
        kind: 'project-default-already-exists',
      });
    });

    it('isDefault with only the slug taken → slug-conflict', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'P', slug: 'p' });
      expect(await projects.create(T1, { name: 'D', slug: 'p', isDefault: true })).toEqual({
        kind: 'slug-conflict',
        slug: 'p',
      });
      expect(await projects.getDefault(T1)).toBeUndefined();
    });

    it('a Default in tenant A does NOT block a Default in tenant B', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'D1', slug: 'd1', isDefault: true });
      const d2 = await createProject(projects, T2, {
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
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      expect(await projects.get(T2, id)).toBeUndefined();
    });

    it('project list across tenants does not leak', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'A', slug: 'a' });
      const page = await projects.list(T2, {});
      expect(page.items).toEqual([]);
    });

    it('project-membership add under wrong tenant → project-not-found', async () => {
      const { projects, memberships } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      expect(await memberships.add(T2, { projectId: id, userId: U1, role: 'editor' })).toEqual({
        kind: 'project-not-found',
      });
      expect((await memberships.list(T1, id, {})).items).toEqual([]);
    });

    it('project update under wrong tenant → project-not-found', async () => {
      const { projects } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      expect(await projects.update(T2, id, { name: 'B' })).toEqual({ kind: 'project-not-found' });
      expect((await projects.get(T1, id))?.name).toBe('A');
    });

    it('membership updateRole under wrong tenant → project-not-found', async () => {
      const { projects, memberships } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      await memberships.add(T1, { projectId: id, userId: U1, role: 'editor' });
      expect(await memberships.updateRole(T2, id, U1, 'owner')).toEqual({
        kind: 'project-not-found',
      });
    });

    it('team-project grant add under wrong tenant errors', async () => {
      const { projects, grants } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      await expect(
        grants.add(T2, { teamId: TEAM_A, projectId: id, role: 'editor' }),
      ).rejects.toThrow();
    });

    it('listForUser across tenants only returns tenant-scoped rows', async () => {
      const { projects, memberships } = makeBinding();
      const p1 = await createProject(projects, T1, { name: 'A', slug: 'a' });
      const p2 = await createProject(projects, T2, { name: 'B', slug: 'b' });
      await memberships.add(T1, { projectId: p1, userId: U1, role: 'editor' });
      await memberships.add(T2, { projectId: p2, userId: U1, role: 'editor' });
      const t1Page = await memberships.listForUser(T1, U1, {});
      expect(t1Page.items).toHaveLength(1);
      expect(t1Page.items[0]?.projectId).toBe(p1);
    });
  });

  describe(`${label} — membership + grant idempotency`, () => {
    it('project-membership add keeps the role held: `ok` for that role, `membership-exists` for another', async () => {
      const { projects, memberships } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      expect(await memberships.add(T1, { projectId: id, userId: U1, role: 'owner' })).toEqual({
        kind: 'ok',
      });
      expect(await memberships.add(T1, { projectId: id, userId: U1, role: 'owner' })).toEqual({
        kind: 'ok',
      });
      expect(await memberships.add(T1, { projectId: id, userId: U1, role: 'viewer' })).toEqual({
        kind: 'membership-exists',
        role: 'owner',
      });
      const page = await memberships.list(T1, id, {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.role).toBe('owner');
    });

    it('a team grant reads back with `get` (where the binding has it), with when it was given', async () => {
      const { projects, grants } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'editor' });
      if (grants.get === undefined) return;
      const got = await grants.get(T1, TEAM_A, id);
      expect(got).toMatchObject({ teamId: TEAM_A, projectId: id, role: 'editor' });
      expect(typeof got?.grantedAt).toBe('string');
      expect(await grants.get(T1, TEAM_B, id)).toBeUndefined();
      expect(await grants.get(T2, TEAM_A, id)).toBeUndefined();
    });

    it('project-membership updateRole mutates the role', async () => {
      const { projects, memberships } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      await memberships.add(T1, { projectId: id, userId: U1, role: 'editor' });
      expect(await memberships.updateRole(T1, id, U1, 'owner')).toEqual({ kind: 'ok' });
      expect((await memberships.list(T1, id, {})).items[0]?.role).toBe('owner');
    });

    it('project-membership updateRole on a missing membership → project-membership-not-found', async () => {
      const { projects, memberships } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      expect(await memberships.updateRole(T1, id, U1, 'owner')).toEqual({
        kind: 'project-membership-not-found',
      });
    });

    it('grant add is idempotent', async () => {
      const { projects, grants } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'owner' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'viewer' });
      const page = await grants.listForProject(T1, id, {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.role).toBe('owner');
    });

    it('grant updateRole mutates the role', async () => {
      const { projects, grants } = makeBinding();
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'editor' });
      await grants.updateRole(T1, TEAM_A, id, 'owner');
      const page = await grants.listForTeam(T1, TEAM_A, {});
      expect(page.items[0]?.role).toBe('owner');
    });
  });

  describe(`${label} — listForUser aggregates across projects`, () => {
    it('returns every direct-grant project the user has', async () => {
      const { projects, memberships } = makeBinding();
      const a = await createProject(projects, T1, { name: 'A', slug: 'a' });
      const b = await createProject(projects, T1, { name: 'B', slug: 'b' });
      const c = await createProject(projects, T1, { name: 'C', slug: 'c' });
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
      const id = await createProject(projects, T1, { name: 'A', slug: 'a' });
      await grants.add(T1, { teamId: TEAM_A, projectId: id, role: 'editor' });
      await grants.add(T1, { teamId: TEAM_B, projectId: id, role: 'viewer' });
      const page = await grants.listForProject(T1, id, {});
      expect(page.items).toHaveLength(2);
    });

    it('listForTeam returns every project the team has a grant on', async () => {
      const { projects, grants } = makeBinding();
      const a = await createProject(projects, T1, { name: 'A', slug: 'a' });
      const b = await createProject(projects, T1, { name: 'B', slug: 'b' });
      await grants.add(T1, { teamId: TEAM_A, projectId: a, role: 'editor' });
      await grants.add(T1, { teamId: TEAM_A, projectId: b, role: 'viewer' });
      const page = await grants.listForTeam(T1, TEAM_A, {});
      expect(page.items).toHaveLength(2);
    });
  });

  describe(`${label} — slug uniqueness`, () => {
    it('create with a slug a project without an org already has → slug-conflict', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'Matter', slug: 'm1' });
      expect(await projects.create(T1, { name: 'Matter again', slug: 'm1' })).toEqual({
        kind: 'slug-conflict',
        slug: 'm1',
      });
      expect((await projects.list(T1, {})).items).toHaveLength(1);
    });

    it('another tenant may use the same slug', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'Matter', slug: 'm1' });
      expect((await projects.create(T2, { name: 'Matter', slug: 'm1' })).kind).toBe('ok');
    });

    it("update to another project's slug → slug-conflict; the project is unchanged", async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'A', slug: 'a' });
      const id = await createProject(projects, T1, { name: 'B', slug: 'b' });
      expect(await projects.update(T1, id, { slug: 'a' })).toEqual({
        kind: 'slug-conflict',
        slug: 'a',
      });
      expect((await projects.get(T1, id))?.slug).toBe('b');
    });

    it('two orgs may each have a project with the same slug', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'A', slug: 'shared', orgId: ORG_A });
      await createProject(projects, T1, { name: 'B', slug: 'shared', orgId: ORG_B });
      // And a project without an org may have it too.
      await createProject(projects, T1, { name: 'C', slug: 'shared' });
      expect((await projects.list(T1, {})).items.map((p) => p.slug)).toEqual([
        'shared',
        'shared',
        'shared',
      ]);
    });

    it("create with a slug the org's project already has → slug-conflict", async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'A', slug: 'a', orgId: ORG_A });
      expect(await projects.create(T1, { name: 'A again', slug: 'a', orgId: ORG_A })).toEqual({
        kind: 'slug-conflict',
        slug: 'a',
      });
    });

    it('a move to an org that has the slug → slug-conflict; the project stays where it was', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'In A', slug: 's', orgId: ORG_A });
      const id = await createProject(projects, T1, { name: 'In B', slug: 's', orgId: ORG_B });
      expect(await projects.update(T1, id, { orgId: ORG_A })).toEqual({
        kind: 'slug-conflict',
        slug: 's',
      });
      expect((await projects.get(T1, id))?.orgId).toBe(ORG_B);
    });

    it('a move out of its org, where a project without one has the slug → slug-conflict', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'Org-less', slug: 's' });
      const id = await createProject(projects, T1, { name: 'In A', slug: 's', orgId: ORG_A });
      expect(await projects.update(T1, id, { orgId: null })).toEqual({
        kind: 'slug-conflict',
        slug: 's',
      });
    });

    it('a move to an org without the slug, and a rename to a slug only another org has: ok', async () => {
      const { projects } = makeBinding();
      await createProject(projects, T1, { name: 'In A', slug: 'a', orgId: ORG_A });
      const id = await createProject(projects, T1, { name: 'In B', slug: 'b', orgId: ORG_B });
      expect(await projects.update(T1, id, { slug: 'a' })).toEqual({ kind: 'ok' });
      expect(await projects.update(T1, id, { slug: 'c', orgId: ORG_A })).toEqual({ kind: 'ok' });
    });
  });

  if (options.checksOrgs === true) {
    describe(`${label} — an org that isn't the tenant's (T220)`, () => {
      it('creating a project in it: org-not-found, and nothing is created', async () => {
        const { projects } = makeBinding();
        expect(
          await projects.create(T1, { name: 'P', slug: 'p', orgId: CONFORMANCE_MISSING_ORG }),
        ).toEqual({ kind: 'org-not-found', orgId: CONFORMANCE_MISSING_ORG });
        expect((await projects.list(T1, { orgId: CONFORMANCE_MISSING_ORG })).items).toEqual([]);
      });

      it('moving a project to it: org-not-found, and the project stays where it was', async () => {
        const { projects } = makeBinding();
        const id = await createProject(projects, T1, { name: 'P', slug: 'p', orgId: ORG_A });
        expect(await projects.update(T1, id, { orgId: CONFORMANCE_MISSING_ORG })).toEqual({
          kind: 'org-not-found',
          orgId: CONFORMANCE_MISSING_ORG,
        });
        expect((await projects.get(T1, id))?.orgId).toBe(ORG_A);
      });
    });
  }
}

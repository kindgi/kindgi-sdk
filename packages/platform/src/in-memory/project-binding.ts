// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `makeInMemoryProjectBinding` — reference in-memory implementations of
 * `ProjectBinding` + `ProjectMembershipBinding` + `TeamProjectGrantBinding`.
 *
 * Storage: three maps — projects, direct-grant memberships, team-project
 * grants. All share the same tenant-isolation guardrail + return the
 * combined trio so callers wire the whole surface at once. The
 * in-memory adapter keeps the team↔project join (`TeamProjectGrant`)
 * here for simplicity.
 *
 * `create` enforces the `Project.isDefault = true` uniqueness
 * guardrail at write time: creating a second Default in the same
 * tenant resolves to `project-default-already-exists`. A project's
 * slug is unique within its org, and a project without an org's among
 * the tenant's projects without one (`slug-conflict`).
 */

import type { Filter, OrgId, Page, ProjectId, TeamId, TenantId, UserId } from '@kindgi/types';

import type {
  ProjectBinding,
  ProjectCreateOutcome,
  ProjectListFilter,
  ProjectMembershipAddInput,
  ProjectMembershipAddOutcome,
  ProjectMembershipBinding,
  ProjectMembershipUpdateRoleOutcome,
  ProjectUpdateOutcome,
} from '../project-binding.js';
import type {
  TeamProjectGrant,
  TeamProjectGrantAddInput,
  TeamProjectGrantBinding,
} from '../team-project-grant-binding.js';
import type {
  Project,
  ProjectMembership,
  ProjectPatch,
  ProjectRole,
  ProjectSpec,
} from '../types.js';

import { nowTimestamp, paginate } from './util.js';

let projectIdCounter = 0;
function nextProjectId(): ProjectId {
  projectIdCounter += 1;
  return `project-${projectIdCounter}` as ProjectId;
}

function projMembershipKey(projectId: ProjectId, userId: UserId): string {
  return `${projectId}::${userId}`;
}

function grantKey(teamId: TeamId, projectId: ProjectId): string {
  return `${teamId}::${projectId}`;
}

/**
 * `orgExists`: whether an org is the tenant's (live). Given, a project or
 * team created in or moved to another org is `org-not-found`, as the
 * durable bindings answer; absent, any `orgId` is taken as it is.
 */
export interface InMemoryHierarchyOptions {
  readonly orgExists?: (tenantId: TenantId, orgId: OrgId) => boolean | Promise<boolean>;
}

/**
 * Combined factory — returns the three project-related bindings that
 * share underlying storage. Any of them can be plucked out and passed
 * individually to consumers that need just one.
 */
export function makeInMemoryProjectBinding(options: InMemoryHierarchyOptions = {}): {
  readonly projects: ProjectBinding;
  readonly memberships: ProjectMembershipBinding;
  readonly grants: TeamProjectGrantBinding;
} {
  const projectRows = new Map<ProjectId, Project>();
  const membershipRows = new Map<string, ProjectMembership>();
  const grantRows = new Map<string, TeamProjectGrant>();
  // Track grant insertion order for deterministic `list` ordering.
  const grantOrder: string[] = [];

  function findProjectInTenant(tenantId: TenantId, projectId: ProjectId): Project | undefined {
    const p = projectRows.get(projectId);
    if (p === undefined || p.tenantId !== tenantId) return undefined;
    return p;
  }

  function tenantAlreadyHasDefault(tenantId: TenantId): boolean {
    for (const row of projectRows.values()) {
      if (row.tenantId === tenantId && row.isDefault) return true;
    }
    return false;
  }

  /**
   * Is `slug` held by another project (not `exceptId`) where a project of
   * `orgId` lives: in that org, or, without an org, among the tenant's
   * projects without one?
   */
  function slugTaken(
    tenantId: TenantId,
    orgId: Project['orgId'],
    slug: string,
    exceptId?: ProjectId,
  ): boolean {
    for (const row of projectRows.values()) {
      if (
        row.tenantId === tenantId &&
        row.orgId === orgId &&
        row.slug === slug &&
        row.id !== exceptId
      ) {
        return true;
      }
    }
    return false;
  }

  const projects: ProjectBinding = {
    async create(tenantId, spec: ProjectSpec): Promise<ProjectCreateOutcome> {
      const isDefault = spec.isDefault === true;
      // The Default guardrail first: a caller asking for the Default
      // wants to hear that one exists, whatever its slug.
      if (isDefault && tenantAlreadyHasDefault(tenantId)) {
        return { kind: 'project-default-already-exists' };
      }
      if (spec.orgId !== undefined && (await options.orgExists?.(tenantId, spec.orgId)) === false) {
        return { kind: 'org-not-found', orgId: spec.orgId };
      }
      if (slugTaken(tenantId, spec.orgId, spec.slug)) {
        return { kind: 'slug-conflict', slug: spec.slug };
      }
      const id = nextProjectId();
      const now = nowTimestamp();
      const row: Project = {
        id,
        tenantId,
        name: spec.name,
        slug: spec.slug,
        isDefault,
        createdAt: now,
        updatedAt: now,
        ...(spec.orgId !== undefined ? { orgId: spec.orgId } : {}),
        ...(spec.description !== undefined ? { description: spec.description } : {}),
      };
      projectRows.set(id, row);
      return { kind: 'ok', projectId: id };
    },

    async get(tenantId, projectId): Promise<Project | undefined> {
      return findProjectInTenant(tenantId, projectId);
    },

    async list(tenantId, filter: ProjectListFilter): Promise<Page<Project>> {
      const all: Project[] = [];
      for (const row of projectRows.values()) {
        if (row.tenantId !== tenantId) continue;
        if (filter.orgId !== undefined && row.orgId !== filter.orgId) continue;
        if (filter.nameContains !== undefined && !row.name.includes(filter.nameContains)) {
          continue;
        }
        all.push(row);
      }
      all.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return paginate(all, filter.limit, filter.cursor);
    },

    async getDefault(tenantId): Promise<Project | undefined> {
      for (const row of projectRows.values()) {
        if (row.tenantId === tenantId && row.isDefault) return row;
      }
      return undefined;
    },

    async update(tenantId, projectId, patch: ProjectPatch): Promise<ProjectUpdateOutcome> {
      const row = findProjectInTenant(tenantId, projectId);
      if (row === undefined) {
        return { kind: 'project-not-found' };
      }
      let nextOrgId = row.orgId;
      if (patch.orgId !== undefined) {
        nextOrgId = patch.orgId === null ? undefined : patch.orgId;
      }
      if (
        patch.orgId !== undefined &&
        patch.orgId !== null &&
        (await options.orgExists?.(tenantId, patch.orgId)) === false
      ) {
        return { kind: 'org-not-found', orgId: patch.orgId };
      }
      // The slug it ends up with, where it ends up: a move to another org
      // (or out of one) can meet a project with the same slug there.
      const nextSlug = patch.slug ?? row.slug;
      if (
        (patch.slug !== undefined || patch.orgId !== undefined) &&
        slugTaken(tenantId, nextOrgId, nextSlug, projectId)
      ) {
        return { kind: 'slug-conflict', slug: nextSlug };
      }
      const nextDescription = patch.description ?? row.description;
      const next: Project = {
        id: row.id,
        tenantId: row.tenantId,
        name: patch.name ?? row.name,
        slug: patch.slug ?? row.slug,
        isDefault: row.isDefault,
        createdAt: row.createdAt,
        updatedAt: nowTimestamp(),
        ...(nextOrgId !== undefined ? { orgId: nextOrgId } : {}),
        ...(nextDescription !== undefined ? { description: nextDescription } : {}),
      };
      projectRows.set(projectId, next);
      return { kind: 'ok' };
    },

    async delete(tenantId, projectId): Promise<void> {
      const row = findProjectInTenant(tenantId, projectId);
      if (row === undefined) return;
      projectRows.delete(projectId);
      // Cascade — direct memberships + team grants drop with the project.
      for (const key of membershipRows.keys()) {
        if (key.startsWith(`${projectId}::`)) {
          membershipRows.delete(key);
        }
      }
      for (let i = grantOrder.length - 1; i >= 0; i -= 1) {
        const key = grantOrder[i];
        if (key === undefined) continue;
        if (key.endsWith(`::${projectId}`)) {
          grantRows.delete(key);
          grantOrder.splice(i, 1);
        }
      }
    },
  };

  const memberships: ProjectMembershipBinding = {
    async add(tenantId, input: ProjectMembershipAddInput): Promise<ProjectMembershipAddOutcome> {
      const proj = findProjectInTenant(tenantId, input.projectId);
      if (proj === undefined) {
        return { kind: 'project-not-found' };
      }
      const key = projMembershipKey(input.projectId, input.userId);
      if (membershipRows.has(key)) return { kind: 'ok' };
      const row: ProjectMembership = {
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
        joinedAt: nowTimestamp(),
      };
      membershipRows.set(key, row);
      return { kind: 'ok' };
    },

    async remove(tenantId, projectId, userId): Promise<void> {
      const proj = findProjectInTenant(tenantId, projectId);
      if (proj === undefined) return;
      membershipRows.delete(projMembershipKey(projectId, userId));
    },

    async list(tenantId, projectId, filter: Filter): Promise<Page<ProjectMembership>> {
      const proj = findProjectInTenant(tenantId, projectId);
      if (proj === undefined) return { items: [] };
      const all: ProjectMembership[] = [];
      for (const row of membershipRows.values()) {
        if (row.projectId !== projectId) continue;
        all.push(row);
      }
      all.sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0));
      return paginate(all, filter.limit, filter.cursor);
    },

    async listForUser(tenantId, userId, filter: Filter): Promise<Page<ProjectMembership>> {
      const all: ProjectMembership[] = [];
      for (const row of membershipRows.values()) {
        if (row.userId !== userId) continue;
        const p = projectRows.get(row.projectId);
        if (p === undefined || p.tenantId !== tenantId) continue;
        all.push(row);
      }
      all.sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0));
      return paginate(all, filter.limit, filter.cursor);
    },

    async updateRole(
      tenantId,
      projectId,
      userId,
      role: ProjectRole,
    ): Promise<ProjectMembershipUpdateRoleOutcome> {
      const proj = findProjectInTenant(tenantId, projectId);
      if (proj === undefined) {
        return { kind: 'project-not-found' };
      }
      const key = projMembershipKey(projectId, userId);
      const row = membershipRows.get(key);
      if (row === undefined) {
        return { kind: 'project-membership-not-found' };
      }
      membershipRows.set(key, { ...row, role });
      return { kind: 'ok' };
    },
  };

  const grants: TeamProjectGrantBinding = {
    async add(tenantId, input: TeamProjectGrantAddInput): Promise<void> {
      // Grant validity requires the project to exist in-tenant. Team
      // existence is not checked here: teams live in the separate
      // `makeInMemoryTeamBinding` store.
      const proj = findProjectInTenant(tenantId, input.projectId);
      if (proj === undefined) {
        throw new Error(`project-not-found: ${input.projectId}`);
      }
      const key = grantKey(input.teamId, input.projectId);
      if (grantRows.has(key)) return;
      const row: TeamProjectGrant = {
        teamId: input.teamId,
        projectId: input.projectId,
        role: input.role,
      };
      grantRows.set(key, row);
      grantOrder.push(key);
    },

    async remove(tenantId, teamId, projectId): Promise<void> {
      const proj = findProjectInTenant(tenantId, projectId);
      if (proj === undefined) return;
      const key = grantKey(teamId, projectId);
      if (grantRows.delete(key)) {
        const idx = grantOrder.indexOf(key);
        if (idx >= 0) grantOrder.splice(idx, 1);
      }
    },

    async list(tenantId, filter: Filter): Promise<Page<TeamProjectGrant>> {
      const all: TeamProjectGrant[] = [];
      for (const key of grantOrder) {
        const row = grantRows.get(key);
        if (row === undefined) continue;
        const p = projectRows.get(row.projectId);
        if (p === undefined || p.tenantId !== tenantId) continue;
        all.push(row);
      }
      return paginate(all, filter.limit, filter.cursor);
    },

    async listForTeam(tenantId, teamId, filter: Filter): Promise<Page<TeamProjectGrant>> {
      const all: TeamProjectGrant[] = [];
      for (const key of grantOrder) {
        const row = grantRows.get(key);
        if (row === undefined) continue;
        if (row.teamId !== teamId) continue;
        const p = projectRows.get(row.projectId);
        if (p === undefined || p.tenantId !== tenantId) continue;
        all.push(row);
      }
      return paginate(all, filter.limit, filter.cursor);
    },

    async listForProject(tenantId, projectId, filter: Filter): Promise<Page<TeamProjectGrant>> {
      const proj = findProjectInTenant(tenantId, projectId);
      if (proj === undefined) return { items: [] };
      const all: TeamProjectGrant[] = [];
      for (const key of grantOrder) {
        const row = grantRows.get(key);
        if (row === undefined) continue;
        if (row.projectId !== projectId) continue;
        all.push(row);
      }
      return paginate(all, filter.limit, filter.cursor);
    },

    async updateRole(tenantId, teamId, projectId, role: ProjectRole): Promise<void> {
      const proj = findProjectInTenant(tenantId, projectId);
      if (proj === undefined) {
        throw new Error(`project-not-found: ${projectId}`);
      }
      const key = grantKey(teamId, projectId);
      const row = grantRows.get(key);
      if (row === undefined) {
        throw new Error(`team-project-grant-not-found: ${teamId}/${projectId}`);
      }
      grantRows.set(key, { ...row, role });
    },
  };

  return { projects, memberships, grants };
}

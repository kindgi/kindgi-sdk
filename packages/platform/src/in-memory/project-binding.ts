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
 * guardrail at write time: creating a second default in the same
 * tenant resolves to `project-default-already-exists`. A project's
 * slug is unique within its org, and a project without an org's among
 * the tenant's projects without one (`slug-conflict`). A slug a project
 * had before a rename stays that project's, across the tenant
 * (`slug-conflict` with `heldAs: 'old-slug'`).
 *
 * A deleted project stays in the map, marked with the time it was deleted,
 * and every read but `restore` and `listDeleted` passes over it. Its
 * memberships, team grants and slugs stay too, so a restore brings it back
 * as it was.
 */

import type {
  Filter,
  OrgId,
  Page,
  ProjectId,
  TeamId,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import type {
  ProjectBinding,
  ProjectCreateOutcome,
  ProjectDeleteOutcome,
  ProjectListFilter,
  ProjectMembershipAddInput,
  ProjectMembershipAddOutcome,
  ProjectMembershipBinding,
  ProjectMembershipUpdateRoleOutcome,
  ProjectProductionOutcome,
  ProjectRepoConnectionOutcome,
  ProjectRestoreOutcome,
  ProjectUpdateOutcome,
} from '../project-binding.js';
import type {
  TeamProjectGrant,
  TeamProjectGrantAddInput,
  TeamProjectGrantBinding,
} from '../team-project-grant-binding.js';
import type {
  DeletedProject,
  Project,
  ProjectMembership,
  ProjectPatch,
  ProjectRole,
  ProjectSpec,
} from '../types.js';

import { nowTimestamp, paginate } from './util.js';

/** A project id is a UUID on the wire (`Project.id`), here too, so routes that check its shape take it. */
function nextProjectId(): ProjectId {
  return crypto.randomUUID() as ProjectId;
}

function projMembershipKey(projectId: ProjectId, userId: UserId): string {
  return `${projectId}::${userId}`;
}

function grantKey(teamId: TeamId, projectId: ProjectId): string {
  return `${teamId}::${projectId}`;
}

/**
 * - `orgExists`: whether an org is the workspace's (live). Given, a project or
 *   team created in or moved to another org is `org-not-found`, as the
 *   durable bindings answer; absent, any `orgId` is taken as it is.
 * - `productionLimit`: the workspace's limit on projects in production
 *   (`TenantLimits.projectsInProduction`), read where it's kept;
 *   `undefined` for none. Read synchronously, so `setProduction` reads,
 *   counts and changes in one step, as a database's lock makes it.
 * - `environmentOrderOf`: the id of the environment order a project is a
 *   member of, or `undefined` for none. Given, `delete` and an `orgId` move
 *   refuse a project that is in an order (`project-in-environment-order`), as
 *   the durable binding does under its per-workspace lock; absent, no project is
 *   in an order. Compose this to the environment-order binding's `orderOf`
 *   wherever both share a store so the guard is never silently unset.
 */
export interface InMemoryHierarchyOptions {
  readonly orgExists?: (tenantId: TenantId, orgId: OrgId) => boolean | Promise<boolean>;
  readonly productionLimit?: (tenantId: TenantId) => number | undefined;
  readonly environmentOrderOf?: (
    tenantId: TenantId,
    projectId: ProjectId,
  ) => string | undefined | Promise<string | undefined>;
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
  // When each deleted project was deleted. A restore removes its entry.
  const deletedAt = new Map<ProjectId, Timestamp>();
  // One entry per rename that changed a slug, oldest first, as the durable
  // binding's rename record keeps them.
  const slugRenames: {
    readonly tenantId: TenantId;
    readonly projectId: ProjectId;
    readonly fromSlug: string;
  }[] = [];
  const membershipRows = new Map<string, ProjectMembership>();
  const grantRows = new Map<string, TeamProjectGrant>();
  // Track grant insertion order for deterministic `list` ordering.
  const grantOrder: string[] = [];

  /** The tenant's project, live or deleted. */
  function findAnyInTenant(tenantId: TenantId, projectId: ProjectId): Project | undefined {
    const p = projectRows.get(projectId);
    if (p === undefined || p.tenantId !== tenantId) return undefined;
    return p;
  }

  /** The tenant's live project: a deleted one is as unknown. */
  function findProjectInTenant(tenantId: TenantId, projectId: ProjectId): Project | undefined {
    const p = findAnyInTenant(tenantId, projectId);
    return p === undefined || deletedAt.has(p.id) ? undefined : p;
  }

  /** Is the project with this id the tenant's, and live? */
  function liveInTenant(tenantId: TenantId, projectId: ProjectId): boolean {
    return findProjectInTenant(tenantId, projectId) !== undefined;
  }

  /** The slugs `row` had before it was renamed, newest first, without its current one. */
  function formerSlugsOf(row: Project): string[] {
    const former: string[] = [];
    for (let i = slugRenames.length - 1; i >= 0; i -= 1) {
      const rename = slugRenames[i];
      if (rename === undefined || rename.projectId !== row.id) continue;
      if (rename.fromSlug !== row.slug && !former.includes(rename.fromSlug)) {
        former.push(rename.fromSlug);
      }
    }
    return former;
  }

  /** A project as the binding answers it, with its `formerSlugs`. */
  function withFormerSlugs(row: Project): Project {
    return { ...row, formerSlugs: formerSlugsOf(row) };
  }

  /**
   * The project of the tenant (not `exceptId`) that had `slug` before it
   * was renamed, and hasn't it again, live or deleted; `undefined` for none.
   */
  function slugHeldBy(tenantId: TenantId, slug: string, exceptId?: ProjectId): Project | undefined {
    for (const rename of slugRenames) {
      if (rename.tenantId !== tenantId || rename.fromSlug !== slug) continue;
      if (rename.projectId === exceptId) continue;
      const holder = projectRows.get(rename.projectId);
      if (holder !== undefined && holder.slug !== slug) return holder;
    }
    return undefined;
  }

  /** A slug conflict, saying when the project holding the slug is deleted. */
  function slugConflict(
    slug: string,
    holder: Project,
    heldAs?: 'old-slug',
  ): Extract<ProjectUpdateOutcome, { kind: 'slug-conflict' }> {
    return {
      kind: 'slug-conflict',
      slug,
      ...(heldAs !== undefined && { heldAs }),
      ...(deletedAt.has(holder.id) && { deletedProject: true as const }),
    };
  }

  /** `limit-reached` when the tenant's projects in production are at its limit or past it. */
  function limitReached(tenantId: TenantId): ProjectProductionOutcome | undefined {
    const limit = options.productionLimit?.(tenantId);
    if (limit === undefined) return undefined;
    let inProduction = 0;
    for (const row of projectRows.values()) {
      if (row.tenantId !== tenantId || deletedAt.has(row.id)) continue;
      if (row.productionSince !== undefined) inProduction += 1;
    }
    return inProduction >= limit
      ? { kind: 'limit-reached', projectsInProduction: limit, inProduction }
      : undefined;
  }

  function tenantAlreadyHasDefault(tenantId: TenantId): boolean {
    for (const row of projectRows.values()) {
      if (row.tenantId === tenantId && row.isDefault) return true;
    }
    return false;
  }

  /**
   * The other project (not `exceptId`), live or deleted, that has `slug`
   * where a project of `orgId` lives: in that org, or, without an org,
   * among the tenant's projects without one; `undefined` for none.
   */
  function slugTakenBy(
    tenantId: TenantId,
    orgId: Project['orgId'],
    slug: string,
    exceptId?: ProjectId,
  ): Project | undefined {
    for (const row of projectRows.values()) {
      if (
        row.tenantId === tenantId &&
        row.orgId === orgId &&
        row.slug === slug &&
        row.id !== exceptId
      ) {
        return row;
      }
    }
    return undefined;
  }

  const projects: ProjectBinding = {
    async create(tenantId, spec: ProjectSpec): Promise<ProjectCreateOutcome> {
      const isDefault = spec.isDefault === true;
      // The isDefault guardrail first: a caller asking for the default
      // wants to hear that one exists, whatever its slug.
      if (isDefault && tenantAlreadyHasDefault(tenantId)) {
        return { kind: 'project-default-already-exists' };
      }
      if (spec.orgId !== undefined && (await options.orgExists?.(tenantId, spec.orgId)) === false) {
        return { kind: 'org-not-found', orgId: spec.orgId };
      }
      // The hold first, as the durable binding checks it before its insert
      // meets the slug's unique index.
      const holder = slugHeldBy(tenantId, spec.slug);
      if (holder !== undefined) return slugConflict(spec.slug, holder, 'old-slug');
      const taker = slugTakenBy(tenantId, spec.orgId, spec.slug);
      if (taker !== undefined) return slugConflict(spec.slug, taker);
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
        ...(spec.everyoneCanRun === true && { everyoneCanRun: true }),
      };
      projectRows.set(id, row);
      return { kind: 'ok', projectId: id };
    },

    async get(tenantId, projectId): Promise<Project | undefined> {
      const row = findProjectInTenant(tenantId, projectId);
      return row === undefined ? undefined : withFormerSlugs(row);
    },

    async list(tenantId, filter: ProjectListFilter): Promise<Page<Project>> {
      const all: Project[] = [];
      for (const row of projectRows.values()) {
        if (row.tenantId !== tenantId || deletedAt.has(row.id)) continue;
        if (filter.orgId !== undefined && row.orgId !== filter.orgId) continue;
        if (filter.nameContains !== undefined && !row.name.includes(filter.nameContains)) {
          continue;
        }
        all.push(withFormerSlugs(row));
      }
      all.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return paginate(all, filter.limit, filter.cursor);
    },

    async getDefault(tenantId): Promise<Project | undefined> {
      for (const row of projectRows.values()) {
        if (row.tenantId !== tenantId || deletedAt.has(row.id)) continue;
        if (row.isDefault) return withFormerSlugs(row);
      }
      return undefined;
    },

    async update(tenantId, projectId, patch: ProjectPatch): Promise<ProjectUpdateOutcome> {
      const found = findProjectInTenant(tenantId, projectId);
      if (found === undefined) {
        return { kind: 'project-not-found' };
      }
      let nextOrgId = found.orgId;
      if (patch.orgId !== undefined) {
        nextOrgId = patch.orgId === null ? undefined : patch.orgId;
      }
      // A move to another parent is refused while the project is in an
      // environment order; a rename, slug or description change is not. The
      // parent changes exactly when `nextOrgId` differs from the current org,
      // and the order guard takes precedence over `org-not-found`.
      if (patch.orgId !== undefined && nextOrgId !== found.orgId) {
        const orderId = await options.environmentOrderOf?.(tenantId, projectId);
        if (orderId !== undefined) {
          return { kind: 'project-in-environment-order', orderId };
        }
      }
      if (
        patch.orgId !== undefined &&
        patch.orgId !== null &&
        (await options.orgExists?.(tenantId, patch.orgId)) === false
      ) {
        return { kind: 'org-not-found', orgId: patch.orgId };
      }
      // Read again after the awaits: the slug it's renamed from is the one
      // it has now, as the durable binding reads it under the row's lock, so
      // two renames at once both keep theirs.
      const row = findProjectInTenant(tenantId, projectId);
      if (row === undefined) {
        return { kind: 'project-not-found' };
      }
      const renamed = patch.slug !== undefined && patch.slug !== row.slug;
      const holder = renamed ? slugHeldBy(tenantId, patch.slug, projectId) : undefined;
      if (renamed && holder !== undefined) return slugConflict(patch.slug, holder, 'old-slug');
      // The slug it ends up with, where it ends up: a move to another org
      // (or out of one) can meet a project with the same slug there.
      const nextSlug = patch.slug ?? row.slug;
      const taker =
        patch.slug !== undefined || patch.orgId !== undefined
          ? slugTakenBy(tenantId, nextOrgId, nextSlug, projectId)
          : undefined;
      if (taker !== undefined) return slugConflict(nextSlug, taker);
      const nextDescription = patch.description ?? row.description;
      const sortsEndUsers = patch.sortEndUserCorrections ?? row.sortEndUserCorrections === true;
      const everyoneRuns = patch.everyoneCanRun ?? row.everyoneCanRun === true;
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
        ...(row.productionSince !== undefined ? { productionSince: row.productionSince } : {}),
        ...(sortsEndUsers && { sortEndUserCorrections: true }),
        ...(everyoneRuns && { everyoneCanRun: true }),
        ...(row.repoConnectionId !== undefined ? { repoConnectionId: row.repoConnectionId } : {}),
      };
      projectRows.set(projectId, next);
      if (renamed) slugRenames.push({ tenantId, projectId, fromSlug: row.slug });
      return { kind: 'ok' };
    },

    async setProduction(tenantId, projectId, production): Promise<ProjectProductionOutcome> {
      const row = findProjectInTenant(tenantId, projectId);
      if (row === undefined) return { kind: 'project-not-found' };
      if ((row.productionSince !== undefined) === production) {
        return { kind: 'ok', productionSince: row.productionSince ?? null, changed: false };
      }
      // Read, counted and changed with no await between: one step, as a database's lock makes it.
      const refused = production ? limitReached(tenantId) : undefined;
      if (refused !== undefined) return refused;
      const now = nowTimestamp();
      const { productionSince: _was, ...rest } = row;
      const next: Project = production
        ? { ...rest, productionSince: now, updatedAt: now }
        : { ...rest, updatedAt: now };
      projectRows.set(projectId, next);
      return { kind: 'ok', productionSince: next.productionSince ?? null, changed: true };
    },

    async setRepoConnection(
      tenantId,
      projectId,
      connectionId,
    ): Promise<ProjectRepoConnectionOutcome> {
      const row = findProjectInTenant(tenantId, projectId);
      if (row === undefined) return { kind: 'project-not-found' };
      if ((row.repoConnectionId ?? null) === connectionId) {
        return { kind: 'ok', repoConnectionId: connectionId, changed: false };
      }
      const { repoConnectionId: _was, ...rest } = row;
      const now = nowTimestamp();
      projectRows.set(projectId, {
        ...rest,
        ...(connectionId !== null && { repoConnectionId: connectionId }),
        updatedAt: now,
      });
      return { kind: 'ok', repoConnectionId: connectionId, changed: true };
    },

    async delete(tenantId, projectId): Promise<ProjectDeleteOutcome> {
      const row = findProjectInTenant(tenantId, projectId);
      // An id that names no project, or a deleted one, is `ok` — deleting is
      // idempotent, and a deleted project keeps its first time.
      if (row === undefined) return { kind: 'ok' };
      const orderId = await options.environmentOrderOf?.(tenantId, projectId);
      if (orderId !== undefined) {
        return { kind: 'project-in-environment-order', orderId };
      }
      if (row.isDefault) return { kind: 'project-is-default' };
      // No await between the order answer and the delete — one step, as the
      // durable binding's per-tenant lock makes it.
      deletedAt.set(projectId, nowTimestamp());
      return { kind: 'ok' };
    },

    async restore(tenantId, projectId): Promise<ProjectRestoreOutcome> {
      const row = findAnyInTenant(tenantId, projectId);
      if (row === undefined) return { kind: 'project-not-found' };
      const changed = deletedAt.delete(projectId);
      return { kind: 'ok', project: withFormerSlugs(row), changed };
    },

    async listDeleted(tenantId, filter: Filter): Promise<Page<DeletedProject>> {
      const all: DeletedProject[] = [];
      for (const [id, at] of deletedAt) {
        const row = findAnyInTenant(tenantId, id);
        if (row === undefined) continue;
        all.push({
          id: row.id,
          tenantId: row.tenantId,
          ...(row.orgId !== undefined && { orgId: row.orgId }),
          name: row.name,
          slug: row.slug,
          formerSlugs: formerSlugsOf(row),
          deletedAt: at,
        });
      }
      // The most recently deleted first.
      all.sort((a, b) => {
        if (a.deletedAt !== b.deletedAt) return a.deletedAt > b.deletedAt ? -1 : 1;
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
      });
      return paginate(all, filter.limit, filter.cursor);
    },
  };

  const memberships: ProjectMembershipBinding = {
    async add(tenantId, input: ProjectMembershipAddInput): Promise<ProjectMembershipAddOutcome> {
      const proj = findProjectInTenant(tenantId, input.projectId);
      if (proj === undefined) {
        return { kind: 'project-not-found' };
      }
      const key = projMembershipKey(input.projectId, input.userId);
      const held = membershipRows.get(key);
      if (held !== undefined) {
        // A member keeps the role they hold: a change is `updateRole`.
        return held.role === input.role
          ? { kind: 'ok' }
          : { kind: 'membership-exists', role: held.role };
      }
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
        if (!liveInTenant(tenantId, row.projectId)) continue;
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
        grantedAt: nowTimestamp(),
      };
      grantRows.set(key, row);
      grantOrder.push(key);
    },

    async get(tenantId, teamId, projectId): Promise<TeamProjectGrant | undefined> {
      if (findProjectInTenant(tenantId, projectId) === undefined) return undefined;
      return grantRows.get(grantKey(teamId, projectId));
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
        if (!liveInTenant(tenantId, row.projectId)) continue;
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
        if (!liveInTenant(tenantId, row.projectId)) continue;
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

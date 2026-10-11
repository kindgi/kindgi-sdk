// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// TenantHierarchyBinding — the public shape for Org/Team/Project CRUD
// operations that write authz tuples in the same transaction as the
// entity insert. Implementations are supplied by the deployment and
// plugged in via `CreateAppInput.tenantHierarchyBinding` in
// `@kindgi/api`.
//
// The `Params` shapes are self-contained — reference only public
// types from @kindgi/{platform,types}. Error shapes are structural
// so callers don't need to import an Error type from any
// implementation.
//

import type { OrgId, ProjectId, Result, TeamId, TenantId, UserId } from '@kindgi/types';
import type { ProjectMembershipUpdateRoleOutcome } from './project-binding.js';
import type { TeamMembershipUpdateRoleOutcome } from './team-binding.js';
import type { TeamProjectGrant } from './team-project-grant-binding.js';
import type {
  OrgSpec,
  ProjectRole,
  ProjectSpec,
  TeamProjectRole,
  TeamRole,
  TeamSpec,
} from './types.js';

export interface CreateOrgParams {
  readonly tenantId: TenantId;
  readonly creatorUserId: UserId;
  readonly spec: OrgSpec;
}

export type CreateOrgError =
  | { readonly code: 'slug-conflict'; readonly message: string; readonly cause?: unknown }
  | { readonly code: 'insert-failed'; readonly message: string; readonly cause?: unknown };

export interface CreateTeamParams {
  readonly tenantId: TenantId;
  readonly creatorUserId: UserId;
  readonly spec: TeamSpec;
}

export type CreateTeamError =
  | { readonly code: 'slug-conflict'; readonly message: string; readonly cause?: unknown }
  /** `spec.orgId` isn't the tenant's: it never existed, or it was deleted. */
  | { readonly code: 'org-not-found'; readonly message: string; readonly orgId: OrgId }
  | { readonly code: 'insert-failed'; readonly message: string; readonly cause?: unknown };

export interface AddTeamMemberParams {
  readonly tenantId: TenantId;
  readonly teamId: TeamId;
  readonly userId: UserId;
  readonly role: TeamRole;
}

export interface CreateProjectParams {
  readonly tenantId: TenantId;
  readonly creatorUserId: UserId;
  readonly spec: ProjectSpec;
}

export type CreateProjectError =
  | { readonly code: 'slug-conflict'; readonly message: string; readonly cause?: unknown }
  /** `spec.orgId` isn't the tenant's: it never existed, or it was deleted. */
  | { readonly code: 'org-not-found'; readonly message: string; readonly orgId: OrgId }
  | { readonly code: 'default-conflict'; readonly message: string; readonly cause?: unknown }
  | { readonly code: 'insert-failed'; readonly message: string; readonly cause?: unknown };

export interface AddProjectMemberParams {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly userId: UserId;
  readonly role: ProjectRole;
}

export type AddTeamMemberError =
  | {
      /** No team with this id in the tenant. */
      readonly code: 'team-not-found';
      readonly message: string;
    }
  | {
      /** A member already, with another role: kept, and nothing written. */
      readonly code: 'membership-exists';
      readonly message: string;
      readonly role: TeamRole;
    }
  | { readonly code: 'add-failed'; readonly message: string; readonly cause?: unknown };

export type AddProjectMemberError =
  | {
      /** No project with this id in the tenant. */
      readonly code: 'project-not-found';
      readonly message: string;
    }
  | {
      /** A member already, with another role: kept, and nothing written. */
      readonly code: 'membership-exists';
      readonly message: string;
      readonly role: ProjectRole;
    }
  | { readonly code: 'add-failed'; readonly message: string; readonly cause?: unknown };

/** Which direct membership to remove: the user's on the team or project. */
export interface RemoveTeamMemberParams {
  readonly tenantId: TenantId;
  readonly teamId: TeamId;
  readonly userId: UserId;
}

export interface RemoveProjectMemberParams {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly userId: UserId;
}

/** A direct membership's new role. */
export interface UpdateTeamMemberRoleParams extends RemoveTeamMemberParams {
  readonly role: TeamRole;
}

export interface UpdateProjectMemberRoleParams extends RemoveProjectMemberParams {
  readonly role: ProjectRole;
}

/** A team's role on a project, given or changed. */
export interface TeamProjectGrantParams {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly teamId: TeamId;
  readonly role: TeamProjectRole;
}

/** Which team's grant on a project to remove. */
export interface RemoveTeamProjectGrantParams {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly teamId: TeamId;
}

export type AddTeamProjectGrantError =
  | { readonly code: 'project-not-found'; readonly message: string }
  | { readonly code: 'team-not-found'; readonly message: string }
  | { readonly code: 'write-failed'; readonly message: string; readonly cause?: unknown };

/** The grant added, or the one the team already held there (`created: false`: nothing written). */
export interface AddTeamProjectGrantResult {
  readonly created: boolean;
  readonly grant: TeamProjectGrant;
}

export type TeamProjectGrantUpdateRoleOutcome =
  | { readonly kind: 'ok'; readonly grant: TeamProjectGrant }
  | { readonly kind: 'project-not-found' }
  | { readonly kind: 'team-grant-not-found' };

/** Which team to delete. */
export interface DeleteTeamParams {
  readonly tenantId: TenantId;
  readonly teamId: TeamId;
}

/** A membership change that couldn't be written (the row and its tuple both left as they were). */
export interface MembershipWriteError {
  readonly code: 'write-failed';
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Tenant-summary read shape returned by `getTenant`. Only the fields
 * the `/v1/tenant` GET route surfaces — id / name / slug / createdAt /
 * updatedAt. Timestamps are ISO 8601 strings; impls that hold Date
 * objects convert at the boundary.
 */
export interface TenantSummary {
  readonly id: TenantId;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Tenant-hierarchy CRUD binding. Every route that creates orgs /
 * teams / projects or adds members writes atomically: entity insert
 * + FGA parent/owner tuples in the same transaction.
 *
 * Deployments supply the implementation; tests can substitute a mock.
 */
export interface TenantHierarchyBinding {
  createOrg(params: CreateOrgParams): Promise<Result<{ readonly orgId: OrgId }, CreateOrgError>>;
  createTeam(
    params: CreateTeamParams,
  ): Promise<Result<{ readonly teamId: TeamId }, CreateTeamError>>;
  createProject(
    params: CreateProjectParams,
  ): Promise<Result<{ readonly projectId: ProjectId }, CreateProjectError>>;
  addTeamMember(params: AddTeamMemberParams): Promise<Result<void, AddTeamMemberError>>;
  addProjectMember(params: AddProjectMemberParams): Promise<Result<void, AddProjectMemberError>>;
  /**
   * Remove a user's team membership and its authorization tuple
   * together (one transaction, or the tuple outbox). No-op when absent.
   * The membership routes use this when authorization is enforced; a
   * binding without it can't keep permissions in step, so those routes
   * refuse the change rather than remove the row alone.
   */
  removeTeamMember?(params: RemoveTeamMemberParams): Promise<Result<void, MembershipWriteError>>;
  /** Change a team membership's role and replace its tuple together (see `removeTeamMember`). */
  updateTeamMemberRole?(
    params: UpdateTeamMemberRoleParams,
  ): Promise<Result<TeamMembershipUpdateRoleOutcome, MembershipWriteError>>;
  /** Remove a user's direct project membership and its tuple together (see `removeTeamMember`). */
  removeProjectMember?(
    params: RemoveProjectMemberParams,
  ): Promise<Result<void, MembershipWriteError>>;
  /** Change a direct project membership's role and replace its tuple together (see `removeTeamMember`). */
  updateProjectMemberRole?(
    params: UpdateProjectMemberRoleParams,
  ): Promise<Result<ProjectMembershipUpdateRoleOutcome, MembershipWriteError>>;
  /**
   * Give a team a role on a project: the grant's row and its tuple
   * together. A team that already holds a role there keeps it, and nothing
   * is written (`created: false`, with the grant it holds). With an
   * authorizer, the team-grant routes need this, `updateTeamProjectGrantRole`
   * and `removeTeamProjectGrant`; without them they refuse the change.
   */
  addTeamProjectGrant?(
    params: TeamProjectGrantParams,
  ): Promise<Result<AddTeamProjectGrantResult, AddTeamProjectGrantError>>;
  /** Change a team's role on a project, row and tuples together. */
  updateTeamProjectGrantRole?(
    params: TeamProjectGrantParams,
  ): Promise<Result<TeamProjectGrantUpdateRoleOutcome, MembershipWriteError>>;
  /** Remove a team's role on a project and its tuples together. No-op when it has none. */
  removeTeamProjectGrant?(
    params: RemoveTeamProjectGrantParams,
  ): Promise<Result<void, MembershipWriteError>>;
  /**
   * Delete a team with every tuple it holds or gives (its parent, its
   * members' roles, its project grants), in one transaction, so nobody
   * keeps access through a team that's gone. With an authorizer, the team
   * delete route needs it, and refuses without it. `deleted: false` when
   * there was no such team.
   */
  deleteTeam?(
    params: DeleteTeamParams,
  ): Promise<Result<{ readonly deleted: boolean }, MembershipWriteError>>;
  /**
   * Look up a tenant by id. Returns `null` when no tenant exists.
   * Not itself tenant-scoped: it is how a caller finds out which
   * tenant it is operating as.
   */
  getTenant(tenantId: TenantId): Promise<TenantSummary | null>;
}

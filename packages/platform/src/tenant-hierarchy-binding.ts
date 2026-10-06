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
import type { OrgSpec, ProjectRole, ProjectSpec, TeamRole, TeamSpec } from './types.js';

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
  | { readonly code: 'add-failed'; readonly message: string; readonly cause?: unknown };

export type AddProjectMemberError =
  | {
      /** No project with this id in the tenant. */
      readonly code: 'project-not-found';
      readonly message: string;
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
   * Look up a tenant by id. Returns `null` when no tenant exists.
   * Not itself tenant-scoped: it is how a caller finds out which
   * tenant it is operating as.
   */
  getTenant(tenantId: TenantId): Promise<TenantSummary | null>;
}

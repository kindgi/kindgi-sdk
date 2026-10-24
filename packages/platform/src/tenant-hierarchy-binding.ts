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
  /**
   * The person who creates it, made its admin. Absent when no person is
   * behind the key (a service account's): no one is made
   * its admin, and the tenant's admins reach it through its parent.
   */
  readonly creatorUserId?: UserId;
  readonly spec: OrgSpec;
}

export type CreateOrgError =
  | { readonly code: 'slug-conflict'; readonly message: string; readonly cause?: unknown }
  | { readonly code: 'insert-failed'; readonly message: string; readonly cause?: unknown };

export interface CreateTeamParams {
  readonly tenantId: TenantId;
  /**
   * The person who creates it, made its admin. Absent when no person is
   * behind the key (a service account's): no one is made
   * its admin, and the tenant's admins reach it through its parent.
   */
  readonly creatorUserId?: UserId;
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
  /**
   * The person who creates it, made its owner. Absent when no person is
   * behind the key (a service account's): no one is made
   * its owner, and the tenant's admins reach it through its parent.
   */
  readonly creatorUserId?: UserId;
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
  | {
      /**
       * A person a site signs in (`createdBy: site:<id>`): they hold only
       * the grants their site's sign-in writes, never one given here.
       */
      readonly code: 'site-person-grants-managed';
      readonly message: string;
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
  | {
      /**
       * A person a site signs in (`createdBy: site:<id>`): they hold only
       * the grants their site's sign-in writes, never one given here.
       */
      readonly code: 'site-person-grants-managed';
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
  /**
   * `write-failed`: the row and its tuple couldn't be changed together.
   * `site-person-grants-managed`: the person is one a site signs in, who
   * holds only the grants their site's sign-in writes.
   */
  readonly code: 'write-failed' | 'site-person-grants-managed';
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
  /**
   * Whether the tenant may put projects in production. Absent means
   * allowed: a runtime that doesn't gate production leaves it out. The
   * production route checks it only when its gate is on.
   */
  readonly productionAllowed?: boolean;
  /** The tenant's limits that are set. Absent when none is. */
  readonly limits?: TenantLimits;
  /**
   * Where the tenant stands, on a runtime serving many tenants: `closing`
   * (readable and exportable for its window, nothing runs) or `suspended`
   * (the same, reversibly). `closing` wins. Absent: active.
   */
  readonly state?: 'active' | 'suspended' | 'closing';
}

/**
 * A tenant's limits, each absent while it isn't set (and then not
 * enforced). Set per tenant by the system API; a self-hosted runtime
 * sets none unless its operator does.
 */
export interface TenantLimits {
  /** API requests a minute, as a token bucket. Past it: 429 `rate-limit-exceeded`. */
  readonly apiRequestsPerMinute?: number;
  /** Webhook deliveries received a minute, across the tenant's triggers. Past it: 429. */
  readonly webhookReceivesPerMinute?: number;
  /** Runs executing at once. Past it, a new run waits as `pending`. */
  readonly runsAtOnce?: number;
  /** Runs waiting as `pending`. Past it, a new run is refused with 429. */
  readonly runsPending?: number;
  /** Tool calls in flight to the tenant's pack services. Past it, a call waits for a slot. */
  readonly toolCallsInFlight?: number;
  /** Approvals waiting for a decision. Past it, the step that asks fails, naming the limit. */
  readonly approvalsPending?: number;
  /**
   * Projects in production at once. Past it, putting another project in
   * production is refused with 403 `production-limit-reached`. Lowering it
   * takes no project out of production: with more in production than the
   * limit, the next one waits until enough come out.
   */
  readonly projectsInProduction?: number;
}

/** A tenant's new name, slug, or both (`renameTenant`). A field left out stays as it is. */
export interface RenameTenantParams {
  readonly tenantId: TenantId;
  readonly name?: string;
  readonly slug?: string;
}

/**
 * How a rename ended. The checks and the write are one change, so a tenant
 * that starts closing, or a slug another tenant takes, while it runs is
 * refused, never written over.
 */
export type RenameTenantOutcome =
  /** Renamed, or already so: the same values again change nothing, `updatedAt` included. */
  | { readonly kind: 'ok' }
  /** No tenant with that id, or a purged one. */
  | { readonly kind: 'tenant-not-found' }
  | { readonly kind: 'tenant-closing' }
  /** Its setup hasn't finished: the create request that finishes it finds it by its slug. */
  | { readonly kind: 'tenant-setup-pending' }
  /** Another tenant has the slug: a purged one, or one whose setup is pending, included. */
  | { readonly kind: 'slug-taken' }
  /**
   * The deployment's verified sign-in domains name this tenant by its
   * current `slug` (`domains`, each `<domain>:<slug>` entry's domain), so
   * after the rename the server would find no tenant by it when it next
   * starts.
   */
  | {
      readonly kind: 'slug-in-config';
      readonly names: 'current';
      readonly slug: string;
      readonly domains: readonly string[];
    }
  /**
   * The deployment's verified sign-in domains name the new slug, so the
   * server's next start would give those domains to this tenant. The
   * entries aren't given: they aren't this tenant's.
   */
  | { readonly kind: 'slug-in-config'; readonly names: 'new' };

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
  /**
   * Rename a tenant: its name, its slug, or both. Its id stays, so
   * everything that names it by id keeps working. The checks (purged,
   * closing, setup pending, a slug another tenant has, a slug the
   * deployment's sign-in settings name) and the write are one change.
   * `PATCH /v1/tenant` and `PATCH /v1/system/tenants/{tenantId}` mount
   * only with it.
   */
  renameTenant?(params: RenameTenantParams): Promise<RenameTenantOutcome>;
}

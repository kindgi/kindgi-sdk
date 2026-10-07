// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `ProjectBinding` + `ProjectMembershipBinding` — the project CRUD
 * surface + the user↔project direct-grant membership surface within a
 * tenant.
 *
 * Projects are the primary content-scope; all content (memory /
 * agents / flows / guardrails / runs / artifacts / cost / evals /
 * approvals / evidence / provenance / observations) carries a
 * required `projectId` and is read/written filtered by it.
 *
 * `getDefault` returns the tenant's auto-created "Default" project.
 * That row is the only one where `Project.isDefault = true`;
 * implementations keep exactly one per tenant (this binding's
 * in-memory adapter checks at write time, before the row lands in the
 * map). Callers that don't naturally know a project resolve the
 * Default with `getDefault` and pass its id explicitly (see e.g.
 * `AgentPublishInput.projectId` in `@kindgi/api`).
 *
 * Same convention as `org-binding.ts`: `tenantId` first, `Page<T>`
 * return, `Filter`-extending filter shapes, and writes the caller can
 * get wrong resolve to an outcome discriminated on `kind` instead of
 * rejecting.
 */

import type { Filter, OrgId, Page, ProjectId, TenantId, UserId } from '@kindgi/types';

import type {
  Project,
  ProjectMembership,
  ProjectPatch,
  ProjectRole,
  ProjectSpec,
} from './types.js';

/**
 * `list` filter for projects. Same shape as `TeamListFilter` — `orgId`
 * narrows to a specific org's projects (nullable FK);
 * `nameContains` is a substring match on `Project.name`.
 */
export interface ProjectListFilter extends Filter {
  readonly orgId?: OrgId;
  readonly nameContains?: string;
}

/**
 * Input for `ProjectMembershipBinding.add`. Distinct interface so
 * downstream additions extend without breaking call sites.
 */
export interface ProjectMembershipAddInput {
  readonly projectId: ProjectId;
  readonly userId: UserId;
  readonly role: ProjectRole;
}

/**
 * The project CRUD binding.
 */
export interface ProjectBinding {
  /**
   * Create a `Project` within the tenant. `spec.orgId` optional.
   * Resolves to `ok` with the assigned `ProjectId`; to `slug-conflict`
   * when another project in the tenant has `spec.slug`; and, when
   * `spec.isDefault === true` and the tenant already has a Default, to
   * `project-default-already-exists` — the isDefault-uniqueness
   * guardrail is enforced at write time.
   */
  create(tenantId: TenantId, spec: ProjectSpec): Promise<ProjectCreateOutcome>;
  /**
   * Look up a `Project` by id. `undefined` when unknown or in a
   * different tenant.
   */
  get(tenantId: TenantId, projectId: ProjectId): Promise<Project | undefined>;
  /**
   * Cursor-paginated list of projects. Filter by `orgId` or
   * `nameContains`.
   */
  list(tenantId: TenantId, filter: ProjectListFilter): Promise<Page<Project>>;
  /**
   * The tenant's Default project (`isDefault: true`). Returns
   * `undefined` when no Default project exists for the tenant.
   */
  getDefault(tenantId: TenantId): Promise<Project | undefined>;
  /**
   * Partially update a `Project`. `ProjectPatch.orgId` supports
   * `null` to re-assign the project out of any org. Resolves to
   * `project-not-found` when no project has `projectId` in the tenant,
   * and to `slug-conflict` when `patch.slug` is another project's slug.
   */
  update(
    tenantId: TenantId,
    projectId: ProjectId,
    patch: ProjectPatch,
  ): Promise<ProjectUpdateOutcome>;
  /**
   * Delete a `Project`. What happens to content rows that still
   * reference the project is the storage layer's concern; the
   * in-memory adapter removes the project's direct memberships and
   * team grants with it.
   */
  delete(tenantId: TenantId, projectId: ProjectId): Promise<void>;
}

/**
 * User↔project direct-grant membership. Additive with team grants
 * (the union rules); a user may have both a direct
 * `ProjectMembership` and access via a team-project grant.
 * Authorization resolves the union.
 */
export interface ProjectMembershipBinding {
  /**
   * Add a user directly to a project. Idempotent on
   * `(projectId, userId)` — re-adding the same user does not mutate
   * a stored differing role. Use `updateRole` to change roles.
   * Resolves to `project-not-found` when no project has
   * `input.projectId` in the tenant.
   */
  add(tenantId: TenantId, input: ProjectMembershipAddInput): Promise<ProjectMembershipAddOutcome>;
  /**
   * Remove the direct project grant. No-op when absent.
   */
  remove(tenantId: TenantId, projectId: ProjectId, userId: UserId): Promise<void>;
  /**
   * Cursor-paginated direct memberships of a project. Ordered by
   * `joinedAt` ascending.
   */
  list(tenantId: TenantId, projectId: ProjectId, filter: Filter): Promise<Page<ProjectMembership>>;
  /**
   * Cursor-paginated direct memberships of a user (across every
   * project the user is directly a member of within the tenant).
   * Used to resolve a user's direct project set.
   */
  listForUser(tenantId: TenantId, userId: UserId, filter: Filter): Promise<Page<ProjectMembership>>;
  /**
   * Update an existing direct-membership's role. Resolves to
   * `project-not-found` when the project isn't in the tenant, and to
   * `project-membership-not-found` when the user has no direct
   * membership.
   */
  updateRole(
    tenantId: TenantId,
    projectId: ProjectId,
    userId: UserId,
    role: ProjectRole,
  ): Promise<ProjectMembershipUpdateRoleOutcome>;
}

/** What `ProjectBinding.create` did. */
export type ProjectCreateOutcome =
  | { readonly kind: 'ok'; readonly projectId: ProjectId }
  | {
      /** Another project in the tenant already has this slug. */
      readonly kind: 'slug-conflict';
      readonly slug: string;
    }
  | {
      /** `spec.isDefault` was `true` and the tenant already has a Default project. */
      readonly kind: 'project-default-already-exists';
    }
  | {
      /**
       * The org the project would be in isn't one of the tenant's: it never
       * existed, or it was deleted. Nothing changed.
       */
      readonly kind: 'org-not-found';
      readonly orgId: OrgId;
    };

/** What `ProjectBinding.update` did. */
export type ProjectUpdateOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No project with this id in the tenant. */
      readonly kind: 'project-not-found';
    }
  | {
      /** Another project in the tenant already has the patched slug. */
      readonly kind: 'slug-conflict';
      readonly slug: string;
    }
  | {
      /**
       * The org the project would be in isn't one of the tenant's: it never
       * existed, or it was deleted. Nothing changed.
       */
      readonly kind: 'org-not-found';
      readonly orgId: OrgId;
    };

/** What `ProjectMembershipBinding.add` did (`ok` when already a member, too). */
export type ProjectMembershipAddOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No project with this id in the tenant. */
      readonly kind: 'project-not-found';
    };

/** What `ProjectMembershipBinding.updateRole` did. */
export type ProjectMembershipUpdateRoleOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No project with this id in the tenant. */
      readonly kind: 'project-not-found';
    }
  | {
      /** The user has no direct membership on the project. */
      readonly kind: 'project-membership-not-found';
    };

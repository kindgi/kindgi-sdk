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

import type { Filter, OrgId, Page, ProjectId, TenantId, Timestamp, UserId } from '@kindgi/types';

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
   * to `slug-conflict` when `patch.slug` is another project's slug, and to
   * `project-in-environment-order` when the patch would change `orgId` for a
   * project that is a member of an environment order (clear it first). A
   * patch that leaves `orgId` untouched — a rename, slug or description
   * change — is never refused on that ground.
   */
  update(
    tenantId: TenantId,
    projectId: ProjectId,
    patch: ProjectPatch,
  ): Promise<ProjectUpdateOutcome>;
  /**
   * Delete a `Project`. Resolves to `project-in-environment-order` when the
   * project is a member of an environment order — the delete does not happen;
   * clear it from the order first. Deleting an id that names no project is
   * `ok` (idempotent). What happens to content rows that still reference a
   * deleted project is the storage layer's concern; the in-memory adapter
   * removes the project's direct memberships and team grants with it.
   */
  delete(tenantId: TenantId, projectId: ProjectId): Promise<ProjectDeleteOutcome>;
  /**
   * Put the project in production (`production: true`), or take it out.
   * Optional: without it, the production route answers 501
   * `production-unsupported`. Setting what's already set changes nothing:
   * it answers `changed: false` and keeps the first `productionSince`. A
   * runtime that meters usage records each change (`project.production`,
   * `on` or `off`) in the same transaction as the change.
   *
   * With the tenant's limit set (`TenantLimits.projectsInProduction`),
   * putting a project in production reads the limit, counts the tenant's
   * projects already in production, and answers `limit-reached` without a
   * change when they're at the limit or past it. The binding reads the
   * limit itself, where the runtime keeps it, and the read, the count and
   * the change are one step: two projects put in production at once can't
   * both pass on the last place, and a limit changed meanwhile is the one
   * counted against. Taking a project out, and a project already in
   * production, are never counted.
   */
  setProduction?(
    tenantId: TenantId,
    projectId: ProjectId,
    production: boolean,
  ): Promise<ProjectProductionOutcome>;
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

/** What `ProjectBinding.setProduction` did. */
export type ProjectProductionOutcome =
  | {
      readonly kind: 'ok';
      /** When it went into production; `null` now that it isn't in production. */
      readonly productionSince: Timestamp | null;
      /** `false` when it was already so, and nothing was written. */
      readonly changed: boolean;
    }
  | {
      /** No project with this id in the tenant. */
      readonly kind: 'project-not-found';
    }
  | {
      /** Not put in production: the tenant's projects in production are at its limit, or past it. */
      readonly kind: 'limit-reached';
      /** The limit. */
      readonly projectsInProduction: number;
      /** The tenant's projects in production now. */
      readonly inProduction: number;
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
    }
  | {
      /**
       * The project is a member of an environment order, so it can't be
       * moved to another parent. Clear it from the order first. Only a patch
       * that changes `orgId` is refused; a rename or slug change is not.
       */
      readonly kind: 'project-in-environment-order';
      readonly orderId: string;
    };

/** What `ProjectBinding.delete` did. */
export type ProjectDeleteOutcome =
  | { readonly kind: 'ok' }
  | {
      /**
       * The project is a member of an environment order, so it can't be
       * deleted. Clear it from the order first.
       */
      readonly kind: 'project-in-environment-order';
      readonly orderId: string;
    };

/** What `ProjectMembershipBinding.add` did (`ok` when already a member, too). */
export type ProjectMembershipAddOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No project with this id in the tenant. */
      readonly kind: 'project-not-found';
    }
  | {
      /** The person is a member already, with another role (kept: change it with `updateRole`). */
      readonly kind: 'membership-exists';
      readonly role: ProjectRole;
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

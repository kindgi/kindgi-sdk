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
 * return, `Filter`-extending filter shapes.
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
   * Create a `Project` within the tenant. `spec.orgId` optional. If
   * `spec.isDefault === true` and a Default already exists, the
   * binding rejects — the isDefault-uniqueness guardrail is enforced
   * at write time.
   */
  create(tenantId: TenantId, spec: ProjectSpec): Promise<ProjectId>;
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
   * `null` to re-assign the project out of any org.
   */
  update(tenantId: TenantId, projectId: ProjectId, patch: ProjectPatch): Promise<void>;
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
   */
  add(tenantId: TenantId, input: ProjectMembershipAddInput): Promise<void>;
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
   * Update an existing direct-membership's role. Errors when the
   * membership doesn't exist.
   */
  updateRole(
    tenantId: TenantId,
    projectId: ProjectId,
    userId: UserId,
    role: ProjectRole,
  ): Promise<void>;
}

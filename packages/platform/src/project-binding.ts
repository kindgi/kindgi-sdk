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
 * `getDefault` returns the tenant's default project (a new tenant gets one).
 * That row is the only one where `Project.isDefault = true`;
 * implementations keep at most one per tenant (this binding's
 * in-memory adapter checks at write time, before the row lands in the
 * map). Callers that don't naturally know a project resolve the
 * default with `getDefault` and pass its id explicitly (see e.g.
 * `AgentPublishInput.projectId` in `@kindgi/api`).
 *
 * Same convention as `org-binding.ts`: `tenantId` first, `Page<T>`
 * return, `Filter`-extending filter shapes, and writes the caller can
 * get wrong resolve to an outcome discriminated on `kind` instead of
 * rejecting.
 *
 * A deleted project is kept, with what's in it, until it's restored. Every
 * read and write here answers for it as for an id that names no project,
 * and its memberships and team grants are out of every list; only
 * `restore` and `listDeleted` see it. Its slugs stay its own.
 */

import type {
  Filter,
  OrgId,
  Page,
  ProjectId,
  SigningKeyId,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import type {
  DeletedProject,
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
   * Create a `Project` within the workspace. `spec.orgId` optional.
   * Resolves to `ok` with the assigned `ProjectId`; to `slug-conflict`
   * when another project in its org has `spec.slug` (for a project without
   * an org: another project without one), or when another project of the
   * workspace had `spec.slug` before it was renamed (`heldAs: 'old-slug'`),
   * with `deletedProject: true` when that project is deleted; and, when
   * `spec.isDefault === true` and the workspace already has a default, to
   * `project-default-already-exists` — the isDefault-uniqueness
   * guardrail is enforced at write time.
   */
  create(tenantId: TenantId, spec: ProjectSpec): Promise<ProjectCreateOutcome>;
  /**
   * Look up a `Project` by id. `undefined` when unknown, deleted, or in a
   * different workspace.
   */
  get(tenantId: TenantId, projectId: ProjectId): Promise<Project | undefined>;
  /**
   * Cursor-paginated list of projects, without the deleted ones. Filter by
   * `orgId` or `nameContains`.
   */
  list(tenantId: TenantId, filter: ProjectListFilter): Promise<Page<Project>>;
  /**
   * The workspace's default project (`isDefault: true`). Returns
   * `undefined` when no default project exists for the workspace.
   */
  getDefault(tenantId: TenantId): Promise<Project | undefined>;
  /**
   * Partially update a `Project`. `ProjectPatch.orgId` supports
   * `null` to re-assign the project out of any org. Resolves to
   * `project-not-found` when no project has `projectId` in the workspace,
   * to `slug-conflict` when `patch.slug` is another project's slug where the
   * project ends up, or a slug another project of the workspace had before it
   * was renamed (`heldAs: 'old-slug'`), either with `deletedProject: true`
   * when the project holding it is deleted, and to
   * `project-in-environment-order` when the patch would change `orgId` for a
   * project that is a member of an environment order (clear it first). A
   * patch that leaves `orgId` untouched — a rename, slug or description
   * change — is never refused on that ground.
   *
   * A patch that changes the slug keeps the old one as the project's: it
   * joins `Project.formerSlugs`, and no other project can take it. The
   * project can take it back, unless another project holds it too. A patch
   * whose slug is the current one changes nothing there.
   */
  update(
    tenantId: TenantId,
    projectId: ProjectId,
    patch: ProjectPatch,
  ): Promise<ProjectUpdateOutcome>;
  /**
   * Delete a `Project`: it's kept, with its memberships, team grants and
   * slugs, and from then on it's gone from every read here (see above).
   * Resolves to `project-in-environment-order` when the project is a member
   * of an environment order, and to `project-is-default` for the
   * workspace's default project; the delete does not happen. Deleting an id
   * that names no project, or a deleted one, is `ok` with `changed: false`
   * (idempotent), and a deleted one keeps the time it was first deleted.
   * The API records a delete that changed something. What a runtime does
   * with what's in the project (its runs, its triggers, who may reach it)
   * is the runtime's concern: Kindgi's cancels the project's unfinished
   * runs once the delete commits, and `createApp`'s `projectDeleted`
   * refuses what would start in it.
   */
  delete(tenantId: TenantId, projectId: ProjectId): Promise<ProjectDeleteOutcome>;
  /**
   * Bring a deleted project back as it was: its memberships, team grants
   * and slugs with it. Its `updatedAt` moves to the restore, as a change's
   * does. A live project is `ok` with `changed: false`, unchanged. The API
   * records a restore that changed something.
   * Resolves to `project-not-found` when no project, live or deleted, has
   * `projectId` in the workspace. Optional, with `listDeleted`: without
   * them, the restore and deleted-list routes answer 501
   * `project-restore-unsupported`.
   *
   * A deleted project isn't counted against the workspace's limit on
   * projects in production (`setProduction`). Restoring one that's in
   * production counts it again: with the workspace's projects in production
   * at its limit, or past it, the restore answers `limit-reached` and the
   * project stays deleted. The read, the count and the restore are one
   * step, as `setProduction`'s are.
   */
  restore?(tenantId: TenantId, projectId: ProjectId): Promise<ProjectRestoreOutcome>;
  /**
   * Cursor-paginated list of the workspace's deleted projects, the most
   * recently deleted first.
   */
  listDeleted?(tenantId: TenantId, filter: Filter): Promise<Page<DeletedProject>>;
  /**
   * Put the project in production (`production: true`), or take it out.
   * Optional: without it, the production route answers 501
   * `production-unsupported`. Setting what's already set changes nothing:
   * it answers `changed: false` and keeps the first `productionSince`. A
   * runtime that meters usage records each change (`project.production`,
   * `on` or `off`) in the same transaction as the change.
   *
   * With the workspace's limit set (`TenantLimits.projectsInProduction`),
   * putting a project in production reads the limit, counts the workspace's
   * projects already in production, and answers `limit-reached` without a
   * change when they're at the limit or past it. The binding reads the
   * limit itself, where the runtime keeps it, and the read, the count and
   * the change are one step: two projects put in production at once can't
   * both pass on the last place, and a limit changed meanwhile is the one
   * counted against. Taking a project out, and a project already in
   * production, are never counted.
   *
   * A binding that keeps the workspace's deployments in the same store
   * answers `promote-only-build` without a change when a promote-only
   * build was deployed into the project (not promoted there), read in the
   * same step under the project's lock. A deploy registered with
   * `promoteOnly` takes that lock too, so a deploy and the change landing
   * at once can't both pass: whichever comes second sees the other. The
   * production route asks the same before it calls this; a binding that
   * never answers `promote-only-build` leaves that check the only one.
   */
  setProduction?(
    tenantId: TenantId,
    projectId: ProjectId,
    production: boolean,
  ): Promise<ProjectProductionOutcome>;
  /**
   * Set the project's repo connection (`connectionId`), or clear it
   * (`null`). Optional: without it, the repo-connection routes answer 501
   * `repo-connection-unsupported`. The caller checks the connection; the
   * binding keeps its id only, with no reference to it, so a connection
   * removed later leaves the id in place. Setting what's already set
   * answers `changed: false`.
   */
  setRepoConnection?(
    tenantId: TenantId,
    projectId: ProjectId,
    connectionId: string | null,
  ): Promise<ProjectRepoConnectionOutcome>;
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
   * `input.projectId` in the workspace.
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
   * project the user is directly a member of within the workspace).
   * Used to resolve a user's direct project set.
   */
  listForUser(tenantId: TenantId, userId: UserId, filter: Filter): Promise<Page<ProjectMembership>>;
  /**
   * Update an existing direct-membership's role. Resolves to
   * `project-not-found` when the project isn't in the workspace, and to
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
      /**
       * Another project in its org already has this slug, or, with
       * `heldAs: 'old-slug'`, another project of the workspace had it before it
       * was renamed.
       */
      readonly kind: 'slug-conflict';
      readonly slug: string;
      readonly heldAs?: 'old-slug';
      /** The project holding the slug is deleted: it's still its own. */
      readonly deletedProject?: true;
    }
  | {
      /** `spec.isDefault` was `true` and the workspace already has a default project. */
      readonly kind: 'project-default-already-exists';
    }
  | {
      /**
       * The org the project would be in isn't one of the workspace's: it never
       * existed, or it was deleted. Nothing changed.
       */
      readonly kind: 'org-not-found';
      readonly orgId: OrgId;
    };

/** What `ProjectBinding.setRepoConnection` did. */
export type ProjectRepoConnectionOutcome =
  | {
      readonly kind: 'ok';
      /** The connection now set; `null` once cleared. */
      readonly repoConnectionId: string | null;
      /** `false` when it was already so, and nothing was written. */
      readonly changed: boolean;
    }
  | {
      /** No project with this id in the workspace. */
      readonly kind: 'project-not-found';
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
      /** No project with this id in the workspace. */
      readonly kind: 'project-not-found';
    }
  | {
      /** Not put in production: the workspace's projects in production are at its limit, or past it. */
      readonly kind: 'limit-reached';
      /** The limit. */
      readonly projectsInProduction: number;
      /** The workspace's projects in production now. */
      readonly inProduction: number;
    }
  | {
      /**
       * Not put in production: a promote-only build was deployed into the
       * project, not promoted there, so it never goes into production.
       */
      readonly kind: 'promote-only-build';
      /** The deployment that keeps it out (the first the binding found). */
      readonly deploymentId: string;
      /** The key that signed that deployment. */
      readonly signerKeyId: SigningKeyId;
    };

/** What `ProjectBinding.update` did. */
export type ProjectUpdateOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No project with this id in the workspace. */
      readonly kind: 'project-not-found';
    }
  | {
      /**
       * Another project already has the slug where the project ends up, or,
       * with `heldAs: 'old-slug'`, another project of the workspace had the
       * patched slug before it was renamed.
       */
      readonly kind: 'slug-conflict';
      readonly slug: string;
      readonly heldAs?: 'old-slug';
      /** The project holding the slug is deleted: it's still its own. */
      readonly deletedProject?: true;
    }
  | {
      /**
       * The org the project would be in isn't one of the workspace's: it never
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
  | {
      readonly kind: 'ok';
      /** `false` when no live project had the id, and nothing was written. */
      readonly changed: boolean;
    }
  | {
      /**
       * The project is a member of an environment order, so it can't be
       * deleted. Clear it from the order first.
       */
      readonly kind: 'project-in-environment-order';
      readonly orderId: string;
    }
  | {
      /** The workspace's default project, which can't be deleted. */
      readonly kind: 'project-is-default';
    };

/** What `ProjectBinding.restore` did. */
export type ProjectRestoreOutcome =
  | {
      readonly kind: 'ok';
      /** The project, live again. */
      readonly project: Project;
      /** `false` when it wasn't deleted, and nothing was written. */
      readonly changed: boolean;
    }
  | {
      /** No project, live or deleted, with this id in the workspace. */
      readonly kind: 'project-not-found';
    }
  | {
      /**
       * Not restored: the project is in production, and the workspace's
       * projects in production are at its limit, or past it.
       */
      readonly kind: 'limit-reached';
      /** The limit. */
      readonly projectsInProduction: number;
      /** The workspace's projects in production now. */
      readonly inProduction: number;
    };

/** What `ProjectMembershipBinding.add` did (`ok` when already a member, too). */
export type ProjectMembershipAddOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No project with this id in the workspace. */
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
      /** No project with this id in the workspace. */
      readonly kind: 'project-not-found';
    }
  | {
      /** The user has no direct membership on the project. */
      readonly kind: 'project-membership-not-found';
    };

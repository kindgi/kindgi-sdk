// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Multi-tenant hierarchy primitives — the type surface for the
 * `Workspace → Org → Team → Project + User` flow.
 *
 * **Pure type shapes.** No runtime code, no validation, no defaults.
 * Binding interfaces live in the sibling `*-binding.ts` files;
 * reference in-memory adapters live under `in-memory/`.
 *
 * Branded IDs are imported from `@kindgi/types` — this package
 * adds no new IDs. `Tenant` itself has no full shape here (only the
 * read-only `TenantSummary` in `tenant-hierarchy-binding.ts`); this
 * package models the hierarchy that sits *under* the tenant.
 */

import type { OrgId, ProjectId, TeamId, TenantId, Timestamp, UserId } from '@kindgi/types';

// ============================================================
// Org — optional structural subdivision within a tenant.
// A firm's litigation department; a hospital's cardiology; a bank's
// commercial-lending LOB. Small tenants ignore Org entirely (no rows,
// no reference on child entities). Large tenants use Org to enforce
// structural boundaries.
// ============================================================

export interface Org {
  readonly id: OrgId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface OrgSpec {
  readonly name: string;
  readonly slug: string;
}

export interface OrgPatch {
  readonly name?: string;
  readonly slug?: string;
}

// ============================================================
// Team — people-group. A named collection of users who work together.
// A matter team; a care team; a deal team. Users belong to many teams.
// Same team works on many projects; same project can have many teams
// collaborating. Distinct from Org (structural) — Team is about
// *working groups*, which cross Org boundaries. Team↔Project is N..N
// via `TeamProjectGrant`.
// ============================================================

export interface Team {
  readonly id: TeamId;
  readonly tenantId: TenantId;
  /**
   * Optional — a team may belong to an org, or be cross-org (no
   * `orgId`).
   */
  readonly orgId?: OrgId;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface TeamSpec {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly orgId?: OrgId;
}

export interface TeamPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string;
  /**
   * `null` explicitly re-assigns the team out of any org (cross-org).
   * `undefined` leaves the FK untouched.
   */
  readonly orgId?: OrgId | null;
}

/**
 * Roles on a `TeamMembership`. Aligned with org/project vocabulary:
 * `admin` + `member`. Additive with project-level grants: a user in
 * three teams has the union of the three teams' project grants.
 * Framework-owned — no external directory sync.
 */
export type TeamRole = 'member' | 'admin';

export interface TeamMembership {
  readonly teamId: TeamId;
  readonly userId: UserId;
  readonly role: TeamRole;
  readonly joinedAt: Timestamp;
}

// ============================================================
// Project — the primary content-scope. Facts, artifacts, runs, blobs,
// evidence, approvals belong to a Project. Vertical-agnostic on the
// wire; verticalized in packs (`Matter` in legal, `Case` in HR,
// `Engagement` in accounting, `Episode` in healthcare, `Deal` in
// finance).
//
// `isDefault` marks each tenant's default project (a new tenant gets one).
// Implementations keep at most one per tenant (the in-memory adapter
// rejects a second default on `create`).
// ============================================================

export interface Project {
  readonly id: ProjectId;
  readonly tenantId: TenantId;
  /**
   * Optional — a project may belong to an org, or be cross-org (no
   * `orgId`).
   */
  readonly orgId?: OrgId;
  readonly name: string;
  readonly slug: string;
  /**
   * `true` for the workspace's default project (a new workspace gets one). At most
   * one row per workspace carries `isDefault = true`.
   * `false` for every other project.
   */
  readonly isDefault: boolean;
  readonly description?: string;
  /**
   * When the project was put in production; absent while it isn't. A run
   * in a project in production is a production run (usage class
   * `production`), and a run anywhere else is staging. Set and cleared by
   * `ProjectBinding.setProduction`.
   */
  readonly productionSince?: Timestamp;
  /**
   * The slugs the project had before it was renamed, newest first, and
   * empty when it never was. They stay the project's: no other project of
   * the workspace can take one, in any org, while the project exists. A
   * binding that keeps them always fills this in; it's absent only from one
   * that doesn't.
   */
  readonly formerSlugs?: readonly string[];
  /**
   * `true` sorts end users' corrections (an app's, for a `participantId`,
   * and not an expert's) like the others, and a schedule counting everyone's
   * counts them. Absent or `false`: they're listed and become test cases,
   * but stay open and unsorted, and never start Improve. Admin on the
   * project sets it (`ProjectPatch`).
   */
  readonly sortEndUserCorrections?: boolean;
  /**
   * The company-wide GitHub connection the project opens its block
   * changes' pull requests through; absent while none is set. Set and
   * cleared by `ProjectBinding.setRepoConnection`. The connection may be
   * gone since: a reader treats that as none.
   */
  readonly repoConnectionId?: string;
  /**
   * `true`: every person in the project's workspace may run it, without a
   * role of their own; service accounts aren't included. That reads only
   * what running takes (the project, its agents and flows, each person's
   * own runs). Absent or `false`: only those given a role. A new project has it unless its
   * creator turns it off; existing projects and workspaces keep it `false`
   * until a project admin turns it on.
   * Admin on the project changes it (`ProjectPatch`).
   */
  readonly everyoneCanRun?: boolean;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * A deleted project, as `ProjectBinding.listDeleted` answers it: what a
 * workspace admin needs to find the one to restore. The project is kept,
 * with what's in it; it's gone from every read until it's restored.
 */
export interface DeletedProject {
  readonly id: ProjectId;
  readonly tenantId: TenantId;
  /** Its org, when it has one. */
  readonly orgId?: OrgId;
  readonly name: string;
  /** Its slug, still its own while it's deleted. */
  readonly slug: string;
  /** The slugs it had before it was renamed, newest first; still its own too. */
  readonly formerSlugs: readonly string[];
  /** When it was deleted. Deleting it again keeps this time; a restore clears it. */
  readonly deletedAt: Timestamp;
}

export interface ProjectSpec {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly orgId?: OrgId;
  /**
   * Optional at spec time — the workspace's default project is created
   * by the framework at workspace-inception, not by a caller. User
   * projects created via `POST /v1/projects` default to `false`.
   */
  readonly isDefault?: boolean;
  /**
   * `Project.everyoneCanRun`. Absent is `false`: `POST /v1/projects`
   * passes it, `true` unless the caller turns it off.
   */
  readonly everyoneCanRun?: boolean;
}

export interface ProjectPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string;
  /**
   * `null` explicitly re-assigns the project out of any org.
   * `undefined` leaves the FK untouched.
   */
  readonly orgId?: OrgId | null;
  /** `Project.sortEndUserCorrections`; `undefined` leaves it as it is. */
  readonly sortEndUserCorrections?: boolean;
  /**
   * `Project.everyoneCanRun`; `undefined` leaves it as it is. Where
   * authorization is enforced, it changes through
   * `TenantHierarchyBinding.updateProject`, with its grant.
   */
  readonly everyoneCanRun?: boolean;
}

/**
 * Roles on a `ProjectMembership` — the direct `User → Project` grant
 * shape. Additive with team-grants. Mirrors the OpenFGA project-type
 * relations (owner / editor / runner / viewer) plus the
 * lightweight `member` and administrative `admin` shorthands. A `runner`
 * sees what a `viewer` does, starts runs of the project's agents and
 * flows, stops their own runs and keeps their own schedules.
 */
export type ProjectRole = 'viewer' | 'runner' | 'editor' | 'owner' | 'admin' | 'member';

/**
 * A role a team holds on a project: `viewer`, `runner`, `editor` or
 * `admin`. A team never owns one (`owner` is a person's), and `member` is
 * retired.
 */
export type TeamProjectRole = Exclude<ProjectRole, 'owner' | 'member'>;

export interface ProjectMembership {
  readonly projectId: ProjectId;
  readonly userId: UserId;
  readonly role: ProjectRole;
  readonly joinedAt: Timestamp;
}

// Authorization types (object types, actions, tuples, checks) live in
// `@kindgi/authz`.

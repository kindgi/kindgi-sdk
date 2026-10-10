// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Multi-tenant hierarchy primitives — the type surface for the
 * `Tenant → Org → Team → Project + User` flow.
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
// `isDefault` marks the auto-created "Default" project per tenant.
// Implementations keep exactly one per tenant (the in-memory adapter
// rejects a second Default on `create`).
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
   * `true` for the tenant's auto-created "Default" project. Exactly
   * one row per tenant carries `isDefault = true`.
   * `false` for every user-created project.
   */
  readonly isDefault: boolean;
  readonly description?: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface ProjectSpec {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly orgId?: OrgId;
  /**
   * Optional at spec time — the tenant's Default project is created
   * by the framework at tenant-inception, not by a caller. User
   * projects created via `POST /v1/projects` default to `false`.
   */
  readonly isDefault?: boolean;
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
}

/**
 * Roles on a `ProjectMembership` — the direct `User → Project` grant
 * shape. Additive with team-grants. Mirrors the OpenFGA project-type
 * relations (owner / editor / viewer) plus the
 * lightweight `member` and administrative `admin` shorthands.
 */
export type ProjectRole = 'viewer' | 'editor' | 'owner' | 'admin' | 'member';

/**
 * A role a team holds on a project: `viewer`, `editor` or `admin`. A team
 * never owns one (`owner` is a person's), and `member` is retired.
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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `TeamProjectGrant` — the team↔project join surface. One row per
 * `(teamId, projectId)` primary key; the `role` names the project-
 * scope grant every team member inherits via the FGA `team:T#member`
 * userset (see `@kindgi/authz`).
 *
 * Same tenant-first convention as every other binding in
 * `@kindgi/platform`. The in-memory reference implementation is part
 * of `makeInMemoryProjectBinding` (its `grants` binding).
 */

import type { Filter, Page, ProjectId, TeamId, TenantId } from '@kindgi/types';

import type { ProjectRole } from './types.js';

/**
 * A team-mediated grant on a project. The `role` uses the same
 * `ProjectRole` union as direct `ProjectMembership.role` — semantics
 * compose (the authorization model resolves the union / inheritance).
 */
export interface TeamProjectGrant {
  readonly teamId: TeamId;
  readonly projectId: ProjectId;
  readonly role: ProjectRole;
}

export interface TeamProjectGrantAddInput {
  readonly teamId: TeamId;
  readonly projectId: ProjectId;
  readonly role: ProjectRole;
}

/**
 * CRUD for team↔project grants.
 */
export interface TeamProjectGrantBinding {
  /**
   * Add a team-project grant. Idempotent on `(teamId, projectId)` —
   * re-adding the same team on the same project does not mutate a
   * stored differing role. Use `updateRole` to change roles.
   */
  add(tenantId: TenantId, input: TeamProjectGrantAddInput): Promise<void>;
  /** Remove a team-project grant. No-op when absent. */
  remove(tenantId: TenantId, teamId: TeamId, projectId: ProjectId): Promise<void>;
  /** Cursor-paginated grants filtered by tenant. */
  list(tenantId: TenantId, filter: Filter): Promise<Page<TeamProjectGrant>>;
  /** Cursor-paginated grants for a specific team. */
  listForTeam(tenantId: TenantId, teamId: TeamId, filter: Filter): Promise<Page<TeamProjectGrant>>;
  /** Cursor-paginated grants for a specific project. */
  listForProject(
    tenantId: TenantId,
    projectId: ProjectId,
    filter: Filter,
  ): Promise<Page<TeamProjectGrant>>;
  /** Update a grant's role. Errors when the grant doesn't exist. */
  updateRole(
    tenantId: TenantId,
    teamId: TeamId,
    projectId: ProjectId,
    role: ProjectRole,
  ): Promise<void>;
}

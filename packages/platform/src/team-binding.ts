// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `TeamBinding` + `TeamMembershipBinding` — the team CRUD surface + the
 * user↔team membership surface within a tenant.
 *
 * Team memberships are **framework-owned**: there is no external
 * directory sync. `TeamMembershipBinding` is the sole source of
 * truth.
 *
 * Same convention as `org-binding.ts`: `tenantId` first, `Page<T>`
 * return, `Filter`-extending filter shapes, and writes the caller can
 * get wrong resolve to an outcome discriminated on `kind` instead of
 * rejecting.
 */

import type { Filter, OrgId, Page, TeamId, TenantId, UserId } from '@kindgi/types';

import type { Team, TeamMembership, TeamPatch, TeamRole, TeamSpec } from './types.js';

/**
 * `list` filter for teams. `orgId` narrows to teams belonging to a
 * specific org (the `Team.orgId?` nullable FK); absent =
 * no org filter, including cross-org teams. `nameContains` mirrors
 * the org shape.
 */
export interface TeamListFilter extends Filter {
  readonly orgId?: OrgId;
  readonly nameContains?: string;
}

/**
 * Input for `TeamMembershipBinding.add`. Distinct interface (not
 * positional args) so downstream additions — e.g., an `addedBy?:
 * UserId` audit field added later — extend without breaking
 * every call site.
 */
export interface TeamMembershipAddInput {
  readonly teamId: TeamId;
  readonly userId: UserId;
  readonly role: TeamRole;
}

/**
 * The team CRUD binding.
 */
export interface TeamBinding {
  /**
   * Create a `Team` within the tenant. `spec.orgId` optional (a team
   * may be cross-org — nullable FK). Resolves to `ok` with the
   * assigned `TeamId`, or to `slug-conflict` when another team in the
   * tenant has `spec.slug`.
   */
  create(tenantId: TenantId, spec: TeamSpec): Promise<TeamCreateOutcome>;
  /**
   * Look up a `Team` by id. `undefined` when unknown or in a different
   * tenant.
   */
  get(tenantId: TenantId, teamId: TeamId): Promise<Team | undefined>;
  /**
   * Cursor-paginated list of teams. Filter by `orgId` (narrow to one
   * org's teams) or `nameContains` (substring match on `Team.name`).
   */
  list(tenantId: TenantId, filter: TeamListFilter): Promise<Page<Team>>;
  /**
   * Partially update a `Team`. `TeamPatch.orgId` supports `null` to
   * explicitly re-assign the team out of any org (cross-org), and
   * `undefined` to leave the FK untouched. Resolves to `team-not-found`
   * when no team has `teamId` in the tenant, and to `slug-conflict`
   * when `patch.slug` is another team's slug.
   */
  update(tenantId: TenantId, teamId: TeamId, patch: TeamPatch): Promise<TeamUpdateOutcome>;
  /**
   * Delete a `Team`. Its membership rows are removed with it (the
   * in-memory adapter deletes them from its map).
   */
  delete(tenantId: TenantId, teamId: TeamId): Promise<void>;
}

/**
 * User↔team membership CRUD. Typical consumers: identity views that
 * show a user's teams, and authorization, where the `team:T#member`
 * userset (see `@kindgi/authz`) gives members access to projects
 * through a team-project grant.
 */
export interface TeamMembershipBinding {
  /**
   * Add a user to a team with a given role. Idempotent on the
   * `(teamId, userId)` primary key — re-adding the same user does not
   * duplicate the row. To change an existing member's role use
   * `updateRole` (semantics are explicit; add-with-role does not
   * silently mutate a differing role).
   *
   * The conformance suite pins this: adding an existing member whose
   * stored role differs is a no-op (not a role overwrite). Resolves to
   * `team-not-found` when no team has `input.teamId` in the tenant.
   */
  add(tenantId: TenantId, input: TeamMembershipAddInput): Promise<TeamMembershipAddOutcome>;
  /**
   * Remove a user from a team. Missing membership is a no-op (not an
   * error) — matches every peer platform's membership-remove shape.
   */
  remove(tenantId: TenantId, teamId: TeamId, userId: UserId): Promise<void>;
  /**
   * Cursor-paginated memberships of a team. Ordered by `joinedAt`
   * ascending; the conformance suite pins this ordering.
   */
  list(tenantId: TenantId, teamId: TeamId, filter: Filter): Promise<Page<TeamMembership>>;
  /**
   * Cursor-paginated memberships of a user (across every team the
   * user belongs to within the tenant). Used to resolve a user's team
   * set (identity views, authorization inheritance).
   */
  listForUser(tenantId: TenantId, userId: UserId, filter: Filter): Promise<Page<TeamMembership>>;
  /**
   * Update an existing membership's role. Resolves to `team-not-found`
   * when the team isn't in the tenant, and to
   * `team-membership-not-found` when the user isn't a member — role
   * mutation of a non-member is a caller mistake, not a silent add.
   */
  updateRole(
    tenantId: TenantId,
    teamId: TeamId,
    userId: UserId,
    role: TeamRole,
  ): Promise<TeamMembershipUpdateRoleOutcome>;
}

/** What `TeamBinding.create` did. */
export type TeamCreateOutcome =
  | { readonly kind: 'ok'; readonly teamId: TeamId }
  | {
      /** Another team in the tenant already has this slug. */
      readonly kind: 'slug-conflict';
      readonly slug: string;
    }
  | {
      /**
       * The org the team would be in isn't one of the tenant's: it never
       * existed, or it was deleted. Nothing changed.
       */
      readonly kind: 'org-not-found';
      readonly orgId: OrgId;
    };

/** What `TeamBinding.update` did. */
export type TeamUpdateOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No team with this id in the tenant. */
      readonly kind: 'team-not-found';
    }
  | {
      /** Another team in the tenant already has the patched slug. */
      readonly kind: 'slug-conflict';
      readonly slug: string;
    }
  | {
      /**
       * The org the team would be in isn't one of the tenant's: it never
       * existed, or it was deleted. Nothing changed.
       */
      readonly kind: 'org-not-found';
      readonly orgId: OrgId;
    };

/** What `TeamMembershipBinding.add` did (`ok` when already a member, too). */
export type TeamMembershipAddOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No team with this id in the tenant. */
      readonly kind: 'team-not-found';
    };

/** What `TeamMembershipBinding.updateRole` did. */
export type TeamMembershipUpdateRoleOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No team with this id in the tenant. */
      readonly kind: 'team-not-found';
    }
  | {
      /** The user isn't a member of the team. */
      readonly kind: 'team-membership-not-found';
    };

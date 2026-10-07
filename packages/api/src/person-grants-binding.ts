// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReviewerRole } from '@kindgi/authz';
import type { ProjectRole, TeamRole } from '@kindgi/platform';
import type { Result, TenantId } from '@kindgi/types';

/**
 * A person's grants: what a person of the tenant may do, read in one
 * call, and tenant admin given or taken (`/v1/identity/users/:id/grants`,
 * `/grant`, `/ungrant`).
 *
 * The read lists what was granted *directly*: tenant admin, a role on a
 * project (its memberships), a role in a team, and the reviewer roster.
 * What a team's or an org's grants imply is not expanded. Project and
 * team roles keep their own membership routes; only tenant admin is
 * granted here, written before the call answers so the person's next
 * request already holds it.
 */
export interface PersonGrants {
  readonly userId: string;
  /** Absent when the runtime has no authorization store: nothing grants it then. */
  readonly tenantAdmin?: boolean;
  /** Direct project memberships. */
  readonly projects: readonly { readonly projectId: string; readonly role: ProjectRole }[];
  /** Team memberships. */
  readonly teams: readonly { readonly teamId: string; readonly role: TeamRole }[];
  /** The person's active entry on the reviewer roster. */
  readonly reviewer?: { readonly role: ReviewerRole };
}

/** What `grant` and `ungrant` take: tenant admin (project and team roles have membership routes). */
export type PersonGrant = { readonly kind: 'tenant-admin' };

export interface PersonRef {
  readonly tenantId: TenantId;
  readonly userId: string;
}

/** A change to a person's grants, and who made it: `user:<id>` or `service_account:<id>`. */
export interface PersonGrantChange extends PersonRef {
  readonly grant: PersonGrant;
  readonly by?: string;
}

export type PersonGrantErrorCode =
  /** No such person in the tenant's directory. */
  | 'identity-user-not-found'
  /** Removing tenant admin from the only person who holds it. */
  | 'last-tenant-admin'
  /** Removing tenant admin from the seed user, whom the runtime grants it at every boot. */
  | 'seed-user-admin'
  /** The runtime has no authorization store to write grants to. */
  | 'person-grants-unsupported';

export interface PersonGrantError {
  readonly code: PersonGrantErrorCode;
  readonly message: string;
}

export interface PersonGrantsBinding {
  /** The person's grants, or `null` when there's no such person. */
  read(input: PersonRef): Promise<PersonGrants | null>;
  /** Grant (a no-op when held); answers with the grants after. */
  grant(input: PersonGrantChange): Promise<Result<PersonGrants, PersonGrantError>>;
  /** Remove (a no-op when not held); answers with the grants after. */
  ungrant(input: PersonGrantChange): Promise<Result<PersonGrants, PersonGrantError>>;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Action, ObjectType, ProjectRole, TeamRole } from '@kindgi/authz';
import type { TenantId } from '@kindgi/types';

import type { TokenPrincipal } from './token-admin.js';

/**
 * What a principal holds, as the runtime's authorization store decides it:
 * the projects it may read, with the role it holds in each and every way it
 * holds it; its orgs and teams; and what each project role allows. `GET
 * /v1/identity/me/permissions` answers it for the caller, with the caller's
 * API key's limits applied on top, so a console hides what the caller can't
 * do instead of offering it and answering 403.
 *
 * Only what the principal may see: projects it may `read`, orgs and teams
 * it's a member of. Nothing here names a project it can't read, or anyone
 * else's role.
 */
export interface MyAccess {
  /**
   * A tenant member (reads the tenant's settings). Absent when the store
   * doesn't say.
   */
  readonly tenantMember?: boolean;
  /** The projects the principal may read. */
  readonly projects: readonly ProjectAccess[];
  /** The orgs the principal is a member or admin of. */
  readonly orgs: readonly OrgAccess[];
  /** The teams the principal is a member or admin of. */
  readonly teams: readonly TeamAccess[];
  /**
   * What each project role allows on the project and the objects in it:
   * role → object type → actions. Worked out from the authorization model
   * itself (a role held on a project, asked of an object in it), so it
   * changes with the model, never with a copy of it.
   */
  readonly capabilities: RoleCapabilities;
}

/** Role → object type → the actions that role allows on every object of that type in its project. */
export type RoleCapabilities = Readonly<
  Partial<Record<ProjectRole, Readonly<Partial<Record<ObjectType, readonly Action[]>>>>>
>;

export interface ProjectAccess {
  readonly projectId: string;
  readonly name: string;
  /** The highest role the principal holds on the project, whichever way. */
  readonly role: ProjectRole;
  /** Every way the principal holds a role on it. */
  readonly via: readonly AccessPath[];
}

/** One way a principal holds a role on a project. */
export type AccessPath =
  /** A membership of its own. `since`: when it was added, when the store keeps it. */
  | { readonly kind: 'direct'; readonly role: ProjectRole; readonly since?: string }
  /** Through a team it's in, which holds `role` on the project. */
  | {
      readonly kind: 'team';
      readonly teamId: string;
      readonly teamName: string;
      readonly role: ProjectRole;
      /** When the principal joined the team, when the store keeps it. */
      readonly since?: string;
    }
  /** As an admin of the org the project sits in: admin on the project. */
  | { readonly kind: 'org-admin'; readonly orgId: string; readonly orgName: string }
  /** As a tenant admin: admin on every project. */
  | { readonly kind: 'tenant-admin' };

export interface OrgAccess {
  readonly orgId: string;
  readonly name: string;
  readonly role: 'admin' | 'member';
}

export interface TeamAccess {
  readonly teamId: string;
  readonly name: string;
  readonly role: TeamRole;
}

export interface MyAccessBinding {
  /** What `principal` holds in `tenantId`. Throws when the store can't be read. */
  read(input: {
    readonly tenantId: TenantId;
    readonly principal: TokenPrincipal;
  }): Promise<MyAccess>;
}

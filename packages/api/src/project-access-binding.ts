// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectRole, TeamProjectRole } from '@kindgi/platform';
import type { ProjectId, TenantId } from '@kindgi/types';

/**
 * Who has access to a project, and how (`GET /v1/projects/{projectId}/access`):
 * everyone the authorization store lets in, with each way in. The route
 * works out each one's effective role, orders and pages them, and shows
 * emails to the project's admins only.
 */
export interface ProjectAccessBinding {
  /** Everyone with access to the project and each way in; `null` when there's no such project. */
  list(input: {
    readonly tenantId: TenantId;
    readonly projectId: ProjectId;
  }): Promise<readonly ProjectAccessHolder[] | null>;
}

/** Whom access is held by: a person, or a service account. */
export interface AccessPrincipal {
  readonly kind: 'user' | 'service-account';
  readonly id: string;
}

/** One way into a project. */
export type ProjectAccessPath =
  /**
   * The principal's own role on the project. `joinedAt` when a membership
   * stands behind it (a tuple without one, such as a creator's `owner`
   * from before memberships recorded it, has none: no membership route
   * changes it).
   */
  | { readonly kind: 'direct'; readonly role: ProjectRole; readonly joinedAt?: string }
  /** A team's grant on the project, which every member of the team holds. */
  | {
      readonly kind: 'team';
      readonly teamId: string;
      readonly teamName?: string;
      readonly role: TeamProjectRole;
    }
  /** An admin of the project's org, directly or through a team: admin on the project. */
  | { readonly kind: 'org-admin'; readonly orgId: string; readonly orgName?: string }
  /** A tenant admin: admin on every project. */
  | { readonly kind: 'tenant-admin' };

/** Someone with access, and every way they have it. */
export interface ProjectAccessHolder {
  readonly principal: AccessPrincipal;
  /** A person's name, or a service account's. */
  readonly displayName?: string;
  /** A person's email. The route shows it to the project's admins only. */
  readonly primaryEmail?: string;
  /** Never empty. */
  readonly via: readonly ProjectAccessPath[];
}

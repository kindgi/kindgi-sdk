// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, TenantId, Timestamp, UserId } from '@kindgi/types';

/**
 * Caller-plugged surface for the tenant-scoped identity directory —
 * part of the admin control plane. Closes the "who is my
 * user" gap the session-auth flow leaves open: the session store
 * (`SessionStoreBinding`) knows about the sessions a user has, and the
 * identity provider (`IdentityProviderBinding`) knows how to
 * authenticate them, but neither answers the "list every user in this
 * tenant" / "show me a user's profile" / "revoke all a user's active
 * sessions" question this binding covers.
 *
 * The framework does NOT own user persistence. Deployments plug in an
 * LDAP / SCIM / IdP-mirror / bespoke store behind this binding.
 *
 * Same caller-plugged pattern as every other admin-plane binding
 * (`PolicyRegistryBinding`, `ProviderRegistryBinding`, ...).
 *
 * The directory is flat. Groups / roles / RBAC / invitations /
 * audit history / LDAP+SCIM sync / impersonation are not part of this
 * binding. Adding a person (`createUser`) is optional: a directory that
 * mirrors an identity provider leaves it out.
 */
export interface IdentityDirectoryBinding {
  /**
   * Look up a specific user by id. Returns `null` when unknown —
   * the route surfaces `null` as `404 identity-user-not-found`.
   */
  getUser(input: IdentityGetUserInput): Promise<UserRecord | null>;
  /**
   * Cursor-paginated list of users in the tenant. Optional `query`
   * is a prefix match on `displayName` — the natural filter shape
   * for a "search users" surface. Sort order is binding-defined (e.g.
   * ascending by `userId`).
   */
  listUsers(input: IdentityListUsersInput): Promise<UserCollectionPage>;
  /**
   * List the active (non-revoked, non-expired) sessions for a user.
   * Implementations may return the full list; `nextCursor` is optional
   * on the response, so an implementation can paginate without a wire
   * change.
   *
   * When the user id is unknown, an empty list is returned rather
   * than a not-found. Callers who need the distinction should call
   * `getUser` first.
   */
  listSessions(input: IdentityListSessionsInput): Promise<SessionSummaryPage>;
  /**
   * Admin op: revoke every active session for a user. Returns the
   * count of sessions revoked (0 when the user was already fully
   * signed out — idempotent). Under the hood, deployments typically
   * delegate to `SessionStoreBinding.revokeAllForUser`.
   */
  revokeAllSessions(input: IdentityRevokeSessionsInput): Promise<RevokeSessionsResult>;
  /**
   * Optional. Add a person to the tenant, with no grants: a tenant admin
   * then gives them a role and mints their first API key. When present,
   * `POST /v1/identity/users` mounts (tenant admins only). An email
   * another person of the tenant has is refused.
   */
  createUser?(input: IdentityCreateUserInput): Promise<IdentityCreateUserResult>;
}

export interface IdentityCreateUserInput {
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly primaryEmail?: string;
  /** Who added them: `user:<id>` or `service_account:<id>`. */
  readonly createdBy?: string;
}

export type IdentityCreateUserResult =
  | { readonly kind: 'created'; readonly user: UserRecord }
  | { readonly kind: 'email-taken'; readonly userId: UserId };

export interface IdentityGetUserInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface IdentityListUsersInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Prefix match on `UserRecord.displayName`. Undefined = no filter. */
  readonly query?: string;
}

export interface IdentityListSessionsInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface IdentityRevokeSessionsInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

/**
 * The tenant-scoped user record on the wire. `primaryEmail` may be
 * redacted by the binding based on tenant policy — the routes treat
 * the field as opaque and return whatever the binding hands back.
 * `metadata` is free-form JSON (e.g. IdP claims, provisioning source,
 * roles).
 */
export interface UserRecord {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly primaryEmail?: string;
  readonly displayName?: string;
  readonly createdAt: Timestamp;
  readonly lastActiveAt?: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface UserCollectionPage {
  readonly data: readonly UserRecord[];
  readonly nextCursor?: Cursor;
}

/**
 * Wire-safe subset of `Session` (from `session-store-binding.ts`).
 * Excludes the opaque provider `accessToken` / `refreshToken` — those
 * never cross the wire, even to admins.
 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly userId: UserId;
  readonly providerId: string;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly scopes: readonly string[];
  readonly revokedAt?: Timestamp;
}

export interface SessionSummaryPage {
  readonly data: readonly SessionSummary[];
  readonly nextCursor?: Cursor;
}

export interface RevokeSessionsResult {
  readonly userId: UserId;
  readonly revokedCount: number;
}

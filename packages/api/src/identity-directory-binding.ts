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
 * The directory is flat. Groups / roles / RBAC / audit history /
 * LDAP+SCIM sync / impersonation are not part of this binding. Adding a
 * person (`createUser`) is optional: a directory that mirrors an identity
 * provider leaves it out. A directory that adds people may invite them
 * (`UserRecord.invite`): pending until their first sign-in, expired once
 * its time passes, renewed by `resendInvite`.
 */
export interface IdentityDirectoryBinding {
  /**
   * Look up a specific user by id. Returns `null` when unknown —
   * the route surfaces `null` as `404 identity-user-not-found`.
   */
  getUser(input: IdentityGetUserInput): Promise<UserRecord | null>;
  /**
   * Optional. The person still in the tenant whose `primaryEmail` is
   * `email`, compared as the directory compares emails when it adds a
   * person (case-insensitively, for the runtime's); `null` when none.
   * When present, `POST /v1/projects/{projectId}/memberships` takes an
   * `email` as well as a `userId`.
   */
  findUserByEmail?(input: IdentityFindUserByEmailInput): Promise<UserRecord | null>;
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
   * Optional. Add a person to the tenant in the role `tenantRole` says,
   * written to the authorization store before it returns: a tenant member
   * (the default) reads the tenant's settings, not its projects; the
   * tenant's observer reads neither, only the projects they're then
   * given. The role is recorded with the person, so a repair puts back
   * the one they hold. A tenant admin then gives them a
   * role and mints their first API key. When present,
   * `POST /v1/identity/users` mounts (tenant admins only). An email
   * another person of the tenant has is refused. A directory that invites
   * people invites one added with an email, and says in `inviteEmail`
   * whether the invitation was emailed.
   */
  createUser?(input: IdentityCreateUserInput): Promise<IdentityCreateUserResult>;
  /**
   * Optional. Renew a person's invitation, for one who hasn't signed in
   * yet: a new expiry, and the invitation emailed again where the
   * deployment can send it (`inviteEmail` says whether it was). A person
   * not here (unknown, or unregistered) is `not-found`; one who has
   * joined, or was never invited, is `not-invited`; a resend over
   * the directory's limits is `capped`, with nothing changed. When
   * present, `POST /v1/identity/users/{userId}/invite` mounts (tenant
   * admins only).
   */
  resendInvite?(input: IdentityResendInviteInput): Promise<IdentityResendInviteResult>;
  /**
   * Optional. Unregister a person (remove them from the tenant), in one
   * step: they're marked unregistered (their record stays, with
   * `unregisteredAt`, so their history still says who they were), every
   * API key and session of theirs is revoked, and every grant and
   * membership they hold is taken from the authorization store, all before
   * it returns. Their email is then free: adding it again makes a new
   * person. Unregistering someone already unregistered changes nothing.
   * Refused for yourself, the deployment's seed user, and the tenant's
   * only tenant admin. When present,
   * `POST /v1/identity/users/{userId}/unregister` mounts (tenant admins
   * only).
   */
  unregisterUser?(input: IdentityUnregisterUserInput): Promise<IdentityUnregisterUserResult>;
}

export interface IdentityUnregisterUserInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** Who unregisters them: `user:<id>` or `service_account:<id>`. */
  readonly unregisteredBy?: string;
}

/** Why a person can't be unregistered. */
export type IdentityUnregisterUserRefusal = 'yourself' | 'seed-user' | 'last-tenant-admin';

export type IdentityUnregisterUserResult =
  | {
      readonly kind: 'unregistered';
      /** The person, with `unregisteredAt`. */
      readonly user: UserRecord;
      /**
       * What unregistering took away: keys, sessions, and every grant (each
       * entry and capability). A repeat takes what an earlier one left; each
       * is 0 once nothing is left.
       */
      readonly keysRevoked: number;
      readonly sessionsRevoked: number;
      readonly grantsRemoved: number;
    }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'refused';
      readonly reason: IdentityUnregisterUserRefusal;
      readonly message: string;
    };

export interface IdentityCreateUserInput {
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly primaryEmail?: string;
  /** Who added them: `user:<id>` or `service_account:<id>`. */
  readonly createdBy?: string;
  /**
   * Email them the invitation (default true). False still invites them,
   * for an admin who tells them another way: `inviteEmail` says
   * `not-requested`.
   */
  readonly sendInvite?: boolean;
  /** Their role in the tenant (default `member`). */
  readonly tenantRole?: TenantRole;
}

/**
 * A person's role in the tenant, apart from tenant admin (a grant): a
 * `member`, or the tenant's `observer`, who reads only the projects
 * they're given.
 */
export type TenantRole = 'member' | 'observer';
export const TENANT_ROLES: readonly TenantRole[] = ['member', 'observer'];

export type IdentityCreateUserResult =
  | {
      readonly kind: 'created';
      readonly user: UserRecord;
      /** Whether the invitation was emailed; absent from a directory that doesn't invite. */
      readonly inviteEmail?: InviteEmail;
    }
  | { readonly kind: 'email-taken'; readonly userId: UserId };

/**
 * Whether an invitation was emailed, and why not:
 * - `no-email`: the person has no email, so isn't invited;
 * - `not-requested`: the add said not to (`sendInvite: false`);
 * - `not-configured`: the deployment sends no email (no SMTP sender);
 * - `send-failed`: the mail server refused it or didn't answer;
 * - `capped`: the workspace's daily invitations are used up.
 * An invitation not emailed is still open: the admin tells them.
 */
export interface InviteEmail {
  readonly sent: boolean;
  readonly reason?: InviteEmailUnsent;
}

export type InviteEmailUnsent =
  | 'no-email'
  | 'not-requested'
  | 'not-configured'
  | 'send-failed'
  | 'capped';

export interface IdentityResendInviteInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** Who renews it: `user:<id>` or `service_account:<id>`. */
  readonly sentBy?: string;
}

export type IdentityResendInviteResult =
  | {
      readonly kind: 'renewed';
      /** The person, with the invitation's new expiry. */
      readonly user: UserRecord;
      readonly inviteEmail: InviteEmail;
    }
  | { readonly kind: 'not-found' }
  /** They've joined (signed in, or were added before invitations), or have no email. */
  | { readonly kind: 'not-invited' }
  /** Over the directory's limits for this person or the workspace; nothing changed. */
  | { readonly kind: 'capped'; readonly retryAfterMs: number };

export interface IdentityGetUserInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface IdentityFindUserByEmailInput {
  readonly tenantId: TenantId;
  readonly email: string;
}

export interface IdentityListUsersInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Prefix match on `UserRecord.displayName`. Undefined = no filter. */
  readonly query?: string;
  /** Unregistered people too (`unregisteredAt` set). Default: only the people still here. */
  readonly includeUnregistered?: boolean;
  /** Only people with an open invitation (`invite` set: pending or expired). */
  readonly pending?: boolean;
}

export interface IdentityListSessionsInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface IdentityRevokeSessionsInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** Who asked (`user:<id>`, `service_account:<id>`), for the audit trail. */
  readonly revokedBy?: string;
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
  /** When they were removed from the tenant (`unregisterUser`); absent while they're here. */
  readonly unregisteredAt?: Timestamp;
  /** Their invitation, while they haven't signed in; absent once they have, or if never invited. */
  readonly invite?: UserInvite;
  /** Their first sign-in that made a session; absent before it, and for people added before it was kept. */
  readonly firstSignedInAt?: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * An open invitation. `pending` signs in; `expired` (past `expiresAt`) is
 * refused at every sign-in way until an admin renews it.
 */
export interface UserInvite {
  readonly state: 'pending' | 'expired';
  readonly expiresAt: Timestamp;
  /** When it was last emailed; absent when it never was. */
  readonly sentAt?: Timestamp;
}

export interface UserCollectionPage {
  readonly data: readonly UserRecord[];
  readonly nextCursor?: Cursor;
}

/** What the wire shows of a `Session` (from `session-store-binding.ts`). */
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

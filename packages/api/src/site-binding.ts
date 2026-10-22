// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, TenantId, Timestamp, UserId } from '@kindgi/types';

import type { UserRecord } from './identity-directory-binding.js';

/**
 * Sites that sign their own people in to one project: a website (a
 * WordPress admin, say) registered with Kindgi vouches for whoever is
 * signed in there, so its people ask agents and decide approvals as
 * themselves, without a Kindgi account of their own. A decision's record
 * names the person, and that they came through the site.
 *
 * A site is registered for exactly one project, by a tenant admin. It
 * proves who it is with an Ed25519 key it made itself: Kindgi only ever
 * holds the public half, posted once with a one-time enrollment code. A
 * person's statement, signed by the site, is exchanged for a short
 * session limited to the site's project (`SessionCreateInput.projectId`);
 * such a session reads nothing above the project, mints no keys and
 * isn't refreshed.
 *
 * The API package doesn't check statements, keep keys or create people:
 * the deployment's binding does all of it, in one place. Everything about
 * a site can be done to it here except reading its keys' private halves,
 * which Kindgi never has.
 */
export interface SiteBinding {
  /**
   * A new site, and its one-time enrollment code (at least 128 bits, stored
   * only hashed, expiring, used up atomically). The route has checked the
   * settings (`checkSiteSettings`).
   */
  register(input: SiteRegisterInput): Promise<SiteRegisterOutcome>;
  list(input: SiteListInput): Promise<SitePage>;
  get(input: SiteGetInput): Promise<Site | null>;
  /**
   * Change a site's settings. The route has checked the patch applied to
   * the site as it read it; the binding applies it to the site as stored
   * and checks the result, in one transaction (`applySiteChange`, then
   * `checkSiteSettings`), since the site may have changed in between. A
   * patch with no `roleMap` keeps the stored map's entries for allowed
   * roles only.
   */
  update(input: SiteUpdateInput): Promise<SiteChangeOutcome>;
  /** Stop or start the site's sign-ins. Pausing ends its live sessions. */
  setPaused(input: SiteSetPausedInput): Promise<SiteChangeOutcome>;
  /** Tombstone the site: its sign-ins stop and its live sessions end. Its people stay. */
  unregister(input: SiteGetInput & { readonly by: string }): Promise<SiteChangeOutcome>;
  /**
   * A new one-time enrollment code for the site. Using it replaces every
   * key the site has and ends its live sessions; an earlier unused code
   * stops working. This is how a site's key is rotated. Like `register`'s,
   * the code has at least 128 bits, is stored only hashed, expires, and is
   * used up atomically (`UPDATE … WHERE used_at IS NULL AND expires_at >
   * now() RETURNING`).
   */
  newEnrollmentCode(
    input: SiteGetInput & { readonly by: string },
  ): Promise<SiteEnrollmentCodeOutcome>;
  /** Revoke one of the site's keys. Its live sessions end. */
  revokeKey(input: SiteRevokeKeyInput): Promise<SiteChangeOutcome>;
  /**
   * Let one of the site's people back in after a removal made in Kindgi
   * (`unregisterUser`), while the site still knows them: their link to the
   * site is live, so their next sign-in through it is theirs again. They're
   * the same person, with their history. Only the person comes back: their
   * grants come back the next time the site signs them in, from its role
   * map then, and their keys and sessions stay gone. A site's people hold
   * no tenant membership, so none is written.
   *
   * A link the site retired (it said they left) stays retired: a site
   * forgets a person who leaves, and signs them in as a new person if they
   * come back, so that link would never see a statement again. Refused,
   * with nothing changed: `not-removed` for someone in the tenant with a
   * live link; `left` for a retired link, removed in Kindgi too or not;
   * and `linked-elsewhere` when letting them back in would let them in
   * another way too, through another site's live link or a sign-in
   * account of the tenant's own. Audited (`site-person-restored`). An
   * unregistered site is `not-found`, as for its other changes; a paused
   * one isn't. Optional: the route is mounted only when the binding has it.
   */
  restorePerson?(input: SitePersonRestoreInput): Promise<SitePersonRestoreOutcome>;
  /**
   * `POST /v1/auth/sites/enroll`, before anyone is signed in: the site
   * posts its public key with a one-time code. The code is the only
   * credential, so a wrong, used or expired one gets the same refusal. The
   * route has already checked the key's shape (before any code is looked
   * up, so a bad key never confirms or uses up a code) and passes only its
   * public members: `kty`, `crv`, `x`, `kid`.
   */
  enroll(input: SiteEnrollInput): Promise<SiteEnrollOutcome>;
  /**
   * `POST /v1/auth/site-sign-in`, before anyone is signed in: a person's
   * statement, signed by a registered site, for a session limited to the
   * site's project. The binding checks everything about it, in this order:
   * 1. a limit on failures per client address;
   * 2. the site exists (by the statement's `iss`);
   * 3. the signature: EdDSA only, against a live key of the site's (by
   *    `kid`), never a key the statement names or links;
   * 4. only then, the site isn't paused and is vouching; the audience; the
   *    times (no `iat` in the future, `exp` at most 60 s after it); a limit
   *    per site, counting only statements whose signature held; the
   *    statement's `jti`, used once; the person and their grants.
   * The route answers every refusal from 1 to 3 the same way
   * (`not-verified`): before the signature the caller has proved nothing.
   * The exact reason goes to the audit.
   *
   * A person's `name` is cleaned with `withoutHiddenCharacters` (never
   * refused for what it holds), and shown everywhere as
   * "<name>, via <the site's displayName>".
   *
   * The session is created with `projectId` the site's project and `role`
   * `member`, read back with `get`, and refused (and revoked) if a limit
   * didn't come back: a store that drops one would hand out an unlimited
   * session.
   */
  signIn(input: SiteSignInInput): Promise<SiteSignInOutcome>;
}

/** A WordPress role (or any site role), as the site names it: `shop_manager`. */
export type SiteRole = string;

/** What a person with one of the site's roles gets in the site's project. */
export interface SiteRoleGrant {
  /** May start turns with the project's agents (`caller`); reading the project comes with every role. */
  readonly ask: boolean;
  /** The reviewer role they decide approvals with; absent: they decide none. At most the site's `reviewerCeiling`. */
  readonly reviewer?: 'standard' | 'senior';
}

export interface Site {
  readonly siteId: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** Set by a tenant admin, never by the site: every person it signs in shows as "<name>, via <displayName>". */
  readonly displayName: string;
  /** The site's origin (`https://acme-store.example`); `http://` only for a loopback address in development. */
  readonly origin: string;
  /** Where an approval opens on the site; its origin is `origin`. `{approvalId}` is replaced. */
  readonly approvalsUrl: string;
  /** The roles that may sign in at all; any other is refused. */
  readonly allowedRoles: readonly SiteRole[];
  /** Role → grant. A person with several allowed roles gets the most any of them gives. */
  readonly roleMap: Readonly<Record<SiteRole, SiteRoleGrant>>;
  /** The highest reviewer role the site's people can have. */
  readonly reviewerCeiling: 'standard' | 'senior';
  /** Whether the site's statements are accepted. A site that isn't vouching only shows its page to people with their own keys. */
  readonly vouching: boolean;
  /** At most this many live people from the site. */
  readonly peopleCap: number;
  /** At most this many new people from the site per day. */
  readonly newPeoplePerDay: number;
  /** The site's live public keys (at most two), by id; never a private half. */
  readonly keys: readonly SiteKey[];
  /** The audience the site's statements carry: this deployment's public URL, given at enrollment. */
  readonly audience?: string;
  readonly createdAt: Timestamp;
  readonly createdBy?: string;
  readonly pausedAt?: Timestamp;
  readonly unregisteredAt?: Timestamp;
}

export interface SiteKey {
  readonly kid: string;
  /** The key's RFC 7638 thumbprint, to compare with the one the site shows. */
  readonly thumbprint: string;
  readonly addedAt: Timestamp;
}

export interface SiteRegisterInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly displayName: string;
  readonly origin: string;
  readonly approvalsUrl: string;
  readonly allowedRoles?: readonly SiteRole[];
  readonly roleMap?: Readonly<Record<SiteRole, SiteRoleGrant>>;
  readonly reviewerCeiling?: 'standard' | 'senior';
  readonly vouching?: boolean;
  readonly peopleCap?: number;
  readonly newPeoplePerDay?: number;
  readonly by: string;
}

export interface SiteEnrollmentCode {
  /** Shown once: the site posts it with its public key. */
  readonly code: string;
  readonly expiresAt: Timestamp;
}

export type SiteRegisterOutcome =
  | { readonly kind: 'ok'; readonly site: Site; readonly enrollment: SiteEnrollmentCode }
  | { readonly kind: 'project-not-found' }
  | SiteInvalid;

/** A site's settings the binding refused, naming the field. */
export interface SiteInvalid {
  readonly kind: 'invalid';
  readonly field: string;
  readonly message: string;
}

export interface SiteListInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly limit: number;
  readonly cursor?: string;
  readonly includeUnregistered?: boolean;
}

export interface SitePage {
  readonly data: readonly Site[];
  readonly nextCursor?: string;
}

export interface SiteGetInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly siteId: string;
}

export interface SiteUpdateInput extends SiteGetInput {
  readonly patch: Partial<
    Pick<
      SiteRegisterInput,
      | 'displayName'
      | 'origin'
      | 'approvalsUrl'
      | 'allowedRoles'
      | 'roleMap'
      | 'reviewerCeiling'
      | 'vouching'
      | 'peopleCap'
      | 'newPeoplePerDay'
    >
  >;
  readonly by: string;
}

export interface SiteSetPausedInput extends SiteGetInput {
  readonly paused: boolean;
  readonly by: string;
}

export interface SiteRevokeKeyInput extends SiteGetInput {
  readonly kid: string;
  readonly by: string;
}

export type SiteChangeOutcome =
  | { readonly kind: 'ok'; readonly site: Site }
  | { readonly kind: 'not-found' }
  | SiteInvalid;

export interface SitePersonRestoreInput extends SiteGetInput {
  readonly userId: UserId;
  readonly by: string;
}

/** Why a restore was refused (see `SiteBinding.restorePerson`). */
export type SitePersonRestoreRefusal = 'not-removed' | 'left' | 'linked-elsewhere';

export type SitePersonRestoreOutcome =
  /** The person, in the tenant again. */
  | { readonly kind: 'ok'; readonly user: UserRecord }
  /** No site with that id in this project, or an unregistered one. */
  | { readonly kind: 'not-found' }
  /** The site has no link to that person, live or retired. */
  | { readonly kind: 'person-not-found' }
  | { readonly kind: 'refused'; readonly reason: SitePersonRestoreRefusal };

export type SiteEnrollmentCodeOutcome =
  | { readonly kind: 'ok'; readonly enrollment: SiteEnrollmentCode }
  | { readonly kind: 'not-found' };

export interface SiteEnrollInput {
  readonly code: string;
  /** The site's Ed25519 public key: only `kty: OKP`, `crv: Ed25519`, `x` and `kid` (checked by the route). */
  readonly publicKey: Readonly<Record<string, string>>;
  /** The client's address, as the deployment knows it, for the limit on failures. */
  readonly clientAddress?: string;
}

export type SiteEnrollOutcome =
  | {
      readonly kind: 'ok';
      readonly siteId: string;
      /** What the site's statements carry as `aud`. */
      readonly audience: string;
    }
  /** A wrong, used or expired code, or a paused or unregistered site: one answer for all. */
  | { readonly kind: 'refused' }
  /** The public key isn't an Ed25519 JWK with a `kid`. */
  | { readonly kind: 'invalid-key'; readonly message: string }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number };

export interface SiteSignInInput {
  /** The person's statement: a compact JWS (`typ: kindgi-site+jwt`, EdDSA). */
  readonly statement: string;
  readonly clientAddress?: string;
}

/** Why a statement was refused. Each is audited (a statement naming no known site is logged instead). */
export type SiteSignInRefusal =
  | 'malformed'
  | 'unknown-site'
  | 'site-paused'
  | 'site-not-vouching'
  | 'unknown-key'
  | 'key-retired'
  | 'bad-signature'
  | 'wrong-audience'
  | 'expired'
  | 'issued-in-the-future'
  | 'too-long-lived'
  | 'replayed'
  | 'role-not-allowed'
  | 'person-removed'
  | 'people-cap';

export type SiteSignInOutcome =
  | {
      readonly kind: 'ok';
      /** A session token, limited to the site's project. Shown once. */
      readonly token: string;
      readonly expiresAt: Timestamp;
      readonly userId: UserId;
      readonly projectId: ProjectId;
    }
  | { readonly kind: 'refused'; readonly reason: SiteSignInRefusal; readonly message: string }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number };

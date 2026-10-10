// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

/**
 * Caller-plugged surface for OAuth/OIDC session persistence. Same
 * pattern as `TokenAdmin` (write path for bearer tokens) — the API
 * package does NOT own session persistence. Deployments plug in a
 * durable store.
 *
 * Sessions are what a sign-in leaves: the deployment's sign-in flow (or
 * `POST /v1/auth/token-sign-in`, `POST /v1/auth/refresh`) calls
 * `SessionStoreBinding.create`, and the caller gets an opaque session
 * token (`kgi_sk_…`) that never leaks a provider token to the client.
 *
 * A store that implements `resolveToken` owns the token: `create` mints it
 * (returned once, as `token`), the store keeps only a hash, and the
 * bearer-auth middleware hands every `kgi_sk_` token to `resolveToken`.
 * A store without it gets the older token, `kgi_sk_<sessionId>`, which
 * the middleware resolves through `get` with `MULTI_TENANT_LOOKUP`;
 * anyone who can read such a store's session ids can use the sessions.
 *
 * The resolver hot path runs on every authenticated request that carries
 * a session token, so implementations SHOULD keep it cheap (a single
 * indexed lookup, or a cache).
 */
export interface SessionStoreBinding {
  create(input: SessionCreateInput): Promise<SessionCreateOutput>;
  get(input: SessionGetInput): Promise<Session | null>;
  list(input: SessionListInput): Promise<SessionPage>;
  revoke(input: SessionRevokeInput): Promise<SessionRevokeOutcome>;
  revokeAllForUser(input: SessionRevokeAllForUserInput): Promise<SessionRevokeAllForUserOutcome>;
  /**
   * The session a token names, or `null` when it names none: an unknown,
   * malformed or tampered token, or one in a format this store didn't
   * mint. The store reads the token's tenant from the token itself and
   * looks only in that tenant, comparing a hash of the token with what it
   * stored (in constant time); nothing is read across tenants before the
   * token is authenticated.
   *
   * A revoked, rotated or expired session is still returned (with
   * `revokedAt`, `rotatedAt`, `expiresAt`): the middleware says which.
   *
   * When present, the middleware never calls `get` with
   * `MULTI_TENANT_LOOKUP`, and `create` must return `token`.
   */
  readonly resolveToken?: (input: SessionResolveTokenInput) => Promise<Session | null>;
  /**
   * Update the session's `lastActiveAt` marker. Called by the auth
   * middleware on each successful authenticated request (throttled, by
   * default to at most once per minute per session, so the write path
   * doesn't hot-spot under load). Absent = the middleware only enforces absolute
   * TTL; inactivity timeout is disabled.
   *
   * The middleware passes the session's own tenant. A store without
   * `resolveToken` must also honor the sentinel `MULTI_TENANT_LOOKUP`,
   * as `get` does.
   */
  readonly touch?: (input: SessionTouchInput) => Promise<SessionTouchOutcome>;
  /**
   * End every live session one provider opened, in one tenant: the console
   * sessions an API key opened (`api-token:<tokenId>`, from token sign-in)
   * when it's revoked; an identity provider's sign-ins when it's removed.
   * Absent → those sessions run until they expire.
   */
  readonly revokeByProvider?: (
    input: SessionRevokeByProviderInput,
  ) => Promise<SessionRevokeAllForUserOutcome>;
}

export interface SessionRevokeByProviderInput {
  readonly tenantId: TenantId;
  /** The `providerId` the sessions were created with. */
  readonly providerId: string;
}

export interface SessionResolveTokenInput {
  /** The whole token, as the caller sent it (`kgi_sk_…`). */
  readonly token: string;
}

export interface SessionCreateInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** ProviderId of the `IdentityProviderBinding` that authenticated the user. */
  readonly providerId: string;
  readonly expiresAt: Timestamp;
  readonly scopes: readonly string[];
  /** Free-form provider claims (e.g. `email`, `name`, `sub`). */
  readonly metadata?: Record<string, unknown>;
}

export interface SessionCreateOutput {
  readonly sessionId: SessionId;
  readonly expiresAt: Timestamp;
  /**
   * The session token the store minted, returned this once (the store
   * keeps only its hash). Required from a store that implements
   * `resolveToken`; absent from an older store, whose token is
   * `kgi_sk_<sessionId>`.
   */
  readonly token?: string;
}

export interface SessionGetInput {
  readonly tenantId: TenantId;
  readonly sessionId: SessionId;
}

export interface SessionListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Filter to sessions for a single user. Absent → all users in tenant. */
  readonly userId?: UserId;
}

export interface SessionRevokeInput {
  readonly tenantId: TenantId;
  readonly sessionId: SessionId;
  /**
   * Distinguishes an explicit revoke (user logout, admin action) from
   * a rotation (`POST /v1/auth/refresh` retiring the old session). The
   * adapter uses this to set both `revokedAt` AND `rotatedAt` on the
   * session so the middleware can return `401 refresh-token-invalid` when
   * the OLD session token is reused after rotation. Defaults to
   * `'revoke'`.
   */
  readonly reason?: 'revoke' | 'rotate';
}

export interface SessionRevokeAllForUserInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface Session {
  readonly id: SessionId;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly providerId: string;
  readonly expiresAt: Timestamp;
  readonly scopes: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: Timestamp;
  /**
   * Last-observed activity timestamp. Populated by adapters that
   * implement `touch()` — the middleware bumps it (throttled) on each
   * authenticated request so the deployment can enforce an
   * inactivity-based logout independent of the absolute session TTL.
   *
   * Adapters MAY leave this undefined when the deployment has opted
   * out of inactivity tracking; in that case the middleware skips the
   * inactivity check and enforces only absolute TTL.
   */
  readonly lastActiveAt?: Timestamp;
  /**
   * Set by `POST /v1/auth/refresh` on the OLD session when it mints a
   * new one. Distinguishes rotation (client should retry with the
   * fresh token — OAuth 2.1 BCP refresh-token reuse detection) from
   * an explicit revocation (user logged out). The middleware surfaces
   * this via `401 refresh-token-invalid` vs `401 auth-revoked`. Set
   * atomically with `revokedAt`.
   */
  readonly rotatedAt?: Timestamp;
  readonly revokedAt?: Timestamp;
}

export interface SessionTouchInput {
  readonly tenantId: TenantId;
  readonly sessionId: SessionId;
  /**
   * The observed activity timestamp. Adapters SHOULD accept a
   * caller-supplied instant so tests can drive the clock; production
   * middleware passes `new Date()`.
   */
  readonly at: Date;
}

export interface SessionTouchOutcome {
  /**
   * `false` when the session was already revoked or the row is
   * unknown — the middleware treats either case as a soft-fail (no
   * fatal error, but the caller's next request will 401 via the
   * standard checks).
   */
  readonly touched: boolean;
}

export interface SessionPage {
  readonly data: readonly Session[];
  readonly nextCursor?: Cursor;
}

export interface SessionRevokeOutcome {
  readonly revoked: boolean;
}

export interface SessionRevokeAllForUserOutcome {
  readonly revokedCount: number;
}

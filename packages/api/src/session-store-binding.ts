// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

/**
 * Caller-plugged surface for OAuth/OIDC session persistence. Same
 * pattern as `TokenAdmin` (write path for bearer tokens) — the API
 * package does NOT own session persistence. Deployments plug in a
 * durable store.
 *
 * Sessions are the byproduct of a successful OAuth callback:
 * `POST /v1/auth/callback/:providerId` exchanges the authorization code
 * for provider tokens, fetches the userinfo, and calls
 * `SessionStoreBinding.create` to persist the resulting session; the
 * route then hands the caller an opaque framework-issued token
 * (`kgi_sk_<sessionId>`) that never leaks the provider access-token or
 * refresh-token to the client.
 *
 * The bearer-auth middleware routes session-token requests through
 * `get(tenantId, sessionId)`; the resolver hot path runs on every
 * authenticated request that carries a session token, so implementations
 * SHOULD keep `get` cheap (e.g. a single indexed lookup by id and
 * expiry, or a cache).
 */
export interface SessionStoreBinding {
  create(input: SessionCreateInput): Promise<SessionCreateOutput>;
  get(input: SessionGetInput): Promise<Session | null>;
  list(input: SessionListInput): Promise<SessionPage>;
  revoke(input: SessionRevokeInput): Promise<SessionRevokeOutcome>;
  revokeAllForUser(input: SessionRevokeAllForUserInput): Promise<SessionRevokeAllForUserOutcome>;
  /**
   * Update the session's `lastActiveAt` marker. Called by the auth
   * middleware on each successful authenticated request (throttled, by
   * default to at most once per minute per session, so the write path
   * doesn't hot-spot under load). Absent = the middleware only enforces absolute
   * TTL; inactivity timeout is disabled.
   *
   * The tenant sentinel `MULTI_TENANT_LOOKUP` is honored the same way
   * as `get` — the middleware doesn't know the tenant ahead of time.
   */
  readonly touch?: (input: SessionTouchInput) => Promise<SessionTouchOutcome>;
}

export interface SessionCreateInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** ProviderId of the `IdentityProviderBinding` that authenticated the user. */
  readonly providerId: string;
  /** Opaque provider access-token — server-side only. */
  readonly accessToken: string;
  /** Opaque provider refresh-token — server-side only, may be absent. */
  readonly refreshToken?: string;
  readonly expiresAt: Timestamp;
  readonly scopes: readonly string[];
  /** Free-form provider claims (e.g. `email`, `name`, `sub`). */
  readonly metadata?: Record<string, unknown>;
}

export interface SessionCreateOutput {
  readonly sessionId: SessionId;
  readonly expiresAt: Timestamp;
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
  readonly accessToken: string;
  readonly refreshToken?: string;
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

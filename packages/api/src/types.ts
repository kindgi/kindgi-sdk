// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Principal, ReviewerRole } from '@kindgi/authz';
import type { Logger, TraceContext } from '@kindgi/log';
import type { ApiTokenId, RunId, SessionId, TenantId, UserId } from '@kindgi/types';

/**
 * Hono environment shape — variables the middleware chain populates
 * and route handlers consume via `c.get(...)`.
 */
export interface AppEnv {
  Variables: {
    requestId: string;
    /**
     * The request's logger (`requestLogMiddleware`): the app's, with the
     * request's `requestId`, `traceId` and `spanId`, and its `tenantId`
     * once authenticated. Routes log through it.
     */
    log: Logger;
    /** The request's W3C trace context: the caller's trace when it sent a valid `traceparent`. */
    trace: TraceContext;
    /** Set by `bearerAuthMiddleware` on authenticated routes. */
    tenantId: TenantId;
    /**
     * Set by `bearerAuthMiddleware` when the token's `TokenResolution`
     * carried a `reviewerRole`, or by the approvals routes (and `whoami`)
     * from the reviewer roster for a token whose user is a registered
     * reviewer (`ReviewerBinding.resolveReviewerRole`). Approvals routes
     * gate visibility + decisions on this: `standard < senior < admin`.
     */
    reviewerRole?: ReviewerRole;
    /**
     * Set by `bearerAuthMiddleware` when the token resolution carries
     * a `userId`. Approvals routes hand it to `ReviewerBinding` to
     * translate `UserId → ReviewerId` before calling `submitReview`.
     */
    userId?: UserId;
    /**
     * Set by `bearerAuthMiddleware` when the caller authenticated with a
     * durable API key: the key's id. The principal is the key's service
     * account.
     */
    tokenId?: ApiTokenId;
    /** The service account an API key acts for. */
    serviceAccountId?: string;
    /**
     * Set by a route whose answer carries a secret (`withholdFromReplay`):
     * the Idempotency-Key middleware keeps that the request succeeded, not
     * its answer.
     */
    idempotencyWithhold?: boolean;
    /** An API key's role ceiling (`member` keys can't administer the tenant). */
    tokenRole?: 'admin' | 'member';
    /** The project an API key is narrowed to. */
    tokenProjectId?: string;
    /** When the API token the request came with expires, if it does. */
    tokenExpiresAt?: Date;
    /**
     * Set by `bearerAuthMiddleware` when the caller presented a
     * framework-issued OAuth session token (`kgi_sk_*`).
     * `/v1/identity/whoami` + `/v1/auth/logout` read this to introspect /
     * revoke without a second lookup. Absent for static bearer tokens.
     */
    sessionId?: SessionId;
    /** Set when the session token came from a cookie (not a header): that cookie's name. */
    sessionCookieName?: string;
    /** Identity-provider id behind a session token. Absent for bearer. */
    providerId?: string;
    /** Set by `sigv4Middleware` on `/s3/*`: the bucket the credential may access. */
    bucket?: string;
    /** Set by `sigv4Middleware` on `/s3/*`: the access key that signed the request. */
    s3AccessKeyId?: string;
    /** OAuth scopes granted to a session token. Absent for bearer. */
    scopes?: readonly string[];
    /**
     * Framework capabilities granted to the bearer. Route handlers
     * call `hasCapability(c, '<name>')` to gate
     * writes / reveals; missing capability → 403 `permission-denied`.
     * Absent = no capabilities granted.
     */
    capabilities?: readonly string[];
    /**
     * Composite authz Principal built by `principalMiddleware` from
     * the token resolution. Present on every route mounted BELOW that
     * middleware (i.e. all `/v1/*` routes). Consumed by the
     * `authorize()` middleware factory and any route handler that
     * needs to make conditional authz checks.
     */
    principal?: Principal;
    /**
     * Set when the request authenticated with a public run token
     * (`kgi_pt_…`): such a request may only read the runs in
     * `publicRunIds` and their descendants, on the progress routes.
     */
    tokenKind?: 'public-run';
    /** The runs a public run token names. */
    publicRunIds?: readonly RunId[];
  };
}

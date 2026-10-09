// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';

import type { ReviewerRole } from '@kindgi/authz';
import type { ApiTokenId, SessionId, TenantId, UserId } from '@kindgi/types';

import type { SigningKeyBinding } from '@kindgi/crypto';

import { statusFor, toWireError } from '../errors.js';
import { PUBLIC_RUN_TOKEN_PREFIX, verifyPublicRunToken } from '../public-run-token.js';
import type { SessionStoreBinding } from '../session-store-binding.js';

/**
 * Resolve an API token → tenant identity. For static bearer tokens this
 * is a caller-injected function: the platform's actual token store (auth
 * service, database, …) plugs in. Signature stays stable across
 * implementations.
 *
 * Return `null` for missing / expired / revoked tokens; the middleware
 * translates to 401 with a specific error code.
 */
export type TokenResolver = (token: string) => Promise<TokenResolution | null>;

export interface TokenResolution {
  readonly tenantId: TenantId;
  /**
   * Optional expiration; if set and in the past, the middleware treats
   * as expired even if the resolver returned a value.
   */
  readonly expiresAt?: Date;
  /** Optional revocation marker; `true` → 401 auth-revoked. */
  readonly revoked?: boolean;
  /**
   * Optional reviewer role granted to this token. When present, the
   * middleware surfaces it as `c.get('reviewerRole')` and approvals
   * routes gate visibility / decisions on the `standard < senior < admin`
   * hierarchy. Absent for tokens that were never provisioned with a
   * reviewer role: the approvals routes then take the role the reviewer
   * roster gives the token's user (`ReviewerBinding.resolveReviewerRole`),
   * and return `403 permission-denied` when it gives none.
   */
  readonly reviewerRole?: ReviewerRole;
  /**
   * Optional user identity behind the token. Approvals routes forward
   * this to a `ReviewerBinding` to translate `UserId → ReviewerId`
   * before calling `hitl.submitReview` (which needs the reviewer id).
   */
  readonly userId?: UserId;
  /**
   * The id of a durable API key (`POST /v1/tokens`), surfaced as
   * `c.get('tokenId')`. The caller is the key's principal: `userId` for a
   * person's key, `serviceAccountId` for a service account's. A key with
   * neither (a store built before principals) is its own service account,
   * `service_account:<tokenId>`.
   */
  readonly tokenId?: ApiTokenId;
  /** The service account an API key acts for (`service_account:<id>`). */
  readonly serviceAccountId?: string;
  /**
   * An API key's role: the most it may do, under its principal's grants.
   * A `member` key is refused tenant-admin actions even when its principal
   * is an admin.
   */
  readonly tokenRole?: 'admin' | 'member';
  /**
   * The project an API key is narrowed to. A request naming another
   * project is refused (`key-project-mismatch`), and so is an `admin`
   * action on the tenant.
   */
  readonly tokenProjectId?: string;
  /**
   * Optional session id. Populated by the session-token verifier path
   * (`kgi_sk_*` tokens) so `/v1/identity/whoami` and `/v1/auth/logout`
   * can introspect / revoke the caller's own session without a second
   * lookup. Absent for static bearer tokens.
   */
  readonly sessionId?: SessionId;
  /**
   * Optional identity-provider id that authenticated the caller. Only
   * populated by session-token verification.
   */
  readonly providerId?: string;
  /**
   * Optional OAuth scopes granted to the session. Only populated by
   * session-token verification.
   */
  readonly scopes?: readonly string[];
  /**
   * Optional last-observed-activity timestamp. Populated by
   * `resolveSessionToken` when the session-store adapter carries
   * `lastActiveAt` on the row. Used by the middleware to enforce the
   * `inactivityTimeoutMs` policy. Absent → inactivity check is
   * skipped.
   */
  readonly lastActiveAt?: Date;
  /**
   * Optional flag set by `resolveSessionToken` when the session was
   * revoked specifically via rotation (`POST /v1/auth/refresh`). The
   * middleware maps this to `401 refresh-token-invalid` instead of
   * the generic `401 auth-revoked`, matching OAuth 2.1 BCP refresh-
   * token-reuse semantics.
   */
  readonly rotated?: boolean;
  /**
   * Optional framework capabilities granted to the bearer. Route
   * handlers gate write / reveal ops on
   * specific capability strings (`env:write`, `secrets:write`,
   * `secrets:rotate`, `secrets:revoke`, `secrets:revoke:hard`,
   * `secrets:reveal`, `kindgi:system`). Callers that plug their
   * own resolver populate this list from their token store; deployments
   * without capability data leave it absent — routes that require a
   * capability then return 403 `permission-denied`.
   *
   * Kindgi's stance: fail-closed on writes when the capability is
   * unset (a token without an explicit `secrets:write` claim cannot
   * mutate the secrets store). Deployments that want any authenticated
   * bearer to be able to write grant the capability on every token.
   */
  readonly capabilities?: readonly string[];
}

/**
 * Session-token prefix. Framework-issued opaque tokens minted by
 * `POST /v1/auth/callback/:providerId` carry this prefix so the auth
 * middleware can route them to the session store instead of the caller-
 * plugged `TokenResolver`. Distinct prefix means a static bearer token
 * and a session token can coexist byte-shape-identical on the wire.
 */
export const SESSION_TOKEN_PREFIX = 'kgi_sk_' as const;

/**
 * The cookie a browser carries its session token in, when the deployment
 * turns cookie sessions on (`SessionConfig.cookie`). `__Host-`: Secure,
 * Path=/, no Domain, so it's sent only to the origin that set it.
 */
export const SESSION_COOKIE_NAME = '__Host-kindgi_session' as const;

/**
 * Cookie sessions: where the middleware reads a browser's session token
 * when the request has no `Authorization` header.
 */
export interface SessionCookieOptions {
  /** The cookie's name. Default `SESSION_COOKIE_NAME`. */
  readonly name?: string;
  /**
   * The origins a cookie-authenticated request may come from (the
   * console's origin, e.g. `https://kindgi.example.com`). An unsafe method
   * (anything but GET, HEAD and OPTIONS) authenticated by the cookie must
   * carry one of them in `Origin`, else 403 `csrf-origin-mismatch`; so
   * must a request with no `Origin` at all. Bearer requests are unaffected.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * Also accept an `Origin` naming the host the request was sent to (its
   * `Host`, or `X-Forwarded-Host` behind a proxy that sets it): the
   * console served from the runtime itself, wherever it's reached. For a
   * deployment that doesn't know its public URL. A cross-site page can't
   * forge `Origin`, nor add `X-Forwarded-Host` without a CORS preflight.
   */
  readonly sameOrigin?: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The older session token, `kgi_sk_<sessionId>`, for a session store
 * without `resolveToken`. A store with it mints its own token
 * (`SessionCreateOutput.token`), and the routes hand that out instead.
 * Session tokens are opaque to clients: never parse one outside the
 * middleware or the store that minted it.
 */
export function encodeSessionToken(sessionId: SessionId): string {
  return `${SESSION_TOKEN_PREFIX}${sessionId as unknown as string}`;
}

/**
 * Optional wiring for the session-token flavor. Provided to the
 * middleware via `bearerAuthMiddleware(resolveToken, { sessionStore })`
 * when the deployment mounts `SessionStoreBinding`. Absent → session-
 * shape tokens fall through to `TokenResolver` (which will typically
 * `null` them → 401 auth-missing) so a deployment without a session
 * store still behaves consistently.
 */
export interface BearerAuthMiddlewareOptions {
  readonly sessionStore?: SessionStoreBinding;
  /**
   * Inactivity timeout — sessions whose `lastActiveAt` is older than
   * `Date.now() - inactivityTimeoutMs` are rejected with 401
   * `session-inactive`. Absent → inactivity enforcement disabled
   * (only absolute TTL applies).
   *
   * Sensible default: 4 hours (`4 * 60 * 60 * 1000`). Deployments
   * customize via `CreateAppInput.session.inactivityTimeout`.
   */
  readonly inactivityTimeoutMs?: number;
  /**
   * How often (per session) the middleware should call
   * `sessionStore.touch` to bump `lastActiveAt`. Higher throttle ⇒
   * fewer writes but coarser inactivity enforcement. Defaults to 60s.
   */
  readonly touchThrottleMs?: number;
  /**
   * Read a session token from a cookie when the request carries no
   * `Authorization` header (browser sessions). Only `kgi_sk_` tokens are
   * taken from it, and only with a `sessionStore`.
   */
  readonly sessionCookie?: SessionCookieOptions;
  /**
   * Accept public run tokens (`kgi_pt_…`), verified against
   * `signingKey`, on the routes `isAllowed` admits (every other route
   * answers 403). Absent → such tokens are not recognized (401).
   */
  readonly publicRunTokens?: {
    readonly signingKey: SigningKeyBinding;
    readonly isAllowed: (method: string, path: string) => boolean;
  };
}

const DEFAULT_TOUCH_THROTTLE_MS = 60_000;

/**
 * Bearer-token middleware. Fails 401 on missing / malformed / expired /
 * revoked. On success, sets `c.set('tenantId', tenantId)` for downstream
 * handlers.
 *
 * Two token flavors are accepted:
 * - `kgi_sk_…` — session tokens. Verified by the session store
 *   (`resolveToken`, or `get` for an older store); expiration +
 *   revocation are pulled from the session row.
 * - anything else — caller-plugged static bearer tokens. Verified via
 *   `resolveToken`. Byte-shape-identical with the session-less contract.
 */
export function bearerAuthMiddleware(
  resolve: TokenResolver,
  options: BearerAuthMiddlewareOptions = {},
): MiddlewareHandler {
  const { sessionStore, inactivityTimeoutMs } = options;
  const touchThrottleMs = options.touchThrottleMs ?? DEFAULT_TOUCH_THROTTLE_MS;
  // Per-process throttle bucket: session id → last touch millis.
  // A shared Map is fine — session ids are opaque strings and the
  // bucket is bounded by the number of active sessions the process
  // has recently observed.
  const touchBucket = new Map<string, number>();
  // Everything after the token is found: the header's or the cookie's.
  const authenticate = async (
    c: Context,
    next: Next,
    token: string,
    requestId: string,
  ): Promise<Response | undefined> => {
    if (token.startsWith(PUBLIC_RUN_TOKEN_PREFIX)) {
      return authenticatePublicRunToken(c, next, token, requestId, options.publicRunTokens);
    }

    const isSessionToken = sessionStore !== undefined && token.startsWith(SESSION_TOKEN_PREFIX);
    const resolution = isSessionToken
      ? await resolveSessionToken(sessionStore!, token)
      : await resolve(token);
    if (resolution === null) {
      const body = toWireError(
        { code: 'auth-missing', message: 'Bearer token is not recognized' },
        requestId,
      );
      return c.json(body, statusFor('auth-missing') as never);
    }
    if (resolution.revoked === true) {
      // Rotated sessions surface as `refresh-token-invalid` — OAuth 2.1
      // BCP reuse detection. The old session token is no longer valid,
      // but the semantic distinction from an explicit revoke matters
      // to compliant clients (they retry with the fresh token instead
      // of prompting the user to re-authenticate).
      if (resolution.rotated === true) {
        const body = toWireError(
          {
            code: 'refresh-token-invalid',
            message: 'Session token was rotated — retry with the fresh token from the last refresh',
          },
          requestId,
        );
        return c.json(body, statusFor('refresh-token-invalid') as never);
      }
      const body = toWireError(
        { code: 'auth-revoked', message: 'Bearer token has been revoked' },
        requestId,
      );
      return c.json(body, statusFor('auth-revoked') as never);
    }
    if (resolution.expiresAt !== undefined && resolution.expiresAt.getTime() < Date.now()) {
      // Session tokens report `session-expired` so callers can
      // distinguish absolute session TTL from bearer-token expiry.
      const expiredCode = isSessionToken ? 'session-expired' : 'auth-expired';
      const expiredMsg = isSessionToken
        ? 'Session has expired (absolute TTL reached)'
        : 'Bearer token has expired';
      const body = toWireError({ code: expiredCode, message: expiredMsg }, requestId);
      return c.json(body, statusFor(expiredCode) as never);
    }
    // Inactivity timeout enforcement. Only applies when the deployment
    // opted in via `inactivityTimeoutMs` AND the token is a session
    // token AND the store populated `lastActiveAt`. Skipping the check
    // preserves the default contract for deployments that don't wire
    // the config.
    if (
      isSessionToken &&
      inactivityTimeoutMs !== undefined &&
      inactivityTimeoutMs > 0 &&
      resolution.lastActiveAt !== undefined
    ) {
      const cutoff = Date.now() - inactivityTimeoutMs;
      if (resolution.lastActiveAt.getTime() < cutoff) {
        const body = toWireError(
          {
            code: 'session-inactive',
            message: 'Session has been idle beyond the inactivity timeout',
          },
          requestId,
        );
        return c.json(body, statusFor('session-inactive') as never);
      }
    }

    c.set('tenantId', resolution.tenantId);
    if (resolution.reviewerRole !== undefined) {
      c.set('reviewerRole', resolution.reviewerRole);
    }
    if (resolution.userId !== undefined) {
      c.set('userId', resolution.userId);
    }
    if (resolution.tokenId !== undefined) {
      c.set('tokenId', resolution.tokenId);
    }
    if (resolution.serviceAccountId !== undefined) {
      c.set('serviceAccountId', resolution.serviceAccountId);
    }
    if (resolution.tokenRole !== undefined) {
      c.set('tokenRole', resolution.tokenRole);
    }
    if (resolution.tokenProjectId !== undefined) {
      c.set('tokenProjectId', resolution.tokenProjectId);
    }
    if (resolution.expiresAt !== undefined && !isSessionToken) {
      c.set('tokenExpiresAt', resolution.expiresAt);
    }
    if (resolution.sessionId !== undefined) {
      c.set('sessionId', resolution.sessionId);
    }
    if (resolution.providerId !== undefined) {
      c.set('providerId', resolution.providerId);
    }
    if (resolution.scopes !== undefined) {
      c.set('scopes', resolution.scopes);
    }
    if (resolution.capabilities !== undefined) {
      c.set('capabilities', resolution.capabilities);
    }

    // Bump `lastActiveAt` (throttled) so the inactivity timeout has
    // a fresh signal to compare against. Only meaningful for session
    // tokens with a wired `touch()`; bearer tokens are skipped.
    if (isSessionToken && sessionStore?.touch !== undefined && resolution.sessionId !== undefined) {
      const sid = resolution.sessionId as unknown as string;
      const last = touchBucket.get(sid) ?? 0;
      const now = Date.now();
      if (now - last >= touchThrottleMs) {
        touchBucket.set(sid, now);
        // Fire-and-forget; we don't want the write path to hold the
        // request. Adapter errors surface via observability, not the
        // hot path (the next check catches a genuinely stale row).
        void sessionStore
          .touch({
            tenantId: resolution.tenantId,
            sessionId: resolution.sessionId,
            at: new Date(now),
          })
          .catch(() => {
            // Best-effort — the next request retries.
          });
      }
    }

    await next();
    return;
  };
  return async (c, next) => {
    const requestId = c.get('requestId') as string;
    const header = c.req.header('authorization');
    if (header === undefined || header.length === 0) {
      const fromCookie = sessionCookieToken(c, sessionStore, options.sessionCookie);
      if (fromCookie !== undefined) {
        const refusal = csrfRefusal(c, options.sessionCookie as SessionCookieOptions, requestId);
        if (refusal !== undefined) return refusal;
        c.set('sessionCookieName', options.sessionCookie?.name ?? SESSION_COOKIE_NAME);
        return authenticate(c, next, fromCookie, requestId);
      }
      const body = toWireError(
        { code: 'auth-missing', message: 'Authorization header is required' },
        requestId,
      );
      return c.json(body, statusFor('auth-missing') as never);
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match === null) {
      const body = toWireError(
        {
          code: 'auth-missing',
          message: 'Authorization header must be "Bearer <token>"',
        },
        requestId,
      );
      return c.json(body, statusFor('auth-missing') as never);
    }
    const token = match[1]?.trim() ?? '';
    if (token.length === 0) {
      const body = toWireError(
        { code: 'auth-missing', message: 'Bearer token is empty' },
        requestId,
      );
      return c.json(body, statusFor('auth-missing') as never);
    }

    return authenticate(c, next, token, requestId);
  };
}

/**
 * Session-token verification path. Distinct from `TokenResolver` because
 * a session carries structured OAuth context (userId + providerId +
 * scopes + expiration + revocation) that the store returns natively —
 * we don't want to squeeze that shape through the resolver contract.
 *
 * A store with `resolveToken` gets the whole token: it reads the tenant
 * from it, looks only in that tenant and compares a hash, so nothing is
 * read across tenants before the token is authenticated. The session it
 * returns is authoritative for `tenantId`.
 *
 * A store without it gets the older lookup: the token's remainder is the
 * session id, read with `get({ tenantId: MULTI_TENANT_LOOKUP, sessionId })`,
 * which such stores must honor by skipping the tenant filter.
 */
async function resolveSessionToken(
  sessionStore: SessionStoreBinding,
  token: string,
): Promise<TokenResolution | null> {
  const session = await findSession(sessionStore, token);
  if (session === null) return null;
  return {
    tenantId: session.tenantId,
    userId: session.userId as unknown as UserId,
    sessionId: session.id,
    providerId: session.providerId,
    scopes: session.scopes,
    expiresAt: new Date(session.expiresAt as unknown as string),
    revoked: session.revokedAt !== undefined,
    ...(session.rotatedAt !== undefined && { rotated: true }),
    ...(session.lastActiveAt !== undefined && {
      lastActiveAt: new Date(session.lastActiveAt as unknown as string),
    }),
  };
}

/**
 * The session token in the request's cookie, when cookie sessions are on
 * and the cookie holds a session token; `undefined` otherwise (an API
 * key or any other token is never taken from a cookie).
 */
function sessionCookieToken(
  c: Context,
  sessionStore: SessionStoreBinding | undefined,
  cookie: SessionCookieOptions | undefined,
): string | undefined {
  if (cookie === undefined || sessionStore === undefined) return undefined;
  const value = getCookie(c, cookie.name ?? SESSION_COOKIE_NAME)?.trim();
  if (value === undefined || !value.startsWith(SESSION_TOKEN_PREFIX)) return undefined;
  return value;
}

/**
 * A cookie-authenticated unsafe request must come from an allowed origin:
 * a browser always sends `Origin` on such requests, and a cross-site page
 * can't forge it. A missing `Origin` is refused too.
 */
function csrfRefusal(
  c: Context,
  cookie: SessionCookieOptions,
  requestId: string,
): Response | undefined {
  if (SAFE_METHODS.has(c.req.method)) return undefined;
  const origin = c.req.header('origin');
  if (origin !== undefined && cookie.allowedOrigins.includes(origin)) return undefined;
  if (origin !== undefined && cookie.sameOrigin === true && isSameHost(c, origin)) return undefined;
  const body = toWireError(
    {
      code: 'csrf-origin-mismatch',
      message:
        origin === undefined
          ? 'A request signed in by the session cookie must say where it comes from (Origin)'
          : `A request signed in by the session cookie can't come from ${origin}`,
    },
    requestId,
  );
  return c.json(body, statusFor('csrf-origin-mismatch') as never);
}

/**
 * Whether `origin` names the host this request was sent to, over https (or
 * plain http on loopback, for local development). The session cookie is
 * `__Host-` and Secure, so a browser holding it is on https: a plain-http
 * page on the same host (an on-path attacker's) is not the same origin.
 */
function isSameHost(c: Context, origin: string): boolean {
  let host: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
      return false;
    }
    host = url.host;
  } catch {
    return false;
  }
  // The request's own URL carries its Host (the Node server builds it from it).
  const sentTo = [
    new URL(c.req.url).host,
    c.req.header('host'),
    c.req.header('x-forwarded-host')?.split(',')[0]?.trim(),
  ];
  return sentTo.some((h) => h !== undefined && h !== '' && h.toLowerCase() === host.toLowerCase());
}

async function findSession(sessionStore: SessionStoreBinding, token: string) {
  if (sessionStore.resolveToken !== undefined) {
    return sessionStore.resolveToken({ token });
  }
  const sessionIdStr = token.slice(SESSION_TOKEN_PREFIX.length);
  if (sessionIdStr.length === 0) return null;
  return sessionStore.get({
    tenantId: MULTI_TENANT_LOOKUP,
    sessionId: sessionIdStr as unknown as SessionId,
  });
}

/**
 * Sentinel `tenantId` value the middleware passes to
 * `SessionStoreBinding.get` when it needs to look up a session by its
 * id without knowing the tenant in advance: only for a store without
 * `resolveToken`. Such stores MUST honor it by skipping the tenant
 * filter (the tenant is not known until the session row has been read).
 */
export const MULTI_TENANT_LOOKUP = '__kindgi_session_multi_tenant_lookup__' as unknown as TenantId;

/**
 * A public run token: verify it, admit only the routes it may use, and
 * mark the request so the progress routes check it against the runs
 * it names.
 */
async function authenticatePublicRunToken(
  c: Context,
  next: Next,
  token: string,
  requestId: string,
  config: BearerAuthMiddlewareOptions['publicRunTokens'],
): Promise<Response | undefined> {
  const verified =
    config === undefined
      ? ({ kind: 'err', reason: 'unknown-key' } as const)
      : verifyPublicRunToken(token, { signingKey: config.signingKey });
  if (verified.kind === 'err') {
    const expired = verified.reason === 'expired';
    const code = expired ? 'auth-expired' : 'auth-missing';
    const message = expired ? 'Public run token has expired' : 'Bearer token is not recognized';
    return c.json(toWireError({ code, message }, requestId), statusFor(code) as never);
  }
  if (config === undefined || !config.isAllowed(c.req.method, c.req.path)) {
    return c.json(
      toWireError(
        {
          code: 'permission-denied',
          message:
            'A public run token can only follow the runs it names: GET /v1/runs/{runId}/progress and GET /v1/runs/{runId}/progress/stream',
        },
        requestId,
      ),
      statusFor('permission-denied') as never,
    );
  }
  c.set('tenantId', verified.claims.tenantId);
  c.set('tokenKind', 'public-run');
  c.set('publicRunIds', verified.claims.runIds);
  await next();
  return undefined;
}

/** `localhost`, `127.0.0.0/8` or `::1`. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

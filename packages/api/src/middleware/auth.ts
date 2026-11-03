// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';

import type { ReviewerRole } from '@kindgi/authz';
import type { ApiTokenId, SessionId, TenantId, UserId } from '@kindgi/types';

import type { SigningKeyBinding } from '@kindgi/crypto';
import type { Logger } from '@kindgi/log';

import { statusFor, toWireError } from '../errors.js';
import type { PersonCapabilitiesBinding } from '../person-capabilities-binding.js';
import { PUBLIC_RUN_TOKEN_PREFIX, verifyPublicRunToken } from '../public-run-token.js';
import type { SessionStoreBinding } from '../session-store-binding.js';
import {
  FULL_SYSTEM_CAPABILITY,
  SYSTEM_TENANT_ID,
  type SystemPrincipal,
  isSystemCapability,
  isSystemKeysPath,
} from '../system.js';
import type { TokenAdmin } from '../token-admin.js';
import { loggable } from './error-mapper.js';

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
   * Set when the token is the deployment's operator's, acting in no tenant:
   * a system key (`kgi_sy_…`), or the deployment's own token on a runtime
   * serving many tenants. Its scopes are its `capabilities`. The middleware
   * gives such a request `SYSTEM_TENANT_ID` whatever `tenantId` says.
   */
  readonly system?: SystemPrincipal;
  /**
   * Set on the deployment's own token by a runtime serving one tenant: on
   * `/v1/system/keys` (and under it) the token is this system principal,
   * with the full system capability and nothing of the tenant's, so it
   * mints, lists and revokes the system keys. Everywhere else it is what
   * the rest of this resolution says.
   */
  readonly systemKeysOperator?: SystemPrincipal;
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
   * Optional framework capabilities granted to the bearer (a session's
   * are its person's, from `personCapabilities`). Route
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
 * Session-token prefix. Framework-issued opaque session tokens (a
 * sign-in's, a refresh's) carry this prefix so the auth
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
 * The session cookie's name when it isn't `Secure`
 * (`SessionCookieOptions.secure: false`): a browser refuses the `__Host-`
 * prefix without `Secure`.
 */
export const PLAIN_SESSION_COOKIE_NAME = 'kindgi_session' as const;

/**
 * Cookie sessions: where the middleware reads a browser's session token
 * when the request has no `Authorization` header.
 */
export interface SessionCookieOptions {
  /**
   * The cookie's name. Default `SESSION_COOKIE_NAME`, or
   * `PLAIN_SESSION_COOKIE_NAME` when `secure` is `false`.
   */
  readonly name?: string;
  /**
   * Whether the cookie is `Secure`. Default `true`. `false` is for
   * development on a loopback address only (`http://localhost`,
   * `127.0.0.1`): Safari keeps a `Secure` cookie only over https, even
   * there. The cookie is then a plain one (`PLAIN_SESSION_COOKIE_NAME` by
   * default; `__Host-` needs `Secure`), still `HttpOnly` and
   * `SameSite=Lax`, and the middleware reads only that name.
   */
  readonly secure?: boolean;
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

/** The session cookie's name and whether it's `Secure`, as configured. */
export function sessionCookieOf(cookie: SessionCookieOptions | undefined): {
  readonly name: string;
  readonly secure: boolean;
} {
  const secure = cookie?.secure !== false;
  return {
    name: cookie?.name ?? (secure ? SESSION_COOKIE_NAME : PLAIN_SESSION_COOKIE_NAME),
    secure,
  };
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

const TOKEN_SIGN_IN_PROVIDER = 'api-token';

/** The provider of a session token sign-in opens: `api-token:<tokenId>`, or `api-token` for a key with no id. */
export function tokenSignInProvider(tokenId: ApiTokenId | undefined): string {
  return tokenId === undefined ? TOKEN_SIGN_IN_PROVIDER : `${TOKEN_SIGN_IN_PROVIDER}:${tokenId}`;
}

/** The key a session was opened with by token sign-in, from its provider; `undefined` for any other session. */
export function tokenSignInKey(providerId: string | undefined): ApiTokenId | undefined {
  const prefix = `${TOKEN_SIGN_IN_PROVIDER}:`;
  if (providerId === undefined || !providerId.startsWith(prefix)) return undefined;
  const tokenId = providerId.slice(prefix.length);
  return tokenId.length > 0 ? (tokenId as ApiTokenId) : undefined;
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
   * What a session's person holds, read on each session request once the
   * session is found valid: the session carries those capabilities. A
   * system capability among them is dropped. Absent → a session carries
   * none. An API key's are its own, never its person's.
   */
  readonly personCapabilities?: PersonCapabilitiesBinding;
  /**
   * The deployment's API keys, read on each request on a session token
   * sign-in opened (its provider names the key, `api-token:<tokenId>`) once
   * the session is found valid: a revoked or missing key refuses it, 401
   * `auth-revoked`, whatever failed to end it when the key was revoked.
   * Absent → such a session is refused: nothing can check its key. Other
   * sessions, and API keys themselves, read nothing more.
   */
  readonly apiKeys?: Pick<TokenAdmin, 'get'>;
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
      : operatorOnSystemKeys(await resolve(token), c.req.path);
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
    const keyRefusal = isSessionToken
      ? await sessionKeyRefusal(options.apiKeys, resolution)
      : undefined;
    if (keyRefusal !== undefined) {
      const body = toWireError({ code: 'auth-revoked', message: keyRefusal }, requestId);
      return c.json(body, statusFor('auth-revoked') as never);
    }

    if (resolution.system !== undefined) {
      c.set('systemPrincipal', resolution.system);
      c.set('tenantId', SYSTEM_TENANT_ID);
    } else {
      c.set('tenantId', resolution.tenantId);
    }
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
    const capabilities = isSessionToken
      ? await sessionCapabilities(options.personCapabilities, resolution)
      : resolution.capabilities;
    if (capabilities !== undefined) {
      c.set('capabilities', capabilities);
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
        // request. A touch the store couldn't write is said, and the
        // session's next request touches again rather than wait out the
        // throttle. The line names the tenant, never the session: an older
        // store's token is `kgi_sk_<sessionId>`.
        const log = c.get('log') as Logger | undefined;
        void sessionStore
          .touch({
            tenantId: resolution.tenantId,
            sessionId: resolution.sessionId,
            at: new Date(now),
          })
          .catch((cause: unknown) => {
            if (touchBucket.get(sid) === now) touchBucket.delete(sid);
            log?.warn(
              "the session's activity wasn't recorded: its inactivity timeout still counts from the touch before, and its next request touches again",
              { tenantId: resolution.tenantId, err: loggable(cause) },
            );
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
        const cookie = sessionCookieOf(options.sessionCookie);
        c.set('sessionCookieName', cookie.name);
        c.set('sessionCookieSecure', cookie.secure);
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
 * Serving one tenant, the deployment's own token on `/v1/system/keys`:
 * the system principal `systemKeysOperator` names, holding `kindgi:system`,
 * in no tenant. Elsewhere, and for any other token, the resolution as it is.
 */
function operatorOnSystemKeys(
  resolution: TokenResolution | null,
  path: string,
): TokenResolution | null {
  const operator = resolution?.systemKeysOperator;
  if (resolution === null || operator === undefined || !isSystemKeysPath(path)) return resolution;
  return {
    tenantId: SYSTEM_TENANT_ID,
    system: operator,
    capabilities: [FULL_SYSTEM_CAPABILITY],
    ...(resolution.expiresAt !== undefined && { expiresAt: resolution.expiresAt }),
    ...(resolution.revoked !== undefined && { revoked: resolution.revoked }),
  };
}

/**
 * Why a valid session token sign-in opened is refused: its key is revoked or
 * gone, or the deployment can't read its keys to tell. `undefined` for a
 * live key, and for every other session (an identity provider's, or the
 * deployment's own token's, `api-token` with no key id). Read on each
 * request, never cached, so the session ends at its key's revoke even when
 * ending it then failed. A read that fails fails the request, as a failed
 * session lookup does: it never reads as a live key.
 */
async function sessionKeyRefusal(
  apiKeys: Pick<TokenAdmin, 'get'> | undefined,
  resolution: TokenResolution,
): Promise<string | undefined> {
  const tokenId = tokenSignInKey(resolution.providerId);
  if (tokenId === undefined) return undefined;
  if (apiKeys === undefined) {
    return "This session was opened with an API key, and this deployment can't check its API keys: sign in another way";
  }
  const key = await apiKeys.get({ tenantId: resolution.tenantId, tokenId });
  if (key === undefined || key.revokedAt !== undefined) {
    return 'The API key this session was opened with is revoked: sign in again';
  }
  return undefined;
}

/**
 * A valid session's capabilities: its person's, without any system one.
 * A person's are never the operator's powers, whatever the store holds.
 * A read that fails fails the request, as a failed session lookup does:
 * answering as if they held none would blame them for the store.
 */
async function sessionCapabilities(
  personCapabilities: PersonCapabilitiesBinding | undefined,
  resolution: TokenResolution,
): Promise<readonly string[] | undefined> {
  if (personCapabilities === undefined || resolution.userId === undefined) return undefined;
  const held = await personCapabilities.held({
    tenantId: resolution.tenantId,
    userId: resolution.userId,
  });
  return held.filter((cap) => !isSystemCapability(cap));
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
    // A session's limits are read exactly as a key's (`keyCeilingDeny`,
    // `refuseOtherProjectForKey`, `inKeyProject`).
    ...(session.projectId !== undefined && {
      tokenProjectId: session.projectId as unknown as string,
    }),
    ...(session.role !== undefined && { tokenRole: session.role }),
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
  // Only the configured cookie: a plain `kindgi_session` never counts where
  // the session cookie is `Secure`.
  const value = getCookie(c, sessionCookieOf(cookie).name)?.trim();
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
          : `A request signed in by the session cookie can't come from ${origin}${
              cookie.allowedOrigins[0] !== undefined
                ? `; open the console at ${cookie.allowedOrigins[0]}`
                : ''
            }`,
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

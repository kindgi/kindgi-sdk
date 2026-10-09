// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import type { SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  ClaimMappingScopesSpec,
  ClaimMappingSpec,
  ExchangeCodeFn,
  IdentityProviderBinding,
  ProviderConfig,
  RefreshTokenFn,
  SamlAttributeMapping,
} from '../identity-provider-binding.js';
import { encodeSessionToken } from '../middleware/auth.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import type {
  Session,
  SessionCreateOutput,
  SessionStoreBinding,
} from '../session-store-binding.js';
import type { OauthStateStore } from '../state-store-binding.js';
import type { AppEnv } from '../types.js';
import { hasCapability } from './env.js';
import { tenantResourceAccess } from './tenant-access.js';

/**
 * Auth routes. Layer OAuth 2.0 / OIDC on top of the static
 * bearer-token infrastructure. Bearer-token routes remain byte-shape-
 * identical; auth flow is caller-plugged via `IdentityProviderBinding`
 * (provider catalog) + `SessionStoreBinding` (session persistence) +
 * `OauthStateStore` (short-lived CSRF/PKCE cache).
 *
 * Every route runs INSIDE the `/v1/*` auth chain and requires either a
 * bearer or session token, EXCEPT `/v1/auth/callback/:providerId` which
 * accepts the redirect from the provider carrying no framework token
 * (that would be a chicken-and-egg — the caller hasn't obtained a
 * session yet). `createApp` (`app.ts`) mounts the callback outside the
 * auth chain so unauthenticated redirects reach it.
 */
export interface AuthRouterOptions {
  readonly sessionStore: SessionStoreBinding;
  readonly identityProvider: IdentityProviderBinding;
  readonly stateStore: OauthStateStore;
  /**
   * The deployment's own code exchange. With it, `POST /login/:providerId`
   * and the callback mount (the OAuth flow run by this package); without
   * it (sign-in runs elsewhere, e.g. a browser flow in the deployment),
   * only the provider catalog, refresh and logout do.
   */
  readonly exchangeCode?: ExchangeCodeFn;
  readonly refreshToken?: RefreshTokenFn;
  /**
   * Default TTL for the CSRF/PKCE state cache entries. 10 minutes covers
   * a normal browser hop with margin for slow provider consent screens
   * without keeping a lost row around forever.
   */
  readonly stateTtlMs?: number;
  /**
   * With one (T243 A): the provider catalog is tenant-wide, so reading it
   * needs `read` on the tenant and changing it `admin`, as for every
   * tenant-wide resource (`tenantResourceAccess`). Logging in, refreshing
   * and logging out are the caller's own, and stay unchecked.
   */
  readonly authorizer?: Authorizer;
  /**
   * Who may add, change and remove the tenant's providers: `tenant` (the
   * default) its admins; `operator` only the deployment's own token (the
   * `kindgi:system` capability), when the operator manages sign-in
   * (`KINDGI_AUTH_TENANT_PROVIDERS=off`). Reads, and signing in with the
   * providers already there, are the same either way.
   */
  readonly providerChanges?: 'tenant' | 'operator';
  /** `signed-out` events, best effort. */
  readonly auditEvents?: AuditEventBinding;
}

/** The answer to a tenant's change to a provider when the operator manages sign-in. */
export const OPERATOR_MANAGED_MESSAGE =
  "This deployment's operator manages sign-in (KINDGI_AUTH_TENANT_PROVIDERS=off): identity providers can't be added, changed or removed here, except with the deployment's own token (KINDGI_API_TOKEN).";

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Build the auth router. Two Hono routers are returned — one gated
 * (mounted inside the `/v1/*` bearer chain: provider catalog CRUD,
 * login initiation, refresh, logout) and one public-adjacent (mounted
 * outside the bearer chain: callback endpoint the provider redirects
 * to; still tenant-scoped via the state row's `tenantId`).
 *
 * `whoami` lives at `/v1/identity/whoami` and is unconditionally
 * mounted from `identityRouter`.
 */
export function authRouters(options: AuthRouterOptions): {
  readonly authed: Hono<AppEnv>;
  readonly callback: Hono<AppEnv>;
} {
  const { sessionStore, identityProvider, stateStore, exchangeCode } = options;
  const refreshToken = options.refreshToken;
  const stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;

  const authed = new Hono<AppEnv>();

  // The provider catalog is tenant-wide: any GET (the list, one provider,
  // its sign-in URLs) needs `read` on the tenant, any change `admin`.
  const providerAccess = tenantResourceAccess(options.authorizer);
  authed.use('/providers', providerAccess);
  authed.use('/providers/*', providerAccess);

  // When the operator manages sign-in, a change takes the deployment's own
  // token; the providers there keep signing people in.
  const providerChanges = options.providerChanges ?? 'tenant';
  if (providerChanges === 'operator') {
    const operatorOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
      if (c.req.method === 'GET' || c.req.method === 'HEAD' || hasCapability(c, 'kindgi:system')) {
        return next();
      }
      c.status(statusFor('identity-providers-operator-managed') as never);
      return c.json(
        toWireError(
          { code: 'identity-providers-operator-managed', message: OPERATOR_MANAGED_MESSAGE },
          c.get('requestId'),
        ),
      );
    };
    authed.use('/providers', operatorOnly);
    authed.use('/providers/*', operatorOnly);
  }

  // ---------- GET /providers ----------
  authed.get('/providers', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const page = await identityProvider.list({ tenantId });
    return c.json({
      data: page.data.map(serializeProviderConfig),
      hasMore: false,
      changes: providerChanges,
    });
  });

  // ---------- POST /providers ----------
  authed.post('/providers', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsedJson = await parseJsonBody(c);
    if (parsedJson.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError(parsedJson.error, requestId));
    }
    const parsed = parseProviderConfig(parsedJson.value);
    if (parsed.kind === 'err') {
      c.status(statusFor(parsed.error.code) as never);
      return c.json(toWireError(parsed.error, requestId));
    }

    const existing = await identityProvider.get({ tenantId, providerId: parsed.value.providerId });
    if (existing !== null) {
      c.status(statusFor('identity-provider-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'identity-provider-already-registered',
            message: `Identity provider "${parsed.value.providerId}" is already registered for this tenant`,
            providerId: parsed.value.providerId,
          },
          requestId,
        ),
      );
    }

    const outcome = await identityProvider.register({ tenantId, config: parsed.value });
    if (outcome.kind === 'invalid') {
      c.status(statusFor('identity-provider-invalid') as never);
      return c.json(
        toWireError(
          {
            code: 'identity-provider-invalid',
            message: outcome.message,
            providerId: parsed.value.providerId,
          },
          requestId,
        ),
      );
    }
    c.status(201);
    return c.json({
      providerId: outcome.providerId,
      ...(outcome.provider !== undefined && {
        provider: serializeProviderConfig(outcome.provider),
      }),
    });
  });

  // ---------- GET /providers/:providerId ----------
  authed.get('/providers/:providerId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const providerId = c.req.param('providerId');
    const found = await identityProvider.get({ tenantId, providerId });
    if (found === null) return providerNotFound(c, providerId);
    return c.json(serializeProviderConfig(found));
  });

  // ---------- GET /providers/:providerId/sign-in ----------
  const signInUrls = identityProvider.signInUrls;
  if (signInUrls !== undefined) {
    authed.get('/providers/:providerId/sign-in', async (c) => {
      const requestId = c.get('requestId');
      const tenantId = c.get('tenantId') as TenantId;
      const providerId = c.req.param('providerId');
      const asked = c.req.query('kind');
      if (asked !== undefined && asked !== 'oidc' && asked !== 'saml' && asked !== 'oauth2') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`kind` must be `oidc`, `saml` or `oauth2`' },
            requestId,
          ),
        );
      }
      const registered = await identityProvider.get({ tenantId, providerId });
      const kind = asked ?? registered?.kind;
      if (kind === undefined) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `No identity provider "${providerId}" is registered yet: say which \`kind\` it will be (\`?kind=oidc\` or \`?kind=saml\`)`,
            },
            requestId,
          ),
        );
      }
      const signIn = await signInUrls({ tenantId, providerId, kind });
      if (signIn === undefined) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `This deployment doesn't sign in with \`${kind}\` providers`,
            },
            requestId,
          ),
        );
      }
      return c.json({ providerId, kind, signIn, registered: registered !== null });
    });
  }

  // ---------- PATCH /providers/:providerId ----------
  const update = identityProvider.update;
  if (update !== undefined) {
    authed.patch('/providers/:providerId', async (c) => {
      const requestId = c.get('requestId');
      const tenantId = c.get('tenantId') as TenantId;
      const providerId = c.req.param('providerId');

      const parsedJson = await parseJsonBody(c);
      if (parsedJson.kind === 'err') {
        c.status(statusFor('bad-input') as never);
        return c.json(toWireError(parsedJson.error, requestId));
      }
      const existing = await identityProvider.get({ tenantId, providerId });
      if (existing === null) return providerNotFound(c, providerId);
      const merged = mergeProviderChanges(existing, parsedJson.value);
      const parsed = merged.kind === 'err' ? merged : parseProviderConfig(merged.value);
      if (parsed.kind === 'err') {
        c.status(statusFor(parsed.error.code) as never);
        return c.json(toWireError(parsed.error, requestId));
      }

      const outcome = await update({ tenantId, config: parsed.value });
      if (outcome.kind === 'not-found') return providerNotFound(c, providerId);
      if (outcome.kind === 'invalid') {
        c.status(statusFor('identity-provider-invalid') as never);
        return c.json(
          toWireError(
            { code: 'identity-provider-invalid', message: outcome.message, providerId },
            requestId,
          ),
        );
      }
      return c.json({ providerId, provider: serializeProviderConfig(outcome.provider) });
    });
  }

  // ---------- POST /providers/:providerId/unregister ----------
  authed.post('/providers/:providerId/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const providerId = c.req.param('providerId');

    const outcome = await identityProvider.unregister({ tenantId, providerId });
    if (!outcome.unregistered) {
      c.status(statusFor('identity-provider-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'identity-provider-not-found',
            message: `No identity provider registered with id "${providerId}"`,
            providerId,
          },
          requestId,
        ),
      );
    }
    return c.json({ providerId, unregistered: true });
  });

  if (exchangeCode !== undefined) {
    // ---------- POST /login/:providerId ----------
    authed.post('/login/:providerId', async (c) => {
      const requestId = c.get('requestId');
      const tenantId = c.get('tenantId') as TenantId;
      const providerId = c.req.param('providerId');

      const found = await identityProvider.get({ tenantId, providerId });
      if (found === null) {
        c.status(statusFor('identity-provider-not-found') as never);
        return c.json(
          toWireError(
            {
              code: 'identity-provider-not-found',
              message: `No identity provider registered with id "${providerId}"`,
              providerId,
            },
            requestId,
          ),
        );
      }
      const config = oauthFlowOf(found);
      if (config === null) {
        c.status(statusFor('invalid-provider-config') as never);
        return c.json(
          toWireError(
            {
              code: 'invalid-provider-config',
              message: `Identity provider "${providerId}" (${found.kind}) signs in through the deployment's own sign-in, not this endpoint`,
              providerId,
            },
            requestId,
          ),
        );
      }

      let redirectUri: string | undefined;
      const parsedBody = await parseOptionalJsonBody(c);
      if (parsedBody.kind === 'err') {
        c.status(statusFor('bad-input') as never);
        return c.json(toWireError(parsedBody.error, requestId));
      }
      if (parsedBody.value !== undefined) {
        const raw = (parsedBody.value as { redirectUri?: unknown }).redirectUri;
        if (raw !== undefined) {
          if (typeof raw !== 'string' || raw.length === 0) {
            c.status(statusFor('bad-input') as never);
            return c.json(
              toWireError(
                { code: 'bad-input', message: '`redirectUri` must be a non-empty string' },
                requestId,
              ),
            );
          }
          redirectUri = raw;
        }
      }

      const state = base64Url(randomBytes(32));
      const codeVerifier = base64Url(randomBytes(64));
      const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
      const effectiveRedirect =
        redirectUri ??
        (typeof config.metadata?.defaultRedirectUri === 'string'
          ? String(config.metadata?.defaultRedirectUri)
          : '');
      if (effectiveRedirect.length === 0) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message:
                '`redirectUri` must be supplied in the body or via `metadata.defaultRedirectUri` on the provider config',
            },
            requestId,
          ),
        );
      }

      // OAuth 2.1 BCP redirect-URI allowlist enforcement. Absent /
      // empty list means pass-through (no allowlist check); populated
      // list requires an exact-string match against the effective
      // redirect URI (either the body-supplied value or the resolved
      // `metadata.defaultRedirectUri`). This is the primary gate — the
      // callback route re-verifies against the same list for
      // belt-and-suspenders defense in case the allowlist tightened
      // between login and callback.
      if (
        config.allowedRedirectUris !== undefined &&
        config.allowedRedirectUris.length > 0 &&
        !config.allowedRedirectUris.includes(effectiveRedirect)
      ) {
        c.status(statusFor('redirect-uri-not-allowed') as never);
        return c.json(
          toWireError(
            {
              code: 'redirect-uri-not-allowed',
              message: `redirect_uri "${effectiveRedirect}" is not in the provider's allowedRedirectUris list`,
              providerId,
            },
            requestId,
          ),
        );
      }

      await stateStore.put({
        state,
        tenantId,
        providerId,
        codeVerifier,
        redirectUri: effectiveRedirect,
        expiresAt: Date.now() + stateTtlMs,
      });

      const authorizationUrl = buildAuthorizationUrl({
        config,
        state,
        codeChallenge,
        redirectUri: effectiveRedirect,
      });
      return c.json({
        authorizationUrl,
        state,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });
    });
  }

  // ---------- POST /refresh ----------
  authed.post('/refresh', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const sessionId = c.get('sessionId') as SessionId | undefined;
    if (sessionId === undefined) {
      c.status(statusFor('auth-not-session-token') as never);
      return c.json(
        toWireError(
          {
            code: 'auth-not-session-token',
            message:
              'Refresh is only valid for session tokens (`kgi_sk_*`); bearer tokens are managed via `/v1/tokens`',
          },
          requestId,
        ),
      );
    }
    if (c.get('sessionCookieName') !== undefined) {
      // Refresh answers with the new token in its body, which a browser
      // session must never hand to page scripts: it ends at its TTL.
      c.status(statusFor('cookie-session-not-refreshable') as never);
      return c.json(
        toWireError(
          {
            code: 'cookie-session-not-refreshable',
            message: 'A browser session (cookie) is not refreshed: sign in again when it ends',
          },
          requestId,
        ),
      );
    }
    const current = await sessionStore.get({ tenantId, sessionId });
    if (current === null || current.revokedAt !== undefined) {
      c.status(statusFor('session-not-found') as never);
      return c.json(
        toWireError(
          { code: 'session-not-found', message: 'Session no longer exists', sessionId },
          requestId,
        ),
      );
    }

    let created: { readonly session: Session; readonly rawToken: string };
    if (refreshToken !== undefined && current.refreshToken !== undefined) {
      let rotated: Awaited<ReturnType<RefreshTokenFn>>;
      try {
        rotated = await refreshToken({
          tenantId,
          providerId: current.providerId,
          refreshToken: current.refreshToken,
        });
      } catch (err) {
        c.status(statusFor('oauth-refresh-failed') as never);
        return c.json(
          toWireError(
            {
              code: 'oauth-refresh-failed',
              message: err instanceof Error ? err.message : 'refresh failed',
            },
            requestId,
          ),
        );
      }
      const createdSession = await sessionStore.create({
        tenantId,
        userId: current.userId,
        providerId: current.providerId,
        accessToken: rotated.accessToken,
        ...(rotated.refreshToken !== undefined && { refreshToken: rotated.refreshToken }),
        expiresAt: rotated.expiresAt.toISOString() as never,
        scopes: rotated.scopes,
        ...(rotated.claims !== undefined && { metadata: rotated.claims }),
      });
      const fresh = await sessionStore.get({ tenantId, sessionId: createdSession.sessionId });
      if (fresh === null) throw new Error('session vanished immediately after create');
      created = { session: fresh, rawToken: sessionTokenOf(createdSession) };
    } else {
      // Rotate the framework token only; keep provider tokens as-is.
      const createdSession = await sessionStore.create({
        tenantId,
        userId: current.userId,
        providerId: current.providerId,
        ...(current.accessToken !== undefined && { accessToken: current.accessToken }),
        ...(current.refreshToken !== undefined && { refreshToken: current.refreshToken }),
        expiresAt: current.expiresAt,
        scopes: current.scopes,
        ...(current.metadata !== undefined && { metadata: current.metadata }),
      });
      const fresh = await sessionStore.get({ tenantId, sessionId: createdSession.sessionId });
      if (fresh === null) throw new Error('session vanished immediately after create');
      created = { session: fresh, rawToken: sessionTokenOf(createdSession) };
    }

    // OAuth 2.1 BCP: mark the old session as ROTATED (not just revoked)
    // so the middleware can return `401 refresh-token-invalid` on reuse
    // rather than the generic `401 auth-revoked`. Reuse detection lets
    // compliant clients retry with the fresh token instead of forcing
    // a full re-auth.
    await sessionStore.revoke({ tenantId, sessionId, reason: 'rotate' });

    // A session token: an Idempotency-Key repeat doesn't get it.
    withholdFromReplay(c);
    return c.json({
      sessionToken: created.rawToken,
      sessionId: created.session.id,
      expiresAt: created.session.expiresAt,
    });
  });

  // ---------- POST /logout ----------
  authed.post('/logout', logoutHandler(sessionStore, options.auditEvents));

  const callback = new Hono<AppEnv>();

  // ---------- POST /callback/:providerId (mounted outside the bearer chain) ----------
  if (exchangeCode !== undefined) {
    callback.post('/:providerId', async (c) => {
      const requestId = c.get('requestId');
      const providerId = c.req.param('providerId');

      const parsedJson = await parseJsonBody(c);
      if (parsedJson.kind === 'err') {
        c.status(statusFor('bad-input') as never);
        return c.json(toWireError(parsedJson.error, requestId));
      }
      const parsedCallback = parseCallbackBody(parsedJson.value);
      if (parsedCallback.kind === 'err') {
        c.status(statusFor(parsedCallback.error.code) as never);
        return c.json(toWireError(parsedCallback.error, requestId));
      }
      const { code, state } = parsedCallback.value;

      // `state` alone is uniquely identifying (256 bits of entropy). The
      // store returns the row's `tenantId` so we know which tenant the
      // callback belongs to — cross-checking `providerId` guards against
      // a stolen `state` being replayed against the wrong provider mount.
      const entry = await stateStore.take({ state, providerId });
      if (entry === null) {
        c.status(statusFor('oauth-state-invalid') as never);
        return c.json(
          toWireError(
            {
              code: 'oauth-state-invalid',
              message: '`state` is unknown, expired, or already consumed',
            },
            requestId,
          ),
        );
      }

      // Belt-and-suspenders redirect-URI check. Login already validated
      // the stored redirect_uri against `allowedRedirectUris` when the
      // row was written, but the allowlist may have tightened between
      // login and callback — if so, refuse the exchange rather than
      // handing the caller a session under a redirect the tenant no
      // longer trusts. Also runs when the provider config went missing
      // (unregister mid-flight) so we don't silently proceed.
      const currentConfig = await identityProvider.get({
        tenantId: entry.tenantId,
        providerId,
      });
      const currentAllowlist =
        currentConfig === null ? undefined : oauthFlowOf(currentConfig)?.allowedRedirectUris;
      if (
        currentAllowlist !== undefined &&
        currentAllowlist.length > 0 &&
        !currentAllowlist.includes(entry.redirectUri)
      ) {
        c.status(statusFor('redirect-uri-mismatch') as never);
        return c.json(
          toWireError(
            {
              code: 'redirect-uri-mismatch',
              message:
                "redirect_uri from the login state row is not in the provider's current allowedRedirectUris list",
              providerId,
            },
            requestId,
          ),
        );
      }

      let outcome: Awaited<ReturnType<ExchangeCodeFn>>;
      try {
        outcome = await exchangeCode({
          tenantId: entry.tenantId,
          providerId,
          code,
          codeVerifier: entry.codeVerifier,
          redirectUri: entry.redirectUri,
        });
      } catch (err) {
        c.status(statusFor('oauth-code-exchange-failed') as never);
        return c.json(
          toWireError(
            {
              code: 'oauth-code-exchange-failed',
              message: err instanceof Error ? err.message : 'code exchange failed',
            },
            requestId,
          ),
        );
      }

      const created = await sessionStore.create({
        tenantId: entry.tenantId,
        userId: outcome.userId as unknown as UserId,
        providerId,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken !== undefined && { refreshToken: outcome.refreshToken }),
        expiresAt: outcome.expiresAt.toISOString() as never,
        scopes: outcome.scopes,
        ...(outcome.claims !== undefined && { metadata: outcome.claims }),
      });

      // A session token: an Idempotency-Key repeat doesn't get it.
      withholdFromReplay(c);
      c.status(201);
      return c.json({
        sessionToken: sessionTokenOf(created),
        sessionId: created.sessionId,
        expiresAt: created.expiresAt,
      });
    });
  }

  return { authed, callback };
}

// ---------- helpers ----------

/** The token a store minted, or the older `kgi_sk_<sessionId>` for a store that mints none. */
function sessionTokenOf(created: SessionCreateOutput): string {
  return created.token ?? encodeSessionToken(created.sessionId);
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** What this package's own OAuth flow (login + callback) needs from a provider. */
interface OAuthFlowConfig {
  readonly clientId: string;
  readonly authorizationEndpoint: string;
  readonly scopes: readonly string[];
  readonly allowedRedirectUris?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

const DEFAULT_OIDC_SCOPES: readonly string[] = ['openid', 'email', 'profile'];

/**
 * The provider's OAuth flow settings, or `null` when it has none: a SAML
 * provider, or an OIDC one whose endpoints the deployment hasn't
 * discovered (it signs in through the deployment's own browser flow).
 */
function oauthFlowOf(config: ProviderConfig): OAuthFlowConfig | null {
  if (config.kind === 'saml') return null;
  if (config.kind === 'oidc' && config.authorizationEndpoint === undefined) return null;
  return {
    clientId: config.clientId,
    authorizationEndpoint: config.authorizationEndpoint as string,
    scopes: config.scopes ?? DEFAULT_OIDC_SCOPES,
    ...(config.allowedRedirectUris !== undefined && {
      allowedRedirectUris: config.allowedRedirectUris,
    }),
    ...(config.metadata !== undefined && { metadata: config.metadata }),
  };
}

function buildAuthorizationUrl(input: {
  readonly config: OAuthFlowConfig;
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}): string {
  const { config, state, codeChallenge, redirectUri } = input;
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function providerNotFound(c: Context<AppEnv>, providerId: string): Response {
  c.status(statusFor('identity-provider-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'identity-provider-not-found',
        message: `No identity provider registered with id "${providerId}"`,
        providerId,
      },
      c.get('requestId'),
    ),
  );
}

/** What the issuer's discovery gave: stale once the issuer changes. */
const DISCOVERED_OIDC_FIELDS = [
  'authorizationEndpoint',
  'tokenEndpoint',
  'userinfoEndpoint',
  'jwksEndpoint',
] as const;

/**
 * A PATCH body merged into the stored provider: a field given replaces
 * it, `null` removes it, `providerId` and `kind` can't change. `signIn`
 * is the deployment's, so it never comes from the stored copy. A new
 * `issuer` drops the endpoints discovered from the old one.
 */
function mergeProviderChanges(
  existing: ProviderConfig,
  body: unknown,
): ParsedOk<Record<string, unknown>> | ParsedErr {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', error: { code: 'bad-input', message: 'Request body must be an object' } };
  }
  const changes = body as Record<string, unknown>;
  if (changes.providerId !== undefined && changes.providerId !== existing.providerId) {
    return invalid(
      "`providerId` can't change: register the provider under the new id, then unregister this one",
    );
  }
  if (changes.kind !== undefined && changes.kind !== existing.kind) {
    return invalid(
      "`kind` can't change: register a new provider of that kind, then unregister this one",
    );
  }
  const { signIn: _deployments, ...stored } = serializeProviderConfig(existing);
  const merged: Record<string, unknown> = stored;
  if (
    existing.kind === 'oidc' &&
    changes.issuer !== undefined &&
    changes.issuer !== existing.issuer
  ) {
    for (const field of DISCOVERED_OIDC_FIELDS) delete merged[field];
  }
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) delete merged[field];
    else merged[field] = value;
  }
  return { kind: 'ok', value: merged };
}

function serializeProviderConfig(c: ProviderConfig): Record<string, unknown> {
  // References to secrets (`clientSecretRef`, `spSigningKeyRef`…) are safe
  // to return: they aren't the secrets. Clients need enough to render a
  // "Sign in with X" button and to configure the identity provider.
  const base = {
    providerId: c.providerId,
    kind: c.kind,
    ...definedOf(c, ['displayName', 'domains', 'join', 'signIn', 'metadata']),
  };
  switch (c.kind) {
    case 'oauth2':
      return {
        ...base,
        clientId: c.clientId,
        clientSecretRef: c.clientSecretRef,
        authorizationEndpoint: c.authorizationEndpoint,
        tokenEndpoint: c.tokenEndpoint,
        scopes: c.scopes,
        ...definedOf(c, ['userinfoEndpoint', 'allowedRedirectUris', 'claimMapping']),
      };
    case 'oidc':
      return {
        ...base,
        issuer: c.issuer,
        clientId: c.clientId,
        clientSecretRef: c.clientSecretRef,
        ...definedOf(c, [
          'scopes',
          'authorizationEndpoint',
          'tokenEndpoint',
          'userinfoEndpoint',
          'jwksEndpoint',
          'allowedRedirectUris',
          'claimMapping',
        ]),
      };
    case 'saml':
      return {
        ...base,
        ...definedOf(c, [
          'idpMetadataXml',
          'idpEntityId',
          'idpSsoUrl',
          'idpCertificates',
          'spSigningKeyRef',
          'spDecryptionKeyRef',
          'wantAssertionsSigned',
          'attributeMapping',
        ]),
      };
  }
}

/** The named fields of `obj` that are set. */
function definedOf<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

type ParsedOk<T> = { readonly kind: 'ok'; readonly value: T };
type ParsedErr = {
  readonly kind: 'err';
  readonly error: { readonly code: string; readonly message: string };
};

async function parseJsonBody(c: Context<AppEnv>): Promise<ParsedOk<unknown> | ParsedErr> {
  try {
    const text = await c.req.text();
    if (text.length === 0) {
      return { kind: 'err', error: { code: 'bad-input', message: 'Request body is required' } };
    }
    return { kind: 'ok', value: JSON.parse(text) };
  } catch {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: 'Request body must be valid JSON' },
    };
  }
}

async function parseOptionalJsonBody(
  c: Context<AppEnv>,
): Promise<ParsedOk<unknown | undefined> | ParsedErr> {
  try {
    const text = await c.req.text();
    if (text.length === 0) return { kind: 'ok', value: undefined };
    return { kind: 'ok', value: JSON.parse(text) };
  } catch {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: 'Request body must be valid JSON' },
    };
  }
}

/**
 * Fields that would carry a secret itself rather than a reference to one:
 * refused outright, so a secret sent by mistake is never stored.
 */
const PLAINTEXT_SECRET_FIELDS: Readonly<Record<string, string>> = {
  clientSecret: 'clientSecretRef',
  spSigningKey: 'spSigningKeyRef',
  spDecryptionKey: 'spDecryptionKeyRef',
  privateKey: 'spSigningKeyRef',
};

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function invalid(message: string): ParsedErr {
  return { kind: 'err', error: { code: 'invalid-provider-config', message } };
}

/** Reads typed fields off a request body, collecting the first problem. */
class FieldReader {
  error: ParsedErr | undefined;
  constructor(private readonly b: Record<string, unknown>) {}

  str(k: string): string {
    const v = this.b[k];
    if (typeof v !== 'string' || v.length === 0) {
      this.error ??= invalid(`Field \`${k}\` must be a non-empty string`);
      return '';
    }
    return v;
  }

  optStr(k: string): string | undefined {
    const v = this.b[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0) {
      this.error ??= invalid(`\`${k}\` must be a non-empty string when supplied`);
      return undefined;
    }
    return v;
  }

  url(k: string, required: boolean): string | undefined {
    const v = required ? this.str(k) : this.optStr(k);
    if (v === undefined || v === '') return v;
    try {
      new URL(v);
    } catch {
      this.error ??= invalid(`\`${k}\` must be an absolute URL`);
    }
    return v;
  }

  strings(k: string, required: boolean): readonly string[] | undefined {
    const v = this.b[k];
    if (v === undefined) {
      if (required) this.error ??= invalid(`\`${k}\` must be an array of strings`);
      return undefined;
    }
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
      this.error ??= invalid(`\`${k}\` must be an array of non-empty strings`);
      return undefined;
    }
    return v as string[];
  }

  bool(k: string): boolean | undefined {
    const v = this.b[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') {
      this.error ??= invalid(`\`${k}\` must be a boolean when supplied`);
      return undefined;
    }
    return v;
  }

  object(k: string): Record<string, unknown> | undefined {
    const v = this.b[k];
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      this.error ??= invalid(`\`${k}\` must be an object when supplied`);
      return undefined;
    }
    return v as Record<string, unknown>;
  }
}

function parseProviderConfig(body: unknown): ParsedOk<ProviderConfig> | ParsedErr {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', error: { code: 'bad-input', message: 'Request body must be an object' } };
  }
  const b = body as Record<string, unknown>;
  for (const [field, instead] of Object.entries(PLAINTEXT_SECRET_FIELDS)) {
    if (b[field] !== undefined) {
      return invalid(
        `\`${field}\` is never accepted: register \`${instead}\`, a reference the deployment resolves`,
      );
    }
  }
  const kind = b.kind;
  if (kind !== 'oauth2' && kind !== 'oidc' && kind !== 'saml') {
    return invalid('`kind` must be `oidc`, `saml` or `oauth2`');
  }

  const r = new FieldReader(b);
  const providerId = r.str('providerId');
  const displayName = r.optStr('displayName');
  const domainsRaw = r.strings('domains', false);
  const domains = domainsRaw?.map((d) => d.toLowerCase());
  if (domains?.some((d) => !DOMAIN_RE.test(d))) {
    r.error ??= invalid('`domains` must be email domains, e.g. `acme.com`');
  }
  const join = b.join;
  if (join !== undefined && join !== 'invite' && join !== 'domain') {
    r.error ??= invalid('`join` must be `invite` or `domain`');
  }
  if (join === 'domain' && (domains === undefined || domains.length === 0)) {
    r.error ??= invalid('`join: domain` needs `domains`');
  }
  const metadata = r.object('metadata');
  const base = {
    providerId,
    ...(displayName !== undefined && { displayName }),
    ...(domains !== undefined && { domains }),
    ...(join !== undefined && { join: join as 'invite' | 'domain' }),
    ...(metadata !== undefined && { metadata }),
  };

  let claimMapping: ClaimMappingSpec | undefined;
  if (kind !== 'saml' && b.claimMapping !== undefined) {
    const parsed = parseClaimMapping(b.claimMapping);
    if (parsed.kind === 'err') return parsed;
    claimMapping = parsed.value;
  }

  let value: ProviderConfig;
  if (kind === 'oauth2') {
    const clientId = r.str('clientId');
    const clientSecretRef = r.str('clientSecretRef');
    const authorizationEndpoint = r.str('authorizationEndpoint');
    const tokenEndpoint = r.str('tokenEndpoint');
    const userinfoEndpoint = r.optStr('userinfoEndpoint');
    const scopes = r.strings('scopes', true) ?? [];
    const allowedRedirectUris = r.strings('allowedRedirectUris', false);
    value = {
      ...base,
      kind,
      clientId,
      clientSecretRef,
      authorizationEndpoint,
      tokenEndpoint,
      scopes,
      ...(userinfoEndpoint !== undefined && { userinfoEndpoint }),
      ...(allowedRedirectUris !== undefined && { allowedRedirectUris }),
      ...(claimMapping !== undefined && { claimMapping }),
    };
  } else if (kind === 'oidc') {
    const issuer = r.url('issuer', true) ?? '';
    const clientId = r.str('clientId');
    const clientSecretRef = r.str('clientSecretRef');
    const scopes = r.strings('scopes', false);
    const authorizationEndpoint = r.url('authorizationEndpoint', false);
    const tokenEndpoint = r.url('tokenEndpoint', false);
    const userinfoEndpoint = r.url('userinfoEndpoint', false);
    const jwksEndpoint = r.url('jwksEndpoint', false);
    const allowedRedirectUris = r.strings('allowedRedirectUris', false);
    value = {
      ...base,
      kind,
      issuer,
      clientId,
      clientSecretRef,
      ...(scopes !== undefined && { scopes }),
      ...(authorizationEndpoint !== undefined && { authorizationEndpoint }),
      ...(tokenEndpoint !== undefined && { tokenEndpoint }),
      ...(userinfoEndpoint !== undefined && { userinfoEndpoint }),
      ...(jwksEndpoint !== undefined && { jwksEndpoint }),
      ...(allowedRedirectUris !== undefined && { allowedRedirectUris }),
      ...(claimMapping !== undefined && { claimMapping }),
    };
  } else {
    const idpMetadataXml = r.optStr('idpMetadataXml');
    const idpEntityId = r.optStr('idpEntityId');
    const idpSsoUrl = r.url('idpSsoUrl', false);
    const idpCertificates = r.strings('idpCertificates', false);
    if (
      idpMetadataXml === undefined &&
      (idpEntityId === undefined ||
        idpSsoUrl === undefined ||
        idpCertificates === undefined ||
        idpCertificates.length === 0)
    ) {
      r.error ??= invalid(
        'A SAML provider needs `idpMetadataXml`, or `idpEntityId` + `idpSsoUrl` + `idpCertificates`',
      );
    }
    const spSigningKeyRef = r.optStr('spSigningKeyRef');
    const spDecryptionKeyRef = r.optStr('spDecryptionKeyRef');
    const wantAssertionsSigned = r.bool('wantAssertionsSigned');
    const mappingRaw = r.object('attributeMapping');
    let attributeMapping: SamlAttributeMapping | undefined;
    if (mappingRaw !== undefined) {
      const m = new FieldReader(mappingRaw);
      const userId = m.optStr('userId');
      const email = m.optStr('email');
      const displayName = m.optStr('displayName');
      if (m.error !== undefined)
        r.error ??= invalid(`\`attributeMapping\`: ${m.error.error.message}`);
      attributeMapping = {
        ...(userId !== undefined && { userId }),
        ...(email !== undefined && { email }),
        ...(displayName !== undefined && { displayName }),
      };
    }
    value = {
      ...base,
      kind,
      ...(idpMetadataXml !== undefined && { idpMetadataXml }),
      ...(idpEntityId !== undefined && { idpEntityId }),
      ...(idpSsoUrl !== undefined && { idpSsoUrl }),
      ...(idpCertificates !== undefined && { idpCertificates }),
      ...(spSigningKeyRef !== undefined && { spSigningKeyRef }),
      ...(spDecryptionKeyRef !== undefined && { spDecryptionKeyRef }),
      ...(wantAssertionsSigned !== undefined && { wantAssertionsSigned }),
      ...(attributeMapping !== undefined && { attributeMapping }),
    };
  }
  if (r.error !== undefined) return r.error;
  return { kind: 'ok', value };
}

function parseClaimMapping(raw: unknown): ParsedOk<ClaimMappingSpec> | ParsedErr {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-provider-config',
        message: '`claimMapping` must be an object when supplied',
      },
    };
  }
  const m = raw as Record<string, unknown>;
  const optionalString = (
    key: keyof ClaimMappingSpec,
    value: unknown,
  ): string | ParsedErr | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-provider-config',
          message: `\`claimMapping.${String(key)}\` must be a non-empty string when supplied`,
        },
      };
    }
    return value;
  };
  const userId = optionalString('userId', m.userId);
  if (typeof userId !== 'string' && userId !== undefined) return userId;
  const email = optionalString('email', m.email);
  if (typeof email !== 'string' && email !== undefined) return email;
  const displayName = optionalString('displayName', m.displayName);
  if (typeof displayName !== 'string' && displayName !== undefined) return displayName;

  let scopes: ClaimMappingScopesSpec | undefined;
  if (m.scopes !== undefined) {
    const s = m.scopes;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-provider-config',
          message: '`claimMapping.scopes` must be an object when supplied',
        },
      };
    }
    const so = s as Record<string, unknown>;
    if (typeof so.claim !== 'string' || so.claim.length === 0) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-provider-config',
          message: '`claimMapping.scopes.claim` must be a non-empty string',
        },
      };
    }
    if (so.delimiter !== undefined && typeof so.delimiter !== 'string') {
      return {
        kind: 'err',
        error: {
          code: 'invalid-provider-config',
          message: '`claimMapping.scopes.delimiter` must be a string when supplied',
        },
      };
    }
    scopes = {
      claim: so.claim,
      ...(typeof so.delimiter === 'string' && { delimiter: so.delimiter }),
    };
  }

  let metadata: readonly string[] | undefined;
  if (m.metadata !== undefined) {
    if (
      !Array.isArray(m.metadata) ||
      m.metadata.some((s) => typeof s !== 'string' || s.length === 0)
    ) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-provider-config',
          message: '`claimMapping.metadata` must be an array of non-empty strings when supplied',
        },
      };
    }
    metadata = m.metadata as string[];
  }

  return {
    kind: 'ok',
    value: {
      ...(userId !== undefined && { userId }),
      ...(email !== undefined && { email }),
      ...(displayName !== undefined && { displayName }),
      ...(scopes !== undefined && { scopes }),
      ...(metadata !== undefined && { metadata }),
    },
  };
}

function parseCallbackBody(
  body: unknown,
): ParsedOk<{ readonly code: string; readonly state: string }> | ParsedErr {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', error: { code: 'bad-input', message: 'Request body must be an object' } };
  }
  const b = body as Record<string, unknown>;
  const code = b.code;
  if (typeof code !== 'string' || code.length === 0) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`code` must be a non-empty string' },
    };
  }
  const state = b.state;
  if (typeof state !== 'string' || state.length === 0) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`state` must be a non-empty string' },
    };
  }
  return { kind: 'ok', value: { code, state } };
}

/**
 * `POST /v1/auth/logout`: revokes the caller's session; a browser session
 * loses its cookie too. Also mounted on its own with cookie sessions and
 * no identity providers (console token sign-in).
 */
export function logoutHandler(
  sessionStore: SessionStoreBinding,
  auditEvents?: AuditEventBinding,
): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const sessionId = c.get('sessionId') as SessionId | undefined;
    if (sessionId === undefined) {
      c.status(statusFor('auth-not-session-token') as never);
      return c.json(
        toWireError(
          {
            code: 'auth-not-session-token',
            message:
              'Logout is only valid for session tokens (`kgi_sk_*`); bearer tokens are managed via `/v1/tokens`',
          },
          requestId,
        ),
      );
    }
    const outcome = await sessionStore.revoke({ tenantId, sessionId });
    const userId = c.get('userId');
    if (auditEvents !== undefined && outcome.revoked) {
      try {
        const appended = await auditEvents.append([
          {
            id: randomUUID(),
            tenantId,
            kind: 'signed-out',
            timestamp: new Date().toISOString() as Timestamp,
            actor: userId !== undefined ? `user:${userId}` : 'system',
            outcome: 'succeeded',
            payload: { v: 1, doc: { sessionId } },
          },
        ]);
        if (appended.kind === 'err') {
          c.get('log').warn(`signed-out audit event failed: ${appended.error.message}`);
        }
      } catch (cause) {
        c.get('log').warn(
          `signed-out audit event failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    const cookieName = c.get('sessionCookieName');
    if (cookieName !== undefined) {
      // A browser session: the cookie goes with it.
      c.header('Set-Cookie', `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    }
    return c.json({ sessionId, revoked: outcome.revoked });
  };
}

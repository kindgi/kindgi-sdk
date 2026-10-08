// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { SessionId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  ClaimMappingScopesSpec,
  ClaimMappingSpec,
  ExchangeCodeFn,
  IdentityProviderBinding,
  ProviderConfig,
  RefreshTokenFn,
} from '../identity-provider-binding.js';
import { encodeSessionToken } from '../middleware/auth.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { Session, SessionStoreBinding } from '../session-store-binding.js';
import type { OauthStateStore } from '../state-store-binding.js';
import type { AppEnv } from '../types.js';
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
  readonly exchangeCode: ExchangeCodeFn;
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
}

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

  // ---------- GET /providers ----------
  authed.get('/providers', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const page = await identityProvider.list({ tenantId });
    return c.json({ data: page.data.map(serializeProviderConfig), hasMore: false });
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
    c.status(201);
    return c.json({ providerId: outcome.providerId });
  });

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

  // ---------- POST /login/:providerId ----------
  authed.post('/login/:providerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const providerId = c.req.param('providerId');

    const config = await identityProvider.get({ tenantId, providerId });
    if (config === null) {
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
      created = { session: fresh, rawToken: encodeSessionToken(createdSession.sessionId) };
    } else {
      // Rotate the framework token only; keep provider tokens as-is.
      const createdSession = await sessionStore.create({
        tenantId,
        userId: current.userId,
        providerId: current.providerId,
        accessToken: current.accessToken,
        ...(current.refreshToken !== undefined && { refreshToken: current.refreshToken }),
        expiresAt: current.expiresAt,
        scopes: current.scopes,
        ...(current.metadata !== undefined && { metadata: current.metadata }),
      });
      const fresh = await sessionStore.get({ tenantId, sessionId: createdSession.sessionId });
      if (fresh === null) throw new Error('session vanished immediately after create');
      created = { session: fresh, rawToken: encodeSessionToken(createdSession.sessionId) };
    }

    // OAuth 2.1 BCP: mark the old session as ROTATED (not just revoked)
    // so the middleware can return `401 refresh-token-invalid` on reuse
    // rather than the generic `401 auth-revoked`. Reuse detection lets
    // compliant clients retry with the fresh token instead of forcing
    // a full re-auth.
    await sessionStore.revoke({ tenantId, sessionId, reason: 'rotate' });

    return c.json({
      sessionToken: created.rawToken,
      sessionId: created.session.id,
      expiresAt: created.session.expiresAt,
    });
  });

  // ---------- POST /logout ----------
  authed.post('/logout', async (c) => {
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
    return c.json({ sessionId, revoked: outcome.revoked });
  });

  const callback = new Hono<AppEnv>();

  // ---------- POST /callback/:providerId (mounted outside the bearer chain) ----------
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
    if (
      currentConfig !== null &&
      currentConfig.allowedRedirectUris !== undefined &&
      currentConfig.allowedRedirectUris.length > 0 &&
      !currentConfig.allowedRedirectUris.includes(entry.redirectUri)
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

    c.status(201);
    return c.json({
      sessionToken: encodeSessionToken(created.sessionId),
      sessionId: created.sessionId,
      expiresAt: created.expiresAt,
    });
  });

  return { authed, callback };
}

// ---------- helpers ----------

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

function buildAuthorizationUrl(input: {
  readonly config: ProviderConfig;
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

function serializeProviderConfig(c: ProviderConfig): Record<string, unknown> {
  // Every field except clientSecretRef (which is a REFERENCE, not the
  // secret itself) is safe to return. Clients need enough to render an
  // "sign in with X" button and know what scopes they're granting.
  return {
    providerId: c.providerId,
    kind: c.kind,
    clientId: c.clientId,
    clientSecretRef: c.clientSecretRef,
    authorizationEndpoint: c.authorizationEndpoint,
    tokenEndpoint: c.tokenEndpoint,
    ...(c.userinfoEndpoint !== undefined && { userinfoEndpoint: c.userinfoEndpoint }),
    scopes: c.scopes,
    ...(c.allowedRedirectUris !== undefined && {
      allowedRedirectUris: c.allowedRedirectUris,
    }),
    ...(c.claimMapping !== undefined && { claimMapping: c.claimMapping }),
    ...(c.metadata !== undefined && { metadata: c.metadata }),
  };
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

function parseProviderConfig(body: unknown): ParsedOk<ProviderConfig> | ParsedErr {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', error: { code: 'bad-input', message: 'Request body must be an object' } };
  }
  const b = body as Record<string, unknown>;
  const requiredStr = (k: string): string | ParsedErr => {
    const v = b[k];
    if (typeof v !== 'string' || v.length === 0) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-provider-config',
          message: `Field \`${k}\` must be a non-empty string`,
        },
      };
    }
    return v;
  };
  const providerId = requiredStr('providerId');
  if (typeof providerId !== 'string') return providerId;
  const clientId = requiredStr('clientId');
  if (typeof clientId !== 'string') return clientId;
  const clientSecretRef = requiredStr('clientSecretRef');
  if (typeof clientSecretRef !== 'string') return clientSecretRef;
  const authorizationEndpoint = requiredStr('authorizationEndpoint');
  if (typeof authorizationEndpoint !== 'string') return authorizationEndpoint;
  const tokenEndpoint = requiredStr('tokenEndpoint');
  if (typeof tokenEndpoint !== 'string') return tokenEndpoint;

  const kindRaw = b.kind;
  if (kindRaw !== 'oauth2' && kindRaw !== 'oidc') {
    return {
      kind: 'err',
      error: {
        code: 'invalid-provider-config',
        message: '`kind` must be `oauth2` or `oidc`',
      },
    };
  }

  const scopesRaw = b.scopes;
  if (!Array.isArray(scopesRaw) || scopesRaw.some((s) => typeof s !== 'string')) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-provider-config',
        message: '`scopes` must be an array of strings',
      },
    };
  }
  const scopes = scopesRaw as string[];

  const userinfoEndpointRaw = b.userinfoEndpoint;
  if (userinfoEndpointRaw !== undefined && typeof userinfoEndpointRaw !== 'string') {
    return {
      kind: 'err',
      error: {
        code: 'invalid-provider-config',
        message: '`userinfoEndpoint` must be a string when supplied',
      },
    };
  }
  const metadataRaw = b.metadata;
  if (
    metadataRaw !== undefined &&
    (metadataRaw === null || typeof metadataRaw !== 'object' || Array.isArray(metadataRaw))
  ) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-provider-config',
        message: '`metadata` must be an object when supplied',
      },
    };
  }

  const allowedRedirectUrisRaw = b.allowedRedirectUris;
  let allowedRedirectUris: readonly string[] | undefined;
  if (allowedRedirectUrisRaw !== undefined) {
    if (
      !Array.isArray(allowedRedirectUrisRaw) ||
      allowedRedirectUrisRaw.some((s) => typeof s !== 'string' || s.length === 0)
    ) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-provider-config',
          message: '`allowedRedirectUris` must be an array of non-empty strings when supplied',
        },
      };
    }
    allowedRedirectUris = allowedRedirectUrisRaw as string[];
  }

  const claimMappingRaw = b.claimMapping;
  let claimMapping: ClaimMappingSpec | undefined;
  if (claimMappingRaw !== undefined) {
    const parsed = parseClaimMapping(claimMappingRaw);
    if (parsed.kind === 'err') return parsed;
    claimMapping = parsed.value;
  }

  return {
    kind: 'ok',
    value: {
      providerId,
      kind: kindRaw,
      clientId,
      clientSecretRef,
      authorizationEndpoint,
      tokenEndpoint,
      ...(typeof userinfoEndpointRaw === 'string' && { userinfoEndpoint: userinfoEndpointRaw }),
      scopes,
      ...(allowedRedirectUris !== undefined && { allowedRedirectUris }),
      ...(claimMapping !== undefined && { claimMapping }),
      ...(metadataRaw !== undefined && { metadata: metadataRaw as Record<string, unknown> }),
    },
  };
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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { ref } from '@kindgi/authz';
import type { SessionId, TenantId, Timestamp } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  ClaimMappingScopesSpec,
  ClaimMappingSpec,
  IdentityProviderBinding,
  ProviderConfig,
  SamlAttributeMapping,
} from '../identity-provider-binding.js';
import { encodeSessionToken } from '../middleware/auth.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import type { SessionCreateOutput, SessionStoreBinding } from '../session-store-binding.js';
import type { AppEnv } from '../types.js';
import { hasCapability, refused } from './denied.js';
import { tenantResourceAccess } from './tenant-access.js';

/**
 * Auth routes, on top of the static bearer-token infrastructure: the
 * workspace's identity-provider catalog (`IdentityProviderBinding`) and
 * the session lifecycle (`SessionStoreBinding`: refresh, logout). Sign-in
 * itself runs in the deployment (its browser flow), which reads the
 * catalog. Every route runs inside the `/v1/*` auth chain, with a bearer
 * or session token.
 */
export interface AuthRouterOptions {
  readonly sessionStore: SessionStoreBinding;
  readonly identityProvider: IdentityProviderBinding;
  /**
   * With one (T243 A): the provider catalog is tenant-wide, so reading it
   * needs `read` on the tenant and changing it `admin`, as for every
   * tenant-wide resource (`tenantResourceAccess`). Refreshing and logging
   * out are the caller's own, and stay unchecked.
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

/**
 * Build the auth router, mounted inside the `/v1/*` bearer chain:
 * provider catalog CRUD, refresh, logout.
 *
 * `whoami` lives at `/v1/identity/whoami` and is unconditionally
 * mounted from `identityRouter`.
 */
export function authRouter(options: AuthRouterOptions): Hono<AppEnv> {
  const { sessionStore, identityProvider } = options;

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
      // Recorded with the authorizer, as every refusal the API decides
      // itself is, under its own code.
      return refused(c, options.authorizer, {
        action: 'admin',
        resource: ref('tenant', c.get('tenantId') as unknown as string),
        message: OPERATOR_MANAGED_MESSAGE,
        failing: 'scope',
        code: 'identity-providers-operator-managed',
      });
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
      if (asked !== undefined && asked !== 'oidc' && asked !== 'saml') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`kind` must be `oidc` or `saml`' }, requestId),
        );
      }
      const registered = await identityProvider.get({ tenantId, providerId });
      // A provider stored before as a kind sign-in no longer uses (a plain
      // OAuth 2.0 one, `oauth2`) gets the same answer as a kind this
      // deployment doesn't sign in with, whatever its binding would say.
      const stored = registered?.kind as string | undefined;
      const notSignedInWith = (k: string) => {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `This deployment doesn't sign in with \`${k}\` providers`,
            },
            requestId,
          ),
        );
      };
      if (asked === undefined && stored !== undefined && stored !== 'oidc' && stored !== 'saml') {
        return notSignedInWith(stored);
      }
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
      if (signIn === undefined) return notSignedInWith(kind);
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

    // A new session in place of this one: same person, provider, scopes,
    // expiry and metadata. Refresh never calls the provider.
    const createdSession = await sessionStore.create({
      tenantId,
      userId: current.userId,
      providerId: current.providerId,
      expiresAt: current.expiresAt,
      scopes: current.scopes,
      ...(current.metadata !== undefined && { metadata: current.metadata }),
    });
    const fresh = await sessionStore.get({ tenantId, sessionId: createdSession.sessionId });
    if (fresh === null) throw new Error('session vanished immediately after create');
    const created = { session: fresh, rawToken: sessionTokenOf(createdSession) };

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

  return authed;
}

// ---------- helpers ----------

/** The token a store minted, or the older `kgi_sk_<sessionId>` for a store that mints none. */
function sessionTokenOf(created: SessionCreateOutput): string {
  return created.token ?? encodeSessionToken(created.sessionId);
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
    default:
      // A kind this package no longer serves, stored before (a plain OAuth
      // 2.0 provider): it still lists, with its common fields.
      return base;
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
  readonly error: { readonly code: string; readonly message: string; readonly providerId?: string };
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

/**
 * Fields a provider no longer takes, and why. A provider stored with one
 * still loads and signs people in; the field is left out of what it reads.
 */
const REMOVED_FIELDS: Readonly<Record<string, string>> = {
  allowedRedirectUris:
    'sign-in runs in the deployment, at its own callback URL, so nothing would enforce it',
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
  for (const [field, why] of Object.entries(REMOVED_FIELDS)) {
    if (b[field] !== undefined) return invalid(`\`${field}\` is no longer accepted: ${why}`);
  }
  const kind = b.kind;
  if (kind === 'oauth2') {
    // Refused as a deployment refused it before this package dropped the
    // kind: 422, so the answer a client knows stays the same.
    return {
      kind: 'err',
      error: {
        code: 'identity-provider-invalid',
        message:
          'Sign-in uses OIDC or SAML identity providers; a plain OAuth 2.0 provider (`oauth2`) is not one of them',
        ...(typeof b.providerId === 'string' && { providerId: b.providerId }),
      },
    };
  }
  if (kind !== 'oidc' && kind !== 'saml') {
    return invalid('`kind` must be `oidc` or `saml`');
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
  if (kind === 'oidc') {
    const issuer = r.url('issuer', true) ?? '';
    const clientId = r.str('clientId');
    const clientSecretRef = r.str('clientSecretRef');
    const scopes = r.strings('scopes', false);
    const authorizationEndpoint = r.url('authorizationEndpoint', false);
    const tokenEndpoint = r.url('tokenEndpoint', false);
    const userinfoEndpoint = r.url('userinfoEndpoint', false);
    const jwksEndpoint = r.url('jwksEndpoint', false);
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
      const secure = c.get('sessionCookieSecure') === false ? '' : ' Secure;';
      c.header('Set-Cookie', `${cookieName}=; Path=/; Max-Age=0; HttpOnly;${secure} SameSite=Lax`);
    }
    return c.json({ sessionId, revoked: outcome.revoked });
  };
}

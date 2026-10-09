// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  IdentityProviderRegisterOutcome,
  ProviderConfig,
  RunHandlerBinding,
  SessionStoreBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * `/v1/auth/providers` with one shape per `kind`: `oidc` (issuer +
 * discovery), `saml` (metadata, or entity ID + SSO URL + certificates) and
 * `oauth2` (endpoints given). Secrets only by reference.
 */

const tenantId = randomUUID() as TenantId;
const BEARER = 'providers-kinds-bearer';
const resolveToken: TokenResolver = async (t) => (t === BEARER ? { tenantId, scopes: [] } : null);

const noSessions: SessionStoreBinding = {
  create: async () => {
    throw new Error('not used');
  },
  get: async () => null,
  list: async () => ({ data: [] }),
  revoke: async () => ({ revoked: false }),
  revokeAllForUser: async () => ({ revokedCount: 0 }),
};

function makeApp(
  onRegister: (config: ProviderConfig) => IdentityProviderRegisterOutcome = (config) => ({
    kind: 'ok',
    providerId: config.providerId,
  }),
) {
  const stored = new Map<string, ProviderConfig>();
  const identityProvider: IdentityProviderBinding = {
    list: async () => ({ data: [...stored.values()] }),
    get: async ({ providerId }) => stored.get(providerId) ?? null,
    register: async ({ config }) => {
      const outcome = onRegister(config);
      if (outcome.kind === 'ok') stored.set(config.providerId, outcome.provider ?? config);
      return outcome;
    },
    unregister: async ({ providerId }) => ({ unregistered: stored.delete(providerId) }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    sessionStore: noSessions,
    identityProvider,
    exchangeCode: async () => {
      throw new Error('not used');
    },
  });
  return { app, stored };
}

const register = (app: ReturnType<typeof makeApp>['app'], body: unknown) =>
  app.request('/v1/auth/providers', {
    method: 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

const OIDC = {
  providerId: 'acme-okta',
  kind: 'oidc',
  displayName: 'Acme Okta',
  issuer: 'https://acme.okta.example',
  clientId: 'client-1',
  clientSecretRef: 'ACME_OKTA_SECRET',
  domains: ['Acme.com'],
};

const SAML_METADATA = {
  providerId: 'acme-entra',
  kind: 'saml',
  idpMetadataXml: '<EntityDescriptor entityID="https://sts.example/acme"/>',
  spSigningKeyRef: 'ACME_SP_KEY',
};

describe('registering each kind', () => {
  test('oidc: issuer + client, domains lowercased, returned as stored', async () => {
    const { app, stored } = makeApp();
    const res = await register(app, OIDC);
    expect(res.status).toBe(201);
    const config = stored.get('acme-okta');
    expect(config?.kind).toBe('oidc');
    expect(config?.domains).toEqual(['acme.com']);
    const list = await app.request('/v1/auth/providers', {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    const body = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      providerId: 'acme-okta',
      kind: 'oidc',
      issuer: 'https://acme.okta.example',
      clientSecretRef: 'ACME_OKTA_SECRET',
      displayName: 'Acme Okta',
    });
  });

  test('saml: metadata XML, or entity ID + SSO URL + certificates', async () => {
    const { app } = makeApp();
    expect((await register(app, SAML_METADATA)).status).toBe(201);
    const byParts = await register(app, {
      providerId: 'acme-adfs',
      kind: 'saml',
      idpEntityId: 'https://adfs.example/adfs/services/trust',
      idpSsoUrl: 'https://adfs.example/adfs/ls/',
      idpCertificates: ['-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'],
      wantAssertionsSigned: true,
      attributeMapping: { email: 'mail' },
    });
    expect(byParts.status).toBe(201);
  });

  test('oauth2: a plain OAuth 2.0 provider keeps its shape', async () => {
    const { app } = makeApp();
    const res = await register(app, {
      providerId: 'github',
      kind: 'oauth2',
      clientId: 'gh-client',
      clientSecretRef: 'GITHUB_SECRET',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      scopes: ['read:user'],
    });
    expect(res.status).toBe(201);
  });

  test('the stored provider comes back with signIn when the deployment returns it', async () => {
    const { app } = makeApp((config) => ({
      kind: 'ok',
      providerId: config.providerId,
      provider: {
        ...(config as ProviderConfig & { kind: 'saml' }),
        signIn: {
          spEntityId: 'https://kindgi.example.com/sp/x',
          acsUrl: 'https://kindgi.example.com/auth/sso/saml2/sp/acs/x',
          spMetadataUrl: 'https://kindgi.example.com/auth/sso/saml2/sp/metadata?providerId=x',
        },
      },
    }));
    const res = await register(app, SAML_METADATA);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { providerId: string; provider?: { signIn?: unknown } };
    expect(body.provider?.signIn).toMatchObject({
      acsUrl: 'https://kindgi.example.com/auth/sso/saml2/sp/acs/x',
    });
  });
});

describe('refusals', () => {
  test.each([
    [
      'a plaintext clientSecret',
      { ...OIDC, clientSecret: 's3cret' },
      '`clientSecret` is never accepted',
    ],
    [
      'a raw SAML key',
      { ...SAML_METADATA, privateKey: '-----BEGIN PRIVATE KEY-----' },
      '`privateKey` is never accepted',
    ],
    ['oidc without issuer', { ...OIDC, issuer: undefined }, '`issuer`'],
    ['oidc with an issuer that is no URL', { ...OIDC, issuer: 'acme' }, 'absolute URL'],
    ['saml with no IdP details', { providerId: 'x', kind: 'saml' }, 'needs `idpMetadataXml`'],
    ['an unknown kind', { ...OIDC, kind: 'ldap' }, '`kind` must be'],
    [
      'join: domain without domains',
      { ...OIDC, domains: undefined, join: 'domain' },
      'needs `domains`',
    ],
    ['a domain that is no domain', { ...OIDC, domains: ['not a domain'] }, 'email domains'],
  ])('%s → 400 invalid-provider-config', async (_name, body, message) => {
    const { app } = makeApp();
    const res = await register(app, body);
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('invalid-provider-config');
    expect(error.message).toContain(message);
  });

  test('a configuration the deployment cannot use → 422 identity-provider-invalid', async () => {
    const { app, stored } = makeApp(() => ({
      kind: 'invalid',
      message: 'The issuer https://acme.okta.example has no discovery document',
    }));
    const res = await register(app, OIDC);
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe('identity-provider-invalid');
    expect(error.message).toBe('The issuer https://acme.okta.example has no discovery document');
    expect(stored.size).toBe(0);
  });
});

describe("this API's own OAuth flow (login) per kind", () => {
  const login = (app: ReturnType<typeof makeApp>['app'], providerId: string) =>
    app.request(`/v1/auth/login/${providerId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUri: 'https://app.example/cb' }),
    });

  test('a SAML provider signs in through the deployment, not here', async () => {
    const { app } = makeApp();
    await register(app, SAML_METADATA);
    const res = await login(app, 'acme-entra');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain("signs in through the deployment's own sign-in");
  });

  test('an OIDC provider with its endpoints uses them, with the default OIDC scopes', async () => {
    const { app } = makeApp();
    await register(app, {
      ...OIDC,
      authorizationEndpoint: 'https://acme.okta.example/oauth2/v1/authorize',
      tokenEndpoint: 'https://acme.okta.example/oauth2/v1/token',
    });
    const res = await login(app, 'acme-okta');
    expect(res.status).toBe(200);
    const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://acme.okta.example/oauth2/v1/authorize');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  test('an OIDC provider without endpoints signs in through the deployment', async () => {
    const { app } = makeApp();
    await register(app, OIDC);
    expect((await login(app, 'acme-okta')).status).toBe(400);
  });
});

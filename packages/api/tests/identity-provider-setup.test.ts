// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  IdentityProviderUpdateOutcome,
  ProviderConfig,
  ProviderSignIn,
  RunHandlerBinding,
  SessionStoreBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Setting a provider up the way an admin does it: the identity provider's
 * side first (`GET /v1/auth/providers/:providerId/sign-in`, before anything
 * is registered), then registering what it gave back, then changing it
 * (`PATCH`) without its sign-in URLs moving.
 */

const tenantId = randomUUID() as TenantId;
const BEARER = 'providers-setup-bearer';
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

/** The deployment's URLs: from the provider id alone, as the runtime's are. */
function urlsOf(providerId: string, kind: string): ProviderSignIn | undefined {
  if (kind === 'oidc') return { redirectUri: `https://kindgi.acme.example/cb/${providerId}` };
  if (kind === 'saml') {
    return {
      spEntityId: `https://kindgi.acme.example/sp/${providerId}`,
      acsUrl: `https://kindgi.acme.example/acs/${providerId}`,
      spMetadataUrl: `https://kindgi.acme.example/sp/${providerId}`,
    };
  }
  return undefined;
}

function makeApp(
  options: {
    readonly withSignInUrls?: boolean;
    readonly withUpdate?: boolean;
    readonly onUpdate?: (config: ProviderConfig) => IdentityProviderUpdateOutcome;
  } = {},
) {
  const stored = new Map<string, ProviderConfig>();
  const updates: ProviderConfig[] = [];
  const identityProvider: IdentityProviderBinding = {
    list: async () => ({ data: [...stored.values()] }),
    get: async ({ providerId }) => stored.get(providerId) ?? null,
    register: async ({ config }) => {
      const provider = {
        ...config,
        signIn: urlsOf(config.providerId, config.kind),
      } as ProviderConfig;
      stored.set(config.providerId, provider);
      return { kind: 'ok', providerId: config.providerId, provider };
    },
    unregister: async ({ providerId }) => ({ unregistered: stored.delete(providerId) }),
    ...(options.withSignInUrls !== false && {
      signInUrls: async ({ providerId, kind }) => urlsOf(providerId, kind),
    }),
    ...(options.withUpdate !== false && {
      update: async ({ config }) => {
        updates.push(config);
        const outcome = options.onUpdate?.(config);
        if (outcome !== undefined) return outcome;
        if (!stored.has(config.providerId)) return { kind: 'not-found' };
        const provider = {
          ...config,
          signIn: urlsOf(config.providerId, config.kind),
        } as ProviderConfig;
        stored.set(config.providerId, provider);
        return { kind: 'ok', provider };
      },
    }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    sessionStore: noSessions,
    identityProvider,
  });
  return { app, stored, updates };
}

type App = ReturnType<typeof makeApp>['app'];
const headers = { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' };
const get = (app: App, path: string) => app.request(path, { headers });
const register = (app: App, body: unknown) =>
  app.request('/v1/auth/providers', { method: 'POST', headers, body: JSON.stringify(body) });
const patch = (app: App, providerId: string, body: unknown) =>
  app.request(`/v1/auth/providers/${providerId}`, {
    method: 'PATCH',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

const OKTA = {
  providerId: 'acme-okta',
  kind: 'oidc',
  displayName: 'Acme Okta',
  issuer: 'https://acme.okta.example',
  clientId: 'client-1',
  clientSecretRef: 'ACME_OKTA_SECRET',
  domains: ['acme.com'],
  tokenEndpoint: 'https://acme.okta.example/oauth2/v1/token',
  jwksEndpoint: 'https://acme.okta.example/oauth2/v1/keys',
};

describe('GET /v1/auth/providers/:providerId/sign-in', () => {
  test("before registering: the URLs a provider under that id will have, for IT's side", async () => {
    const { app } = makeApp();
    const res = await get(app, '/v1/auth/providers/acme-okta/sign-in?kind=oidc');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      providerId: 'acme-okta',
      kind: 'oidc',
      signIn: { redirectUri: 'https://kindgi.acme.example/cb/acme-okta' },
      registered: false,
    });
  });

  test('the same URLs after registering, with the kind taken from the provider', async () => {
    const { app } = makeApp();
    const before = (await (
      await get(app, '/v1/auth/providers/acme-okta/sign-in?kind=oidc')
    ).json()) as {
      signIn: unknown;
    };
    expect((await register(app, OKTA)).status).toBe(201);
    const after = await get(app, '/v1/auth/providers/acme-okta/sign-in');
    expect(after.status).toBe(200);
    const body = (await after.json()) as { signIn: unknown; registered: boolean; kind: string };
    expect(body).toMatchObject({ kind: 'oidc', registered: true });
    expect(body.signIn).toEqual(before.signIn);
  });

  test('SAML: the entity ID, ACS URL and metadata URL', async () => {
    const { app } = makeApp();
    const res = await get(app, '/v1/auth/providers/acme-saml/sign-in?kind=saml');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signIn: unknown }).signIn).toEqual({
      spEntityId: 'https://kindgi.acme.example/sp/acme-saml',
      acsUrl: 'https://kindgi.acme.example/acs/acme-saml',
      spMetadataUrl: 'https://kindgi.acme.example/sp/acme-saml',
    });
  });

  test('a provider not registered yet needs `kind`; a bad kind is refused', async () => {
    const { app } = makeApp();
    const noKind = await get(app, '/v1/auth/providers/acme-okta/sign-in');
    expect(noKind.status).toBe(400);
    expect((await errorOf(noKind)).message).toContain('`kind`');
    const bad = await get(app, '/v1/auth/providers/acme-okta/sign-in?kind=ldap');
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe('bad-input');
  });

  test("a kind the deployment doesn't sign in with: 400, says so", async () => {
    const { app } = makeApp();
    const res = await get(app, '/v1/auth/providers/acme-gh/sign-in?kind=oauth2');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain("doesn't sign in with `oauth2`");
  });

  test("not mounted when the deployment can't say", async () => {
    const { app } = makeApp({ withSignInUrls: false });
    const res = await get(app, '/v1/auth/providers/acme-okta/sign-in?kind=oidc');
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/auth/providers/:providerId', () => {
  test('the provider as stored, with signIn; unknown → 404', async () => {
    const { app } = makeApp();
    await register(app, OKTA);
    const res = await get(app, '/v1/auth/providers/acme-okta');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      providerId: 'acme-okta',
      kind: 'oidc',
      clientSecretRef: 'ACME_OKTA_SECRET',
      signIn: { redirectUri: 'https://kindgi.acme.example/cb/acme-okta' },
    });
    const missing = await get(app, '/v1/auth/providers/nobody');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('identity-provider-not-found');
  });
});

describe('PATCH /v1/auth/providers/:providerId', () => {
  test('merges the changes; everything else stays; the sign-in URLs stay', async () => {
    const { app, updates } = makeApp();
    await register(app, OKTA);
    const res = await patch(app, 'acme-okta', {
      domains: ['acme.com', 'acme.co.uk'],
      clientId: 'client-2',
      signIn: { redirectUri: 'https://evil.example/cb' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providerId: string; provider: Record<string, unknown> };
    expect(body.providerId).toBe('acme-okta');
    expect(body.provider).toMatchObject({
      displayName: 'Acme Okta',
      issuer: OKTA.issuer,
      clientId: 'client-2',
      clientSecretRef: 'ACME_OKTA_SECRET',
      domains: ['acme.com', 'acme.co.uk'],
      tokenEndpoint: OKTA.tokenEndpoint,
      signIn: { redirectUri: 'https://kindgi.acme.example/cb/acme-okta' },
    });
    // The binding gets the whole configuration, never the caller's signIn.
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('signIn');
    expect(updates[0]).toMatchObject({
      providerId: 'acme-okta',
      kind: 'oidc',
      clientId: 'client-2',
    });
  });

  test('`null` removes an optional field', async () => {
    const { app } = makeApp();
    await register(app, OKTA);
    const res = await patch(app, 'acme-okta', { displayName: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { provider: object }).provider).not.toHaveProperty('displayName');
  });

  test('a new issuer drops the endpoints discovered from the old one; the same issuer keeps them', async () => {
    const { app, updates } = makeApp();
    await register(app, OKTA);
    await patch(app, 'acme-okta', { issuer: OKTA.issuer, clientId: 'client-2' });
    expect(updates[0]).toMatchObject({ tokenEndpoint: OKTA.tokenEndpoint });
    await patch(app, 'acme-okta', { issuer: 'https://acme-new.okta.example' });
    expect(updates[1]).toMatchObject({ issuer: 'https://acme-new.okta.example' });
    expect(updates[1]).not.toHaveProperty('tokenEndpoint');
    expect(updates[1]).not.toHaveProperty('jwksEndpoint');
  });

  test("`providerId` and `kind` can't change", async () => {
    const { app, updates } = makeApp();
    await register(app, OKTA);
    const kind = await patch(app, 'acme-okta', { kind: 'saml' });
    expect(kind.status).toBe(400);
    const kindError = await errorOf(kind);
    expect(kindError.code).toBe('invalid-provider-config');
    expect(kindError.message).toContain("`kind` can't change");
    expect(
      (await errorOf(await patch(app, 'acme-okta', { providerId: 'other' }))).message,
    ).toContain("`providerId` can't change");
    // Restating them unchanged is fine.
    expect((await patch(app, 'acme-okta', { providerId: 'acme-okta', kind: 'oidc' })).status).toBe(
      200,
    );
    expect(updates).toHaveLength(1);
  });

  test('the result must still be a whole provider; a plaintext secret is refused', async () => {
    const { app, updates } = makeApp();
    await register(app, OKTA);
    const noClient = await patch(app, 'acme-okta', { clientId: null });
    expect(noClient.status).toBe(400);
    expect((await errorOf(noClient)).message).toContain('`clientId`');
    const secret = await patch(app, 'acme-okta', { clientSecret: 'shh' });
    expect(secret.status).toBe(400);
    expect((await errorOf(secret)).message).toContain('`clientSecret` is never accepted');
    expect(updates).toHaveLength(0);
  });

  test("the deployment can't use it: 422 identity-provider-invalid, with its message", async () => {
    const { app } = makeApp({
      onUpdate: () => ({ kind: 'invalid', message: 'No secret named ACME_OKTA_SECRET_2' }),
    });
    await register(app, OKTA);
    const res = await patch(app, 'acme-okta', { clientSecretRef: 'ACME_OKTA_SECRET_2' });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'identity-provider-invalid',
      message: 'No secret named ACME_OKTA_SECRET_2',
    });
  });

  test('unknown provider → 404; unregistered meanwhile → 404', async () => {
    const { app } = makeApp({ onUpdate: () => ({ kind: 'not-found' }) });
    expect((await patch(app, 'nobody', { displayName: 'X' })).status).toBe(404);
    await register(app, OKTA);
    const raced = await patch(app, 'acme-okta', { displayName: 'X' });
    expect(raced.status).toBe(404);
    expect((await errorOf(raced)).code).toBe('identity-provider-not-found');
  });

  test('the body must be a JSON object', async () => {
    const { app } = makeApp();
    await register(app, OKTA);
    expect((await patch(app, 'acme-okta', '[1]')).status).toBe(400);
    expect((await patch(app, 'acme-okta', 'not json')).status).toBe(400);
  });

  test("not mounted when the deployment can't update providers", async () => {
    const { app } = makeApp({ withUpdate: false });
    await register(app, OKTA);
    expect((await patch(app, 'acme-okta', { displayName: 'X' })).status).toBe(404);
  });
});

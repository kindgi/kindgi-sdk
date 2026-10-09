// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * When the operator manages sign-in (`identityProviderChanges: 'operator'`,
 * the runtime's `KINDGI_AUTH_TENANT_PROVIDERS=off`), a tenant can't add,
 * change or remove its identity providers: only the deployment's own token
 * (`kindgi:system`) can. Reading them, and signing in with the ones there,
 * are the same as ever. The list says which it is (`changes`).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  ProviderConfig,
  ProviderSignIn,
  RunHandlerBinding,
  SessionStoreBinding,
  TokenResolver,
} from '../src/index.js';
import { OPERATOR_MANAGED_MESSAGE } from '../src/routes/auth.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
/** A tenant admin's key. */
const ADMIN = 'operator-managed-admin';
/** The deployment's own token: the runtime resolves it with `kindgi:system`. */
const DEPLOYMENT = 'operator-managed-deployment';
const resolveToken: TokenResolver = async (t) =>
  t === ADMIN
    ? { tenantId, scopes: ['tenant-admin'], capabilities: [] }
    : t === DEPLOYMENT
      ? { tenantId, scopes: ['tenant-admin'], capabilities: ['kindgi:system'] }
      : null;

const noSessions: SessionStoreBinding = {
  create: async () => {
    throw new Error('not used');
  },
  get: async () => null,
  list: async () => ({ data: [] }),
  revoke: async () => ({ revoked: false }),
  revokeAllForUser: async () => ({ revokedCount: 0 }),
};

const urlsOf = (providerId: string): ProviderSignIn => ({
  redirectUri: `https://kindgi.acme.example/cb/${providerId}`,
});

const OKTA = {
  providerId: 'acme-okta',
  kind: 'oidc',
  displayName: 'Acme Okta',
  issuer: 'https://acme.okta.example',
  clientId: 'client-1',
  clientSecretRef: 'ACME_OKTA_SECRET',
  domains: ['acme.com'],
} as const;

function makeApp(changes?: 'tenant' | 'operator') {
  const stored = new Map<string, ProviderConfig>([
    [OKTA.providerId, { ...OKTA, signIn: urlsOf(OKTA.providerId) } as ProviderConfig],
  ]);
  const identityProvider: IdentityProviderBinding = {
    list: async () => ({ data: [...stored.values()] }),
    get: async ({ providerId }) => stored.get(providerId) ?? null,
    register: async ({ config }) => {
      const provider = { ...config, signIn: urlsOf(config.providerId) } as ProviderConfig;
      stored.set(config.providerId, provider);
      return { kind: 'ok', providerId: config.providerId, provider };
    },
    unregister: async ({ providerId }) => ({ unregistered: stored.delete(providerId) }),
    signInUrls: async ({ providerId }) => urlsOf(providerId),
    update: async ({ config }) => {
      if (!stored.has(config.providerId)) return { kind: 'not-found' };
      const provider = { ...config, signIn: urlsOf(config.providerId) } as ProviderConfig;
      stored.set(config.providerId, provider);
      return { kind: 'ok', provider };
    },
    signInOptions: async ({ emailDomain }) =>
      emailDomain === 'acme.com'
        ? [...stored.values()].map((p) => ({
            providerId: p.providerId,
            displayName: p.displayName ?? p.providerId,
            signInUrl: `/auth/start/${p.providerId}`,
          }))
        : [],
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    sessionStore: noSessions,
    identityProvider,
    ...(changes !== undefined && { identityProviderChanges: changes }),
  });
  return { app, stored };
}

type App = ReturnType<typeof makeApp>['app'];
const call = (app: App, as: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const NEW = {
  providerId: 'acme-entra',
  kind: 'oidc',
  issuer: 'https://login.microsoftonline.example/t-1/v2.0',
  clientId: 'client-2',
  clientSecretRef: 'ACME_ENTRA_SECRET',
  domains: ['acme.com'],
};

describe('who may change identity providers', () => {
  test("by default the tenant's admins: the list says `tenant`, and an admin registers one", async () => {
    const { app, stored } = makeApp();
    const list = await call(app, ADMIN, 'GET', '/v1/auth/providers');
    expect(((await list.json()) as { changes: string }).changes).toBe('tenant');
    expect((await call(app, ADMIN, 'POST', '/v1/auth/providers', NEW)).status).toBe(201);
    expect(stored.has('acme-entra')).toBe(true);
  });

  test('operator-managed: a tenant admin adds, changes and removes nothing, and hears why', async () => {
    const { app, stored } = makeApp('operator');
    const before = JSON.stringify([...stored.entries()]);
    const refused = [
      await call(app, ADMIN, 'POST', '/v1/auth/providers', NEW),
      await call(app, ADMIN, 'PATCH', '/v1/auth/providers/acme-okta', { domains: ['acme.org'] }),
      await call(app, ADMIN, 'POST', '/v1/auth/providers/acme-okta/unregister', {}),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      const { error } = (await res.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe('identity-providers-operator-managed');
      expect(error.message).toBe(OPERATOR_MANAGED_MESSAGE);
      expect(error.message).toContain('KINDGI_AUTH_TENANT_PROVIDERS=off');
      expect(error.message).toContain('KINDGI_API_TOKEN');
    }
    expect(JSON.stringify([...stored.entries()])).toBe(before);
  });

  test('operator-managed: reading them is the same, and the list says `operator`', async () => {
    const { app } = makeApp('operator');
    const list = await call(app, ADMIN, 'GET', '/v1/auth/providers');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      changes: 'operator',
      data: [{ providerId: 'acme-okta' }],
    });
    expect((await call(app, ADMIN, 'GET', '/v1/auth/providers/acme-okta')).status).toBe(200);
    const urls = await call(app, ADMIN, 'GET', '/v1/auth/providers/acme-entra/sign-in?kind=oidc');
    expect(urls.status).toBe(200);
  });

  test('operator-managed: the providers there still sign people in', async () => {
    const { app } = makeApp('operator');
    const options = await app.request('/v1/auth/sign-in-options?email=ann@acme.com');
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({ data: [{ providerId: 'acme-okta' }] });
  });

  test("operator-managed: the deployment's own token adds, changes and removes them", async () => {
    const { app, stored } = makeApp('operator');
    expect((await call(app, DEPLOYMENT, 'POST', '/v1/auth/providers', NEW)).status).toBe(201);
    const changed = await call(app, DEPLOYMENT, 'PATCH', '/v1/auth/providers/acme-entra', {
      displayName: 'Acme Entra',
    });
    expect(changed.status).toBe(200);
    expect(stored.get('acme-entra')?.displayName).toBe('Acme Entra');
    const removed = await call(
      app,
      DEPLOYMENT,
      'POST',
      '/v1/auth/providers/acme-okta/unregister',
      {},
    );
    expect(removed.status).toBe(200);
    expect(stored.has('acme-okta')).toBe(false);
  });
});

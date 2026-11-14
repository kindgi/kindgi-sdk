// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An identity provider's secret references are checked as every other
 * registration's are: a reference never names a model provider's key, nor a
 * name under the reserved `kindgi.` prefix. `POST /v1/auth/providers` and
 * `PATCH /v1/auth/providers/:providerId` answer 400 with the shared codes
 * and words, and nothing is registered or changed.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  ProviderConfig,
  RunHandlerBinding,
  SessionStoreBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const BEARER = 'idp-secret-refs-bearer';
const resolveToken: TokenResolver = async (t) =>
  t === BEARER ? { tenantId, scopes: ['tenant-admin'] } : null;

const noSessions: SessionStoreBinding = {
  create: async () => {
    throw new Error('not used');
  },
  get: async () => null,
  list: async () => ({ data: [] }),
  revoke: async () => ({ revoked: false }),
  revokeAllForUser: async () => ({ revokedCount: 0 }),
};

const MODEL_KEY = 'ANTHROPIC_API_KEY';
const REFUSED = `\`${MODEL_KEY}\` is the key of model provider "anthropic-main": an identity provider never gets a model provider's key. Store the identity provider's own secret under its own name and use that name`;
const HELD = 'kindgi.connection-token';
const RESERVED = `\`${HELD}\` uses the reserved "kindgi." prefix: an identity provider never names one. Those names are Kindgi's own; store the secret under a name of its own and use that`;

const OKTA = {
  providerId: 'acme-okta',
  kind: 'oidc',
  displayName: 'Acme Okta',
  issuer: 'https://acme.okta.example',
  clientId: 'client-1',
  clientSecretRef: 'ACME_OKTA_SECRET',
  domains: ['acme.com'],
};

const ADFS = {
  providerId: 'acme-adfs',
  kind: 'saml',
  displayName: 'Acme ADFS',
  idpEntityId: 'https://adfs.acme.example/adfs/services/trust',
  idpSsoUrl: 'https://adfs.acme.example/adfs/ls',
  idpCertificates: ['-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'],
  spSigningKeyRef: 'ACME_SP_SIGNING_KEY',
  domains: ['acme.com'],
};

function makeApp() {
  const stored = new Map<string, ProviderConfig>();
  const registered: ProviderConfig[] = [];
  const updated: ProviderConfig[] = [];
  const identityProvider: IdentityProviderBinding = {
    list: async () => ({ data: [...stored.values()] }),
    get: async ({ providerId }) => stored.get(providerId) ?? null,
    register: async ({ config }) => {
      registered.push(config);
      stored.set(config.providerId, config);
      return { kind: 'ok', providerId: config.providerId, provider: config };
    },
    unregister: async ({ providerId }) => ({ unregistered: stored.delete(providerId) }),
    update: async ({ config }) => {
      updated.push(config);
      stored.set(config.providerId, config);
      return { kind: 'ok', provider: config };
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    sessionStore: noSessions,
    identityProvider,
    providerRegistry: {
      resolveForRuntime: async () => [
        {
          metadata: { id: 'anthropic-main' },
          adapterId: '@kindgi/adapter-model-anthropic',
          secretRef: { envName: 'local', name: MODEL_KEY },
        },
      ],
      register: async () => {
        throw new Error('not used');
      },
      list: async () => ({ data: [] }),
      get: async () => null,
    } as never,
  });
  return { app, stored, registered, updated };
}

type App = ReturnType<typeof makeApp>['app'];
const headers = { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' };
const register = (app: App, body: unknown) =>
  app.request('/v1/auth/providers', { method: 'POST', headers, body: JSON.stringify(body) });
const patch = (app: App, providerId: string, body: unknown) =>
  app.request(`/v1/auth/providers/${providerId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
const answerOf = async (res: Response) => [
  res.status,
  ((await res.json()) as { error?: unknown }).error,
];

describe('POST /v1/auth/providers', () => {
  test("an OIDC client secret that's a model provider's key: 400, naming it, and nothing is registered", async () => {
    const h = makeApp();
    for (const clientSecretRef of [MODEL_KEY, `production/${MODEL_KEY}`, ` ${MODEL_KEY} `]) {
      const res = await register(h.app, { ...OKTA, clientSecretRef });
      expect(await answerOf(res)).toEqual([
        400,
        expect.objectContaining({
          code: 'provider-key-refused',
          message: REFUSED,
          details: { secret: MODEL_KEY, providerId: 'anthropic-main' },
        }),
      ]);
    }
    expect(h.registered).toEqual([]);
  });

  test('a SAML key under the reserved `kindgi.` prefix: 400, naming it, and nothing is registered', async () => {
    const h = makeApp();
    for (const body of [
      { ...ADFS, spSigningKeyRef: HELD },
      { ...ADFS, spDecryptionKeyRef: `local/${HELD}` },
    ]) {
      const res = await register(h.app, body);
      expect(await answerOf(res)).toEqual([
        400,
        expect.objectContaining({
          code: 'reserved-name-prefix',
          message: RESERVED,
          details: { secret: HELD },
        }),
      ]);
    }
    expect(h.registered).toEqual([]);
  });

  test('secrets of their own: registered as before', async () => {
    const h = makeApp();
    const oidc = await register(h.app, { ...OKTA, clientSecretRef: 'production/ACME_OKTA_SECRET' });
    expect(oidc.status).toBe(201);
    const saml = await register(h.app, { ...ADFS, spDecryptionKeyRef: 'ACME_SP_DECRYPTION_KEY' });
    expect(saml.status).toBe(201);
    expect(h.registered.map((p) => p.providerId)).toEqual(['acme-okta', 'acme-adfs']);
  });
});

describe('PATCH /v1/auth/providers/:providerId', () => {
  test("a new client secret that's a model provider's key: 400, and the provider is unchanged", async () => {
    const h = makeApp();
    expect((await register(h.app, OKTA)).status).toBe(201);
    const res = await patch(h.app, 'acme-okta', { clientSecretRef: MODEL_KEY });
    expect(await answerOf(res)).toEqual([
      400,
      expect.objectContaining({ code: 'provider-key-refused', message: REFUSED }),
    ]);
    expect(h.updated).toEqual([]);
    expect(h.stored.get('acme-okta')).toEqual(
      expect.objectContaining({ clientSecretRef: 'ACME_OKTA_SECRET' }),
    );
  });

  test('a provider that already names one is refused on any change, until it names its own', async () => {
    const h = makeApp();
    // Written before the check, as a provider registered on an earlier version may be.
    h.stored.set('acme-okta', { ...OKTA, clientSecretRef: MODEL_KEY } as ProviderConfig);
    const renamed = await patch(h.app, 'acme-okta', { displayName: 'Acme sign-in' });
    expect(await answerOf(renamed)).toEqual([
      400,
      expect.objectContaining({ code: 'provider-key-refused', message: REFUSED }),
    ]);
    expect(h.updated).toEqual([]);

    const repointed = await patch(h.app, 'acme-okta', { clientSecretRef: 'ACME_OKTA_SECRET' });
    expect(repointed.status).toBe(200);
    expect(h.updated.map((p) => (p.kind === 'oidc' ? p.clientSecretRef : undefined))).toEqual([
      'ACME_OKTA_SECRET',
    ]);
  });

  test('a SAML key moved under the reserved prefix: 400 `reserved-name-prefix`', async () => {
    const h = makeApp();
    expect((await register(h.app, ADFS)).status).toBe(201);
    const res = await patch(h.app, 'acme-adfs', { spDecryptionKeyRef: HELD });
    expect(await answerOf(res)).toEqual([
      400,
      expect.objectContaining({ code: 'reserved-name-prefix', message: RESERVED }),
    ]);
    expect(h.updated).toEqual([]);
  });
});

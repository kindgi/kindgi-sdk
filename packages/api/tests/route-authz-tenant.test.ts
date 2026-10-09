// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tenant-wide routes ask for the tenant (T243 A, finding g): providers,
 * policies, adapters, capabilities, signing keys, deployments and the
 * sign-in provider catalog (`/v1/auth/providers`) need
 * `read` on the tenant to read and `admin` to change; webhook endpoints
 * and compliance evidence need `admin` for every call. Each route, with
 * no grants, is refused 403 having asked the PDP for exactly that, and
 * every pair asked is one the authorization model defines
 * (`OBJECT_ACTIONS`: the tenant has no `write`). Changing the tenant's
 * config (its secrets and env) needs `admin`, on top of the `read` every
 * `/v1/tenant` route needs.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type Action,
  type AuthzCheckBinding,
  type Decision,
  OBJECT_ACTIONS,
  type ObjectType,
  type ResourceRef,
} from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  ProviderConfig,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

/** A binding whose every method fails: a refused request never reaches it. */
const unreached = () =>
  new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('a refused request reached the binding');
      },
    },
  ) as never;

/**
 * `granted`: the pairs (`read tenant`) the caller holds; none by default.
 * `bindings`: bindings a test reaches past the check (the rest are `unreached`).
 */
function harness(
  granted: readonly string[] = [],
  bindings: { readonly identityProvider?: IdentityProviderBinding } = {},
) {
  const asked: string[] = [];
  const decide = (action: Action, resource: ResourceRef): Decision => {
    asked.push(`${action} ${resource.type}`);
    const allowed = granted.includes(`${action} ${resource.type}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: no grants',
      evidence: {
        action,
        relation: '',
        resource: `${resource.type}:${resource.id}`,
        actorSubject: '',
      },
    };
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    capabilityRegistry: unreached(),
    providerRegistry: unreached(),
    adapterRegistry: unreached(),
    webhookEndpoints: unreached(),
    policyRegistry: unreached(),
    signingKeyRegistry: unreached(),
    deploymentRegistry: unreached(),
    imageRegistry: unreached(),
    auditEvents: unreached(),
    complianceClassifier: unreached(),
    complianceGenerator: unreached(),
    sessionStore: unreached(),
    identityProvider: bindings.identityProvider ?? unreached(),
    exchangeCode: unreached(),
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, resource) => decide(action, resource),
        checkBatch: async (_p, action, resources) => resources.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  return { app, asked };
}

const READ = 'read tenant';
const ADMIN = 'admin tenant';

const ROUTES: readonly (readonly [string, string, string])[] = [
  ['GET', '/v1/capabilities', READ],
  ['GET', '/v1/capabilities/x', READ],
  ['GET', '/v1/providers', READ],
  ['GET', '/v1/providers/p', READ],
  ['GET', '/v1/providers/p/capabilities', READ],
  ['POST', '/v1/providers', ADMIN],
  ['POST', '/v1/providers/p/unregister', ADMIN],
  ['GET', '/v1/policies', READ],
  ['GET', '/v1/policies/p', READ],
  ['GET', '/v1/policies/p/versions', READ],
  ['GET', '/v1/policies/p/versions/1.0.0', READ],
  ['POST', '/v1/policies', ADMIN],
  ['POST', '/v1/policies/p/versions/1.0.0/unregister', ADMIN],
  ['POST', '/v1/policies/p/versions/1.0.0/reinstate', ADMIN],
  ['GET', '/v1/adapters', READ],
  ['GET', '/v1/adapters/a', READ],
  ['POST', '/v1/adapters/a/test', ADMIN],
  ['POST', '/v1/adapters/a/prepare', ADMIN],
  ['GET', '/v1/signing-keys', READ],
  ['GET', '/v1/signing-keys/k', READ],
  ['POST', '/v1/signing-keys', ADMIN],
  ['POST', '/v1/signing-keys/k/revoke', ADMIN],
  ['GET', '/v1/deployments', READ],
  ['GET', '/v1/deployments/d', READ],
  ['POST', '/v1/deployments', ADMIN],
  ['POST', '/v1/deployments/d/secrets', ADMIN],
  ['GET', '/v1/webhook-endpoints', ADMIN],
  ['GET', '/v1/webhook-endpoints/e', ADMIN],
  ['POST', '/v1/webhook-endpoints', ADMIN],
  ['POST', '/v1/webhook-endpoints/generate-secret', ADMIN],
  ['PATCH', '/v1/webhook-endpoints/e', ADMIN],
  ['POST', '/v1/webhook-endpoints/e/unregister', ADMIN],
  ['GET', '/v1/webhook-endpoints/e/deliveries', ADMIN],
  ['POST', '/v1/webhook-endpoints/e/deliveries/d/redeliver', ADMIN],
  ['POST', '/v1/webhook-endpoints/e/test', ADMIN],
  ['GET', '/v1/auth/providers', READ],
  ['POST', '/v1/auth/providers', ADMIN],
  ['GET', '/v1/auth/providers/p', READ],
  ['GET', '/v1/auth/providers/p/sign-in', READ],
  ['PATCH', '/v1/auth/providers/p', ADMIN],
  ['POST', '/v1/auth/providers/p/unregister', ADMIN],
  ['GET', '/v1/compliance/evidence', ADMIN],
  ['GET', '/v1/compliance/evidence/x', ADMIN],
  ['POST', '/v1/compliance/evidence/export', ADMIN],
];

describe('tenant-wide routes ask for the tenant', () => {
  test.each(ROUTES)('%s %s needs %s', async (method, path, needs) => {
    const { app, asked } = harness();
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(method !== 'GET' && { body: '{}' }),
    });
    expect(res.status).toBe(403);
    expect(asked).toEqual([needs]);
  });

  test('every pair asked is one the authorization model defines', () => {
    for (const [, , needs] of ROUTES) {
      const [action, type] = needs.split(' ') as [Action, ObjectType];
      expect(OBJECT_ACTIONS[type], needs).toContain(action);
    }
  });
});

describe('the sign-in provider catalog: any GET needs `read`, any change `admin`', () => {
  // `tenantResourceAccess`, as for every tenant-wide resource: the list
  // already shows each provider in full, so one provider (and its
  // sign-in URLs) is a reader's too.
  const call = (app: ReturnType<typeof harness>['app'], method: string, path: string) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(method !== 'GET' && { body: '{}' }),
    });

  const signIn = { redirectUri: 'https://kindgi.acme.example/auth/sso/callback/idp-p' };
  const provider: ProviderConfig = {
    providerId: 'p',
    kind: 'oidc',
    issuer: 'https://idp.acme.example',
    clientId: 'client-1',
    clientSecretRef: 'ACME_SECRET',
    signIn,
  };
  const reachable: IdentityProviderBinding = {
    list: async () => ({ data: [provider] }),
    get: async ({ providerId }) => (providerId === 'p' ? provider : null),
    register: unreached(),
    unregister: unreached(),
    signInUrls: async () => signIn,
    update: unreached(),
  };

  test('a reader reads one provider: 200, having asked for `read`', async () => {
    const { app, asked } = harness([READ], { identityProvider: reachable });
    const res = await call(app, 'GET', '/v1/auth/providers/p');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { providerId: string }).providerId).toBe('p');
    expect(asked).toEqual([READ]);
  });

  test("a reader reads a provider's sign-in URLs: 200, having asked for `read`", async () => {
    const { app, asked } = harness([READ], { identityProvider: reachable });
    const res = await call(app, 'GET', '/v1/auth/providers/p/sign-in');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signIn: unknown }).signIn).toEqual(signIn);
    expect(asked).toEqual([READ]);
  });

  test.each([
    ['PATCH', '/v1/auth/providers/p'],
    ['POST', '/v1/auth/providers/p/unregister'],
  ])('a reader is refused %s %s (403), having asked for `admin`', async (method, path) => {
    const { app, asked } = harness([READ]);
    const res = await call(app, method, path);
    expect(res.status).toBe(403);
    expect(asked).toEqual([ADMIN]);
  });
});

describe("the tenant's config: reading it needs `read`, changing it `admin`", () => {
  const patch = (app: ReturnType<typeof harness>['app']) =>
    app.request('/v1/tenant/config', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });

  test('PATCH with only `read` is refused (403), having asked for `admin`', async () => {
    const { app, asked } = harness([READ]);
    const res = await patch(app);
    expect(res.status).toBe(403);
    expect(asked).toEqual([READ, ADMIN]);
  });

  test('PATCH with `admin` passes the check; GET needs only `read`', async () => {
    const admin = harness([READ, ADMIN]);
    expect((await patch(admin.app)).status).not.toBe(403);
    expect(admin.asked).toEqual([READ, ADMIN]);

    const reader = harness([READ]);
    const res = await reader.app.request('/v1/tenant/config', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).not.toBe(403);
    expect(reader.asked).toEqual([READ]);
  });
});

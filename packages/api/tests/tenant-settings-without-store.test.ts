// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A runtime without an authorization store (no `authz`): the tenant's
 * settings are still a tenant admin's to change, as with one
 * (route-authz-tenant.test.ts), and a tenant admin is who `whoami` says
 * (`isTenantAdmin`: the `tenant-admin` scope, on a key that's neither a
 * `member` key nor limited to a project). Reading providers, policies,
 * adapters, capabilities, signing keys and the sign-in provider catalog
 * stays anyone's; webhook endpoints and compliance evidence, every call
 * a tenant admin's. Deployments are project work, which such a runtime
 * leaves to every caller.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolution, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;

const CALLERS: Readonly<Record<string, Omit<TokenResolution, 'tenantId'>>> = {
  // The deployment's API token, or an admin key.
  admin: {
    userId: 'user-admin' as UserId,
    scopes: ['tenant-admin'],
    capabilities: ['signing-keys:write'],
  },
  // A person signed in with an identity provider, or a member key.
  member: { userId: 'user-member' as UserId, scopes: [], capabilities: ['signing-keys:write'] },
  // A member key, whatever scopes it carries: a member's.
  'member key': {
    userId: 'user-member' as UserId,
    scopes: ['tenant-admin'],
    tokenRole: 'member',
    capabilities: ['signing-keys:write'],
  },
  // An admin key limited to one project.
  'project key': {
    userId: 'user-admin' as UserId,
    scopes: ['tenant-admin'],
    tokenProjectId: randomUUID(),
    capabilities: ['signing-keys:write'],
  },
};

const resolveToken: TokenResolver = async (token) => {
  const caller = CALLERS[token];
  return caller === undefined ? null : { tenantId, ...caller };
};

/** Every caller but the tenant admin. */
const OTHERS = ['member', 'member key', 'project key'] as const;

/** A binding whose every method fails: past the check, a request ends here (500), never 403. */
const unreached = () =>
  new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('reached the binding');
      },
    },
  ) as never;

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
  identityProvider: unreached(),
});

const call = (caller: string, method: string, path: string) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${caller}`, 'content-type': 'application/json' },
    ...(method !== 'GET' && { body: '{}' }),
  });

/** Anyone reads these. */
const READS: readonly (readonly [string, string])[] = [
  ['GET', '/v1/capabilities'],
  ['GET', '/v1/capabilities/x'],
  ['GET', '/v1/providers'],
  ['GET', '/v1/providers/p'],
  ['GET', '/v1/providers/p/capabilities'],
  ['GET', '/v1/providers/p/check'],
  ['GET', '/v1/policies'],
  ['GET', '/v1/policies/p'],
  ['GET', '/v1/policies/p/versions'],
  ['GET', '/v1/policies/p/versions/1.0.0'],
  ['GET', '/v1/adapters'],
  ['GET', '/v1/adapters/a'],
  ['GET', '/v1/signing-keys'],
  ['GET', '/v1/signing-keys/k'],
  ['GET', '/v1/auth/providers'],
  ['GET', '/v1/auth/providers/p'],
  ['GET', '/v1/auth/providers/p/sign-in'],
];

/** A change to a tenant-wide setting (`tenantResourceAccess`): a tenant admin's. */
const CHANGES: readonly (readonly [string, string])[] = [
  ['POST', '/v1/providers'],
  ['POST', '/v1/providers/p/unregister'],
  ['POST', '/v1/policies'],
  ['POST', '/v1/policies/p/versions/1.0.0/unregister'],
  ['POST', '/v1/policies/p/versions/1.0.0/reinstate'],
  ['POST', '/v1/adapters/a/test'],
  ['POST', '/v1/adapters/a/prepare'],
  ['POST', '/v1/signing-keys'],
  ['POST', '/v1/signing-keys/k/revoke'],
  ['POST', '/v1/auth/providers'],
  ['PATCH', '/v1/auth/providers/p'],
  ['POST', '/v1/auth/providers/p/unregister'],
];

/** Every call a tenant admin's (`tenantAdminAccess`), reads too. */
const ADMIN_ONLY: readonly (readonly [string, string])[] = [
  ['GET', '/v1/webhook-endpoints'],
  ['GET', '/v1/webhook-endpoints/e'],
  ['POST', '/v1/webhook-endpoints'],
  ['POST', '/v1/webhook-endpoints/generate-secret'],
  ['PATCH', '/v1/webhook-endpoints/e'],
  ['POST', '/v1/webhook-endpoints/e/unregister'],
  ['GET', '/v1/webhook-endpoints/e/deliveries'],
  ['POST', '/v1/webhook-endpoints/e/deliveries/d/redeliver'],
  ['POST', '/v1/webhook-endpoints/e/test'],
  ['GET', '/v1/compliance/evidence'],
  ['GET', '/v1/compliance/evidence/x'],
  ['POST', '/v1/compliance/evidence/export'],
];

async function expectRefused(res: Response, what: string): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('permission-denied');
  expect(body.error.message).toBe(
    `${what} This runtime has no authorization store, so a tenant admin is the deployment's API token, an admin key, or a console signed in with either.`,
  );
}

describe('without an authorization store, the tenant settings are a tenant admin’s to change', () => {
  test.each(READS)('anyone reads: %s %s', async (method, path) => {
    for (const caller of Object.keys(CALLERS)) {
      expect((await call(caller, method, path)).status, caller).not.toBe(403);
    }
  });

  test.each(CHANGES)('a tenant admin changes: %s %s', async (method, path) => {
    expect((await call('admin', method, path)).status).not.toBe(403);
  });

  test.each(CHANGES)(
    'anyone else is refused (403 permission-denied): %s %s',
    async (method, path) => {
      for (const caller of OTHERS) {
        await expectRefused(
          await call(caller, method, path),
          'Only a tenant admin changes a tenant-wide setting.',
        );
      }
    },
  );

  test.each(ADMIN_ONLY)('a tenant admin, and only one, calls %s %s', async (method, path) => {
    expect((await call('admin', method, path)).status).not.toBe(403);
    for (const caller of OTHERS) {
      await expectRefused(
        await call(caller, method, path),
        'Only a tenant admin reads or changes this tenant-wide setting.',
      );
    }
  });
});

describe('without an authorization store, deployments stay every caller’s', () => {
  test.each([
    ['GET', '/v1/deployments'],
    ['GET', '/v1/deployments/d'],
    ['POST', '/v1/deployments'],
  ])("a member's %s %s isn't refused", async (method, path) => {
    expect((await call('member', method, path)).status).not.toBe(403);
  });
});

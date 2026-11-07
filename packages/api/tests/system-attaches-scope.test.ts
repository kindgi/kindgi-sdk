// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `system:attaches`, a project's attaches: used only by a key holding it
 * itself (`ownSystemScope`), never by one holding `kindgi:system`, and
 * held by no key on a runtime serving one tenant, with or without a pack
 * service per deployment.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import {
  ONE_TENANT_DEPLOYMENT_SCOPES,
  ONE_TENANT_SYSTEM_SCOPES,
  oneTenantSystemScopes,
} from '../src/system.js';
import type { AppEnv } from '../src/types.js';

import { SYSTEM_SCOPES, SYSTEM_TENANT_ID, createApp, ownSystemScope } from '../src/index.js';
import type {
  RunHandlerBinding,
  SystemDeploymentsBinding,
  SystemKeyRecord,
  SystemKeysBinding,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
/** The deployment's own token, serving one tenant. */
const SINGLE_BOOT = 'kgi_bt_single';
/** The deployment's own token, serving many: a system principal with the full capability. */
const MULTI_BOOT = 'kgi_bt_multi';

type Runtime = 'many-tenants' | 'one-tenant' | 'one-tenant-with-deployments';

function makeApp(runtime: Runtime) {
  const keys = new Map<string, SystemKeyRecord & { readonly secret: string }>();
  const systemKeys: SystemKeysBinding = {
    async mint(input) {
      const id = randomUUID();
      const secret = `kgi_sy_${id}_${randomBytes(16).toString('base64url')}`;
      const record = { id, scopes: input.scopes, createdAt: new Date(), mintedBy: input.mintedBy };
      keys.set(id, { ...record, secret });
      return { record, token: secret };
    },
    async list() {
      return [...keys.values()].map(({ secret: _secret, ...r }) => r);
    },
    async revoke() {
      return null;
    },
  };
  /** A key with any scopes, as one minted while the runtime served many tenants would be. */
  const plant = (scopes: readonly string[]): string => {
    const id = randomUUID();
    const secret = `kgi_sy_${id}_planted`;
    keys.set(id, { id, scopes, createdAt: new Date(), mintedBy: 'boot', secret });
    return secret;
  };
  const app = createApp({
    ...createStubAppBindings(),
    ...(runtime === 'many-tenants' && { tenancy: 'multi' as const }),
    tenantStates: { of: async () => undefined },
    runHandler: {} as RunHandlerBinding,
    resolveToken: async (token) => {
      if (token === SINGLE_BOOT && runtime !== 'many-tenants') {
        return {
          tenantId,
          userId: 'user-seed' as UserId,
          scopes: ['tenant-admin'],
          capabilities: ['kindgi:system'],
          systemKeysOperator: { keyId: 'boot' },
        };
      }
      if (token === MULTI_BOOT && runtime === 'many-tenants') {
        return {
          tenantId: SYSTEM_TENANT_ID,
          system: { keyId: 'boot' },
          capabilities: ['kindgi:system'],
        };
      }
      const k = [...keys.values()].find((x) => x.secret === token);
      return k === undefined
        ? null
        : { tenantId: SYSTEM_TENANT_ID, system: { keyId: k.id }, capabilities: k.scopes };
    },
    systemKeys,
    systemAccessAudit: {
      async record() {},
      async begin() {
        return '0';
      },
      async finish() {},
    },
    license: {
      status: () => ({ mode: 'licensed', name: 'Acme', use: 'production' }),
      usage: async ({ since, until }) => ({
        since: since.toISOString(),
        until: until.toISOString(),
        runtimeVersion: '0.0.0',
        runs: 0,
        people: 1,
      }),
    },
    runtime: { version: '0.0.0', development: false },
    ...(runtime === 'one-tenant-with-deployments' && {
      systemTenantDirectory: {
        async get(id: TenantId) {
          return id === tenantId ? { id, state: 'active' as const } : null;
        },
      },
      // The fence answers before any of the orchestrator's routes would call it.
      systemDeployments: {
        binding: {} as SystemDeploymentsBinding,
        endpointHostAllowed: () => false,
      },
    }),
  });
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };
  return { call, plant };
}

const error = (r: { body: Record<string, unknown> }) =>
  r.body.error as { code?: string; details?: Record<string, unknown> } | undefined;

describe('system:attaches: which runtimes a key holds it on', () => {
  test("it's a system scope, and neither list a runtime serving one tenant serves holds it", () => {
    expect(SYSTEM_SCOPES).toContain('system:attaches');
    expect(ONE_TENANT_SYSTEM_SCOPES).not.toContain('system:attaches');
    expect(ONE_TENANT_DEPLOYMENT_SCOPES).not.toContain('system:attaches');
    expect(oneTenantSystemScopes(false)).not.toContain('system:attaches');
    expect(oneTenantSystemScopes(true)).not.toContain('system:attaches');
  });

  test('serving many tenants, the full system key mints a key holding it', async () => {
    const { call } = makeApp('many-tenants');
    const r = await call(MULTI_BOOT, 'POST', '/v1/system/keys', { scopes: ['system:attaches'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  test.each(['one-tenant', 'one-tenant-with-deployments'] as const)(
    "serving one tenant (%s), the deployment's own token mints no key holding it",
    async (runtime) => {
      const { call } = makeApp(runtime);
      for (const scopes of [['system:attaches'], ['system:license', 'system:attaches']]) {
        const r = await call(SINGLE_BOOT, 'POST', '/v1/system/keys', { scopes });
        expect(r.status, `${scopes.join(',')}: ${JSON.stringify(r.body)}`).toBe(400);
        expect(error(r)?.code).toBe('bad-input');
      }
    },
  );

  test.each(['one-tenant', 'one-tenant-with-deployments'] as const)(
    'serving one tenant (%s), a planted key holding it is refused, the license route too',
    async (runtime) => {
      const { call, plant } = makeApp(runtime);
      const routes: readonly [string, string][] = [
        ['GET', '/v1/license'],
        ['GET', '/v1/system/deployments?endpoint=missing'],
      ];
      for (const scopes of [['system:attaches'], ['system:license', 'system:attaches']]) {
        const key = plant(scopes);
        for (const [method, path] of routes) {
          const r = await call(key, method, path);
          expect(r.status, `${scopes.join(',')} ${method} ${path}`).toBe(403);
          expect(error(r)?.code).toBe('system-key-scope-not-served');
          expect(error(r)?.details?.served).not.toContain('system:attaches');
        }
      }
    },
  );
});

/** A route only a key holding `system:attaches` itself may use, with the caller each test gives. */
function attachRoute(caller: {
  readonly system: boolean;
  readonly capabilities?: readonly string[];
}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-1');
    c.set('tenantId', SYSTEM_TENANT_ID);
    if (caller.system) c.set('systemPrincipal', { keyId: 'key-1' });
    if (caller.capabilities !== undefined) c.set('capabilities', caller.capabilities);
    await next();
  });
  app.post('/attach', (c) => {
    const principal = ownSystemScope(c, 'system:attaches', 'Attaching a project');
    return principal instanceof Response ? principal : c.json({ keyId: principal.keyId });
  });
  return async () => {
    const res = await app.request('/attach', { method: 'POST' });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}

describe('ownSystemScope: system:attaches is used by a key holding it itself', () => {
  test('a key holding it gets through, as its system principal', async () => {
    for (const capabilities of [['system:attaches'], ['system:deployments', 'system:attaches']]) {
      const r = await attachRoute({ system: true, capabilities })();
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ keyId: 'key-1' });
    }
  });

  test("kindgi:system doesn't stand in for it, nor does any other scope or none", async () => {
    for (const capabilities of [
      ['kindgi:system'],
      ['kindgi:system', 'system:deployments'],
      ['system:deployments'],
      [],
      undefined,
    ]) {
      const r = await attachRoute({
        system: true,
        ...(capabilities !== undefined && { capabilities }),
      })();
      expect(r.status, JSON.stringify(capabilities)).toBe(403);
      expect(error(r)?.code).toBe('system-scope-missing');
      expect(error(r)?.details?.scope).toBe('system:attaches');
    }
  });

  test("a caller that isn't a system principal is refused, whatever it holds", async () => {
    const r = await attachRoute({ system: false, capabilities: ['system:attaches'] })();
    expect(r.status).toBe(403);
    expect(error(r)?.code).toBe('system-principal-required');
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import type { TenantHierarchyBinding } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { CreateAppInput, RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * `GET /v1/tenant`'s `egress`: the addresses the deployment's calls come
 * from, as the runtime passes them to `createApp`. The deployment's, so
 * every tenant reads the same lists; absent when nothing is published.
 * The addresses are from the documentation ranges (RFC 5737, RFC 3849).
 */

const ACME = { token: 'acme-token', tenantId: randomUUID() as TenantId };
const GLOBEX = { token: 'globex-token', tenantId: randomUUID() as TenantId };
const userId = randomUUID() as UserId;

const resolveToken: TokenResolver = async (token) => {
  const caller = [ACME, GLOBEX].find((t) => t.token === token);
  return caller === undefined ? null : { tenantId: caller.tenantId, userId };
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

function makeApp(egress?: CreateAppInput['egress'], authz?: AuthzCheckBinding) {
  const stubs = createStubAppBindings();
  const tenantHierarchyBinding: TenantHierarchyBinding = {
    ...stubs.tenantHierarchyBinding,
    getTenant: async (tenantId) => ({
      id: tenantId,
      name: 'Acme',
      slug: 'acme',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
  };
  return createApp({
    ...stubs,
    tenantHierarchyBinding,
    resolveToken,
    runHandler,
    ...(egress !== undefined && { egress }),
    ...(authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: authz },
    }),
  });
}

async function tenantOf(app: ReturnType<typeof makeApp>, token = ACME.token) {
  const res = await app.request('/v1/tenant', { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /v1/tenant's egress", () => {
  test('a deployment that publishes nothing: no egress', async () => {
    const { status, body } = await tenantOf(makeApp());
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('egress');
  });

  test('both lists empty: no egress, the same as none', async () => {
    const { body } = await tenantOf(makeApp({ server: [], deployments: [] }));
    expect(body).not.toHaveProperty('egress');
  });

  test('both lists, as given, IPv6 too', async () => {
    const egress = { server: ['192.0.2.10'], deployments: ['198.51.100.20', '2001:db8::1'] };
    const { body } = await tenantOf(makeApp(egress));
    expect(body.egress).toEqual(egress);
  });

  test('one list set: the other is there, empty', async () => {
    const { body } = await tenantOf(makeApp({ server: [], deployments: ['198.51.100.20'] }));
    expect(body.egress).toEqual({ server: [], deployments: ['198.51.100.20'] });
  });

  test("the deployment's, not the tenant's: another tenant reads the same lists", async () => {
    const egress = { server: ['192.0.2.10'], deployments: ['198.51.100.20'] };
    const app = makeApp(egress);
    expect((await tenantOf(app, ACME.token)).body.egress).toEqual(egress);
    expect((await tenantOf(app, GLOBEX.token)).body.egress).toEqual(egress);
  });

  test('anyone in the tenant reads it, its observer too: `belong` is enough, not `read`', async () => {
    const asked: string[] = [];
    const readOnly = {
      check: async (_p: unknown, action: string, resource: { type: string; id: string }) => {
        asked.push(`${action} ${resource.type}:${resource.id}`);
        const allowed = action === 'belong';
        return { allowed, reason: 'test', failing: allowed ? undefined : 'actor' } as Decision;
      },
    } as unknown as AuthzCheckBinding;
    const { status, body } = await tenantOf(
      makeApp({ server: ['192.0.2.10'], deployments: [] }, readOnly),
    );
    expect(status).toBe(200);
    expect(body.egress).toEqual({ server: ['192.0.2.10'], deployments: [] });
    expect(asked).toEqual([`belong tenant:${ACME.tenantId}`]);
  });

  test("an entry that isn't an IP address: createApp throws, naming the list", () => {
    expect(() => makeApp({ server: ['192.0.2.10'], deployments: ['nat.example.com'] })).toThrow(
      'egress.deployments: "nat.example.com" isn\'t an IP address',
    );
    expect(() => makeApp({ server: ['192.0.2.0/24'], deployments: [] })).toThrow(
      'egress.server: "192.0.2.0/24" isn\'t an IP address',
    );
    expect(() => makeApp({ server: ['fe80::1%eth0'], deployments: [] })).toThrow(
      'egress.server: "fe80::1%eth0" isn\'t an IP address',
    );
  });

  test("a later change to the caller's arrays doesn't change the answer", async () => {
    const server = ['192.0.2.10'];
    const app = makeApp({ server, deployments: [] });
    server.push('192.0.2.11');
    expect((await tenantOf(app)).body.egress).toEqual({ server: ['192.0.2.10'], deployments: [] });
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/tokens`: API keys. Mint, list (paged, newest first), read, revoke;
 * tenant admins only; a caller only grants capabilities it holds; a key
 * authenticates as its service account.
 */

import { describe, expect, test } from 'vitest';

import type { ApiTokenId, TenantId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ApiTokenRecord,
  RunHandlerBinding,
  TokenAdmin,
  TokenMintInput,
  TokenResolver,
} from '../src/index.js';

const tenantA = '00000000-0000-4000-8000-00000000000a' as TenantId;
const tenantB = '00000000-0000-4000-8000-00000000000b' as TenantId;

const ADMIN = 'token-admin';
const MEMBER = 'token-member';
const B_ADMIN = 'token-tenant-b-admin';

const runHandler = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
} as unknown as RunHandlerBinding;

/** An in-memory TokenAdmin whose minted keys also resolve. */
function inMemoryKeys() {
  const records = new Map<string, ApiTokenRecord & { tenantId: TenantId; secret: string }>();
  let seq = 0;
  const admin: TokenAdmin = {
    async mint(input: TokenMintInput) {
      seq += 1;
      const tokenId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` as ApiTokenId;
      const secret = `kgi_ak_test_${seq}`;
      records.set(tokenId as unknown as string, {
        tokenId,
        tenantId: input.tenantId,
        secret,
        role: input.role,
        capabilities: input.capabilities,
        ...(input.label !== undefined && { label: input.label }),
        ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
      });
      const record = records.get(tokenId as unknown as string) as ApiTokenRecord;
      return { record, token: secret };
    },
    async list({ tenantId, limit, after }) {
      return [...records.values()]
        .filter((r) => r.tenantId === tenantId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .filter((r) => after === undefined || r.createdAt.getTime() < after.createdAt.getTime())
        .slice(0, limit);
    },
    async get({ tenantId, tokenId }) {
      const r = records.get(tokenId as unknown as string);
      return r !== undefined && r.tenantId === tenantId ? r : undefined;
    },
    async revoke({ tenantId, tokenId }) {
      const r = records.get(tokenId as unknown as string);
      if (r === undefined || r.tenantId !== tenantId) return { kind: 'not-found' };
      records.set(tokenId as unknown as string, { ...r, revokedAt: new Date() });
      return { kind: 'ok' };
    },
  };
  const resolve: TokenResolver = async (token) => {
    const r = [...records.values()].find((x) => x.secret === token);
    if (r === undefined || r.revokedAt !== undefined) return null;
    return {
      tenantId: r.tenantId,
      tokenId: r.tokenId,
      scopes: r.role === 'admin' ? ['tenant-admin'] : [],
      capabilities: r.capabilities,
    };
  };
  return { admin, resolve };
}

function makeApp() {
  const keys = inMemoryKeys();
  const resolveToken: TokenResolver = async (t) => {
    if (t === ADMIN) {
      return {
        tenantId: tenantA,
        scopes: ['tenant-admin'],
        capabilities: ['env:write', 'secrets:write'],
      };
    }
    if (t === MEMBER) return { tenantId: tenantA, scopes: [], capabilities: ['env:write'] };
    if (t === B_ADMIN) return { tenantId: tenantB, scopes: ['tenant-admin'], capabilities: [] };
    return keys.resolve(t);
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    tokenAdmin: keys.admin,
  });
  return app;
}

async function call(
  app: ReturnType<typeof createApp>,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('/v1/tokens', () => {
  test('an admin mints a key with a role and capabilities it holds; the secret comes back once', async () => {
    const app = makeApp();
    const minted = await call(app, 'POST', '/v1/tokens', ADMIN, {
      role: 'member',
      capabilities: ['env:write', 'env:write'],
      label: 'ci',
    });
    expect(minted.status).toBe(201);
    expect(minted.body).toMatchObject({ role: 'member', capabilities: ['env:write'] });
    expect(typeof minted.body.token).toBe('string');

    const read = await call(app, 'GET', `/v1/tokens/${minted.body.tokenId as string}`, ADMIN);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      tokenId: minted.body.tokenId,
      role: 'member',
      capabilities: ['env:write'],
      label: 'ci',
    });
    expect(read.body).not.toHaveProperty('token');
  });

  test('no body mints a member key with no capabilities', async () => {
    const minted = await call(makeApp(), 'POST', '/v1/tokens', ADMIN);
    expect(minted.status).toBe(201);
    expect(minted.body).toMatchObject({ role: 'member', capabilities: [] });
  });

  test("a caller can't grant a capability it doesn't hold", async () => {
    const res = await call(makeApp(), 'POST', '/v1/tokens', ADMIN, {
      role: 'admin',
      capabilities: ['env:write', 'kindgi:system'],
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('kindgi:system');
  });

  test('a member manages no keys: mint, list, read and revoke are 403', async () => {
    const app = makeApp();
    expect((await call(app, 'POST', '/v1/tokens', MEMBER, { capabilities: [] })).status).toBe(403);
    expect((await call(app, 'GET', '/v1/tokens', MEMBER)).status).toBe(403);
    const minted = await call(app, 'POST', '/v1/tokens', ADMIN, {});
    const id = minted.body.tokenId as string;
    expect((await call(app, 'GET', `/v1/tokens/${id}`, MEMBER)).status).toBe(403);
    expect((await call(app, 'POST', `/v1/tokens/${id}/revoke`, MEMBER)).status).toBe(403);
  });

  test('a minted member key authenticates, and still administers nothing', async () => {
    const app = makeApp();
    const minted = await call(app, 'POST', '/v1/tokens', ADMIN, { capabilities: ['env:write'] });
    const key = minted.body.token as string;
    expect((await call(app, 'GET', '/v1/tokens', key)).status).toBe(403);
  });

  test('an admin key mints, but only within what it holds itself', async () => {
    const app = makeApp();
    const adminKey = (
      await call(app, 'POST', '/v1/tokens', ADMIN, { role: 'admin', capabilities: ['env:write'] })
    ).body.token as string;
    const child = await call(app, 'POST', '/v1/tokens', adminKey, { capabilities: ['env:write'] });
    expect(child.status).toBe(201);
    const read = await call(app, 'GET', `/v1/tokens/${child.body.tokenId as string}`, ADMIN);
    expect(String(read.body.createdBy)).toMatch(/^service_account:/);
    const escalate = await call(app, 'POST', '/v1/tokens', adminKey, {
      capabilities: ['secrets:write'],
    });
    expect(escalate.status).toBe(403);
  });

  test('revoke: the key stops authenticating on the next request', async () => {
    const app = makeApp();
    const minted = await call(app, 'POST', '/v1/tokens', ADMIN, { role: 'admin' });
    const key = minted.body.token as string;
    expect((await call(app, 'GET', '/v1/tokens', key)).status).toBe(200);
    const revoked = await call(
      app,
      'POST',
      `/v1/tokens/${minted.body.tokenId as string}/revoke`,
      ADMIN,
    );
    expect(revoked.body).toEqual({ tokenId: minted.body.tokenId, revoked: true });
    expect((await call(app, 'GET', '/v1/tokens', key)).status).toBe(401);
  });

  test("list pages newest first, and a tenant never sees another's keys", async () => {
    const app = makeApp();
    for (let i = 0; i < 3; i += 1) await call(app, 'POST', '/v1/tokens', ADMIN, { label: `k${i}` });
    await call(app, 'POST', '/v1/tokens', B_ADMIN, { label: 'b' });

    const first = await call(app, 'GET', '/v1/tokens?limit=2', ADMIN);
    expect(first.body.hasMore).toBe(true);
    expect((first.body.data as { label: string }[]).map((k) => k.label)).toEqual(['k2', 'k1']);
    const second = await call(
      app,
      'GET',
      `/v1/tokens?limit=2&cursor=${first.body.nextCursor as string}`,
      ADMIN,
    );
    expect(second.body.hasMore).toBe(false);
    expect((second.body.data as { label: string }[]).map((k) => k.label)).toEqual(['k0']);

    const b = await call(app, 'GET', '/v1/tokens', B_ADMIN);
    expect((b.body.data as { label: string }[]).map((k) => k.label)).toEqual(['b']);
    const aKey = (first.body.data as { tokenId: string }[])[0]?.tokenId as string;
    expect((await call(app, 'GET', `/v1/tokens/${aKey}`, B_ADMIN)).status).toBe(404);
    expect((await call(app, 'POST', `/v1/tokens/${aKey}/revoke`, B_ADMIN)).status).toBe(404);
  });

  test('bad input: an unknown role, capabilities that are not strings, a malformed cursor', async () => {
    const app = makeApp();
    expect((await call(app, 'POST', '/v1/tokens', ADMIN, { role: 'owner' })).status).toBe(400);
    expect(
      (await call(app, 'POST', '/v1/tokens', ADMIN, { capabilities: 'env:write' })).status,
    ).toBe(400);
    expect((await call(app, 'POST', '/v1/tokens', ADMIN, { capabilities: [''] })).status).toBe(400);
    expect((await call(app, 'GET', '/v1/tokens?cursor=nope', ADMIN)).status).toBe(400);
  });
});

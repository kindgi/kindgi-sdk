// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/signing-keys`: the trust list `POST /v1/deployments` verifies
 * signers against.
 */

import { describe, expect, test } from 'vitest';

import type { SigningKeyId, TenantId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  SigningKeyBinding,
  TokenResolver,
  TrustedKey,
} from '../src/index.js';

const tenantA = '00000000-0000-4000-8000-00000000000a' as TenantId;
const tenantB = '00000000-0000-4000-8000-00000000000b' as TenantId;
const ADMIN = 'token-signing-keys-write';
const READER = 'token-read-only';
const OTHER_TENANT = 'token-tenant-b';

const resolveToken: TokenResolver = async (t) => {
  if (t === ADMIN) return { tenantId: tenantA, capabilities: ['signing-keys:write'] };
  if (t === READER) return { tenantId: tenantA, capabilities: [] };
  if (t === OTHER_TENANT) return { tenantId: tenantB, capabilities: ['signing-keys:write'] };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
} as unknown as RunHandlerBinding;

/** A trust list in memory, per tenant. */
function inMemoryTrustList(): SigningKeyBinding {
  const keys = new Map<string, TrustedKey>();
  const k = (tenantId: TenantId, keyId: SigningKeyId) => `${tenantId}/${keyId}`;
  return {
    async isTrusted({ tenantId, keyId, publicKey }) {
      const key = keys.get(k(tenantId, keyId));
      return {
        kind: 'ok',
        value: key !== undefined && key.revokedAt === undefined && key.publicKey === publicKey,
      };
    },
    async verify() {
      return { kind: 'ok', value: { valid: false, reason: 'unused' } };
    },
    async listTrusted({ tenantId, includeRevoked, labelFilter }) {
      const data = [...keys.values()]
        .filter((key) => key.tenantId === tenantId)
        .filter((key) => includeRevoked === true || key.revokedAt === undefined)
        .filter((key) => labelFilter === undefined || (key.label ?? '').startsWith(labelFilter));
      return { data };
    },
    async getTrusted({ tenantId, keyId }) {
      return keys.get(k(tenantId, keyId)) ?? null;
    },
    async addTrusted({ tenantId, keyId, algorithm, publicKey, label }) {
      const existing = keys.get(k(tenantId, keyId));
      if (existing !== undefined) {
        return existing.publicKey === publicKey
          ? { kind: 'already-trusted', key: existing }
          : { kind: 'key-id-conflict', existing };
      }
      const key: TrustedKey = {
        keyId,
        tenantId,
        algorithm,
        publicKey,
        ...(label !== undefined && { label }),
        createdAt: '2026-10-02T00:00:00.000Z',
      };
      keys.set(k(tenantId, keyId), key);
      return { kind: 'ok', key };
    },
    async revokeTrusted({ tenantId, keyId, reason }) {
      const key = keys.get(k(tenantId, keyId));
      if (key === undefined || key.revokedAt !== undefined) return { revoked: false };
      keys.set(k(tenantId, keyId), {
        ...key,
        revokedAt: '2026-10-02T01:00:00.000Z',
        ...(reason !== undefined && { revokedReason: reason }),
      });
      return { revoked: true };
    },
  };
}

const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

function makeApp(withTrustList = true) {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    ...(withTrustList && { signingKeyRegistry: inMemoryTrustList() }),
  });
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

describe('/v1/signing-keys', () => {
  test('not mounted without a signing-key registry', async () => {
    const res = await makeApp(false).request('/v1/signing-keys', {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(404);
  });

  test('trust a key, read it back, list it; trusting it again is a 200 no-op', async () => {
    const app = makeApp();
    const added = await call(app, 'POST', '/v1/signing-keys', ADMIN, {
      keyId: 'ci-2026-10',
      publicKey: PUBLIC_KEY,
      label: 'ci',
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      keyId: 'ci-2026-10',
      tenantId: tenantA,
      algorithm: 'ed25519',
      publicKey: PUBLIC_KEY,
      label: 'ci',
    });
    expect((await call(app, 'GET', '/v1/signing-keys/ci-2026-10', READER)).body).toEqual(
      added.body,
    );
    const page = await call(app, 'GET', '/v1/signing-keys', READER);
    expect(page.body).toEqual({ data: [added.body], hasMore: false });
    const again = await call(app, 'POST', '/v1/signing-keys', ADMIN, {
      keyId: 'ci-2026-10',
      publicKey: PUBLIC_KEY,
    });
    expect(again.status).toBe(200);
  });

  test('a known key id with a different public key is a conflict: rotate under a new id', async () => {
    const app = makeApp();
    await call(app, 'POST', '/v1/signing-keys', ADMIN, { keyId: 'ci', publicKey: PUBLIC_KEY });
    const conflict = await call(app, 'POST', '/v1/signing-keys', ADMIN, {
      keyId: 'ci',
      publicKey: OTHER_KEY,
    });
    expect(conflict.status).toBe(409);
    expect((conflict.body.error as { code: string }).code).toBe('signing-key-conflict');
  });

  test('revoke: the key stays readable with its reason, and leaves the default list', async () => {
    const app = makeApp();
    await call(app, 'POST', '/v1/signing-keys', ADMIN, { keyId: 'ci', publicKey: PUBLIC_KEY });
    const revoked = await call(app, 'POST', '/v1/signing-keys/ci/revoke', ADMIN, {
      reason: 'laptop lost',
    });
    expect(revoked.body).toEqual({ keyId: 'ci', revoked: true });
    expect((await call(app, 'GET', '/v1/signing-keys/ci', READER)).body).toMatchObject({
      revokedAt: '2026-10-02T01:00:00.000Z',
      revokedReason: 'laptop lost',
    });
    expect((await call(app, 'GET', '/v1/signing-keys', READER)).body.data).toEqual([]);
    expect(
      ((await call(app, 'GET', '/v1/signing-keys?includeRevoked=true', READER)).body.data as [])
        .length,
    ).toBe(1);
    // Idempotent.
    expect((await call(app, 'POST', '/v1/signing-keys/ci/revoke', ADMIN)).body).toEqual({
      keyId: 'ci',
      revoked: false,
    });
  });

  test('trusting a revoked key id again is a 409: revocation is final', async () => {
    const trustList = inMemoryTrustList();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      signingKeyRegistry: {
        ...trustList,
        addTrusted: async () => ({
          kind: 'error',
          code: 'signing-key-revoked',
          message: 'Signing key "ci" was revoked',
        }),
      },
    });
    const res = await call(app, 'POST', '/v1/signing-keys', ADMIN, {
      keyId: 'ci',
      publicKey: PUBLIC_KEY,
    });
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('signing-key-revoked');
  });

  test('changing the trust list needs signing-keys:write', async () => {
    const app = makeApp();
    const add = await call(app, 'POST', '/v1/signing-keys', READER, {
      keyId: 'ci',
      publicKey: PUBLIC_KEY,
    });
    expect(add.status).toBe(403);
    expect((add.body.error as { code: string }).code).toBe('permission-denied');
    const revoke = await call(app, 'POST', '/v1/signing-keys/ci/revoke', READER);
    expect(revoke.status).toBe(403);
  });

  test('a bad key id, public key or algorithm is refused', async () => {
    const app = makeApp();
    for (const body of [
      { keyId: '', publicKey: PUBLIC_KEY },
      { keyId: 'has space', publicKey: PUBLIC_KEY },
      { keyId: 'ci', publicKey: Buffer.alloc(16).toString('base64') },
      { keyId: 'ci', publicKey: 'not base64!' },
    ]) {
      expect((await call(app, 'POST', '/v1/signing-keys', ADMIN, body)).status).toBe(400);
    }
    const rsa = await call(app, 'POST', '/v1/signing-keys', ADMIN, {
      keyId: 'ci',
      publicKey: PUBLIC_KEY,
      algorithm: 'rsa',
    });
    expect(rsa.status).toBe(400);
    expect((rsa.body.error as { code: string }).code).toBe('signing-key-algorithm-unsupported');
  });

  test("one tenant can't see another's keys", async () => {
    const app = makeApp();
    await call(app, 'POST', '/v1/signing-keys', ADMIN, { keyId: 'ci', publicKey: PUBLIC_KEY });
    expect((await call(app, 'GET', '/v1/signing-keys/ci', OTHER_TENANT)).status).toBe(404);
    expect((await call(app, 'GET', '/v1/signing-keys', OTHER_TENANT)).body.data).toEqual([]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { BlobStorageBinding } from '@kindgi/blob-binding';
import type { TenantHierarchyBinding } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { validateAgainst } from './support/openapi-schema.js';

/**
 * `GET /v1/tenant`'s `storage`: what the tenant's files take, from a file
 * store that counts them, beside the `storageMiB` limit it's checked
 * against. Each tenant reads its own; absent from a store that doesn't count.
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

function makeApp(used?: ReadonlyMap<TenantId, number>) {
  const stubs = createStubAppBindings();
  const tenantHierarchyBinding: TenantHierarchyBinding = {
    ...stubs.tenantHierarchyBinding,
    getTenant: async (tenantId) => ({
      id: tenantId,
      name: 'Acme',
      slug: 'acme',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      limits: { storageMiB: 1 },
    }),
  };
  // Only the count is read here; the routes that store aren't called.
  const blobStorage = {
    ...(used !== undefined && {
      async storageUsed(tenantId: TenantId) {
        return { usedBytes: used.get(tenantId) ?? 0 };
      },
    }),
  } as unknown as BlobStorageBinding;
  return createApp({ ...stubs, tenantHierarchyBinding, resolveToken, runHandler, blobStorage });
}

async function tenantOf(app: ReturnType<typeof makeApp>, token = ACME.token) {
  const res = await app.request('/v1/tenant', { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /v1/tenant's storage", () => {
  test('a store that counts: each tenant reads its own, past a lowered limit too', async () => {
    const app = makeApp(new Map([[ACME.tenantId, 3 * 1024 * 1024]]));
    const acme = await tenantOf(app);
    expect(acme.status).toBe(200);
    expect(acme.body.storage).toEqual({ usedBytes: 3 * 1024 * 1024 });
    expect(acme.body.limits).toEqual({ storageMiB: 1 });
    expect(validateAgainst('Tenant', acme.body)).toEqual([]);
    // A tenant with no files yet takes none.
    expect((await tenantOf(app, GLOBEX.token)).body.storage).toEqual({ usedBytes: 0 });
  });

  test("a store that doesn't count: no storage, and the limit is still read", async () => {
    const { status, body } = await tenantOf(makeApp());
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('storage');
    expect(body.limits).toEqual({ storageMiB: 1 });
  });
});

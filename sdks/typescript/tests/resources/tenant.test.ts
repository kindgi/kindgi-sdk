// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, noContentFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_TENANT = {
  tenantId: 'tenant-1',
  name: 'Acme Legal',
  slug: 'acme-legal',
  residency: 'us-east-1',
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
};

describe('tenant — wire round-trips', () => {
  it('get + config.list + config.upsert hit /v1/tenant/*', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(SAMPLE_TENANT) },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
      { status: 200, body: JSON.stringify({ upserted: true }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.tenant.get();
    await client.tenant.config.list({ kind: 'feature-flag' as never });
    await client.tenant.config.upsert({ entries: [] as unknown as never });
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/tenant',
      'GET /v1/tenant/config',
      'PATCH /v1/tenant/config',
    ]);
  });

  it('update: PATCH /v1/tenant with the fields given and the idempotency key; a 204 resolves to nothing', async () => {
    const stub = noContentFetch();
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.tenant.update(
        { name: 'Acme Store', slug: 'acme-store' },
        { idempotencyKey: 'k-1' },
      ),
    ).toBeUndefined();
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`PATCH ${API}/v1/tenant`);
    expect(JSON.parse(call.body ?? '{}')).toEqual({ name: 'Acme Store', slug: 'acme-store' });
    expect(call.headers['idempotency-key']).toBe('k-1');
  });

  it('update: a slug the sign-in settings name surfaces as a conflict with its own code', async () => {
    const stub = errorFetch(409, {
      code: 'tenant-slug-in-config',
      message: 'The server names the slug "acme".',
      details: { slug: 'acme' },
    });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await expect(client.tenant.update({ slug: 'acme' })).rejects.toMatchObject({
      error: { code: 'conflict', serverCode: 'tenant-slug-in-config' },
    });
  });
});

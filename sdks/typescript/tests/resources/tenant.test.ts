// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

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
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_ORG = {
  orgId: 'org-1',
  tenantId: 'tenant-1',
  name: 'Litigation',
  slug: 'litigation',
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
};

describe('orgs — wire round-trips', () => {
  it('CRUD paths hit /v1/orgs', async () => {
    const page = { data: [SAMPLE_ORG], hasMore: false };
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ id: 'org-1' }) },
      { status: 200, body: JSON.stringify(page) },
      { status: 200, body: JSON.stringify(SAMPLE_ORG) },
      { status: 200, body: JSON.stringify(SAMPLE_ORG) },
      { status: 200, body: '{}' },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.orgs.create({ name: 'Litigation', slug: 'litigation' });
    await client.orgs.list();
    await client.orgs.get('org-1');
    await client.orgs.update('org-1', { name: 'Litigation & Compliance' });
    await client.orgs.delete('org-1');
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/orgs',
      'GET /v1/orgs',
      'GET /v1/orgs/org-1',
      'PATCH /v1/orgs/org-1',
      'DELETE /v1/orgs/org-1',
    ]);
  });
});

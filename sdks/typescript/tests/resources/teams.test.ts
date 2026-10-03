// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_TEAM = {
  teamId: 't1',
  tenantId: 'tenant-1',
  name: 'Compliance',
  slug: 'compliance',
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
};

describe('teams — wire round-trips', () => {
  it('CRUD + memberships hit /v1/teams', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ id: 't1' }) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_TEAM], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_TEAM) },
      { status: 200, body: JSON.stringify(SAMPLE_TEAM) },
      { status: 200, body: '{}' },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
      { status: 201, body: JSON.stringify({ userId: 'u1', role: 'admin' }) },
      { status: 200, body: '{}' },
      { status: 200, body: '{}' },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.teams.create({ name: 'Compliance', slug: 'compliance' });
    await client.teams.list();
    await client.teams.get('t1');
    await client.teams.update('t1', { name: 'Compliance & Risk' });
    await client.teams.delete('t1');
    await client.teams.memberships.list('t1');
    await client.teams.memberships.add('t1', { userId: 'u1', role: 'admin' });
    await client.teams.memberships.updateRole('t1', 'u1', 'member');
    await client.teams.memberships.remove('t1', 'u1');
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/teams',
      'GET /v1/teams',
      'GET /v1/teams/t1',
      'PATCH /v1/teams/t1',
      'DELETE /v1/teams/t1',
      'GET /v1/teams/t1/memberships',
      'POST /v1/teams/t1/memberships',
      'PATCH /v1/teams/t1/memberships/u1',
      'DELETE /v1/teams/t1/memberships/u1',
    ]);
  });
});

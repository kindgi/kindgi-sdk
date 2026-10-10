// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_PROJECT = {
  projectId: 'p1',
  tenantId: 'tenant-1',
  orgId: null,
  name: 'Default',
  slug: 'default',
  isDefault: true,
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
};

describe('projects — wire round-trips', () => {
  it('CRUD + default + memberships hit /v1/projects', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ id: 'p1' }) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_PROJECT], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_PROJECT) },
      { status: 200, body: JSON.stringify(SAMPLE_PROJECT) },
      { status: 200, body: JSON.stringify(SAMPLE_PROJECT) },
      { status: 200, body: '{}' },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
      { status: 201, body: JSON.stringify({ userId: 'u1', role: 'admin' }) },
      { status: 200, body: '{}' },
      { status: 200, body: '{}' },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.projects.create({ name: 'Default', slug: 'default' });
    await client.projects.list();
    await client.projects.getDefault();
    await client.projects.get('p1');
    await client.projects.update('p1', { name: 'Renamed' });
    await client.projects.delete('p1');
    await client.projects.memberships.list('p1');
    await client.projects.memberships.add('p1', { userId: 'u1', role: 'admin' });
    await client.projects.memberships.updateRole('p1', 'u1', 'viewer');
    await client.projects.memberships.remove('p1', 'u1');
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/projects',
      'GET /v1/projects',
      'GET /v1/projects/default',
      'GET /v1/projects/p1',
      'PATCH /v1/projects/p1',
      'DELETE /v1/projects/p1',
      'GET /v1/projects/p1/memberships',
      'POST /v1/projects/p1/memberships',
      'PATCH /v1/projects/p1/memberships/u1',
      'DELETE /v1/projects/p1/memberships/u1',
    ]);
  });

  it('teamGrants map to /v1/projects/:id/team-grants, and teams.projectGrants to /v1/teams/:id/project-grants', async () => {
    const grant = {
      teamId: 't1',
      projectId: 'p1',
      role: 'editor',
      teamName: 'Crew',
      projectName: 'Acme',
    };
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [grant], hasMore: false }) },
      { status: 201, body: JSON.stringify(grant) },
      { status: 200, body: '{}' },
      { status: 200, body: '{}' },
      { status: 200, body: JSON.stringify({ data: [grant], hasMore: false }) },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const page = await client.projects.teamGrants.list('p1', { limit: 5 });
    expect(page.data[0]?.teamName).toBe('Crew');
    expect(await client.projects.teamGrants.add('p1', { teamId: 't1', role: 'editor' })).toEqual(
      grant,
    );
    await client.projects.teamGrants.updateRole('p1', 't1', 'admin');
    await client.projects.teamGrants.remove('p1', 't1');
    await client.teams.projectGrants.list('t1');
    await client.projects.access.list('p1', { limit: 100 });
    expect(
      stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`),
    ).toEqual([
      'GET /v1/projects/p1/team-grants?limit=5',
      'POST /v1/projects/p1/team-grants',
      'PATCH /v1/projects/p1/team-grants/t1',
      'DELETE /v1/projects/p1/team-grants/t1',
      'GET /v1/teams/t1/project-grants',
      'GET /v1/projects/p1/access?limit=100',
    ]);
    expect(JSON.parse(stub.calls[1]?.body as string)).toEqual({ teamId: 't1', role: 'editor' });
    expect(JSON.parse(stub.calls[2]?.body as string)).toEqual({ role: 'admin' });
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const TENANT = '6f1c2c0e-3b0a-4f1e-9a51-0c1d2e3f4a5b';
const PROJECT = '0b3a1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const WINDOW = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' };

const page = {
  data: [
    {
      projectId: PROJECT,
      kind: 'run.ended',
      state: 'failed',
      count: 2,
      quantity: 5400,
      firstAt: '2026-11-02T10:00:00.000Z',
      lastAt: '2026-11-03T11:00:00.000Z',
    },
  ],
  watermark: '2026-11-04T00:00:00.000Z',
  nextCursor: 'c-2',
};

/** The request's method, origin and path, and its query as an object. */
function asked(stub: ReturnType<typeof jsonFetch>) {
  const call = stub.calls[0]!;
  const url = new URL(call.url);
  return {
    route: `${call.method} ${url.origin}${url.pathname}`,
    query: Object.fromEntries(url.searchParams),
    body: call.body,
  };
}

describe('usage — wire round-trip', () => {
  it('read: GET /v1/usage, lists joined with commas, one project', async () => {
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.usage.read({
        ...WINDOW,
        groupBy: ['project', 'kind', 'state'],
        kind: ['run.ended'],
        class: ['production', 'staging'],
        state: ['failed', 'cancelled'],
        projectId: PROJECT,
        limit: 500,
        cursor: 'c-1',
      }),
    ).toEqual(page);
    expect(asked(stub)).toEqual({
      route: `GET ${API}/v1/usage`,
      query: {
        ...WINDOW,
        groupBy: 'project,kind,state',
        kind: 'run.ended',
        class: 'production,staging',
        state: 'failed,cancelled',
        projectId: PROJECT,
        limit: '500',
        cursor: 'c-1',
      },
      body: undefined,
    });
  });

  it('read: only the window when nothing else is asked; empty lists are left out', async () => {
    const stub = jsonFetch({ data: [], watermark: page.watermark });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.usage.read({ ...WINDOW, groupBy: [], kind: [] });
    expect(asked(stub).query).toEqual(WINDOW);
  });
});

describe('systemUsage — wire round-trip', () => {
  it('read: GET /v1/system/usage, grouped by tenant, one tenant', async () => {
    const answer = { ...page, data: [{ ...page.data[0]!, tenantId: TENANT }] };
    const stub = jsonFetch(answer);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemUsage.read({
        ...WINDOW,
        groupBy: ['tenant', 'project', 'state'],
        kind: ['project.production'],
        state: ['on'],
        tenantId: TENANT,
        limit: 500,
        cursor: 'c-1',
      }),
    ).toEqual(answer);
    expect(asked(stub)).toEqual({
      route: `GET ${API}/v1/system/usage`,
      query: {
        ...WINDOW,
        groupBy: 'tenant,project,state',
        kind: 'project.production',
        state: 'on',
        tenantId: TENANT,
        limit: '500',
        cursor: 'c-1',
      },
      body: undefined,
    });
  });

  it('read: only the window when nothing else is asked', async () => {
    const stub = jsonFetch({ data: [], watermark: page.watermark });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.systemUsage.read(WINDOW);
    expect(asked(stub).query).toEqual(WINDOW);
  });
});

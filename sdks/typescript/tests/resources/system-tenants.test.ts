// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const TENANT = '6f1c2c0e-3b0a-4f1e-9a51-0c1d2e3f4a5b';

describe('systemTenants — wire round-trip', () => {
  it('setProductionAllowed: PUT …/production-allowed with { allowed }', async () => {
    const answer = { tenantId: TENANT, productionAllowed: false };
    const stub = jsonFetch(answer);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemTenants.setProductionAllowed(TENANT, false, { idempotencyKey: 'k-1' }),
    ).toEqual(answer);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `PUT ${API}/v1/system/tenants/${TENANT}/production-allowed`,
    );
    expect(JSON.parse(call.body ?? '{}')).toEqual({ allowed: false });
    expect(call.headers['idempotency-key']).toBe('k-1');
  });

  it('setLimits: PUT …/limits with exactly the limits given', async () => {
    const limits = { apiRequestsPerMinute: 600, runsAtOnce: 20 };
    const stub = jsonFetch({ tenantId: TENANT, limits });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemTenants.setLimits(TENANT, limits)).toEqual({
      tenantId: TENANT,
      limits,
    });
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`PUT ${API}/v1/system/tenants/${TENANT}/limits`);
    expect(JSON.parse(call.body ?? '{}')).toEqual(limits);
  });
});

describe('systemUsage — wire round-trip', () => {
  const page = {
    data: [
      {
        tenantId: TENANT,
        projectId: 'p-1',
        state: 'on' as const,
        count: 1,
        quantity: 0,
        firstAt: '2026-11-02T10:00:00.000Z',
        lastAt: '2026-11-02T10:00:00.000Z',
      },
    ],
    watermark: '2026-11-04T00:00:00.000Z',
  };

  it('read: GET /v1/system/usage, lists joined with commas', async () => {
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemUsage.read({
        from: '2026-11-01T00:00:00Z',
        to: '2026-12-01T00:00:00Z',
        groupBy: ['tenant', 'project', 'state'],
        kind: ['project.production'],
        state: ['on'],
        limit: 500,
        cursor: 'c-1',
      }),
    ).toEqual(page);
    const url = new URL(stub.calls[0]!.url);
    expect(`${stub.calls[0]!.method} ${url.origin}${url.pathname}`).toBe(
      `GET ${API}/v1/system/usage`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
      groupBy: 'tenant,project,state',
      kind: 'project.production',
      state: 'on',
      limit: '500',
      cursor: 'c-1',
    });
  });

  it('read: only the window when nothing else is asked', async () => {
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.systemUsage.read({ from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' });
    const url = new URL(stub.calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
    });
  });
});

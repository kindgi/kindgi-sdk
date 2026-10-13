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

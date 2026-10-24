// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { hangingFetch, jsonFetch, noContentFetch } from '../support/recording-fetch.js';

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

  it('update: PATCH /v1/system/tenants/{id} with the fields given; a 204 resolves to nothing', async () => {
    const stub = noContentFetch();
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemTenants.update(TENANT, { slug: 'acme-store' }, { idempotencyKey: 'k-2' }),
    ).toBeUndefined();
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`PATCH ${API}/v1/system/tenants/${TENANT}`);
    expect(JSON.parse(call.body ?? '{}')).toEqual({ slug: 'acme-store' });
    expect(call.headers['idempotency-key']).toBe('k-2');
  });

  it('limits: GET …/limits, the shape setLimits takes', async () => {
    const answer = { tenantId: TENANT, limits: { runsAtOnce: 20, approvalsPending: 500 } };
    const stub = jsonFetch(answer);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemTenants.limits(TENANT)).toEqual(answer);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`GET ${API}/v1/system/tenants/${TENANT}/limits`);
    expect(call.body).toBeUndefined();
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

describe('systemTenants — P1 routes, wire round-trip', () => {
  const TENANT_ROW = {
    id: TENANT,
    name: 'Acme Store',
    slug: 'acme-store',
    state: 'active',
    createdAt: '2026-10-12T09:00:00.000Z',
    test: false,
    productionAllowed: false,
  };

  it('create: POST /v1/system/tenants with the spec', async () => {
    const answer = { tenant: TENANT_ROW, firstAdmin: { personId: 'p-1' } };
    const stub = jsonFetch(answer, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const spec = {
      name: 'Acme Store',
      productionAllowed: false,
      firstAdmin: { email: 'owner@acme.test', name: 'Ada Owner' },
    };
    expect(await client.systemTenants.create(spec, { idempotencyKey: 'signup:1' })).toEqual(answer);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`POST ${API}/v1/system/tenants`);
    expect(JSON.parse(call.body ?? '{}')).toEqual(spec);
    expect(call.headers['idempotency-key']).toBe('signup:1');
  });

  it('close, setSuspended, setImagePrefix: their paths and bodies', async () => {
    for (const [run, method, path, body] of [
      [(c: ReturnType<typeof createClient>) => c.systemTenants.close(TENANT), 'POST', '/close', {}],
      [
        (c: ReturnType<typeof createClient>) =>
          c.systemTenants.setSuspended(TENANT, true, 'unpaid invoice'),
        'PUT',
        '/suspended',
        { suspended: true, reason: 'unpaid invoice' },
      ],
      [
        (c: ReturnType<typeof createClient>) =>
          c.systemTenants.setImagePrefix(TENANT, 'us-central1-docker.pkg.dev/p/s-1'),
        'PUT',
        '/image-prefix',
        { prefix: 'us-central1-docker.pkg.dev/p/s-1' },
      ],
    ] as const) {
      const stub = jsonFetch(TENANT_ROW);
      const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
      expect(await run(client)).toEqual(TENANT_ROW);
      const call = stub.calls[0]!;
      expect(`${call.method} ${call.url}`).toBe(
        `${method} ${API}/v1/system/tenants/${TENANT}${path}`,
      );
      expect(JSON.parse(call.body ?? '{}')).toEqual(body);
    }
  });

  it('purge: POST …/purge with { confirm }, and what it did comes back', async () => {
    const answer = {
      tenantId: TENANT,
      complete: true,
      alreadyPurged: false,
      purgedAt: '2026-11-20T10:00:15.000Z',
      deleted: [{ table: 'runs', rows: 12 }],
      objectsDeleted: 3,
      authzStoreDeleted: true,
      left: [],
      objectsLeft: 0,
    };
    const stub = jsonFetch(answer);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemTenants.purge(TENANT, 'acme-store', { idempotencyKey: 'purge:1' }),
    ).toEqual(answer);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`POST ${API}/v1/system/tenants/${TENANT}/purge`);
    expect(JSON.parse(call.body ?? '{}')).toEqual({ confirm: 'acme-store' });
    expect(call.headers['idempotency-key']).toBe('purge:1');
  });

  it("purge: timeoutMs is this call's, not part of the request", async () => {
    const stub = hangingFetch();
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await expect(
      client.systemTenants.purge(TENANT, 'acme-store', { timeoutMs: 20 }),
    ).rejects.toMatchObject({ error: { code: 'network', timeoutMs: 20 } });
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({ confirm: 'acme-store' });
  });

  it('list, get and admins read; whoami names the key', async () => {
    const listStub = jsonFetch({ data: [TENANT_ROW] });
    expect(
      await createClient({ apiUrl: API, auth: AUTH, fetch: listStub.fetch }).systemTenants.list({
        limit: 10,
      }),
    ).toEqual({ data: [TENANT_ROW] });
    expect(listStub.calls[0]!.url).toBe(`${API}/v1/system/tenants?limit=10`);
    const admins = [{ userId: 'p-1', email: 'owner@acme.test' }];
    const adminStub = jsonFetch({ data: admins });
    expect(
      await createClient({ apiUrl: API, auth: AUTH, fetch: adminStub.fetch }).systemTenants.admins(
        TENANT,
      ),
    ).toEqual(admins);
    const meStub = jsonFetch({ keyId: 'k-1', scopes: ['system:tenants'] });
    expect(
      await createClient({ apiUrl: API, auth: AUTH, fetch: meStub.fetch }).systemKeys.whoami(),
    ).toEqual({ keyId: 'k-1', scopes: ['system:tenants'] });
    expect(meStub.calls[0]!.url).toBe(`${API}/v1/system/whoami`);
  });
});

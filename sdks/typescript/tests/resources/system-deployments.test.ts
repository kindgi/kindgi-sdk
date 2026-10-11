// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const TENANT = '6f1c2c0e-3b0a-4f1e-9a51-0c1d2e3f4a5b';

const ENTRY = {
  tenantId: TENANT,
  deploymentId: 'dep-1',
  packId: 'acme.aperture',
  imageRef: `us-central1-docker.pkg.dev/acme-shard/s-1/pack@sha256:${'a'.repeat(64)}`,
  imageDigest: `sha256:${'a'.repeat(64)}`,
  artifactVersion: '20261012.1',
  activatedAt: '2026-10-12T09:00:00.000Z',
};
const READY = { status: 'ready', since: '2026-10-12T09:05:00.000Z' };

describe('systemDeployments — wire round-trip', () => {
  it('list: GET /v1/system/deployments with the filter and the page', async () => {
    const page = { data: [{ ...ENTRY, reason: 'superseded' }], hasMore: false };
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemDeployments.list('retire', { cursor: 'c1', limit: 10 })).toEqual(
      page,
    );
    expect(`${stub.calls[0]!.method} ${stub.calls[0]!.url}`).toBe(
      `GET ${API}/v1/system/deployments?endpoint=retire&cursor=c1&limit=10`,
    );
  });

  it('setEndpoint: PUT …/endpoint with the spec, the ids path-encoded', async () => {
    const stub = jsonFetch(READY);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const spec = {
      url: 'https://kp-eslgokebn7iqldfhboiy-123456789012.us-central1.run.app',
      auth: 'google-id-token' as const,
      token: 'pack-token-0123456789abcdef',
    };
    expect(
      await client.systemDeployments.setEndpoint(TENANT, 'dep/1', spec, { idempotencyKey: 'e-1' }),
    ).toEqual(READY);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `PUT ${API}/v1/system/tenants/${TENANT}/deployments/dep%2F1/endpoint`,
    );
    expect(JSON.parse(call.body ?? '{}')).toEqual(spec);
    expect(call.headers['idempotency-key']).toBe('e-1');
  });

  it('clearEndpoint: DELETE …/endpoint', async () => {
    const cleared = { status: 'cleared', since: '2026-10-12T10:00:00.000Z' };
    const stub = jsonFetch(cleared);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemDeployments.clearEndpoint(TENANT, 'dep-1')).toEqual(cleared);
    expect(`${stub.calls[0]!.method} ${stub.calls[0]!.url}`).toBe(
      `DELETE ${API}/v1/system/tenants/${TENANT}/deployments/dep-1/endpoint`,
    );
  });

  it('recordProblem: PUT …/endpoint/problem with the code', async () => {
    const pending = {
      status: 'pending',
      since: '2026-10-12T09:00:00.000Z',
      problem: { code: 'capacity-unavailable', since: '2026-10-12T09:01:00.000Z' },
    };
    const stub = jsonFetch(pending);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemDeployments.recordProblem(TENANT, 'dep-1', {
        code: 'capacity-unavailable',
      }),
    ).toEqual(pending);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `PUT ${API}/v1/system/tenants/${TENANT}/deployments/dep-1/endpoint/problem`,
    );
    expect(JSON.parse(call.body ?? '{}')).toEqual({ code: 'capacity-unavailable' });
  });

  it('setSuspended: PUT …/suspended with the state and reason', async () => {
    const suspension = { suspended: true, since: '2026-10-12T11:00:00.000Z' };
    const stub = jsonFetch(suspension);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const spec = { suspended: true, reason: 'abuse report 7' };
    expect(await client.systemDeployments.setSuspended(TENANT, 'dep-1', spec)).toEqual(suspension);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `PUT ${API}/v1/system/tenants/${TENANT}/deployments/dep-1/suspended`,
    );
    expect(JSON.parse(call.body ?? '{}')).toEqual(spec);
  });
});

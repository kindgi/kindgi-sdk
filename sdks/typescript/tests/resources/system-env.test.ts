// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const TENANT = '6f1c2c0e-3b0a-4f1e-9a51-0c1d2e3f4a5b';
const PROJECT = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';
const PATH = 'projects/acme-prod/secrets/stripe-key/versions/3';
const AT = {
  tenantId: TENANT,
  scope: { kind: 'project' as const, projectId: PROJECT },
  envName: 'production' as never,
};
const QUERY = `envName=production&scopeKind=project&scopeId=${PROJECT}`;
const RECORD = {
  scope: { kind: 'project', id: PROJECT },
  envName: 'production',
  name: 'STRIPE_KEY',
  cloudSecret: PATH,
  revision: 1,
  createdAt: '2026-10-31T00:00:00Z',
  updatedAt: '2026-10-31T00:00:00Z',
};

describe('systemEnv — wire round-trip', () => {
  it('setCloudSecret: PUT …/env/{name} at the scope and env, with { cloudSecret, ifRevision }', async () => {
    const stub = jsonFetch(RECORD);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemEnv.setCloudSecret(
        { ...AT, name: 'STRIPE_KEY', cloudSecret: PATH, ifRevision: 0 },
        { idempotencyKey: 'k-1' },
      ),
    ).toEqual({ kind: 'ok', record: RECORD });
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `PUT ${API}/v1/system/tenants/${TENANT}/env/STRIPE_KEY?${QUERY}`,
    );
    expect(JSON.parse(call.body ?? '{}')).toEqual({ cloudSecret: PATH, ifRevision: 0 });
    expect(call.headers['idempotency-key']).toBe('k-1');
  });

  it('setCloudSecret: a 409 env-write-conflict is the revision-conflict outcome', async () => {
    const stub = errorFetch(409, {
      code: 'env-write-conflict',
      message: 'Stored revision is 4; retry with the current one.',
      details: { currentRevision: 4 },
    });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemEnv.setCloudSecret({
        ...AT,
        name: 'STRIPE_KEY',
        cloudSecret: PATH,
        ifRevision: 3,
      }),
    ).toEqual({ kind: 'revision-conflict', currentRevision: 4 });
  });

  it('setCloudSecret: any other refusal is thrown, with its code', async () => {
    const stub = errorFetch(403, { code: 'system-scope-missing', message: 'no' });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await expect(
      client.systemEnv.setCloudSecret({ ...AT, name: 'STRIPE_KEY', cloudSecret: PATH }),
    ).rejects.toMatchObject({ error: { serverCode: 'system-scope-missing' } });
  });

  it('deleteCloudSecret: DELETE …/env/{name}, { deleted }', async () => {
    const stub = jsonFetch({ deleted: true });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemEnv.deleteCloudSecret({ ...AT, name: 'STRIPE_KEY' })).toEqual({
      deleted: true,
    });
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `DELETE ${API}/v1/system/tenants/${TENANT}/env/STRIPE_KEY?${QUERY}`,
    );
  });

  it('listCloudSecrets: GET …/env with the cursor and limit given', async () => {
    const answer = { data: [RECORD], hasMore: false };
    const stub = jsonFetch(answer);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemEnv.listCloudSecrets({ ...AT, cursor: 'A_KEY' as never, limit: 10 }),
    ).toEqual(answer);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `GET ${API}/v1/system/tenants/${TENANT}/env?${QUERY}&cursor=A_KEY&limit=10`,
    );
  });

  it('a tenant scope sends no scopeId', async () => {
    const stub = jsonFetch({ data: [], hasMore: false });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.systemEnv.listCloudSecrets({ ...AT, scope: { kind: 'tenant' } });
    expect(stub.calls[0]!.url).toBe(
      `${API}/v1/system/tenants/${TENANT}/env?envName=production&scopeKind=tenant`,
    );
  });
});

describe('env.listCloudSecrets — the tenant view', () => {
  it('GET /v1/env/cloud-secrets at the scope and env: names, never a path', async () => {
    const answer = {
      data: [{ ...RECORD, cloudSecret: undefined }].map(({ cloudSecret: _, ...r }) => r),
      hasMore: false,
    };
    const stub = jsonFetch(answer);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.env.listCloudSecrets({ scope: AT.scope, envName: AT.envName })).toEqual(
      answer,
    );
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`GET ${API}/v1/env/cloud-secrets?${QUERY}`);
  });
});

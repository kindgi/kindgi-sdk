// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const P1 = '00000000-0000-4000-8000-0000000000b1';

const WIRE = {
  serviceAccountId: 'sa-1',
  name: 'acme-ci',
  grants: [{ kind: 'project', projectId: P1, role: 'editor' }],
  createdBy: 'user:alice',
  createdAt: '2026-10-07T00:00:00.000Z',
};

const client = (stub: ReturnType<typeof jsonFetch>) =>
  createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });

describe('serviceAccounts', () => {
  it('create POSTs the name and grants', async () => {
    const stub = jsonFetch(WIRE, { status: 201 });
    const created = await client(stub).serviceAccounts.create(
      { name: 'acme-ci', grants: [{ kind: 'project', projectId: P1, role: 'editor' }] },
      { idempotencyKey: 'idem-sa' },
    );
    expect(created).toEqual(WIRE);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/service-accounts');
    expect(req.headers['idempotency-key']).toBe('idem-sa');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      name: 'acme-ci',
      grants: [{ kind: 'project', projectId: P1, role: 'editor' }],
    });
  });

  it('list pages, and asks for unregistered accounts only when told to', async () => {
    const stub = jsonFetch({ data: [WIRE], hasMore: false });
    const page = await client(stub).serviceAccounts.list({ includeUnregistered: true, limit: 5 });
    expect(page.data).toEqual([WIRE]);
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/service-accounts?limit=5&includeUnregistered=true',
    );
  });

  it('get, grant, ungrant and unregister name the account in the path', async () => {
    const cases = [
      ['get', 'GET', 'https://api.example.com/v1/service-accounts/sa-1', undefined],
      [
        'grant',
        'POST',
        'https://api.example.com/v1/service-accounts/sa-1/grant',
        { kind: 'tenant-admin' },
      ],
      [
        'ungrant',
        'POST',
        'https://api.example.com/v1/service-accounts/sa-1/ungrant',
        { kind: 'project', projectId: P1 },
      ],
      ['unregister', 'POST', 'https://api.example.com/v1/service-accounts/sa-1/unregister', {}],
    ] as const;
    for (const [method, verb, url, body] of cases) {
      const stub = jsonFetch(WIRE);
      const sa = client(stub).serviceAccounts;
      if (method === 'get') await sa.get('sa-1');
      if (method === 'grant') await sa.grant('sa-1', { kind: 'tenant-admin' });
      if (method === 'ungrant') await sa.ungrant('sa-1', { kind: 'project', projectId: P1 });
      if (method === 'unregister') await sa.unregister('sa-1');
      const req = stub.calls[0]!;
      expect(req.method, method).toBe(verb);
      expect(req.url, method).toBe(url);
      if (body !== undefined) expect(JSON.parse(req.body ?? 'null'), method).toEqual(body);
    }
  });

  it('a taken name is a conflict; an unknown account a not-found', async () => {
    const taken = errorFetch(409, { code: 'service-account-name-taken', message: 'taken' });
    await expect(client(taken).serviceAccounts.create({ name: 'acme-ci' })).rejects.toMatchObject({
      error: { code: 'conflict', reason: 'service-account-name-taken' },
    });
    const missing = errorFetch(404, { code: 'service-account-not-found', message: 'none' });
    await expect(client(missing).serviceAccounts.get('sa-x')).rejects.toMatchObject({
      error: { code: 'not-found', resource: { kind: 'service-account' } },
    });
  });
});

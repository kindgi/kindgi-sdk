// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const GROUP = {
  id: 'jc-1',
  tenantId: 'tenant-1',
  scope: { kind: 'tenant' },
  name: 'expert',
  weight: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function clientFor(stub: { fetch: typeof fetch }) {
  return createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });
}

describe('correctorGroups.create', () => {
  it('POSTs /v1/corrector-groups with scope, name and weight', async () => {
    const stub = jsonFetch(GROUP, { status: 201 });
    const created = await clientFor(stub).correctorGroups.create(
      {
        scope: { kind: 'agent', projectId: 'proj-1', agentId: 'acme.matcher' },
        name: 'expert',
        weight: 3,
      },
      { idempotencyKey: 'idem-c' },
    );
    expect(created.id).toBe('jc-1');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/corrector-groups');
    expect(req.headers['idempotency-key']).toBe('idem-c');
    expect(JSON.parse(req.body!)).toEqual({
      scope: { kind: 'agent', projectId: 'proj-1', agentId: 'acme.matcher' },
      name: 'expert',
      weight: 3,
    });
  });

  it('surfaces corrector-group-name-taken', async () => {
    const stub = errorFetch(409, { code: 'corrector-group-name-taken', message: 'Taken.' });
    await expect(
      clientFor(stub).correctorGroups.create({
        scope: { kind: 'tenant' },
        name: 'expert',
        weight: 1,
      }),
    ).rejects.toMatchObject({
      error: {
        code: 'conflict',
        reason: 'corrector-group-name-taken',
        serverCode: 'corrector-group-name-taken',
      },
    });
  });
});

describe('correctorGroups.list', () => {
  it('GETs /v1/corrector-groups, encoding the scope', async () => {
    const stub = jsonFetch({ data: [GROUP], hasMore: false });
    const page = await clientFor(stub).correctorGroups.list({
      scope: { kind: 'agent', projectId: 'proj-1', agentId: 'acme.matcher' },
      limit: 5,
    });
    expect(page.data[0]?.name).toBe('expert');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/corrector-groups');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '5',
      scopeKind: 'agent',
      projectId: 'proj-1',
      agentId: 'acme.matcher',
    });
  });

  it('a tenant scope is scopeKind alone', async () => {
    const stub = jsonFetch({ data: [], hasMore: false });
    await clientFor(stub).correctorGroups.list({ scope: { kind: 'tenant' } });
    expect(Object.fromEntries(new URL(stub.calls[0]?.url).searchParams)).toEqual({
      scopeKind: 'tenant',
    });
  });
});

describe('correctorGroups.get / update / unregister', () => {
  it('GETs one group', async () => {
    const stub = jsonFetch(GROUP);
    expect((await clientFor(stub).correctorGroups.get('jc-1')).weight).toBe(3);
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/corrector-groups/jc-1');
  });

  it('PATCHes weight and description', async () => {
    const stub = jsonFetch({ ...GROUP, weight: 5 });
    const updated = await clientFor(stub).correctorGroups.update('jc-1', { weight: 5 });
    expect(updated.weight).toBe(5);
    const req = stub.calls[0]!;
    expect(req.method).toBe('PATCH');
    expect(JSON.parse(req.body!)).toEqual({ weight: 5 });
  });

  it('sends who may assert a group, and null to lift it', async () => {
    const assertableBy = { minReviewerRole: 'senior', principalKinds: ['user'] } as const;
    const stub = jsonFetch({ ...GROUP, assertableBy }, { status: 201 });
    const created = await clientFor(stub).correctorGroups.create({
      scope: { kind: 'tenant' },
      name: 'expert',
      weight: 3,
      assertableBy,
    });
    expect(created.assertableBy).toEqual(assertableBy);
    expect(JSON.parse(stub.calls[0]?.body ?? '{}').assertableBy).toEqual(assertableBy);

    const lifted = jsonFetch(GROUP);
    await clientFor(lifted).correctorGroups.update('jc-1', { assertableBy: null });
    expect(JSON.parse(lifted.calls[0]?.body ?? '{}')).toEqual({ assertableBy: null });
  });

  it('POSTs unregister and returns nothing', async () => {
    const stub = jsonFetch({ correctorGroupId: 'jc-1', unregistered: true });
    expect(await clientFor(stub).correctorGroups.unregister('jc-1')).toBeUndefined();
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/corrector-groups/jc-1/unregister');
  });
});

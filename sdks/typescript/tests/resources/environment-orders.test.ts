// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const client = (fetch: typeof globalThis.fetch) =>
  createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch });

const ORDER = {
  parent: { kind: 'tenant' },
  entries: [{ position: 0, projectId: 'p-a' }, { position: 1 }],
};

describe('environmentOrders.list', () => {
  it('GETs /v1/environment-orders with limit + cursor', async () => {
    const stub = jsonFetch({ data: [ORDER], hasMore: true, nextCursor: 'c1' });
    const page = await client(stub.fetch).environmentOrders.list({
      limit: 10,
      cursor: 'c0' as never,
    });
    expect(page.data).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('c1');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/environment-orders');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('cursor')).toBe('c0');
  });
});

describe('environmentOrders.getTenantOrder', () => {
  it('GETs /v1/environment-orders/tenant, a hidden project is position-only', async () => {
    const stub = jsonFetch(ORDER);
    const order = await client(stub.fetch).environmentOrders.getTenantOrder();
    expect(order.entries[0]?.projectId).toBe('p-a');
    expect(order.entries[1]?.projectId).toBeUndefined();
    expect(new URL(stub.calls[0]?.url).pathname).toBe('/v1/environment-orders/tenant');
    expect(stub.calls[0]?.method).toBe('GET');
  });
});

describe('environmentOrders.setTenantOrder', () => {
  it('PUTs /v1/environment-orders/tenant with projectIds', async () => {
    const stub = jsonFetch(ORDER);
    await client(stub.fetch).environmentOrders.setTenantOrder({
      projectIds: ['p-a', 'p-b'],
    });
    expect(new URL(stub.calls[0]?.url).pathname).toBe('/v1/environment-orders/tenant');
    expect(stub.calls[0]?.method).toBe('PUT');
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({ projectIds: ['p-a', 'p-b'] });
  });

  it('`[]` clears', async () => {
    const stub = jsonFetch({ parent: { kind: 'tenant' }, entries: [] });
    await client(stub.fetch).environmentOrders.setTenantOrder({ projectIds: [] });
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({ projectIds: [] });
  });
});

describe('environmentOrders org routes', () => {
  it('GET encodes the org id in the path', async () => {
    const stub = jsonFetch({ parent: { kind: 'org', orgId: 'o 1' }, entries: [] });
    await client(stub.fetch).environmentOrders.getOrgOrder('o 1');
    expect(new URL(stub.calls[0]?.url).pathname).toBe('/v1/environment-orders/orgs/o%201');
  });

  it('PUT sends projectIds to the org path', async () => {
    const stub = jsonFetch({ parent: { kind: 'org', orgId: 'o1' }, entries: [] });
    await client(stub.fetch).environmentOrders.setOrgOrder('o1', {
      projectIds: ['p-c', 'p-d'],
    });
    expect(new URL(stub.calls[0]?.url).pathname).toBe('/v1/environment-orders/orgs/o1');
    expect(stub.calls[0]?.method).toBe('PUT');
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({ projectIds: ['p-c', 'p-d'] });
  });
});

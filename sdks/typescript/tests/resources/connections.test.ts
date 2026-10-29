// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const EMPTY = { status: 200, body: JSON.stringify({ data: [], hasMore: false }) };

function clientFor(answers: number) {
  const stub = recordingFetch(Array.from({ length: answers }, () => EMPTY));
  const client = createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });
  return { stub, client };
}

const urls = (stub: { readonly calls: readonly { readonly url: string }[] }) =>
  stub.calls.map((c) => new URL(c.url));

describe('connectionApps.list', () => {
  it('GETs /v1/connection-apps, asking for removed ones only when told to', async () => {
    const { stub, client } = clientFor(3);
    await client.connectionApps.list({ includeRemoved: true, limit: 50, cursor: 'c-1' });
    await client.connectionApps.list({ includeRemoved: false });
    await client.connectionApps.list();
    const [asked, declined, plain] = urls(stub);
    expect(asked?.pathname).toBe('/v1/connection-apps');
    expect(Object.fromEntries(asked?.searchParams ?? [])).toEqual({
      includeRemoved: 'true',
      limit: '50',
      cursor: 'c-1',
    });
    expect(declined?.search).toBe('');
    expect(plain?.search).toBe('');
  });
});

describe('connections.list', () => {
  it('GETs /v1/connections with its filters, and includeRemoved only when told to', async () => {
    const { stub, client } = clientFor(2);
    await client.connections.list({
      projectId: 'p-1',
      app: 'google',
      owner: 'me',
      ownerKind: 'member',
      state: 'working',
      includeRemoved: true,
      limit: 10,
    });
    await client.connections.list({ includeRemoved: false });
    const [asked, declined] = urls(stub);
    expect(asked?.pathname).toBe('/v1/connections');
    expect(Object.fromEntries(asked?.searchParams ?? [])).toEqual({
      projectId: 'p-1',
      app: 'google',
      owner: 'me',
      ownerKind: 'member',
      state: 'working',
      includeRemoved: 'true',
      limit: '10',
    });
    expect(declined?.search).toBe('');
  });
});

describe('connections.update', () => {
  it('PATCHes /v1/connections/{connectionId} with its label, and the Idempotency-Key', async () => {
    const connection = { connectionId: 'c 1', label: 'Work mail' };
    const stub = jsonFetch(connection);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const renamed = await client.connections.update(
      'c 1',
      { label: 'Work mail' },
      { idempotencyKey: 'idem-r' },
    );
    expect(renamed).toEqual(connection);
    const [req] = stub.calls;
    expect(req?.method).toBe('PATCH');
    expect(new URL(req?.url ?? '').pathname).toBe('/v1/connections/c%201');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ label: 'Work mail' });
    expect(req?.headers['idempotency-key']).toBe('idem-r');
  });
});

describe('connections.connect and finish', () => {
  it('POSTs /v1/connections with the connection it reconnects', async () => {
    const request = { requestId: 'r-1', reconnects: 'c-1', state: 'pending' };
    const stub = jsonFetch(request, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const made = await client.connections.connect(
      { app: 'google', for: 'company', permissions: ['gmail.send'], reconnects: 'c-1' },
      { idempotencyKey: 'idem-c' },
    );
    expect(made).toEqual(request);
    const [req] = stub.calls;
    expect(req?.method).toBe('POST');
    expect(new URL(req?.url ?? '').pathname).toBe('/v1/connections');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      app: 'google',
      for: 'company',
      permissions: ['gmail.send'],
      reconnects: 'c-1',
    });
    expect(req?.headers['idempotency-key']).toBe('idem-c');
  });

  it("the finish answer says it reconnected, or the name it was to get when that was another's", async () => {
    const stub = jsonFetch({
      kind: 'connected',
      reconnected: false,
      labelTaken: 'support@acme.example',
      connection: { connectionId: 'c-2', label: 'support@acme.example 2' },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const finished = await client.connections.finish({ state: 's-1', code: 'x' });
    expect(finished.reconnected).toBe(false);
    expect(finished.labelTaken).toBe('support@acme.example');
  });
});

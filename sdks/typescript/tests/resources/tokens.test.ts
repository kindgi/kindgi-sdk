// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

describe('tokens.create', () => {
  it('POSTs /v1/tokens with role, capabilities and label, and returns { meta, secret }', async () => {
    const stub = jsonFetch(
      {
        tokenId: 'tok-123',
        token: 'plaintext-secret',
        role: 'member',
        capabilities: ['env:write'],
        label: 'ingest-worker',
        createdBy: 'user:u-1',
        createdAt: '2026-10-03T00:00:00Z',
        expiresAt: '2027-01-01T00:00:00Z',
      },
      { status: 201 },
    );
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.tokens.create(
      { role: 'member', capabilities: ['env:write'], label: 'ingest-worker' },
      { idempotencyKey: 'idem-1' },
    );

    expect(result.secret).toBe('plaintext-secret');
    expect(result.meta).toEqual({
      id: 'tok-123',
      role: 'member',
      capabilities: ['env:write'],
      label: 'ingest-worker',
      createdBy: 'user:u-1',
      createdAt: '2026-10-03T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
    });
    expect(result.meta).not.toHaveProperty('token');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/tokens');
    expect(req.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      role: 'member',
      capabilities: ['env:write'],
      label: 'ingest-worker',
    });
  });

  it('with no spec, sends an empty body (a member key with no capabilities)', async () => {
    const stub = jsonFetch(
      {
        tokenId: 't',
        token: 's',
        role: 'member',
        capabilities: [],
        createdAt: '2026-10-03T00:00:00Z',
      },
      { status: 201 },
    );
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await client.tokens.create();
    expect(JSON.parse(stub.calls[0]?.body ?? 'null')).toEqual({});
  });
});

describe('tokens.list / tokens.get', () => {
  it('GETs /v1/tokens with paging and maps the page', async () => {
    const stub = jsonFetch({
      data: [
        {
          tokenId: 'tok-2',
          role: 'admin',
          capabilities: [],
          createdAt: '2026-10-03T00:00:02Z',
          revokedAt: '2026-10-03T01:00:00Z',
        },
      ],
      hasMore: true,
      nextCursor: 'next',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const page = await client.tokens.list({ limit: 1, cursor: 'c0' as never });
    const token = {
      id: 'tok-2',
      role: 'admin',
      capabilities: [],
      createdAt: '2026-10-03T00:00:02Z',
      revokedAt: '2026-10-03T01:00:00Z',
    };
    expect(page).toEqual({ data: [token], hasMore: true, nextCursor: 'next' });
    expect(page.items).toEqual([token]);
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/tokens?limit=1&cursor=c0');
  });

  it('GETs /v1/tokens/{tokenId}', async () => {
    const stub = jsonFetch({
      tokenId: 'tok-9',
      role: 'member',
      capabilities: ['env:write'],
      createdAt: '2026-10-03T00:00:00Z',
      lastUsedAt: '2026-10-03T02:00:00Z',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const key = await client.tokens.get('tok-9' as never);
    expect(key).toMatchObject({ id: 'tok-9', lastUsedAt: '2026-10-03T02:00:00Z' });
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/tokens/tok-9');
  });
});

describe('tokens.revoke', () => {
  it('POSTs /v1/tokens/{tokenId}/revoke and resolves void', async () => {
    const stub = jsonFetch({ tokenId: 'tok-9', revoked: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.tokens.revoke('tok-9' as never, { idempotencyKey: 'idem-r' });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/tokens/tok-9/revoke');
    expect(req.headers['idempotency-key']).toBe('idem-r');
  });

  it('maps 404 not-found to NotFoundError', async () => {
    const stub = errorFetch(404, { code: 'not-found', message: 'no such token' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.tokens.revoke('tok-x' as never)).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

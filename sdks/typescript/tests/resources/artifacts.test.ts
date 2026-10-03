// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_BLOB = {
  blobId: 'blob-1',
  tenantId: '00000000-0000-4000-8000-000000000002',
  name: 'contract.pdf',
  contentType: 'application/pdf',
  size: 12345,
  hash: 'a'.repeat(64),
  tags: {},
  createdAt: '2026-09-20T00:00:00Z',
};

describe('artifacts.list', () => {
  it('GETs /v1/artifacts with contentType/ownerRunId filters', async () => {
    const stub = jsonFetch({ data: [WIRE_BLOB], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.artifacts.list({
      contentType: 'application/pdf',
      ownerRunId: 'r-1' as never,
      limit: 20,
    });

    expect(page.items[0]?.blobId).toBe('blob-1');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/artifacts');
    expect(url.searchParams.get('contentType')).toBe('application/pdf');
    expect(url.searchParams.get('ownerRunId')).toBe('r-1');
  });
});

describe('artifacts.delete', () => {
  it('DELETEs /v1/artifacts/{blobId} and returns { blobId, deleted }', async () => {
    const stub = jsonFetch({ blobId: 'blob-1', deleted: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const r = await client.artifacts.delete('blob-1' as never, { idempotencyKey: 'idem-d' });
    expect(r.deleted).toBe(true);
    const req = stub.calls[0]!;
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('https://api.example.com/v1/artifacts/blob-1');
    expect(req.headers['idempotency-key']).toBe('idem-d');
  });

  it('maps 404 blob-not-found to NotFoundError', async () => {
    const stub = errorFetch(404, { code: 'blob-not-found', message: 'no such blob' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.artifacts.delete('blob-x' as never)).rejects.toMatchObject({
      error: { code: 'not-found', resource: { kind: 'blob' } },
    });
  });
});

describe('artifacts not-yet-wired surface', () => {
  it('put / get / presign / setRetentionLock throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.artifacts.put({ contentType: 'text/plain', body: new Uint8Array() }),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'artifacts.put' },
    });
    await expect(
      client.artifacts.get({
        provider: 'fs',
        bucket: 'b',
        key: 'k',
        size: 0,
        sha256: 'x',
        contentType: 'text/plain',
        tenantId: 't' as never,
        createdAt: '2026-09-20' as never,
      }),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'artifacts.get' },
    });
    await expect(
      client.artifacts.presign({ operation: 'put', contentType: 'text/plain' }),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'artifacts.presign' },
    });
    await expect(
      client.artifacts.setRetentionLock(
        {
          provider: 'fs',
          bucket: 'b',
          key: 'k',
          size: 0,
          sha256: 'x',
          contentType: 'text/plain',
          tenantId: 't' as never,
          createdAt: '2026-09-20' as never,
        },
        '2027-01-01' as never,
      ),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'artifacts.setRetentionLock' },
    });
    expect(stub.calls.length).toBe(0);
  });
});

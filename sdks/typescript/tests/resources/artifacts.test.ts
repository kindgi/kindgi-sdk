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

describe('artifacts.upload / download', () => {
  /** A fetch that keeps the request (FormData included) and answers with `res`. */
  function capture(res: () => Response) {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return res();
    }) as typeof fetch;
    return { seen, fetchImpl };
  }

  it('upload POSTs a multipart form with the file and its fields', async () => {
    const stub = capture(
      () =>
        new Response(JSON.stringify({ ...WIRE_BLOB, projectId: 'p-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetchImpl,
    });
    const meta = await client.artifacts.upload(
      {
        body: 'hello',
        name: 'note.txt',
        contentType: 'text/plain',
        projectId: 'p-1',
        tags: { k: 'v' },
      },
      { idempotencyKey: 'idem-a' },
    );
    expect(meta).toMatchObject({ blobId: 'blob-1', projectId: 'p-1' });
    const { url, init } = stub.seen[0]!;
    expect([url, init.method]).toEqual(['https://api.example.com/v1/artifacts', 'POST']);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-a');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    const form = init.body as FormData;
    expect(await (form.get('file') as Blob).text()).toBe('hello');
    expect([
      form.get('name'),
      form.get('contentType'),
      form.get('projectId'),
      form.get('tags'),
    ]).toEqual(['note.txt', 'text/plain', 'p-1', '{"k":"v"}']);
  });

  it('download streams the bytes with what the headers say', async () => {
    const stub = capture(
      () =>
        new Response('hello', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': '5',
            'x-kindgi-blob-hash': 'b'.repeat(64),
            'x-kindgi-blob-name': encodeURIComponent('my note.txt'),
          },
        }),
    );
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetchImpl,
    });
    const got = await client.artifacts.download('blob 1' as never);
    expect(stub.seen[0]!.url).toBe('https://api.example.com/v1/artifacts/blob%201');
    expect([got.name, got.contentType, got.size, got.hash]).toEqual([
      'my note.txt',
      'text/plain',
      5,
      'b'.repeat(64),
    ]);
    expect(await new Response(got.body).text()).toBe('hello');
  });

  it('head reads the headers with HEAD, no body', async () => {
    const stub = capture(
      () =>
        new Response(null, {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': '5',
            'x-kindgi-blob-hash': 'c'.repeat(64),
          },
        }),
    );
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetchImpl,
    });
    expect(await client.artifacts.head('b-1' as never)).toEqual({
      blobId: 'b-1',
      name: '',
      contentType: 'text/plain',
      size: 5,
      hash: 'c'.repeat(64),
    });
    expect(stub.seen[0]!.init.method).toBe('HEAD');
  });

  it("head's 404 (no body) is a not-found that says so", async () => {
    const stub = capture(() => new Response(null, { status: 404 }));
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetchImpl,
    });
    await expect(client.artifacts.head('gone' as never)).rejects.toMatchObject({
      message: "No such artifact, or it's in a project you can't read",
      error: { code: 'not-found' },
    });
  });

  it('a refusal throws the wire error: over the cap, or not found', async () => {
    const tooBig = capture(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'artifact-too-large', message: 'too big', requestId: 'r' },
          }),
          { status: 413, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: tooBig.fetchImpl,
    });
    await expect(client.artifacts.upload({ body: 'x' })).rejects.toMatchObject({
      message: 'too big',
      error: { code: 'invalid-request' },
    });
    const missing = errorFetch(404, { code: 'blob-not-found', message: 'none' });
    const c2 = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: missing.fetch,
    });
    await expect(c2.artifacts.download('b' as never)).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

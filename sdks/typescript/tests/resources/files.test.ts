// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const FILE_ID = '00000000-0000-4000-8000-0000000000f1';

const WIRE_VERSION = {
  fileId: FILE_ID,
  version: 2,
  blobId: '00000000-0000-4000-8000-0000000000b2',
  name: 'contract.txt',
  contentType: 'text/plain',
  size: 120,
  hash: 'a'.repeat(64),
  tags: {},
  parentVersion: 1,
  madeVia: 'upload',
  createdBy: 'user:u-1',
  createdAt: '2026-11-05T08:00:00Z',
};

const WIRE_FILE = {
  fileId: FILE_ID,
  tenantId: '00000000-0000-4000-8000-000000000002',
  projectId: 'p-1',
  name: 'contract.txt',
  latestVersion: 2,
  highestVersion: 2,
  pinnedVersions: [],
  latest: WIRE_VERSION,
  createdAt: '2026-11-05T07:00:00Z',
  updatedAt: '2026-11-05T08:00:00Z',
};

/** A fetch that keeps the request (FormData included) and answers with `res`. */
function capture(res: () => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return res();
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** A queued 200 answer for `recordingFetch`. */
const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('files.list / get / delete / pinHistory', () => {
  it('list GETs /v1/files with its filters', async () => {
    const stub = jsonFetch({ data: [WIRE_FILE], hasMore: true, nextCursor: 'c-2' });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });

    const page = await client.files.list({
      ownerRunId: 'r-1',
      projectId: 'p-1',
      contentType: 'text/markdown',
      limit: 20,
      cursor: 'c-1' as never,
    });

    expect([page.data[0]?.fileId, page.hasMore, page.nextCursor]).toEqual([FILE_ID, true, 'c-2']);
    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe('/v1/files');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ownerRunId: 'r-1',
      projectId: 'p-1',
      contentType: 'text/markdown',
      limit: '20',
      cursor: 'c-1',
    });
  });

  it('get reads one file, and delete DELETEs it with an idempotency key', async () => {
    const got = jsonFetch(WIRE_FILE);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: got.fetch });
    expect((await client.files.get(FILE_ID)).latestVersion).toBe(2);
    expect([got.calls[0]!.method, got.calls[0]!.url]).toEqual([
      'GET',
      `${API}/v1/files/${FILE_ID}`,
    ]);

    const del = jsonFetch({ fileId: FILE_ID, deleted: true });
    const c2 = createClient({ apiUrl: API, auth: AUTH, fetch: del.fetch });
    expect(await c2.files.delete(FILE_ID, { idempotencyKey: 'idem-d' })).toEqual({
      fileId: FILE_ID,
      deleted: true,
    });
    const req = del.calls[0]!;
    expect([req.method, req.url]).toEqual(['DELETE', `${API}/v1/files/${FILE_ID}`]);
    expect(req.headers['idempotency-key']).toBe('idem-d');
  });

  it('pinHistory GETs the pin history, a page at a time', async () => {
    const change = {
      changeId: 'ch-1',
      fileId: FILE_ID,
      version: 1,
      change: 'pin',
      by: 'user:u-1',
      at: '2026-11-05T08:00:00Z',
      reason: 'signed',
    };
    const stub = jsonFetch({ data: [change], hasMore: false });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });

    const page = await client.files.pinHistory(FILE_ID, { limit: 5 });
    expect(page.data[0]?.change).toBe('pin');
    const url = new URL(stub.calls[0]!.url);
    expect([url.pathname, url.searchParams.get('limit')]).toEqual([
      `/v1/files/${FILE_ID}/pin-history`,
      '5',
    ]);
  });
});

describe('files.create / versions.add', () => {
  it('create POSTs a multipart form with the file and its fields', async () => {
    const stub = capture(() =>
      json({ version: { ...WIRE_VERSION, version: 1 }, created: true }, 201),
    );
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetchImpl });

    const write = await client.files.create(
      {
        body: 'hello',
        name: 'note.txt',
        contentType: 'text/plain',
        ownerRunId: 'r-1',
        tags: { k: 'v' },
      },
      { idempotencyKey: 'idem-c' },
    );

    expect([write.created, write.version.version]).toEqual([true, 1]);
    const { url, init } = stub.seen[0]!;
    expect([url, init.method]).toEqual([`${API}/v1/files`, 'POST']);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-c');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    const form = init.body as FormData;
    expect(await (form.get('file') as Blob).text()).toBe('hello');
    expect([
      form.get('name'),
      form.get('contentType'),
      form.get('ownerRunId'),
      form.get('projectId'),
      form.get('tags'),
    ]).toEqual(['note.txt', 'text/plain', 'r-1', null, '{"k":"v"}']);
  });

  it('versions.add sends expectedVersion, and passes created: false through', async () => {
    const stub = capture(() => json({ version: WIRE_VERSION, created: false }));
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetchImpl });

    const write = await client.files.versions.add(FILE_ID, {
      body: new Blob(['same'], { type: 'text/markdown' }),
      expectedVersion: 2,
    });

    expect([write.created, write.version.version]).toEqual([false, 2]);
    const { url, init } = stub.seen[0]!;
    expect([url, init.method]).toEqual([`${API}/v1/files/${FILE_ID}/versions`, 'POST']);
    const form = init.body as FormData;
    expect([form.get('expectedVersion'), form.get('contentType'), form.get('name')]).toEqual([
      '2',
      'text/markdown',
      null,
    ]);
  });

  it('a Latest that moved is a conflict with both numbers', async () => {
    const stub = capture(() =>
      json(
        {
          error: {
            code: 'file-version-conflict',
            message: 'Latest is version 5, not 4',
            requestId: 'r',
            details: { expectedVersion: 4, latestVersion: 5 },
          },
        },
        409,
      ),
    );
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetchImpl });

    await expect(
      client.files.versions.add(FILE_ID, { body: 'x', expectedVersion: 4 }),
    ).rejects.toMatchObject({
      error: {
        code: 'conflict',
        reason: 'file-version-conflict',
        fields: { expectedVersion: 4, latestVersion: 5 },
      },
    });
  });

  it('over the cap is an invalid request, file-too-large', async () => {
    const stub = capture(() =>
      json({ error: { code: 'file-too-large', message: 'too big', requestId: 'r' } }, 413),
    );
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetchImpl });

    await expect(client.files.create({ body: 'x' })).rejects.toMatchObject({
      message: 'too big',
      error: { code: 'invalid-request' },
    });
  });
});

describe('files.versions', () => {
  it('list and get name a version, or latest', async () => {
    const listed = jsonFetch({ data: [WIRE_VERSION], hasMore: false });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: listed.fetch });
    expect((await client.files.versions.list(FILE_ID)).data[0]?.version).toBe(2);
    expect(new URL(listed.calls[0]!.url).pathname).toBe(`/v1/files/${FILE_ID}/versions`);

    const got = recordingFetch([ok(WIRE_VERSION), ok(WIRE_VERSION)]);
    const c2 = createClient({ apiUrl: API, auth: AUTH, fetch: got.fetch });
    await c2.files.versions.get(FILE_ID, 'latest');
    await c2.files.versions.get(FILE_ID, 1);
    expect(got.calls.map((c) => c.url)).toEqual([
      `${API}/v1/files/${FILE_ID}/versions/latest`,
      `${API}/v1/files/${FILE_ID}/versions/1`,
    ]);
  });

  it('download streams the bytes, naming the version it served', async () => {
    const stub = capture(
      () =>
        new Response('# Contract', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': '10',
            'x-kindgi-blob-hash': 'b'.repeat(64),
            'x-kindgi-blob-name': encodeURIComponent('my contract.txt'),
            'x-kindgi-file-version': '3',
          },
        }),
    );
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetchImpl });

    const got = await client.files.versions.download(FILE_ID, 'latest');

    expect(stub.seen[0]!.url).toBe(`${API}/v1/files/${FILE_ID}/versions/latest/content`);
    expect([got.fileId, got.version, got.name, got.contentType, got.size, got.hash]).toEqual([
      FILE_ID,
      3,
      'my contract.txt',
      'text/plain',
      10,
      'b'.repeat(64),
    ]);
    expect(await new Response(got.body).text()).toBe('# Contract');
  });

  it("a version that's gone is not-found, never Latest", async () => {
    const stub = errorFetch(404, { code: 'file-version-not-found', message: 'gone' });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });

    await expect(client.files.versions.download(FILE_ID, 2)).rejects.toMatchObject({
      error: { code: 'not-found', resource: { kind: 'file-version' } },
    });
  });

  it('restore, pin and unpin POST their bodies', async () => {
    const stub = recordingFetch([
      ok({ version: { ...WIRE_VERSION, version: 3, restoredFrom: 1 }, created: true }),
      ok({
        ...WIRE_VERSION,
        pin: { by: 'user:u-1', at: '2026-11-05T08:00:00Z', reason: 'signed' },
      }),
      ok(WIRE_VERSION),
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.files.versions.restore(
      FILE_ID,
      1,
      { expectedVersion: 2 },
      { idempotencyKey: 'idem-r' },
    );
    await client.files.versions.pin(FILE_ID, 1, { reason: 'signed' });
    await client.files.versions.unpin(FILE_ID, 1);

    expect(stub.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', `${API}/v1/files/${FILE_ID}/versions/1/restore`, '{"expectedVersion":2}'],
      ['POST', `${API}/v1/files/${FILE_ID}/versions/1/pin`, '{"reason":"signed"}'],
      ['POST', `${API}/v1/files/${FILE_ID}/versions/1/unpin`, '{}'],
    ]);
    expect(stub.calls[0]!.headers['idempotency-key']).toBe('idem-r');
  });

  it("delete DELETEs one version; a pinned one, or the file's last, is a conflict", async () => {
    const del = jsonFetch({ fileId: FILE_ID, version: 2, deleted: true });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: del.fetch });
    expect((await client.files.versions.delete(FILE_ID, 2)).version).toBe(2);
    expect([del.calls[0]!.method, del.calls[0]!.url]).toEqual([
      'DELETE',
      `${API}/v1/files/${FILE_ID}/versions/2`,
    ]);

    for (const code of ['file-version-pinned', 'file-last-version']) {
      const refused = errorFetch(409, { code, message: 'no' });
      const c2 = createClient({ apiUrl: API, auth: AUTH, fetch: refused.fetch });
      await expect(c2.files.versions.delete(FILE_ID, 1)).rejects.toMatchObject({
        error: { code: 'conflict', reason: code },
      });
    }
  });
});

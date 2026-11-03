// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import aws4 from 'aws4';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { BlobMeta, BlobPutInput, BlobStorageBinding } from '@kindgi/blob-binding';
import type { ArtifactId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { createApp } from '../src/app.js';
import type { RunHandlerBinding } from '../src/index.js';
import { canonicalRequest, parseSigV4 } from '../src/middleware/sigv4-verify.js';
import { sigv4Middleware } from '../src/middleware/sigv4.js';
import type { S3CredentialBinding } from '../src/s3-credential-binding.js';
import { createStubAppBindings } from '../src/testing/app-bindings.js';
import type { AppEnv } from '../src/types.js';

// aws4 is an independent SigV4 implementation (the one most JS S3 clients
// use): every case signs with it and verifies with our middleware.
const { RequestSigner } = aws4;

const ACCESS_KEY = 'AKIAKINDGITEST000001';
const SECRET_KEY = 'kindgi-test-secret-key-0000000000000000000';
const BUCKET = 'artifacts';
const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const T0 = new Date('2026-09-30T12:00:00.900Z');
const MiB = 1024 * 1024;

const credentials: S3CredentialBinding = {
  async resolve(accessKeyId) {
    return accessKeyId === ACCESS_KEY
      ? ({ accessKeyId, secretKey: SECRET_KEY, tenantId: TENANT, bucket: BUCKET } as never)
      : null;
  },
};

function makeApp(maxBytes = MiB) {
  const app = new Hono<AppEnv>();
  app.use('/s3/*', sigv4Middleware(credentials, maxBytes));
  app.all('/s3/*', async (c) =>
    c.json({ bucket: c.get('bucket'), tenantId: c.get('tenantId'), body: await c.req.text() }),
  );
  return app;
}

interface Signed {
  readonly url: string;
  readonly init: RequestInit;
}

function sign(input: {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
  secret?: string;
}): Signed {
  const body = input.body ?? '';
  const opts = {
    host: 'localhost',
    method: input.method,
    path: input.path,
    service: 's3',
    region: 'us-east-1',
    headers: { host: 'localhost', ...input.headers } as Record<string, string>,
    body,
  };
  new RequestSigner(opts, {
    accessKeyId: ACCESS_KEY,
    secretAccessKey: input.secret ?? SECRET_KEY,
  }).sign();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) headers[k] = String(v);
  return {
    url: `http://localhost${input.path}`,
    init: {
      method: input.method,
      headers,
      ...(body.length > 0 && { body, duplex: 'half' }),
    } as RequestInit,
  };
}

function presign(path: string, expiresSeconds: number): string {
  const sep = path.includes('?') ? '&' : '?';
  const opts = {
    host: 'localhost',
    method: 'GET',
    path: `${path}${sep}X-Amz-Expires=${expiresSeconds}`,
    service: 's3',
    region: 'us-east-1',
    signQuery: true,
  };
  new RequestSigner(opts, { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }).sign();
  return `http://localhost${opts.path}`;
}

/** A body streamed in `chunk`-byte pieces up to `total`, counting what was pulled. */
function counted(total: number, chunk = 64 * 1024) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close();
      pulled += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(0x78));
    },
  });
  return { stream, pulled: () => pulled };
}

/** A signed request sent with `body`, which its signature doesn't cover. */
function withBody(req: Signed, body: ReadableStream<Uint8Array>): RequestInit {
  return { ...req.init, body, duplex: 'half' } as RequestInit;
}

/** Signed for a body the signature doesn't cover. */
const UNSIGNED = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };

async function codeOf(res: Response): Promise<string> {
  return /<Code>([^<]+)<\/Code>/.exec(await res.text())?.[1] ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SigV4 header auth — the client’s timestamp is what gets verified', () => {
  test('GET signed and verified in the same second → 200', async () => {
    const req = sign({ method: 'GET', path: `/s3/${BUCKET}/a.txt` });
    const res = await makeApp().request(req.url, req.init);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bucket: BUCKET, tenantId: TENANT });
  });

  test('verification in a later second than signing still passes', async () => {
    const req = sign({ method: 'PUT', path: `/s3/${BUCKET}/a.txt`, body: 'hello' });
    vi.setSystemTime(new Date(T0.getTime() + 2_300));
    const res = await makeApp().request(req.url, req.init);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ body: 'hello' });
  });

  test('14 minutes of clock skew is accepted, both directions', async () => {
    for (const offset of [14 * 60_000, -14 * 60_000]) {
      vi.setSystemTime(T0);
      const req = sign({ method: 'GET', path: `/s3/${BUCKET}/a.txt` });
      vi.setSystemTime(new Date(T0.getTime() + offset));
      const res = await makeApp().request(req.url, req.init);
      expect(res.status, `offset ${offset}`).toBe(200);
    }
  });

  test('more than 15 minutes of skew → 403 RequestTimeTooSkewed', async () => {
    for (const offset of [16 * 60_000, -16 * 60_000]) {
      vi.setSystemTime(T0);
      const req = sign({ method: 'GET', path: `/s3/${BUCKET}/a.txt` });
      vi.setSystemTime(new Date(T0.getTime() + offset));
      const res = await makeApp().request(req.url, req.init);
      expect(res.status, `offset ${offset}`).toBe(403);
      expect(await codeOf(res)).toBe('RequestTimeTooSkewed');
    }
  });
});

describe('SigV4 header auth — only the headers the client signed count', () => {
  test('headers added after signing (proxy / HTTP stack) are ignored', async () => {
    const req = sign({ method: 'PUT', path: `/s3/${BUCKET}/a.txt`, body: 'x' });
    const headers = {
      ...(req.init.headers as Record<string, string>),
      'x-forwarded-for': '203.0.113.7',
      'accept-encoding': 'gzip, br',
      'user-agent': 'some-client/1.0',
    };
    const res = await makeApp().request(req.url, { ...req.init, headers });
    expect(res.status).toBe(200);
  });

  test('a signed header changed after signing → 403 SignatureDoesNotMatch', async () => {
    const req = sign({
      method: 'PUT',
      path: `/s3/${BUCKET}/a.txt`,
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    });
    const headers = {
      ...(req.init.headers as Record<string, string>),
      'content-type': 'text/html',
    };
    const res = await makeApp().request(req.url, { ...req.init, headers });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SignatureDoesNotMatch');
  });

  test('a signed header removed after signing → 403 SignatureDoesNotMatch', async () => {
    const req = sign({
      method: 'GET',
      path: `/s3/${BUCKET}/a.txt`,
      headers: { 'x-amz-meta-owner': 'ops' },
    });
    const { 'x-amz-meta-owner': _dropped, ...headers } = req.init.headers as Record<string, string>;
    const res = await makeApp().request(req.url, { ...req.init, headers });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SignatureDoesNotMatch');
  });

  test('body swapped after signing → 400 XAmzContentSHA256Mismatch', async () => {
    const req = sign({ method: 'PUT', path: `/s3/${BUCKET}/a.txt`, body: 'good' });
    const res = await makeApp().request(req.url, { ...req.init, body: 'evil' });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('XAmzContentSHA256Mismatch');
  });

  test('wrong secret → 403 SignatureDoesNotMatch', async () => {
    const req = sign({ method: 'GET', path: `/s3/${BUCKET}/a.txt`, secret: 'not-the-secret' });
    const res = await makeApp().request(req.url, req.init);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SignatureDoesNotMatch');
  });

  test('credential-scope date that disagrees with x-amz-date → 403', async () => {
    const req = sign({ method: 'GET', path: `/s3/${BUCKET}/a.txt` });
    const headers = { ...(req.init.headers as Record<string, string>) };
    const auth = headers.Authorization as string;
    headers.Authorization = auth.replace(/\/\d{8}\//, '/20260929/');
    const res = await makeApp().request(req.url, { ...req.init, headers });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SignatureDoesNotMatch');
  });

  test('missing Authorization → 403 AccessDenied; unknown key → 403 InvalidAccessKeyId', async () => {
    const bare = await makeApp().request(`http://localhost/s3/${BUCKET}/a.txt`, {
      headers: { host: 'localhost' },
    });
    expect(bare.status).toBe(403);
    expect(await codeOf(bare)).toBe('AccessDenied');

    const req = sign({ method: 'GET', path: `/s3/${BUCKET}/a.txt` });
    const headers = { ...(req.init.headers as Record<string, string>) };
    headers.Authorization = (headers.Authorization as string).replace(
      ACCESS_KEY,
      'AKIAUNKNOWN000000000',
    );
    const res = await makeApp().request(req.url, { ...req.init, headers });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('InvalidAccessKeyId');
  });

  test('wrong bucket for the credential → 403 AccessDenied', async () => {
    const req = sign({ method: 'GET', path: '/s3/other-bucket/a.txt' });
    const res = await makeApp().request(req.url, req.init);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('AccessDenied');
  });
});

describe('the body: read once the request is signed for its bucket, under the limit', () => {
  test('a request not signed for its bucket is refused before its body is read', async () => {
    const path = `/s3/${BUCKET}/a.bin`;
    const unknownKey = sign({ method: 'PUT', path, headers: UNSIGNED });
    const headers = { ...(unknownKey.init.headers as Record<string, string>) };
    headers.Authorization = (headers.Authorization as string).replace(
      ACCESS_KEY,
      'AKIAUNKNOWN000000000',
    );
    const refused: Record<string, Signed> = {
      'no signature': { url: `http://localhost${path}`, init: { method: 'PUT', headers: {} } },
      'an unknown key': { url: unknownKey.url, init: { ...unknownKey.init, headers } },
      'a wrong secret': sign({ method: 'PUT', path, headers: UNSIGNED, secret: 'not-the-secret' }),
      'another bucket': sign({ method: 'PUT', path: '/s3/other-bucket/a.bin', headers: UNSIGNED }),
    };
    for (const [name, req] of Object.entries(refused)) {
      const body = counted(20 * MiB);
      const res = await makeApp().request(req.url, withBody(req, body.stream));
      expect(res.status, name).toBe(403);
      expect(body.pulled(), name).toBeLessThanOrEqual(64 * 1024);
    }
  });

  test('a body over the limit → 400 EntityTooLarge, unread by its declared length or as soon as a streamed one passes it', async () => {
    const path = `/s3/${BUCKET}/a.bin`;
    const declared = counted(20 * MiB);
    const byLength = sign({
      method: 'PUT',
      path,
      headers: { ...UNSIGNED, 'content-length': String(20 * MiB) },
    });
    const refusedByLength = await makeApp().request(
      byLength.url,
      withBody(byLength, declared.stream),
    );
    expect(refusedByLength.status).toBe(400);
    expect(await codeOf(refusedByLength)).toBe('EntityTooLarge');
    expect(declared.pulled()).toBeLessThanOrEqual(64 * 1024);

    const streamed = counted(20 * MiB);
    const asStreamed = sign({ method: 'PUT', path, headers: UNSIGNED });
    const refusedAsStreamed = await makeApp().request(
      asStreamed.url,
      withBody(asStreamed, streamed.stream),
    );
    expect(refusedAsStreamed.status).toBe(400);
    expect(await codeOf(refusedAsStreamed)).toBe('EntityTooLarge');
    expect(streamed.pulled()).toBeLessThanOrEqual(MiB + 2 * 64 * 1024);
  });

  test('a body at the limit is read whole, and is what the route reads', async () => {
    const body = 'x'.repeat(MiB);
    const req = sign({ method: 'PUT', path: `/s3/${BUCKET}/a.bin`, body });
    const res = await makeApp().request(req.url, req.init);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { body: string }).body).toBe(body);
  });

  test('a body dropped after signing → 400 XAmzContentSHA256Mismatch', async () => {
    // Signed for a body, with no length to sign (a chunked upload's shape), and sent without it.
    const req = sign({
      method: 'PUT',
      path: `/s3/${BUCKET}/a.txt`,
      headers: { 'x-amz-content-sha256': createHash('sha256').update('good').digest('hex') },
    });
    const res = await makeApp().request(req.url, req.init);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('XAmzContentSHA256Mismatch');
  });
});

describe("the app's S3 routes: `artifactMaxBytes`, and the body the middleware read", () => {
  function s3App(artifactMaxBytes = 16) {
    const objects: { key: string; bytes: string }[] = [];
    const parts: { partNumber: number; bytes: string }[] = [];
    const completed: (readonly { partNumber: number; etag: string }[])[] = [];
    const text = (bytes: BlobPutInput['bytes']) => new TextDecoder().decode(bytes as Uint8Array);
    const blobStorage = {
      async putByKey(_tenant: TenantId, _bucket: string, key: string, input: BlobPutInput) {
        objects.push({ key, bytes: text(input.bytes) });
        return { kind: 'ok', value: { hash: 'object-hash' } as BlobMeta };
      },
      async uploadPart(
        _tenant: TenantId,
        _bucket: string,
        _key: string,
        _uploadId: string,
        partNumber: number,
        bytes: Uint8Array,
      ) {
        parts.push({ partNumber, bytes: text(bytes) });
        return { kind: 'ok', value: { etag: 'part-etag' } };
      },
      async completeMultipartUpload(
        _tenant: TenantId,
        _bucket: string,
        _key: string,
        _uploadId: string,
        declared: readonly { partNumber: number; etag: string }[],
      ) {
        completed.push(declared);
        return { kind: 'ok', value: { hash: 'multipart-hash' } as BlobMeta };
      },
    } as unknown as BlobStorageBinding;
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: async () => null,
      runHandler: {} as RunHandlerBinding,
      blobStorage,
      s3Credentials: credentials,
      artifactMaxBytes,
    });
    return { app, objects, parts, completed };
  }

  test('an object or a part over `artifactMaxBytes` → 400 EntityTooLarge; at it, stored as sent', async () => {
    const { app, objects, parts } = s3App();
    const object = `/s3/${BUCKET}/notes.txt`;
    const part = `${object}?partNumber=1&uploadId=upload-1`;
    for (const path of [object, part]) {
      const over = sign({ method: 'PUT', path, body: 'x'.repeat(17) });
      const refused = await app.request(over.url, over.init);
      expect(refused.status, path).toBe(400);
      expect(await codeOf(refused), path).toBe('EntityTooLarge');
    }
    expect(objects).toEqual([]);
    expect(parts).toEqual([]);

    const putObject = sign({ method: 'PUT', path: object, body: 'sixteen bytes ok' });
    expect((await app.request(putObject.url, putObject.init)).status).toBe(200);
    const putPart = sign({ method: 'PUT', path: part, body: 'a part, sixteen.' });
    expect((await app.request(putPart.url, putPart.init)).status).toBe(200);
    expect(objects).toEqual([{ key: 'notes.txt', bytes: 'sixteen bytes ok' }]);
    expect(parts).toEqual([{ partNumber: 1, bytes: 'a part, sixteen.' }]);
  });

  test('CompleteMultipartUpload reads its parts from the body the middleware read', async () => {
    const { app, completed } = s3App(1024);
    const req = sign({
      method: 'POST',
      path: `/s3/${BUCKET}/notes.txt?uploadId=upload-1`,
      body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"part-etag"</ETag></Part></CompleteMultipartUpload>',
    });
    const res = await app.request(req.url, req.init);
    expect(res.status).toBe(200);
    expect(completed).toEqual([[{ partNumber: 1, etag: 'part-etag' }]]);
  });
});

describe("the app's S3 object reads: a HEAD from the metadata, a GET reads the object out or cancels it", () => {
  const BYTES = 'hello world';

  /** One object, `notes.txt`; each `getByKey` opens a stream that records whether it was read to its end or cancelled. */
  function objectApp() {
    const meta: BlobMeta = {
      blobId: '00000000-0000-4000-8000-0000000000d1' as ArtifactId,
      tenantId: TENANT,
      name: 'notes.txt',
      contentType: 'text/plain',
      size: BYTES.length,
      hash: 'a'.repeat(64),
      tags: {},
      ownerRunId: '00000000-0000-4000-8000-0000000000d2' as RunId,
      createdAt: '2026-09-30T11:00:00.000Z' as Timestamp,
    };
    const opened: { read: boolean; cancelled: boolean }[] = [];
    const blobStorage = {
      async headByKey(_tenant: TenantId, _bucket: string, key: string) {
        return key === 'notes.txt' ? meta : null;
      },
      async getByKey(_tenant: TenantId, _bucket: string, key: string) {
        if (key !== 'notes.txt') {
          return { kind: 'err', error: { code: 'blob-not-found', message: 'none' } };
        }
        const state = { read: false, cancelled: false };
        opened.push(state);
        let sent = false;
        // No high-water mark: nothing is pulled until a reader asks.
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (sent) {
                state.read = true;
                controller.close();
                return;
              }
              sent = true;
              controller.enqueue(new TextEncoder().encode(BYTES));
            },
            cancel() {
              state.cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        return { kind: 'ok', value: { meta, stream } };
      },
    } as unknown as BlobStorageBinding;
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: async () => null,
      runHandler: {} as RunHandlerBinding,
      blobStorage,
      s3Credentials: credentials,
    });
    const send = async (method: string, key: string, headers: Record<string, string>) => {
      const req = sign({ method, path: `/s3/${BUCKET}/${key}`, headers });
      return app.request(req.url, req.init);
    };
    return { app, send, opened };
  }

  test.each([
    ['the object', 'notes.txt', {}, 200],
    ['a range of it', 'notes.txt', { range: 'bytes=0-4' }, 206],
    ['its last bytes', 'notes.txt', { range: 'bytes=-3' }, 206],
    ['a malformed range', 'notes.txt', { range: 'bytes=x' }, 416],
    ['a key that is not there', 'missing.txt', {}, 404],
  ] as const)(
    "HEAD for %s: a GET's status and headers, and nothing opened",
    async (_what, key, range, status) => {
      const { send, opened } = objectApp();
      const headers = { 'x-request-id': `req-${status}`, ...range };
      const head = await send('HEAD', key, headers);
      expect(opened).toEqual([]);
      const get = await send('GET', key, headers);
      expect([head.status, get.status]).toEqual([status, status]);
      // Each request answers its own span; every other header is the same.
      const { traceresponse: headSpan, ...headHeaders } = Object.fromEntries(
        head.headers.entries(),
      );
      const { traceresponse: getSpan, ...getHeaders } = Object.fromEntries(get.headers.entries());
      expect([headSpan, getSpan]).toEqual([expect.any(String), expect.any(String)]);
      expect(headHeaders).toEqual(getHeaders);
      expect(await head.text()).toBe('');
    },
  );

  test('a GET hands the object out as the body, drains it for a range, and cancels it for a malformed range', async () => {
    const { send, opened } = objectApp();
    const whole = await send('GET', 'notes.txt', {});
    expect(opened).toEqual([{ read: false, cancelled: false }]);
    expect(await whole.text()).toBe(BYTES);
    expect(opened[0]).toEqual({ read: true, cancelled: false });

    const range = await send('GET', 'notes.txt', { range: 'bytes=6-' });
    // Read out before the answer, which carries the slice.
    expect(opened[1]).toEqual({ read: true, cancelled: false });
    expect([range.status, await range.text()]).toEqual([206, 'world']);

    const malformed = await send('GET', 'notes.txt', { range: 'bytes=x' });
    expect([malformed.status, await codeOf(malformed)]).toEqual([416, 'InvalidRange']);
    expect(opened[2]).toEqual({ read: false, cancelled: true });
  });

  test('a HEAD on the bucket answers 200 with no body', async () => {
    const { app } = objectApp();
    const req = sign({ method: 'HEAD', path: `/s3/${BUCKET}` });
    const res = await app.request(req.url, req.init);
    expect([res.status, await res.text()]).toEqual([200, '']);
  });
});

describe("the app's S3 object reads: a browser that opens one never runs it as a page of this origin", () => {
  const SAVED = {
    'content-disposition': `attachment; filename="page"; filename*=UTF-8''page`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  };

  /** One object, `page`, stored with `contentType`. */
  function typedApp(contentType: string) {
    const meta: BlobMeta = {
      blobId: '00000000-0000-4000-8000-0000000000d3' as ArtifactId,
      tenantId: TENANT,
      name: 'page',
      contentType,
      size: 9,
      hash: 'b'.repeat(64),
      tags: {},
      createdAt: '2026-09-30T11:00:00.000Z' as Timestamp,
    };
    const blobStorage = {
      async headByKey(_tenant: TenantId, _bucket: string, key: string) {
        return key === 'page' ? meta : null;
      },
      async getByKey(_tenant: TenantId, _bucket: string, key: string) {
        if (key !== 'page')
          return { kind: 'err', error: { code: 'blob-not-found', message: 'none' } };
        return { kind: 'ok', value: { meta, stream: new Response('<p>hi</p>').body } };
      },
    } as unknown as BlobStorageBinding;
    return createApp({
      ...createStubAppBindings(),
      resolveToken: async () => null,
      runHandler: {} as RunHandlerBinding,
      blobStorage,
      s3Credentials: credentials,
    });
  }

  test.each([
    ['HTML', 'text/html; charset=utf-8', { ...SAVED, 'content-type': 'text/html; charset=utf-8' }],
    ['SVG', 'image/svg+xml', { ...SAVED, 'content-type': 'image/svg+xml' }],
    ['XML', 'application/xml', { ...SAVED, 'content-type': 'application/xml' }],
    [
      'a type that is not a media type',
      'text/html, image/png',
      { ...SAVED, 'content-type': 'application/octet-stream' },
    ],
    [
      'an image type over 255 characters',
      `image/png; x=${'a'.repeat(243)}`,
      { ...SAVED, 'content-type': 'application/octet-stream' },
    ],
  ])(
    '%s: GET, a range and HEAD answer an attachment, nosniff and sandboxed',
    async (_what, stored, expected) => {
      const app = typedApp(stored);
      for (const [method, headers] of [
        ['GET', {}],
        ['GET', { range: 'bytes=0-2' }],
        ['HEAD', {}],
      ] as const) {
        const req = sign({ method, path: `/s3/${BUCKET}/page`, headers });
        const res = await app.request(req.url, req.init);
        expect(res.status, `${method} ${JSON.stringify(headers)}`).toBeLessThan(300);
        expect(Object.fromEntries(res.headers.entries())).toMatchObject(expected);
      }
    },
  );

  test.each([
    ['PNG', 'image/png'],
    ['PDF', 'application/pdf'],
    ['plain text', 'Text/Plain; charset=utf-8'],
    ['MP4 video', 'video/mp4'],
  ])('%s stays inline, nosniff, so a presigned link opens it', async (_what, stored) => {
    const app = typedApp(stored);
    const res = await app.request(presign(`/s3/${BUCKET}/page`, 300), {
      headers: { host: 'localhost' },
    });
    expect(res.status).toBe(200);
    const headers = Object.fromEntries(res.headers.entries());
    expect(headers).toMatchObject({ 'content-type': stored, 'x-content-type-options': 'nosniff' });
    expect(headers).not.toHaveProperty('content-disposition');
    expect(headers).not.toHaveProperty('content-security-policy');
  });

  test('a presigned link that asks for another type or for inline gets the object as stored', async () => {
    const asPng = 'response-content-type=image%2Fpng&response-content-disposition=inline';
    const html = await typedApp('text/html').request(presign(`/s3/${BUCKET}/page?${asPng}`, 300), {
      headers: { host: 'localhost' },
    });
    expect(html.status).toBe(200);
    expect(Object.fromEntries(html.headers.entries())).toMatchObject({
      ...SAVED,
      'content-type': 'text/html',
    });

    const asHtml = 'response-content-type=text%2Fhtml';
    const png = await typedApp('image/png').request(presign(`/s3/${BUCKET}/page?${asHtml}`, 300), {
      headers: { host: 'localhost' },
    });
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-disposition')).toBeNull();
  });
});

describe('SigV4 canonicalization matches S3 signers', () => {
  test.each([
    ['nested key', '/s3/artifacts/dir/sub/file.bin'],
    ['encoded space', '/s3/artifacts/my%20file.txt'],
    ['reserved characters', "/s3/artifacts/a(b)c!d'e*f.txt"],
    ['unicode', '/s3/artifacts/r%C3%A9sum%C3%A9.pdf'],
    ['encoded slash inside a segment', '/s3/artifacts/a%2Fb.txt'],
  ])('%s — %s', async (_name, path) => {
    const req = sign({ method: 'GET', path });
    const res = await makeApp().request(req.url, req.init);
    expect(res.status).toBe(200);
  });

  test.each([
    ['sorted after signing order', '/s3/artifacts?prefix=a%20b&list-type=2&max-keys=10'],
    ['valueless parameter', '/s3/artifacts/big.bin?uploads'],
    ['empty value', '/s3/artifacts/big.bin?uploads='],
    ['repeated key (first value counts)', '/s3/artifacts?prefix=x&prefix=y'],
    ['encoded characters in values', '/s3/artifacts?continuation-token=a%2Bb%3D%3D'],
  ])('query: %s', async (_name, path) => {
    const req = sign({ method: 'GET', path });
    const res = await makeApp().request(req.url, req.init);
    expect(res.status).toBe(200);
  });

  test('canonical request carries exactly the signed headers, in order', () => {
    const req = sign({
      method: 'PUT',
      path: `/s3/${BUCKET}/a.txt`,
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    });
    const headers = new Headers({
      ...(req.init.headers as Record<string, string>),
      'x-forwarded-for': '203.0.113.7',
    });
    const request = { method: 'PUT', url: new URL(req.url), headers };
    const claim = parseSigV4(request);
    if (claim.kind !== 'ok') throw new Error('parse failed');
    const canonical = canonicalRequest(request, claim.value);
    if (canonical.kind !== 'ok') throw new Error('canonicalization failed');
    expect(claim.value.signedHeaders).not.toContain('x-forwarded-for');
    expect(canonical.value).not.toContain('x-forwarded-for');
    const lines = canonical.value.split('\n');
    // …, canonical headers (one line each), blank line, signed headers, payload hash
    expect(lines.at(-2)).toBe(claim.value.signedHeaders.join(';'));
  });
});

describe('SigV4 presigned URLs', () => {
  test('presigned GET is accepted, even with headers the browser adds', async () => {
    const url = presign(`/s3/${BUCKET}/a.txt`, 300);
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    const res = await makeApp().request(url, {
      headers: {
        host: 'localhost',
        accept: '*/*',
        'accept-language': 'en',
        'user-agent': 'browser',
      },
    });
    expect(res.status).toBe(200);
  });

  test('presigned URL past X-Amz-Expires → 403 AccessDenied', async () => {
    const url = presign(`/s3/${BUCKET}/a.txt`, 60);
    vi.setSystemTime(new Date(T0.getTime() + 61_000));
    const res = await makeApp().request(url, { headers: { host: 'localhost' } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Request has expired');
  });

  test('X-Amz-Expires beyond 7 days → 400 AuthorizationQueryParametersError', async () => {
    const url = presign(`/s3/${BUCKET}/a.txt`, 7 * 24 * 3600 + 1);
    const res = await makeApp().request(url, { headers: { host: 'localhost' } });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('AuthorizationQueryParametersError');
  });

  test('tampered presigned signature → 403 SignatureDoesNotMatch', async () => {
    const url = presign(`/s3/${BUCKET}/a.txt`, 300);
    const tampered = url.replace(
      /X-Amz-Signature=([0-9a-f])/,
      (_m, c: string) => `X-Amz-Signature=${c === '0' ? '1' : '0'}`,
    );
    const res = await makeApp().request(tampered, { headers: { host: 'localhost' } });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SignatureDoesNotMatch');
  });

  test('presigned URL dated beyond the allowed skew → 403 RequestTimeTooSkewed', async () => {
    vi.setSystemTime(new Date(T0.getTime() + 20 * 60_000));
    const url = presign(`/s3/${BUCKET}/a.txt`, 300);
    vi.setSystemTime(T0);
    const res = await makeApp().request(url, { headers: { host: 'localhost' } });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('RequestTimeTooSkewed');
  });
});

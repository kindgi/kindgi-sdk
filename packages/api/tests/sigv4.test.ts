// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import aws4 from 'aws4';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { canonicalRequest, parseSigV4 } from '../src/middleware/sigv4-verify.js';
import { sigv4Middleware } from '../src/middleware/sigv4.js';
import type { S3CredentialBinding } from '../src/s3-credential-binding.js';
import type { AppEnv } from '../src/types.js';

// aws4 is an independent SigV4 implementation (the one most JS S3 clients
// use): every case signs with it and verifies with our middleware.
const { RequestSigner } = aws4;

const ACCESS_KEY = 'AKIAKINDGITEST000001';
const SECRET_KEY = 'kindgi-test-secret-key-0000000000000000000';
const BUCKET = 'artifacts';
const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const T0 = new Date('2026-09-30T12:00:00.900Z');

const credentials: S3CredentialBinding = {
  async resolve(accessKeyId) {
    return accessKeyId === ACCESS_KEY
      ? ({ accessKeyId, secretKey: SECRET_KEY, tenantId: TENANT, bucket: BUCKET } as never)
      : null;
  },
};

function makeApp() {
  const app = new Hono<AppEnv>();
  app.use('/s3/*', sigv4Middleware(credentials));
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

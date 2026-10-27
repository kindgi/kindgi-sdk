// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack tool's file store: `POST /v1/file-uploads`, with the call's
 * upload token as the bearer and no API key. The route reads the bytes
 * under its own limit and passes them, the name and the declared type to
 * the runtime's binding; the token never reaches a log line.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { HOSTED_BOUNDS } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { FILE_LIMITS } from '@kindgi/capabilities';
import { createLogger } from '@kindgi/log';
import { MAX_STORED_FILE_BYTES } from '@kindgi/tools';
import type { EnvName, Result, TenantId, UserId } from '@kindgi/types';

import { createApp, createInMemoryRateLimitStore } from '../src/index.js';
import type {
  FileUploadAnswer,
  FileUploadBinding,
  FileUploadInput,
  FileUploadRefusal,
  RateLimitStore,
  RateLimitTakeInput,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import {
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_REQUESTS_PER_CLIENT_PER_MINUTE,
} from '../src/routes/file-uploads.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const API_KEY = 'file-uploads-api-key';
const resolveToken: TokenResolver = async (token) =>
  token === API_KEY ? { tenantId, userId: 'user-1' as UserId } : null;
/** A call's upload token: the credential, never in a log line. */
const UPLOAD_TOKEN = 'kgi_fu_tenant_id_upload-secret-4b1c';

const STORED: FileUploadAnswer = {
  file: {
    type: 'kindgi.file',
    artifactId: randomUUID(),
    name: 'invoice.pdf',
    contentType: 'application/pdf',
    size: 4,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  },
};

interface Options {
  /** `false`: a runtime that stores no files. */
  readonly fileUploads?: false;
  readonly store?: (input: FileUploadInput) => Result<FileUploadAnswer, FileUploadRefusal>;
  /** How the deployment tells clients apart and where it counts them (`webhookReceiver`'s). */
  readonly clients?: {
    readonly clientAddress?: (request: Request) => string | undefined;
    readonly rateLimitStore?: RateLimitStore;
  };
}

function harness(options: Options = {}) {
  const stored: FileUploadInput[] = [];
  const lines: string[] = [];
  const fileUploads: FileUploadBinding = {
    store: async (input) => {
      stored.push(input);
      return options.store?.(input) ?? { kind: 'ok', value: STORED };
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    logger: createLogger({ level: 'debug', write: (l) => lines.push(l) }),
    ...(options.fileUploads !== false && { fileUploads }),
    ...(options.clients !== undefined && {
      webhookReceiver: { envName: 'production' as EnvName, ...options.clients },
    }),
  });
  /** A pack service's store: the upload token as the bearer. */
  const upload = (
    body: RequestInit['body'] | undefined,
    headers: Record<string, string> = {
      authorization: `Bearer ${UPLOAD_TOKEN}`,
      'content-type': 'application/pdf',
      'kindgi-file-name': 'invoice.pdf',
    },
  ) =>
    app.request('/v1/file-uploads', {
      method: 'POST',
      headers,
      ...(body !== undefined && { body }),
    });
  return { app, stored, lines, upload };
}

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('the upload route', () => {
  test('stores the bytes with no API key, and answers the stored file', async () => {
    const h = harness();
    const res = await h.upload(bytes('test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STORED);
    expect(h.stored).toEqual([
      {
        token: UPLOAD_TOKEN,
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        bytes: bytes('test'),
      },
    ]);
  });

  test('answers why nothing was stored, as the runtime says', async () => {
    for (const reason of ['type', 'size', 'limit'] as const) {
      const h = harness({ store: () => ({ kind: 'ok', value: { notStored: reason } }) });
      const res = await h.upload(bytes('test'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ notStored: reason });
    }
  });

  test('decodes the name; no name and no type pass on empty', async () => {
    const h = harness();
    await h.upload(bytes('test'), {
      authorization: `Bearer ${UPLOAD_TOKEN}`,
      'kindgi-file-name': 'Rechnung%20M%C3%A4rz%0A.pdf',
    });
    await h.upload(bytes('test'), { authorization: `Bearer ${UPLOAD_TOKEN}` });
    expect(h.stored.map(({ name }) => name)).toEqual(['Rechnung März\n.pdf', '']);
    expect(h.stored[1]?.contentType).toBe('');
  });

  test('a name that is not percent-encoded UTF-8 is 400 bad-input, with nothing stored', async () => {
    const h = harness();
    const res = await h.upload(bytes('test'), {
      authorization: `Bearer ${UPLOAD_TOKEN}`,
      'kindgi-file-name': '%E0%A4%A',
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('bad-input');
    expect(h.stored).toEqual([]);
  });

  test('a body past the limit is passed on as too-large, read no further', async () => {
    const h = harness({ store: () => ({ kind: 'ok', value: { notStored: 'size' } }) });
    const res = await h.upload(new Uint8Array(FILE_UPLOAD_MAX_BYTES + 1));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notStored: 'size' });
    expect(h.stored[0]?.bytes).toBe('too-large');
  });

  test("the limit is the largest any type allows, the one a pack's store holds to", () => {
    expect(FILE_UPLOAD_MAX_BYTES).toBe(
      Math.max(FILE_LIMITS.imageBytes, FILE_LIMITS.documentBytes, FILE_LIMITS.textBytes),
    );
    expect(FILE_UPLOAD_MAX_BYTES).toBe(MAX_STORED_FILE_BYTES);
  });

  test('a body at the limit is read whole', async () => {
    const h = harness();
    expect((await h.upload(new Uint8Array(FILE_UPLOAD_MAX_BYTES))).status).toBe(200);
    expect((h.stored[0]?.bytes as Uint8Array).byteLength).toBe(FILE_UPLOAD_MAX_BYTES);
  });

  test("no bearer, another scheme, an unknown token and a wrong secret get the same 404, never /v1's 401", async () => {
    const h = harness({
      store: (input) =>
        input.token === UPLOAD_TOKEN
          ? { kind: 'ok', value: STORED }
          : { kind: 'err', error: { code: 'file-upload-not-found' } },
    });
    const answers = [];
    for (const authorization of [
      undefined,
      `Basic ${UPLOAD_TOKEN}`,
      'Bearer kgi_fu_unknown',
      `Bearer ${UPLOAD_TOKEN}x`,
      `Bearer ${API_KEY}`,
    ]) {
      const res = await h.upload(bytes('test'), {
        ...(authorization !== undefined && { authorization }),
      });
      answers.push([res.status, (await errorOf(res)).code]);
    }
    expect(answers).toEqual(Array(5).fill([404, 'file-upload-not-found']));
  });

  test('the bearer scheme is read in any case', async () => {
    const h = harness();
    expect(
      (await h.upload(bytes('test'), { authorization: `bearer ${UPLOAD_TOKEN}` })).status,
    ).toBe(200);
    expect(h.stored[0]?.token).toBe(UPLOAD_TOKEN);
  });

  test('a closed upload is 409 file-upload-closed', async () => {
    const h = harness({ store: () => ({ kind: 'err', error: { code: 'file-upload-closed' } }) });
    const res = await h.upload(bytes('test'));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('file-upload-closed');
  });

  test('a suspended project is 409 project-suspended', async () => {
    const h = harness({ store: () => ({ kind: 'err', error: { code: 'project-suspended' } }) });
    const res = await h.upload(bytes('test'));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('project-suspended');
  });

  test.each([
    ['closing', 409, 'tenant-closing', { state: 'closing' }],
    ['suspended', 409, 'tenant-suspended', { state: 'suspended' }],
    ['unreadable', 503, 'tenant-state-unavailable', undefined],
  ] as const)(
    'a tenant %s is answered as the gate answers its writes: %i %s',
    async (state, status, code, details) => {
      const h = harness({
        store: () => ({ kind: 'err', error: { code: 'tenant-frozen', state } }),
      });
      const res = await h.upload(bytes('test'));
      expect(res.status).toBe(status);
      expect(res.headers.get('retry-after')).toBe(state === 'unreadable' ? '5' : null);
      const error = await errorOf(res);
      expect(error.code).toBe(code);
      expect(error.details).toEqual(details);
    },
  );

  test('on a runtime that stores no files, every upload is 404 file-upload-not-found', async () => {
    const h = harness({ fileUploads: false });
    const res = await h.upload(bytes('test'));
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('file-upload-not-found');
  });

  test("the API's own body limit leaves the route alone: a hosted 2 MiB doesn't cut a 3 MB PDF", async () => {
    const restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    try {
      const h = harness();
      const res = await h.upload(new Uint8Array(3_000_000));
      expect(res.status).toBe(200);
      expect((h.stored[0]?.bytes as Uint8Array).byteLength).toBe(3_000_000);
    } finally {
      restore();
    }
  });

  test('the token never reaches a log line or an answer', async () => {
    const h = harness({ store: () => ({ kind: 'err', error: { code: 'file-upload-closed' } }) });
    const res = await h.upload(bytes('test'));
    expect(JSON.stringify(await res.json())).not.toContain(UPLOAD_TOKEN);
    const routes = h.lines.map((l) => (JSON.parse(l) as { route?: string }).route);
    expect(routes).toContain('/v1/file-uploads');
    expect(h.lines.join('\n')).not.toContain(UPLOAD_TOKEN);
  });
});

describe("the route's limit per client", () => {
  /** The in-memory store at a limit of `limit`, keeping what each take asked for. */
  function storeAt(limit: number) {
    const real = createInMemoryRateLimitStore();
    const asked: RateLimitTakeInput[] = [];
    const store: RateLimitStore = {
      take: (input) => {
        asked.push(input);
        return real.take({ ...input, limit });
      },
    };
    return { store, asked };
  }
  const from = (address: string) => ({
    authorization: `Bearer ${UPLOAD_TOKEN}`,
    'x-forwarded-for': address,
  });

  test('a client past its requests is answered 429, before its body is read or its token looked up', async () => {
    const { store, asked } = storeAt(1);
    const h = harness({ clients: { rateLimitStore: store } });
    expect((await h.upload(bytes('test'), from('203.0.113.7'))).status).toBe(200);
    const res = await h.upload(bytes('test'), from('203.0.113.7'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await errorOf(res)).code).toBe('rate-limit-exceeded');
    expect(h.stored).toHaveLength(1);
    // Another client has its own count.
    expect((await h.upload(bytes('test'), from('203.0.113.8'))).status).toBe(200);
    expect(asked[0]).toEqual({
      key: 'file-upload:203.0.113.7',
      limit: FILE_UPLOAD_REQUESTS_PER_CLIENT_PER_MINUTE,
      windowMs: 60_000,
    });
    expect(asked.every((a) => !a.key.includes(UPLOAD_TOKEN))).toBe(true);
  });

  test('a store that fails lets the upload through, and is logged once a minute', async () => {
    const h = harness({
      clients: {
        rateLimitStore: {
          take: async () => {
            throw new Error('the counts are down');
          },
        },
      },
    });
    expect((await h.upload(bytes('test'))).status).toBe(200);
    expect((await h.upload(bytes('test'))).status).toBe(200);
    expect(h.stored).toHaveLength(2);
    expect(h.lines.filter((l) => l.includes('the rate-limit store failed'))).toHaveLength(1);
  });
});

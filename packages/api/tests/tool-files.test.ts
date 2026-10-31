// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack tool's files: `POST /v1/tool-files` and
 * `GET /v1/tool-files/{artifactId}`, with the call's token as the bearer
 * and no API key. The store's route passes the name, the declared type and
 * length, and a read of the body under its own limit to the runtime's
 * binding; the read's route sends the bytes the binding answers and gives
 * their room back once they're sent. The token never reaches a log line.
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
  RateLimitStore,
  RateLimitTakeInput,
  RunHandlerBinding,
  TokenResolver,
  ToolFileReadAnswer,
  ToolFileReadInput,
  ToolFileStoreAnswer,
  ToolFileStoreInput,
  ToolFilesBinding,
  ToolFilesRefusal,
} from '../src/index.js';
import {
  TOOL_FILES_BUSY_RETRY_AFTER_SECONDS,
  TOOL_FILES_REQUESTS_PER_CLIENT_PER_MINUTE,
  TOOL_FILE_MAX_BYTES,
} from '../src/routes/tool-files.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const API_KEY = 'tool-files-api-key';
const resolveToken: TokenResolver = async (token) =>
  token === API_KEY ? { tenantId, userId: 'user-1' as UserId } : null;
/** A call's tool files token: the credential, never in a log line. */
const TOKEN = 'kgi_tf_tenant_id_tool-files-secret-4b1c';

const STORED: ToolFileStoreAnswer = {
  file: {
    type: 'kindgi.file',
    artifactId: randomUUID(),
    name: 'invoice.pdf',
    contentType: 'application/pdf',
    size: 4,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  },
};

/** A store as the binding saw it, its body read. */
type Stored = Omit<ToolFileStoreInput, 'body'> & { readonly bytes: Uint8Array | 'too-large' };

interface Options {
  /** `false`: a runtime that stores no files. */
  readonly toolFiles?: false;
  /** The most of the body the binding reads. Default: all the route allows. */
  readonly bodyMax?: number;
  readonly store?: (input: Stored) => Result<ToolFileStoreAnswer, ToolFilesRefusal>;
  readonly read?: (input: ToolFileReadInput) => Result<ToolFileReadAnswer, ToolFilesRefusal>;
  /** How the deployment tells clients apart and where it counts them (`webhookReceiver`'s). */
  readonly clients?: {
    readonly clientAddress?: (request: Request) => string | undefined;
    readonly rateLimitStore?: RateLimitStore;
  };
}

function harness(options: Options = {}) {
  const stored: Stored[] = [];
  const reads: ToolFileReadInput[] = [];
  const lines: string[] = [];
  const toolFiles: ToolFilesBinding = {
    store: async ({ body, ...input }) => {
      const seen = { ...input, bytes: await body(options.bodyMax ?? TOOL_FILE_MAX_BYTES) };
      stored.push(seen);
      return options.store?.(seen) ?? { kind: 'ok', value: STORED };
    },
    read: async (input) => {
      reads.push(input);
      return options.read?.(input) ?? { kind: 'ok', value: { bytes: PDF } };
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    logger: createLogger({ level: 'debug', write: (l) => lines.push(l) }),
    ...(options.toolFiles !== false && { toolFiles }),
    ...(options.clients !== undefined && {
      webhookReceiver: { envName: 'production' as EnvName, ...options.clients },
    }),
  });
  /** A pack service's store: the call's token as the bearer. */
  const store = (
    body: RequestInit['body'] | undefined,
    headers: Record<string, string> = {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/pdf',
      'kindgi-file-name': 'invoice.pdf',
    },
  ) =>
    app.request('/v1/tool-files', {
      method: 'POST',
      headers,
      ...(body !== undefined && { body }),
    });
  /** A pack service's read: the token as the bearer. */
  const read = (
    artifactId: string,
    headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
  ) => app.request(`/v1/tool-files/${artifactId}`, { headers });
  return { app, stored, reads, lines, store, read };
}

const PDF = new TextEncoder().encode('%PDF-1.7 acme');

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('the store route', () => {
  test('stores the bytes with no API key, and answers the stored file', async () => {
    const h = harness();
    const res = await h.store(bytes('test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STORED);
    expect(h.stored).toEqual([
      {
        token: TOKEN,
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        bytes: bytes('test'),
      },
    ]);
  });

  test('passes on the declared length, when one is sent', async () => {
    const h = harness();
    await h.store(bytes('test'), {
      authorization: `Bearer ${TOKEN}`,
      'content-length': '4',
    });
    expect(h.stored[0]?.declaredBytes).toBe(4);
  });

  test('answers why nothing was stored, as the runtime says', async () => {
    for (const reason of ['type', 'size', 'limit', 'storage'] as const) {
      const h = harness({ store: () => ({ kind: 'ok', value: { notStored: reason } }) });
      const res = await h.store(bytes('test'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ notStored: reason });
    }
  });

  test('decodes the name; no name and no type pass on empty', async () => {
    const h = harness();
    await h.store(bytes('test'), {
      authorization: `Bearer ${TOKEN}`,
      'kindgi-file-name': 'Rechnung%20M%C3%A4rz%0A.pdf',
    });
    await h.store(bytes('test'), { authorization: `Bearer ${TOKEN}` });
    expect(h.stored.map(({ name }) => name)).toEqual(['Rechnung März\n.pdf', '']);
    expect(h.stored[1]?.contentType).toBe('');
  });

  test('a name that is not percent-encoded UTF-8 is 400 bad-input, with nothing stored', async () => {
    const h = harness();
    const res = await h.store(bytes('test'), {
      authorization: `Bearer ${TOKEN}`,
      'kindgi-file-name': '%E0%A4%A',
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('bad-input');
    expect(h.stored).toEqual([]);
  });

  test('a body past the limit is passed on as too-large, read no further', async () => {
    const h = harness({ store: () => ({ kind: 'ok', value: { notStored: 'size' } }) });
    const res = await h.store(new Uint8Array(TOOL_FILE_MAX_BYTES + 1));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notStored: 'size' });
    expect(h.stored[0]?.bytes).toBe('too-large');
  });

  test("the limit is the largest any type allows, the one a pack's store holds to", () => {
    expect(TOOL_FILE_MAX_BYTES).toBe(
      Math.max(FILE_LIMITS.imageBytes, FILE_LIMITS.documentBytes, FILE_LIMITS.textBytes),
    );
    expect(TOOL_FILE_MAX_BYTES).toBe(MAX_STORED_FILE_BYTES);
  });

  test("a body past the binding's own limit is too-large, and one past the route's never read past it", async () => {
    const h = harness({ bodyMax: 10, store: () => ({ kind: 'ok', value: { notStored: 'size' } }) });
    await h.store(new Uint8Array(11));
    expect(h.stored[0]?.bytes).toBe('too-large');
    const whole = harness({ bodyMax: 10 });
    await whole.store(new Uint8Array(10));
    expect((whole.stored[0]?.bytes as Uint8Array).byteLength).toBe(10);
    const capped = harness({ bodyMax: TOOL_FILE_MAX_BYTES * 2 });
    await capped.store(new Uint8Array(TOOL_FILE_MAX_BYTES + 1));
    expect(capped.stored[0]?.bytes).toBe('too-large');
  });

  test('a body at the limit is read whole', async () => {
    const h = harness();
    expect((await h.store(new Uint8Array(TOOL_FILE_MAX_BYTES))).status).toBe(200);
    expect((h.stored[0]?.bytes as Uint8Array).byteLength).toBe(TOOL_FILE_MAX_BYTES);
  });

  test("no bearer, another scheme, an unknown token and a wrong secret get the same 404, never /v1's 401", async () => {
    const h = harness({
      store: (input) =>
        input.token === TOKEN
          ? { kind: 'ok', value: STORED }
          : { kind: 'err', error: { code: 'tool-file-token-not-found' } },
    });
    const answers = [];
    for (const authorization of [
      undefined,
      `Basic ${TOKEN}`,
      'Bearer kgi_tf_unknown',
      `Bearer ${TOKEN}x`,
      `Bearer ${API_KEY}`,
    ]) {
      const res = await h.store(bytes('test'), {
        ...(authorization !== undefined && { authorization }),
      });
      answers.push([res.status, (await errorOf(res)).code]);
    }
    expect(answers).toEqual(Array(5).fill([404, 'tool-file-token-not-found']));
  });

  test('the bearer scheme is read in any case', async () => {
    const h = harness();
    expect((await h.store(bytes('test'), { authorization: `bearer ${TOKEN}` })).status).toBe(200);
    expect(h.stored[0]?.token).toBe(TOKEN);
  });

  test('a closed token is 409 tool-file-token-closed', async () => {
    const h = harness({
      store: () => ({ kind: 'err', error: { code: 'tool-file-token-closed' } }),
    });
    const res = await h.store(bytes('test'));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('tool-file-token-closed');
  });

  test('a suspended project is 409 project-suspended', async () => {
    const h = harness({ store: () => ({ kind: 'err', error: { code: 'project-suspended' } }) });
    const res = await h.store(bytes('test'));
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
      const res = await h.store(bytes('test'));
      expect(res.status).toBe(status);
      expect(res.headers.get('retry-after')).toBe(state === 'unreadable' ? '5' : null);
      const error = await errorOf(res);
      expect(error.code).toBe(code);
      expect(error.details).toEqual(details);
    },
  );

  test("no room in the runtime's memory for files is 503 tool-files-busy, with Retry-After", async () => {
    const h = harness({ store: () => ({ kind: 'err', error: { code: 'tool-files-busy' } }) });
    const res = await h.store(bytes('test'));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(TOOL_FILES_BUSY_RETRY_AFTER_SECONDS));
    expect((await errorOf(res)).code).toBe('tool-files-busy');
  });

  test('on a runtime that stores no files, every store is 404 tool-file-token-not-found', async () => {
    const h = harness({ toolFiles: false });
    const res = await h.store(bytes('test'));
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('tool-file-token-not-found');
  });

  test("the API's own body limit leaves the route alone: a hosted 2 MiB doesn't cut a 3 MB PDF", async () => {
    const restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    try {
      const h = harness();
      const res = await h.store(new Uint8Array(3_000_000));
      expect(res.status).toBe(200);
      expect((h.stored[0]?.bytes as Uint8Array).byteLength).toBe(3_000_000);
    } finally {
      restore();
    }
  });

  test('the token never reaches a log line or an answer', async () => {
    const h = harness({
      store: () => ({ kind: 'err', error: { code: 'tool-file-token-closed' } }),
    });
    const res = await h.store(bytes('test'));
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
    const routes = h.lines.map((l) => (JSON.parse(l) as { route?: string }).route);
    expect(routes).toContain('/v1/tool-files');
    expect(h.lines.join('\n')).not.toContain(TOKEN);
  });
});

describe('the read route', () => {
  test('sends the bytes with no API key, as an attachment never sniffed, then gives their room back', async () => {
    let released = 0;
    const h = harness({
      read: () => ({ kind: 'ok', value: { bytes: PDF, release: () => released++ } }),
    });
    const artifactId = randomUUID();
    const res = await h.read(artifactId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe(String(PDF.byteLength));
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(released).toBe(1);
    expect(h.reads).toEqual([{ token: TOKEN, artifactId }]);
  });

  test('a client that goes away before the bytes are sent gives their room back too, once', async () => {
    let released = 0;
    const h = harness({
      read: () => ({ kind: 'ok', value: { bytes: PDF, release: () => released++ } }),
    });
    const res = await h.read(randomUUID());
    await res.body?.cancel();
    expect(released).toBe(1);
  });

  test('a slow client takes the bytes a slice at a time, and their room is held until it has the last one', async () => {
    let released = 0;
    const bytes = new Uint8Array(3 * 64 * 1024 + 5).map((_, i) => i % 251);
    const h = harness({
      read: () => ({ kind: 'ok', value: { bytes, release: () => released++ } }),
    });
    const reader = (await h.read(randomUUID())).body?.getReader();
    if (reader === undefined) throw new Error('the read sent no body');
    const first = await reader.read();
    expect(first.value?.byteLength).toBe(64 * 1024);
    expect(released).toBe(0);
    const slices = [first.value as Uint8Array];
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      slices.push(next.value);
    }
    expect(slices.map((slice) => slice.byteLength)).toEqual([65536, 65536, 65536, 5]);
    expect(new Uint8Array(Buffer.concat(slices))).toEqual(bytes);
    expect(released).toBe(1);
  });

  test('a client that goes away partway through gives their room back, once', async () => {
    let released = 0;
    const bytes = new Uint8Array(3 * 64 * 1024);
    const h = harness({
      read: () => ({ kind: 'ok', value: { bytes, release: () => released++ } }),
    });
    const reader = (await h.read(randomUUID())).body?.getReader();
    if (reader === undefined) throw new Error('the read sent no body');
    await reader.read();
    expect(released).toBe(0);
    await reader.cancel();
    await reader.cancel();
    expect(released).toBe(1);
  });

  test("an id that isn't percent-encoded UTF-8 reaches the runtime as some string, never a 500", async () => {
    const h = harness({ read: () => ({ kind: 'ok', value: { notRead: 'rule' } }) });
    const res = await h.read('art-%ED%A0%80');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notRead: 'rule' });
    expect(typeof h.reads[0]?.artifactId).toBe('string');
  });

  test('answers why there are no bytes, as JSON, as the runtime says', async () => {
    for (const reason of ['rule', 'gone', 'changed', 'size'] as const) {
      const h = harness({ read: () => ({ kind: 'ok', value: { notRead: reason } }) });
      const res = await h.read(randomUUID());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ notRead: reason });
    }
  });

  test("no bearer, an unknown token and a store-only call's token get the same 404, never /v1's 401", async () => {
    const h = harness({
      read: () => ({ kind: 'err', error: { code: 'tool-file-token-not-found' } }),
    });
    const answers = [];
    for (const headers of [
      {},
      { authorization: 'Bearer kgi_tf_unknown' },
      { authorization: `Bearer ${API_KEY}` },
    ]) {
      const res = await h.read(randomUUID(), headers);
      answers.push([res.status, (await errorOf(res)).code]);
    }
    expect(answers).toEqual(Array(3).fill([404, 'tool-file-token-not-found']));
    // No bearer is answered before the binding is asked.
    expect(h.reads).toHaveLength(2);
  });

  test.each([
    ['tool-file-token-closed', 409, null],
    ['tool-files-busy', 503, String(TOOL_FILES_BUSY_RETRY_AFTER_SECONDS)],
  ] as const)('%s is %i', async (code, status, retryAfter) => {
    const h = harness({ read: () => ({ kind: 'err', error: { code } }) });
    const res = await h.read(randomUUID());
    expect(res.status).toBe(status);
    expect(res.headers.get('retry-after')).toBe(retryAfter);
    expect((await errorOf(res)).code).toBe(code);
  });

  test('on a runtime that stores no files, every read is 404 tool-file-token-not-found', async () => {
    const res = await harness({ toolFiles: false }).read(randomUUID());
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('tool-file-token-not-found');
  });

  test('the token never reaches a log line or an answer', async () => {
    const h = harness({
      read: () => ({ kind: 'err', error: { code: 'tool-file-token-closed' } }),
    });
    const res = await h.read(randomUUID());
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
    expect(h.lines.join('\n')).not.toContain(TOKEN);
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
    authorization: `Bearer ${TOKEN}`,
    'x-forwarded-for': address,
  });

  test('a client past its requests is answered 429, before its body is read or its token looked up', async () => {
    const { store, asked } = storeAt(1);
    const h = harness({ clients: { rateLimitStore: store } });
    expect((await h.store(bytes('test'), from('203.0.113.7'))).status).toBe(200);
    const res = await h.store(bytes('test'), from('203.0.113.7'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await errorOf(res)).code).toBe('rate-limit-exceeded');
    expect(h.stored).toHaveLength(1);
    // Another client has its own count.
    expect((await h.store(bytes('test'), from('203.0.113.8'))).status).toBe(200);
    expect(asked[0]).toEqual({
      key: 'tool-files:203.0.113.7',
      limit: TOOL_FILES_REQUESTS_PER_CLIENT_PER_MINUTE,
      windowMs: 60_000,
    });
    expect(asked.every((a) => !a.key.includes(TOKEN))).toBe(true);
  });

  test("a client's reads count with its stores", async () => {
    const { store } = storeAt(1);
    const h = harness({ clients: { rateLimitStore: store } });
    expect((await h.store(bytes('test'), from('203.0.113.7'))).status).toBe(200);
    const res = await h.read(randomUUID(), from('203.0.113.7'));
    expect(res.status).toBe(429);
    expect(h.reads).toEqual([]);
  });

  test('a rate-limit store that fails lets the request through, and is logged once a minute', async () => {
    const h = harness({
      clients: {
        rateLimitStore: {
          take: async () => {
            throw new Error('the counts are down');
          },
        },
      },
    });
    expect((await h.store(bytes('test'))).status).toBe(200);
    expect((await h.store(bytes('test'))).status).toBe(200);
    expect(h.stored).toHaveLength(2);
    expect(h.lines.filter((l) => l.includes('the rate-limit store failed'))).toHaveLength(1);
  });
});

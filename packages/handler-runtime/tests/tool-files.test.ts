// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool that declares `storesFiles` or `readsFiles` gets `ctx.files` when
 * the call carries tool files: each store posts the bytes to the link, each
 * read gets a file's bytes from under it, and the handler never sees the
 * link or its token (pack protocol 2.10.0).
 */

import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type FileStore, type FileToStore, MAX_STORED_FILE_BYTES } from '@kindgi/tools';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type {
  HandlerContext,
  HandlerModule,
  HandlerOutcome,
  ToolInvocationSpec,
} from '../src/handler-runner.js';
import { runHandlerOrPause } from '../src/handler-runner.js';
import { fileStoreOf, toolFilesOf } from '../src/tool-files.js';

const token = 'kgi_tf_test-token';

/** The file the link answers for `invoice`, whose bytes are "test". */
const stored = {
  type: 'kindgi.file',
  artifactId: 'art-1',
  name: 'invoice.pdf',
  contentType: 'application/pdf',
  size: 4,
  sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
} as const;

const invoice: FileToStore = {
  name: 'invoice.pdf',
  contentType: 'application/pdf',
  bytes: new TextEncoder().encode('test'),
};

interface Received {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** What the link answers a store, and what it received. */
let answer: { readonly status: number; readonly body: unknown };
/** What the link answers a read: JSON, or bytes with `contentType`. */
let readAnswer: {
  readonly status: number;
  readonly contentType?: string;
  readonly body: unknown;
};
const received: Received[] = [];
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.url?.endsWith('/never') === true) return;
      if (req.method === 'GET') {
        const bytes = readAnswer.contentType !== undefined;
        res.writeHead(readAnswer.status, {
          'content-type': readAnswer.contentType ?? 'application/json',
        });
        res.end(bytes ? (readAnswer.body as Buffer) : JSON.stringify(readAnswer.body));
        return;
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/tool-files`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  answer = { status: 200, body: { file: stored } };
  readAnswer = { status: 200, contentType: 'application/octet-stream', body: PDF };
});

const PDF = Buffer.from('%PDF-1.7 acme');

const tool = (overrides: Partial<ToolInvocationSpec> = {}): ToolInvocationSpec => ({
  id: 'acme.mail.attachment-get',
  modulePath: '/fake/attachment-get.js',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  storesFiles: true,
  ...overrides,
});

/**
 * The context the pack service builds for a call with an idempotency key:
 * the tool files are a hidden property, as `secrets` is.
 */
const ctx = (sent: unknown = { url, token }, idempotencyKey = 'call-key'): HandlerContext => {
  const out: HandlerContext = {
    tenantId: 'tenant-1',
    runId: 'run-1',
    ...(idempotencyKey !== '' && { idempotencyKey }),
  };
  Object.defineProperty(out, 'toolFiles', { value: sent, enumerable: false });
  return out;
};

const STORES = { store: true, read: false } as const;
const READS = { store: false, read: true } as const;

/** The handler's `files.store`; throws when it got none. */
const storeOf = (c: HandlerContext | FileStore) => {
  const files = 'tenantId' in c ? c.files : c;
  if (files?.store === undefined) throw new Error('the handler got no files.store');
  return files.store;
};

/** The handler's `files.read`; throws when it got none. */
const readOf = (c: HandlerContext | FileStore) => {
  const files = 'tenantId' in c ? c.files : c;
  if (files?.read === undefined) throw new Error('the handler got no files.read');
  return files.read;
};

const run = (
  handler: (input: unknown, ctx: HandlerContext) => unknown,
  spec: Partial<ToolInvocationSpec> = {},
  context: HandlerContext = ctx(),
): Promise<HandlerOutcome> =>
  runHandlerOrPause({
    tool: tool(spec),
    input: {},
    ctx: context,
    importHandler: async (): Promise<HandlerModule> => handler as HandlerModule,
  });

describe('a tool that stores files', () => {
  test('gets files and not the link; a store posts the bytes with the token, and answers the file', async () => {
    const outcome = await run(async (_input, c) => ({
      sees: ['toolFiles' in c, Object.isFrozen(c.files)],
      answer: await storeOf(c)(invoice),
    }));
    expect(outcome).toEqual({
      kind: 'ok',
      value: { sees: [false, true], answer: { file: stored } },
    });
    expect(received).toEqual([
      {
        method: 'POST',
        path: '/v1/tool-files',
        headers: expect.objectContaining({
          authorization: `Bearer ${token}`,
          'content-type': 'application/pdf',
          'kindgi-file-name': 'invoice.pdf',
        }),
        body: 'test',
      },
    ]);
  });

  test('sends the name percent-encoded, so any name can travel in a header', async () => {
    await storeOf(fileContext())({ ...invoice, name: 'Rechnung März\r\n.pdf' });
    expect(received[0]?.headers['kindgi-file-name']).toBe('Rechnung%20M%C3%A4rz%0D%0A.pdf');
  });

  test('a lone surrogate in the name goes as U+FFFD; a pair stays one character', async () => {
    await storeOf(fileContext())({ ...invoice, name: 'a\ud800b\ud83d\ude00.pdf' });
    expect(received[0]?.headers['kindgi-file-name']).toBe('a%EF%BF%BDb%F0%9F%98%80.pdf');
  });

  test.each([
    ['no type', ''],
    ['a line break', 'application/pdf\r\nx-acme: 1'],
    ['a character above U+00FF', 'application/\u{1F4E6}'],
  ])(
    'sends a declared type with %s as application/octet-stream: the bytes decide',
    async (_label, contentType) => {
      await storeOf(fileContext())({ ...invoice, contentType });
      expect(received[0]?.headers['content-type']).toBe('application/octet-stream');
    },
  );

  test.each(['type', 'size', 'limit', 'storage'] as const)(
    'answers why nothing was stored: %s',
    async (reason) => {
      answer = { status: 200, body: { notStored: reason } };
      expect(await storeOf(fileContext())(invoice)).toEqual({ notStored: reason });
    },
  );

  test.each([
    ['a file value missing its sha256', { file: { ...stored, sha256: undefined } }],
    ['a reason no store gives', { notStored: 'gone' }],
    ['nothing', {}],
  ])("rejects an answer that's %s", async (_label, body) => {
    answer = { status: 200, body };
    await expect(storeOf(fileContext())(invoice)).rejects.toThrow(
      "files.store: the runtime's answer isn't a stored file or a reason",
    );
  });

  test('a refused store fails the call, naming the status and the error code', async () => {
    answer = {
      status: 409,
      body: { error: { code: 'tool-file-token-closed', message: 'closed' } },
    };
    const outcome = await run(async (_input, c) => storeOf(c)(invoice));
    expect(outcome).toMatchObject({
      kind: 'err',
      error: { code: 'handler-throw', toolId: 'acme.mail.attachment-get' },
    });
    expect(outcome.kind === 'err' && outcome.error.message).toContain(
      'files.store: the runtime answered 409 (tool-file-token-closed)',
    );
  });

  test('a failure that quotes the token shows it redacted', async () => {
    answer = { status: 400, body: { error: { code: `token ${token} refused` } } };
    const outcome = await run(async (_input, c) => storeOf(c)(invoice));
    expect(outcome.kind === 'err' && outcome.error.message).toContain(
      '400 (token [redacted] refused)',
    );
    expect(JSON.stringify(outcome)).not.toContain(token);
  });

  test('a file over the largest any type allows answers size, and nothing is sent', async () => {
    const store = storeOf(fileStoreOf({ url, token }, STORES));
    const over = { ...invoice, bytes: new Uint8Array(MAX_STORED_FILE_BYTES + 1) };
    await expect(store(over)).resolves.toEqual({ notStored: 'size' });
    expect(received).toEqual([]);
  });

  test("a store the link doesn't answer stops with the call's abort signal", async () => {
    const controller = new AbortController();
    const pending = storeOf(fileStoreOf({ url: `${url}/never`, token }, STORES, controller.signal))(
      invoice,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  test("a file a JavaScript handler shapes wrong is refused before it's sent", async () => {
    const store = storeOf(fileContext());
    for (const file of [
      { ...invoice, bytes: 'test' },
      { ...invoice, name: undefined },
      { ...invoice, contentType: 7 },
      undefined,
    ]) {
      await expect(store(file as unknown as FileToStore)).rejects.toThrow(TypeError);
    }
    expect(received).toEqual([]);
  });

  test('from a runtime that sent no tool files, or unusable ones, gets no files', async () => {
    const plain: HandlerContext = { tenantId: 'tenant-1', runId: 'run-1' };
    for (const context of [
      plain,
      ctx({ url: 'ftp://kindgi.example/x', token }),
      ctx({ url, token: '' }),
    ]) {
      expect(await run((_input, c) => ({ files: 'files' in c }), {}, context)).toEqual({
        kind: 'ok',
        value: { files: false },
      });
    }
  });

  test("keeps the caller's context, its hidden properties too, and doesn't change it", async () => {
    const caller = ctx();
    Object.defineProperty(caller, 'secrets', { value: { API_KEY: 'k' }, enumerable: false });
    const outcome = await run((_input, c) => ({ key: c.secrets?.API_KEY }), {}, caller);
    expect(outcome).toEqual({ kind: 'ok', value: { key: 'k' } });
    expect(caller).not.toHaveProperty('files');
    expect(caller.toolFiles).toEqual({ url, token });
  });

  test('a tool that also pauses gets both', async () => {
    const waitToken = {
      id: 'wt-1',
      url: 'https://kindgi.example/v1/wait-tokens/wt-1/answer?sig=s',
    };
    const caller = ctx();
    Object.defineProperty(caller, 'waitToken', { value: waitToken, enumerable: true });
    const outcome = await run(
      (_input, c) => ({ files: 'files' in c, pause: 'pause' in c }),
      { pauses: true },
      caller,
    );
    expect(outcome).toEqual({ kind: 'ok', value: { files: true, pause: true } });
  });
});

describe("a tool that doesn't declare storesFiles", () => {
  test('gets neither files nor the link, even when the call carries one', async () => {
    const outcome = await run((_input, c) => ({ files: 'files' in c, link: 'toolFiles' in c }), {
      storesFiles: false,
    });
    expect(outcome).toEqual({ kind: 'ok', value: { files: false, link: false } });
  });

  test("a caller's own files are dropped: the runner decides them for each call", async () => {
    const caller: HandlerContext = { tenantId: 'tenant-1', runId: 'run-1' };
    Object.defineProperty(caller, 'files', {
      value: fileStoreOf({ url, token }, STORES),
      enumerable: true,
    });
    const outcome = await run(
      (_input, c) => ({ files: 'files' in c }),
      { storesFiles: false },
      caller,
    );
    expect(outcome).toEqual({ kind: 'ok', value: { files: false } });
  });
});

describe('a tool that reads files', () => {
  test("gets files.read and no store; a read gets the file's bytes under the link, with the token", async () => {
    const outcome = await run(
      async (_input, c) => {
        const read = await readOf(c)('art-1');
        return {
          sees: ['toolFiles' in c, c.files?.store === undefined],
          bytes: 'bytes' in read ? Buffer.from(read.bytes).toString() : read,
        };
      },
      { storesFiles: false, readsFiles: true },
    );
    expect(outcome).toEqual({
      kind: 'ok',
      value: { sees: [false, true], bytes: '%PDF-1.7 acme' },
    });
    expect(received).toEqual([
      {
        method: 'GET',
        path: '/v1/tool-files/art-1',
        headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
        body: '',
      },
    ]);
  });

  test("sends the file's id percent-encoded, and a link's trailing slash isn't doubled", async () => {
    await readOf(fileStoreOf({ url: `${url}/`, token }, READS))('a/b c?');
    expect(received[0]?.path).toBe('/v1/tool-files/a%2Fb%20c%3F');
  });

  test('a lone surrogate in the id goes as U+FFFD: the runtime answers rule, and the call goes on', async () => {
    readAnswer = { status: 200, body: { notRead: 'rule' } };
    expect(await readOf(fileContext())('art-\uD800')).toEqual({ notRead: 'rule' });
    expect(received[0]?.path).toBe('/v1/tool-files/art-%EF%BF%BD');
  });

  test.each(['rule', 'gone', 'changed', 'size'] as const)(
    'answers why there are no bytes: %s',
    async (reason) => {
      readAnswer = { status: 200, body: { notRead: reason } };
      expect(await readOf(fileContext())('art-1')).toEqual({ notRead: reason });
    },
  );

  test.each([
    ['a reason no read gives', { notRead: 'limit' }],
    ['nothing', {}],
  ])("rejects an answer that's %s", async (_label, body) => {
    readAnswer = { status: 200, body };
    await expect(readOf(fileContext())('art-1')).rejects.toThrow(
      "files.read: the runtime's answer isn't a file's bytes or a reason",
    );
  });

  test.each([
    [404, 'tool-file-token-not-found'],
    [409, 'tool-file-token-closed'],
    [503, 'tool-files-busy'],
  ])(
    'a refused read (%i) fails the call, naming the status and the error code',
    async (status, code) => {
      readAnswer = { status, body: { error: { code, message: 'no' } } };
      const outcome = await run(async (_input, c) => readOf(c)('art-1'), { readsFiles: true });
      expect(outcome.kind === 'err' && outcome.error.message).toContain(
        `files.read: the runtime answered ${status} (${code})`,
      );
      expect(JSON.stringify(outcome)).not.toContain(token);
    },
  );

  test("an id a JavaScript handler gives wrong is refused before it's sent", async () => {
    const read = readOf(fileContext());
    for (const id of ['', undefined, 7]) {
      await expect(read(id as unknown as string)).rejects.toThrow(TypeError);
    }
    expect(received).toEqual([]);
  });

  test('a call with no idempotency key: a tool that stores and reads gets only read; one that only stores, no files', async () => {
    const sees = (_input: unknown, c: HandlerContext) => ({
      store: c.files?.store !== undefined,
      read: c.files?.read !== undefined,
    });
    const keyless = ctx({ url, token }, '');
    expect(await run(sees, { readsFiles: true }, keyless)).toEqual({
      kind: 'ok',
      value: { store: false, read: true },
    });
    expect(await run((_input, c) => ({ files: 'files' in c }), {}, keyless)).toEqual({
      kind: 'ok',
      value: { files: false },
    });
    expect(await run(sees, { readsFiles: true })).toEqual({
      kind: 'ok',
      value: { store: true, read: true },
    });
  });
});

describe('toolFilesOf', () => {
  test.each([
    ['nothing', undefined],
    ['a string', url],
    ['a link that is not http(s)', { url: 'ftp://kindgi.example/x', token }],
    ['a link that does not parse', { url: 'https://', token }],
    ['no token', { url }],
    ['an empty token', { url, token: '' }],
    ['a token with a line break', { url, token: 'kgi_tf_a\r\nb' }],
    ['a token above U+00FF', { url, token: 'kgi_tf_\u{1F4E6}' }],
  ])('takes %s as no tool files', (_label, value) => {
    expect(toolFilesOf(value)).toBeUndefined();
  });

  test('keeps the link and the token, and nothing else', () => {
    expect(toolFilesOf({ url, token, extra: 1 })).toEqual({ url, token });
  });
});

/** The context a tool that stores and reads files gets for a call with tool files. */
function fileContext(): HandlerContext {
  return {
    tenantId: 'tenant-1',
    runId: 'run-1',
    files: fileStoreOf({ url, token }, { store: true, read: true }),
  };
}

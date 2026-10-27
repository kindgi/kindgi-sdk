// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool that declares `storesFiles` gets `ctx.files` when the call carries
 * a file upload: each store posts the bytes to the upload link, and the
 * handler never sees the link or its token (pack protocol 2.10.0).
 */

import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FileStore, FileToStore } from '@kindgi/tools';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { fileStoreOf, fileUploadOf } from '../src/file-upload.js';
import type {
  HandlerContext,
  HandlerModule,
  HandlerOutcome,
  ToolInvocationSpec,
} from '../src/handler-runner.js';
import { runHandlerOrPause } from '../src/handler-runner.js';

const token = 'kgi_fu_test-token';

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

/** What the upload link answers, and what it received. */
let answer: { readonly status: number; readonly body: unknown };
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
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/file-uploads`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  answer = { status: 200, body: { file: stored } };
});

const tool = (overrides: Partial<ToolInvocationSpec> = {}): ToolInvocationSpec => ({
  id: 'acme.mail.attachment-get',
  modulePath: '/fake/attachment-get.js',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  storesFiles: true,
  ...overrides,
});

/** The context the pack service builds: the upload is a hidden property, as `secrets` is. */
const ctx = (upload: unknown = { url, token }): HandlerContext => {
  const out: HandlerContext = { tenantId: 'tenant-1', runId: 'run-1' };
  Object.defineProperty(out, 'fileUpload', { value: upload, enumerable: false });
  return out;
};

const filesOf = (c: HandlerContext): FileStore => {
  if (c.files === undefined) throw new Error('the handler got no files');
  return c.files;
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
  test('gets files and not the upload; a store posts the bytes with the token, and answers the file', async () => {
    const outcome = await run(async (_input, c) => ({
      sees: ['fileUpload' in c, Object.isFrozen(c.files)],
      answer: await filesOf(c).store(invoice),
    }));
    expect(outcome).toEqual({
      kind: 'ok',
      value: { sees: [false, true], answer: { file: stored } },
    });
    expect(received).toEqual([
      {
        method: 'POST',
        path: '/v1/file-uploads',
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
    await filesOf(fileContext()).store({ ...invoice, name: 'Rechnung März\r\n.pdf' });
    expect(received[0]?.headers['kindgi-file-name']).toBe('Rechnung%20M%C3%A4rz%0D%0A.pdf');
  });

  test.each([
    ['no type', ''],
    ['a line break', 'application/pdf\r\nx-acme: 1'],
    ['a character above U+00FF', 'application/\u{1F4E6}'],
  ])(
    'sends a declared type with %s as application/octet-stream: the bytes decide',
    async (_label, contentType) => {
      await filesOf(fileContext()).store({ ...invoice, contentType });
      expect(received[0]?.headers['content-type']).toBe('application/octet-stream');
    },
  );

  test.each(['type', 'size', 'limit'] as const)(
    'answers why nothing was stored: %s',
    async (reason) => {
      answer = { status: 200, body: { notStored: reason } };
      expect(await filesOf(fileContext()).store(invoice)).toEqual({ notStored: reason });
    },
  );

  test.each([
    ['a file value missing its sha256', { file: { ...stored, sha256: undefined } }],
    ['a reason no store gives', { notStored: 'gone' }],
    ['nothing', {}],
  ])("rejects an answer that's %s", async (_label, body) => {
    answer = { status: 200, body };
    await expect(filesOf(fileContext()).store(invoice)).rejects.toThrow(
      "files.store: the runtime's answer isn't a stored file or a reason",
    );
  });

  test('a refused store fails the call, naming the status and the error code', async () => {
    answer = { status: 409, body: { error: { code: 'file-upload-closed', message: 'closed' } } };
    const outcome = await run(async (_input, c) => filesOf(c).store(invoice));
    expect(outcome).toMatchObject({
      kind: 'err',
      error: { code: 'handler-throw', toolId: 'acme.mail.attachment-get' },
    });
    expect(outcome.kind === 'err' && outcome.error.message).toContain(
      'files.store: the runtime answered 409 (file-upload-closed)',
    );
  });

  test('a failure that quotes the token shows it redacted', async () => {
    answer = { status: 400, body: { error: { code: `token ${token} refused` } } };
    const outcome = await run(async (_input, c) => filesOf(c).store(invoice));
    expect(outcome.kind === 'err' && outcome.error.message).toContain(
      '400 (token [redacted] refused)',
    );
    expect(JSON.stringify(outcome)).not.toContain(token);
  });

  test("a store the link doesn't answer stops with the call's abort signal", async () => {
    const controller = new AbortController();
    const pending = fileStoreOf({ url: `${url}/never`, token }, controller.signal).store(invoice);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  test("a file a JavaScript handler shapes wrong is refused before it's sent", async () => {
    const store = filesOf(fileContext());
    for (const file of [
      { ...invoice, bytes: 'test' },
      { ...invoice, name: undefined },
      { ...invoice, contentType: 7 },
      undefined,
    ]) {
      await expect(store.store(file as unknown as FileToStore)).rejects.toThrow(TypeError);
    }
    expect(received).toEqual([]);
  });

  test('from a runtime that sent no upload, or an unusable one, gets no files', async () => {
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
    expect(caller.fileUpload).toEqual({ url, token });
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
  test('gets neither files nor the upload, even when the call carries one', async () => {
    const outcome = await run((_input, c) => ({ files: 'files' in c, upload: 'fileUpload' in c }), {
      storesFiles: false,
    });
    expect(outcome).toEqual({ kind: 'ok', value: { files: false, upload: false } });
  });

  test("a caller's own files are dropped: the runner decides them for each call", async () => {
    const caller: HandlerContext = { tenantId: 'tenant-1', runId: 'run-1' };
    Object.defineProperty(caller, 'files', {
      value: fileStoreOf({ url, token }),
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

describe('fileUploadOf', () => {
  test.each([
    ['nothing', undefined],
    ['a string', url],
    ['a link that is not http(s)', { url: 'ftp://kindgi.example/x', token }],
    ['a link that does not parse', { url: 'https://', token }],
    ['no token', { url }],
    ['an empty token', { url, token: '' }],
    ['a token with a line break', { url, token: 'kgi_fu_a\r\nb' }],
    ['a token above U+00FF', { url, token: 'kgi_fu_\u{1F4E6}' }],
  ])('takes %s as no upload', (_label, value) => {
    expect(fileUploadOf(value)).toBeUndefined();
  });

  test('keeps the link and the token, and nothing else', () => {
    expect(fileUploadOf({ url, token, extra: 1 })).toEqual({ url, token });
  });
});

/** The context a tool that stores files gets for a call with an upload. */
function fileContext(): HandlerContext {
  return { tenantId: 'tenant-1', runId: 'run-1', files: fileStoreOf({ url, token }) };
}

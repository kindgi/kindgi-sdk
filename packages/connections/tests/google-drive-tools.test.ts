// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Google Drive tools. The answers are in the shapes Drive's reference
 * gives: files.list and files.get (developers.google.com/workspace/drive/
 * api/reference/rest/v3/files), files.export, and the multipart and
 * resumable uploads (developers.google.com/workspace/drive/api/guides/
 * manage-uploads).
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  type FileReadAnswer,
  type FileStore,
  type FileStoreAnswer,
  type FileToStore,
  type ToolConnection,
  invokeToolForTest,
} from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  googleDriveFileCreate,
  googleDriveFileGet,
  googleDriveFilesList,
} from '../src/google-tools.js';

const TOKEN = 'ya29.not-a-real-token';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS =
  'id,name,mimeType,size,modifiedTime,webViewLink,parents,owners(displayName,emailAddress,me)';

const list = googleDriveFilesList({ id: 'acme.drive.list' });
const get = googleDriveFileGet({ id: 'acme.drive.get' });
const create = googleDriveFileCreate({ id: 'acme.drive.create' });

/** A PNG's first bytes: what a store would check. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function drive(): ToolConnection {
  return {
    connectionId: randomUUID(),
    app: 'google',
    appName: 'Google',
    accessToken: TOKEN,
    account: { id: 'g-1', label: 'ana@acme.test' },
  };
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | undefined;
}

/** Google Drive, stubbed: each call's answer in turn, and what each call sent. */
function driveAnswering(...answers: (() => Response)[]): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      sent.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers as Record<string, string> | undefined) ?? {},
        body: init.body as string | Uint8Array | undefined,
      });
      const answer = answers[sent.length - 1] ?? answers.at(-1);
      if (answer === undefined) throw new Error('no answer stubbed');
      return answer();
    }),
  );
  return sent;
}

const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

/** A file store that keeps what it's given and answers `answer`, else the stored file; and reads `reads`. */
function filesAnswering(
  options: {
    readonly answer?: FileStoreAnswer;
    readonly reads?: Readonly<Record<string, FileReadAnswer>>;
  } = {},
) {
  const stored: FileToStore[] = [];
  const read: string[] = [];
  const files: FileStore = {
    store: async (file) => {
      stored.push(file);
      return (
        options.answer ?? {
          file: {
            type: 'kindgi.file',
            artifactId: 'art-1',
            name: file.name,
            contentType: file.contentType,
            size: file.bytes.byteLength,
            sha256: createHash('sha256').update(file.bytes).digest('hex'),
          },
        }
      );
    },
    read: async (artifactId) => {
      read.push(artifactId);
      return options.reads?.[artifactId] ?? { notRead: 'rule' };
    },
  };
  return { files, stored, read };
}

/** A record that keeps each key's first answer, as a run's journal does. */
function journal() {
  const kept = new Map<string, unknown>();
  return async <T>(key: string, decide: () => T | Promise<T>): Promise<T> => {
    if (!kept.has(key)) kept.set(key, await decide());
    return kept.get(key) as T;
  };
}

const REPORT = {
  id: 'f-report',
  name: 'Q3 report.pdf',
  mimeType: 'application/pdf',
  size: '52341',
  modifiedTime: '2026-11-02T09:15:00.000Z',
  webViewLink: 'https://drive.google.com/file/d/f-report/view',
  parents: ['d-finance'],
  owners: [{ displayName: 'Ana', emailAddress: 'ana@acme.test', me: true }],
};

const SHARED_DOC = {
  id: 'f-plan',
  name: 'Plan',
  mimeType: 'application/vnd.google-apps.document',
  modifiedTime: '2026-11-01T17:00:00+01:00',
  webViewLink: 'https://docs.google.com/document/d/f-plan/edit',
  parents: ['d-shared'],
  owners: [{ displayName: 'Bo', emailAddress: 'bo@acme.test', me: false }],
};

const googleError = (status: number, reason: string, message: string) => () =>
  Response.json({ error: { code: status, message, errors: [{ reason, message }] } }, { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what each tool declares', () => {
  it('reads with drive.readonly, adds with drive.file, and asks before an unattended create', () => {
    for (const tool of [list, get]) {
      expect(tool).toMatchObject({
        mutating: false,
        resultIsOutsideData: true,
        network: { kind: 'allowlist', hosts: ['www.googleapis.com'] },
        needsSpec: {
          connections: { drive: { app: 'google', permissions: ['drive.readonly'], as: 'person' } },
        },
      });
    }
    expect(list.storesFiles).toBeUndefined();
    expect(get.storesFiles).toBe(true);
    expect(create).toMatchObject({
      mutating: true,
      needsApprovalWhenUnattended: true,
      readsFiles: true,
      network: { kind: 'allowlist', hosts: ['www.googleapis.com'] },
      needsSpec: {
        connections: { drive: { app: 'google', permissions: ['drive.file'], as: 'person' } },
      },
      effects: [
        { kind: 'external-side-effect', resource: 'external:google-drive' },
        { kind: 'sensitive-data-egress', resource: 'external:google-drive' },
      ],
    });
  });

  it("a company tool uses the company's connection and says so", () => {
    const company = googleDriveFileCreate({ id: 'acme.store-drive.create', as: 'company' });
    expect(company.needsSpec?.connections?.drive).toEqual({
      app: 'google',
      permissions: ['drive.file'],
      as: 'company',
    });
    expect(company.description).toContain("the company's Google Drive");
    expect(
      googleDriveFilesList({ id: 'acme.store-drive.list', as: 'company' }).description,
    ).toContain("the company's Google Drive");
  });
});

describe('google drive files list', () => {
  it('lists newest first, not in the trash, across drives, each file as a list gives it', async () => {
    const sent = driveAnswering(() =>
      Response.json({ files: [REPORT, SHARED_DOC, { id: 'no-name' }], nextPageToken: 'tok~2' }),
    );
    const r = await invokeToolForTest(list, {}, { connections: { drive: drive() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        files: [
          {
            id: 'f-report',
            name: 'Q3 report.pdf',
            kind: 'file',
            contentType: 'application/pdf',
            size: 52341,
            modified: '2026-11-02T09:15:00Z',
            link: 'https://drive.google.com/file/d/f-report/view',
            folderId: 'd-finance',
          },
          {
            id: 'f-plan',
            name: 'Plan',
            kind: 'file',
            contentType: 'application/vnd.google-apps.document',
            modified: '2026-11-01T16:00:00Z',
            link: 'https://docs.google.com/document/d/f-plan/edit',
            folderId: 'd-shared',
            owner: { address: 'bo@acme.test', name: 'Bo' },
          },
        ],
        next: 'tok~2',
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]?.url.startsWith(`${FILES}?`)).toBe(true);
    expect(params(sent[0]?.url ?? '')).toEqual({
      q: 'trashed = false',
      pageSize: '25',
      fields: `nextPageToken,files(${FIELDS})`,
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      orderBy: 'modifiedTime desc',
    });
  });

  it("builds Drive's query from the typed fields, each value quoted and escaped", async () => {
    const sent = driveAnswering(() => Response.json({ files: [] }));
    await invokeToolForTest(
      list,
      {
        text: 'budget 2027',
        name: "Bo's \\ plan' or name contains '",
        folderId: 'd-finance',
        kind: 'spreadsheet',
        modifiedAfter: '2026-11-01T00:00:00+01:00',
        top: 10,
        next: 'tok~2',
      },
      { connections: { drive: drive() } },
    );
    const p = params(sent[0]?.url ?? '');
    expect(p.q).toBe(
      [
        'trashed = false',
        "fullText contains 'budget 2027'",
        "name contains 'Bo\\'s \\\\ plan\\' or name contains \\''",
        "'d-finance' in parents",
        "mimeType = 'application/vnd.google-apps.spreadsheet'",
        "modifiedTime > '2026-10-31T23:00:00Z'",
      ].join(' and '),
    );
    expect(p.pageSize).toBe('10');
    expect(p.pageToken).toBe('tok~2');
    // A search is ordered by how well each file matches.
    expect(p.orderBy).toBeUndefined();
  });

  it('a kind of folder or image is a type test, and any is none', async () => {
    const sent = driveAnswering(() => Response.json({ files: [] }));
    const ctx = { connections: { drive: drive() } };
    await invokeToolForTest(list, { kind: 'folder' }, ctx);
    await invokeToolForTest(list, { kind: 'image' }, ctx);
    await invokeToolForTest(list, { kind: 'any' }, ctx);
    expect(sent.map((s) => params(s.url).q)).toEqual([
      "trashed = false and mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false and mimeType contains 'image/'",
      'trashed = false',
    ]);
  });

  it('refuses a folder id, a next or words a list never gives, sending nothing', async () => {
    const sent = driveAnswering(() => Response.json({ files: [] }));
    const ctx = { connections: { drive: drive() } };
    for (const input of [
      { folderId: '../x' },
      { folderId: 'a b' },
      { next: 'has space' },
      { next: '' },
      { text: 'line\nbreak' },
      { top: 51 },
    ]) {
      expect((await invokeToolForTest(list, input, ctx)).kind).toBe('err');
    }
    expect(sent).toHaveLength(0);
  });

  it("a folder is a folder; the account's own files name no owner, nor do a shared drive's", async () => {
    driveAnswering(() =>
      Response.json({
        files: [
          { id: 'd-1', name: 'Finance', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'f-2', name: 'Team notes.txt', mimeType: 'text/plain', size: '12' },
        ],
      }),
    );
    const r = await invokeToolForTest(list, {}, { connections: { drive: drive() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        files: [
          {
            id: 'd-1',
            name: 'Finance',
            kind: 'folder',
            contentType: 'application/vnd.google-apps.folder',
          },
          { id: 'f-2', name: 'Team notes.txt', kind: 'file', contentType: 'text/plain', size: 12 },
        ],
      },
    });
  });

  it("Google's refusal comes back in its words, never with the token; a missing permission says to reconnect", async () => {
    driveAnswering(
      googleError(
        403,
        'insufficientPermissions',
        'Request had insufficient authentication scopes.',
      ),
    );
    const r = await invokeToolForTest(list, {}, { connections: { drive: drive() } });
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      'Google Drive refused the call (HTTP 403): Request had insufficient authentication scopes.',
    );
    expect(message).toContain('the person reconnects Google to allow it');
    expect(message).not.toContain(TOKEN);
  });
});

describe('google drive file get', () => {
  it('reads the details first, then downloads and stores a file of a type a run may have', async () => {
    const sent = driveAnswering(
      () => Response.json({ ...REPORT, name: 'Logo.png', mimeType: 'image/png', size: '11' }),
      () => new Response(PNG),
    );
    const { files, stored } = filesAnswering();
    const r = await invokeToolForTest(
      get,
      { fileId: 'f-report' },
      { connections: { drive: drive() }, files },
    );
    expect(r).toMatchObject({
      kind: 'ok',
      value: {
        files: [{ type: 'kindgi.file', name: 'Logo.png', contentType: 'image/png', size: 11 }],
        listed: { id: 'f-report', name: 'Logo.png', kind: 'file', size: 11 },
      },
    });
    expect(stored).toEqual([{ name: 'Logo.png', contentType: 'image/png', bytes: PNG }]);
    expect(sent.map((s) => s.url)).toEqual([
      `${FILES}/f-report?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`,
      `${FILES}/f-report?alt=media&supportsAllDrives=true`,
    ]);
  });

  it("downloads nothing of a type a run can't have, of a size past its type's limit, or with no file store", async () => {
    const cases = [
      { file: { ...REPORT, mimeType: 'application/zip', name: 'all.zip' }, reason: 'type' },
      { file: { ...REPORT, size: '10000001' }, reason: 'size' },
      { file: REPORT, reason: 'store', noStore: true },
    ] as const;
    for (const c of cases) {
      const sent = driveAnswering(() => Response.json(c.file));
      const { files, stored } = filesAnswering();
      const r = await invokeToolForTest(
        get,
        { fileId: 'f-report' },
        { connections: { drive: drive() }, ...(!('noStore' in c) && { files }) },
      );
      expect(r).toMatchObject({
        kind: 'ok',
        value: { notShown: { name: c.file.name, reason: c.reason }, listed: { id: 'f-report' } },
      });
      expect(sent).toHaveLength(1);
      expect(stored).toHaveLength(0);
    }
  });

  it("a download past its type's limit stops there and isn't stored", async () => {
    driveAnswering(
      () => Response.json({ ...REPORT, name: 'Notes.txt', mimeType: 'text/plain', size: '5' }),
      () => new Response(new Uint8Array(1_000_001)),
    );
    const { files, stored } = filesAnswering();
    const r = await invokeToolForTest(
      get,
      { fileId: 'f-report' },
      { connections: { drive: drive() }, files },
    );
    expect(r).toMatchObject({ kind: 'ok', value: { notShown: { reason: 'size' } } });
    expect(stored).toHaveLength(0);
  });

  it("exports Google's own files: a Doc as Markdown, or as a PDF with format: 'pdf'", async () => {
    const sent = driveAnswering(
      () => Response.json(SHARED_DOC),
      () => new Response('# Plan\n'),
      () => Response.json(SHARED_DOC),
      () => new Response('%PDF-1.7'),
    );
    const { files, stored } = filesAnswering();
    const ctx = { connections: { drive: drive() }, files };
    expect(await invokeToolForTest(get, { fileId: 'f-plan' }, ctx)).toMatchObject({
      kind: 'ok',
      value: {
        files: [{ name: 'Plan.md', contentType: 'text/markdown' }],
        listed: { id: 'f-plan' },
      },
    });
    await invokeToolForTest(get, { fileId: 'f-plan', format: 'pdf' }, ctx);
    expect(stored.map((f) => [f.name, f.contentType])).toEqual([
      ['Plan.md', 'text/markdown'],
      ['Plan.pdf', 'application/pdf'],
    ]);
    expect(sent[1]?.url).toBe(`${FILES}/f-plan/export?mimeType=text%2Fmarkdown`);
    expect(sent[3]?.url).toBe(`${FILES}/f-plan/export?mimeType=application%2Fpdf`);
  });

  it('a Sheet is CSV, Slides plain text, a Drawing a PNG; a Form has no export', async () => {
    const asText = [
      ['application/vnd.google-apps.spreadsheet', 'text%2Fcsv', 'Plan.csv'],
      ['application/vnd.google-apps.presentation', 'text%2Fplain', 'Plan.txt'],
      ['application/vnd.google-apps.drawing', 'image%2Fpng', 'Plan.png'],
    ] as const;
    for (const [mimeType, exportType, name] of asText) {
      const sent = driveAnswering(
        () => Response.json({ ...SHARED_DOC, mimeType }),
        () => new Response(mimeType.endsWith('drawing') ? PNG : 'a,b\n'),
      );
      const { files, stored } = filesAnswering();
      await invokeToolForTest(
        get,
        { fileId: 'f-plan' },
        { connections: { drive: drive() }, files },
      );
      expect(sent[1]?.url).toBe(`${FILES}/f-plan/export?mimeType=${exportType}`);
      expect(stored[0]?.name).toBe(name);
    }
    const sent = driveAnswering(() =>
      Response.json({ ...SHARED_DOC, mimeType: 'application/vnd.google-apps.form' }),
    );
    const { files } = filesAnswering();
    const r = await invokeToolForTest(
      get,
      { fileId: 'f-plan' },
      { connections: { drive: drive() }, files },
    );
    expect(r).toMatchObject({ kind: 'ok', value: { notShown: { name: 'Plan', reason: 'type' } } });
    expect(sent).toHaveLength(1);
  });

  it("an export past Google's 10 MB isn't shown, for its size", async () => {
    driveAnswering(
      () => Response.json(SHARED_DOC),
      googleError(403, 'exportSizeLimitExceeded', 'This file is too large to be exported.'),
    );
    const { files, stored } = filesAnswering();
    const r = await invokeToolForTest(
      get,
      { fileId: 'f-plan' },
      { connections: { drive: drive() }, files },
    );
    expect(r).toMatchObject({
      kind: 'ok',
      value: { notShown: { name: 'Plan.md', reason: 'size' } },
    });
    expect(stored).toHaveLength(0);
  });

  it("a folder is refused, pointing to a list; a file Drive can't find says so", async () => {
    driveAnswering(() =>
      Response.json({ id: 'd-1', name: 'Finance', mimeType: 'application/vnd.google-apps.folder' }),
    );
    const { files } = filesAnswering();
    const folder = await invokeToolForTest(
      get,
      { fileId: 'd-1' },
      { connections: { drive: drive() }, files },
    );
    expect(folder.kind === 'err' ? folder.error.message : '').toContain('is a folder');
    driveAnswering(googleError(404, 'notFound', 'File not found: f-gone.'));
    const gone = await invokeToolForTest(
      get,
      { fileId: 'f-gone' },
      { connections: { drive: drive() }, files },
    );
    expect(gone.kind === 'err' ? gone.error.message : '').toContain(
      "Google Drive refused the call (HTTP 404): File not found: f-gone. The file is gone, or the connection can't see it.",
    );
  });
});

describe('google drive file create', () => {
  const ADDED = {
    id: 'f-new',
    name: 'Summary.md',
    mimeType: 'text/markdown',
    size: '9',
    modifiedTime: '2026-11-04T07:00:00.000Z',
    webViewLink: 'https://drive.google.com/file/d/f-new/view',
    parents: ['root-id'],
    owners: [{ emailAddress: 'ana@acme.test', me: true }],
  };

  it('adds text in one request, its details and bytes as multipart, marked with the call', async () => {
    const sent = driveAnswering(
      () => Response.json({ files: [] }),
      () => Response.json(ADDED),
    );
    const key = randomUUID();
    const mark = createHash('sha256').update(key).digest('hex');
    const r = await invokeToolForTest(
      create,
      { name: 'Summary.md', text: '# Summary', contentType: 'text/markdown' },
      { connections: { drive: drive() }, idempotencyKey: key },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        id: 'f-new',
        name: 'Summary.md',
        kind: 'file',
        contentType: 'text/markdown',
        size: 9,
        modified: '2026-11-04T07:00:00Z',
        link: 'https://drive.google.com/file/d/f-new/view',
        folderId: 'root-id',
      },
    });
    // The guard first: a file this call added before.
    expect(params(sent[0]?.url ?? '')).toEqual({
      q: `appProperties has { key='kindgiCall' and value='${mark}' }`,
      pageSize: '1',
      fields: `files(${FIELDS},trashed)`,
    });
    expect(sent[1]?.method).toBe('POST');
    expect(sent[1]?.url).toBe(
      `${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`,
    );
    const type = sent[1]?.headers['content-type'] ?? '';
    const boundary = /^multipart\/related; boundary=(kindgi-[0-9a-f-]{36})$/.exec(type)?.[1];
    expect(boundary).toBeDefined();
    expect(Buffer.from(sent[1]?.body as Uint8Array).toString('utf8')).toBe(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
        `{"name":"Summary.md","appProperties":{"kindgiCall":"${mark}"}}\r\n` +
        `--${boundary}\r\ncontent-type: text/markdown\r\n\r\n# Summary\r\n--${boundary}--\r\n`,
    );
    expect(JSON.stringify(sent)).not.toContain(key);
  });

  it('a call made again answers the file it added before, adding nothing; one trashed since is refused', async () => {
    const key = randomUUID();
    const sent = driveAnswering(() => Response.json({ files: [ADDED] }));
    const r = await invokeToolForTest(
      create,
      { name: 'Summary.md', text: '# Summary' },
      { connections: { drive: drive() }, idempotencyKey: key },
    );
    expect(r).toMatchObject({ kind: 'ok', value: { id: 'f-new' } });
    expect(sent).toHaveLength(1);
    driveAnswering(() => Response.json({ files: [{ ...ADDED, trashed: true }] }));
    const trashed = await invokeToolForTest(
      create,
      { name: 'Summary.md', text: '# Summary' },
      { connections: { drive: drive() }, idempotencyKey: key },
    );
    expect(trashed.kind === 'err' ? trashed.error.message : '').toContain('moved to the trash');
  });

  it('a step run again gets the first answer from its record, sending nothing', async () => {
    const sent = driveAnswering(
      () => Response.json({ files: [] }),
      () => Response.json(ADDED),
    );
    const ctx = {
      connections: { drive: drive() },
      idempotencyKey: randomUUID(),
      record: journal(),
    };
    const first = await invokeToolForTest(create, { name: 'Summary.md', text: '# Summary' }, ctx);
    expect(await invokeToolForTest(create, { name: 'Summary.md', text: '# Summary' }, ctx)).toEqual(
      first,
    );
    expect(sent).toHaveLength(2);
  });

  it('with no key, no guard and no mark; with convert, CSV becomes a Sheet', async () => {
    const sent = driveAnswering(() =>
      Response.json({ ...ADDED, mimeType: 'application/vnd.google-apps.spreadsheet' }),
    );
    await invokeToolForTest(
      create,
      { name: 'Budget', text: 'a,b\n1,2\n', contentType: 'text/csv', convert: true },
      { connections: { drive: drive() } },
    );
    expect(sent).toHaveLength(1);
    const body = Buffer.from(sent[0]?.body as Uint8Array).toString('utf8');
    expect(body).toContain(
      '{"name":"Budget","mimeType":"application/vnd.google-apps.spreadsheet"}',
    );
    expect(body).toContain('content-type: text/csv\r\n\r\na,b\n1,2\n\r\n');
  });

  it("adds a run's file by its file value, read from the run's files; one it may not read is refused", async () => {
    const sent = driveAnswering(() => Response.json({ ...ADDED, name: 'Logo.png' }));
    const { files, read } = filesAnswering({ reads: { 'art-7': { bytes: PNG } } });
    const r = await invokeToolForTest(
      create,
      {
        file: {
          type: 'kindgi.file',
          artifactId: 'art-7',
          name: 'Logo.png',
          contentType: 'image/png',
          size: 11,
        },
      },
      { connections: { drive: drive() }, files },
    );
    expect(r).toMatchObject({ kind: 'ok', value: { name: 'Logo.png' } });
    expect(read).toEqual(['art-7']);
    const body = Buffer.from(sent[0]?.body as Uint8Array);
    expect(body.includes(Buffer.from(PNG))).toBe(true);
    expect(body.toString('latin1')).toContain('content-type: image/png\r\n\r\n');

    const refused = await invokeToolForTest(
      create,
      { file: { artifactId: 'art-8', name: 'x.pdf', contentType: 'application/pdf' } },
      { connections: { drive: drive() }, files },
    );
    expect(refused.kind === 'err' ? refused.error.message : '').toContain(
      'The run file "art-8" can\'t be read: rule.',
    );
    expect(sent).toHaveLength(1);
  });

  it('refuses a create with neither text nor a file, or both, a file of a type a run has none of, or convert of a PDF', async () => {
    const sent = driveAnswering(() => Response.json(ADDED));
    const { files } = filesAnswering({ reads: { 'art-7': { bytes: PNG } } });
    const ctx = { connections: { drive: drive() }, files };
    const messages: string[] = [];
    for (const input of [
      { name: 'x.txt' },
      {
        name: 'x.txt',
        text: 'x',
        file: { artifactId: 'art-7', name: 'a.png', contentType: 'image/png' },
      },
      { text: 'no name' },
      { file: { artifactId: 'art-7', name: 'a.zip', contentType: 'application/zip' } },
      {
        file: { artifactId: 'art-7', name: 'a.pdf', contentType: 'application/pdf' },
        convert: true,
      },
    ]) {
      const r = await invokeToolForTest(create, input, ctx);
      messages.push(
        r.kind === 'err' ? r.error.message.replace(/^Tool "[^"]+" handler threw: /, '') : 'ok',
      );
    }
    expect(messages).toEqual([
      'Give the file as `text` or as a run `file`: one of the two.',
      'Give the file as `text` or as a run `file`: one of the two.',
      'A file from `text` needs a `name`.',
      "The run file's `contentType` isn't one a run's file has: give its file value as it came.",
      '`convert` takes a text, Markdown or CSV file: a Google Doc or Sheet is made from those.',
    ]);
    expect(sent).toHaveLength(0);
  });

  it('adds a file past 5 MB in two requests: its details, then its bytes at the upload address Drive gave', async () => {
    const big = new Uint8Array(5_000_001).fill(0x41);
    const address = `${UPLOAD}?uploadType=resumable&upload_id=xa298sd_sdlkj2`;
    const sent = driveAnswering(
      () => new Response(null, { status: 200, headers: { location: address } }),
      () => Response.json({ ...ADDED, name: 'Big.txt', mimeType: 'text/plain' }),
    );
    const { files } = filesAnswering({ reads: { 'art-9': { bytes: big } } });
    const r = await invokeToolForTest(
      create,
      { file: { artifactId: 'art-9', name: 'Big.txt', contentType: 'text/plain' } },
      { connections: { drive: drive() }, files },
    );
    expect(r).toMatchObject({ kind: 'ok', value: { name: 'Big.txt' } });
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      [
        'POST',
        `${UPLOAD}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`,
      ],
      ['PUT', address],
    ]);
    expect(sent[0]?.headers).toMatchObject({
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'text/plain',
      'x-upload-content-length': '5000001',
    });
    expect(sent[0]?.body).toBe('{"name":"Big.txt"}');
    expect(sent[1]?.body).toBe(big);
  });

  it("never sends the bytes to an upload address off Drive's own upload path", async () => {
    for (const location of [
      'https://uploads.example.test/upload/drive/v3/files?upload_id=1',
      'http://www.googleapis.com/upload/drive/v3/files?upload_id=1',
      'https://www.googleapis.com/drive/v3/files?upload_id=1',
      'https://www.googleapis.com/upload/drive/v3/files',
      'not a url',
    ]) {
      const sent = driveAnswering(() => new Response(null, { status: 200, headers: { location } }));
      const { files } = filesAnswering({
        reads: { 'art-9': { bytes: new Uint8Array(5_000_001) } },
      });
      const r = await invokeToolForTest(
        create,
        { file: { artifactId: 'art-9', name: 'Big.txt', contentType: 'text/plain' } },
        { connections: { drive: drive() }, files },
      );
      expect(r.kind === 'err' ? r.error.message : '').toContain(
        "Google Drive's upload address isn't its own upload path.",
      );
      expect(sent).toHaveLength(1);
    }
  });
});

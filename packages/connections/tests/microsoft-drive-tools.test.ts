// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The OneDrive and SharePoint tools. The answers are in the shapes
 * Microsoft Graph's reference gives: list children, search and get a
 * driveItem, its remoteItem facet (learn.microsoft.com/en-us/graph/api/
 * resources/driveitem), upload by PUT .../content, search sites, and list
 * a site's drives.
 */

import { randomUUID } from 'node:crypto';

import {
  type FileReadAnswer,
  type FileStore,
  type ToolConnection,
  invokeToolForTest,
} from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  oneDriveFileCreate,
  oneDriveFilesList,
  oneDriveSharedFilesList,
  sharePointLibrariesList,
} from '../src/microsoft-tools.js';

const TOKEN = 'eyJ0eXAi.not-a-real-token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const FIELDS = 'id,name,file,folder,size,lastModifiedDateTime,webUrl,parentReference,remoteItem';
const PAGE = `$select=${encodeURIComponent(FIELDS)}&$top=25`;

const list = oneDriveFilesList({ id: 'acme.onedrive.list' });
const shared = oneDriveSharedFilesList({ id: 'acme.onedrive.shared' });
const create = oneDriveFileCreate({ id: 'acme.onedrive.create' });
const libraries = sharePointLibrariesList({ id: 'acme.sharepoint.libraries' });

/** A PNG's first bytes. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function account(): ToolConnection {
  return {
    connectionId: randomUUID(),
    app: 'microsoft',
    appName: 'Microsoft',
    accessToken: TOKEN,
    account: { id: 'm-1', label: 'ana@acme.test' },
  };
}

const onedrive = () => ({ connections: { onedrive: account() } });

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | undefined;
}

/** Microsoft Graph, stubbed: each call's answer in turn, and what each call sent. */
function graphAnswering(...answers: (() => Response)[]): Sent[] {
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

/** A file store that reads `reads`, and stores nothing. */
function filesReading(reads: Readonly<Record<string, FileReadAnswer>>) {
  const read: string[] = [];
  const files: FileStore = {
    store: async () => {
      throw new Error('a create stores nothing');
    },
    read: async (artifactId) => {
      read.push(artifactId);
      return reads[artifactId] ?? { notRead: 'rule' };
    },
  };
  return { files, read };
}

/** A record that keeps each key's first answer, as a run's journal does. */
function journal() {
  const kept = new Map<string, unknown>();
  return async <T>(key: string, decide: () => T | Promise<T>): Promise<T> => {
    if (!kept.has(key)) kept.set(key, await decide());
    return kept.get(key) as T;
  };
}

const graphError = (status: number, code: string, message: string) => () =>
  Response.json({ error: { code, message } }, { status });

const page = (value: readonly unknown[], nextLink?: string) => () =>
  Response.json({ value, ...(nextLink !== undefined && { '@odata.nextLink': nextLink }) });

/** A refusal's words, without the run's `Tool "<id>" handler threw: ` before them. */
const message = (r: { readonly kind: string; readonly error?: { readonly message: string } }) =>
  r.kind === 'err' ? (r.error?.message ?? '').replace(/^Tool "[^"]+" handler threw: /, '') : '';

const REPORT = {
  id: '01REPORT',
  name: 'Q3 report.pdf',
  file: { mimeType: 'application/pdf' },
  size: 52341,
  lastModifiedDateTime: '2026-11-02T09:15:00.000Z',
  webUrl: 'https://acme-my.sharepoint.com/personal/ana/Documents/Q3%20report.pdf',
  parentReference: { id: '01ROOT', driveId: 'b!own-drive' },
};

const REPORT_LISTED = {
  id: '01REPORT',
  name: 'Q3 report.pdf',
  kind: 'file',
  contentType: 'application/pdf',
  size: 52341,
  modified: '2026-11-02T09:15:00Z',
  link: 'https://acme-my.sharepoint.com/personal/ana/Documents/Q3%20report.pdf',
  folderId: '01ROOT',
};

const FINANCE = {
  id: '01FINANCE',
  name: 'Finance',
  folder: { childCount: 3 },
  size: 90_000,
  lastModifiedDateTime: '2026-11-01T17:00:00+01:00',
  webUrl: 'https://acme-my.sharepoint.com/personal/ana/Documents/Finance',
  parentReference: { id: '01ROOT', driveId: 'b!own-drive' },
};

/** A file Bo shares, as Ana's drive gives it: a shortcut whose `remoteItem` is the file. */
const BO_PLAN = {
  id: '01SHORTCUT',
  name: 'Plan.docx',
  remoteItem: {
    id: '01PLAN',
    name: 'Plan.docx',
    file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    size: 2048,
    lastModifiedDateTime: '2026-10-30T08:00:00Z',
    webUrl: 'https://acme-my.sharepoint.com/personal/bo/Documents/Plan.docx',
    parentReference: { id: '01BOROOT', driveId: 'b!bo-drive' },
    shared: { owner: { user: { displayName: 'Bo', email: 'bo@acme.test' } } },
  },
};

const BO_PLAN_LISTED = {
  id: '01PLAN',
  name: 'Plan.docx',
  kind: 'file',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 2048,
  modified: '2026-10-30T08:00:00Z',
  link: 'https://acme-my.sharepoint.com/personal/bo/Documents/Plan.docx',
  folderId: '01BOROOT',
  driveId: 'b!bo-drive',
  owner: { address: 'bo@acme.test', name: 'Bo' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what each tool declares', () => {
  it('reads its own drive with files.read, beyond it with files.read.all, libraries with sites.read.all', () => {
    const reads = (permission: string, need = 'onedrive') => ({
      mutating: false,
      resultIsOutsideData: true,
      network: { kind: 'allowlist', hosts: ['graph.microsoft.com'] },
      needsSpec: {
        connections: { [need]: { app: 'microsoft', permissions: [permission], as: 'person' } },
      },
    });
    expect(list).toMatchObject(reads('files.read'));
    expect(shared).toMatchObject(reads('files.read.all'));
    expect(libraries).toMatchObject(reads('sites.read.all', 'sharepoint'));
    for (const tool of [list, shared, libraries]) {
      expect(tool.storesFiles).toBeUndefined();
      expect(tool.needsApprovalWhenUnattended).toBeUndefined();
    }
  });

  it('adds with files.readwrite, reading run files, and asks before an unattended create', () => {
    expect(create).toMatchObject({
      mutating: true,
      needsApprovalWhenUnattended: true,
      readsFiles: true,
      network: { kind: 'allowlist', hosts: ['graph.microsoft.com'] },
      needsSpec: {
        connections: {
          onedrive: { app: 'microsoft', permissions: ['files.readwrite'], as: 'person' },
        },
      },
      effects: [
        { kind: 'external-side-effect', resource: 'external:onedrive' },
        { kind: 'sensitive-data-egress', resource: 'external:onedrive' },
      ],
    });
  });

  it("a company tool uses the company's connection and says so", () => {
    const company = oneDriveFileCreate({ id: 'acme.store-onedrive.create', as: 'company' });
    expect(company.needsSpec?.connections?.onedrive).toEqual({
      app: 'microsoft',
      permissions: ['files.readwrite'],
      as: 'company',
    });
    expect(company.description).toContain("the company's OneDrive");
    for (const tool of [
      oneDriveFilesList({ id: 'acme.store-onedrive.list', as: 'company' }),
      oneDriveSharedFilesList({ id: 'acme.store-onedrive.shared', as: 'company' }),
      sharePointLibrariesList({ id: 'acme.store-sharepoint.libraries', as: 'company' }),
    ]) {
      expect(tool.description).toContain("the company's");
      expect(Object.values(tool.needsSpec?.connections ?? {})[0]?.as).toBe('company');
    }
  });
});

describe('onedrive files list', () => {
  it("lists the drive's top level, each file as a list gives it, and a page's skiptoken as next", async () => {
    const sent = graphAnswering(
      page(
        [REPORT, FINANCE, BO_PLAN, { id: '01NONAME' }, null],
        `${GRAPH}/me/drive/root/children?${PAGE}&$skiptoken=tok~2`,
      ),
    );
    const r = await invokeToolForTest(list, {}, onedrive());
    expect(r).toEqual({
      kind: 'ok',
      value: {
        files: [
          REPORT_LISTED,
          {
            id: '01FINANCE',
            name: 'Finance',
            kind: 'folder',
            contentType: 'inode/directory',
            modified: '2026-11-01T16:00:00Z',
            link: 'https://acme-my.sharepoint.com/personal/ana/Documents/Finance',
            folderId: '01ROOT',
          },
          BO_PLAN_LISTED,
        ],
        next: 'tok~2',
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${GRAPH}/me/drive/root/children?${PAGE}`);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("lists a folder by its id, searches with its quotes doubled, and gives next back as Graph's $skiptoken", async () => {
    const sent = graphAnswering(page([]));
    // A personal account's ids hold a `!`.
    await invokeToolForTest(list, { folderId: 'A1B2C3!105', top: 50 }, onedrive());
    await invokeToolForTest(list, { text: "Bo's plan #2" }, onedrive());
    await invokeToolForTest(list, { text: 'plan', next: 'a+b/c=' }, onedrive());
    expect(sent.map((s) => s.url)).toEqual([
      `${GRAPH}/me/drive/items/A1B2C3!105/children?$select=${encodeURIComponent(FIELDS)}&$top=50`,
      `${GRAPH}/me/drive/root/search(q='Bo''s%20plan%20%232')?${PAGE}`,
      `${GRAPH}/me/drive/root/search(q='plan')?${PAGE}&$skiptoken=a%2Bb%2Fc%3D`,
    ]);
  });

  it("reads a skiptoken as it's written: a + stays a +", async () => {
    graphAnswering(page([], `${GRAPH}/me/drive/root/children?$top=25&%24skiptoken=a+b%2Fc`));
    const r = await invokeToolForTest(list, {}, onedrive());
    expect(r).toEqual({ kind: 'ok', value: { files: [], next: 'a+b/c' } });
  });

  it('refuses text with a folder, an id or a next a list never gives, sending nothing', async () => {
    const sent = graphAnswering(page([]));
    for (const input of [
      { text: 'plan', folderId: '01FINANCE' },
      { folderId: '../01ROOT' },
      { folderId: '01ROOT/children' },
      { folderId: '.' },
      { next: 'two words' },
    ]) {
      const r = await invokeToolForTest(list, input, onedrive());
      expect(r.kind, JSON.stringify(input)).toBe('err');
    }
    expect(sent).toHaveLength(0);
  });

  it('never follows a next link: one off Microsoft Graph, or with no skiptoken, is refused', async () => {
    graphAnswering(
      page([REPORT], 'https://graph.microsoft.com.example/v1.0/me/drive?$skiptoken=x'),
    );
    expect(message(await invokeToolForTest(list, {}, onedrive()))).toContain(
      "OneDrive's next page isn't on Microsoft Graph.",
    );
    graphAnswering(page([REPORT], `${GRAPH}/me/drive/root/children?$skip=25`));
    expect(message(await invokeToolForTest(list, {}, onedrive()))).toContain(
      "OneDrive's next page has no `$skiptoken` a list can give back.",
    );
  });

  it("Microsoft's refusal comes back in its words, never with the token, saying what to do", async () => {
    graphAnswering(graphError(403, 'accessDenied', 'Access denied'));
    const denied = message(await invokeToolForTest(list, {}, onedrive()));
    expect(denied).toContain('OneDrive refused the call (HTTP 403): accessDenied: Access denied');
    expect(denied).toContain('the person reconnects Microsoft to allow it');
    expect(denied).not.toContain(TOKEN);
    graphAnswering(graphError(404, 'itemNotFound', 'The resource could not be found.'));
    expect(message(await invokeToolForTest(list, { folderId: '01GONE' }, onedrive()))).toContain(
      "(HTTP 404): itemNotFound: The resource could not be found. It's gone, or the connection can't see it.",
    );
  });
});

describe('onedrive shared files list', () => {
  it('searches the drive itself, not its root, so files others share come too, each with its drive and owner', async () => {
    const sent = graphAnswering(page([REPORT, BO_PLAN]));
    const r = await invokeToolForTest(shared, { text: 'plan' }, onedrive());
    expect(r).toEqual({ kind: 'ok', value: { files: [REPORT_LISTED, BO_PLAN_LISTED] } });
    expect(sent[0]?.url).toBe(`${GRAPH}/me/drive/search(q='plan')?${PAGE}`);
  });

  it("lists a library's top level, a folder in it, and what matches in it, each file in that drive", async () => {
    const sent = graphAnswering(page([{ ...REPORT, parentReference: { id: '01LIBROOT' } }]));
    const r = await invokeToolForTest(shared, { driveId: 'b!lib-1' }, onedrive());
    expect(r).toEqual({
      kind: 'ok',
      value: { files: [{ ...REPORT_LISTED, folderId: '01LIBROOT', driveId: 'b!lib-1' }] },
    });
    await invokeToolForTest(shared, { driveId: 'b!lib-1', folderId: '01LIBDOCS' }, onedrive());
    await invokeToolForTest(shared, { driveId: 'b!lib-1', text: 'budget' }, onedrive());
    expect(sent.map((s) => s.url)).toEqual([
      `${GRAPH}/drives/b!lib-1/root/children?${PAGE}`,
      `${GRAPH}/drives/b!lib-1/items/01LIBDOCS/children?${PAGE}`,
      `${GRAPH}/drives/b!lib-1/root/search(q='budget')?${PAGE}`,
    ]);
  });

  it('refuses a folder without its drive, a call with neither text nor a drive, or a drive id a list never gives', async () => {
    const sent = graphAnswering(page([]));
    expect(message(await invokeToolForTest(shared, { folderId: '01PLAN' }, onedrive()))).toContain(
      'A `folderId` needs its `driveId`',
    );
    expect(message(await invokeToolForTest(shared, {}, onedrive()))).toContain(
      'Give `text`, or a `driveId`',
    );
    expect((await invokeToolForTest(shared, { driveId: 'b!x/../y' }, onedrive())).kind).toBe('err');
    expect(sent).toHaveLength(0);
  });
});

describe('sharepoint libraries list', () => {
  const SITE_1 =
    'acme.sharepoint.com,1f1e1d1c-0000-4000-8000-000000000001,2a2b2c2d-0000-4000-8000-000000000002';
  const SITE_2 =
    'acme.sharepoint.com,3f3e3d3c-0000-4000-8000-000000000003,4a4b4c4d-0000-4000-8000-000000000004';

  it("finds sites by text, then gives each one's libraries, at most top sites", async () => {
    const sent = graphAnswering(
      page([
        { id: 'not/a-site', displayName: 'Skipped' },
        {
          id: SITE_1,
          displayName: 'Finance team',
          webUrl: 'https://acme.sharepoint.com/sites/finance',
        },
        { id: SITE_2, name: 'sales', webUrl: 'https://acme.sharepoint.com/sites/sales' },
        { id: SITE_2.replace('3f3e', '5f5e'), displayName: 'Past top' },
      ]),
      page([
        {
          id: 'b!fin-docs',
          name: 'Documents',
          webUrl: 'https://acme.sharepoint.com/sites/finance/Shared%20Documents',
        },
        { name: 'No id' },
      ]),
      page([{ id: 'b!sales-docs', name: 'Contracts' }]),
    );
    const r = await invokeToolForTest(
      libraries,
      { text: 'finance team', top: 2 },
      { connections: { sharepoint: account() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        libraries: [
          {
            driveId: 'b!fin-docs',
            name: 'Documents',
            link: 'https://acme.sharepoint.com/sites/finance/Shared%20Documents',
            site: { name: 'Finance team', link: 'https://acme.sharepoint.com/sites/finance' },
          },
          {
            driveId: 'b!sales-docs',
            name: 'Contracts',
            site: { name: 'sales', link: 'https://acme.sharepoint.com/sites/sales' },
          },
        ],
      },
    });
    expect(sent.map((s) => s.url)).toEqual([
      `${GRAPH}/sites?search=finance%20team`,
      `${GRAPH}/sites/${SITE_1}/drives?$select=id%2Cname%2CwebUrl`,
      `${GRAPH}/sites/${SITE_2}/drives?$select=id%2Cname%2CwebUrl`,
    ]);
  });

  it("a personal account's refusal comes back in SharePoint's words", async () => {
    graphAnswering(graphError(400, 'invalidRequest', 'Invalid request'));
    expect(
      message(
        await invokeToolForTest(
          libraries,
          { text: 'finance' },
          { connections: { sharepoint: account() } },
        ),
      ),
    ).toContain('SharePoint refused the call (HTTP 400): invalidRequest: Invalid request');
  });
});

describe('onedrive file create', () => {
  const ADDED = {
    id: '01SUMMARY',
    name: 'Summary.md',
    file: { mimeType: 'text/markdown' },
    size: 9,
    lastModifiedDateTime: '2026-11-04T07:00:00Z',
    webUrl: 'https://acme-my.sharepoint.com/personal/ana/Documents/Summary.md',
    parentReference: { id: '01ROOT', driveId: 'b!own-drive' },
  };
  const ADDED_LISTED = {
    id: '01SUMMARY',
    name: 'Summary.md',
    kind: 'file',
    contentType: 'text/markdown',
    size: 9,
    modified: '2026-11-04T07:00:00Z',
    link: 'https://acme-my.sharepoint.com/personal/ana/Documents/Summary.md',
    folderId: '01ROOT',
  };
  const PUT_ROOT = `${GRAPH}/me/drive/root:/Summary.md:/content?@microsoft.graph.conflictBehavior=fail`;

  it('adds text at the top level in one PUT, which never replaces a file of that name', async () => {
    const sent = graphAnswering(() => Response.json(ADDED, { status: 201 }));
    const r = await invokeToolForTest(
      create,
      { name: 'Summary.md', text: '# Summary', contentType: 'text/markdown' },
      onedrive(),
    );
    expect(r).toEqual({ kind: 'ok', value: ADDED_LISTED });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.url).toBe(PUT_ROOT);
    expect(sent[0]?.headers['content-type']).toBe('text/markdown');
    expect(Buffer.from(sent[0]?.body as Uint8Array).toString('utf8')).toBe('# Summary');
  });

  it("adds a run's file into a folder by its id, the name one path segment", async () => {
    const sent = graphAnswering(() =>
      Response.json({ ...ADDED, name: 'Logo #1.png', file: { mimeType: 'image/png' }, size: 11 }),
    );
    const { files, read } = filesReading({ 'art-7': { bytes: PNG } });
    const r = await invokeToolForTest(
      create,
      {
        file: {
          type: 'kindgi.file',
          artifactId: 'art-7',
          name: 'Logo.png',
          contentType: 'image/png',
        },
        name: 'Logo #1.png',
        folderId: 'A1B2C3!105',
      },
      { ...onedrive(), files },
    );
    expect(r).toMatchObject({ kind: 'ok', value: { name: 'Logo #1.png', size: 11 } });
    expect(read).toEqual(['art-7']);
    expect(sent[0]?.url).toBe(
      `${GRAPH}/me/drive/items/A1B2C3!105:/Logo%20%231.png:/content?@microsoft.graph.conflictBehavior=fail`,
    );
    expect(sent[0]?.headers['content-type']).toBe('image/png');
    expect(sent[0]?.body).toEqual(PNG);
  });

  it('a name already there answers that file when it has the same size, as for a call made again; else it says so', async () => {
    const sent = graphAnswering(
      graphError(409, 'nameAlreadyExists', 'The specified item name already exists.'),
      () => Response.json(ADDED),
    );
    const again = await invokeToolForTest(
      create,
      { name: 'Summary.md', text: '# Summary' },
      onedrive(),
    );
    expect(again).toEqual({ kind: 'ok', value: ADDED_LISTED });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `PUT ${PUT_ROOT}`,
      `GET ${GRAPH}/me/drive/root:/Summary.md?${PAGE.split('&')[0]}`,
    ]);

    graphAnswering(graphError(409, 'nameAlreadyExists', 'exists'), () =>
      Response.json({ ...ADDED, size: 5 }),
    );
    expect(
      message(
        await invokeToolForTest(create, { name: 'Summary.md', text: '# Summary' }, onedrive()),
      ),
    ).toBe('A file named "Summary.md" is already there: give the file another `name`.');

    graphAnswering(graphError(409, 'nameAlreadyExists', 'exists'), () =>
      Response.json({ ...FINANCE, name: 'Summary.md' }),
    );
    expect(
      message(
        await invokeToolForTest(create, { name: 'Summary.md', text: '# Summary' }, onedrive()),
      ),
    ).toBe('A folder named "Summary.md" is already there: give the file another `name`.');
  });

  it('a step run again gets the first answer from its record, sending nothing', async () => {
    const sent = graphAnswering(() => Response.json(ADDED, { status: 201 }));
    const ctx = { ...onedrive(), idempotencyKey: randomUUID(), record: journal() };
    const first = await invokeToolForTest(create, { name: 'Summary.md', text: '# Summary' }, ctx);
    expect(await invokeToolForTest(create, { name: 'Summary.md', text: '# Summary' }, ctx)).toEqual(
      first,
    );
    expect(sent).toHaveLength(1);
  });

  it("refuses a name that isn't one path segment, and a folder id a list never gives, sending nothing", async () => {
    const sent = graphAnswering(() => Response.json(ADDED));
    const { files } = filesReading({ 'art-7': { bytes: PNG } });
    for (const name of ['..', '.']) {
      expect(message(await invokeToolForTest(create, { name, text: 'x' }, onedrive()))).toContain(
        "isn't a name a OneDrive file can have",
      );
    }
    expect(
      message(
        await invokeToolForTest(
          create,
          { file: { artifactId: 'art-7', name: 'a/b.png', contentType: 'image/png' } },
          { ...onedrive(), files },
        ),
      ),
    ).toContain('"a/b.png" isn\'t a name a OneDrive file can have');
    for (const input of [
      { name: 'a/b.md', text: 'x' },
      { name: 'b.md', text: 'x', folderId: '01ROOT:/x' },
    ]) {
      expect((await invokeToolForTest(create, input, onedrive())).kind).toBe('err');
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses in Microsoft's words when the upload fails", async () => {
    graphAnswering(graphError(507, 'quotaLimitReached', 'Insufficient Space Available'));
    expect(
      message(
        await invokeToolForTest(create, { name: 'Summary.md', text: '# Summary' }, onedrive()),
      ),
    ).toBe(
      "OneDrive didn't add the file (HTTP 507): quotaLimitReached: Insufficient Space Available",
    );
  });
});

describe('a file listed is sized only as Graph says', () => {
  it('drops a size that is not a whole number, and gives an untyped file as octet-stream', async () => {
    graphAnswering(page([{ id: '01ODD', name: 'odd', size: 1.5, file: {} }]));
    const r = await invokeToolForTest(list, {}, onedrive());
    expect(r).toEqual({
      kind: 'ok',
      value: {
        files: [
          { id: '01ODD', name: 'odd', kind: 'file', contentType: 'application/octet-stream' },
        ],
      },
    });
  });
});

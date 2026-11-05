// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi files`, through the client, and the line each `kindgi artifacts` command says. */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ConnectionsSeam } from '../src/commands/connections.js';
import { DEPRECATED_COMMANDS } from '../src/commands/deprecated.js';
import { findCommand } from '../src/commands/index.js';
import { guessContentType } from '../src/content-type-guess.js';
import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const VERSION = {
  fileId: 'f-1',
  version: 2,
  blobId: 'b-2',
  name: 'report.md',
  contentType: 'text/markdown',
  size: 5,
  hash: sha256('hello'),
  tags: {},
  madeVia: 'upload',
  parentVersion: 1,
  createdBy: 'user:u-1',
  createdAt: '2026-11-05T08:00:00Z',
};

const FILE = {
  fileId: 'f-1',
  tenantId: 't',
  name: 'report.md',
  projectId: 'p-1',
  ownerRunId: 'r-1',
  latestVersion: 2,
  highestVersion: 3,
  pinnedVersions: [1],
  latest: VERSION,
  createdAt: '2026-11-05T07:00:00Z',
  updatedAt: '2026-11-05T08:00:00Z',
};

/** Versions 3 (deleted), 2 (Latest) and 1 (pinned), newest first. */
const VERSIONS = [
  { ...VERSION, version: 3, blobId: 'b-3', deletedAt: '2026-11-05T09:00:00Z' },
  VERSION,
  {
    ...VERSION,
    version: 1,
    blobId: 'f-1',
    parentVersion: undefined,
    pin: { by: 'user:u-1', at: '2026-11-05T07:30:00Z', reason: 'signed' },
  },
];

const conflict = (expectedVersion: number, latestVersion: number) =>
  new KindgiApiError({
    code: 'conflict',
    reason: 'file-version-conflict',
    message: `Latest is version ${latestVersion}, not ${expectedVersion}`,
    fields: { expectedVersion, latestVersion },
  } as never);

const NO_ROUTE = new KindgiApiError({
  code: 'not-found',
  serverCode: 'route-not-found',
  message: 'No route for GET /v1/files',
  resource: { kind: 'route', id: 'unknown' },
} as never);

interface Fakes {
  /** Set, every files call throws it. */
  readonly fails?: unknown;
  /** What `versions.add` and `restore` answer. */
  readonly write?: () => unknown;
  readonly body?: string;
  readonly hash?: string;
  readonly connectionsSeam?: ConnectionsSeam;
  readonly stopSignal?: AbortSignal;
}

async function run(argv: readonly string[], fakes: Fakes = {}) {
  const calls: unknown[][] = [];
  const rec =
    (name: string, value: () => unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      if (fakes.fails !== undefined) throw fakes.fails;
      return value();
    };
  const write = fakes.write ?? (() => ({ version: { ...VERSION, version: 3 }, created: true }));
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    connectionsSeam: fakes.connectionsSeam ?? { interactive: () => false },
    ...(fakes.stopSignal !== undefined && { stopSignal: fakes.stopSignal }),
    clientFactory: () =>
      ({
        files: {
          list: rec('files.list', () => ({ data: [FILE], hasMore: true, nextCursor: 'c-2' })),
          get: rec('files.get', () => FILE),
          create: rec('files.create', () => ({
            version: { ...VERSION, version: 1 },
            created: true,
          })),
          delete: rec('files.delete', () => ({ fileId: 'f-1', deleted: true })),
          pinHistory: rec('files.pinHistory', () => ({
            data: [
              {
                changeId: 'ch-1',
                fileId: 'f-1',
                version: 1,
                change: 'pin',
                by: 'user:u-1',
                at: '2026-11-05T07:30:00Z',
                reason: 'signed',
              },
            ],
            hasMore: false,
          })),
          versions: {
            list: rec('files.versions.list', () => ({ data: VERSIONS, hasMore: false })),
            get: rec('files.versions.get', () => VERSION),
            add: rec('files.versions.add', write),
            restore: rec('files.versions.restore', write),
            delete: rec('files.versions.delete', () => ({
              fileId: 'f-1',
              version: 3,
              deleted: true,
            })),
            pin: rec('files.versions.pin', () => VERSIONS[2]),
            unpin: rec('files.versions.unpin', () => VERSION),
            download: rec('files.versions.download', () => ({
              fileId: 'f-1',
              version: 2,
              name: 'report.md',
              contentType: 'text/markdown',
              size: 5,
              hash: fakes.hash ?? sha256(fakes.body ?? 'hello'),
              body: new Response(fakes.body ?? 'hello').body!,
            })),
          },
        },
        artifacts: {
          list: rec('artifacts.list', () => ({ data: [], hasMore: false })),
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi files list, get, versions, pin-history', () => {
  test('list sends its filters, and --table has a row per file', async () => {
    const { out, calls } = await run([
      'files',
      'list',
      '--run=r-1',
      '--project=p-1',
      '--content-type=text/markdown',
      '--limit=10',
      '--cursor=c-1',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'files.list',
        {
          ownerRunId: 'r-1',
          projectId: 'p-1',
          contentType: 'text/markdown',
          limit: 10,
          cursor: 'c-1',
        },
      ],
    ]);
    expect(JSON.parse(out.stdout).data[0].fileId).toBe('f-1');

    const table = await run(['files', 'list', '--table']);
    expect(table.out.stdout).toMatch(/^ID\s+NAME\s+TYPE\s+LATEST\s+SIZE\s+PROJECT\s+RUN\s+UPDATED/);
    expect(table.out.stdout).toMatch(/f-1\s+report\.md\s+text\/markdown\s+v2\s+5\s+p-1\s+r-1/);
    expect(table.out.stderr).toBe('Next page: --cursor=c-2\n');
  });

  test('get reads the file, or with a version (a number or latest) that version', async () => {
    const file = await run(['files', 'get', 'f-1']);
    const latest = await run(['files', 'get', 'f-1', 'latest']);
    const two = await run(['files', 'get', 'f-1', '2']);
    expect([file.calls, latest.calls, two.calls]).toEqual([
      [['files.get', 'f-1']],
      [['files.versions.get', 'f-1', 'latest']],
      [['files.versions.get', 'f-1', 2]],
    ]);

    for (const bad of ['0', 'v2', '1.5']) {
      const { out, calls } = await run(['files', 'get', 'f-1', bad]);
      expect(out.exitCode, bad).toBe(2);
      expect(out.stderr).toContain(
        `<version> must be a whole number from 1, or latest, got "${bad}"`,
      );
      expect(calls).toEqual([]);
    }
  });

  test("versions lists every number; its table names each one's state from the file's Latest", async () => {
    const json = await run(['files', 'versions', 'f-1']);
    expect(json.calls).toEqual([['files.versions.list', 'f-1', {}]]);

    const table = await run(['files', 'versions', 'f-1', '--table']);
    expect(table.calls.map(([name]) => name)).toEqual(['files.versions.list', 'files.get']);
    // The header, the rule under it, then a row per version.
    const [header, rule, ...rows] = table.out.stdout.trim().split('\n');
    expect(header).toMatch(/^VERSION\s+STATE\s+CREATED\s+BY\s+HOW\s+SIZE\s+PINNED$/);
    expect(rule).toMatch(/^[─ ]+$/);
    expect(rows.map((r) => r.split(/\s+/).slice(0, 2))).toEqual([
      ['3', 'deleted'],
      ['2', 'latest'],
      ['1', 'live'],
    ]);
    expect(rows[2]).toMatch(/yes$/);
  });

  test('pin-history is one list, with its table', async () => {
    const { out, calls } = await run(['files', 'pin-history', 'f-1', '--limit=5', '--table']);
    expect(calls).toEqual([['files.pinHistory', 'f-1', { limit: 5 }]]);
    expect(out.stdout).toMatch(/^VERSION\s+CHANGE\s+BY\s+AT\s+REASON/);
    expect(out.stdout).toMatch(/1\s+pin\s+user:u-1\s+2026-11-05T07:30:00Z\s+signed/);
  });
});

describe('kindgi files download', () => {
  test('writes Latest under its own name, and says the number it got', async () => {
    const { out, calls } = await run(['files', 'download', 'f-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['files.versions.download', 'f-1', 'latest']]);
    expect(JSON.parse(out.stdout)).toEqual({
      fileId: 'f-1',
      version: 2,
      file: join(cwd, 'report.md'),
      size: 5,
      hash: sha256('hello'),
    });
    expect(await readFile(join(cwd, 'report.md'), 'utf8')).toBe('hello');
  });

  test('a named version, to -o; a file already there is kept without --force', async () => {
    const { calls } = await run(['files', 'download', 'f-1', '1', '-o', 'v1.md']);
    expect(calls).toEqual([['files.versions.download', 'f-1', 1]]);
    expect(await readFile(join(cwd, 'v1.md'), 'utf8')).toBe('hello');

    await writeFile(join(cwd, 'v1.md'), 'old');
    const again = await run(['files', 'download', 'f-1', '1', '-o', 'v1.md']);
    expect(again.out.exitCode).toBe(1);
    expect(again.out.stderr).toContain(`${join(cwd, 'v1.md')} exists: pass --force`);
    expect(await readFile(join(cwd, 'v1.md'), 'utf8')).toBe('old');
  });

  test("bytes that aren't the version's are never written", async () => {
    const { out } = await run(['files', 'download', 'f-1'], { hash: sha256('other') });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`not version 2's ${sha256('other')}`);
    expect(await readdir(cwd)).toEqual([]);
  });

  test('a stop before the answer: exit 130, and no file', async () => {
    const stop = new AbortController();
    stop.abort();
    const { out } = await run(['files', 'download', 'f-1'], { stopSignal: stop.signal });
    expect(out.exitCode, out.stderr).toBe(130);
    expect(out.stderr).toBe('kindgi files download stopped: no file was written.\n');
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe('kindgi files upload and restore', () => {
  test('without --to, version 1 of a new file, typed from its extension', async () => {
    await writeFile(join(cwd, 'report.pdf'), 'hello');
    const { out, calls } = await run([
      'files',
      'upload',
      'report.pdf',
      '--run=r-1',
      '--tag=kind=summary',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'files.create',
        {
          body: new Uint8Array(Buffer.from('hello')),
          name: 'report.pdf',
          contentType: 'application/pdf',
          ownerRunId: 'r-1',
          tags: { kind: 'summary' },
        },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toMatchObject({ created: true, version: { version: 1 } });
  });

  test('with --to, a version of that file; --content-type wins over the guess', async () => {
    await writeFile(join(cwd, 'report.md'), 'hello');
    const { out, calls } = await run([
      'files',
      'upload',
      'report.md',
      '--to=f-1',
      '--expected-version=2',
      '--content-type=application/octet-stream',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'files.versions.add',
        'f-1',
        {
          body: new Uint8Array(Buffer.from('hello')),
          contentType: 'application/octet-stream',
          expectedVersion: 2,
        },
      ],
    ]);
  });

  test("bytes that are Latest's already add nothing, and say so; exit 0", async () => {
    await writeFile(join(cwd, 'report.md'), 'hello');
    const { out } = await run(['files', 'upload', 'report.md', '--to=f-1'], {
      write: () => ({ version: VERSION, created: false }),
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ created: false, version: { version: 2 } });
    expect(out.stderr).toBe('Nothing new: these bytes are already version 2.\n');
  });

  test('a Latest that moved writes nothing: both numbers, exit 1', async () => {
    await writeFile(join(cwd, 'report.md'), 'hello');
    const { out } = await run(
      ['files', 'upload', 'report.md', '--to=f-1', '--expected-version=4'],
      {
        write: () => {
          throw conflict(4, 5);
        },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('Latest is version 5, not 4, so nothing was written.\n');
  });

  test('--to with --run or --project, or --expected-version alone, is called wrong', async () => {
    await writeFile(join(cwd, 'report.md'), 'hello');
    for (const argv of [
      ['--to=f-1', '--run=r-1'],
      ['--to=f-1', '--project=p-1'],
      ['--expected-version=1'],
    ]) {
      const { out, calls } = await run(['files', 'upload', 'report.md', ...argv]);
      expect(out.exitCode, argv.join(' ')).toBe(2);
      expect(calls).toEqual([]);
    }
  });

  test('restore sends the Latest it expects, and says when nothing was added', async () => {
    const { out, calls } = await run(['files', 'restore', 'f-1', '1', '--expected-version=2'], {
      write: () => ({ version: VERSION, created: false }),
    });
    expect(calls).toEqual([['files.versions.restore', 'f-1', 1, { expectedVersion: 2 }]]);
    expect(out.stderr).toBe('Nothing new: these bytes are already version 2.\n');

    const moved = await run(['files', 'restore', 'f-1', '1', '--expected-version=2'], {
      write: () => {
        throw conflict(2, 3);
      },
    });
    expect([moved.out.exitCode, moved.out.stderr]).toEqual([
      1,
      'Latest is version 3, not 2, so nothing was written.\n',
    ]);
  });

  test('pin and unpin take a reason', async () => {
    const pinned = await run(['files', 'pin', 'f-1', '1', '--reason=signed']);
    const unpinned = await run(['files', 'unpin', 'f-1', '1']);
    expect([pinned.calls, unpinned.calls]).toEqual([
      [['files.versions.pin', 'f-1', 1, { reason: 'signed' }]],
      [['files.versions.unpin', 'f-1', 1, {}]],
    ]);
    expect(JSON.parse(pinned.out.stdout).pin.reason).toBe('signed');
  });
});

describe('kindgi files delete', () => {
  test('with no terminal and no --yes, nothing is deleted: exit 1', async () => {
    const { out, calls } = await run(['files', 'delete', 'f-1']);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      "kindgi files delete asks first, and there's no terminal to ask on. Run it with --yes.\n",
    );
    expect(calls).toEqual([]);
  });

  test('--yes deletes the file, or with a version that version', async () => {
    const file = await run(['files', 'delete', 'f-1', '--yes']);
    const one = await run(['files', 'delete', 'f-1', '3', '--yes']);
    expect([file.calls, one.calls]).toEqual([
      [['files.delete', 'f-1']],
      [['files.versions.delete', 'f-1', 3]],
    ]);
    expect(JSON.parse(file.out.stdout)).toEqual({ fileId: 'f-1', deleted: true });
  });

  test('at a terminal it names what goes, counting the live versions; no is no', async () => {
    const asked: string[] = [];
    const seam = (yes: boolean): ConnectionsSeam => ({
      interactive: () => true,
      confirm: async (question) => {
        asked.push(question);
        return yes;
      },
    });
    const yes = await run(['files', 'delete', 'f-1'], { connectionsSeam: seam(true) });
    expect(yes.calls.map(([name]) => name)).toEqual([
      'files.get',
      'files.versions.list',
      'files.delete',
    ]);
    const no = await run(['files', 'delete', 'f-1', '2'], { connectionsSeam: seam(false) });
    expect(asked).toEqual([
      'Delete report.md and its 2 versions? [y/N] ',
      'Delete version 2 of report.md? [y/N] ',
    ]);
    expect([no.out.exitCode, no.out.stderr]).toEqual([
      1,
      'kindgi files delete: nothing changed.\n',
    ]);
    expect(no.calls.map(([name]) => name)).toEqual(['files.get']);
  });
});

describe('a runtime without the file store', () => {
  test('every command says so plainly, and exits 1', async () => {
    await writeFile(join(cwd, 'report.md'), 'hello');
    for (const argv of [
      ['files', 'list'],
      ['files', 'upload', 'report.md'],
      ['files', 'delete', 'f-1', '--yes'],
    ]) {
      const { out } = await run(argv, { fails: NO_ROUTE });
      expect(out.exitCode, argv.join(' ')).toBe(1);
      expect(out.stderr).toBe(
        "This runtime doesn't keep files. Whoever runs it turns the file store on.\n",
      );
    }
  });
});

describe('kindgi artifacts, deprecated', () => {
  test('each deprecated command, and the one it names, is a real command', () => {
    for (const [path, { use }] of DEPRECATED_COMMANDS) {
      const words = path.split(' ');
      expect(findCommand(words)?.consumed, path).toBe(words.length);
      const replacement = use.split(' ');
      expect(findCommand(replacement)?.consumed, use).toBe(replacement.length);
      expect(findCommand(replacement)?.command.kind, use).toBe('leaf');
    }
  });

  test('a run says on stderr which command to use; stdout is as it was', async () => {
    const { out } = await run(['artifacts', 'list']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toBe(
      'kindgi artifacts list is deprecated: use kindgi files list. Removed in 0.8.0.\n',
    );
    expect(JSON.parse(out.stdout)).toEqual({ data: [], hasMore: false });
  });

  test("it says so when the call fails, too, and delete's names one version", async () => {
    const { out } = await run(['artifacts', 'delete', 'b-1']);
    expect(out.stderr).toMatch(
      /^kindgi artifacts delete is deprecated: use kindgi files delete <file-id> <version>, which asks first unless --yes\. Removed in 0\.8\.0\.\n/,
    );
  });

  test('the help lines', async () => {
    const root = await run(['--help']);
    expect(root.out.stdout).toContain(
      '  artifacts         Deprecated: use kindgi files. Removed in 0.8.0.\n',
    );
    expect(root.out.stdout).toContain(
      '  files             Files kept in the runtime, with every version: list, get, versions, download, upload, restore, pin, unpin, pin-history, delete.\n',
    );
    const group = await run(['artifacts', '--help']);
    expect(group.out.stdout.split('\n')[0]).toBe('Deprecated: use kindgi files. Removed in 0.8.0.');
  });

  test('"kindgi file" points at kindgi files', async () => {
    const { out } = await run(['file', 'list']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Unknown command "file". Did you mean "kindgi files"?');
  });
});

describe('the type upload guesses', () => {
  test('from the extension in any case, else application/octet-stream', () => {
    expect(
      ['a.md', 'a.PDF', 'a.yaml', 'a.ts', 'a.docx', 'a.png', 'a.bin', 'Makefile'].map(
        guessContentType,
      ),
    ).toEqual([
      'text/markdown',
      'application/pdf',
      'application/yaml',
      'text/x-typescript',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png',
      'application/octet-stream',
      'application/octet-stream',
    ]);
  });
});

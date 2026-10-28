// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi artifacts` and `kindgi capabilities`, through the client. */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runCli } from '../src/main.js';

/** Set, the next links fail with this code, as on a file system with no hard links. */
const links = vi.hoisted(() => ({ fail: undefined as string | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    link: async (from: string, to: string) => {
      if (links.fail !== undefined) {
        throw Object.assign(new Error(`${links.fail}: no link from ${from}`), { code: links.fail });
      }
      return real.link(from, to);
    },
  };
});

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  links.fail = undefined;
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const META = {
  blobId: 'b-1',
  tenantId: 't',
  name: 'report.pdf',
  contentType: 'application/pdf',
  size: 5,
  hash: 'a'.repeat(64),
  tags: {},
  projectId: 'p-1',
  ownerRunId: 'r-1',
  createdAt: '2026-10-07T00:00:00Z',
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** What the download answers: its body, made fresh for each call, and the name, size and hash its headers give. */
interface Download {
  readonly name?: string;
  readonly body: () => ReadableStream<Uint8Array>;
  readonly size: number;
  readonly hash: string;
}

const HELLO: Download = { body: () => new Response('hello').body!, size: 5, hash: sha256('hello') };

/** A file already at the target, not text, so that it is compared byte for byte. */
const OLD = Buffer.from([0, 255, 16, 10]);

/** A body that sends `sent`, then fails as a dropped connection does. */
function cutShort(sent: string): () => ReadableStream<Uint8Array> {
  return () => {
    let started = false;
    return new ReadableStream({
      pull(controller) {
        if (started) return controller.error(new TypeError('terminated'));
        started = true;
        controller.enqueue(new TextEncoder().encode(sent));
      },
    });
  };
}

/** A body that sends `hel`, and `lo` only once `release` is called; `waiting` resolves once it is held. */
function held(): {
  body: () => ReadableStream<Uint8Array>;
  waiting: Promise<void>;
  release: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let sent = false;
  const body = () =>
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          return controller.enqueue(new TextEncoder().encode('hel'));
        }
        reached();
        await gate;
        controller.enqueue(new TextEncoder().encode('lo'));
        controller.close();
      },
    });
  return { body, waiting, release };
}

async function run(argv: readonly string[], download: Download = HELLO) {
  const calls: unknown[][] = [];
  const rec =
    (name: string, value: () => unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return value();
    };
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        artifacts: {
          list: rec('artifacts.list', () => ({ data: [META], hasMore: false })),
          head: rec('artifacts.head', () => ({
            blobId: 'b-1',
            name: 'report.pdf',
            contentType: 'application/pdf',
            size: 5,
            hash: 'a'.repeat(64),
          })),
          upload: rec('artifacts.upload', () => META),
          download: rec('artifacts.download', () => ({
            name: download.name ?? 'report.pdf',
            contentType: 'application/pdf',
            size: download.size,
            hash: download.hash,
            body: download.body(),
          })),
          delete: rec('artifacts.delete', () => ({ blobId: 'b-1', deleted: true })),
        },
        capabilities: {
          list: rec('capabilities.list', () => ({
            data: [
              {
                id: 'feature:vision',
                feature: 'vision',
                description: 'Reads images in its input.',
                providers: [{ providerId: 'acme-openai', models: ['gpt-acme', 'gpt-mini'] }],
              },
              {
                id: 'feature:batch',
                feature: 'batch',
                description: 'Takes requests in a batch.',
                providers: [],
              },
            ],
            hasMore: false,
          })),
          get: rec('capabilities.get', () => ({ id: 'feature:vision' })),
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi artifacts', () => {
  test('upload reads the file, names it after the file, passes run, project and tags', async () => {
    await writeFile(join(cwd, 'report.pdf'), 'hello');
    const { out, calls } = await run([
      'artifacts',
      'upload',
      'report.pdf',
      '--content-type=application/pdf',
      '--run=r-1',
      '--tag=kind=report',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    const input = calls[0]?.[1] as Record<string, unknown>;
    expect(input).toMatchObject({
      name: 'report.pdf',
      contentType: 'application/pdf',
      ownerRunId: 'r-1',
      tags: { kind: 'report' },
    });
    expect(new TextDecoder().decode(input.body as Uint8Array)).toBe('hello');
    expect(JSON.parse(out.stdout)).toMatchObject({ blobId: 'b-1', projectId: 'p-1' });
  });

  test('a bad --tag is refused before any call', async () => {
    await writeFile(join(cwd, 'a.txt'), 'x');
    const { out, calls } = await run(['artifacts', 'upload', 'a.txt', '--tag=nokey']);
    // A usage error.
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--tag must be key=value');
    expect(calls).toEqual([]);
  });

  test('download writes the file under its own name; an existing file is kept unless --force', async () => {
    const first = await run(['artifacts', 'download', 'b-1']);
    expect(first.out.exitCode, first.out.stderr).toBe(0);
    expect(await readFile(join(cwd, 'report.pdf'), 'utf8')).toBe('hello');
    expect(JSON.parse(first.out.stdout)).toMatchObject({
      blobId: 'b-1',
      size: 5,
      hash: sha256('hello'),
    });
    const again = await run(['artifacts', 'download', 'b-1']);
    expect(again.out.exitCode).toBe(1);
    expect(again.out.stderr).toContain('pass --force');
    const forced = await run(['artifacts', 'download', 'b-1', '--force']);
    expect(forced.out.exitCode).toBe(0);
    const other = await run(['artifacts', 'download', 'b-1', '-o', 'copy.pdf']);
    expect(other.out.exitCode).toBe(0);
    expect(await readFile(join(cwd, 'copy.pdf'), 'utf8')).toBe('hello');
    expect((await readdir(cwd)).sort()).toEqual(['copy.pdf', 'report.pdf']);
  });

  test('a download that stops part way writes no file, and with --force leaves the old one as it was', async () => {
    const cut = await run(['artifacts', 'download', 'b-1'], { ...HELLO, body: cutShort('hel') });
    expect(cut.out.exitCode).toBe(1);
    expect(cut.out.stderr).toContain(
      `the download stopped part way (terminated): ${join(cwd, 'report.pdf')} wasn't written`,
    );
    expect(await readdir(cwd)).toEqual([]);
    await writeFile(join(cwd, 'report.pdf'), OLD);
    const forced = await run(['artifacts', 'download', 'b-1', '--force'], {
      ...HELLO,
      body: cutShort('hel'),
    });
    expect(forced.out.exitCode).toBe(1);
    expect(forced.out.stderr).toContain('the download stopped part way');
    expect(await readFile(join(cwd, 'report.pdf'))).toEqual(OLD);
    expect(await readdir(cwd)).toEqual(['report.pdf']);
  });

  test('a rename over the target that fails leaves no partial file', async () => {
    await mkdir(join(cwd, 'report.pdf'));
    const forced = await run(['artifacts', 'download', 'b-1', '--force']);
    expect(forced.out.exitCode).toBe(1);
    expect(await readdir(cwd)).toEqual(['report.pdf']);
    expect(await readdir(join(cwd, 'report.pdf'))).toEqual([]);
  });

  test('a file that turns up at the target during the download is kept, and no partial is left; with --force it is replaced', async () => {
    const target = join(cwd, 'report.pdf');
    const first = held();
    const kept = run(['artifacts', 'download', 'b-1'], { ...HELLO, body: first.body });
    await first.waiting;
    await writeFile(target, OLD);
    first.release();
    const { out } = await kept;
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`${target} exists: pass --force to overwrite it, or -o <file>`);
    expect(await readFile(target)).toEqual(OLD);
    expect(await readdir(cwd)).toEqual(['report.pdf']);
    await rm(target);
    const second = held();
    const forced = run(['artifacts', 'download', 'b-1', '--force'], {
      ...HELLO,
      body: second.body,
    });
    await second.waiting;
    await writeFile(target, OLD);
    second.release();
    expect((await forced).out.exitCode).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(await readdir(cwd)).toEqual(['report.pdf']);
  });

  test('with no hard links, the target is looked for again right before the rename', async () => {
    links.fail = 'EPERM';
    const target = join(cwd, 'report.pdf');
    const written = await run(['artifacts', 'download', 'b-1']);
    expect(written.out.exitCode, written.out.stderr).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(await readdir(cwd)).toEqual(['report.pdf']);
    await rm(target);
    const late = held();
    const kept = run(['artifacts', 'download', 'b-1'], { ...HELLO, body: late.body });
    await late.waiting;
    await writeFile(target, OLD);
    late.release();
    const { out } = await kept;
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`${target} exists: pass --force`);
    expect(await readFile(target)).toEqual(OLD);
    expect(await readdir(cwd)).toEqual(['report.pdf']);
  });

  test("a name that is no file's (empty, `.` or `..`) gives the file the blob id", async () => {
    for (const name of ['', '.', '..']) {
      const got = await run(['artifacts', 'download', 'b-1'], { ...HELLO, name });
      expect(got.out.exitCode, `${name}: ${got.out.stderr}`).toBe(0);
      expect(await readFile(join(cwd, 'b-1'), 'utf8')).toBe('hello');
      expect(await readdir(cwd)).toEqual(['b-1']);
      await rm(join(cwd, 'b-1'));
    }
  });

  test("bytes whose sha256 isn't the one the server sent: no file, and the old one as it was; with no hash sent, the stream's end, and the size and hash of the bytes written", async () => {
    const wrong = { ...HELLO, body: () => new Response('hellx').body! };
    const got = await run(['artifacts', 'download', 'b-1'], wrong);
    expect(got.out.exitCode).toBe(1);
    expect(got.out.stderr).toContain(
      `the bytes that arrived have the sha256 ${sha256('hellx')}, not the artifact's ${sha256('hello')}: ${join(cwd, 'report.pdf')} wasn't written`,
    );
    expect(await readdir(cwd)).toEqual([]);
    await writeFile(join(cwd, 'report.pdf'), OLD);
    const forced = await run(['artifacts', 'download', 'b-1', '--force'], wrong);
    expect(forced.out.exitCode).toBe(1);
    expect(await readFile(join(cwd, 'report.pdf'))).toEqual(OLD);
    expect(await readdir(cwd)).toEqual(['report.pdf']);
    // As a proxy that compresses the body answers: no length, and here no hash either.
    const noHash = await run(['artifacts', 'download', 'b-1', '-o', 'no-hash.pdf'], {
      ...wrong,
      size: 0,
      hash: '',
    });
    expect(noHash.out.exitCode, noHash.out.stderr).toBe(0);
    expect(await readFile(join(cwd, 'no-hash.pdf'), 'utf8')).toBe('hellx');
    expect(JSON.parse(noHash.out.stdout)).toMatchObject({ size: 5, hash: sha256('hellx') });
  });

  test('list filters by run, project and type; as a table with each project', async () => {
    const { out, calls } = await run([
      'artifacts',
      'list',
      '--run=r-1',
      '--project=p-1',
      '--content-type=application/pdf',
      '--table',
    ]);
    expect(calls).toEqual([
      ['artifacts.list', { ownerRunId: 'r-1', projectId: 'p-1', contentType: 'application/pdf' }],
    ]);
    expect(out.stdout).toContain('report.pdf');
    expect(out.stdout).toContain('p-1');
  });

  test('get reads the headers; delete names the artifact', async () => {
    const g = await run(['artifacts', 'get', 'b-1']);
    expect(g.calls).toEqual([['artifacts.head', 'b-1']]);
    expect(JSON.parse(g.out.stdout)).toMatchObject({ name: 'report.pdf', size: 5 });
    const d = await run(['artifacts', 'delete', 'b-1']);
    expect(d.calls).toEqual([['artifacts.delete', 'b-1']]);
  });
});

describe('kindgi capabilities', () => {
  test('list as a table: what each feature means, and your models with it', async () => {
    const { out, calls } = await run(['capabilities', 'list', '--feature=v', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['capabilities.list', { feature: 'v' }]]);
    expect(out.stdout).toContain('Reads images in its input.');
    expect(out.stdout).toContain('acme-openai: gpt-acme, gpt-mini');
    expect(out.stdout).toContain('none of yours');
  });

  test('get by id', async () => {
    const { calls } = await run(['capabilities', 'get', 'feature:vision']);
    expect(calls).toEqual([['capabilities.get', 'feature:vision']]);
  });
});

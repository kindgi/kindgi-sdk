// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi artifacts` and `kindgi capabilities`, through the client. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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

async function run(argv: readonly string[]) {
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
            name: 'report.pdf',
            contentType: 'application/pdf',
            size: 5,
            hash: 'a'.repeat(64),
            body: new Response('hello').body,
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
    expect(JSON.parse(first.out.stdout)).toMatchObject({ blobId: 'b-1', size: 5 });
    const again = await run(['artifacts', 'download', 'b-1']);
    expect(again.out.exitCode).toBe(1);
    expect(again.out.stderr).toContain('pass --force');
    const forced = await run(['artifacts', 'download', 'b-1', '--force']);
    expect(forced.out.exitCode).toBe(0);
    const other = await run(['artifacts', 'download', 'b-1', '-o', 'copy.pdf']);
    expect(other.out.exitCode).toBe(0);
    expect(await readFile(join(cwd, 'copy.pdf'), 'utf8')).toBe('hello');
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

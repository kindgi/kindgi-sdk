// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi memory erasures create / get / list / export / replay`
 * (T273 M-5), through the client's `memory.erasures`.
 */

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

const ERASURE = {
  id: '00000000-0000-4000-8000-000000000001',
  selectorKind: 'participant',
  status: 'completed',
  phase: 'done',
  requestedBy: 'user:admin-1',
  matchable: true,
  counts: { memory_facts: 2 },
  attempts: 0,
  createdAt: '2026-10-07T00:00:00Z',
  completedAt: '2026-10-07T00:01:00Z',
};
const ENTRY = {
  id: ERASURE.id,
  selectorKind: 'participant',
  selectorHmac: 'a'.repeat(64),
  keyId: 'v1.0011223344556677',
  requestedBy: 'user:admin-1',
  status: 'completed',
  createdAt: '2026-10-07T00:00:00Z',
};

async function erasures(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['memory', 'erasures', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        identity: { whoami: record('whoami', { tenantId: 't-1', scopes: [] }) },
        memory: {
          erasures: {
            create: record('create', { ...ERASURE, status: 'pending', phase: 'seed' }),
            get: record('get', ERASURE),
            list: record('list', { data: [ERASURE], hasMore: false, items: [ERASURE] }),
            export: record('export', [ENTRY]),
            replay: record('replay', { replayed: [ENTRY.id], restored: [], unmatched: [] }),
            resume: record('resume', { ...ERASURE, forced: true }),
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi memory erasures (T273 M-5)', () => {
  test.each([
    [['--participant=end-7'], { subject: { kind: 'participant', id: 'end-7' } }],
    [['--user=u-1'], { subject: { kind: 'user', id: 'u-1' } }],
    [['--external=ext-1'], { subject: { kind: 'external', id: 'ext-1' } }],
    [['--fact=f-1'], { factId: 'f-1' }],
    [['--conversation=c-1'], { conversationId: 'c-1' }],
  ])('create %j', async (flags, selector) => {
    const { out, calls } = await erasures(['create', ...flags]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['create', selector]]);
    expect(JSON.parse(out.stdout).status).toBe('pending');
  });

  test('create refuses none, or more than one, selector', async () => {
    for (const flags of [[], ['--fact=f-1', '--user=u-1']]) {
      const { out, calls } = await erasures(['create', ...flags]);
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain('Name exactly one of');
      expect(calls).toEqual([]);
    }
  });

  test('get, and list as a table', async () => {
    const got = await erasures(['get', ERASURE.id]);
    expect(got.calls).toEqual([['get', ERASURE.id]]);
    const listed = await erasures(['list', '--limit=5', '--table']);
    expect(listed.calls).toEqual([['list', { limit: 5 }]]);
    expect(listed.out.stdout).toContain(ERASURE.id);
    expect(listed.out.stdout).toContain('REPLAYABLE');
  });

  test('export to a file, and replay from it', async () => {
    const file = join(cwd, 'ledger.json');
    const exported = await erasures(['export', `--out=${file}`]);
    expect(exported.out.exitCode, exported.out.stderr).toBe(0);
    expect(JSON.parse(exported.out.stdout)).toEqual({ wrote: file, erasures: 1 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ erasures: [ENTRY] });

    const replayed = await erasures(['replay', file]);
    expect(replayed.out.exitCode, replayed.out.stderr).toBe(0);
    expect(replayed.calls).toEqual([['replay', [ENTRY]]]);
  });

  test("replay takes the API's export shape too, and refuses a file that isn't one", async () => {
    const api = join(cwd, 'api.json');
    await writeFile(api, JSON.stringify({ data: [ENTRY] }));
    expect((await erasures(['replay', api])).calls).toEqual([['replay', [ENTRY]]]);
    const bad = join(cwd, 'bad.json');
    await writeFile(bad, JSON.stringify({ rows: [] }));
    const refused = await erasures(['replay', bad]);
    expect(refused.out.exitCode).not.toBe(0);
    expect(refused.out.stderr).toContain("isn't an export");
  });

  test('resume, with and without --force', async () => {
    expect((await erasures(['resume', ERASURE.id])).calls).toEqual([['resume', ERASURE.id, {}]]);
    expect((await erasures(['resume', ERASURE.id, '--force'])).calls).toEqual([
      ['resume', ERASURE.id, { force: true }],
    ]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
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

/** Run the CLI against a stub client that records each call. */
async function run(argv: readonly string[], client: Record<string, unknown>) {
  return runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
  });
}

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

describe('kindgi test-sets', () => {
  test('list narrows by kind and project', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['test-sets', 'list', '--kind=regression', '--project=p-1', '--limit=5', '--cursor=c1'],
      { testSets: { list: rec('list', { data: [], hasMore: false }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'list',
        { kind: 'regression', scopeKind: 'project', scopeId: 'p-1', limit: 5, cursor: 'c1' },
      ],
    ]);
  });

  test('list rejects an unknown kind', async () => {
    const out = await run(['test-sets', 'list', '--kind=bogus'], { testSets: {} });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--kind must be one of');
  });

  test("list doesn't take `corrections`: an agent's corrections are its test set", async () => {
    const out = await run(['test-sets', 'list', '--kind=corrections'], { testSets: {} });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--kind must be one of');
  });

  test('show gets the latest, or a version with --test-set-version', async () => {
    const { calls, rec } = recorder();
    const client = {
      testSets: { get: rec('get'), versions: { get: rec('versions.get') } },
    };
    expect((await run(['test-sets', 'show', 'acme.matches'], client)).exitCode).toBe(0);
    expect(
      (await run(['test-sets', 'show', 'acme.matches', '--test-set-version=1.2.0'], client))
        .exitCode,
    ).toBe(0);
    expect(calls).toEqual([
      ['get', 'acme.matches'],
      ['versions.get', 'acme.matches', '1.2.0'],
    ]);
  });

  test('cases pages a version', async () => {
    const { calls, rec } = recorder();
    const client = { testSets: { listCases: rec('cases', { data: [], hasMore: false }) } };
    const out = await run(
      ['test-sets', 'cases', 's', '--test-set-version=1.0.0', '--limit=10', '--cursor=c2'],
      client,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['cases', 's', '1.0.0', { limit: 10, cursor: 'c2' }]]);
    expect((await run(['test-sets', 'cases', 's'], client)).stderr).toContain('--test-set-version');
  });
});

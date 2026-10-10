// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Finding a retired agent, tool or test set, and an unregistered version,
 * from the CLI: `--include-retired` on the lists, `--include-unregistered`
 * on the versions lists (the same flag blocks and flows take; tools'
 * old `--include-tombstoned` is gone).
 */

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

const PAGE = { data: [], hasMore: false };

/** Run the CLI against a stub client that records each call. */
async function run(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return PAGE;
    };
  const client = {
    agents: { list: rec('agents.list'), versions: { list: rec('agents.versions.list') } },
    tools: { list: rec('tools.list'), versions: { list: rec('tools.versions.list') } },
    evalSuites: { list: rec('evalSuites.list') },
  };
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
  });
  return { out, calls };
}

describe('retired items and unregistered versions', () => {
  test.each([
    [
      ['agents', 'list', '--include-retired'],
      ['agents.list', { includeRetired: true }],
    ],
    [
      ['agents', 'versions', 'acme.drafter', '--include-unregistered'],
      ['agents.versions.list', 'acme.drafter', { includeTombstoned: true }],
    ],
    [
      ['tools', 'list', '--include-retired'],
      ['tools.list', { includeRetired: true }],
    ],
    [
      ['tools', 'versions', 'acme.lookup', '--include-unregistered'],
      ['tools.versions.list', 'acme.lookup', { includeTombstoned: true }],
    ],
    [
      ['eval-suites', 'list', '--include-retired'],
      ['evalSuites.list', { includeRetired: true }],
    ],
  ])('%j', async (argv, call) => {
    const { out, calls } = await run(argv);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([call]);
  });

  test('without the flags, nothing retired or unregistered is asked for', async () => {
    const { calls } = await run(['agents', 'versions', 'acme.drafter']);
    expect(calls).toEqual([['agents.versions.list', 'acme.drafter', {}]]);
    expect((await run(['tools', 'list'])).calls).toEqual([['tools.list', {}]]);
  });

  test("tools' old --include-tombstoned is gone", async () => {
    const { out, calls } = await run(['tools', 'versions', 'acme.lookup', '--include-tombstoned']);
    expect(out.exitCode).not.toBe(0);
    expect(calls).toEqual([]);
  });
});

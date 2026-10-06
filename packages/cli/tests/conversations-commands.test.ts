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

/** `kindgi conversations list` with `flags` against a client that records the call. */
async function list(flags: readonly string[]) {
  const calls: unknown[] = [];
  const out = await runCli({
    argv: ['conversations', 'list', ...flags, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        conversations: {
          list: async (filter: unknown) => {
            calls.push(filter);
            return { items: [] };
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi conversations list', () => {
  test('lists with no filter: the API leaves replay conversations out', async () => {
    const { out, calls } = await list([]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{}]);
  });

  test('--status, --replays, --limit and --cursor map to one list call', async () => {
    const { out, calls } = await list([
      '--status=open',
      '--replays=only',
      '--limit=5',
      '--cursor=c-1',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{ status: 'open', replays: 'only', limit: 5, cursor: 'c-1' }]);
  });

  test('errors: a status or replays it does not know', async () => {
    for (const [flag, message] of [
      ['--status=archived', '--status must be one of open, closed, got "archived"'],
      ['--replays=all', '--replays must be one of exclude, include, only, got "all"'],
    ] as const) {
      const { out, calls } = await list([flag]);
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain(message);
      expect(calls).toEqual([]);
    }
  });
});

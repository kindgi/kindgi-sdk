// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi runs list`: the agent and replay filters reach the client. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
let seen: Record<string, unknown>[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
  seen = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const client = {
  runs: {
    list: async (filter: Record<string, unknown>) => {
      seen.push(filter);
      return { data: [], hasMore: false };
    },
  },
};

function run(...argv: string[]) {
  return runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
  });
}

describe('kindgi runs list', () => {
  test('without replay flags, none are sent (the API leaves replays out)', async () => {
    expect((await run('runs', 'list')).exitCode).toBe(0);
    expect(seen).toEqual([{}]);
  });

  test('--replays and --eval-run reach the client', async () => {
    expect((await run('runs', 'list', '--replays=only')).exitCode).toBe(0);
    expect((await run('runs', 'list', '--eval-run=eval-1')).exitCode).toBe(0);
    expect(seen).toEqual([{ replays: 'only' }, { evalRunId: 'eval-1' }]);
  });

  test('--trigger reaches the client as triggerId', async () => {
    expect((await run('runs', 'list', '--trigger=sched-1')).exitCode).toBe(0);
    expect(seen).toEqual([{ triggerId: 'sched-1' }]);
  });

  test('--agent reaches the client, with the other filters', async () => {
    expect((await run('runs', 'list', '--agent=acme.drafter')).exitCode).toBe(0);
    expect(
      (await run('runs', 'list', '--agent=acme.drafter', '--replays=include', '--limit=5'))
        .exitCode,
    ).toBe(0);
    expect(seen).toEqual([
      { agentId: 'acme.drafter' },
      { agentId: 'acme.drafter', replays: 'include', limit: 5 },
    ]);
  });

  test('a --replays value that is not one of the three is refused', async () => {
    const out = await run('runs', 'list', '--replays=some');
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('--replays must be one of exclude, include, only');
    expect(seen).toEqual([]);
  });
});

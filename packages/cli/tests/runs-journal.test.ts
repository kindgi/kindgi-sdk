// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi runs journal`: `--table` renders the entries; JSON stays the default. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
let seen: unknown[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
  seen = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PAGE = {
  data: [
    { sequence: 0, kind: 'run-started', timestamp: '2026-10-09T12:00:00.000Z' },
    {
      sequence: 1,
      kind: 'node-completed',
      nodeId: 'lookup',
      payload: { output: { status: 'shipped' } },
      timestamp: '2026-10-09T12:00:01.000Z',
    },
  ],
  hasMore: false,
};

const client = {
  runs: {
    journal: async (runId: string, filter?: unknown) => {
      seen.push({ runId, filter });
      return PAGE;
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

describe('kindgi runs journal', () => {
  test('--table renders one row per entry, not the JSON', async () => {
    const out = await run('runs', 'journal', RUN_ID, '--table');
    expect(out.exitCode, out.stderr).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/SEQ\s+KIND\s+NODE\s+TIME/);
    expect(lines.some((l) => /^0\s+run-started\s+2026-10-09T12:00:00\.000Z/.test(l))).toBe(true);
    expect(lines.some((l) => /^1\s+node-completed\s+lookup\s+2026-10-09T12:00:01/.test(l))).toBe(
      true,
    );
    // The payload stays in the JSON, out of the table.
    expect(out.stdout).not.toContain('shipped');
    expect(out.stdout.trimStart().startsWith('{')).toBe(false);
  });

  test('without --table, the page prints as JSON, payloads included', async () => {
    const out = await run('runs', 'journal', RUN_ID);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(PAGE);
  });

  test('--since reaches the client', async () => {
    expect((await run('runs', 'journal', RUN_ID, '--since=1', '--table')).exitCode).toBe(0);
    expect(seen).toEqual([{ runId: RUN_ID, filter: { since: '1' } }]);
  });
});

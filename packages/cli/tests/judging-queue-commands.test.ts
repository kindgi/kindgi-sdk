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

describe('kindgi judging-queue', () => {
  test('list passes the state, the filters and the paging', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'judging-queue',
        'list',
        '--project=p-1',
        '--state=open',
        '--agent=acme.matcher',
        '--rule=jr-1',
        '--class=jc-1',
        '--for-me',
        '--added-after=2026-10-01',
        '--closed-after=2026-10-02',
        '--limit=5',
        '--cursor=c1',
      ],
      { projects: { judgingQueue: { list: rec('list', { data: [], hasMore: false, total: 0 }) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'list',
        'p-1',
        {
          state: 'open',
          agentId: 'acme.matcher',
          ruleId: 'jr-1',
          judgeClassId: 'jc-1',
          forMe: true,
          addedAfter: '2026-10-01T00:00:00.000Z',
          closedAfter: '2026-10-02T00:00:00.000Z',
          limit: 5,
          cursor: 'c1',
        },
      ],
    ]);
  });

  test('list refuses an unknown state', async () => {
    const out = await run(['judging-queue', 'list', '--project=p-1', '--state=waiting'], {
      projects: { judgingQueue: {} },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--state must be one of open, judged, dismissed, erased');
  });

  test('dismiss sends the reason; reopen takes none', async () => {
    const { calls, rec } = recorder();
    const client = {
      projects: {
        judgingQueue: {
          dismiss: rec('dismiss', { runId: 'r-1', state: 'dismissed' }),
          reopen: rec('reopen', { runId: 'r-1', state: 'open' }),
        },
      },
    };
    expect(
      (
        await run(
          ['judging-queue', 'dismiss', 'r-1', '--project=p-1', '--reason=off topic'],
          client,
        )
      ).exitCode,
    ).toBe(0);
    expect((await run(['judging-queue', 'reopen', 'r-1', '--project=p-1'], client)).exitCode).toBe(
      0,
    );
    expect(calls).toEqual([
      ['dismiss', 'p-1', 'r-1', 'off topic'],
      ['reopen', 'p-1', 'r-1'],
    ]);
  });
});

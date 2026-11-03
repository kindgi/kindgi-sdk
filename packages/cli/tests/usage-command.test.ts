// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi usage`: the window it asks for, the flags it passes, and `--table`. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { UsagePage, UsageQuery } from '@kindgi/client';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const PROJECT = '0b3a1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const PAGE: UsagePage = {
  data: [
    {
      projectId: PROJECT,
      kind: 'run.started',
      count: 12,
      quantity: 12,
      firstAt: '2026-11-02T10:00:00.000Z',
      lastAt: '2026-11-29T18:00:00.000Z',
    },
    {
      kind: 'llm.embedding',
      count: 3,
      quantity: 9000,
      firstAt: '2026-11-05T10:00:00.000Z',
      lastAt: '2026-11-05T11:00:00.000Z',
    },
  ],
  watermark: '2026-12-01T00:04:00.000Z',
  nextCursor: 'c-2',
};

function usage(...argv: string[]) {
  const asked: UsageQuery[] = [];
  const client = {
    usage: {
      read: async (query: UsageQuery) => {
        asked.push(query);
        return PAGE;
      },
    },
  };
  const out = runCli({
    argv: ['usage', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
  });
  return { out, asked };
}

describe('kindgi usage', () => {
  test('--month reads that calendar month in UTC, and prints the page as JSON', async () => {
    const { out, asked } = usage('--month=2026-12');
    const res = await out;
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(PAGE);
    expect(asked).toEqual([{ from: '2026-12-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }]);
  });

  test('without a window, the current UTC month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-28T23:30:00-05:00'));
    const { out, asked } = usage();
    expect((await out).exitCode).toBe(0);
    expect(asked[0]).toEqual({ from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' });
  });

  test('--from and --to, a project, groups, filters, a page', async () => {
    const { out, asked } = usage(
      '--from=2026-11-01',
      '--to=2026-11-15T12:00:00+02:00',
      `--project=${PROJECT}`,
      '--group-by=day,state',
      '--kind=run.ended',
      '--class=production,staging',
      '--state=failed, cancelled',
      '--limit=50',
      '--cursor=c-1',
    );
    expect((await out).exitCode).toBe(0);
    expect(asked[0]).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-15T10:00:00.000Z',
      projectId: PROJECT,
      groupBy: ['day', 'state'],
      kind: ['run.ended'],
      class: ['production', 'staging'],
      state: ['failed', 'cancelled'],
      limit: 50,
      cursor: 'c-1',
    });
  });

  test('--table: a row per group, the watermark and the next page on stderr', async () => {
    const res = await usage('--month=2026-11', '--table').out;
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.split('\n');
    expect(lines[0]).toMatch(/^PROJECT\s+KIND\s+COUNT\s+QUANTITY\s+FIRST\s+LAST$/);
    expect(lines[2]).toMatch(new RegExp(`^${PROJECT}\\s+run\\.started\\s+12\\s+12\\s+`));
    expect(lines[3]).toMatch(/^\(none\)\s+llm\.embedding\s+3\s+9000\s+/);
    expect(res.stderr).toBe(
      'Every record at or before 2026-12-01T00:04:00.000Z is counted.\nNext page: --cursor=c-2\n',
    );
  });

  test('--table follows --group-by', async () => {
    const res = await usage('--month=2026-11', '--group-by=kind', '--table').out;
    expect(res.stdout.split('\n')[0]).toMatch(/^KIND\s+COUNT\s+QUANTITY\s+FIRST\s+LAST$/);
  });

  test('a window the flags get wrong is a usage error, and nothing is read', async () => {
    for (const argv of [
      ['--month=2026-13'],
      ['--month=11-2026'],
      ['--month=2026-11', '--from=2026-11-01'],
      ['--from=2026-11-01'],
      ['--to=2026-11-01'],
      ['--from=yesterday', '--to=2026-11-01'],
      ['--group-by=tenant'],
      ['--limit=ten'],
    ]) {
      const { out, asked } = usage(...argv);
      const res = await out;
      expect(res.exitCode, argv.join(' ')).toBe(2);
      expect(asked, argv.join(' ')).toEqual([]);
    }
  });
});

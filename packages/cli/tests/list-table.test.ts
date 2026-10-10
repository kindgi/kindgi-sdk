// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `--table` on the list commands that have columns: runs, tools and providers. */

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

const client = {
  runs: {
    list: async () => ({
      data: [
        {
          id: 'run-1',
          status: 'completed',
          flowId: 'acme.review',
          createdAt: '2026-10-03T10:00:00.000Z',
        },
        {
          id: 'run-22',
          status: 'failed',
          flowId: 'agent.turn',
          createdAt: '2026-10-03T11:00:00.000Z',
        },
        {
          id: 'run-3',
          status: 'completed',
          flowId: 'agent.turn',
          agent: {
            id: 'acme.desk',
            version: '1.2.0',
            conversationId: 'c0ffee00-0000-4000-8000-000000000003',
          },
          createdAt: '2026-10-03T12:00:00.000Z',
        },
      ],
      hasMore: true,
      nextCursor: 'c-2',
    }),
  },
  tools: {
    list: async () => ({
      data: [
        { id: 'acme.search', version: '1.0.0', description: 'Search the\nrequests by text.' },
        { id: 'acme.long', description: 'x'.repeat(80) },
      ],
      hasMore: false,
    }),
  },
  providers: {
    list: async () => ({
      data: [
        {
          id: 'anthropic',
          region: 'unspecified',
          models: [{ name: 'claude-haiku-4-5' }, { name: 'claude-sonnet-5-5' }],
        },
        { id: 'dev-echo', region: 'unspecified', models: [{ name: 'echo' }], fallback: true },
      ],
      hasMore: false,
    }),
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

describe('--table', () => {
  test('runs list: a row per run, an agent run by its agent; the next page cursor on stderr', async () => {
    const out = await run('runs', 'list', '--table');
    expect(out.exitCode).toBe(0);
    // run-22 is an agent run from a runtime that doesn't name the agent yet: its flow, `agent.turn`.
    expect(out.stdout.split('\n')).toEqual([
      'ID      STATUS     FLOW / AGENT     CREATED',
      '──────  ─────────  ───────────────  ────────────────────────',
      'run-1   completed  acme.review      2026-10-03T10:00:00.000Z',
      'run-22  failed     agent.turn       2026-10-03T11:00:00.000Z',
      'run-3   completed  acme.desk@1.2.0  2026-10-03T12:00:00.000Z',
      '',
    ]);
    expect(out.stderr).toBe('Next page: --cursor=c-2\n');
  });

  test('tools list: one-line, shortened descriptions', async () => {
    const out = await run('tools', 'list', '--table');
    const lines = out.stdout.split('\n');
    expect(lines[0]).toMatch(/^ID\s+VERSION\s+DESCRIPTION$/);
    expect(lines[2]).toMatch(/^acme\.search\s+1\.0\.0\s+Search the requests by text\.$/);
    expect(lines[3]).toBe(`acme.long${' '.repeat(13)}${'x'.repeat(59)}…`);
    expect(out.stderr).toBe('');
  });

  test('providers list: models joined, fallbacks marked', async () => {
    const out = await run('providers', 'list', '--table');
    expect(out.stdout).toContain('anthropic  unspecified  claude-haiku-4-5, claude-sonnet-5-5');
    expect(out.stdout).toMatch(/dev-echo\s+unspecified\s+echo\s+yes/);
  });

  test('without --table, the page is JSON as before', async () => {
    const out = await run('runs', 'list');
    expect(JSON.parse(out.stdout)).toMatchObject({ nextCursor: 'c-2', hasMore: true });
    expect(out.stderr).toBe('');
  });
});

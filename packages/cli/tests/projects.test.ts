// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi projects list / get-default / get <id>`: the ids the
 * `--project=<id>` flags take, through the client's `projects`.
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

const DEFAULT = { id: 'p-default', name: 'Default', slug: 'default', isDefault: true };

async function run(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        projects: {
          list: async (...args: unknown[]) => {
            calls.push(['list', ...args]);
            return { data: [DEFAULT], hasMore: false };
          },
          getDefault: async (...args: unknown[]) => {
            calls.push(['getDefault', ...args]);
            return DEFAULT;
          },
          get: async (...args: unknown[]) => {
            calls.push(['get', ...args]);
            return DEFAULT;
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi projects', () => {
  test('list: the page, with --limit and --cursor passed on', async () => {
    const { out, calls } = await run(['projects', 'list', '--limit=5', '--cursor=c1']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['list', { limit: 5, cursor: 'c1' }]]);
    expect(out.stdout).toContain('p-default');
  });

  test('list without flags asks for the first page', async () => {
    const { calls } = await run(['projects', 'list']);
    expect(calls).toEqual([['list', {}]]);
  });

  test('get-default: the Default project', async () => {
    const { out, calls } = await run(['projects', 'get-default']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['getDefault']]);
    expect(out.stdout).toContain('"isDefault": true');
  });

  test('get <project-id>', async () => {
    const { out, calls } = await run(['projects', 'get', 'p-default']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['get', 'p-default']]);
  });

  test('get without the id: a usage error naming it', async () => {
    const { out, calls } = await run(['projects', 'get']);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('project-id');
    expect(calls).toEqual([]);
  });
});

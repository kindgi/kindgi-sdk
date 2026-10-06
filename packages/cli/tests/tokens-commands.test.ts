// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi tokens create / list / get / revoke` (T238), through the client's `tokens`. */

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

const META = {
  id: 'tok-1',
  role: 'member',
  capabilities: ['env:write'],
  label: 'ci',
  createdAt: '2026-10-06T12:00:00Z',
};

async function tokens(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['tokens', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        tokens: {
          create: record('create', { meta: META, secret: 'kgi_bt_secret' }),
          list: record('list', { items: [META] }),
          get: record('get', META),
          revoke: record('revoke', undefined),
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi tokens (T238)', () => {
  test('create --spec: prints the token with its secret, and says it is shown once', async () => {
    const { out, calls } = await tokens([
      'create',
      '--spec={"role":"member","capabilities":["env:write"],"label":"ci"}',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['create', { role: 'member', capabilities: ['env:write'], label: 'ci' }],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({ meta: META, secret: 'kgi_bt_secret' });
    expect(out.stderr).toContain('The secret of token tok-1 is shown once, above: store it now.');
  });

  test('create with no spec: a member token with no capabilities', async () => {
    const { out, calls } = await tokens(['create']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['create', undefined]]);
  });

  test('list [--limit] [--cursor], and --table without secrets', async () => {
    const { out, calls } = await tokens(['list', '--limit=5', '--cursor=c-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { limit: 5, cursor: 'c-1' }]]);
    const table = await tokens(['list', '--table']);
    expect(table.out.stdout).toContain('tok-1');
    expect(table.out.stdout).not.toContain('kgi_bt_');
  });

  test('get <token-id> and revoke <token-id>', async () => {
    const got = await tokens(['get', 'tok-1']);
    expect(got.calls).toEqual([['get', 'tok-1']]);
    const revoked = await tokens(['revoke', 'tok-1']);
    expect(revoked.out.exitCode, revoked.out.stderr).toBe(0);
    expect(revoked.calls).toEqual([['revoke', 'tok-1']]);
    expect(JSON.parse(revoked.out.stdout)).toEqual({ tokenId: 'tok-1', revoked: true });
  });

  test('get and revoke without the id: a usage error naming it', async () => {
    for (const command of ['get', 'revoke']) {
      const { out, calls } = await tokens([command]);
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain('token-id');
      expect(calls).toEqual([]);
    }
  });
});

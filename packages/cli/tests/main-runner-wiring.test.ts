// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Production runner wiring — no injected runners. Every other command
 * test injects fixtures, which is exactly how `kindgi env …` / `kindgi
 * key …` shipped unusable: the lazy loader matched the resolved LEAF
 * name (`list`) against the group name (`env`), so the real runners were
 * never loaded outside tests. Found by the existing-app pilot.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-wiring-'));
  await writeFile(
    join(dir, 'kindgi.config.mjs'),
    "export default { pack: { id: 'wiring', version: '0.1.0' } };\n",
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('group subcommands load their production runners', () => {
  test('kindgi env list --env=local reads the real env files', async () => {
    await writeFile(join(dir, '.env'), 'APP_NAME=wiring\n');
    const out = await runCli({
      argv: ['env', 'list', '--env=local', `--path=${dir}`],
      cwd: dir,
      env: {},
    });
    expect(out.stderr).not.toContain('runners to be wired');
    expect(out.exitCode).toBe(0);
    expect((JSON.parse(out.stdout) as { count: number }).count).toBe(1);
  });

  test('kindgi key list reads the real key directory', async () => {
    const out = await runCli({ argv: ['key', 'list'], cwd: dir, home: dir, env: {} });
    expect(out.stderr).not.toContain('runners to be wired');
    expect(out.exitCode).toBe(0);
  });
});

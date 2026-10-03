// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The environment `kindgi dev` gives the pack service: the pack's env
 * files minus Kindgi's own settings, plus PATH, HOME and TMPDIR — and
 * nothing else from the shell.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { devPackEnv, devPackEnvFiles } from '../src/dev/pack-env.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-pack-env-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('devPackEnv', () => {
  test("the pack's env files without KINDGI_*, plus PATH/HOME/TMPDIR, and nothing else", async () => {
    await writeFile(
      join(dir, '.env'),
      'DATABASE_URL=postgres://pack\nCORPUS_BUCKET=cases\nKINDGI_DATABASE_URL=postgres://kindgi\n',
    );
    await writeFile(join(dir, '.env.local'), 'CORPUS_BUCKET=cases-local\n');
    const env = await devPackEnv({
      packDir: dir,
      hostEnv: {
        PATH: '/usr/bin',
        HOME: '/home/dev',
        TMPDIR: '/tmp',
        AWS_SECRET_ACCESS_KEY: 'leak',
        KINDGI_API_TOKEN: 'leak',
      },
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      TMPDIR: '/tmp',
      DATABASE_URL: 'postgres://pack',
      CORPUS_BUCKET: 'cases-local',
      NODE_ENV: 'development',
    });
  });

  test('dev.envFiles replaces the default files', async () => {
    await writeFile(join(dir, '.env'), 'FROM_DEFAULT=1\n');
    await writeFile(join(dir, 'config.env'), 'FROM_CONFIG=1\n');
    const env = await devPackEnv({ packDir: dir, localEnvFiles: ['config.env'], hostEnv: {} });
    expect(env).toEqual({ FROM_CONFIG: '1', NODE_ENV: 'development' });
    expect(devPackEnvFiles(dir, ['config.env'])).toEqual([join(dir, 'config.env')]);
  });

  test('no env files: only the host variables', async () => {
    expect(await devPackEnv({ packDir: dir, hostEnv: { PATH: '/bin' } })).toEqual({
      PATH: '/bin',
      NODE_ENV: 'development',
    });
    expect(devPackEnvFiles(dir)).toEqual([join(dir, '.env'), join(dir, '.env.local')]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_LOCAL_ENV_FILES,
  displayEnvPath,
  isRuntimeKey,
  packValues,
  readPackEnv,
  resolvePackEnvFiles,
  runtimeValues,
} from '../src/index.js';

const PACK = '/work/app';

describe('resolvePackEnvFiles', () => {
  test('local: the project files, lowest precedence first; write = the last', () => {
    expect(DEFAULT_LOCAL_ENV_FILES).toEqual(['.env', '.env.local']);
    expect(resolvePackEnvFiles({ packDir: PACK, envName: 'local' })).toEqual({
      read: [join(PACK, '.env'), join(PACK, '.env.local')],
      write: join(PACK, '.env.local'),
    });
  });

  test('local with an override list; absolute entries kept', () => {
    const r = resolvePackEnvFiles({
      packDir: PACK,
      envName: 'local',
      localEnvFiles: ['../shared/.env', '/abs/.env', '.env.dev'],
    });
    expect(r.read).toEqual([join(PACK, '../shared/.env'), '/abs/.env', join(PACK, '.env.dev')]);
    expect(r.write).toBe(join(PACK, '.env.dev'));
  });

  test('other environments: one .env.<envName>, override ignored', () => {
    expect(
      resolvePackEnvFiles({ packDir: PACK, envName: 'staging', localEnvFiles: ['.env'] }),
    ).toEqual({ read: [join(PACK, '.env.staging')], write: join(PACK, '.env.staging') });
  });

  test('an empty override list is an error', () => {
    expect(() =>
      resolvePackEnvFiles({ packDir: PACK, envName: 'local', localEnvFiles: [] }),
    ).toThrow(TypeError);
  });
});

describe('readPackEnv', () => {
  test('merges present files, reports origin, skips missing ones', async () => {
    const files: Record<string, string> = {
      [join(PACK, '.env')]: 'A=1\nB=${A}-base\n',
    };
    const env = await readPackEnv({
      packDir: PACK,
      envName: 'local',
      readFile: async (p) => files[p] ?? null,
    });
    expect(env.present).toEqual([join(PACK, '.env')]);
    expect(env.values).toEqual({ A: '1', B: '1-base' });
    expect(env.origin.B).toBe(join(PACK, '.env'));
  });
});

describe('runtime vs. pack names', () => {
  test('KINDGI_ prefix is the line', () => {
    expect(isRuntimeKey('KINDGI_DATABASE_URL')).toBe(true);
    expect(isRuntimeKey('DATABASE_URL')).toBe(false);
    const all = { KINDGI_X: '1', DATABASE_URL: '2' };
    expect(runtimeValues(all)).toEqual({ KINDGI_X: '1' });
    expect(packValues(all)).toEqual({ DATABASE_URL: '2' });
  });
});

describe('displayEnvPath', () => {
  test('relative inside the pack, absolute outside it', () => {
    expect(displayEnvPath(PACK, join(PACK, '.env.local'))).toBe('.env.local');
    expect(displayEnvPath(PACK, '/elsewhere/.env')).toBe('/elsewhere/.env');
  });
});

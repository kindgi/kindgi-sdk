// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_LOCAL_ENV_FILES,
  KINDGI_SECRETS_FILE,
  describeUnreadable,
  displayEnvPath,
  isRuntimeKey,
  packValues,
  readPackEnv,
  resolvePackEnvFiles,
  runtimeValues,
} from '../src/index.js';

const PACK = '/work/app';

describe('resolvePackEnvFiles', () => {
  test("local: the app's files, then Kindgi's own on top; a secret's write lands in Kindgi's", () => {
    expect(DEFAULT_LOCAL_ENV_FILES).toEqual(['.env', '.env.local']);
    expect(KINDGI_SECRETS_FILE).toBe('.kindgi/secrets.env');
    expect(resolvePackEnvFiles({ packDir: PACK, envName: 'local' })).toEqual({
      read: [join(PACK, '.env'), join(PACK, '.env.local'), join(PACK, '.kindgi/secrets.env')],
      write: join(PACK, '.kindgi/secrets.env'),
      app: [join(PACK, '.env'), join(PACK, '.env.local')],
      appWrite: join(PACK, '.env.local'),
      kindgi: join(PACK, '.kindgi/secrets.env'),
    });
  });

  test("local with an override list: it names the app's files; absolute entries kept", () => {
    const r = resolvePackEnvFiles({
      packDir: PACK,
      envName: 'local',
      localEnvFiles: ['../shared/.env', '/abs/.env', '.env.dev'],
    });
    expect(r.app).toEqual([join(PACK, '../shared/.env'), '/abs/.env', join(PACK, '.env.dev')]);
    expect(r.read).toEqual([...r.app, join(PACK, '.kindgi/secrets.env')]);
    expect(r.write).toBe(join(PACK, '.kindgi/secrets.env'));
    expect(r.appWrite).toBe(join(PACK, '.env.dev'));
  });

  test('other environments: one .env.<envName>, override ignored, no Kindgi file', () => {
    const staging = join(PACK, '.env.staging');
    expect(
      resolvePackEnvFiles({ packDir: PACK, envName: 'staging', localEnvFiles: ['.env'] }),
    ).toEqual({ read: [staging], write: staging, app: [staging], appWrite: staging });
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
    expect(env.unreadable).toEqual([]);
  });

  test("Kindgi's own file wins over the app's", async () => {
    const files: Record<string, string> = {
      [join(PACK, '.env.local')]: 'KEY=from-app\nOTHER=app\n',
      [join(PACK, '.kindgi/secrets.env')]: 'KEY=from-kindgi\n',
    };
    const env = await readPackEnv({
      packDir: PACK,
      envName: 'local',
      readFile: async (p) => files[p] ?? null,
    });
    expect(env.values).toEqual({ KEY: 'from-kindgi', OTHER: 'app' });
    expect(env.origin.KEY).toBe(join(PACK, '.kindgi/secrets.env'));
  });

  test("a file it can't read is left out and named, not thrown", async () => {
    const env = await readPackEnv({
      packDir: PACK,
      envName: 'local',
      readFile: async (p) => {
        if (p === join(PACK, '.env.local')) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return p === join(PACK, '.env') ? 'A=1\n' : null;
      },
    });
    expect(env.values).toEqual({ A: '1' });
    expect(env.unreadable).toEqual([{ file: join(PACK, '.env.local'), code: 'EPERM' }]);
    expect(describeUnreadable(PACK, env.unreadable)).toBe('.env.local (permission denied)');
  });

  test('any other read error still throws', async () => {
    await expect(
      readPackEnv({
        packDir: PACK,
        envName: 'local',
        readFile: async () => {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        },
      }),
    ).rejects.toThrow('EIO');
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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `createClient` without options: env first, then the running `kindgi dev`
 * (`.kindgirc.json`) outside production, with the two one-time warnings.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type RuntimeConfigContext,
  findDevRuntime,
  resetWarningsForTests,
  resolveClientOptions,
} from '../src/runtime-config.js';

let dir: string;
let warnings: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-runtime-config-'));
  warnings = [];
  resetWarningsForTests();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function context(env: Record<string, string | undefined>, cwd: string = dir): RuntimeConfigContext {
  return { env, cwd, warn: (m) => warnings.push(m) };
}

async function writeRc(where: string, rc: Record<string, unknown>): Promise<void> {
  await mkdir(where, { recursive: true });
  await writeFile(join(where, '.kindgirc.json'), JSON.stringify(rc), 'utf8');
}

const DEV = { apiUrl: 'http://127.0.0.1:4000', token: 'kgi_bt_dev', tenantId: 't-1' };

describe('resolveClientOptions', () => {
  test('env wins, with no warning when there is no kindgi dev', () => {
    const options = resolveClientOptions(
      {},
      context({ KINDGI_API_URL: 'https://kindgi.acme.dev', KINDGI_API_TOKEN: 'kgi_bt_prod' }),
    );
    expect(options).toEqual({
      apiUrl: 'https://kindgi.acme.dev',
      auth: { kind: 'apiToken', token: 'kgi_bt_prod' },
    });
    expect(warnings).toEqual([]);
  });

  test('explicit options win over env', () => {
    const options = resolveClientOptions(
      { apiUrl: 'https://other', auth: { kind: 'apiToken', token: 'x' } },
      context({ KINDGI_API_URL: 'https://kindgi.acme.dev', KINDGI_API_TOKEN: 'y' }),
    );
    expect(options.apiUrl).toBe('https://other');
    expect(options.auth).toEqual({ kind: 'apiToken', token: 'x' });
  });

  test('no env in development: the running kindgi dev, found from a subfolder, with one warning naming the env file', async () => {
    await writeRc(dir, DEV);
    const sub = join(dir, 'app', 'routes');
    await mkdir(sub, { recursive: true });
    const options = resolveClientOptions({}, context({}, sub));
    expect(options).toEqual({ apiUrl: DEV.apiUrl, auth: { kind: 'apiToken', token: DEV.token } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Using the running kindgi dev from');
    expect(warnings[0]).toContain('KINDGI_API_URL and KINDGI_API_TOKEN');
    expect(warnings[0]).toContain('your env file (.env / .env.local)');
    resolveClientOptions({}, context({}, sub));
    expect(warnings).toHaveLength(1);
  });

  test('only the missing field comes from kindgi dev', async () => {
    await writeRc(dir, DEV);
    const options = resolveClientOptions({}, context({ KINDGI_API_URL: DEV.apiUrl }));
    expect(options.auth).toEqual({ kind: 'apiToken', token: DEV.token });
    expect(warnings[0]).toContain('for KINDGI_API_TOKEN.');
  });

  test('production never reads .kindgirc.json: missing env is an error', async () => {
    await writeRc(dir, DEV);
    for (const env of [{ NODE_ENV: 'production' }, { KINDGI_ENV: 'production' }]) {
      expect(() => resolveClientOptions({}, context(env))).toThrow(
        "createClient(): KINDGI_API_URL and KINDGI_API_TOKEN aren't set.",
      );
    }
    expect(warnings).toEqual([]);
  });

  test('nothing anywhere: the error says what to set and where', () => {
    expect(() => resolveClientOptions({}, context({}))).toThrow(
      /aren't set\. Set them in your env file \(\.env \/ \.env\.local\), or pass \{ apiUrl, auth \}\. In development, run `kindgi dev`/,
    );
  });

  test('a token that differs from the running kindgi dev for the same URL warns once (stale after --reset)', async () => {
    await writeRc(dir, DEV);
    const env = { KINDGI_API_URL: `${DEV.apiUrl}/`, KINDGI_API_TOKEN: 'kgi_bt_old' };
    const options = resolveClientOptions({}, context(env));
    expect(options.auth).toEqual({ kind: 'apiToken', token: 'kgi_bt_old' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("doesn't match the running kindgi dev's");
    expect(warnings[0]).toContain('kindgi dev --reset');
    resolveClientOptions({}, context(env));
    expect(warnings).toHaveLength(1);
  });

  test('a different URL (a staging runtime on purpose) is not warned about', async () => {
    await writeRc(dir, DEV);
    resolveClientOptions(
      {},
      context({ KINDGI_API_URL: 'https://staging.acme.dev', KINDGI_API_TOKEN: 'kgi_bt_staging' }),
    );
    expect(warnings).toEqual([]);
  });
});

describe('findDevRuntime', () => {
  test('ignores a .kindgirc.json without apiUrl or token, or one that does not parse', async () => {
    await writeRc(dir, { token: 'x' });
    expect(findDevRuntime(dir)).toBeUndefined();
    await writeFile(join(dir, '.kindgirc.json'), '{', 'utf8');
    expect(findDevRuntime(dir)).toBeUndefined();
  });

  test('no cwd (a browser): nothing', () => {
    expect(findDevRuntime(undefined)).toBeUndefined();
  });
});

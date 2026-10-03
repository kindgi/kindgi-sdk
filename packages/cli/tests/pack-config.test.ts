// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadPackConfig } from '../src/pack-config.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-pack-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noSeam = { buildConfigLoader: undefined };

describe('loadPackConfig', () => {
  test('test seam: the injected loader wins', async () => {
    const r = await loadPackConfig({ buildConfigLoader: async () => ({ pack: { id: 'x' } }) }, dir);
    expect(r).toEqual({ kind: 'ok', config: { pack: { id: 'x' } } });
  });

  test('test seam: a throwing loader is `invalid` with its message', async () => {
    const r = await loadPackConfig(
      {
        buildConfigLoader: async () => {
          throw new Error('bad config');
        },
      },
      dir,
    );
    expect(r).toEqual({ kind: 'invalid', message: 'bad config' });
  });

  test('real files: no config → `missing`', async () => {
    expect((await loadPackConfig(noSeam, dir)).kind).toBe('missing');
  });

  test('real files: a config that fails to import → `invalid` carrying the cause (was swallowed before)', async () => {
    await writeFile(join(dir, 'kindgi.config.mjs'), "throw new Error('typo in config');");
    const r = await loadPackConfig(noSeam, dir);
    expect(r.kind).toBe('invalid');
    expect(r.kind === 'invalid' && r.message).toContain('typo in config');
  });

  test('real files: a valid config loads with every field', async () => {
    await writeFile(
      join(dir, 'kindgi.config.mjs'),
      "export default { pack: { id: 'p', version: '1' }, environments: { staging: {} } };",
    );
    const r = await loadPackConfig(noSeam, dir);
    expect(r.kind === 'ok' && r.config.environments).toEqual({ staging: {} });
  });
});

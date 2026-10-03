// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  collectIncludeFiles,
  forbiddenReason,
  readBundleConfig,
} from '../src/build/context-files.js';

let pack: string;
const put = async (rel: string, body = '// x\n'): Promise<string> => {
  const abs = join(pack, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf8');
  return abs;
};

beforeEach(async () => {
  pack = await mkdtemp(join(tmpdir(), 'kindgi-context-'));
  await put('kindgi.config.mts', 'export default {};\n');
});
afterEach(async () => {
  await rm(pack, { recursive: true, force: true });
});

describe('forbiddenReason — secrets never ship', () => {
  test.each([
    '.env',
    '.env.local',
    '.env.production',
    'config/.env.json',
    '.kindgirc.json',
    '.npmrc',
    '.yarnrc.yml',
    'certs/server.key',
    'keys/signing.pem',
    'id_ed25519',
    '.git/config',
    '.kindgi/dev/index.json',
    'node_modules/x/index.js',
  ])('%s is refused', (rel) => {
    expect(forbiddenReason(rel)).toBeDefined();
  });

  test.each(['kindgi/tools/echo.ts', 'src/lib/db.ts', 'data/prompts.json', 'environment.ts'])(
    '%s is allowed',
    (rel) => {
      expect(forbiddenReason(rel)).toBeUndefined();
    },
  );
});

describe('collectIncludeFiles — the pack files an image holds', () => {
  test('only what bundle.include lists: never the source, never the rest of the app', async () => {
    await put('kindgi/tools/echo.ts');
    await put('src/app/page.tsx');
    await put('kindgi/data/prompts.json', '{}');
    await put('kindgi/data/nested/more.json', '{}');
    await put('kindgi/data/readme.txt', '#');
    expect(await collectIncludeFiles(pack, ['kindgi/data/**/*.json'])).toEqual({
      kind: 'ok',
      files: ['kindgi/data/nested/more.json', 'kindgi/data/prompts.json'],
    });
    expect(await collectIncludeFiles(pack, [])).toEqual({ kind: 'ok', files: [] });
  });

  test('a secret an include matches fails the build, naming it', async () => {
    await put('kindgi/.env.local', 'X=1\n');
    await put('kindgi/data/ok.json', '{}');
    const r = await collectIncludeFiles(pack, ['kindgi/**/*']);
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.message).toContain('kindgi/.env.local (secret-shaped file)');
  });
});

describe('readBundleConfig', () => {
  test('absent → no includes; valid list passes; anything else is invalid', () => {
    expect(readBundleConfig({})).toEqual({ kind: 'ok', bundle: { include: [] } });
    expect(readBundleConfig({ bundle: { include: ['a/**'] } })).toEqual({
      kind: 'ok',
      bundle: { include: ['a/**'] },
    });
    expect(readBundleConfig({ bundle: { include: 'a/**' } }).kind).toBe('invalid');
    expect(readBundleConfig({ bundle: 3 }).kind).toBe('invalid');
  });
});

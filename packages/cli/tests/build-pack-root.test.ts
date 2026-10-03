// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `resolvePackRoots` — the pack/repo-root detector that
 * distinguishes standalone (`kindgi.config.ts` + `package.json`
 * same dir) from augment (`kindgi.config.ts` in a subdir, `package.json`
 * up the tree).
 *
 * Uses a real tmp filesystem so path-normalization + walk-up behavior
 * are exercised end-to-end; the `fileExists` seam is used only where
 * we specifically want to test the injection point.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CONFIG_FILENAMES, resolvePackRoots } from '../src/build/pack-root.js';

let root: string;

beforeEach(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  root = await mkdtemp(join(tmpdir(), 'kindgi-pack-root-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function touch(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '');
}

// ---------------------------------------------------------------------
// standalone layout
// ---------------------------------------------------------------------

describe('resolvePackRoots — standalone layout', () => {
  test('kindgi.config.ts + package.json in the same dir → mode "standalone"', async () => {
    await touch(join(root, 'kindgi.config.ts'));
    await touch(join(root, 'package.json'));

    const result = await resolvePackRoots({ cwd: root });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.roots.mode).toBe('standalone');
    expect(result.roots.packDir).toBe(root);
    expect(result.roots.repoRoot).toBe(root);
  });

  test('accepts each of the four config filenames', async () => {
    for (const name of CONFIG_FILENAMES) {
      const dir = join(root, name.replace(/\W/g, '_'));
      await mkdir(dir, { recursive: true });
      await touch(join(dir, name));
      await touch(join(dir, 'package.json'));

      const result = await resolvePackRoots({ cwd: dir });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.roots.mode).toBe('standalone');
    }
  });
});

// ---------------------------------------------------------------------
// augment layout
// ---------------------------------------------------------------------

describe('resolvePackRoots — augment layout', () => {
  test('kindgi.config.ts in subdir, package.json at repo root → mode "augment"', async () => {
    // <root>/package.json  (surrounding repo)
    // <root>/kindgi/kindgi.config.ts  (embedded pack)
    await touch(join(root, 'package.json'));
    await touch(join(root, 'kindgi', 'kindgi.config.ts'));

    const packDir = join(root, 'kindgi');
    const result = await resolvePackRoots({ cwd: packDir });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.roots.mode).toBe('augment');
    expect(result.roots.packDir).toBe(packDir);
    expect(result.roots.repoRoot).toBe(root);
  });

  test('deeper nesting: <root>/apps/foo/kindgi/kindgi.config.ts, package.json at repo root', async () => {
    await touch(join(root, 'package.json'));
    const packDir = join(root, 'apps', 'foo', 'kindgi');
    await touch(join(packDir, 'kindgi.config.ts'));

    const result = await resolvePackRoots({ cwd: packDir });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.roots.mode).toBe('augment');
    expect(result.roots.repoRoot).toBe(root);
  });

  test('nearest ancestor with package.json wins (monorepo case)', async () => {
    // <root>/package.json                       (workspace root)
    // <root>/apps/foo/package.json              (workspace member)
    // <root>/apps/foo/kindgi/kindgi.config.ts   (pack inside the member)
    await touch(join(root, 'package.json'));
    await touch(join(root, 'apps', 'foo', 'package.json'));
    const packDir = join(root, 'apps', 'foo', 'kindgi');
    await touch(join(packDir, 'kindgi.config.ts'));

    const result = await resolvePackRoots({ cwd: packDir });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // repoRoot should be the NEAREST package.json, not the workspace root.
    expect(result.roots.repoRoot).toBe(join(root, 'apps', 'foo'));
    expect(result.roots.mode).toBe('augment');
  });
});

// ---------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------

describe('resolvePackRoots — errors', () => {
  test('no config at packDir → "no-config"', async () => {
    await touch(join(root, 'package.json'));

    const result = await resolvePackRoots({ cwd: root });

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.code).toBe('no-config');
    expect(result.message).toContain('kindgi.config');
  });

  test('no package.json anywhere up the tree → "no-package-json"', async () => {
    // Fully isolated fake filesystem via fileExists seam so we don't
    // pollute the actual tmp with a package.json at some ancestor.
    const packDir = '/synthetic/pack';
    const seenPaths: string[] = [];
    const fileExists = async (path: string): Promise<boolean> => {
      seenPaths.push(path);
      return path === '/synthetic/pack/kindgi.config.ts';
    };

    const result = await resolvePackRoots({
      cwd: packDir,
      fileExists,
    });

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.code).toBe('no-package-json');
    // Verify we actually walked up to root before giving up.
    expect(seenPaths.some((p) => p === '/package.json')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// --path flag handling
// ---------------------------------------------------------------------

describe('resolvePackRoots — --path flag', () => {
  test('resolves absolute path flag as-is', async () => {
    await touch(join(root, 'package.json'));
    const packDir = join(root, 'kindgi');
    await touch(join(packDir, 'kindgi.config.ts'));

    const result = await resolvePackRoots({
      cwd: '/some/unrelated/cwd',
      pathFlag: packDir,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.roots.packDir).toBe(packDir);
  });

  test('resolves relative path flag against cwd', async () => {
    await touch(join(root, 'package.json'));
    await touch(join(root, 'kindgi', 'kindgi.config.ts'));

    const result = await resolvePackRoots({
      cwd: root,
      pathFlag: 'kindgi',
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.roots.packDir).toBe(join(root, 'kindgi'));
    expect(result.roots.repoRoot).toBe(root);
  });

  test('empty string --path treated as absent', async () => {
    await touch(join(root, 'kindgi.config.ts'));
    await touch(join(root, 'package.json'));

    const result = await resolvePackRoots({ cwd: root, pathFlag: '' });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.roots.packDir).toBe(root);
  });
});

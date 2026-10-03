// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `detectInitMode` — the branch point between fresh
 * (`kindgi init <pack-name>`) and augment (`kindgi init` inside an
 * existing Node.js project). Uses the injected `fileExists` seam so
 * these tests never touch the actual filesystem.
 */

import { describe, expect, test } from 'vitest';

import { detectInitMode } from '../src/init/mode-detect.js';

const noopFile = async (): Promise<boolean> => false;
const alwaysFile = async (): Promise<boolean> => true;

// ---------------------------------------------------------------------
// fresh mode
// ---------------------------------------------------------------------

describe('detectInitMode — fresh mode', () => {
  test('positional pack-name → fresh', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/wd',
      positionals: ['my-pack'],
      newRepoFlag: false,
      fileExists: noopFile,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.mode).toBe('fresh');
    if (result.mode !== 'fresh') return;
    expect(result.packName).toBe('my-pack');
    expect(result.targetDir).toBe('/tmp/wd/my-pack');
  });

  test('positional pack-name wins even when package.json is present', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/wd',
      positionals: ['my-pack'],
      newRepoFlag: false,
      fileExists: alwaysFile,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.mode).toBe('fresh');
  });

  test('dot-namespaced pack-name → dirName strips namespace', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/wd',
      positionals: ['acme.legal-basics'],
      newRepoFlag: false,
      fileExists: noopFile,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    if (result.mode !== 'fresh') throw new Error('expected fresh');
    expect(result.targetDir).toBe('/tmp/wd/legal-basics');
  });

  test('--path (relative) overrides default dirName', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/wd',
      positionals: ['my-pack'],
      pathFlag: 'custom-out',
      newRepoFlag: false,
      fileExists: noopFile,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    if (result.mode !== 'fresh') throw new Error('expected fresh');
    expect(result.targetDir).toBe('/tmp/wd/custom-out');
  });

  test('--path (absolute) overrides both cwd + dirName', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/wd',
      positionals: ['my-pack'],
      pathFlag: '/somewhere-else/pack',
      newRepoFlag: false,
      fileExists: noopFile,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    if (result.mode !== 'fresh') throw new Error('expected fresh');
    expect(result.targetDir).toBe('/somewhere-else/pack');
  });
});

// ---------------------------------------------------------------------
// augment mode
// ---------------------------------------------------------------------

describe('detectInitMode — augment mode', () => {
  test('a pyproject.toml without a package.json → augment, a Python pack', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/py-app',
      positionals: [],
      newRepoFlag: false,
      fileExists: async (path) => path === '/tmp/py-app/pyproject.toml',
    });
    expect(result).toEqual({
      kind: 'ok',
      mode: 'augment',
      targetDir: '/tmp/py-app',
      language: 'python',
    });
  });

  test('both project files: TypeScript unless --template=python', async () => {
    const both = { cwd: '/tmp/both', positionals: [], newRepoFlag: false, fileExists: alwaysFile };
    expect(await detectInitMode(both)).toMatchObject({ mode: 'augment', language: 'node' });
    expect(await detectInitMode({ ...both, templateFlag: 'python' })).toMatchObject({
      mode: 'augment',
      language: 'python',
    });
  });

  test('no positional + package.json at cwd → augment', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/existing-app',
      positionals: [],
      newRepoFlag: false,
      fileExists: async (path) => path === '/tmp/existing-app/package.json',
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.mode).toBe('augment');
    if (result.mode !== 'augment') return;
    expect(result.targetDir).toBe('/tmp/existing-app');
  });

  test('no positional + --path (relative) with package.json there → augment against that dir', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/wd',
      positionals: [],
      pathFlag: 'other-repo',
      newRepoFlag: false,
      fileExists: async (path) => path === '/tmp/wd/other-repo/package.json',
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.mode).toBe('augment');
    if (result.mode !== 'augment') return;
    expect(result.targetDir).toBe('/tmp/wd/other-repo');
  });

  test('no positional + --path (absolute) → augment against that dir', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/wd',
      positionals: [],
      pathFlag: '/somewhere/existing',
      newRepoFlag: false,
      fileExists: async (path) => path === '/somewhere/existing/package.json',
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    if (result.mode !== 'augment') throw new Error('expected augment');
    expect(result.targetDir).toBe('/somewhere/existing');
  });
});

// ---------------------------------------------------------------------
// --new-repo escape hatch
// ---------------------------------------------------------------------

describe('detectInitMode — --new-repo forcing fresh', () => {
  test('--new-repo + positional → fresh, even when package.json exists', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/existing-app',
      positionals: ['nested-pack'],
      newRepoFlag: true,
      fileExists: alwaysFile,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    if (result.mode !== 'fresh') throw new Error('expected fresh');
    expect(result.packName).toBe('nested-pack');
  });

  test('--new-repo without pack-name → clear error', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/wd',
      positionals: [],
      newRepoFlag: true,
      fileExists: alwaysFile,
    });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('--new-repo requires a pack-name');
  });
});

// ---------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------

describe('detectInitMode — errors', () => {
  test('no positional + no package.json → clear error with both fix pointers', async () => {
    const result = await detectInitMode({
      cwd: '/tmp/empty',
      positionals: [],
      newRepoFlag: false,
      fileExists: noopFile,
    });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('No pack-name provided');
    expect(result.message).toContain('no package.json');
    expect(result.message).toContain('kindgi init <pack-name>');
    expect(result.message).toContain('run inside a directory with package.json');
  });
});

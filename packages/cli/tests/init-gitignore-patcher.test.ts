// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for the `.gitignore` patcher.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { patchGitignore, patchPrettierignore } from '../src/init/gitignore-patcher.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-gitignore-patch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeGitignore(contents: string): Promise<string> {
  const path = join(dir, '.gitignore');
  await writeFile(path, contents, 'utf8');
  return path;
}

// ---------------------------------------------------------------------

describe('patchGitignore', () => {
  test('creates file when absent, appends every pattern with marker', async () => {
    const path = join(dir, '.gitignore');
    const result = await patchGitignore(path);
    expect(result.kind).toBe('patched');
    // .kindgirc.json holds the dev server's bearer token — never committed.
    expect(result.appended).toEqual(['.env.local', '.kindgi/', '.kindgirc.json']);
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('# Kindgi');
    expect(raw).toContain('.env.local');
    expect(raw).toContain('.kindgi/');
  });

  test('appends to existing file preserving prior content', async () => {
    const path = await writeGitignore('node_modules/\ndist/\n*.log\n');
    await patchGitignore(path);
    const raw = await readFile(path, 'utf8');
    expect(raw.startsWith('node_modules/\ndist/\n*.log\n')).toBe(true);
    expect(raw).toContain('# Kindgi');
    expect(raw).toContain('.env.local');
    expect(raw).toContain('.kindgi/');
  });

  test('skips patterns already present as exact matches', async () => {
    const path = await writeGitignore('node_modules/\n.env.local\n');
    const result = await patchGitignore(path);
    expect(result.kind).toBe('patched');
    expect(result.appended).toEqual(['.kindgi/', '.kindgirc.json']);
    const raw = await readFile(path, 'utf8');
    // .env.local not appended twice.
    const envLocalMatches = raw.split('\n').filter((l) => l.trim() === '.env.local');
    expect(envLocalMatches).toHaveLength(1);
  });

  test('no-op when every pattern is already present', async () => {
    const source = 'node_modules/\n.env.local\n.kindgi/\n.kindgirc.json\n';
    const path = await writeGitignore(source);
    const result = await patchGitignore(path);
    expect(result.kind).toBe('already-present');
    expect(result.appended).toEqual([]);
    const raw = await readFile(path, 'utf8');
    expect(raw).toBe(source);
  });

  test('idempotent on re-run (no duplicate Kindgi block)', async () => {
    const path = join(dir, '.gitignore');
    await patchGitignore(path);
    const first = await readFile(path, 'utf8');
    const result = await patchGitignore(path);
    expect(result.kind).toBe('already-present');
    const second = await readFile(path, 'utf8');
    expect(second).toBe(first);
  });

  test('handles missing trailing newline in source', async () => {
    const path = await writeGitignore('node_modules/\ndist/'); // no trailing \n
    await patchGitignore(path);
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('node_modules/\ndist/\n');
    expect(raw).toContain('# Kindgi\n');
  });
});

describe('patchPrettierignore', () => {
  test('adds the Kindgi-managed skills to an existing .prettierignore', async () => {
    const path = join(dir, '.prettierignore');
    await writeFile(path, 'dist/\n', 'utf8');
    const result = await patchPrettierignore(path);
    expect(result).toEqual({ kind: 'patched', appended: ['.claude/skills/kindgi-*/'] });
    expect(await readFile(path, 'utf8')).toBe('dist/\n\n# Kindgi\n.claude/skills/kindgi-*/\n');
  });

  test('never creates a .prettierignore the app did not have', async () => {
    const path = join(dir, '.prettierignore');
    expect((await patchPrettierignore(path)).kind).toBe('absent');
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  test('idempotent', async () => {
    const path = join(dir, '.prettierignore');
    await writeFile(path, 'dist/\n', 'utf8');
    await patchPrettierignore(path);
    expect((await patchPrettierignore(path)).kind).toBe('already-present');
  });
});

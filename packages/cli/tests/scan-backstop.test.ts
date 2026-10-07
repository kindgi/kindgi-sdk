// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The scan behind `kindgi dev`'s watchers (`dev/scan-backstop.ts`): what
 * it counts and skips, and that a change to a counted file changes it.
 */

import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { pythonSourcesSignature } from '../src/dev/python-builder.js';
import { scanSignature, startScanBackstop } from '../src/dev/scan-backstop.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-scan-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = async (rel: string, text: string): Promise<void> => {
  await mkdir(join(dir, rel, '..'), { recursive: true });
  await writeFile(join(dir, rel), text);
};

const names = (signature: string): string[] =>
  signature === '' ? [] : signature.split('\n').map((line) => line.split(':')[0] ?? '');

describe('scanSignature', () => {
  test('counts the files `includes` names, never in skipped folders', async () => {
    await put('tools/echo.ts', 'a');
    await put('tools/nested/helper.ts', 'b');
    await put('tools/notes.txt', 'c');
    await put('tools/node_modules/dep/index.ts', 'd');
    await put('tools/.cache/x.ts', 'e');
    await put('tools/dist/echo.ts', 'f');
    const signature = await scanSignature({
      folders: [{ abs: join(dir, 'tools'), rel: 'tools' }],
      includes: (rel) => rel.endsWith('.ts'),
    });
    expect(names(signature)).toEqual(['tools/echo.ts', 'tools/nested/helper.ts']);
  });

  test('a changed, removed or added file changes it; an untouched tree does not', async () => {
    await put('tools/echo.ts', 'a');
    const spec = {
      folders: [{ abs: join(dir, 'tools'), rel: 'tools' }],
      includes: (rel: string) => rel.endsWith('.ts'),
    };
    const first = await scanSignature(spec);
    expect(await scanSignature(spec)).toBe(first);

    // The same size, a later mtime (an edit in place).
    await put('tools/echo.ts', 'b');
    await utimes(join(dir, 'tools', 'echo.ts'), new Date(), new Date(Date.now() + 5_000));
    const edited = await scanSignature(spec);
    expect(edited).not.toBe(first);

    await put('tools/more.ts', 'c');
    const added = await scanSignature(spec);
    expect(names(added)).toEqual(['tools/echo.ts', 'tools/more.ts']);

    await unlink(join(dir, 'tools', 'more.ts'));
    expect(names(await scanSignature(spec))).toEqual(['tools/echo.ts']);
  });

  test('single files count once they exist (an env file created later)', async () => {
    const env = join(dir, '.env');
    const spec = { folders: [], includes: () => false, files: [env] };
    const missing = await scanSignature(spec);
    expect(missing).toBe(`${env}:-`);
    await writeFile(env, 'A=1\n');
    expect(await scanSignature(spec)).not.toBe(missing);
  });

  test('a folder that is not there counts as empty', async () => {
    expect(
      await scanSignature({
        folders: [{ abs: join(dir, 'nope'), rel: 'nope' }],
        includes: () => true,
      }),
    ).toBe('');
  });
});

describe('pythonSourcesSignature', () => {
  test("the .py files and pyproject.toml a Python pack's build reads, as the watch counts them", async () => {
    await put('pyproject.toml', '[project]\n');
    await put('tools/echo.py', 'x = 1\n');
    await put('lib/db.py', 'y = 1\n');
    await put('tools/__pycache__/echo.cpython-313.pyc', '');
    await put('.venv/lib/site.py', '');
    await put('venv/lib/site.py', '');
    await put('README.md', '');
    expect(names(await pythonSourcesSignature(dir))).toEqual([
      'lib/db.py',
      'pyproject.toml',
      'tools/echo.py',
    ]);
  });
});

describe('startScanBackstop', () => {
  test('a slow scan waits longer before the next one (50 times its duration, at most 5 s)', async () => {
    vi.useFakeTimers();
    try {
      let files = 'a';
      const onChange = vi.fn();
      // Each scan takes 100 ms of the clock: the next one waits 5 s, not 1 s.
      const scan = async (): Promise<string> => {
        vi.setSystemTime(Date.now() + 100);
        return files;
      };
      const backstop = await startScanBackstop({ scan, intervalMs: 1_000, onChange });
      await vi.advanceTimersByTimeAsync(1_000); // the first scan: it took 100 ms
      files = 'b';
      await vi.advanceTimersByTimeAsync(4_000);
      expect(onChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onChange).toHaveBeenCalledTimes(1);
      backstop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

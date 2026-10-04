// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { packServiceCommand } from '../src/dev/defaults.js';
import { checkPackPython, resolvePackCode, resolvePackPython } from '../src/dev/pack-code.js';
import { createPythonPackBuilder, isPythonSourceChange } from '../src/dev/python-builder.js';

// The Python SDK's own virtualenv in the sibling kindgi-sdk checkout (`uv sync` in sdks/python).
const sdkPython = fileURLToPath(
  new URL('../../../../kindgi-sdk/sdks/python/.venv/bin/python', import.meta.url),
);
const hasSdkPython = existsSync(sdkPython);
const systemPython = ((): string | undefined => {
  try {
    return execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
})();

let packDir: string;
beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-pack-code-'));
});
afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

describe("the pack's Python", () => {
  test('dev.python: a path or a command list', async () => {
    expect(await resolvePackPython(packDir, { dev: { python: '/opt/py/bin/python' } })).toEqual({
      kind: 'ok',
      value: ['/opt/py/bin/python'],
    });
    expect(await resolvePackPython(packDir, { dev: { python: ['uv', 'run', 'python'] } })).toEqual({
      kind: 'ok',
      value: ['uv', 'run', 'python'],
    });
    const bad = await resolvePackPython(packDir, { dev: { python: [] } });
    expect(bad.kind === 'err' && bad.message).toMatch(/`dev.python` must be/);
  });

  test("else the pack's .venv, else python3", async () => {
    expect(await resolvePackPython(packDir, {})).toEqual({ kind: 'ok', value: ['python3'] });
    await mkdir(join(packDir, '.venv', 'bin'), { recursive: true });
    await writeFile(join(packDir, '.venv', 'bin', 'python'), '');
    expect(await resolvePackPython(packDir, {})).toEqual({
      kind: 'ok',
      value: [join(packDir, '.venv', 'bin', 'python')],
    });
  });

  test('a Node pack needs no interpreter', async () => {
    expect(await resolvePackCode('node', packDir, { dev: { python: [] } })).toEqual({
      kind: 'ok',
      value: { language: 'node' },
    });
  });

  test("a Python pack's service is `python -m kindgi.pack serve`", () => {
    expect(packServiceCommand({ language: 'python', python: ['uv', 'run', 'python'] })).toEqual([
      'uv',
      'run',
      'python',
      '-m',
      'kindgi.pack',
      'serve',
    ]);
  });

  test.skipIf(!hasSdkPython)('an interpreter with kindgi passes the check', async () => {
    const checked = await checkPackPython([sdkPython], { PATH: process.env.PATH ?? '' });
    expect(checked.kind === 'ok' && checked.value).toMatch(/^Python 3\.\d+\.\d+ · kindgi \S+ \(/);
  });

  test.skipIf(systemPython === undefined)(
    'an interpreter without kindgi fails it, with the fix',
    async () => {
      const checked = await checkPackPython([systemPython as string], {
        PATH: process.env.PATH ?? '',
      });
      expect(checked.kind === 'err' && checked.message).toMatch(/cannot import kindgi/);
      expect(checked.kind === 'err' && checked.message).toMatch(/uv add kindgi/);
    },
  );

  test.skipIf(!hasSdkPython)(
    'a kindgi/__init__.py in the pack hides the SDK — the check says so',
    async () => {
      const app = await mkdtemp(join(tmpdir(), 'kindgi-shadow-'));
      await mkdir(join(app, 'kindgi'), { recursive: true });
      await writeFile(join(app, 'kindgi', '__init__.py'), '');
      const checked = await checkPackPython([sdkPython], { PATH: process.env.PATH ?? '' }, app);
      expect(checked.kind === 'err' && checked.message).toMatch(/hides the kindgi SDK/);
      await rm(app, { recursive: true, force: true });
      // From elsewhere, the same interpreter is fine.
      expect((await checkPackPython([sdkPython], { PATH: process.env.PATH ?? '' })).kind).toBe(
        'ok',
      );
    },
  );

  test('an interpreter that does not exist fails it', async () => {
    const checked = await checkPackPython(['/nonexistent/python'], {});
    expect(checked.kind === 'err' && checked.message).toMatch(/did not start/);
  });
});

describe('the Python pack builder', () => {
  test('which changes are code changes', () => {
    expect(isPythonSourceChange('tools/ledger.py')).toBe(true);
    expect(isPythonSourceChange('lib/db.py')).toBe(true);
    expect(isPythonSourceChange('pyproject.toml')).toBe(true);
    expect(isPythonSourceChange('tools/__pycache__/ledger.cpython-313.pyc')).toBe(false);
    expect(isPythonSourceChange('.venv/lib/python3.13/site-packages/x.py')).toBe(false);
    expect(isPythonSourceChange('.kindgi/dev/index.json')).toBe(false);
    expect(isPythonSourceChange('README.md')).toBe(false);
    expect(isPythonSourceChange('sub/pyproject.toml')).toBe(false);
  });

  const env = async (): Promise<Record<string, string>> => ({ PATH: process.env.PATH ?? '' });

  test.skipIf(systemPython === undefined)(
    'a build compiles the sources and locates syntax errors',
    async () => {
      const builder = createPythonPackBuilder({ packDir, python: [systemPython as string], env });
      await mkdir(join(packDir, 'tools'), { recursive: true });
      await mkdir(join(packDir, '.venv'), { recursive: true });
      await writeFile(join(packDir, 'tools', 'ok.py'), 'x = 1\n');
      await writeFile(join(packDir, '.venv', 'broken.py'), 'def (:\n'); // never checked
      expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
      await writeFile(join(packDir, 'tools', 'bad.py'), 'def f(:\n    pass\n');
      const failed = await builder.build();
      expect(failed.kind).toBe('err');
      expect(failed.kind === 'err' && failed.errors).toEqual([
        expect.stringMatching(/^tools\/bad\.py:1:7: SyntaxError: /),
      ]);
    },
  );

  test.skipIf(systemPython === undefined)('a .py edit rebuilds; other files do not', async () => {
    const builder = createPythonPackBuilder({
      packDir,
      python: [systemPython as string],
      env,
      debounceMs: 50,
    });
    const builds: unknown[] = [];
    await mkdir(join(packDir, 'tools'), { recursive: true });
    await builder.watch((build) => builds.push(build));
    // The watcher is live once a probe edit rebuilds: a fixed sleep after
    // starting it isn't enough on a loaded machine, where the event stream
    // can start late. Then wait until no more builds arrive and start over.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const liveBy = Date.now() + 15_000;
    for (let i = 0; builds.length === 0 && Date.now() < liveBy; i += 1) {
      await writeFile(join(packDir, 'tools', 'probe.py'), `x = ${i}\n`);
      await sleep(250);
    }
    expect(builds.length).toBeGreaterThan(0);
    const quietBy = Date.now() + 15_000;
    for (let seen = -1; seen !== builds.length && Date.now() < quietBy; ) {
      seen = builds.length;
      await sleep(1_500);
    }
    builds.length = 0;
    await writeFile(join(packDir, 'notes.txt'), 'ignored\n');
    await sleep(400);
    expect(builds).toEqual([]);
    await writeFile(join(packDir, 'tools', 'a.py'), 'x = 1\n');
    const deadline = Date.now() + 15_000;
    while (builds.length === 0 && Date.now() < deadline) await sleep(20);
    expect(builds.length).toBeGreaterThan(0);
    expect(
      builds.every((b) => JSON.stringify(b) === JSON.stringify({ kind: 'ok', bundleMap: {} })),
    ).toBe(true);
    await builder.dispose();
  });
});

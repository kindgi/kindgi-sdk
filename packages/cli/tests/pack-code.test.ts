// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { execFileSync } from 'node:child_process';
import { existsSync, type watch } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';

import { packServiceCommand } from '../src/dev/defaults.js';
import { checkPackPython, resolvePackCode, resolvePackPython } from '../src/dev/pack-code.js';
import { createPythonPackBuilder, isPythonSourceChange } from '../src/dev/python-builder.js';
import { untilReported } from './fs-events.js';

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

  // Which events rebuild, with scripted events: "didn't rebuild" is a fact, not a wait.
  test.skipIf(systemPython === undefined)(
    'a .py edit rebuilds; other files, and events without a name, do not',
    async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      let listener: ((event: string, filename: string | null) => void) | undefined;
      const watchFs = ((_path: string, _options: unknown, onEvent: typeof listener) => {
        listener = onEvent;
        return { close() {} };
      }) as unknown as typeof watch;
      const builder = createPythonPackBuilder({
        packDir,
        python: [systemPython as string],
        env,
        debounceMs: 50,
        watchFs,
        // The scan never sees a change: only the events decide here.
        scanSources: async () => 'unchanged',
      });
      const builds: unknown[] = [];
      await mkdir(join(packDir, 'tools'), { recursive: true });
      await writeFile(join(packDir, 'tools', 'a.py'), 'x = 1\n');
      await builder.watch((build) => builds.push(build));
      // One timer: the scan's interval.
      listener?.('change', 'notes.txt');
      listener?.('change', join('.venv', 'lib', 'x.py'));
      listener?.('rename', null);
      expect(vi.getTimerCount()).toBe(1);
      listener?.('change', join('tools', 'a.py'));
      listener?.('change', join('tools', 'a.py'));
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();
      await vi.waitFor(() => expect(builds).toEqual([{ kind: 'ok', bundleMap: {} }]), {
        timeout: 30_000,
      });
      await builder.dispose();
    },
  );

  // A dropped event (FSEvents under load): the scan finds the change.
  test.skipIf(systemPython === undefined)(
    'an edit no event reports is found by the scan, and built once',
    async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const watchFs = (() => ({ close() {} })) as unknown as typeof watch;
      let sources = 'tools/a.py:1:6';
      const builder = createPythonPackBuilder({
        packDir,
        python: [systemPython as string],
        env,
        debounceMs: 50,
        scanIntervalMs: 1_000,
        watchFs,
        scanSources: async () => sources,
      });
      const builds: unknown[] = [];
      await mkdir(join(packDir, 'tools'), { recursive: true });
      await writeFile(join(packDir, 'tools', 'a.py'), 'x = 1\n');
      await builder.watch((build) => builds.push(build));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(builds).toEqual([]);
      // The edit: no event, only the files changed.
      sources = 'tools/a.py:2:7';
      await vi.advanceTimersByTimeAsync(1_000 + 50);
      vi.useRealTimers();
      await vi.waitFor(() => expect(builds).toEqual([{ kind: 'ok', bundleMap: {} }]), {
        timeout: 30_000,
      });
      vi.useFakeTimers();
      // Nothing changed since: no second build.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(builds).toHaveLength(1);
      await builder.dispose();
    },
  );

  // The real file system: its events reach the builder (see ./fs-events.ts).
  test.skipIf(systemPython === undefined)(
    'a .py edit on disk rebuilds',
    { timeout: 90_000 },
    async (context) => {
      const builder = createPythonPackBuilder({
        packDir,
        python: [systemPython as string],
        env,
        debounceMs: 50,
      });
      onTestFinished(() => builder.dispose());
      const builds: unknown[] = [];
      await mkdir(join(packDir, 'tools'), { recursive: true });
      await builder.watch((build) => builds.push(build));
      let round = 0;
      await untilReported(
        context,
        { folder: packDir, recursive: true, name: join('tools', 'a.py') },
        () => builds.length > 0,
        () => writeFile(join(packDir, 'tools', 'a.py'), `x = ${round++}\n`),
      );
      expect(builds[0]).toEqual({ kind: 'ok', bundleMap: {} });
    },
  );
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  type DetectIo,
  binCommand,
  binDisplay,
  cliInstall,
  detectBinRunner,
  detectPackageManager,
  installCommand,
  localLinkProtocol,
  publishedCliSpec,
  usablePackageManager,
} from '../src/package-manager.js';
import { CLI_VERSION } from '../src/version-info.js';

function io(files: Record<string, string>): DetectIo {
  return {
    readFile: async (p) => files[p] ?? null,
    exists: async (p) => Object.hasOwn(files, p),
  };
}

describe('detectPackageManager', () => {
  test('the packageManager field wins over lockfiles at the same level', async () => {
    const files = {
      [join('/app', 'package.json')]: '{"packageManager":"pnpm@11.25.0"}',
      [join('/app', 'package-lock.json')]: '{}',
    };
    expect(await detectPackageManager('/app', io(files))).toBe('pnpm');
  });

  test.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['pnpm-workspace.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ])('%s → %s', async (file, pm) => {
    expect(await detectPackageManager('/app', io({ [join('/app', file)]: '' }))).toBe(pm);
  });

  test('a pack inside a monorepo inherits the root manager', async () => {
    const files = {
      [join('/repo', 'pnpm-lock.yaml')]: '',
      [join('/repo/packs/a', 'package.json')]: '{}',
    };
    expect(await detectPackageManager('/repo/packs/a', io(files))).toBe('pnpm');
  });

  test('nothing found → npm', async () => {
    expect(await detectPackageManager('/nowhere', io({}))).toBe('npm');
  });

  test('an unknown packageManager value is ignored', async () => {
    const files = {
      [join('/app', 'package.json')]: '{"packageManager":"deno@2"}',
      [join('/app', 'yarn.lock')]: '',
    };
    expect(await detectPackageManager('/app', io(files))).toBe('yarn');
  });
});

describe('binCommand — runs the project-local bin, never downloads', () => {
  test.each([
    ['pnpm', 'pnpm', ['exec', 'kindgi', 'dev']],
    ['npm', 'npx', ['--no', 'kindgi', 'dev']],
    ['yarn', 'yarn', ['kindgi', 'dev']],
    ['bun', 'bun', ['run', 'kindgi', 'dev']],
  ] as const)('%s', (pm, command, args) => {
    expect(binCommand(pm, 'kindgi', ['dev'])).toEqual({ command, args });
  });

  test('path — a Python pack (no npm project) runs the published CLI through npx, within its minor (an rc: that rc)', () => {
    const cli = publishedCliSpec(CLI_VERSION);
    expect(binCommand('path', 'kindgi', ['dev'])).toEqual({
      command: 'npx',
      args: ['--yes', cli, 'dev'],
    });
    expect(binDisplay('path', 'kindgi', ['skills', 'sync'])).toBe(`npx --yes ${cli} skills sync`);
    expect(binCommand('path', 'uv', ['sync'])).toEqual({ command: 'uv', args: ['sync'] });
  });

  test('binDisplay / installCommand / localLinkProtocol', () => {
    expect(binDisplay('pnpm', 'kindgi', ['dev'])).toBe('pnpm exec kindgi dev');
    expect(installCommand('bun')).toBe('bun install');
    expect(localLinkProtocol('npm')).toBe('file:');
    expect(localLinkProtocol('pnpm')).toBe('link:');
  });
});

describe('usablePackageManager (T280)', () => {
  const pnpmProject = { '/app/pnpm-workspace.yaml': '' };
  test('the declared manager when it runs here', async () => {
    expect(
      await usablePackageManager('/app', { ...io(pnpmProject), runs: async () => true }),
    ).toEqual({
      pm: 'pnpm',
    });
  });

  test("npm when the declared one doesn't run here, naming it", async () => {
    const asked: string[] = [];
    const runs = async (pm: string) => {
      asked.push(pm);
      return false;
    };
    expect(await usablePackageManager('/app', { ...io(pnpmProject), runs })).toEqual({
      pm: 'npm',
      declared: 'pnpm',
    });
    expect(asked).toEqual(['pnpm']);
    expect(await detectBinRunner('/app', 'node', { ...io(pnpmProject), runs })).toBe('npm');
  });

  test('npm is never probed; no probe means the declared manager is assumed to run', async () => {
    const runs = async () => {
      throw new Error('npm is never probed');
    };
    expect(await usablePackageManager('/app', { ...io({}), runs })).toEqual({ pm: 'npm' });
    expect(await usablePackageManager('/app', io(pnpmProject))).toEqual({ pm: 'pnpm' });
  });
});

describe('detectBinRunner', () => {
  test('a Python pack runs the kindgi on PATH, whatever lockfiles sit above it', async () => {
    expect(await detectBinRunner('/app', 'python', io({ '/app/pnpm-lock.yaml': '' }))).toBe('path');
  });

  test('a Java pack runs its kindgiw, else the published CLI: it has no npm or Python environment', async () => {
    expect(await detectBinRunner('/app', 'java', io({ '/app/pnpm-lock.yaml': '' }))).toBe('path');
    expect(await detectBinRunner('/app', 'java', io({}), { KINDGI_CLI_INSTALL: 'pypi' })).toBe(
      'path',
    );
    // With its wrapper, the CLI version the pack pins.
    expect(await detectBinRunner('/app', 'java', io({ '/app/kindgiw': '' }))).toBe('kindgiw');
    expect(binDisplay('kindgiw', 'kindgi', ['dev'])).toBe('./kindgiw dev');
  });

  test('a Node pack runs it through its package manager', async () => {
    expect(await detectBinRunner('/app', 'node', io({ '/app/pnpm-lock.yaml': '' }))).toBe('pnpm');
  });

  test("from the PyPI CLI, a Python pack runs it from its own environment: uv, or Poetry's", async () => {
    const pypi = { KINDGI_CLI_INSTALL: 'pypi' };
    expect(await detectBinRunner('/app', 'python', io({}), pypi)).toBe('uv');
    expect(await detectBinRunner('/app', 'python', io({ '/app/uv.lock': '' }), pypi)).toBe('uv');
    expect(await detectBinRunner('/app/svc', 'python', io({ '/app/poetry.lock': '' }), pypi)).toBe(
      'poetry',
    );
    // A Node pack is unaffected.
    expect(await detectBinRunner('/app', 'node', io({ '/app/pnpm-lock.yaml': '' }), pypi)).toBe(
      'pnpm',
    );
  });
});

describe('cliInstall', () => {
  test('pypi only when the PyPI launcher says so; npm otherwise', () => {
    expect(cliInstall({ KINDGI_CLI_INSTALL: 'pypi' })).toBe('pypi');
    expect(cliInstall({})).toBe('npm');
    expect(cliInstall({ KINDGI_CLI_INSTALL: 'something' })).toBe('npm');
  });

  test('the PyPI runners: uv run, poetry run, or the bare script in an activated environment', () => {
    expect(binDisplay('uv', 'kindgi', ['dev'])).toBe('uv run kindgi dev');
    expect(binDisplay('poetry', 'kindgi', ['dev'])).toBe('poetry run kindgi dev');
    expect(binDisplay('venv', 'kindgi', ['dev'])).toBe('kindgi dev');
  });
});

describe('publishedCliSpec', () => {
  test("a release's hints download its minor; a release candidate's, its exact version", () => {
    expect(publishedCliSpec('0.1.3')).toBe('@kindgi/cli@0.1');
    expect(publishedCliSpec('1.2.0')).toBe('@kindgi/cli@1.2');
    // A range never matches a pre-release: `@0.1` would run the last release.
    expect(publishedCliSpec('0.1.4-rc.0')).toBe('@kindgi/cli@0.1.4-rc.0');
    expect(publishedCliSpec('unknown')).toBe('@kindgi/cli');
  });
});

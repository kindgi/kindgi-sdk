// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  type DetectIo,
  binCommand,
  binDisplay,
  detectBinRunner,
  detectPackageManager,
  installCommand,
  localLinkProtocol,
} from '../src/package-manager.js';

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

  test('path — the bin on PATH (a Python pack has no npm project)', () => {
    expect(binCommand('path', 'kindgi', ['dev'])).toEqual({ command: 'kindgi', args: ['dev'] });
    expect(binDisplay('path', 'kindgi', ['skills', 'sync'])).toBe('kindgi skills sync');
  });

  test('binDisplay / installCommand / localLinkProtocol', () => {
    expect(binDisplay('pnpm', 'kindgi', ['dev'])).toBe('pnpm exec kindgi dev');
    expect(installCommand('bun')).toBe('bun install');
    expect(localLinkProtocol('npm')).toBe('file:');
    expect(localLinkProtocol('pnpm')).toBe('link:');
  });
});

describe('detectBinRunner', () => {
  test('a Python pack runs the kindgi on PATH, whatever lockfiles sit above it', async () => {
    expect(await detectBinRunner('/app', 'python', io({ '/app/pnpm-lock.yaml': '' }))).toBe('path');
  });

  test('a Node pack runs it through its package manager', async () => {
    expect(await detectBinRunner('/app', 'node', io({ '/app/pnpm-lock.yaml': '' }))).toBe('pnpm');
  });
});

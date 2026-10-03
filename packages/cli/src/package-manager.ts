// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The package manager a project uses — so the CLI prints commands that
 * work there, and writes launch commands (`.mcp.json`) that run the
 * project's OWN `kindgi`: never a global install, never a registry
 * download (`npx kindgi` without `--no` would fetch the unscoped `kindgi`
 * package, which Kindgi does not own).
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PackLanguage } from '@kindgi/handler-runtime';

import { CLI_VERSION } from './version-info.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/**
 * How a pack runs its bins: through its package manager, or — a Python
 * pack, which has no npm project to install the CLI into — from `PATH`.
 */
export type BinRunner = PackageManager | 'path';

/** Lockfile / workspace marker → manager, checked in this order per directory. */
const MARKERS: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-workspace.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

export interface DetectIo {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly exists: (path: string) => Promise<boolean>;
}

const defaultIo: DetectIo = {
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Walk up from `dir`; at each level the `packageManager` field of
 * `package.json` wins, then a lockfile / workspace marker. A pack inside
 * a monorepo therefore inherits the root's manager. `npm` when nothing
 * says otherwise.
 */
export async function detectPackageManager(
  dir: string,
  io: DetectIo = defaultIo,
): Promise<PackageManager> {
  let current = dir;
  for (;;) {
    const declared = parsePackageManagerField(await io.readFile(join(current, 'package.json')));
    if (declared !== undefined) return declared;
    for (const [file, pm] of MARKERS) {
      if (await io.exists(join(current, file))) return pm;
    }
    const parent = dirname(current);
    if (parent === current) return 'npm';
    current = parent;
  }
}

function parsePackageManagerField(raw: string | null): PackageManager | undefined {
  if (raw === null) return undefined;
  try {
    const field = (JSON.parse(raw) as { packageManager?: unknown }).packageManager;
    if (typeof field !== 'string') return undefined;
    const name = field.split('@')[0];
    return name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun'
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}

/** The pack's `BinRunner`: `path` for a Python pack, else its package manager. */
export async function detectBinRunner(
  dir: string,
  language: PackLanguage,
  io: DetectIo = defaultIo,
): Promise<BinRunner> {
  return language === 'python' ? 'path' : await detectPackageManager(dir, io);
}

/**
 * How to run a project-local bin — resolves `node_modules/.bin` and
 * refuses to download when the bin is missing. `path` runs the bin on
 * `PATH` (a Python pack's globally installed CLI).
 */
/** `@kindgi/cli@<major.minor>` of the running CLI (`@kindgi/cli` when unknown). */
const PUBLISHED_CLI = (() => {
  const minor = /^(\d+)\.(\d+)\./.exec(CLI_VERSION)?.slice(1, 3).join('.');
  return minor === undefined ? '@kindgi/cli' : `@kindgi/cli@${minor}`;
})();

export function binCommand(
  runner: BinRunner,
  bin: string,
  args: readonly string[] = [],
): { readonly command: string; readonly args: readonly string[] } {
  switch (runner) {
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', bin, ...args] };
    case 'npm':
      return { command: 'npx', args: ['--no', bin, ...args] };
    case 'yarn':
      return { command: 'yarn', args: [bin, ...args] };
    case 'bun':
      return { command: 'bun', args: ['run', bin, ...args] };
    case 'path':
      // No npm project to install the CLI into (a Python pack): the published
      // CLI through npx, within this CLI's minor (as Python packs pin
      // `kindgi>=0.1,<0.2`). `--yes`, so no install prompt stalls a person
      // or a coding agent.
      return bin === 'kindgi'
        ? { command: 'npx', args: ['--yes', PUBLISHED_CLI, ...args] }
        : { command: bin, args: [...args] };
  }
}

/** `binCommand` as a line to show a person. */
export function binDisplay(runner: BinRunner, bin: string, args: readonly string[] = []): string {
  const c = binCommand(runner, bin, args);
  return [c.command, ...c.args].join(' ');
}

export function installCommand(pm: PackageManager): string {
  return `${pm} install`;
}

/**
 * Protocol for depending on a local directory by symlink. npm has no
 * `link:`; its `file:` symlinks directories (npm ≥ 7).
 */
export function localLinkProtocol(pm: PackageManager): 'link:' | 'file:' {
  return pm === 'npm' ? 'file:' : 'link:';
}

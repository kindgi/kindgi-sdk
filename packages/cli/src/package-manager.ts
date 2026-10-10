// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The package manager a project uses — so the CLI prints commands that
 * work there, and writes launch commands (`.mcp.json`) that run the
 * project's OWN `kindgi`: never a global install, never a registry
 * download (`npx kindgi` without `--no` would fetch the unscoped `kindgi`
 * package, which Kindgi does not own).
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type PackLanguage, isJvmLanguage } from '@kindgi/handler-runtime';

import { CLI_VERSION } from './version-info.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/**
 * How a pack runs its bins: through its package manager, or — a Python
 * pack, which has no npm project to install the CLI into — from `PATH`.
 */
export type BinRunner = PackageManager | 'path' | 'uv' | 'poetry' | 'venv' | 'kindgiw';

/**
 * How this CLI was installed: from npm (`@kindgi/cli`), or from PyPI
 * (`kindgi-cli`, with Node from a wheel), whose launcher sets
 * `KINDGI_CLI_INSTALL=pypi`. A Python pack then runs the CLI from its own
 * Python environment (`uv run kindgi`), not through npx.
 */
export function cliInstall(
  env: Readonly<Record<string, string | undefined>> = process.env,
): 'npm' | 'pypi' {
  return env.KINDGI_CLI_INSTALL === 'pypi' ? 'pypi' : 'npm';
}

/**
 * A Python pack's runner. From the npm CLI: `path` (npx, within this CLI's
 * minor). From the PyPI CLI, the pack's own environment: `poetry run` for a
 * Poetry project (a `poetry.lock` at or above `dir`), else `uv run`.
 */
export async function pythonBinRunner(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: DetectIo = defaultIo,
): Promise<BinRunner> {
  if (cliInstall(env) !== 'pypi') return 'path';
  let current = dir;
  for (;;) {
    if (await io.exists(join(current, 'poetry.lock'))) return 'poetry';
    if (await io.exists(join(current, 'uv.lock'))) return 'uv';
    const parent = dirname(current);
    if (parent === current) return 'uv';
    current = parent;
  }
}

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
  /**
   * Whether `pm` runs on this machine (`<pm> --version`). Absent: assume
   * it does. npm is never asked: it comes with Node.
   */
  readonly runs?: (pm: PackageManager) => Promise<boolean>;
}

/** `<pm> --version`, once per manager per process: corepack never prompts; gives up after 15 s. */
const probed = new Map<PackageManager, Promise<boolean>>();
function managerRuns(pm: PackageManager): Promise<boolean> {
  let known = probed.get(pm);
  if (known === undefined) {
    known = new Promise<boolean>((done) => {
      const child = spawn(pm, ['--version'], {
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
        stdio: 'ignore',
      });
      const timer = setTimeout(() => child.kill(), 15_000);
      child.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    });
    probed.set(pm, known);
  }
  return known;
}

/** The real file reads and the real `<pm> --version` probe. */
export const defaultDetectIo: DetectIo = {
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
  runs: managerRuns,
};
const defaultIo = defaultDetectIo;

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
  return (await declaredPackageManager(dir, io)) ?? 'npm';
}

/**
 * What the folders at and above `dir` say about the package manager (a
 * `packageManager` field, then a lockfile or workspace marker, per
 * level); `undefined` when nothing does.
 */
export async function declaredPackageManager(
  dir: string,
  io: DetectIo = defaultIo,
): Promise<PackageManager | undefined> {
  let current = dir;
  for (;;) {
    const declared = parsePackageManagerField(await io.readFile(join(current, 'package.json')));
    if (declared !== undefined) return declared;
    for (const [file, pm] of MARKERS) {
      if (await io.exists(join(current, file))) return pm;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** A package manager's version as it prints it: `10.28.0`, `11.0.0-rc.1`. */
export function isPackageVersion(text: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text);
}

/**
 * `pnpm --version` in `dir`: the pnpm the host runs there (a corepack pin
 * included). Corepack never prompts (it would wait on no terminal), and
 * the read gives up after 15 s. Rejects with the reason.
 */
export function readPnpmVersion(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--version'], {
      cwd: dir,
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const version = stdout.trim().split('\n').pop()?.trim() ?? '';
      if (code === 0 && version !== '') resolve(version);
      else {
        const why =
          signal !== null
            ? 'it took longer than 15 s'
            : (stderr.trim().split('\n').pop() ?? `exit ${code}`);
        reject(new Error(why || `pnpm --version exited ${code}`));
      }
    });
  });
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

/**
 * The manager that runs this project's commands on this machine: the one
 * its folders declare (`detectPackageManager`) when it's installed here,
 * else npm, which comes with Node and runs whatever any manager put in
 * `node_modules/.bin`. `declared` names a declared manager this machine
 * doesn't have, so a printed command never names it.
 */
export async function usablePackageManager(
  dir: string,
  io: DetectIo = defaultIo,
): Promise<{ readonly pm: PackageManager; readonly declared?: PackageManager }> {
  const pm = await detectPackageManager(dir, io);
  if (pm === 'npm' || io.runs === undefined || (await io.runs(pm))) return { pm };
  return { pm: 'npm', declared: pm };
}

/**
 * The pack's `BinRunner`: `pythonBinRunner`'s for a Python pack; for a JVM
 * pack (Java, Scala), which has no npm or Python environment, its `kindgiw` (the CLI
 * version it pins), else the published CLI through npx; else the manager
 * that runs here.
 */
export async function detectBinRunner(
  dir: string,
  language: PackLanguage,
  io: DetectIo = defaultIo,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BinRunner> {
  if (language === 'python') return await pythonBinRunner(dir, env, io);
  // A JVM pack (Java, Scala) runs the CLI its kindgiw pins; without the wrapper, the published one.
  if (isJvmLanguage(language)) return (await io.exists(join(dir, 'kindgiw'))) ? 'kindgiw' : 'path';
  return (await usablePackageManager(dir, io)).pm;
}

/**
 * How to run a project-local bin — resolves `node_modules/.bin` and
 * refuses to download when the bin is missing. `path` runs the bin on
 * `PATH` (a Python pack's globally installed CLI).
 */
/**
 * The published CLI a hint downloads: `@kindgi/cli@<major.minor>` of the
 * running CLI, its exact version for a release candidate (a range never
 * matches a pre-release, so `@0.1` would run the last release), and
 * `@kindgi/cli` when the version is unknown.
 */
export function publishedCliSpec(version: string): string {
  const match = /^(\d+)\.(\d+)\.\d+(-\S+)?/.exec(version);
  if (match === null) return '@kindgi/cli';
  return match[3] === undefined ? `@kindgi/cli@${match[1]}.${match[2]}` : `@kindgi/cli@${version}`;
}

const PUBLISHED_CLI = publishedCliSpec(CLI_VERSION);

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
    case 'uv':
      // The PyPI CLI (`kindgi-cli`) in the pack's uv environment.
      return { command: 'uv', args: ['run', bin, ...args] };
    case 'poetry':
      return { command: 'poetry', args: ['run', bin, ...args] };
    case 'venv':
      // The PyPI CLI's script in the app's own (activated) environment.
      return { command: bin, args: [...args] };
    case 'kindgiw':
      // A Java pack's wrapper: the CLI version its kindgi.config.json pins.
      return bin === 'kindgi'
        ? { command: './kindgiw', args: [...args] }
        : { command: bin, args: [...args] };
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

/** How a project runs one of its package.json scripts: `pnpm typecheck`, `npm run typecheck`. */
export function scriptCommand(pm: PackageManager, script: string): string {
  return pm === 'npm' || pm === 'bun' ? `${pm} run ${script}` : `${pm} ${script}`;
}

/**
 * Protocol for depending on a local directory by symlink. npm has no
 * `link:`; its `file:` symlinks directories (npm ≥ 7).
 */
export function localLinkProtocol(pm: PackageManager): 'link:' | 'file:' {
  return pm === 'npm' ? 'file:' : 'link:';
}

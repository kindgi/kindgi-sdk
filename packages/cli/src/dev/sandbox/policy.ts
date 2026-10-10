// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What the sandboxed pack service may read, worked out at every start
 * from what that start runs:
 *
 * - the app (the pack root), read and write;
 * - every `node_modules` from the app up to `/` (a workspace's hoisted
 *   dependencies);
 * - the runtime: Node's install and the pack service's own package; the
 *   Python interpreter's `sys.path`, prefix and base prefix (a venv, a
 *   uv-managed Python under `~/.local/share/uv`); the JDK and every
 *   classpath entry (jars in `~/.m2/repository`, coursier's cache);
 * - `dev.sandbox.allowRead`;
 * - a linked package's own folder: where a dependency's link points
 *   outside all of the above (a checkout's workspace packages, `link:`
 *   ones), and theirs in turn.
 *
 * A root that is `/`, the home folder, or a folder holding the home
 * folder is left out (`skipped`): it would open everything the sandbox
 * closes.
 *
 * The app's Kindgi configuration (`kindgi.config.*`, `pyproject.toml`) is
 * read-only inside: `kindgi dev` itself loads it, and it says how wide the
 * sandbox is.
 */

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import { type PackCode, isJvmPackCode, javaArgsFile } from '../pack-code.js';
import type { DevSandboxSettings } from './settings.js';

export interface SandboxPolicy {
  /** The app (the pack root), real path. */
  readonly app: string;
  /** The home folder, real path. */
  readonly home: string;
  /** Real paths the service reads, outside the app. */
  readonly readRoots: readonly string[];
  /** Roots left out because they hold the home folder. */
  readonly skipped: readonly string[];
  /** UNIX sockets it may connect to (`dev.sandbox.allowUnixSockets`). */
  readonly allowUnixSockets: readonly string[];
  /** Its own temp folder, real path (its `TMPDIR` on macOS). */
  readonly tmpDir: string;
  /** Folders inside the app's closed `.kindgi` it may write (the indexer's output). */
  readonly writable: readonly string[];
  /**
   * The app's Kindgi configuration files, by every name `kindgi dev` looks
   * for, whether or not they exist: never written from inside.
   */
  readonly readOnly: readonly string[];
  /**
   * Symbolic links a path it runs from resolves through, outside the app
   * and the read roots (a uv-managed Python's `cpython-3.11-…` link to its
   * `cpython-3.11.16-…` folder, in the home folder): opened one by one
   * (macOS), or made again inside (Linux).
   */
  readonly links: readonly { readonly path: string; readonly target: string }[];
}

/** Every name `kindgi dev` reads a pack's configuration from, at the app's root. */
export const CONFIG_FILE_NAMES: readonly string[] = [
  'kindgi.config.ts',
  'kindgi.config.mts',
  'kindgi.config.cts',
  'kindgi.config.js',
  'kindgi.config.mjs',
  'kindgi.config.cjs',
  'kindgi.config.json',
  'pyproject.toml',
];

export interface SandboxPolicyOptions {
  readonly packDir: string;
  readonly home: string;
  readonly code: PackCode;
  readonly settings: DevSandboxSettings;
  readonly tmpDir: string;
  /** The pack service's environment, for asking the Python interpreter. */
  readonly env: Readonly<Record<string, string>>;
  /** Node: the binary and the entrypoint (the pack service's, or the indexer's). */
  readonly node: { readonly execPath: string; readonly entry: string };
  /** Folders inside the app's `.kindgi` it may write. */
  readonly writable?: readonly string[];
  /** Test seam: what the Python interpreter says about itself. */
  readonly queryPython?: (
    python: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<PythonPaths>;
}

export interface PythonPaths {
  readonly path: readonly string[];
  readonly prefix: string;
  readonly basePrefix: string;
  readonly executable: string;
}

export async function sandboxPolicy(opts: SandboxPolicyOptions): Promise<SandboxPolicy> {
  const app = real(opts.packDir);
  const home = real(opts.home);
  const runtime = await runtimeRoots(opts);
  const base = [...nodeModulesUpFrom(app), ...runtime.roots, ...opts.settings.allowRead];
  const linked = linkedPackages([app, ...runtime.packages], [app, ...base.map(real)]);
  const { readRoots, skipped } = partitionRoots([...base, ...linked], app, home);
  const inside = (p: string) => [app, ...readRoots].some((r) => p === r || p.startsWith(r + sep));
  const links = new Map<string, string>();
  for (const path of [...runtime.paths, ...base]) {
    for (const link of symlinksOf(path)) if (!inside(link.path)) links.set(link.path, link.target);
  }
  return {
    app,
    home,
    readRoots,
    skipped,
    allowUnixSockets: opts.settings.allowUnixSockets,
    tmpDir: opts.tmpDir,
    writable: (opts.writable ?? []).map(real),
    readOnly: CONFIG_FILE_NAMES.map((name) => join(app, name)),
    links: [...links].map(([path, target]) => ({ path, target })),
  };
}

/** How many links one path's resolution follows, at most (a loop stops there). */
const MAX_HOPS = 40;

/**
 * The symbolic links met while resolving `path`, in order: each one's own
 * path (its folder resolved) and its target as written.
 */
export function symlinksOf(path: string): { readonly path: string; readonly target: string }[] {
  if (!isAbsolute(path)) return [];
  const found: { path: string; target: string }[] = [];
  let pending = path.split(sep).filter((c) => c !== '');
  let at = parse(path).root;
  let hops = 0;
  while (pending.length > 0 && hops < MAX_HOPS) {
    const name = pending.shift() as string;
    if (name === '.') continue;
    if (name === '..') {
      at = dirname(at);
      continue;
    }
    const next = join(at, name);
    let target: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
    } catch {
      return found;
    }
    if (target === undefined) {
      at = next;
      continue;
    }
    hops += 1;
    found.push({ path: next, target });
    const rest = target.split(sep).filter((c) => c !== '');
    if (isAbsolute(target)) at = parse(target).root;
    pending = [...rest, ...pending];
  }
  return found;
}
/** How many linked packages the search follows, at most. */
const MAX_LINKED = 500;

/**
 * The real folders of the packages that dependencies of `starts` link to
 * outside `covered` (a checkout's workspace packages, `link:` ones), and
 * theirs in turn: each package's own folder, never a parent. A link into
 * a covered folder (a `node_modules`) isn't followed: it's open already.
 */
export function linkedPackages(starts: readonly string[], covered: readonly string[]): string[] {
  const isCovered = (p: string) => covered.some((c) => p === c || p.startsWith(c + sep));
  const found = new Set<string>();
  const queue = [...starts];
  const seen = new Set<string>();
  while (queue.length > 0 && found.size < MAX_LINKED) {
    const dir = queue.shift() as string;
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const name of dependencyNames(dir)) {
      const link = join(dir, 'node_modules', ...name.split('/'));
      let isLink = false;
      try {
        isLink = lstatSync(link).isSymbolicLink();
      } catch {
        continue;
      }
      if (!isLink) continue;
      const target = real(link);
      if (isCovered(target) || !existsSync(join(target, 'package.json'))) continue;
      found.add(target);
      queue.push(target);
    }
  }
  return [...found];
}

/** The names a package depends on at run time (`dependencies`, `optionalDependencies`). */
function dependencyNames(dir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

/**
 * What the pack's runtime reads: Node's install, the Python interpreter's
 * paths, the JDK and the classpath; and, for Node, the package whose
 * entrypoint runs (whose links are followed).
 */
async function runtimeRoots(opts: SandboxPolicyOptions): Promise<{
  readonly roots: string[];
  readonly packages: string[];
  /** The paths it runs from, as written (their links are made reachable too). */
  readonly paths: string[];
}> {
  const { code } = opts;
  if (code.language === 'node') {
    const node = nodeRoots(opts.node.execPath, opts.node.entry);
    return { ...node, paths: [opts.node.execPath, opts.node.entry] };
  }
  if (code.language === 'python') {
    const query = opts.queryPython ?? queryPythonReal;
    const py = await query(code.python, opts.packDir, opts.env);
    const program = code.python[0];
    return {
      roots: [...py.path, py.prefix, py.basePrefix, dirname(dirname(real(py.executable)))],
      packages: [],
      paths: [
        py.executable,
        ...(program !== undefined && isAbsolute(program) ? [program] : []),
        ...(program !== undefined && !isAbsolute(program) && program.includes(sep)
          ? [resolve(opts.packDir, program)]
          : []),
        ...py.path,
        py.prefix,
        py.basePrefix,
      ],
    };
  }
  if (isJvmPackCode(code)) {
    const jdk = jdkRoot(code.javaHome, code.java, opts.env.PATH);
    const classpath = await classpathEntries(javaArgsFile(code));
    return {
      roots: [jdk, ...classpath],
      packages: [],
      paths: [...(code.javaHome !== undefined ? [code.javaHome] : []), code.java, ...classpath],
    };
  }
  return { roots: [], packages: [], paths: [] };
}

/**
 * The candidates that exist, as real paths: outside the app (it's open
 * anyway), and not holding the home folder (those are `skipped`).
 */
function partitionRoots(
  candidates: readonly string[],
  app: string,
  home: string,
): { readonly readRoots: string[]; readonly skipped: string[] } {
  const readRoots = new Set<string>();
  const skipped = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === '' || !isAbsolute(candidate) || !existsSync(candidate)) continue;
    const root = real(candidate);
    if (root === app || root.startsWith(app + sep)) continue;
    (holds(root, home) ? skipped : readRoots).add(root);
  }
  return { readRoots: withoutNested([...readRoots]), skipped: [...skipped] };
}

/** Whether `root` is `/`, `home`, or a folder above it. */
function holds(root: string, home: string): boolean {
  return root === parse(root).root || home === root || home.startsWith(root + sep);
}

/** Drop a root inside another (the outer one covers it). */
function withoutNested(roots: readonly string[]): string[] {
  return roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(o + sep)));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `<dir>/node_modules` for the app and each folder above it, where one exists. */
function nodeModulesUpFrom(dir: string): string[] {
  const found: string[] = [];
  let at = dir;
  for (;;) {
    const candidate = join(at, 'node_modules');
    if (existsSync(candidate)) found.push(candidate);
    const up = dirname(at);
    if (up === at) return found;
    at = up;
  }
}

/** Node's install, and the entrypoint's package with the `node_modules` above it. */
function nodeRoots(
  execPath: string,
  entry: string,
): { readonly roots: string[]; readonly packages: string[] } {
  const entryReal = real(entry);
  let packageRoot = dirname(entryReal);
  while (!existsSync(join(packageRoot, 'package.json')) && dirname(packageRoot) !== packageRoot) {
    packageRoot = dirname(packageRoot);
  }
  return {
    roots: [dirname(dirname(real(execPath))), packageRoot, ...nodeModulesUpFrom(packageRoot)],
    packages: [packageRoot],
  };
}

/** The JDK's home: `javaHome`, else the `java` on `PATH`'s, two folders up from its real path. */
function jdkRoot(javaHome: string | undefined, java: string, path: string | undefined): string {
  if (javaHome !== undefined) return real(javaHome);
  const binary = isAbsolute(java)
    ? java
    : (path ?? '')
        .split(delimiter)
        .map((d) => join(d, java))
        .find((p) => existsSync(p));
  return binary === undefined ? '' : dirname(dirname(real(binary)));
}

/** The classpath in a JVM pack's `@argfile` (`-cp "<entries>"`), each entry's real path. */
export async function classpathEntries(argsFile: string): Promise<string[]> {
  const text = await readFile(argsFile, 'utf8').catch(() => '');
  const match = /-cp\s+"((?:[^"\\]|\\.)*)"/.exec(text);
  if (match?.[1] === undefined) return [];
  const value = match[1].replace(/\\(.)/g, '$1');
  return value
    .split(delimiter)
    .filter((e) => e !== '')
    .map((e) => (e.endsWith(`${sep}*`) ? e.slice(0, -2) : e));
}

const PYTHON_PATHS =
  'import json, sys; print(json.dumps({"path": sys.path, "prefix": sys.prefix, "base": sys.base_prefix, "exe": sys.executable}))';

/** Ask the pack's interpreter where it reads from. */
export function queryPythonReal(
  python: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<PythonPaths> {
  const [program, ...args] = python;
  return new Promise((resolvePaths, reject) => {
    execFile(
      program ?? 'python3',
      [...args, '-c', PYTHON_PATHS],
      { cwd, env, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err !== null) {
          reject(new Error(`could not ask the pack's Python where it reads from: ${err.message}`));
          return;
        }
        try {
          const line = stdout.trim().split('\n').pop() ?? '';
          const parsed = JSON.parse(line) as {
            path: string[];
            prefix: string;
            base: string;
            exe: string;
          };
          resolvePaths({
            path: parsed.path,
            prefix: parsed.prefix,
            basePrefix: parsed.base,
            executable: parsed.exe,
          });
        } catch (cause) {
          reject(
            new Error(`the pack's Python answered something else: ${(cause as Error).message}`),
          );
        }
      },
    );
  });
}

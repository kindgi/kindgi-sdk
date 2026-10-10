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
 * - `dev.sandbox.allowRead`.
 *
 * A root that is `/`, the home folder, or a folder holding the home
 * folder is left out (`skipped`): it would open everything the sandbox
 * closes.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, parse, sep } from 'node:path';

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
}

export interface SandboxPolicyOptions {
  readonly packDir: string;
  readonly home: string;
  readonly code: PackCode;
  readonly settings: DevSandboxSettings;
  readonly tmpDir: string;
  /** The pack service's environment, for asking the Python interpreter. */
  readonly env: Readonly<Record<string, string>>;
  /** Node: the binary and the pack service's entrypoint. */
  readonly node: { readonly execPath: string; readonly entry: string };
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
  const candidates = [
    ...nodeModulesUpFrom(app),
    ...(await runtimeRoots(opts)),
    ...opts.settings.allowRead,
  ];
  const { readRoots, skipped } = partitionRoots(candidates, app, home);
  return {
    app,
    home,
    readRoots,
    skipped,
    allowUnixSockets: opts.settings.allowUnixSockets,
    tmpDir: opts.tmpDir,
  };
}

/** What the pack's runtime reads: Node's install, the Python interpreter's paths, the JDK and the classpath. */
async function runtimeRoots(opts: SandboxPolicyOptions): Promise<string[]> {
  const { code } = opts;
  if (code.language === 'node') return nodeRoots(opts.node.execPath, opts.node.entry);
  if (code.language === 'python') {
    const query = opts.queryPython ?? queryPythonReal;
    const py = await query(code.python, opts.packDir, opts.env);
    return [...py.path, py.prefix, py.basePrefix, dirname(dirname(real(py.executable)))];
  }
  if (isJvmPackCode(code)) {
    return [
      jdkRoot(code.javaHome, code.java, opts.env.PATH),
      ...(await classpathEntries(javaArgsFile(code))),
    ];
  }
  return [];
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

/** Node's install, and the pack service's package with the `node_modules` above it. */
function nodeRoots(execPath: string, entry: string): string[] {
  const roots = [dirname(dirname(real(execPath)))];
  const entryReal = real(entry);
  let packageRoot = dirname(entryReal);
  while (!existsSync(join(packageRoot, 'package.json')) && dirname(packageRoot) !== packageRoot) {
    packageRoot = dirname(packageRoot);
  }
  roots.push(packageRoot, ...nodeModulesUpFrom(packageRoot));
  return roots;
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

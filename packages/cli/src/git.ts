// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Git, run by its absolute path from `PATH`: never a `git` in the folder
 * it runs in.
 *
 * The CLI runs git (and gh) in the pack's folder. Given a bare `'git'`,
 * Node hands the name to libuv, and on Windows libuv looks in the child's
 * `cwd` (for `git.com`, then `git.exe`) before `PATH`, unless
 * `NoDefaultCurrentDirectoryInExePath` is set. A `git.exe` in the pack
 * would then run in git's place. On every platform, an empty or relative
 * `PATH` entry is relative to that folder too. {@link findOnPath} looks
 * only in `PATH`'s absolute entries, trying the names libuv would there,
 * and {@link gitOutput} runs the git it finds.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/** Where {@link searchPath} looks; tests pass another platform. */
export interface PathLookup {
  readonly platform: NodeJS.Platform;
  /** `PATH`'s value; `undefined` when it isn't set. */
  readonly path: string | undefined;
  /** Whether `file` is a file the platform can run. */
  readonly runnable: (file: string) => Promise<boolean>;
}

const runnable = async (file: string): Promise<boolean> => {
  try {
    if (!(await stat(file)).isFile()) return false;
    // Windows runs a file it finds by name whatever its mode, as libuv does.
    if (process.platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * `env`'s `PATH`. On Windows the name's case doesn't matter, and of two
 * spellings the one Node gives a child is used: the first, sorted.
 */
export function pathValue(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (platform !== 'win32') return env.PATH;
  const [name] = Object.keys(env)
    .filter((key) => key.toUpperCase() === 'PATH')
    .sort();
  return name === undefined ? undefined : env[name];
}

/**
 * `PATH`'s entries, in order. On Windows they're split at `;`, and a
 * double-quoted part may hold one; the quotes are taken off.
 */
export function pathEntries(platform: NodeJS.Platform, value: string): string[] {
  if (platform !== 'win32') return value.split(':');
  const entries: string[] = [];
  let entry = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === ';' && !quoted) {
      entries.push(entry);
      entry = '';
    } else entry += char;
  }
  entries.push(entry);
  return entries;
}

/**
 * Whether `entry` names the same folder whatever the current one is: on
 * Windows, a drive's (`C:\…`) or a share's (`\\host\…`), not `C:tools` or
 * `\tools`.
 */
function absolute(platform: NodeJS.Platform, entry: string): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(entry) || /^[\\/]{2}[^\\/]/.test(entry);
  return entry.startsWith('/');
}

/**
 * `name`'s absolute path: in the first absolute `PATH` entry that holds
 * it, as `<name>.com` and then `<name>.exe` on Windows (the names libuv
 * tries); `undefined` when none does. Empty and relative entries are
 * skipped.
 */
export async function searchPath(name: string, lookup: PathLookup): Promise<string | undefined> {
  if (lookup.path === undefined) return undefined;
  const join = lookup.platform === 'win32' ? path.win32.join : path.posix.join;
  const names = lookup.platform === 'win32' ? [`${name}.com`, `${name}.exe`] : [name];
  for (const entry of pathEntries(lookup.platform, lookup.path)) {
    if (!absolute(lookup.platform, entry)) continue;
    for (const fileName of names) {
      const file = join(entry, fileName);
      if (await lookup.runnable(file)) return file;
    }
  }
  return undefined;
}

const found = new Map<string, Promise<string | undefined>>();

/**
 * {@link searchPath} for `name` on `env`'s `PATH`, on this platform. A
 * path found is kept for each `PATH` value. A miss isn't, so a program
 * installed while the CLI runs is found at the next call.
 */
export function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const value = pathValue(process.platform, env);
  if (value === undefined) return Promise.resolve(undefined);
  const key = `${name}\0${value}`;
  const kept = found.get(key);
  if (kept !== undefined) return kept;
  const search = searchPath(name, { platform: process.platform, path: value, runnable }).then(
    (file) => {
      if (file === undefined && found.get(key) === search) found.delete(key);
      return file;
    },
  );
  found.set(key, search);
  return search;
}

export interface GitRun {
  /** Milliseconds git may run before it's ended. */
  readonly timeout: number;
  /** The most it may print, in bytes (`execFile`'s `maxBuffer`; 1 MiB when absent). */
  readonly maxBuffer?: number;
  /** The environment git is found on and run with; this process's when absent. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * `git <args>` run in `cwd`, by {@link findOnPath}'s path: what it
 * printed, or `undefined` when it failed or there's no git on `PATH`.
 */
export async function gitOutput(
  cwd: string,
  args: readonly string[],
  run: GitRun,
): Promise<string | undefined> {
  const git = await findOnPath('git', run.env ?? process.env);
  if (git === undefined) return undefined;
  return new Promise<string | undefined>((resolvePromise) => {
    execFile(
      git,
      [...args],
      {
        cwd,
        timeout: run.timeout,
        ...(run.maxBuffer !== undefined && { maxBuffer: run.maxBuffer }),
        ...(run.env !== undefined && { env: run.env }),
      },
      (err, stdout) => resolvePromise(err === null ? stdout : undefined),
    );
  });
}

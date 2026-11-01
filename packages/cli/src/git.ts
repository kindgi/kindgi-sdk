// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Git, run by its absolute path from `PATH`: never a `git` in the folder
 * it runs in.
 *
 * The CLI runs git in the pack's folder. Given a bare `'git'`, Node hands
 * the name to libuv, and on Windows libuv looks in the child's `cwd`
 * (for `git.com`, then `git.exe`) before `PATH`, unless
 * `NoDefaultCurrentDirectoryInExePath` is set. A `git.exe` in the pack
 * would then run in git's place. On every platform, an empty or relative
 * `PATH` entry is relative to that folder too. {@link findGit} looks
 * only in `PATH`'s absolute entries, trying the names libuv would there,
 * and {@link gitOutput} runs what it found.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/** Where {@link findGit} looks: {@link gitLookup} for this process; tests pass another platform. */
export interface GitLookup {
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

/** This process's platform and `PATH`. */
export function gitLookup(): GitLookup {
  return { platform: process.platform, path: process.env.PATH, runnable };
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
 * Git's absolute path: in the first absolute `PATH` entry that holds it,
 * as `git.com` and then `git.exe` on Windows (the names libuv tries);
 * `undefined` when none does. Empty and relative entries are skipped.
 */
export async function findGit(lookup: GitLookup): Promise<string | undefined> {
  if (lookup.path === undefined) return undefined;
  const join = lookup.platform === 'win32' ? path.win32.join : path.posix.join;
  const names = lookup.platform === 'win32' ? ['git.com', 'git.exe'] : ['git'];
  for (const entry of pathEntries(lookup.platform, lookup.path)) {
    if (!absolute(lookup.platform, entry)) continue;
    for (const name of names) {
      const file = join(entry, name);
      if (await lookup.runnable(file)) return file;
    }
  }
  return undefined;
}

let found:
  | { readonly path: string | undefined; readonly git: Promise<string | undefined> }
  | undefined;

/** {@link findGit} for this process, looked up once for each `PATH` it has. */
function processGit(): Promise<string | undefined> {
  const lookup = gitLookup();
  if (found === undefined || found.path !== lookup.path) {
    found = { path: lookup.path, git: findGit(lookup) };
  }
  return found.git;
}

export interface GitRun {
  /** Milliseconds git may run before it's ended. */
  readonly timeout: number;
  /** The most it may print, in bytes (`execFile`'s `maxBuffer`; 1 MiB when absent). */
  readonly maxBuffer?: number;
}

/**
 * `git <args>` run in `cwd`, by {@link findGit}'s path: what it printed,
 * or `undefined` when it failed or there's no git on `PATH`.
 */
export async function gitOutput(
  cwd: string,
  args: readonly string[],
  run: GitRun,
): Promise<string | undefined> {
  const git = await processGit();
  if (git === undefined) return undefined;
  return new Promise<string | undefined>((resolvePromise) => {
    execFile(
      git,
      [...args],
      {
        cwd,
        timeout: run.timeout,
        ...(run.maxBuffer !== undefined && { maxBuffer: run.maxBuffer }),
      },
      (err, stdout) => resolvePromise(err === null ? stdout : undefined),
    );
  });
}

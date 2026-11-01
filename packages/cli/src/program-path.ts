// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The programs the CLI starts, by their absolute path from `PATH`: never
 * one in the folder they run in.
 *
 * The CLI starts git, docker, the package manager, the pack's Python and
 * more, often in the pack's folder. Given a bare name, Node hands it to
 * libuv, and on Windows libuv looks in the child's `cwd` (for
 * `<name>.com`, then `<name>.exe`) before `PATH`, unless
 * `NoDefaultCurrentDirectoryInExePath` is set; with no `cwd` given, that's
 * the CLI's own folder. A `docker.exe` in the pack would then run in
 * docker's place. On every platform, an empty or relative `PATH` entry is
 * relative to that folder too. {@link findOnPath} looks only in `PATH`'s
 * absolute entries, trying the names libuv would there, and every child
 * the CLI starts runs what {@link programPath} finds.
 */

import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import path from 'node:path';

/** An environment, as a child gets it. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Where {@link searchPath} looks; tests pass another platform. */
export interface PathLookup {
  readonly platform: NodeJS.Platform;
  /** `PATH`'s value; `undefined` when it isn't set. */
  readonly path: string | undefined;
  /** Whether `file` is a file the platform can run. */
  readonly runnable: (file: string) => Promise<boolean>;
}

/** The file reads {@link runnable} makes; tests pass others. */
export interface RunnableFs {
  readonly lstat: (file: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readonly stat: (file: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readonly access: (file: string, mode: number) => Promise<void>;
}

const NODE_FS: RunnableFs = { lstat, stat, access };

/**
 * Whether `file` is one `platform` runs when it finds it by name.
 *
 * On Windows that's libuv's own test: it's there and isn't a folder, read
 * without following a link. So a Store app's `python.exe`, an alias that
 * can't be opened as a file, is one, and a link to a folder isn't.
 * Windows runs it whatever its mode. Elsewhere it's a file, or a link to
 * one, that may be run.
 */
export async function runnable(
  platform: NodeJS.Platform,
  file: string,
  fs: RunnableFs = NODE_FS,
): Promise<boolean> {
  try {
    if (platform === 'win32') {
      const entry = await fs.lstat(file);
      if (entry.isDirectory()) return false;
      if (!entry.isSymbolicLink()) return true;
      return await fs.stat(file).then(
        (target) => !target.isDirectory(),
        () => true,
      );
    }
    if (!(await fs.stat(file)).isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `env`'s `PATH`. On Windows the name's case doesn't matter, and of two
 * spellings the one Node gives a child is used: the first, sorted.
 */
export function pathValue(platform: NodeJS.Platform, env: Env): string | undefined {
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
 * The names libuv tries for `name` in each folder on Windows: `name` as
 * given when it has an extension (a `.` with something after it, as in
 * `notepad.exe` or `python3.12`), then `<name>.com` and `<name>.exe`. A
 * name that ends in `.` takes those without a second one. `.` and an empty
 * name are never a program.
 */
function windowsNames(name: string): string[] {
  if (name === '' || name === '.') return [];
  const dot = name.indexOf('.');
  const stem = name.endsWith('.') ? name : `${name}.`;
  const given = dot !== -1 && dot < name.length - 1 ? [name] : [];
  return [...given, `${stem}com`, `${stem}exe`];
}

/**
 * `name`'s absolute path: in the first absolute `PATH` entry that holds
 * it, by the names libuv tries there on Windows ({@link windowsNames});
 * `undefined` when none does. Empty and relative entries are skipped.
 */
export async function searchPath(name: string, lookup: PathLookup): Promise<string | undefined> {
  if (lookup.path === undefined) return undefined;
  const join = lookup.platform === 'win32' ? path.win32.join : path.posix.join;
  const names = lookup.platform === 'win32' ? windowsNames(name) : [name];
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
export function findOnPath(name: string, env: Env): Promise<string | undefined> {
  const value = pathValue(process.platform, env);
  if (value === undefined) return Promise.resolve(undefined);
  const key = `${name}\0${value}`;
  const kept = found.get(key);
  if (kept !== undefined) return kept;
  const search = searchPath(name, {
    platform: process.platform,
    path: value,
    runnable: (file) => runnable(process.platform, file),
  }).then((file) => {
    if (file === undefined && found.get(key) === search) found.delete(key);
    return file;
  });
  found.set(key, search);
  return search;
}

/**
 * Whether one of `PATH`'s absolute entries holds `name`, though not as a
 * program that may be run (no run permission, or a folder). Off Windows,
 * spawn tries each entry, goes on past one it may not run, and gives
 * `EACCES` rather than `ENOENT` when it finds no program but found one of
 * those. On Windows, {@link runnable} is libuv's whole test: there's none.
 */
async function refusedOnPath(name: string, env: Env): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const value = pathValue(process.platform, env);
  if (value === undefined) return false;
  for (const entry of pathEntries(process.platform, value)) {
    if (!absolute(process.platform, entry)) continue;
    const there = await stat(path.posix.join(entry, name)).then(
      () => true,
      (cause: NodeJS.ErrnoException) => cause.code === 'EACCES',
    );
    if (there) return true;
  }
  return false;
}

/**
 * Whether `command` names a file rather than a program to look for: on
 * Windows it holds a `\`, `/` or a drive's `:`; elsewhere a `/`. libuv
 * doesn't search `PATH` for one.
 */
export function namesFile(platform: NodeJS.Platform, command: string): boolean {
  return platform === 'win32' ? /[\\/:]/.test(command) : command.includes('/');
}

/**
 * The file a child runs for `command` with `env`, the child's own
 * environment: a bare name by {@link findOnPath}; a path (a setting's
 * `dev.python`, `$JAVA_HOME/bin/java`, `process.execPath`) as given, and
 * an empty one too, for spawn's own error. Rejects, when `PATH`'s absolute
 * entries hold no such program, with the error Node's spawn gives for one
 * it can't find (`code` `ENOENT`, `spawn <command> ENOENT`), or for one it
 * found but couldn't run (`EACCES`, {@link refusedOnPath}), so a caller's
 * not-found path reads as it did.
 */
export async function programPath(command: string, env: Env = process.env): Promise<string> {
  if (command === '' || namesFile(process.platform, command)) return command;
  const file = await findOnPath(command, env);
  if (file !== undefined) return file;
  const code = (await refusedOnPath(command, env)) ? 'EACCES' : 'ENOENT';
  const error: NodeJS.ErrnoException = new Error(`spawn ${command} ${code}`);
  error.code = code;
  error.syscall = `spawn ${command}`;
  error.path = command;
  throw error;
}

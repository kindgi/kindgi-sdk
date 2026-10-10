// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Which env files belong to a pack environment, and what they hold.
 *
 * **`local` — `kindgi dev`.** The project's own env files, read the way
 * the application beside the pack reads them: `.env`, then `.env.local`
 * on top (override per pack with `dev.envFiles` in `kindgi.config.ts`).
 * Then Kindgi's own secrets file, `.kindgi/secrets.env`, on top of those:
 * a secret stored with `kindgi secrets set` lands there, not in a file
 * the application loads too (a framework loads `.env.local` into every
 * route of the app). `kindgi secrets set --app` writes the app's own
 * highest-precedence file instead, for a value both sides read.
 *
 * **Any other environment** (`staging`, `production`, …) — one file,
 * `.env.<envName>`, read and written as-is. Deployed environments keep
 * their real secrets in the runtime's secret store; these files carry
 * per-environment values to push there.
 *
 * **Runtime vs. agents.** One file can hold both Kindgi's own runtime
 * config and the values the pack's agents use. The `KINDGI_` prefix is
 * the line: `KINDGI_*` names configure Kindgi and are never exposed as
 * secrets; every other name belongs to the pack.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { type EnvDiagnostic, readEnvLayers } from '@kindgi/dotenv-file';

/** The environment `kindgi dev` runs as. */
export const LOCAL_ENV_NAME = 'local';

/** The app's files read for `local`, lowest precedence first. */
export const DEFAULT_LOCAL_ENV_FILES: readonly string[] = ['.env', '.env.local'];

/**
 * Kindgi's own secrets file for `local`, relative to the pack: read after
 * the app's files (so it wins) and the target of `kindgi secrets set`.
 * Under `.kindgi/`, which `kindgi init` and every template gitignore; no
 * framework loads it.
 */
export const KINDGI_SECRETS_FILE = '.kindgi/secrets.env';

/** Names with this prefix are Kindgi runtime config, never pack secrets. */
export const RUNTIME_KEY_PREFIX = 'KINDGI_';

export function isRuntimeKey(name: string): boolean {
  return name.startsWith(RUNTIME_KEY_PREFIX);
}

export interface PackEnvFilesInput {
  /** Pack root — the directory holding `kindgi.config.ts`. */
  readonly packDir: string;
  readonly envName: string;
  /**
   * Files read for `local`, lowest precedence first; relative paths
   * resolve against `packDir`. Defaults to `DEFAULT_LOCAL_ENV_FILES`.
   * Ignored for every other environment.
   */
  readonly localEnvFiles?: readonly string[];
}

export interface PackEnvFiles {
  /** Absolute paths, lowest precedence first. */
  readonly read: readonly string[];
  /** Where a secret's write lands: Kindgi's own file for `local`, else the env's file. */
  readonly write: string;
  /** The app's own files among `read` (for `local`, every file but Kindgi's), lowest first. */
  readonly app: readonly string[];
  /** Where a write for the app lands (`set --app`): the app's highest-precedence file. */
  readonly appWrite: string;
  /** Kindgi's own secrets file (absolute), for `local` only. */
  readonly kindgi?: string;
}

export function resolvePackEnvFiles(input: PackEnvFilesInput): PackEnvFiles {
  const names =
    input.envName === LOCAL_ENV_NAME
      ? (input.localEnvFiles ?? DEFAULT_LOCAL_ENV_FILES)
      : [`.env.${input.envName}`];
  if (names.length === 0) {
    throw new TypeError('localEnvFiles must list at least one file.');
  }
  const app = names.map((n) => (isAbsolute(n) ? n : join(input.packDir, n)));
  const appWrite = app[app.length - 1] as string;
  if (input.envName !== LOCAL_ENV_NAME) return { read: app, write: appWrite, app, appWrite };
  const kindgi = join(input.packDir, KINDGI_SECRETS_FILE);
  return { read: [...app, kindgi], write: kindgi, app, appWrite, kindgi };
}

/** Display form of a pack env file path (relative to the pack when inside it). */
export function displayEnvPath(packDir: string, path: string): string {
  const rel = relative(packDir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

export interface ReadPackEnvInput extends PackEnvFilesInput {
  /**
   * Fallback for `${VAR}` references no file defines — typically the
   * process environment. Never overrides a file's own value.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** File reader: contents, or `null` when the file does not exist. */
  readonly readFile?: (path: string) => Promise<string | null>;
}

/** A file that exists but can't be read (a read guard, a permission). */
export interface UnreadableEnvFile {
  /** Absolute path. */
  readonly file: string;
  /** The error code, e.g. `EACCES` or `EPERM`. */
  readonly code: string;
}

export interface PackEnv {
  readonly files: PackEnvFiles;
  /** Files that exist, lowest precedence first. */
  readonly present: readonly string[];
  /** Every name the files define — runtime and pack — merged and expanded. */
  readonly values: Readonly<Record<string, string>>;
  /** For each name, the file that supplied it. */
  readonly origin: Readonly<Record<string, string>>;
  readonly diagnostics: readonly EnvDiagnostic[];
  /**
   * Files that exist but couldn't be read: left out of `values`. A caller
   * that needs every file says so by name (`describeUnreadable`); one that
   * reports (`kindgi doctor`) carries on.
   */
  readonly unreadable: readonly UnreadableEnvFile[];
}

/** Error codes that mean "there, but not readable by this process". */
const UNREADABLE_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM']);

export async function readPackEnv(input: ReadPackEnvInput): Promise<PackEnv> {
  const files = resolvePackEnvFiles(input);
  const read = input.readFile ?? readFileOrNull;
  const unreadable: UnreadableEnvFile[] = [];
  const layers = await Promise.all(
    files.read.map(async (source) => {
      try {
        return { source, contents: await read(source) };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === undefined || !UNREADABLE_CODES.has(code)) throw err;
        unreadable.push({ file: source, code });
        return { source, contents: null };
      }
    }),
  );
  const view = readEnvLayers(layers, input.env !== undefined ? { env: input.env } : {});
  return {
    files,
    present: view.present,
    values: view.values,
    origin: view.origin,
    diagnostics: view.diagnostics,
    unreadable: files.read.flatMap((f) => unreadable.filter((u) => u.file === f)),
  };
}

/** `.env.local (permission denied)`, for a message naming the files that couldn't be read. */
export function describeUnreadable(
  packDir: string,
  unreadable: readonly UnreadableEnvFile[],
): string {
  return unreadable.map((u) => `${displayEnvPath(packDir, u.file)} (permission denied)`).join(', ');
}

/** The pack's names only (`KINDGI_*` removed). */
export function packValues(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => !isRuntimeKey(name)));
}

/** Kindgi's runtime config only (`KINDGI_*`). */
export function runtimeValues(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => isRuntimeKey(name)));
}

export async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fsReadFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

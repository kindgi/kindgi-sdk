// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Which env files belong to a pack environment, and what they hold.
 *
 * **`local` — `kindgi dev`.** The project's own env files, read the way
 * the application beside the pack reads them: `.env`, then `.env.local`
 * on top (override per pack with `dev.envFiles` in `kindgi.config.ts`).
 * Kindgi reads them; it writes only when asked (an explicit secret or
 * env `set`), and then to the highest-precedence file so the new value
 * wins.
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

/** Files read for `local`, lowest precedence first. */
export const DEFAULT_LOCAL_ENV_FILES: readonly string[] = ['.env', '.env.local'];

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
  /** Where a write lands — the highest-precedence file. */
  readonly write: string;
}

export function resolvePackEnvFiles(input: PackEnvFilesInput): PackEnvFiles {
  const names =
    input.envName === LOCAL_ENV_NAME
      ? (input.localEnvFiles ?? DEFAULT_LOCAL_ENV_FILES)
      : [`.env.${input.envName}`];
  if (names.length === 0) {
    throw new TypeError('localEnvFiles must list at least one file.');
  }
  const read = names.map((n) => (isAbsolute(n) ? n : join(input.packDir, n)));
  return { read, write: read[read.length - 1] as string };
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

export interface PackEnv {
  readonly files: PackEnvFiles;
  /** Files that exist, lowest precedence first. */
  readonly present: readonly string[];
  /** Every name the files define — runtime and pack — merged and expanded. */
  readonly values: Readonly<Record<string, string>>;
  /** For each name, the file that supplied it. */
  readonly origin: Readonly<Record<string, string>>;
  readonly diagnostics: readonly EnvDiagnostic[];
}

export async function readPackEnv(input: ReadPackEnvInput): Promise<PackEnv> {
  const files = resolvePackEnvFiles(input);
  const read = input.readFile ?? readFileOrNull;
  const layers = await Promise.all(
    files.read.map(async (source) => ({ source, contents: await read(source) })),
  );
  const view = readEnvLayers(layers, input.env !== undefined ? { env: input.env } : {});
  return {
    files,
    present: view.present,
    values: view.values,
    origin: view.origin,
    diagnostics: view.diagnostics,
  };
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

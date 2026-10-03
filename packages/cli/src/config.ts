// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Resolved configuration used by every command. Precedence at load
 * time is: CLI flag (`--url`, `--token`) > env var
 * (`KINDGI_API_URL`, `KINDGI_API_TOKEN`) > file
 * (`.kindgirc.json` in cwd, then `~/.kindgi/config.json`).
 */
export interface ResolvedConfig {
  readonly apiUrl: string | undefined;
  readonly token: string | undefined;
  readonly source: {
    readonly apiUrl: ConfigSource;
    readonly token: ConfigSource;
  };
}

export type ConfigSource = 'flag' | 'env' | 'file' | 'unset';

export interface ConfigInputs {
  readonly flagUrl?: string | undefined;
  readonly flagToken?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Directory used as cwd when looking for `.kindgirc.json`. */
  readonly cwd?: string;
  /** Directory used as `$HOME` when looking for `~/.kindgi/config.json`. */
  readonly home?: string;
  /**
   * Optional file loader override for tests. Returns `null` when the
   * file does not exist; throws for any other IO error.
   */
  readonly readFile?: (path: string) => Promise<string | null>;
}

interface FileConfig {
  readonly apiUrl?: string;
  readonly token?: string;
}

async function defaultReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadConfig(inputs: ConfigInputs = {}): Promise<ResolvedConfig> {
  const env = inputs.env ?? process.env;
  const cwd = inputs.cwd ?? process.cwd();
  const home = inputs.home ?? homedir();
  const read = inputs.readFile ?? defaultReadFile;

  const fileConfig = await loadFileConfig(cwd, home, read);

  const envUrl = env.KINDGI_API_URL;
  const envToken = env.KINDGI_API_TOKEN;

  const apiUrl = pickWithSource(inputs.flagUrl, envUrl, fileConfig.apiUrl);
  const token = pickWithSource(inputs.flagToken, envToken, fileConfig.token);

  return {
    apiUrl: apiUrl.value,
    token: token.value,
    source: { apiUrl: apiUrl.source, token: token.source },
  };
}

function pickWithSource(
  flag: string | undefined,
  env: string | undefined,
  file: string | undefined,
): { value: string | undefined; source: ConfigSource } {
  if (typeof flag === 'string' && flag !== '') return { value: flag, source: 'flag' };
  if (typeof env === 'string' && env !== '') return { value: env, source: 'env' };
  if (typeof file === 'string' && file !== '') return { value: file, source: 'file' };
  return { value: undefined, source: 'unset' };
}

async function loadFileConfig(
  cwd: string,
  home: string,
  read: (path: string) => Promise<string | null>,
): Promise<FileConfig> {
  const cwdPath = join(cwd, '.kindgirc.json');
  const homePath = join(home, '.kindgi', 'config.json');
  const merged: { apiUrl?: string; token?: string } = {};
  for (const path of [homePath, cwdPath]) {
    const raw = await read(path);
    if (raw === null) continue;
    const parsed = parseJson(raw, path);
    if (typeof parsed.apiUrl === 'string') merged.apiUrl = parsed.apiUrl;
    if (typeof parsed.token === 'string') merged.token = parsed.token;
  }
  return merged;
}

function parseJson(raw: string, path: string): FileConfig {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj === null || typeof obj !== 'object') return {};
    return obj as FileConfig;
  } catch (err) {
    throw new Error(
      `Malformed JSON in ${path}: ${(err as Error).message}. Delete or repair the file.`,
    );
  }
}

/**
 * Persist a config file at `~/.kindgi/config.json`. Called by
 * `kindgi auth login`. Merges with any existing file so a partial
 * write does not clobber other keys.
 */
export async function saveHomeConfig(
  patch: FileConfig,
  home: string | undefined = homedir(),
): Promise<string> {
  const resolvedHome = home ?? homedir();
  const path = join(resolvedHome, '.kindgi', 'config.json');
  const existing = await defaultReadFile(path);
  const base = existing === null ? {} : (JSON.parse(existing) as FileConfig);
  const next = { ...base, ...patch };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return path;
}

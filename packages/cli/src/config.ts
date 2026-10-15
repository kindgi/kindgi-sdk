// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isLocalAddress } from './api-address.js';

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
  /** The file each value came from, when its source is `file`. */
  readonly files?: {
    readonly apiUrl?: ConfigFile;
    readonly token?: ConfigFile;
  };
  /**
   * The API address stored beside the key, in the key's own file: the
   * address the key is for. Set when the key came from a file that has one.
   */
  readonly keyAddress?: string;
  /**
   * This folder's `.kindgirc.json` when it points at a local runtime (a
   * loopback `apiUrl`, as `kindgi dev` writes it), with the config resolved
   * without that file. `--hosted` goes on `without`: a local runtime is
   * never a hosted target. Flag and env values stay in it.
   */
  readonly localRuntime?: {
    readonly file: string;
    readonly apiUrl: string;
    readonly without: ResolvedConfig;
  };
}

export type ConfigSource = 'flag' | 'env' | 'file' | 'unset';

/**
 * A config file: `~/.kindgi/config.json` (`home`, which `kindgi auth
 * login` writes) or this folder's `.kindgirc.json` (`folder`, which
 * `kindgi dev` writes).
 */
export interface ConfigFile {
  readonly path: string;
  readonly kind: 'home' | 'folder';
}

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

/** A config file that was there, and what it holds. */
interface ReadConfigFile extends ConfigFile {
  readonly values: FileConfig;
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

  const homeFile = await readConfigFile(join(home, '.kindgi', 'config.json'), 'home', read);
  const folderFile = await readConfigFile(join(cwd, '.kindgirc.json'), 'folder', read);
  const resolve = (files: readonly (ReadConfigFile | undefined)[]) =>
    resolveConfig(inputs.flagUrl, inputs.flagToken, env, files);

  const config = resolve([homeFile, folderFile]);
  const local = folderFile?.values.apiUrl;
  if (folderFile === undefined || local === undefined || !isLocalAddress(local)) return config;
  return {
    ...config,
    localRuntime: { file: folderFile.path, apiUrl: local, without: resolve([homeFile]) },
  };
}

/**
 * Each value: the flag, else the env var, else the last of `files` that
 * holds it (this folder's file over the home one, field by field).
 */
function resolveConfig(
  flagUrl: string | undefined,
  flagToken: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  files: readonly (ReadConfigFile | undefined)[],
): ResolvedConfig {
  const urlFile = lastHolding(files, 'apiUrl');
  const tokenFile = lastHolding(files, 'token');
  const apiUrl = pickWithSource(flagUrl, env.KINDGI_API_URL, urlFile?.values.apiUrl);
  const token = pickWithSource(flagToken, env.KINDGI_API_TOKEN, tokenFile?.values.token);
  const keyAddress = token.source === 'file' ? tokenFile?.values.apiUrl : undefined;
  const from = {
    ...(apiUrl.source === 'file' && urlFile !== undefined && { apiUrl: fileRef(urlFile) }),
    ...(token.source === 'file' && tokenFile !== undefined && { token: fileRef(tokenFile) }),
  };
  return {
    apiUrl: apiUrl.value,
    token: token.value,
    source: { apiUrl: apiUrl.source, token: token.source },
    ...(Object.keys(from).length > 0 && { files: from }),
    ...(keyAddress !== undefined && keyAddress !== '' && { keyAddress }),
  };
}

function lastHolding(
  files: readonly (ReadConfigFile | undefined)[],
  field: keyof FileConfig,
): ReadConfigFile | undefined {
  return files.findLast((f) => typeof f?.values[field] === 'string');
}

function fileRef(file: ReadConfigFile): ConfigFile {
  return { path: file.path, kind: file.kind };
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

async function readConfigFile(
  path: string,
  kind: ConfigFile['kind'],
  read: (path: string) => Promise<string | null>,
): Promise<ReadConfigFile | undefined> {
  const raw = await read(path);
  if (raw === null) return undefined;
  const parsed = parseJson(raw, path);
  return {
    path,
    kind,
    values: {
      ...(typeof parsed.apiUrl === 'string' && { apiUrl: parsed.apiUrl }),
      ...(typeof parsed.token === 'string' && { token: parsed.token }),
    },
  };
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

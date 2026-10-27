// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isLocalAddress, storedKeyFor } from './api-address.js';
import { writePrivateFile } from './private-file.js';

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
   * When the key is a stored one: every key the config files hold, each
   * with the address stored beside it, the home file's before this
   * folder's. A stored key goes only to its own address, and the key for
   * an address is found by it (`storedKeyFor` in api-address.ts).
   */
  readonly storedKeys?: readonly StoredKey[];
  /**
   * This folder's `.kindgirc.json` when it points at a `kindgi dev`
   * runtime (`kindgi dev` wrote it, or its `apiUrl` is a loopback one),
   * with the config resolved without that file. `--hosted` goes on
   * `without`: a dev runtime is never a hosted target. Flag and env
   * values stay in it.
   */
  readonly devRuntime?: {
    readonly file: string;
    readonly apiUrl?: string;
    readonly without: ResolvedConfig;
  };
}

export type ConfigSource = 'flag' | 'env' | 'file' | 'unset';

/** A key a config file holds, and the address stored beside it, if any. */
export interface StoredKey {
  readonly token: string;
  readonly apiUrl?: string;
  readonly file: ConfigFile;
}

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
  /** `kindgi dev` writes these beside its runtime's address and key. */
  readonly packServicePort?: unknown;
  readonly packServiceToken?: unknown;
}

/** A config file that was there, and what it holds. */
interface ReadConfigFile extends ConfigFile {
  readonly values: Pick<FileConfig, 'apiUrl' | 'token'>;
  /** `kindgi dev` wrote it: it has the pack service's port or token. */
  readonly writtenByDev: boolean;
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
  if (folderFile === undefined || !pointsAtDevRuntime(folderFile)) return config;
  const apiUrl = folderFile.values.apiUrl;
  return {
    ...config,
    devRuntime: {
      file: folderFile.path,
      ...(apiUrl !== undefined && { apiUrl }),
      without: resolve([homeFile]),
    },
  };
}

/** A `.kindgirc.json` for a `kindgi dev` runtime: `kindgi dev` wrote it, or it's at a loopback address. */
function pointsAtDevRuntime(file: ReadConfigFile): boolean {
  const apiUrl = file.values.apiUrl;
  return file.writtenByDev || (apiUrl !== undefined && isLocalAddress(apiUrl));
}

/**
 * Each value: the flag, else the env var, else the last of `files` that
 * holds it (this folder's file over the home one, field by field). A
 * stored key is the one for the address: see `storedKeyFor`.
 */
function resolveConfig(
  flagUrl: string | undefined,
  flagToken: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  files: readonly (ReadConfigFile | undefined)[],
): ResolvedConfig {
  const urlFile = lastHolding(files, 'apiUrl');
  const apiUrl = pickWithSource(flagUrl, env.KINDGI_API_URL, urlFile?.values.apiUrl);
  const keys = storedKeysOf(files);
  const stored = storedKeyFor(keys, apiUrl.value);
  const token = pickWithSource(flagToken, env.KINDGI_API_TOKEN, stored?.token);
  const key = token.source === 'file' ? stored : undefined;
  const from = {
    ...(apiUrl.source === 'file' && urlFile !== undefined && { apiUrl: fileRef(urlFile) }),
    ...(key !== undefined && { token: key.file }),
  };
  return {
    apiUrl: apiUrl.value,
    token: token.value,
    source: { apiUrl: apiUrl.source, token: token.source },
    ...(Object.keys(from).length > 0 && { files: from }),
    ...(key?.apiUrl !== undefined && { keyAddress: key.apiUrl }),
    ...(key !== undefined && { storedKeys: keys }),
  };
}

/** The keys `files` hold, in their order, each with the address beside it. */
function storedKeysOf(files: readonly (ReadConfigFile | undefined)[]): StoredKey[] {
  return files.flatMap((f) => {
    const token = f?.values.token;
    if (f === undefined || token === undefined) return [];
    const apiUrl = f.values.apiUrl;
    return [{ token, ...(apiUrl !== undefined && apiUrl !== '' && { apiUrl }), file: fileRef(f) }];
  });
}

function lastHolding(
  files: readonly (ReadConfigFile | undefined)[],
  field: 'apiUrl' | 'token',
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
    writtenByDev:
      typeof parsed.packServicePort === 'number' || typeof parsed.packServiceToken === 'string',
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

/** `~/.kindgi` holds the API key: this account's only. */
const HOME_DIR_MODE = 0o700;

/**
 * Persist a config file at `~/.kindgi/config.json`. Called by
 * `kindgi auth login`. Merges with any existing file so a partial
 * write does not clobber other keys.
 *
 * The file is `0600` and `~/.kindgi` `0700`, an older looser one
 * included: the new text is a new file that replaces the old one
 * (`writePrivateFile`). A symlinked `config.json` stays a link, and the
 * file it points to is the one replaced.
 * Windows has no such modes: the write there is as before.
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
  const text = `${JSON.stringify(next, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: HOME_DIR_MODE });
  // One made earlier, by hand or by an older CLI, may be looser.
  if (
    process.platform !== 'win32' &&
    ((await stat(dirname(path))).mode & 0o777 & ~HOME_DIR_MODE) !== 0
  ) {
    await chmod(dirname(path), HOME_DIR_MODE);
  }
  await writePrivateFile(path, text);
  return path;
}

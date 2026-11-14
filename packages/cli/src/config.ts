// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isLocalAddress, sameAddress, storedKeyFor } from './api-address.js';
import { homeFolder } from './home.js';
import { makePrivateDir, writePrivateFile } from './private-file.js';
import {
  PROFILE_ENV,
  PROFILE_NAME,
  PROFILE_NAME_RULE,
  type ProfileLogin,
  type ProfileSummary,
  type ReadProfiles,
  heldNames,
  readProfiles,
} from './profiles.js';

/**
 * Resolved configuration used by every command. Precedence at load
 * time is: CLI flag (`--url`, `--token`) > a profile named by `--profile`
 * (its address and key; it beats the env vars) > env var
 * (`KINDGI_API_URL`, `KINDGI_API_TOKEN`), or a profile named by
 * `KINDGI_PROFILE` (never both) > file (`.kindgirc.json` in cwd, then
 * `~/.kindgi/config.json`'s login without a name). A profile skips the
 * folder's `.kindgirc.json`, and its key is reached only by its name. A
 * file may also hold a `project` beside its key: see `keyProject`.
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
   * The project stored beside the key, in the key's own file: an id or a
   * slug, as `--project` takes. A command that names no project goes into
   * it (`kindgi deploy`, and the commands that would take the tenant's
   * default project). Set only when the key came from a file that has one,
   * so a key given with `--token` or `KINDGI_API_TOKEN` has none, and nor
   * does a profile's.
   */
  readonly keyProject?: string;
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
  /**
   * The profile the command goes on (`--profile`, else KINDGI_PROFILE), and
   * whether `~/.kindgi/config.json` holds it usable. Only `kindgi auth
   * login` runs on one it doesn't hold: it saves it.
   */
  readonly profile?: {
    readonly name: string;
    readonly from: 'flag' | 'env';
    readonly held: boolean;
  };
  /** The profiles `~/.kindgi/config.json` holds: names and addresses, never keys. */
  readonly profiles?: readonly ProfileSummary[];
  /**
   * Why the command can't go on the profile it names: main refuses it
   * before the command runs. `kindgi auth login` is exempt from all but
   * `env-pair` and `name`: it saves a profile, and goes by its own rules.
   */
  readonly profileRefusal?: {
    readonly kind: 'name' | 'env-pair' | 'unknown' | 'malformed' | 'other-address';
    readonly message: string;
  };
  /** The env vars `--profile` beat, which aren't read: main says so on stderr. */
  readonly profileBeat?: readonly string[];
  /** This folder's `.kindgirc.json` for a `kindgi dev` runtime, which the profile skipped: main says so. */
  readonly profileSkipped?: string;
}

export type ConfigSource = 'flag' | 'env' | 'file' | 'unset';

/** A key a config file holds, and the address and project stored beside it, if any. */
export interface StoredKey {
  readonly token: string;
  readonly apiUrl?: string;
  readonly project?: string;
  readonly file: ConfigFile;
}

/**
 * A config file: `~/.kindgi/config.json` (`home`, which `kindgi auth
 * login` writes) or this folder's `.kindgirc.json` (`folder`, which
 * `kindgi dev` writes). `profile` names the home file's profile a value
 * came from; without it, the value is the login without a name.
 */
export interface ConfigFile {
  readonly path: string;
  readonly kind: 'home' | 'folder';
  readonly profile?: string;
}

export interface ConfigInputs {
  readonly flagUrl?: string | undefined;
  readonly flagToken?: string | undefined;
  /** `--profile`: its name is checked when it's parsed. */
  readonly flagProfile?: string | undefined;
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
  /** The project for the key beside it: `keyProject`. */
  readonly project?: string;
  /** `kindgi dev` writes these beside its runtime's address and key. */
  readonly packServicePort?: unknown;
  readonly packServiceToken?: unknown;
  /** The home file's profiles (profiles.ts); a folder file's aren't read. */
  readonly profiles?: unknown;
}

/** A config file that was there, and what it holds. */
interface ReadConfigFile extends ConfigFile {
  readonly values: Pick<FileConfig, 'apiUrl' | 'token' | 'project'>;
  /** `kindgi dev` wrote it: it has the pack service's port or token. */
  readonly writtenByDev: boolean;
  /** Its profiles: the home file's only. */
  readonly profiles: ReadProfiles;
}

/** The env vars that name a runtime without a profile. */
const ENV_PAIR = ['KINDGI_API_URL', 'KINDGI_API_TOKEN'] as const;

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
  const home = homeFolder(inputs.home);
  const read = inputs.readFile ?? defaultReadFile;

  // With no home folder there's no home file, rather than one under the current folder.
  const homePath = home === undefined ? undefined : join(home, '.kindgi', 'config.json');
  const homeFile =
    homePath === undefined ? undefined : await readConfigFile(homePath, 'home', read);
  const folderFile = await readConfigFile(join(cwd, '.kindgirc.json'), 'folder', read);
  const named = profileNamed(inputs.flagProfile, env);
  if (named !== undefined) {
    return profileConfig(named, inputs, env, homePath, homeFile, folderFile);
  }
  const summaries = homeFile?.profiles.summaries ?? [];
  const resolve = (files: readonly (ReadConfigFile | undefined)[]) =>
    resolveConfig(inputs.flagUrl, inputs.flagToken, env, files, summaries);

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

/** The profile a command names: `--profile`, else KINDGI_PROFILE; `undefined` for none. */
function profileNamed(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): { readonly name: string; readonly from: 'flag' | 'env' } | undefined {
  if (flag !== undefined && flag !== '') return { name: flag, from: 'flag' };
  const fromEnv = env[PROFILE_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return { name: fromEnv, from: 'env' };
  return undefined;
}

/**
 * The config on a profile: its own address and key, from the home file
 * alone. `--url` and `--token` still win; the env vars don't (`--profile`
 * beats them, and main says so), and KINDGI_PROFILE beside either is
 * refused. This folder's `.kindgirc.json` isn't read. A name the file
 * doesn't hold, or holds malformed, resolves nothing but the flags: main
 * refuses it, except for `kindgi auth login`, which saves it.
 */
function profileConfig(
  named: { readonly name: string; readonly from: 'flag' | 'env' },
  inputs: ConfigInputs,
  env: Readonly<Record<string, string | undefined>>,
  homePath: string | undefined,
  homeFile: ReadConfigFile | undefined,
  folderFile: ReadConfigFile | undefined,
): ResolvedConfig {
  const { name, from } = named;
  const summaries = homeFile?.profiles.summaries ?? [];
  const exported = ENV_PAIR.filter((k) => given(env[k]));
  const held = heldProfile(named, exported, homePath, homeFile?.profiles);
  if ('refusal' in held) {
    const apiUrl = pickWithSource(inputs.flagUrl, undefined, undefined);
    const token = pickWithSource(inputs.flagToken, undefined, undefined);
    return {
      apiUrl: apiUrl.value,
      token: token.value,
      source: { apiUrl: apiUrl.source, token: token.source },
      profile: { name, from, held: false },
      profiles: summaries,
      ...(from === 'flag' && exported.length > 0 && { profileBeat: exported }),
      profileRefusal: held.refusal,
    };
  }
  const { entry, path } = held;
  const by = from === 'flag' ? `--profile ${name}` : `${PROFILE_ENV}=${name}`;
  const file: ConfigFile = { path, kind: 'home', profile: name };
  const apiUrl = pickWithSource(inputs.flagUrl, undefined, entry.apiUrl);
  const token = pickWithSource(inputs.flagToken, undefined, entry.token);
  const stored = token.source === 'file';
  const files = {
    ...(apiUrl.source === 'file' && { apiUrl: file }),
    ...(stored && { token: file }),
  };
  const skipped =
    folderFile !== undefined && pointsAtDevRuntime(folderFile) ? folderFile.path : undefined;
  const config: ResolvedConfig = {
    apiUrl: apiUrl.value,
    token: token.value,
    source: { apiUrl: apiUrl.source, token: token.source },
    ...(Object.keys(files).length > 0 && { files }),
    // Under a profile, the stored keys are that profile's alone.
    ...(stored && {
      keyAddress: entry.apiUrl,
      storedKeys: [{ token: entry.token, apiUrl: entry.apiUrl, file }],
    }),
    profile: { name, from, held: true },
    profiles: summaries,
    ...(from === 'flag' && exported.length > 0 && { profileBeat: exported }),
    ...(skipped !== undefined && { profileSkipped: skipped }),
  };
  const url = inputs.flagUrl;
  if (url !== undefined && url !== '' && !sameAddress(url, entry.apiUrl)) {
    return refusedOn(
      config,
      'other-address',
      `${by}: the profile's key goes only to its own address, ${entry.apiUrl}, and --url names another: ${url}. Leave out --url, or name the profile for ${url}.`,
    );
  }
  return config;
}

type ProfileRefusal = NonNullable<ResolvedConfig['profileRefusal']>;

/**
 * The named profile's entry, or why it can't be used before its address is
 * read: KINDGI_PROFILE isn't a name, or is set beside KINDGI_API_URL or
 * KINDGI_API_TOKEN, or there's no home folder, or the home file holds no
 * usable entry by that name.
 */
function heldProfile(
  named: { readonly name: string; readonly from: 'flag' | 'env' },
  exported: readonly string[],
  homePath: string | undefined,
  profiles: ReadProfiles | undefined,
): { readonly entry: ProfileLogin; readonly path: string } | { readonly refusal: ProfileRefusal } {
  const { name, from } = named;
  if (from === 'env' && !PROFILE_NAME.test(name)) {
    return {
      refusal: {
        kind: 'name',
        message: `${PROFILE_ENV} isn't a profile name: a name is ${PROFILE_NAME_RULE}.`,
      },
    };
  }
  if (from === 'env' && exported.length > 0) {
    return {
      refusal: {
        kind: 'env-pair',
        message:
          exported.length === 1
            ? `${PROFILE_ENV} and ${exported[0]} are both set, and each picks a runtime: unset one, or pass --profile ${name}.`
            : `${PROFILE_ENV}, ${exported.join(' and ')} are all set, and each picks a runtime: unset ${PROFILE_ENV} or the other two, or pass --profile ${name}.`,
      },
    };
  }
  const by = from === 'flag' ? `--profile ${name}` : `${PROFILE_ENV}=${name}`;
  if (homePath === undefined) {
    return {
      refusal: {
        kind: 'unknown',
        message: `${by}: found no home folder for .kindgi/config.json, which holds the profiles, since HOME is empty. Set HOME and run it again.`,
      },
    };
  }
  const entry = profiles?.usable.get(name);
  if (entry !== undefined) return { entry, path: homePath };
  const summaries = profiles?.summaries ?? [];
  // A held entry that isn't usable is a malformed one, or `profiles` itself is.
  const problem = profiles?.malformed ?? summaries.find((p) => p.name === name)?.problem;
  if (problem !== undefined) {
    return {
      refusal: {
        kind: 'malformed',
        message: `${by}: the profile ${name} in ${homePath} can't be used: ${problem}. Save it again with \`kindgi auth login --profile ${name} --url <url> --token-stdin --force\`, or remove it with \`kindgi auth logout --profile ${name}\`.`,
      },
    };
  }
  return {
    refusal: {
      kind: 'unknown',
      message: `${by}: ${homePath} holds no profile named ${name} (it holds ${heldNames(summaries)}). Save one with \`kindgi auth login --profile ${name} --url <url> --token-stdin\`.`,
    },
  };
}

function refusedOn(
  config: ResolvedConfig,
  kind: ProfileRefusal['kind'],
  message: string,
): ResolvedConfig {
  return { ...config, profileRefusal: { kind, message } };
}

function given(value: string | undefined): boolean {
  return value !== undefined && value !== '';
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
  profiles: readonly ProfileSummary[],
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
    ...(key?.project !== undefined && { keyProject: key.project }),
    ...(key !== undefined && { storedKeys: keys }),
    // Never candidates for an address: only named in a refusal (api-address.ts).
    ...(profiles.length > 0 && { profiles }),
  };
}

/** The keys `files` hold, in their order, each with the address and project beside it. */
function storedKeysOf(files: readonly (ReadConfigFile | undefined)[]): StoredKey[] {
  return files.flatMap((f) => {
    const token = f?.values.token;
    if (f === undefined || token === undefined) return [];
    const { apiUrl, project } = f.values;
    return [
      {
        token,
        ...(apiUrl !== undefined && apiUrl !== '' && { apiUrl }),
        ...(project !== undefined && { project }),
        file: fileRef(f),
      },
    ];
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
      ...(typeof parsed.project === 'string' &&
        parsed.project !== '' && { project: parsed.project }),
    },
    writtenByDev:
      typeof parsed.packServicePort === 'number' || typeof parsed.packServiceToken === 'string',
    profiles: readProfiles(kind === 'home' ? parsed.profiles : undefined),
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
 * What `~/.kindgi/config.json` holds now for one login, the one without a
 * name or a profile: its path, and its address, key and project, each when
 * there. A profile holds no project.
 */
export interface HomeLogin {
  readonly path: string;
  readonly apiUrl?: string;
  readonly token?: string;
  /** For the login without a name: the project stored beside its key. */
  readonly project?: string;
  /** For a profile: the file holds an entry by that name, usable or not. */
  readonly held?: boolean;
  /** For a profile: why its entry (or `profiles` itself) can't be used. */
  readonly problem?: string;
  /**
   * For a profile: why `profiles` itself can't be read. Then the file
   * holds every name (`held`), and a logout removes all of `profiles`.
   */
  readonly profilesProblem?: string;
}

/**
 * Read `~/.kindgi/config.json` as it is now, as `kindgi auth login` finds
 * it before a save: the login without a name, or `profile`'s.
 */
export async function readHomeLogin(home?: string, profile?: string): Promise<HomeLogin> {
  const path = homeConfigPath(home);
  const raw = await defaultReadFile(path);
  const parsed = raw === null ? {} : parseJson(raw, path);
  if (profile === undefined) {
    return {
      path,
      ...(typeof parsed.apiUrl === 'string' && parsed.apiUrl !== '' && { apiUrl: parsed.apiUrl }),
      ...(typeof parsed.token === 'string' && parsed.token !== '' && { token: parsed.token }),
      ...(typeof parsed.project === 'string' &&
        parsed.project !== '' && { project: parsed.project }),
    };
  }
  const profiles = readProfiles(parsed.profiles);
  const entry = profiles.summaries.find((p) => p.name === profile);
  const login = profiles.usable.get(profile);
  const problem = profiles.malformed ?? entry?.problem;
  return {
    path,
    held: entry !== undefined || profiles.malformed !== undefined,
    ...(entry?.apiUrl !== undefined && { apiUrl: entry.apiUrl }),
    ...(login !== undefined && { token: login.token }),
    ...(problem !== undefined && { problem }),
    ...(profiles.malformed !== undefined && { profilesProblem: profiles.malformed }),
  };
}

/** A login as `kindgi auth list` shows it: never its key. */
export interface ListedLogin {
  /** The profile's name; `null` for the login without a name. */
  readonly profile: string | null;
  readonly apiUrl: string | null;
  readonly file: string;
  readonly usable: boolean;
  /** Why it can't be used; set only when it can't. */
  readonly problem?: string;
}

/**
 * Every login `~/.kindgi/config.json` holds, for `kindgi auth list`: the
 * one without a name (when it holds an address or a key), then each
 * profile in the file's order. Never a key. `problem` says why
 * `profiles` itself can't be read.
 */
export async function listHomeLogins(home?: string): Promise<{
  readonly path: string;
  readonly logins: readonly ListedLogin[];
  readonly problem?: string;
}> {
  const path = homeConfigPath(home);
  const raw = await defaultReadFile(path);
  const parsed = raw === null ? {} : parseJson(raw, path);
  const apiUrl = typeof parsed.apiUrl === 'string' && parsed.apiUrl !== '' ? parsed.apiUrl : null;
  const hasKey = typeof parsed.token === 'string' && parsed.token !== '';
  const unnamedProblem =
    apiUrl === null ? 'it has no apiUrl' : hasKey ? undefined : 'it has no token';
  const unnamed: ListedLogin[] =
    apiUrl === null && !hasKey
      ? []
      : [
          {
            profile: null,
            apiUrl,
            file: path,
            usable: unnamedProblem === undefined,
            ...(unnamedProblem !== undefined && { problem: unnamedProblem }),
          },
        ];
  const profiles = readProfiles(parsed.profiles);
  const named = profiles.summaries.map(
    (p): ListedLogin => ({
      profile: p.name,
      apiUrl: p.apiUrl ?? null,
      file: path,
      usable: p.problem === undefined,
      ...(p.problem !== undefined && { problem: p.problem }),
    }),
  );
  return {
    path,
    logins: [...unnamed, ...named],
    ...(profiles.malformed !== undefined && { problem: profiles.malformed }),
  };
}

/**
 * Whether a file's `project` stays when `patch` is saved over it: it's the
 * project for the key beside it, so a new key or address drops it.
 */
export function keepsProject(
  file: Pick<FileConfig, 'apiUrl' | 'token'>,
  patch: Pick<FileConfig, 'apiUrl' | 'token'>,
): boolean {
  return (
    (patch.token === undefined || patch.token === file.token) &&
    (patch.apiUrl === undefined ||
      (file.apiUrl !== undefined && sameAddress(patch.apiUrl, file.apiUrl)))
  );
}

/** `~/.kindgi/config.json`, which a login needs a home folder for. */
function homeConfigPath(home: string | undefined): string {
  const folder = homeFolder(home);
  if (folder === undefined) {
    throw new Error(
      'Found no home folder for .kindgi/config.json, since HOME is empty. Set HOME and run it again.',
    );
  }
  return join(folder, '.kindgi', 'config.json');
}

/**
 * Persist a config file at `~/.kindgi/config.json`. Called by
 * `kindgi auth login`. Merges with any existing file so a partial
 * write does not clobber other keys. A `project` stays only when the
 * key and address do (`keepsProject`).
 *
 * The file is `0600` and `~/.kindgi` `0700`, an older looser one
 * included: the new text is a new file that replaces the old one
 * (`writePrivateFile`). A symlinked `config.json` stays a link, and the
 * file it points to is the one replaced.
 * Windows has no such modes: the write there is as before.
 */
export async function saveHomeConfig(patch: FileConfig, home?: string): Promise<string> {
  return rewriteHomeConfig((base) => {
    const { project: _dropped, ...withoutProject } = base;
    return { ...(keepsProject(base, patch) ? base : withoutProject), ...patch };
  }, home);
}

/**
 * Save `profile`'s login in `~/.kindgi/config.json`'s `profiles`, beside
 * the others and the login without a name, which stay as they are. A
 * `profiles` that isn't an object is replaced (`kindgi auth login`
 * replaces it only with --force).
 */
export async function saveHomeProfile(
  profile: string,
  login: { readonly apiUrl: string; readonly token: string },
  home?: string,
): Promise<string> {
  return rewriteHomeConfig(
    (base) => ({ ...base, profiles: { ...profilesObject(base.profiles), [profile]: login } }),
    home,
  );
}

/**
 * Remove a login from `~/.kindgi/config.json`: `profile`'s, or the one
 * without a name (its `apiUrl` and `token`, and the `project` stored
 * beside them). Everything else stays; an empty `profiles` goes. The file
 * stays `0600`.
 */
export async function removeHomeLogin(profile: string | undefined, home?: string): Promise<string> {
  return rewriteHomeConfig((base) => {
    if (profile === undefined) {
      const { apiUrl: _apiUrl, token: _token, project: _project, ...rest } = base;
      return rest;
    }
    const { [profile]: _gone, ...others } = profilesObject(base.profiles);
    const { profiles: _profiles, ...rest } = base;
    return Object.keys(others).length === 0 ? rest : { ...rest, profiles: others };
  }, home);
}

function profilesObject(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

async function rewriteHomeConfig(
  change: (base: FileConfig) => FileConfig,
  home: string | undefined,
): Promise<string> {
  const path = homeConfigPath(home);
  const existing = await defaultReadFile(path);
  const base = existing === null ? {} : (JSON.parse(existing) as FileConfig);
  const next = change(base);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  // `~/.kindgi` holds the API key: this account's only.
  await makePrivateDir(dirname(path));
  await writePrivateFile(path, text);
  return path;
}

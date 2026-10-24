// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where the CLI may send its API key. A stored key (`kindgi auth login`'s
 * ~/.kindgi/config.json, or `kindgi dev`'s .kindgirc.json) is for the
 * address stored beside it, and goes only there. The key for an address
 * is the one stored with it (`storedKeyFor`); when none is,
 * the command is refused before it sends anything, naming both addresses
 * and the file, wherever the address is named (`--url`, KINDGI_API_URL, a
 * folder's .kindgirc.json, an env block's `endpoint`, `--endpoint`). A
 * key given for the command (`--token`, KINDGI_API_TOKEN) goes where the
 * command says.
 *
 * - **Every command** that sends the key to the CLI's own address
 *   (`ctx.client()`, `ctx.token()`): `ownAddressKeyRefusal`.
 *
 * - **Hosted** (`--hosted`, or the env block's `build: 'hosted'` for the
 *   env the command acts in: `hostedScope`), on every command: the API
 *   is the CLI's own address (`--url`, KINDGI_API_URL or the stored one),
 *   whatever key it goes with. An address named elsewhere may only repeat
 *   it, and with no own address there's nothing to go to. A folder's
 *   .kindgirc.json for a `kindgi dev` runtime (`kindgi dev` wrote it, or
 *   it's at a loopback address) isn't read, address or key: a dev
 *   runtime is never a hosted target. A command that isn't hosted and
 *   goes to that runtime says so first when another address is in reach
 *   (`devRuntimeHint`).
 * - **A deploy to a runtime of your own:** `--endpoint`, else the env
 *   block's `endpoint`, else the CLI's own address. A key given for the
 *   command (`--token`, or an exported KINDGI_API_TOKEN) may go to any of
 *   them; a stored key only to its own address.
 */

import type { ResolvedConfig, StoredKey } from './config.js';

/**
 * The stored key for `url`: the one the files' order picks (this folder's
 * over the home one) when it's for `url`, else the one stored for `url`
 * in another file, else the picked one, which then can't go to `url`. A
 * key with no address beside it is never passed over: nothing says which
 * address it's for, so it's refused wherever it would go, never swapped.
 */
export function storedKeyFor(
  keys: readonly StoredKey[],
  url: string | undefined,
): StoredKey | undefined {
  const picked = keys.at(-1);
  if (picked?.apiUrl === undefined || url === undefined || sameAddress(picked.apiUrl, url)) {
    return picked;
  }
  return keys.findLast((k) => k.apiUrl !== undefined && sameAddress(k.apiUrl, url)) ?? picked;
}

/**
 * `config` with the stored key for `url` (`storedKeyFor`) as its key: for
 * a command that goes to another address than the CLI's own (`kindgi
 * deploy --endpoint`). A key given for the command stays as it is.
 */
export function keyedFor(config: ResolvedConfig, url: string): ResolvedConfig {
  if (config.source.token !== 'file' || config.storedKeys === undefined) return config;
  const key = storedKeyFor(config.storedKeys, url);
  if (key === undefined) return config;
  const { keyAddress: _old, ...rest } = config;
  return {
    ...rest,
    token: key.token,
    files: { ...config.files, token: key.file },
    ...(key.apiUrl !== undefined && { keyAddress: key.apiUrl }),
  };
}

/** An address a command was given, and where (`--endpoint`, `environments.prod.endpoint`). */
export interface NamedAddress {
  readonly url: string | undefined;
  readonly where: string;
}

/** The address a command goes to, and the config it goes on with: its key is `config.token`. */
export type ApiAddress =
  | { readonly kind: 'ok'; readonly url: string; readonly config: ResolvedConfig }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * A hosted build's or deploy's API: the CLI's own address, without a
 * folder's .kindgirc.json for a `kindgi dev` runtime. `named` may only
 * repeat it. `command` names the command in the refusal.
 */
export function hostedApiAddress(
  command: string,
  config: ResolvedConfig,
  named: readonly NamedAddress[],
): ApiAddress {
  const hosted = config.devRuntime?.without ?? config;
  const own = hosted.apiUrl;
  if (own === undefined || own === '') return refused(hostedNoAddress(command, config));
  const keyElsewhere = storedKeyRefusal(command, hosted, own, ownWhere(hosted), false);
  if (keyElsewhere !== undefined) return refused(keyElsewhere);
  const other = named.find((n) => given(n.url) && !sameAddress(n.url as string, own));
  if (other !== undefined) {
    return refused(
      `${command} sends your API key to ${own}, the address it's for (${ownSource(hosted)}), ` +
        `and ${other.where} names another: ${other.url}. The key goes only to its own address: ` +
        `remove ${other.where} (Kindgi Cloud needs none), or ${signIn(other.url as string)}.`,
    );
  }
  return { kind: 'ok', url: own, config: hosted };
}

/**
 * Why a hosted command has nowhere to go: no own address is set, and a
 * folder's .kindgirc.json for a `kindgi dev` runtime, if there's one,
 * isn't read.
 */
export function hostedNoAddress(command: string, config: ResolvedConfig): string {
  const dev = config.devRuntime;
  const at = dev?.apiUrl === undefined ? '' : ` (${dev.apiUrl})`;
  const unread =
    dev === undefined
      ? ''
      : ` ${dev.file} points this folder at a \`kindgi dev\` runtime${at}, which isn't a hosted target, so ${command} doesn't read it.`;
  return `${command} goes to the API your key is for, and no API address is set.${unread} Run \`kindgi auth login --url <url> --token <its key>\`, export KINDGI_API_URL, or pass --url <url>.`;
}

/** Whether a command is hosted, and the config it goes on with. */
export interface HostedScope {
  /** `--hosted`, or the env the command acts in has `build: 'hosted'`. */
  readonly hosted: boolean;
  /** The config, without a `kindgi dev` runtime's .kindgirc.json when hosted (`hostedConfig`). */
  readonly config: ResolvedConfig;
}

export interface HostedScopeInputs {
  readonly config: ResolvedConfig;
  /** `--hosted`. */
  readonly flag: boolean;
  /** The env the command acts in (`--env`, else its default); `undefined` when none applies. */
  readonly envName: string | undefined;
  /**
   * Read the env block whether or not a `kindgi dev` runtime's
   * .kindgirc.json is here: for a command whose run hosted changes, not
   * only its address (`kindgi build`, `kindgi deploy`).
   */
  readonly always: boolean;
  /** Whether the pack's env block says `build: 'hosted'`; `false` with no pack config, or a broken one. */
  readonly envIsHosted: (envName: string) => Promise<boolean>;
}

/**
 * The one hosted rule, for every command: `--hosted`, or the env the
 * command acts in has `build: 'hosted'`. Hosted, the command goes on the
 * config without a `kindgi dev` runtime's .kindgirc.json. Elsewhere the
 * env block can only change the address when such a file is here, so it's
 * read only then, unless `always`.
 */
export async function hostedScope(inputs: HostedScopeInputs): Promise<HostedScope> {
  const { config, envName } = inputs;
  const hosted =
    inputs.flag ||
    (envName !== undefined &&
      (inputs.always || config.devRuntime !== undefined) &&
      (await inputs.envIsHosted(envName)));
  return { hosted, config: hosted ? hostedConfig(config) : config };
}

/**
 * The config a hosted command goes on with: the one resolved without a
 * `kindgi dev` runtime's .kindgirc.json (`devRuntime.without`), the file
 * still known, so `ctx.config`, `ctx.client()` and `ctx.token()` agree.
 */
export function hostedConfig(config: ResolvedConfig): ResolvedConfig {
  const dev = config.devRuntime;
  return dev === undefined ? config : { ...dev.without, devRuntime: dev };
}

/**
 * The line a command that isn't hosted prints first when it sends a key
 * to the `kindgi dev` runtime this folder's .kindgirc.json names, and
 * another address is in reach: a stored sign-in for another address
 * (`--hosted` goes there), or a key given for the command (its own
 * address needs naming). `undefined` when the address was named for the
 * command (`--url`, KINDGI_API_URL), or nothing else is in reach.
 */
export function devRuntimeHint(command: string, config: ResolvedConfig): string | undefined {
  const dev = config.devRuntime;
  const url = config.apiUrl;
  if (dev === undefined || url === undefined || config.files?.apiUrl?.path !== dev.file) {
    return undefined;
  }
  const goes = `${command} goes to the kindgi dev runtime at ${url} (${dev.file} says so).`;
  const other = dev.without.apiUrl;
  if (given(other) && !sameAddress(other as string, url)) {
    return `${goes} For ${other}, pass --hosted.\n`;
  }
  if (config.source.token === 'flag' || config.source.token === 'env') {
    return `${goes} To send it to the address your key is for, pass --url <that address> or export KINDGI_API_URL.\n`;
  }
  return undefined;
}

/**
 * A deploy's API: the first of `named` that's given, else the CLI's own
 * address; `undefined` when there's none. A stored key goes only to the
 * address stored with it; a key given for the command goes where the
 * command says. `command` names the command in the refusal (`kindgi
 * promote` goes where a deploy does).
 */
export function deployApiAddress(
  config: ResolvedConfig,
  named: readonly NamedAddress[],
  command = 'kindgi deploy',
): ApiAddress | undefined {
  const chosen = named.find((n) => given(n.url));
  const url = chosen?.url ?? config.apiUrl;
  if (url === undefined || url === '') return undefined;
  const keyed = keyedFor(config, url);
  const keyElsewhere = storedKeyRefusal(
    command,
    keyed,
    url,
    chosen?.where ?? ownWhere(config),
    true,
  );
  return keyElsewhere !== undefined ? refused(keyElsewhere) : { kind: 'ok', url, config: keyed };
}

/**
 * Why a command that sends the API key to the CLI's own address can't:
 * the stored key isn't for it. `undefined` when it can, or when there's
 * no address or no key (which the command says itself).
 */
export function ownAddressKeyRefusal(command: string, config: ResolvedConfig): string | undefined {
  const url = config.apiUrl;
  if (url === undefined || url === '') return undefined;
  return storedKeyRefusal(command, config, url, ownWhere(config), true);
}

/** What `ownAddressKeyRefusal` finds, in parts: for `kindgi doctor`'s check. */
export interface KeyElsewhere {
  /** "the API key stored in …, which is for …, to …, which … names". */
  readonly sends: string;
  /** What else is stored, and that none is for the address: "" or a sentence and a space. */
  readonly stored: string;
  /** "The key goes only to its own address: …, or …." */
  readonly fix: string;
}

/** The stored key can't go to the CLI's own address: why, in parts (`KeyElsewhere`). */
export function ownAddressKeyElsewhere(config: ResolvedConfig): KeyElsewhere | undefined {
  const url = config.apiUrl;
  if (url === undefined || url === '') return undefined;
  return keyElsewhere(config, url, ownWhere(config), true);
}

/**
 * Why a stored key can't go to `url` (named by `where`): it's for another
 * address, or no address is stored with it. `undefined` when the key
 * wasn't stored (`--token`, KINDGI_API_TOKEN) or is for `url`.
 * `keyForCommand` offers `--token`/KINDGI_API_TOKEN as a fix (a plain
 * deploy's; a hosted command's address is the CLI's own whatever the key).
 */
function storedKeyRefusal(
  command: string,
  config: ResolvedConfig,
  url: string,
  where: string,
  keyForCommand: boolean,
): string | undefined {
  const found = keyElsewhere(config, url, where, keyForCommand);
  if (found === undefined) return undefined;
  return `${command} would send ${found.sends}. ${found.stored}${found.fix}`;
}

function keyElsewhere(
  config: ResolvedConfig,
  url: string,
  where: string,
  keyForCommand: boolean,
): KeyElsewhere | undefined {
  if (config.source.token !== 'file') return undefined;
  const keyAddress = config.keyAddress;
  if (keyAddress !== undefined && sameAddress(url, keyAddress)) return undefined;
  const keyFile = config.files?.token;
  const stored =
    keyFile === undefined ? 'the API key stored' : `the API key stored in ${keyFile.path}`;
  const giveKey = keyForCommand ? ["give that server's key with --token or KINDGI_API_TOKEN"] : [];
  if (keyAddress === undefined) {
    const addAddress = `add "apiUrl": "${url}" beside it in ${keyFile?.path ?? 'its file'}, if it's that server's key`;
    return {
      sends: `${stored} to ${url}, and no address is stored with that key, so nothing shows it's for ${url}`,
      stored: '',
      fix: ownAddressOnly([addAddress, signIn(url), ...giveKey]),
    };
  }
  return {
    sends: `${stored}, which is for ${keyAddress}, to ${url}, which ${where} names`,
    stored: otherKeys(config, url),
    fix: ownAddressOnly([`point ${where} at ${keyAddress}`, signIn(url), ...giveKey]),
  };
}

/**
 * How to sign in to `url`. `kindgi auth login` keeps the key with its
 * address in the home file, where it's found by that address from any
 * folder; it saves only a key it's given (auth.ts), never a stored one for
 * another address, so the hint always gives one.
 */
function signIn(url: string): string {
  return `sign in to ${url} with \`kindgi auth login --url ${url} --token <its key>\``;
}

function ownAddressOnly(fixes: readonly string[]): string {
  return `The key goes only to its own address: ${oneOf(fixes)}.`;
}

/**
 * The other stored keys, and that none is for `url`: "" when the key is
 * the only one. In a folder where `kindgi dev` ran, its .kindgirc.json is
 * read over the home sign-in, so this says where each key is for.
 */
function otherKeys(config: ResolvedConfig, url: string): string {
  const keyFile = config.files?.token;
  const others = (config.storedKeys ?? []).filter((k) => k.file.path !== keyFile?.path);
  if (others.length === 0) return '';
  const each = others.map((k) =>
    k.apiUrl === undefined
      ? `${k.file.path} has one with no address`
      : `${k.file.path} has one for ${k.apiUrl}`,
  );
  return `${each.join(', and ')}, and none is stored for ${url}. `;
}

/**
 * One address, however it's written: the scheme, the host (any case; the
 * loopback names localhost, 127.0.0.1 and ::1 are one), the port (a
 * scheme's default left out) and the path (without a trailing slash).
 */
export function sameAddress(a: string, b: string): boolean {
  return addressKey(a) === addressKey(b);
}

/** An address on this machine: a loopback name (localhost, 127.0.0.1, ::1). */
export function isLocalAddress(raw: string): boolean {
  try {
    return LOOPBACK.has(new URL(raw.trim()).hostname);
  } catch {
    return false;
  }
}

function addressKey(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
  const host = LOOPBACK.has(url.hostname) ? 'loopback' : url.hostname;
  return `${url.protocol}//${host}:${url.port}${url.pathname.replace(/\/+$/, '')}`;
}

/** The loopback names, as `URL` gives a hostname. */
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Where the CLI's own address came from, in words. */
function ownSource(config: ResolvedConfig): string {
  switch (config.source.apiUrl) {
    case 'flag':
      return 'from --url';
    case 'env':
      return 'from KINDGI_API_URL';
    default:
      return config.files?.apiUrl !== undefined
        ? `from ${config.files.apiUrl.path}`
        : 'from the stored config';
  }
}

/** What names the CLI's own address, to point it elsewhere. */
function ownWhere(config: ResolvedConfig): string {
  switch (config.source.apiUrl) {
    case 'flag':
      return '--url';
    case 'env':
      return 'KINDGI_API_URL';
    default:
      return config.files?.apiUrl !== undefined
        ? `the apiUrl in ${config.files.apiUrl.path}`
        : 'the stored apiUrl';
  }
}

/** `a`, `a, or b`, `a, b, or c`. */
function oneOf(choices: readonly string[]): string {
  if (choices.length < 2) return choices.join('');
  return `${choices.slice(0, -1).join(', ')}, or ${choices[choices.length - 1]}`;
}

function given(url: string | undefined): boolean {
  return url !== undefined && url !== '';
}

function refused(message: string): ApiAddress {
  return { kind: 'refused', message };
}

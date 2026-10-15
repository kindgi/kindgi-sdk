// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where `kindgi deploy` and `kindgi build --hosted` may send the CLI's API
 * key. A stored key (`kindgi auth login`'s ~/.kindgi/config.json, or
 * `kindgi dev`'s .kindgirc.json) is for the address stored beside it, and
 * goes only there: another address, wherever it's named (`--url`,
 * KINDGI_API_URL, a folder's .kindgirc.json, an env block's `endpoint`,
 * `--endpoint`), is refused, naming both, never picked silently.
 *
 * - **Hosted** (`--hosted`, or the env block's `build: 'hosted'`): the API
 *   is the CLI's own address (`--url`, KINDGI_API_URL or the stored one),
 *   whatever key it goes with. An address named elsewhere may only repeat
 *   it, and with no own address there's nothing to build at. A folder's
 *   .kindgirc.json that points at a local runtime (`kindgi dev`'s) isn't
 *   read, address or key: a local runtime is never a hosted target.
 * - **A deploy to a runtime of your own:** `--endpoint`, else the env
 *   block's `endpoint`, else the CLI's own address. A key given for the
 *   command (`--token`, or an exported KINDGI_API_TOKEN) may go to any of
 *   them; a stored key only to its own address.
 */

import type { ResolvedConfig } from './config.js';

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
 * folder's .kindgirc.json that points at a local runtime. `named` may only
 * repeat it. `command` names the command in the refusal.
 */
export function hostedApiAddress(
  command: string,
  config: ResolvedConfig,
  named: readonly NamedAddress[],
): ApiAddress {
  const hosted = config.localRuntime?.without ?? config;
  const own = hosted.apiUrl;
  if (own === undefined || own === '') {
    const local = config.localRuntime;
    const unread =
      local === undefined
        ? ''
        : ` ${local.file} points at a local runtime (${local.apiUrl}), which isn't a hosted target, so ${command} doesn't read it.`;
    return refused(
      `${command} goes to the API your key is for, and no API address is set.${unread} Run \`kindgi auth login --url <url>\`, export KINDGI_API_URL, or pass --url <url>.`,
    );
  }
  const keyElsewhere = storedKeyRefusal(command, hosted, own, ownWhere(hosted), false);
  if (keyElsewhere !== undefined) return refused(keyElsewhere);
  const other = named.find((n) => given(n.url) && !sameAddress(n.url as string, own));
  if (other !== undefined) {
    return refused(
      `${command} sends your API key to ${own}, the address it's for (${ownSource(hosted)}), ` +
        `and ${other.where} names another: ${other.url}. The key goes only to its own address: ` +
        `remove ${other.where} (Kindgi Cloud needs none), or sign in to ${other.url} with ` +
        `\`kindgi auth login --url ${other.url}\`.`,
    );
  }
  return { kind: 'ok', url: own, config: hosted };
}

/**
 * A deploy's API: the first of `named` that's given, else the CLI's own
 * address; `undefined` when there's none. A stored key goes only to the
 * address stored with it; a key given for the command goes where the
 * command says.
 */
export function deployApiAddress(
  config: ResolvedConfig,
  named: readonly NamedAddress[],
): ApiAddress | undefined {
  const chosen = named.find((n) => given(n.url));
  const url = chosen?.url ?? config.apiUrl;
  if (url === undefined || url === '') return undefined;
  const keyElsewhere = storedKeyRefusal(
    'kindgi deploy',
    config,
    url,
    chosen?.where ?? ownWhere(config),
    true,
  );
  return keyElsewhere !== undefined ? refused(keyElsewhere) : { kind: 'ok', url, config };
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
  if (config.source.token !== 'file') return undefined;
  const keyFile = config.files?.token;
  const stored = keyFile === undefined ? 'stored' : `stored in ${keyFile.path}`;
  // `kindgi auth login` writes the home file; a folder's file stays over it.
  const signIn = keyFile?.kind !== 'folder';
  const giveKey = keyForCommand ? ["give that server's key with --token or KINDGI_API_TOKEN"] : [];
  const keyAddress = config.keyAddress;
  if (keyAddress === undefined) {
    const store = signIn
      ? `sign in to ${url} with \`kindgi auth login --url ${url}\`, which stores the address with the key`
      : `add the key's address to ${keyFile?.path} as its apiUrl`;
    return `${command} would send the API key ${stored} to ${url}, and no address is stored with that key, so nothing shows it's for ${url}. The key goes only to its own address: ${oneOf([store, ...giveKey])}.`;
  }
  if (sameAddress(url, keyAddress)) return undefined;
  const fixes = [
    `point ${where} at ${keyAddress}`,
    ...(signIn ? [`sign in to ${url} with \`kindgi auth login --url ${url}\``] : []),
    ...giveKey,
  ];
  return `${command} would send the API key ${stored}, which is for ${keyAddress}, to ${url}, which ${where} names. The key goes only to its own address: ${oneOf(fixes)}.`;
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

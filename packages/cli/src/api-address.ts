// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where `kindgi deploy` and `kindgi build --hosted` may send the CLI's API
 * key. The key the CLI has stored (`kindgi auth login`, or `kindgi dev`'s
 * `.kindgirc.json`) is for the CLI's own API address, and goes only
 * there: an address named elsewhere (an env block's `endpoint`,
 * `--endpoint`) that differs is refused, naming both, never picked
 * silently.
 *
 * - **Hosted** (`--hosted`, or the env block's `build: 'hosted'`): the API
 *   is the CLI's own address (`--url`, KINDGI_API_URL or the stored one),
 *   whatever key it goes with. An address named elsewhere may only repeat
 *   it, and with no own address there's nothing to build at.
 * - **A deploy to a runtime of your own:** `--endpoint`, else the env
 *   block's `endpoint`, else the CLI's own address. A key given for the
 *   command (`--token`, or an exported KINDGI_API_TOKEN) may go to any of
 *   them; the stored key only to its own address.
 */

import type { ResolvedConfig } from './config.js';

/** An address a command was given, and where (`--endpoint`, `environments.prod.endpoint`). */
export interface NamedAddress {
  readonly url: string | undefined;
  readonly where: string;
}

export type ApiAddress =
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * A hosted build's or deploy's API: the CLI's own address. `named` may
 * only repeat it. `command` names the command in the refusal.
 */
export function hostedApiAddress(
  command: string,
  config: ResolvedConfig,
  named: readonly NamedAddress[],
): ApiAddress {
  const own = config.apiUrl;
  if (own === undefined || own === '') {
    return refused(
      `${command} goes to the API your key is for, and no API address is set. Run \`kindgi auth login --url <url>\`, export KINDGI_API_URL, or pass --url <url>.`,
    );
  }
  const other = named.find((n) => given(n.url) && !sameAddress(n.url as string, own));
  if (other !== undefined) {
    return refused(
      `${command} sends your API key to ${own}, the address it's for (${ownSource(config)}), ` +
        `and ${other.where} names another: ${other.url}. The key goes only to its own address: ` +
        `remove ${other.where} (Kindgi Cloud needs none), or sign in to ${other.url} with ` +
        `\`kindgi auth login --url ${other.url}\`.`,
    );
  }
  return { kind: 'ok', url: own };
}

/**
 * A deploy's API: the first of `named` that's given, else the CLI's own
 * address; `undefined` when there's none. The stored key goes only to its
 * own address; a key given for the command goes where the command says.
 */
export function deployApiAddress(
  config: ResolvedConfig,
  named: readonly NamedAddress[],
): ApiAddress | undefined {
  const own = config.apiUrl;
  const chosen = named.find((n) => given(n.url));
  if (chosen === undefined) return given(own) ? { kind: 'ok', url: own as string } : undefined;
  const url = chosen.url as string;
  const storedKey = config.source.token === 'file';
  if (!storedKey || !given(own) || sameAddress(url, own as string)) {
    return { kind: 'ok', url };
  }
  return refused(
    `kindgi deploy would send your stored API key, which is for ${own} (${ownSource(config)}), to ${url}, which ${chosen.where} names. The key goes only to its own address: point ${chosen.where} at ${own}, sign in to ${url} with \`kindgi auth login --url ${url}\`, or give that server's key with --token or KINDGI_API_TOKEN.`,
  );
}

/**
 * One address, however it's written: the scheme, the host (any case; the
 * loopback names localhost, 127.0.0.1 and ::1 are one), the port (a
 * scheme's default left out) and the path (without a trailing slash).
 */
export function sameAddress(a: string, b: string): boolean {
  return addressKey(a) === addressKey(b);
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
      return "from `kindgi auth login`, or `kindgi dev`'s .kindgirc.json";
  }
}

function given(url: string | undefined): boolean {
  return url !== undefined && url !== '';
}

function refused(message: string): ApiAddress {
  return { kind: 'refused', message };
}

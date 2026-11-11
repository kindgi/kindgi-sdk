// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The key files for connections' token sets under `kindgi dev`: one pair
 * for each dev database, in `~/.kindgi/dev/connections/<database>/`, made
 * once and kept. The runtime encrypts each connection's token set in that
 * database under the pair, so the pair lives as long as the data: `--reset`
 * of the bundled database removes it, and a database the developer names
 * keeps it. Each key is 32 random bytes, owner-only (`0600`), in an
 * owner-only folder (`0700`), and is never printed. The folder is outside
 * the pack, where the pack's code can't read it (the dev sandbox closes the
 * home folder).
 *
 * `ports.json` beside them lists the API ports whose redirect URI the
 * developer has been told to add to their apps, so that line shows once
 * for each port.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { makePrivateDir, writePrivateFile } from '../private-file.js';

/** What the runtime reads: exactly this many bytes (its secrets key files). */
const KEY_BYTES = 32;
const KEY_MODE = 0o600;

const LOCAL_KEY = 'local.key';
const AAD_KEY = 'aad.key';
const PORTS = 'ports.json';

export interface ConnectionKeys {
  /** The folder that holds the pair and the ports list. */
  readonly folder: string;
  readonly localKeyPath: string;
  readonly aadKeyPath: string;
  /** True when this call made a key: a new database, or one after `--reset`. */
  readonly made: boolean;
}

/** The pair `kindgi dev` gives the runtime, or why there's none: connections are off then. */
export type DevConnectionKeys =
  | { readonly kind: 'on'; readonly keys: ConnectionKeys }
  | { readonly kind: 'off'; readonly reason: string };

/** `~/.kindgi/dev/connections`. */
export function connectionKeysRoot(home: string): string {
  return join(home, '.kindgi', 'dev', 'connections');
}

/**
 * The pair for `database` under `home` (`homeFolder`'s answer), made on
 * its first start and kept; or why there's none.
 */
export async function devConnectionKeys(
  home: string | undefined,
  database: { readonly bundled: string } | { readonly url: string },
): Promise<DevConnectionKeys> {
  if (home === undefined) {
    return { kind: 'off', reason: "there's no home folder to keep their keys in (HOME is empty)" };
  }
  const id = connectionDatabaseId(database);
  if (id === undefined) {
    return {
      kind: 'off',
      reason: "the database's name or URL couldn't name a folder for their keys",
    };
  }
  try {
    return { kind: 'on', keys: await connectionKeys(home, id) };
  } catch (err) {
    return { kind: 'off', reason: (err as Error).message };
  }
}

/** `--reset` of bundled database `name`: its pair goes with the token sets stored under it. */
export async function removeDevConnectionKeys(
  home: string | undefined,
  name: string,
): Promise<boolean> {
  const id = connectionDatabaseId({ bundled: name });
  if (home === undefined || id === undefined) return false;
  return removeConnectionKeys(home, id);
}

/**
 * Where a provider sends the developer back to after they sign in: the
 * runtime's `<public URL>/console/connect/callback`.
 */
export function connectRedirectUri(baseUrl: string): string {
  return `${baseUrl}/console/connect/callback`;
}

/** The runtime's words when it won't start because stored secrets were kept under another key. */
const CHANGED_KEY = /The secrets' (local|AAD) key changed/;

/**
 * What to add when the runtime refused to start because this database's
 * token sets were stored under another key than the one `kindgi dev` gave
 * it. The runtime's own words name its settings, which `kindgi dev` set, so
 * these name the key file and the ways out. `bundled`: the database is the
 * bundled Postgres's, which `--reset` can drop. Empty otherwise, and when
 * connections had no pair.
 */
export function changedKeyHint(
  message: string,
  keys: DevConnectionKeys | undefined,
  bundled: boolean,
): string {
  if (keys?.kind !== 'on') return '';
  const which = CHANGED_KEY.exec(message)?.[1];
  if (which === undefined) return '';
  const file = which === 'local' ? keys.keys.localKeyPath : keys.keys.aadKeyPath;
  const lost = keys.keys.made
    ? " It was made at this start: the one they were stored under isn't there."
    : '';
  const over = bundled
    ? '`kindgi dev --reset` drops this database and starts it over with a new pair'
    : 'for a database you named, point kindgi dev at a new one (it never drops yours)';
  return `\nkindgi dev keeps this database's connection keys in ${keys.keys.folder}, and ${file} isn't the key its token sets were stored under.${lost} Put back the key files they were stored under. Or start connections over: ${over}, then connect each connection again.`;
}

/**
 * The folder name for a database's pair. The bundled Postgres's databases
 * have names of their own (`kindgi_<project>`), which are safe folder
 * names. A database the developer names is known by its host, port and
 * database name, hashed: never its user or password, since the same
 * database reached as another user holds the same data. `undefined` when
 * the name or the URL isn't one.
 */
export function connectionDatabaseId(
  database: { readonly bundled: string } | { readonly url: string },
): string | undefined {
  if ('bundled' in database) {
    return /^[a-z0-9_]+$/.test(database.bundled) ? database.bundled : undefined;
  }
  try {
    const url = new URL(database.url);
    // A socket: `postgres:///db?host=/var/run/postgresql`.
    const host = (url.hostname || url.searchParams.get('host') || 'localhost').toLowerCase();
    const port = url.port || '5432';
    // Postgres's default database is the user's name.
    const name =
      decodeURIComponent(url.pathname.replace(/^\//, '')) || decodeURIComponent(url.username);
    const where = `${host}:${port}/${name}`;
    return `url-${createHash('sha256').update(where).digest('hex').slice(0, 16)}`;
  } catch {
    return undefined;
  }
}

/**
 * The pair for database `id`, made when it isn't there. A key that's there
 * is kept, and made owner-only again if it was looser. One that isn't a
 * regular file of 32 bytes is refused, never replaced: token sets may be
 * stored under it.
 */
export async function connectionKeys(home: string, id: string): Promise<ConnectionKeys> {
  const folder = join(connectionKeysRoot(home), id);
  await makePrivateDir(folder);
  const local = await keyFile(join(folder, LOCAL_KEY), folder);
  const aad = await keyFile(join(folder, AAD_KEY), folder);
  return {
    folder,
    localKeyPath: join(folder, LOCAL_KEY),
    aadKeyPath: join(folder, AAD_KEY),
    made: local.made || aad.made,
  };
}

async function keyFile(path: string, folder: string): Promise<{ readonly made: boolean }> {
  if (await checkKey(path, folder)) return { made: false };
  // A new key goes in beside the name and is then linked to it: of two
  // `kindgi dev` starting at once, both keep the one that got there first.
  const temp = `${path}.${randomBytes(6).toString('hex')}.kindgi-tmp`;
  let made = true;
  try {
    await writeFile(temp, randomBytes(KEY_BYTES), { mode: KEY_MODE, flag: 'wx' });
    await link(temp, path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    made = false;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  if (!made) await checkKey(path, folder);
  return { made };
}

/** False when there's no key at `path`; true for a good one; else refused. */
async function checkKey(path: string, folder: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
  if (!info.isFile() || info.size !== KEY_BYTES) {
    throw new Error(
      `${path} isn't a ${KEY_BYTES}-byte key file. Connections' token sets in this database are kept under it, so it isn't replaced. Put back the file it was, or remove the folder ${folder} to start connections over: then connect each one again.`,
    );
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) await chmod(path, KEY_MODE);
  return true;
}

/**
 * Remove database `id`'s pair (`--reset` of the bundled database: the token
 * sets stored under it went with the database). Only the two key files:
 * the ports list stays, since the developer's apps keep their redirect URIs.
 * True when a key was there.
 */
export async function removeConnectionKeys(home: string, id: string): Promise<boolean> {
  const folder = join(connectionKeysRoot(home), id);
  let removed = false;
  for (const name of [LOCAL_KEY, AAD_KEY]) {
    try {
      await unlink(join(folder, name));
      removed = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  return removed;
}

/**
 * Note `port` in the ports list in `folder`. True when it's new there: the
 * developer hasn't yet been told to add its redirect URI to their apps. A
 * list that can't be read starts over.
 */
export async function notePort(folder: string, port: number): Promise<boolean> {
  const path = join(folder, PORTS);
  let ports: number[] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isPortList(parsed)) ports = [...parsed.ports];
  } catch {
    // None yet, or not one: start over.
  }
  if (ports.includes(port)) return false;
  ports.push(port);
  ports.sort((a, b) => a - b);
  await writePrivateFile(path, `${JSON.stringify({ ports }, null, 2)}\n`);
  return true;
}

function isPortList(value: unknown): value is { readonly ports: readonly number[] } {
  if (typeof value !== 'object' || value === null) return false;
  const ports = (value as { ports?: unknown }).ports;
  return Array.isArray(ports) && ports.every((p) => Number.isInteger(p));
}

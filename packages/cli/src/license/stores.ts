// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a deployment keeps its license key and its renewer's private key,
 * named by a reference (`--key`, `--renewer`):
 *
 * - `file:<path>`: the whole file is the value (a mounted secret, a key file);
 * - `env-file:<path>#<NAME>`: one `NAME=value` line of an env file
 *   (`kindgi.env`), the rest kept as it is.
 *
 * A write replaces the file atomically (a temporary file beside it, then a
 * rename) and keeps its mode; a new file is created `0600`. Nothing here
 * ever prints a value: `describe` says where, never what.
 */

import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface SecretStore {
  /** The value, trimmed; `undefined` when there's none yet (no file, no line, empty). */
  read(): Promise<string | undefined>;
  /** Keep `value` as the new value. */
  write(value: string): Promise<void>;
  /** Where, for messages: never the value. */
  readonly describe: string;
}

export class SecretRefError extends Error {}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The store a reference names. Throws `SecretRefError`, saying what a reference looks like. */
export function secretStoreFor(ref: string, cwd: string = process.cwd()): SecretStore {
  const colon = ref.indexOf(':');
  const scheme = colon === -1 ? '' : ref.slice(0, colon);
  const rest = ref.slice(colon + 1);
  if (scheme === 'file' && rest !== '') return fileStore(resolve(cwd, rest));
  if (scheme === 'env-file') {
    const hash = rest.lastIndexOf('#');
    const path = hash === -1 ? '' : rest.slice(0, hash);
    const name = hash === -1 ? '' : rest.slice(hash + 1);
    if (path !== '' && ENV_NAME.test(name)) return envFileStore(resolve(cwd, path), name);
  }
  throw new SecretRefError(
    `"${ref}" isn't a place to keep a secret. Use file:<path> or env-file:<path>#<NAME> (for example env-file:kindgi.env#KINDGI_LICENSE_KEY).`,
  );
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

/** Replace `path` with `text` in one step, keeping its mode (or 0600 for a new file). */
async function replaceFile(path: string, text: string): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.kindgi-tmp`);
  try {
    await writeFile(temp, text, { mode, flag: 'wx' });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

function fileStore(path: string): SecretStore {
  return {
    async read() {
      const text = (await readText(path))?.trim();
      return text === undefined || text === '' ? undefined : text;
    },
    async write(value) {
      await replaceFile(path, `${value}\n`);
    },
    describe: `the file ${path}`,
  };
}

/** `NAME=value` lines, as a `.env` file holds them: optional `export `, optional quotes. */
function envFileStore(path: string, name: string): SecretStore {
  const line = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=)(.*)$`);
  const unquote = (raw: string) => {
    const v = raw.trim();
    return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
      ? v.slice(1, -1)
      : v;
  };
  return {
    async read() {
      const text = await readText(path);
      if (text === undefined) return undefined;
      for (const l of text.split('\n')) {
        const m = line.exec(l);
        if (m !== null) {
          const value = unquote(m[2] ?? '');
          return value === '' ? undefined : value;
        }
      }
      return undefined;
    },
    async write(value) {
      const text = (await readText(path)) ?? '';
      const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
      let found = false;
      const next = lines.map((l) => {
        const m = line.exec(l);
        if (m === null || found) return l;
        found = true;
        return `${m[1]}${value}`;
      });
      if (!found) next.push(`${name}=${value}`);
      await replaceFile(path, `${next.join('\n')}\n`);
    },
    describe: `${name} in ${path}`,
  };
}

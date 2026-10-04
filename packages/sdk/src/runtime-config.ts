// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where an app's client finds its Kindgi runtime when `createClient` is
 * called without `apiUrl` / `auth`:
 *
 *   1. `KINDGI_API_URL` and `KINDGI_API_TOKEN` from the environment;
 *   2. outside production, the running `kindgi dev`, from the nearest
 *      `.kindgirc.json` at or above the working directory (it records the
 *      runtime's `apiUrl` and the dev `token`), with a one-time warning to
 *      put them in the app's env file;
 *   3. otherwise, an error that says what to set.
 *
 * Production (`NODE_ENV` or `KINDGI_ENV` set to `production`) never reads
 * `.kindgirc.json`. Whatever the source, a token that differs from the
 * running `kindgi dev`'s for the same `apiUrl` (the stale token after
 * `kindgi dev --reset`) is warned about once.
 *
 * Node only: the file is read through `process.getBuiltinModule`, never a
 * static `node:` import, so the module stays safe to bundle for browsers,
 * where only explicit options apply.
 */

import type { AuthConfig, ClientOptions } from '@kindgi/client';

/** The file `kindgi dev` writes in the pack directory. */
export const DEV_RUNTIME_FILE = '.kindgirc.json';

/** What a client needs from a running `kindgi dev`. */
export interface DevRuntime {
  readonly apiUrl: string;
  readonly token: string;
  /** The `.kindgirc.json` it came from. */
  readonly path: string;
}

/** Where the lookup runs: the process's own environment by default (tests pass their own). */
export interface RuntimeConfigContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The directory the `.kindgirc.json` search starts from. */
  readonly cwd: string | undefined;
  readonly warn: (message: string) => void;
}

const ENV_FILE_HINT = 'your env file (.env / .env.local)';

const warned = new Set<string>();

function warnOnce(context: RuntimeConfigContext, key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  context.warn(`[kindgi] ${message}`);
}

export function defaultContext(): RuntimeConfigContext {
  const proc = typeof process === 'undefined' ? undefined : process;
  return {
    env: proc?.env ?? {},
    cwd: typeof proc?.cwd === 'function' ? proc.cwd() : undefined,
    warn: (message) => console.warn(message),
  };
}

export function isProduction(env: RuntimeConfigContext['env']): boolean {
  return env.NODE_ENV === 'production' || env.KINDGI_ENV === 'production';
}

/**
 * The client options with every missing field resolved (see the module
 * comment). Throws when no `apiUrl` or no token can be found.
 */
export function resolveClientOptions(
  options: Partial<ClientOptions>,
  context: RuntimeConfigContext = defaultContext(),
): ClientOptions {
  const { env } = context;
  const dev = isProduction(env) ? undefined : findDevRuntime(context.cwd);

  let apiUrl = options.apiUrl ?? nonEmpty(env.KINDGI_API_URL);
  let auth: AuthConfig | undefined =
    options.auth ??
    (nonEmpty(env.KINDGI_API_TOKEN) !== undefined
      ? { kind: 'apiToken', token: env.KINDGI_API_TOKEN as string }
      : undefined);

  if ((apiUrl === undefined || auth === undefined) && dev !== undefined) {
    const used: string[] = [];
    if (apiUrl === undefined) {
      apiUrl = dev.apiUrl;
      used.push('KINDGI_API_URL');
    }
    if (auth === undefined) {
      auth = { kind: 'apiToken', token: dev.token };
      used.push('KINDGI_API_TOKEN');
    }
    warnOnce(
      context,
      `fallback:${dev.path}`,
      `Using the running kindgi dev from ${dev.path} for ${used.join(' and ')}. Set them in ${ENV_FILE_HINT}, and in production, where there's no ${DEV_RUNTIME_FILE}.`,
    );
  }

  if (apiUrl === undefined || auth === undefined) {
    const missing = [
      ...(apiUrl === undefined ? ['KINDGI_API_URL'] : []),
      ...(auth === undefined ? ['KINDGI_API_TOKEN'] : []),
    ];
    throw new Error(
      `createClient(): ${missing.join(' and ')} ${missing.length === 1 ? "isn't" : "aren't"} set. Set ${missing.length === 1 ? 'it' : 'them'} in ${ENV_FILE_HINT}, or pass { apiUrl, auth }.${
        isProduction(env)
          ? ''
          : ` In development, run \`kindgi dev\` in the app: it writes them to ${DEV_RUNTIME_FILE}, which the client reads.`
      }`,
    );
  }

  if (dev !== undefined && auth.kind === 'apiToken' && auth.token !== dev.token) {
    if (sameUrl(apiUrl, dev.apiUrl)) {
      warnOnce(
        context,
        `stale:${dev.path}:${dev.token}`,
        `The API token doesn't match the running kindgi dev's (${dev.path}). After \`kindgi dev --reset\` the token changes: copy the new one into ${ENV_FILE_HINT}.`,
      );
    }
  }

  return { ...options, apiUrl, auth };
}

/**
 * The running `kindgi dev`'s `apiUrl` and `token`, from the nearest
 * `.kindgirc.json` at or above `from`; `undefined` when there's none, it
 * can't be read, or the runtime can't read files (a browser).
 */
export function findDevRuntime(from: string | undefined): DevRuntime | undefined {
  if (from === undefined) return undefined;
  const fs = builtin<typeof import('node:fs')>('node:fs');
  const path = builtin<typeof import('node:path')>('node:path');
  if (fs === undefined || path === undefined) return undefined;
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, DEV_RUNTIME_FILE);
    if (fs.existsSync(candidate)) return readDevRuntime(fs, candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
}

function readDevRuntime(fs: typeof import('node:fs'), file: string): DevRuntime | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const apiUrl = parsed.apiUrl;
    const token = parsed.token;
    if (typeof apiUrl !== 'string' || apiUrl === '' || typeof token !== 'string' || token === '') {
      return undefined;
    }
    return { apiUrl, token, path: file };
  } catch {
    return undefined;
  }
}

function builtin<T>(id: string): T | undefined {
  const proc = typeof process === 'undefined' ? undefined : process;
  const get = (proc as { getBuiltinModule?: (id: string) => unknown } | undefined)
    ?.getBuiltinModule;
  return typeof get === 'function' ? (get.call(proc, id) as T | undefined) : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** Tests only: forget which warnings were printed. */
export function resetWarningsForTests(): void {
  warned.clear();
}

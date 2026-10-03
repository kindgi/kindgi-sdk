// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Filesystem layout for local signing keys under
 * `<home>/.kindgi/keys/<keyId>.{pem,pub.pem}`. Kept in its own file so the
 * command handler + tests share one source of truth for the layout.
 *
 * Home dir resolution order (matches other CLI commands):
 *   1. `--home <dir>` flag
 *   2. `HOME` env var (via `ctx.env.HOME` or `process.env.HOME`)
 *   3. `os.homedir()`
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory the CLI writes / reads keys under. `~/.kindgi/keys/`. */
export const KEYS_SUBDIR = ['.kindgi', 'keys'] as const;

/** File permissions the CLI enforces on the layout. */
export const PRIVATE_KEY_FILE_MODE = 0o600;
export const PUBLIC_KEY_FILE_MODE = 0o644;
export const KEYS_DIR_MODE = 0o700;

/** Regex a `keyId` must match. Same shape as pack IDs — lowercase kebab, optionally dot-namespaced. */
export const KEY_ID_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

export interface KeyPaths {
  readonly home: string;
  readonly keysDir: string;
  readonly privateKeyPath: (keyId: string) => string;
  readonly publicKeyPath: (keyId: string) => string;
}

/**
 * Resolve every filesystem path from a home dir. Callers supply
 * `--home` / `ctx.env.HOME` / `ctx.home`; this file's job is to keep
 * the layout consistent regardless.
 */
export function resolveKeyPaths(homeInput: string): KeyPaths {
  const home = homeInput;
  const keysDir = join(home, ...KEYS_SUBDIR);
  return {
    home,
    keysDir,
    privateKeyPath: (keyId: string) => join(keysDir, `${keyId}.pem`),
    publicKeyPath: (keyId: string) => join(keysDir, `${keyId}.pub.pem`),
  };
}

/**
 * Resolve the effective home dir given the standard precedence:
 * `--home` > `ctx.env.HOME` > `ctx.home` > `os.homedir()`.
 */
export function pickHome(inputs: {
  readonly flag?: string;
  readonly ctxHome?: string;
  readonly envHome?: string;
}): string {
  if (typeof inputs.flag === 'string' && inputs.flag !== '') return inputs.flag;
  if (typeof inputs.envHome === 'string' && inputs.envHome !== '') return inputs.envHome;
  if (typeof inputs.ctxHome === 'string' && inputs.ctxHome !== '') return inputs.ctxHome;
  return homedir();
}

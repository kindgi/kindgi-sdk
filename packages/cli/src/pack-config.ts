// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one way CLI commands load a pack's `kindgi.config.*`.
 *
 * Production delegates to `@kindgi/handler-runtime`'s
 * `loadKindgiConfig` — the same loader the indexer uses, so `build`,
 * `deploy`, `env`, `dev` and `mcp` agree with `kindgi-index` on lookup
 * order, validation and cache-busting. Tests inject
 * `ctx.buildConfigLoader` to hand in an in-memory config.
 *
 * `missing` and `invalid` are distinct so callers can treat "no config
 * here" as non-fatal while still surfacing a broken config's cause.
 */

import { loadKindgiConfig } from '@kindgi/handler-runtime';

import type { CommandContext } from './context.js';

export type PackConfigRecord = { readonly [k: string]: unknown };

export type PackConfigOutcome =
  | { readonly kind: 'ok'; readonly config: PackConfigRecord }
  | { readonly kind: 'missing'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

export async function loadPackConfig(
  ctx: Pick<CommandContext, 'buildConfigLoader'>,
  packDir: string,
): Promise<PackConfigOutcome> {
  if (ctx.buildConfigLoader !== undefined) {
    try {
      return { kind: 'ok', config: await ctx.buildConfigLoader(packDir) };
    } catch (err) {
      return { kind: 'invalid', message: (err as Error).message };
    }
  }
  const result = await loadKindgiConfig(packDir);
  if (result.kind === 'ok') return { kind: 'ok', config: result.value };
  return result.error.code === 'config-not-found'
    ? { kind: 'missing', message: result.error.message }
    : { kind: 'invalid', message: result.error.message };
}

export type DevEnvFilesOutcome =
  | { readonly kind: 'ok'; readonly files: readonly string[] | undefined }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * `dev.envFiles` — the env files `kindgi dev` reads for the `local`
 * environment, lowest precedence first, relative to the pack root.
 * `undefined` when unset (the default, `.env` then `.env.local`,
 * applies).
 *
 * ```ts
 * export default {
 *   pack: { id: 'acme.app', version: '1.0.0' },
 *   dev: { envFiles: ['.env', '.env.development', '.env.local'] },
 * };
 * ```
 */
export function devEnvFiles(config: PackConfigRecord): DevEnvFilesOutcome {
  const dev = config.dev;
  if (dev === undefined) return { kind: 'ok', files: undefined };
  if (dev === null || typeof dev !== 'object' || Array.isArray(dev)) {
    return { kind: 'invalid', message: '`dev` in kindgi.config.ts must be an object.' };
  }
  const files = (dev as Record<string, unknown>).envFiles;
  if (files === undefined) return { kind: 'ok', files: undefined };
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every((f): f is string => typeof f === 'string' && f !== '')
  ) {
    return {
      kind: 'invalid',
      message:
        '`dev.envFiles` in kindgi.config.ts must be a non-empty list of file paths, lowest precedence first (e.g. [".env", ".env.local"]).',
    };
  }
  return { kind: 'ok', files };
}

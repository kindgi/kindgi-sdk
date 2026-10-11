// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The environment `kindgi dev` gives the pack service — the process
 * that runs the pack's own code. It is what a deployment would give it:
 * the app's env files (`.env`, `.env.local`, or `dev.envFiles`) without
 * Kindgi's own `KINDGI_*` settings, plus the few host variables a Node
 * process and its tools need to work (`PATH`, `HOME` for cloud CLI
 * credentials, `TMPDIR`). Nothing else from the shell reaches pack code.
 *
 * Secrets stay out of it: a name Kindgi's own `.kindgi/secrets.env`
 * defines (what `kindgi secrets set` stores), and any model provider's
 * key, wherever it sits, are never in the pack service's environment. A
 * tool gets a secret only by declaring it (`needsSpec.secrets`), from
 * `ctx.secrets`, as in a deployment.
 */

import {
  LOCAL_ENV_NAME,
  type PackEnv,
  packValues,
  readPackEnv,
  resolvePackEnvFiles,
} from '@kindgi/secrets-dotenv';

/** The host variables a pack service inherits from the shell. */
export const PACK_HOST_ENV: readonly string[] = ['PATH', 'HOME', 'TMPDIR'];

export interface DevPackEnvInput {
  readonly packDir: string;
  /** `dev.envFiles` from `kindgi.config.ts`; default `.env`, `.env.local`. */
  readonly localEnvFiles?: readonly string[];
  /** The CLI's own environment. */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  /** The names model providers resolve their keys from: never passed on. */
  readonly providerKeyNames?: ReadonlySet<string>;
}

export async function devPackEnv(input: DevPackEnvInput): Promise<Record<string, string>> {
  const host: Record<string, string> = {};
  for (const name of PACK_HOST_ENV) {
    const value = input.hostEnv[name];
    if (value !== undefined) host[name] = value;
  }
  // The files' `${VAR}` references to names they don't define (and a key's
  // reference to itself, `KEY=${KEY}`) take the shell's value, as the
  // runtime's do (`shellReferencesOf`). Nothing else from the shell is passed.
  const files = await readPackEnv({
    packDir: input.packDir,
    envName: LOCAL_ENV_NAME,
    ...(input.localEnvFiles !== undefined && { localEnvFiles: input.localEnvFiles }),
    env: input.hostEnv,
  });
  return {
    ...host,
    ...packEnvValues(files, input.providerKeyNames),
    NODE_ENV: 'development',
  };
}

/**
 * The pack's values from its env files, less the secrets: names whose
 * value comes from Kindgi's own secrets file, and the providers' keys.
 */
export function packEnvValues(
  files: PackEnv,
  providerKeyNames: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const kindgiFile = files.files.kindgi;
  return Object.fromEntries(
    Object.entries(packValues(files.values)).filter(
      ([name]) =>
        !providerKeyNames.has(name) &&
        (kindgiFile === undefined || files.origin[name] !== kindgiFile),
    ),
  );
}

/**
 * The env files whose edits should restart the pack service (absolute paths):
 * the app's. Kindgi's own secrets file isn't one: its names never reach the
 * pack service, and a tool's secret resolves on each call.
 */
export function devPackEnvFiles(
  packDir: string,
  localEnvFiles?: readonly string[],
): readonly string[] {
  return resolvePackEnvFiles({
    packDir,
    envName: LOCAL_ENV_NAME,
    ...(localEnvFiles !== undefined && { localEnvFiles }),
  }).app;
}

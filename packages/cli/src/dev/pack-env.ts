// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The environment `kindgi dev` gives the pack service — the process
 * that runs the pack's own code. It is what a deployment would give it:
 * the pack's env files (`.env`, `.env.local`, or `dev.envFiles`) without
 * Kindgi's own `KINDGI_*` settings, plus the few host variables a Node
 * process and its tools need to work (`PATH`, `HOME` for cloud CLI
 * credentials, `TMPDIR`). Nothing else from the shell reaches pack code.
 */

import {
  LOCAL_ENV_NAME,
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
}

export async function devPackEnv(input: DevPackEnvInput): Promise<Record<string, string>> {
  const host: Record<string, string> = {};
  for (const name of PACK_HOST_ENV) {
    const value = input.hostEnv[name];
    if (value !== undefined) host[name] = value;
  }
  const files = await readPackEnv({
    packDir: input.packDir,
    envName: LOCAL_ENV_NAME,
    ...(input.localEnvFiles !== undefined && { localEnvFiles: input.localEnvFiles }),
  });
  return { ...host, ...packValues(files.values), NODE_ENV: 'development' };
}

/** The env files whose edits should restart the pack service (absolute paths). */
export function devPackEnvFiles(
  packDir: string,
  localEnvFiles?: readonly string[],
): readonly string[] {
  return resolvePackEnvFiles({
    packDir,
    envName: LOCAL_ENV_NAME,
    ...(localEnvFiles !== undefined && { localEnvFiles }),
  }).read;
}

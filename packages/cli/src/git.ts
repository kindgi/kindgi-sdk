// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Git, run by its absolute path from `PATH` ({@link findOnPath}): never a
 * `git` in the folder it runs in, the pack's.
 */

import { execFile } from 'node:child_process';

import { type Env, findOnPath } from './program-path.js';

export interface GitRun {
  /** Milliseconds git may run before it's ended. */
  readonly timeout: number;
  /** The most it may print, in bytes (`execFile`'s `maxBuffer`; 1 MiB when absent). */
  readonly maxBuffer?: number;
  /** The environment git is found on and run with; this process's when absent. */
  readonly env?: Env;
}

/**
 * `git <args>` run in `cwd`, by {@link findOnPath}'s path: what it
 * printed, or `undefined` when it failed or there's no git on `PATH`.
 */
export async function gitOutput(
  cwd: string,
  args: readonly string[],
  run: GitRun,
): Promise<string | undefined> {
  const git = await findOnPath('git', run.env ?? process.env);
  if (git === undefined) return undefined;
  return new Promise<string | undefined>((resolvePromise) => {
    execFile(
      git,
      [...args],
      {
        cwd,
        timeout: run.timeout,
        ...(run.maxBuffer !== undefined && { maxBuffer: run.maxBuffer }),
        ...(run.env !== undefined && { env: run.env }),
      },
      (err, stdout) => resolvePromise(err === null ? stdout : undefined),
    );
  });
}

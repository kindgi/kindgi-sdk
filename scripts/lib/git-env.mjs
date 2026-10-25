// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The environment a script test runs git in, in a scratch repository: the
 * caller's, without git's repository variables (`GIT_DIR` and the rest, as
 * `git rev-parse --local-env-vars` lists them). In a shell where they point
 * at another repository, git would otherwise act on that one: its commits,
 * branches, index and config.
 */

import { execFileSync } from 'node:child_process';

/** `env` without git's repository variables; `env` itself is left as it is. */
export function scratchRepoEnv(env = process.env) {
  const scrubbed = { ...env };
  for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)) {
    delete scrubbed[name];
  }
  return scrubbed;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Git's repository variables (`GIT_DIR` and the rest, as
 * `git rev-parse --local-env-vars` lists them), taken out of `process.env`
 * until `vi.unstubAllEnvs()`. A test's scratch repository is then the one
 * git acts on: the git the test runs, and the git the CLI runs in the
 * test's own process, which reads `process.env`. In a shell where they
 * point at another repository, both would otherwise act on that one.
 * Without git on `PATH` it does nothing, since then nothing acts on a
 * repository. `scripts/lib/git-env.mjs` takes the same variables out for
 * the script tests, which pass an environment to each child instead.
 */

import { execFileSync } from 'node:child_process';

import { vi } from 'vitest';

export function stubOutGitRepoVars(): void {
  let names: string;
  try {
    names = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names.split('\n').filter(Boolean)) {
    vi.stubEnv(name, undefined);
  }
}

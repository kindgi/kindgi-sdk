// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** stubOutGitRepoVars: git's repository variables out of process.env, the rest kept, and back after. */

import { afterEach, expect, test, vi } from 'vitest';

import { stubOutGitRepoVars } from './git-env.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

test("git's repository variables are out of process.env until unstubAllEnvs, and the rest stay", () => {
  const before = process.env.GIT_DIR;
  vi.stubEnv('GIT_DIR', '/srv/acme/.git');
  vi.stubEnv('GIT_WORK_TREE', '/srv/acme');
  vi.stubEnv('GIT_INDEX_FILE', '/srv/acme/.git/index');
  vi.stubEnv('GIT_AUTHOR_NAME', 'Acme Dev');
  const path = process.env.PATH;

  stubOutGitRepoVars();
  expect(process.env.GIT_DIR).toBeUndefined();
  expect(process.env.GIT_WORK_TREE).toBeUndefined();
  expect(process.env.GIT_INDEX_FILE).toBeUndefined();
  expect(process.env.GIT_AUTHOR_NAME).toBe('Acme Dev');
  expect(process.env.PATH).toBe(path);

  vi.unstubAllEnvs();
  expect(process.env.GIT_DIR).toBe(before);
});

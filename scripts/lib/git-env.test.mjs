// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** scratchRepoEnv: git's repository variables dropped, the rest kept, and another repository left alone. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { scratchRepoEnv } from './git-env.mjs';

describe('scratchRepoEnv', () => {
  test("drops git's repository variables, keeps the rest, and leaves its argument as it is", () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/acme',
      GIT_AUTHOR_NAME: 'Acme Dev',
      GIT_DIR: '/srv/acme/.git',
      GIT_WORK_TREE: '/srv/acme',
      GIT_INDEX_FILE: '/srv/acme/.git/index',
      GIT_COMMON_DIR: '/srv/acme/.git',
    };
    assert.deepEqual(scratchRepoEnv(env), {
      PATH: '/usr/bin',
      HOME: '/home/acme',
      GIT_AUTHOR_NAME: 'Acme Dev',
    });
    assert.equal(env.GIT_DIR, '/srv/acme/.git');
  });

  test('with GIT_DIR pointing at another repository, a scratch repository gets the commit and the other none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-env-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const git = (cwd, env, ...args) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
        cwd,
        env,
        encoding: 'utf8',
      });
    const other = join(dir, 'other');
    mkdirSync(other);
    const clean = scratchRepoEnv();
    git(other, clean, 'init', '-q', '-b', 'main');
    writeFileSync(join(other, 'README.md'), 'other');
    git(other, clean, 'add', '-A');
    git(other, clean, 'commit', '-q', '-m', 'other');
    const commits = () => git(other, clean, 'rev-list', '--all', '--count').trim();
    const pointed = { ...clean, GIT_DIR: join(other, '.git') };

    const scratch = join(dir, 'scratch');
    mkdirSync(scratch);
    const commit = (env) => {
      git(scratch, env, 'init', '-q', '-b', 'main');
      writeFileSync(join(scratch, 'page.txt'), 'scratch');
      git(scratch, env, 'add', '-A');
      git(scratch, env, 'commit', '-q', '-m', 'scratch');
    };

    commit(scratchRepoEnv(pointed));
    assert.equal(git(scratch, clean, 'rev-list', '--all', '--count').trim(), '1');
    assert.equal(commits(), '1');

    // Without it, the same steps commit to the other repository.
    commit(pointed);
    assert.equal(commits(), '2');
  });
});

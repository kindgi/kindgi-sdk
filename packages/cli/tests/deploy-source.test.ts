// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { readDeploySource, repoOf } from '../src/deploy/source.js';
import { stubOutGitRepoVars } from './git-env.js';

let root: string;

beforeEach(async () => {
  stubOutGitRepoVars();
  // realpath: macOS's tmpdir is a symlink, and git prints resolved paths.
  root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-deploy-source-')));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('repoOf: the origin remote as host/owner/name, with nothing secret in it', () => {
  test.each([
    ['git@github.com:acme/support-pack.git', 'github.com/acme/support-pack'],
    ['https://github.com/acme/support-pack.git', 'github.com/acme/support-pack'],
    ['https://github.com/acme/support-pack/', 'github.com/acme/support-pack'],
    [
      'https://x-access-token:not-a-token@github.com/acme/support-pack',
      'github.com/acme/support-pack',
    ],
    ['https://someone@GitHub.com/acme/support-pack.git', 'github.com/acme/support-pack'],
    ['ssh://git@github.com:22/acme/support-pack.git', 'github.com/acme/support-pack'],
    [
      'https://gitlab.example.com/acme/team/support-pack.git',
      'gitlab.example.com/acme/team/support-pack',
    ],
  ])('%s → %s', (url, repo) => {
    expect(repoOf(url)).toBe(repo);
  });

  test.each([
    ['/srv/git/support-pack.git'],
    ['file:///srv/git/support-pack.git'],
    ['../support-pack'],
    ['https://github.com/acme'],
    ['someone:not-a-token@github.com:acme/support-pack.git'],
    ['https://github.com/acme/support%20pack'],
    ['https://github.com/acme/../support-pack'],
  ])('%s: none', (url) => {
    expect(repoOf(url)).toBeUndefined();
  });
});

describe('readDeploySource, on a real repository', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    });
  const commit = (cwd: string) =>
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'pack');

  /** A repository with a pack at `packs/support`, committed, and an `origin` with a token in it. */
  async function repoWithPack(): Promise<{ repo: string; pack: string; head: string }> {
    const repo = join(root, 'acme');
    const pack = join(repo, 'packs', 'support');
    await mkdir(join(pack, 'blocks'), { recursive: true });
    await writeFile(join(pack, 'blocks', 'tone.json'), '{}\n');
    await writeFile(join(repo, 'README.md'), 'acme\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(
      repo,
      'remote',
      'add',
      'origin',
      'https://x-access-token:not-a-token@github.com/acme/agents.git',
    );
    git(repo, 'add', '.');
    commit(repo);
    return { repo, pack, head: git(repo, 'rev-parse', 'HEAD').trim() };
  }

  test('a clean checkout: the repo, the pack folder, the commit and the branch', async () => {
    const { pack, head } = await repoWithPack();
    expect(await readDeploySource(pack)).toEqual({
      repo: 'github.com/acme/agents',
      path: 'packs/support',
      commit: head,
      branch: 'main',
      dirty: false,
    });
  });

  test("dirty: a change in the pack folder, or a file the commit doesn't hold; not one outside it", async () => {
    const { repo, pack } = await repoWithPack();
    await writeFile(join(repo, 'README.md'), 'acme, changed\n');
    expect((await readDeploySource(pack))?.dirty).toBe(false);

    await writeFile(join(pack, 'blocks', 'reply.json'), '{}\n');
    expect((await readDeploySource(pack))?.dirty).toBe(true);

    git(repo, 'add', '.');
    commit(repo);
    await writeFile(join(pack, 'blocks', 'tone.json'), '{"changed":true}\n');
    expect((await readDeploySource(pack))?.dirty).toBe(true);
  });

  test("the repository's root is `.`; a detached HEAD has no branch; no origin, no repo", async () => {
    const { repo, head } = await repoWithPack();
    git(repo, 'checkout', '-q', '--detach');
    git(repo, 'remote', 'remove', 'origin');
    expect(await readDeploySource(repo)).toEqual({ path: '.', commit: head, dirty: false });
  });

  test('outside a repository, or before its first commit: none', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    expect(await readDeploySource(plain)).toBeUndefined();

    git(plain, 'init', '-q', '-b', 'main');
    expect(await readDeploySource(plain)).toBeUndefined();
  });

  test('without git: none', async () => {
    expect(await readDeploySource(root, async () => undefined)).toBeUndefined();
  });
});

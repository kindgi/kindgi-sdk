// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type GitCall,
  callGit,
  gitCaller,
  gitEnv,
  listedFiles,
  uncommittedFiles,
} from '../src/uncommitted-files.js';
import { stubOutGitRepoVars } from './git-env.js';

let root: string;

beforeEach(async () => {
  stubOutGitRepoVars();
  // realpath: macOS's tmpdir is a symlink, and git prints resolved paths.
  root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-uncommitted-')));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
const commit = (cwd: string) =>
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'pack');

const BLOCKS = [
  'blocks/tone.json',
  'blocks/reply.json',
  'blocks/reply.liquid',
  'blocks/rules.json',
  'blocks/local/draft.json',
];

/**
 * A repository with a pack in `packs/support` (or at its root), every
 * block committed but `blocks/local/`, which the repository ignores.
 */
async function repoWithPack(at: 'nested' | 'root' = 'nested'): Promise<string> {
  const repo = join(root, 'acme');
  const pack = at === 'nested' ? join(repo, 'packs', 'support') : repo;
  await mkdir(join(pack, 'blocks', 'local'), { recursive: true });
  for (const file of BLOCKS) await writeFile(join(pack, file), `${file}\n`);
  const ignored = at === 'nested' ? 'packs/support/blocks/local/' : 'blocks/local/';
  await writeFile(join(repo, '.gitignore'), `${ignored}\n`);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  commit(repo);
  return pack;
}

describe('uncommittedFiles, on a real repository', () => {
  test('files as committed: none listed', async () => {
    const pack = await repoWithPack();
    expect(await uncommittedFiles(pack, ['blocks/tone.json', 'blocks/reply.json'])).toEqual({
      kind: 'git',
      uncommitted: [],
    });
  });

  test('changed, staged, untracked and ignored files are listed, by their paths in the pack', async () => {
    const pack = await repoWithPack();
    await writeFile(join(pack, 'blocks/tone.json'), 'edited\n');
    await writeFile(join(pack, 'blocks/reply.liquid'), 'edited\n');
    git(pack, 'add', 'blocks/reply.liquid');
    await writeFile(join(pack, 'blocks/new.json'), 'new\n');
    expect(
      await uncommittedFiles(pack, [
        'blocks/tone.json',
        'blocks/reply.json',
        'blocks/reply.liquid',
        'blocks/new.json',
        'blocks/local/draft.json',
      ]),
    ).toEqual({
      kind: 'git',
      uncommitted: [
        'blocks/local/draft.json',
        'blocks/new.json',
        'blocks/reply.liquid',
        'blocks/tone.json',
      ],
    });
  });

  test('untracked and ignored files in a folder are listed one by one', async () => {
    const pack = await repoWithPack();
    await mkdir(join(pack, 'blocks/fresh'));
    await writeFile(join(pack, 'blocks/fresh/a.json'), 'a\n');
    await writeFile(join(pack, 'blocks/fresh/b.json'), 'b\n');
    expect(
      await uncommittedFiles(pack, ['blocks/fresh/a.json', 'blocks/local/draft.json']),
    ).toEqual({ kind: 'git', uncommitted: ['blocks/fresh/a.json', 'blocks/local/draft.json'] });
  });

  test('a renamed file is listed, and the path it came from is read as such', async () => {
    const pack = await repoWithPack();
    git(pack, 'mv', 'blocks/rules.json', 'blocks/policy.json');
    await writeFile(join(pack, 'blocks/tone.json'), 'edited\n');
    expect(
      await uncommittedFiles(pack, ['blocks/policy.json', 'blocks/rules.json', 'blocks/tone.json']),
    ).toEqual({
      kind: 'git',
      uncommitted: ['blocks/policy.json', 'blocks/rules.json', 'blocks/tone.json'],
    });
  });

  test("a pack at the repository's root", async () => {
    const pack = await repoWithPack('root');
    await writeFile(join(pack, 'blocks/tone.json'), 'edited\n');
    expect(
      await uncommittedFiles(pack, [
        'blocks/tone.json',
        'blocks/reply.json',
        'blocks/local/draft.json',
      ]),
    ).toEqual({ kind: 'git', uncommitted: ['blocks/local/draft.json', 'blocks/tone.json'] });
  });

  test('a file name with glob characters in it is read as that file', async () => {
    const pack = await repoWithPack();
    await writeFile(join(pack, 'blocks/*.json'), 'odd\n');
    git(pack, 'add', '--', ':(literal)blocks/*.json');
    commit(pack);
    await writeFile(join(pack, 'blocks/tone.json'), 'edited\n');
    expect(await uncommittedFiles(pack, ['blocks/*.json'])).toEqual({
      kind: 'git',
      uncommitted: [],
    });
    await writeFile(join(pack, 'blocks/*.json'), 'edited\n');
    expect(await uncommittedFiles(pack, ['blocks/*.json'])).toEqual({
      kind: 'git',
      uncommitted: ['blocks/*.json'],
    });
  });

  test('each file is named as git names it: `/`-separated and normalized', async () => {
    const pack = await repoWithPack();
    await writeFile(join(pack, 'blocks/tone.json'), 'edited\n');
    await writeFile(join(pack, 'blocks/reply.json'), 'edited\n');
    await writeFile(join(pack, 'blocks/rules.json'), 'edited\n');
    expect(
      await uncommittedFiles(pack, [
        './blocks/tone.json',
        'blocks/../blocks/reply.json',
        'blocks\\rules.json',
        'blocks//reply.liquid',
      ]),
    ).toEqual({
      kind: 'git',
      uncommitted: ['blocks/reply.json', 'blocks/rules.json', 'blocks/tone.json'],
    });
  });

  test('a file in another repository inside this one is uncommitted, whether or not this one holds that repository', async () => {
    const pack = await repoWithPack();
    const sub = join(pack, 'blocks/sub');
    await mkdir(sub);
    await writeFile(join(sub, 'x.json'), 'x\n');
    git(sub, 'init', '-q', '-b', 'main');
    git(sub, 'add', '.');
    commit(sub);
    expect(await uncommittedFiles(pack, ['blocks/sub/x.json', 'blocks/tone.json'])).toEqual({
      kind: 'git',
      uncommitted: ['blocks/sub/x.json'],
    });
    // As a submodule is: the repository inside, committed into this one.
    git(pack, 'add', 'blocks/sub');
    commit(pack);
    expect(await uncommittedFiles(pack, ['blocks/sub/x.json', 'blocks/tone.json'])).toEqual({
      kind: 'git',
      uncommitted: ['blocks/sub/x.json'],
    });
  });

  test("a file that isn't there and that git doesn't hold isn't listed: there's nothing to lose", async () => {
    const pack = await repoWithPack();
    expect(await uncommittedFiles(pack, ['blocks/fresh.liquid', 'blocks/tone.json'])).toEqual({
      kind: 'git',
      uncommitted: [],
    });
  });

  test('a pack outside any repository: not in git', async () => {
    const pack = join(root, 'loose');
    await mkdir(join(pack, 'blocks'), { recursive: true });
    await writeFile(join(pack, 'blocks/tone.json'), '{}\n');
    expect(await uncommittedFiles(pack, ['blocks/tone.json'])).toEqual({ kind: 'not-in-git' });
  });

  test("GIT_DIR set to another repository doesn't make git read that one", async () => {
    const pack = await repoWithPack();
    await writeFile(join(pack, 'blocks/tone.json'), 'edited\n');
    const other = join(root, 'other');
    await mkdir(other);
    git(other, 'init', '-q');
    vi.stubEnv('GIT_DIR', join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);
    expect(await uncommittedFiles(pack, ['blocks/tone.json'])).toEqual({
      kind: 'git',
      uncommitted: ['blocks/tone.json'],
    });
  });

  test('nothing asked: no status read, and none listed', async () => {
    const pack = await repoWithPack();
    const calls: (readonly string[])[] = [];
    const recorded: GitCall = async (cwd, args, timeoutMs) => {
      calls.push(args);
      return callGit(cwd, args, timeoutMs);
    };
    expect(await uncommittedFiles(pack, [], recorded)).toEqual({ kind: 'git', uncommitted: [] });
    expect(calls).toEqual([['rev-parse', '--show-prefix']]);
  });
});

describe("uncommittedFiles: a path that isn't a file in the pack's folder", () => {
  test.each([
    ['empty', ''],
    ['the folder itself', './'],
    ['absolute', '/srv/acme/packs/support/blocks/tone.json'],
    ['absolute on Windows', 'C:\\acme\\blocks\\tone.json'],
    ['outside the folder', '../other/blocks/tone.json'],
    ['outside it, after a way in', 'blocks/../../tone.json'],
    ['a folder', 'blocks/'],
    ['with a NUL', 'blocks/tone.json\0.liquid'],
  ])('%s: unknown, and git is never asked', async (_name, file) => {
    const calls: (readonly string[])[] = [];
    const recorded: GitCall = async (_cwd, args) => {
      calls.push(args);
      return { kind: 'ok', stdout: '' };
    };
    expect(await uncommittedFiles('/pack', ['blocks/reply.json', file], recorded)).toEqual({
      kind: 'unknown',
    });
    expect(calls).toEqual([]);
  });

  test('a folder named without the `/`: unknown', async () => {
    const pack = await repoWithPack();
    expect(await uncommittedFiles(pack, ['blocks/tone.json', 'blocks'])).toEqual({
      kind: 'unknown',
    });
  });

  test('a NUL that reaches git anyway: a git that failed, never a rejection', async () => {
    expect(await callGit(root, ['status', '--', 'blocks/tone.json\0.liquid'], 2_000)).toEqual({
      kind: 'failed',
    });
  });
});

describe('uncommittedFiles: what git is asked', () => {
  test('read-only, the files as literal paths after `--`, each untracked and ignored file on its own', async () => {
    const calls: (readonly string[])[] = [];
    const recorded: GitCall = async (_cwd, args) => {
      calls.push(args);
      return { kind: 'ok', stdout: args[0] === 'rev-parse' ? 'packs/support/\n' : '' };
    };
    await uncommittedFiles('/pack', ['blocks/tone.json', '-p.json'], recorded);
    expect(calls[1]).toEqual([
      '--no-optional-locks',
      '--literal-pathspecs',
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--ignored',
      '--',
      'blocks/tone.json',
      '-p.json',
    ]);
    expect(calls[2]).toEqual([
      '--no-optional-locks',
      '--literal-pathspecs',
      'ls-files',
      '--cached',
      '-z',
      '--',
      'blocks/tone.json',
      '-p.json',
    ]);
    expect(calls).toHaveLength(3);
  });
});

describe.skipIf(process.platform === 'win32')('uncommittedFiles: when git can’t say', () => {
  // A script made just now may take seconds to start (macOS checks a new
  // executable), past the 2 s a git command gets: these wait for its answer.
  const SLOW_START_MS = 30_000;

  /** A `git` on `PATH` that runs `script` (sh), and only it. */
  async function fakeGit(script: string): Promise<void> {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'git'), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, 'git'), 0o755);
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
  }

  test('no git: unknown', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    vi.stubEnv('PATH', empty);
    expect(await uncommittedFiles(root, ['blocks/tone.json'])).toEqual({ kind: 'unknown' });
  });

  test("the git on a given environment's PATH (`gitCaller`)", async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    expect(await uncommittedFiles(root, ['blocks/tone.json'], gitCaller({ PATH: empty }))).toEqual({
      kind: 'unknown',
    });
    await fakeGit(
      'echo "fatal: not a git repository (or any of the parent directories): .git" >&2\nexit 128',
    );
    const bin = join(root, 'bin');
    vi.unstubAllEnvs();
    expect(
      await uncommittedFiles(
        root,
        ['blocks/tone.json'],
        gitCaller({ PATH: `${bin}:/usr/bin:/bin` }),
        SLOW_START_MS,
      ),
    ).toEqual({ kind: 'not-in-git' });
  });

  test("the git in PATH's first absolute entry runs, never one in the pack's folder", async () => {
    // A stand-in in the pack's folder, and `.` and an empty entry ahead of
    // the git on PATH: a bare `git` would run the stand-in.
    await writeFile(join(root, 'git'), '#!/bin/sh\necho ran > "$(dirname "$0")/ran"\n');
    await chmod(join(root, 'git'), 0o755);
    await fakeGit(
      'echo "fatal: not a git repository (or any of the parent directories): .git" >&2\nexit 128',
    );
    vi.stubEnv('PATH', ['.', '', join(root, 'bin'), '/usr/bin', '/bin'].join(':'));
    expect(await uncommittedFiles(root, ['blocks/tone.json'], callGit, SLOW_START_MS)).toEqual({
      kind: 'not-in-git',
    });
    await expect(access(join(root, 'ran'))).rejects.toThrow();
  });

  test('a git that answers past the time: unknown, and it is stopped', async () => {
    await fakeGit('sleep 10');
    const started = Date.now();
    expect(await uncommittedFiles(root, ['blocks/tone.json'], callGit, 200)).toEqual({
      kind: 'unknown',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('another fatal error than no repository (an owner git distrusts): unknown', async () => {
    await fakeGit(`echo "fatal: detected dubious ownership in repository at '$PWD'" >&2\nexit 128`);
    expect(await uncommittedFiles(root, ['blocks/tone.json'], callGit, SLOW_START_MS)).toEqual({
      kind: 'unknown',
    });
  });

  test("a worktree whose repository moved (a `.git` file pointing nowhere): unknown, not 'not in git'", async () => {
    await fakeGit(
      'echo "fatal: not a git repository: /srv/acme/.git/worktrees/support" >&2\nexit 128',
    );
    expect(await uncommittedFiles(root, ['blocks/tone.json'], callGit, SLOW_START_MS)).toEqual({
      kind: 'unknown',
    });
  });

  test("a stop past the filesystem's edge is still looking and finding none: not in git", async () => {
    await fakeGit(
      'echo "fatal: not a git repository (or any parent up to mount point /srv)" >&2\necho "Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set)." >&2\nexit 128',
    );
    expect(await uncommittedFiles(root, ['blocks/tone.json'], callGit, SLOW_START_MS)).toEqual({
      kind: 'not-in-git',
    });
  });

  test('a status that fails after the repository was found: unknown', async () => {
    await fakeGit(
      `if [ "$1" = rev-parse ]; then echo; exit 0; fi\necho "fatal: index file corrupt" >&2\nexit 128`,
    );
    expect(await uncommittedFiles(root, ['blocks/tone.json'], callGit, SLOW_START_MS)).toEqual({
      kind: 'unknown',
    });
  });

  test("an index git can't read after the status: unknown", async () => {
    await fakeGit(
      `case "$3" in ls-files) echo "fatal: index file corrupt" >&2; exit 128;; esac\nexit 0`,
    );
    expect(await uncommittedFiles(root, ['blocks/tone.json'], callGit, SLOW_START_MS)).toEqual({
      kind: 'unknown',
    });
  });
});

describe('gitEnv', () => {
  test("git's repository variables are left out, the rest kept, and its messages are in English", () => {
    expect(
      gitEnv({
        PATH: '/usr/bin',
        HOME: '/home/acme',
        GIT_DIR: '/elsewhere/.git',
        GIT_WORK_TREE: '/elsewhere',
        GIT_INDEX_FILE: '/elsewhere/index',
        GIT_SSH_COMMAND: 'ssh -i key',
        LC_ALL: 'de_DE.UTF-8',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/acme',
      GIT_SSH_COMMAND: 'ssh -i key',
      LC_ALL: 'C',
    });
  });
});

describe('listedFiles: `git status --porcelain -z` read', () => {
  const asked = new Set(['blocks/new.json', 'blocks/old.json', 'blocks/tone.json']);

  test('a rename or a copy has the path it came from as a field of its own', () => {
    expect(
      listedFiles(
        'R  pack/blocks/new.json\0pack/blocks/old.json\0 M pack/blocks/tone.json\0',
        'pack/',
        asked,
      ),
    ).toEqual(['blocks/new.json', 'blocks/old.json', 'blocks/tone.json']);
    expect(listedFiles('C  pack/blocks/new.json\0pack/blocks/tone.json\0', 'pack/', asked)).toEqual(
      ['blocks/new.json', 'blocks/tone.json'],
    );
  });

  test('paths outside the pack, and files not asked about, are left out', () => {
    expect(
      listedFiles(
        ' M other/blocks/tone.json\0?? pack/blocks/extra.json\0 M pack/blocks/tone.json\0',
        'pack/',
        asked,
      ),
    ).toEqual(['blocks/tone.json']);
  });

  test('a folder listed whole lists each asked file in it', () => {
    expect(listedFiles('!! pack/blocks/\0', 'pack/', asked)).toEqual([...asked].sort());
  });

  test('nothing listed', () => {
    expect(listedFiles('', 'pack/', asked)).toEqual([]);
  });
});

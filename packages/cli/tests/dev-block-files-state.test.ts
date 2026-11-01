// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { blockFilesState } from '../src/dev/block-files-state.js';
import type { GitCall } from '../src/uncommitted-files.js';
import { stubOutGitRepoVars } from './git-env.js';

let root: string;

beforeEach(async () => {
  stubOutGitRepoVars();
  // realpath: macOS's tmpdir is a symlink, and git prints resolved paths.
  root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-block-files-')));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const BLOCKS = 'blocks/**/*.json';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const FILES: Readonly<Record<string, string>> = {
  'blocks/support/reply.json': json({
    id: 'acme.reply-prompt',
    version: '1.2.0',
    kind: 'prompt',
    description: 'How the support agent replies',
    content: { templateFile: 'reply.liquid', parameters: [] },
  }),
  'blocks/support/reply.liquid': 'Reply.\n',
  'blocks/style.json': json({
    id: 'acme.reply-style',
    version: '1.0.0',
    kind: 'settings',
    content: {
      values: { tone: 'warm' },
      schema: { type: 'object', properties: { tone: { type: 'string' } } },
    },
  }),
};

/** A pack in `packs/support` of a repository, every file committed; or in no repository. */
async function pack(inGit = true): Promise<string> {
  const repo = join(root, 'acme');
  const dir = inGit ? join(repo, 'packs', 'support') : join(root, 'loose');
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), text);
  }
  if (inGit) {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'pack');
  }
  return dir;
}

describe("blockFilesState: the files of some blocks git hasn't committed", () => {
  test("a block's file and its template file, read from the pack, are what git is asked about", async () => {
    const dir = await pack();
    const state = blockFilesState(dir, BLOCKS);
    expect(await state(['acme.reply-prompt', 'acme.reply-style'])).toEqual({
      kind: 'git',
      uncommitted: [],
    });
    await writeFile(join(dir, 'blocks/support/reply.liquid'), 'Reply, edited.\n');
    await writeFile(join(dir, 'blocks/style.json'), `${FILES['blocks/style.json']}\n`);
    expect(await state(['acme.reply-prompt'])).toEqual({
      kind: 'git',
      uncommitted: ['blocks/support/reply.liquid'],
    });
    expect(await state(['acme.reply-prompt', 'acme.reply-style'])).toEqual({
      kind: 'git',
      uncommitted: ['blocks/style.json', 'blocks/support/reply.liquid'],
    });
  });

  test('a pack in no repository: not in git', async () => {
    const dir = await pack(false);
    expect(await blockFilesState(dir, BLOCKS)(['acme.reply-style'])).toEqual({
      kind: 'not-in-git',
    });
  });

  test("blocks the pack doesn't hold, outside git too: git isn't asked, and nothing is said", async () => {
    const dir = await pack(false);
    const calls: (readonly string[])[] = [];
    const recorded: GitCall = async (_cwd, args) => {
      calls.push(args);
      return { kind: 'not-a-repository' };
    };
    const state = blockFilesState(dir, BLOCKS, recorded);
    expect(await state(['acme.gone'])).toEqual({ kind: 'git', uncommitted: [] });
    expect(await state([])).toEqual({ kind: 'git', uncommitted: [] });
    expect(calls).toEqual([]);
  });
});

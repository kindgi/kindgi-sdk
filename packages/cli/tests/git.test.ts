// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { execFileSync } from 'node:child_process';
import { access, chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { readDeploySource } from '../src/deploy/source.js';
import { locateGit } from '../src/dev/project.js';
import { gitOutput } from '../src/git.js';
import { findOnPath } from '../src/program-path.js';
import { stubOutGitRepoVars } from './git-env.js';

// A stand-in git in the pack's folder, and `.` and an empty entry ahead
// of the real git on PATH: a bare `git` would run the stand-in, as a
// bare `git` on Windows runs a git.exe in the cwd.
describe.skipIf(process.platform === 'win32')("a git in the pack's folder is never run", () => {
  let pack: string;
  let git: string;
  const ran = async (): Promise<boolean> =>
    access(join(pack, 'ran')).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    stubOutGitRepoVars();
    const found = await findOnPath('git', process.env);
    if (found === undefined) throw new Error('these tests need git on PATH');
    git = found;
    // realpath: macOS's tmpdir is a symlink, and git prints resolved paths.
    pack = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-git-')));
    await writeFile(join(pack, 'kindgi.json'), '{}\n');
    const inPack = (...args: string[]) => execFileSync(git, args, { cwd: pack, encoding: 'utf8' });
    inPack('init', '-q');
    inPack('add', 'kindgi.json');
    inPack('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'pack');
    await writeFile(
      join(pack, 'git'),
      '#!/bin/sh\necho ran > "$(dirname "$0")/ran"\necho stand-in\n',
    );
    await chmod(join(pack, 'git'), 0o755);
    vi.stubEnv('PATH', ['.', '', dirname(git)].join(delimiter));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(pack, { recursive: true, force: true });
  });

  test('gitOutput runs the git on PATH', async () => {
    expect(await gitOutput(pack, ['--version'], { timeout: 10_000 })).toMatch(/^git version \d/);
    expect(await ran()).toBe(false);
  });

  test("gitOutput with an env: git is found on that env's PATH, not this process's", async () => {
    vi.stubEnv('PATH', [pack, dirname(git)].join(delimiter));
    const env = { ...process.env, PATH: dirname(git) };
    expect(await gitOutput(pack, ['--version'], { timeout: 10_000, env })).toMatch(
      /^git version \d/,
    );
    expect(await ran()).toBe(false);
    // The pack's folder is an absolute entry on this process's PATH: there, its git is found.
    expect(await gitOutput(pack, ['--version'], { timeout: 10_000 })).toBe('stand-in\n');
    expect(await ran()).toBe(true);
  });

  test("the CLI's git readers: where the pack is for kindgi deploy, and its checkout for kindgi dev", async () => {
    const head = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: pack, encoding: 'utf8' }).trim();
    expect((await readDeploySource(pack))?.commit).toBe(head);
    expect((await locateGit(pack))?.toplevel).toBe(pack);
    expect(await ran()).toBe(false);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { execFileSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { readDeploySource } from '../src/deploy/source.js';
import { locateGit } from '../src/dev/project.js';
import { type GitLookup, findGit, gitLookup, gitOutput, pathEntries } from '../src/git.js';
import { stubOutGitRepoVars } from './git-env.js';

/** A lookup on `platform` where only `files` are there, and every file it asked about. */
function lookupOn(
  platform: NodeJS.Platform,
  path: string | undefined,
  files: readonly string[],
): { readonly lookup: GitLookup; readonly asked: string[] } {
  const asked: string[] = [];
  return {
    lookup: {
      platform,
      path,
      runnable: async (file) => {
        asked.push(file);
        return files.includes(file);
      },
    },
    asked,
  };
}

describe("findGit on Windows: PATH's absolute entries only, never the folder git runs in", () => {
  test("a git.exe in the pack's folder, or in a relative entry, isn't found", async () => {
    const { lookup, asked } = lookupOn('win32', '.;;pack;C:pack;\\pack;C:\\Git\\cmd', [
      'git.exe',
      '.\\git.exe',
      'pack\\git.exe',
      'C:pack\\git.exe',
      '\\pack\\git.exe',
      'C:\\pack\\git.exe',
      'C:\\Git\\cmd\\git.exe',
    ]);
    expect(await findGit(lookup)).toBe('C:\\Git\\cmd\\git.exe');
    expect(asked).toEqual(['C:\\Git\\cmd\\git.com', 'C:\\Git\\cmd\\git.exe']);
  });

  test('in each folder, git.com and then git.exe, as libuv tries them; the first folder wins', async () => {
    const { lookup } = lookupOn('win32', 'C:\\a;C:\\b', [
      'C:\\a\\git.exe',
      'C:\\a\\git.com',
      'C:\\b\\git.com',
    ]);
    expect(await findGit(lookup)).toBe('C:\\a\\git.com');
    const later = lookupOn('win32', 'C:\\a;C:\\b', ['C:\\b\\git.exe']);
    expect(await findGit(later.lookup)).toBe('C:\\b\\git.exe');
  });

  test("a quoted entry, a share, and a drive's root written with /", async () => {
    expect(
      await findGit(
        lookupOn('win32', '"C:\\Program Files\\Git\\cmd"', ['C:\\Program Files\\Git\\cmd\\git.exe'])
          .lookup,
      ),
    ).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(
      await findGit(lookupOn('win32', '\\\\tools\\git', ['\\\\tools\\git\\git.exe']).lookup),
    ).toBe('\\\\tools\\git\\git.exe');
    expect(await findGit(lookupOn('win32', 'C:/Git/cmd', ['C:\\Git\\cmd\\git.exe']).lookup)).toBe(
      'C:\\Git\\cmd\\git.exe',
    );
  });

  test('pathEntries: split at ;, a quoted part may hold one', () => {
    expect(pathEntries('win32', '"C:\\a;b";C:\\c;')).toEqual(['C:\\a;b', 'C:\\c', '']);
  });

  test('no PATH, or no git on it: undefined', async () => {
    expect(await findGit(lookupOn('win32', undefined, ['C:\\Git\\cmd\\git.exe']).lookup)).toBe(
      undefined,
    );
    expect(await findGit(lookupOn('win32', 'C:\\Git\\cmd', []).lookup)).toBe(undefined);
  });
});

describe("findGit on Linux and macOS: an empty or relative entry is the folder git runs in, so it's skipped", () => {
  test('only /usr/bin/git is asked about', async () => {
    const { lookup, asked } = lookupOn('linux', '.::bin:/usr/bin', [
      'git',
      './git',
      'bin/git',
      '/usr/bin/git',
    ]);
    expect(await findGit(lookup)).toBe('/usr/bin/git');
    expect(asked).toEqual(['/usr/bin/git']);
  });
});

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
    const found = await findGit(gitLookup());
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

  test("the CLI's git readers: where the pack is for kindgi deploy, and its checkout for kindgi dev", async () => {
    const head = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: pack, encoding: 'utf8' }).trim();
    expect((await readDeploySource(pack))?.commit).toBe(head);
    expect((await locateGit(pack))?.toplevel).toBe(pack);
    expect(await ran()).toBe(false);
  });
});

describe('the CLI runs git only through gitOutput', () => {
  test('no source file starts a bare git', async () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (await readdir(src, { recursive: true })).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.d.ts'),
    );
    const bare =
      /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*['"`]git(?:\.exe)?['"`]/;
    const starting: string[] = [];
    for (const file of files) {
      if (bare.test(await readFile(join(src, file), 'utf8'))) starting.push(file);
    }
    expect(starting).toEqual([]);
  });
});

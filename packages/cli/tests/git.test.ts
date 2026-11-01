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
import {
  type PathLookup,
  findOnPath,
  gitOutput,
  pathEntries,
  pathValue,
  searchPath,
} from '../src/git.js';
import { stubOutGitRepoVars } from './git-env.js';

/** A lookup on `platform` where only `files` are there, and every file it asked about. */
function lookupOn(
  platform: NodeJS.Platform,
  path: string | undefined,
  files: readonly string[],
): { readonly lookup: PathLookup; readonly asked: string[] } {
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

describe("searchPath on Windows: PATH's absolute entries only, never the folder git runs in", () => {
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
    expect(await searchPath('git', lookup)).toBe('C:\\Git\\cmd\\git.exe');
    expect(asked).toEqual(['C:\\Git\\cmd\\git.com', 'C:\\Git\\cmd\\git.exe']);
  });

  test('in each folder, <name>.com and then <name>.exe, as libuv tries them; the first folder wins', async () => {
    const { lookup } = lookupOn('win32', 'C:\\a;C:\\b', [
      'C:\\a\\git.exe',
      'C:\\a\\git.com',
      'C:\\b\\git.com',
    ]);
    expect(await searchPath('git', lookup)).toBe('C:\\a\\git.com');
    const later = lookupOn('win32', 'C:\\a;C:\\b', ['C:\\b\\git.exe']);
    expect(await searchPath('git', later.lookup)).toBe('C:\\b\\git.exe');
    const gh = lookupOn('win32', 'C:\\gh', ['C:\\gh\\gh.exe']);
    expect(await searchPath('gh', gh.lookup)).toBe('C:\\gh\\gh.exe');
    expect(gh.asked).toEqual(['C:\\gh\\gh.com', 'C:\\gh\\gh.exe']);
  });

  test("a quoted entry, a share, and a drive's root written with /", async () => {
    expect(
      await searchPath(
        'git',
        lookupOn('win32', '"C:\\Program Files\\Git\\cmd"', ['C:\\Program Files\\Git\\cmd\\git.exe'])
          .lookup,
      ),
    ).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(
      await searchPath(
        'git',
        lookupOn('win32', '\\\\tools\\git', ['\\\\tools\\git\\git.exe']).lookup,
      ),
    ).toBe('\\\\tools\\git\\git.exe');
    expect(
      await searchPath('git', lookupOn('win32', 'C:/Git/cmd', ['C:\\Git\\cmd\\git.exe']).lookup),
    ).toBe('C:\\Git\\cmd\\git.exe');
  });

  test('pathEntries: split at ;, a quoted part may hold one', () => {
    expect(pathEntries('win32', '"C:\\a;b";C:\\c;')).toEqual(['C:\\a;b', 'C:\\c', '']);
  });

  test('pathValue: PATH in any case, and of two spellings the one Node gives a child', () => {
    expect(pathValue('win32', { Path: 'C:\\Git\\cmd' })).toBe('C:\\Git\\cmd');
    expect(pathValue('win32', { path: 'C:\\b', PATH: 'C:\\a' })).toBe('C:\\a');
    expect(pathValue('win32', {})).toBe(undefined);
  });

  test('no PATH, or no git on it: undefined', async () => {
    expect(
      await searchPath('git', lookupOn('win32', undefined, ['C:\\Git\\cmd\\git.exe']).lookup),
    ).toBe(undefined);
    expect(await searchPath('git', lookupOn('win32', 'C:\\Git\\cmd', []).lookup)).toBe(undefined);
  });
});

describe("searchPath on Linux and macOS: an empty or relative entry is the folder git runs in, so it's skipped", () => {
  test('only /usr/bin/git is asked about', async () => {
    const { lookup, asked } = lookupOn('linux', '.::bin:/usr/bin', [
      'git',
      './git',
      'bin/git',
      '/usr/bin/git',
    ]);
    expect(await searchPath('git', lookup)).toBe('/usr/bin/git');
    expect(asked).toEqual(['/usr/bin/git']);
  });

  test('pathValue: PATH only, as spelled', () => {
    expect(pathValue('linux', { PATH: '/usr/bin' })).toBe('/usr/bin');
    expect(pathValue('linux', { Path: '/usr/bin' })).toBe(undefined);
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

describe.skipIf(process.platform === 'win32')("findOnPath doesn't keep a miss", () => {
  let bin: string;

  beforeEach(async () => {
    bin = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-path-')));
  });

  afterEach(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  test('a program put on PATH after a miss is found at the next call', async () => {
    const env = { PATH: bin };
    expect(await findOnPath('kindgi-tool', env)).toBe(undefined);
    await writeFile(join(bin, 'kindgi-tool'), '#!/bin/sh\n');
    await chmod(join(bin, 'kindgi-tool'), 0o755);
    expect(await findOnPath('kindgi-tool', env)).toBe(join(bin, 'kindgi-tool'));
  });

  test('no PATH: nothing is found', async () => {
    expect(await findOnPath('git', {})).toBe(undefined);
  });
});

describe('the CLI starts git only by the path findOnPath finds', () => {
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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/cli/src/** packages/handler-runtime/src/** packages/agents/src/**

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type PathLookup,
  type RunnableFs,
  findOnPath,
  namesFile,
  pathEntries,
  pathValue,
  programPath,
  runnable,
  searchPath,
} from '../src/program-path.js';

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

describe("searchPath on Windows: PATH's absolute entries only, never the folder the program runs in", () => {
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

  test('a name with an extension is asked about as given first; one ending in . takes .com and .exe without a second', async () => {
    const system = lookupOn('win32', 'C:\\Windows;C:\\Windows\\System32', [
      'C:\\Windows\\py.exe',
      'C:\\Windows\\System32\\notepad.exe',
    ]);
    expect(await searchPath('notepad.exe', system.lookup)).toBe(
      'C:\\Windows\\System32\\notepad.exe',
    );
    expect(await searchPath('py.exe', system.lookup)).toBe('C:\\Windows\\py.exe');
    expect(system.asked).toEqual([
      'C:\\Windows\\notepad.exe',
      'C:\\Windows\\notepad.exe.com',
      'C:\\Windows\\notepad.exe.exe',
      'C:\\Windows\\System32\\notepad.exe',
      'C:\\Windows\\py.exe',
    ]);
    const python = lookupOn('win32', 'C:\\Python', []);
    expect(await searchPath('python3.12', python.lookup)).toBe(undefined);
    expect(python.asked).toEqual([
      'C:\\Python\\python3.12',
      'C:\\Python\\python3.12.com',
      'C:\\Python\\python3.12.exe',
    ]);
    const dotted = lookupOn('win32', 'C:\\bin', []);
    expect(await searchPath('tool.', dotted.lookup)).toBe(undefined);
    expect(dotted.asked).toEqual(['C:\\bin\\tool.com', 'C:\\bin\\tool.exe']);
    const dot = lookupOn('win32', 'C:\\bin', ['C:\\bin\\.com']);
    expect(await searchPath('.', dot.lookup)).toBe(undefined);
    expect(dot.asked).toEqual([]);
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

describe("searchPath on Linux and macOS: an empty or relative entry is the folder the program runs in, so it's skipped", () => {
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

/** File reads where each of `files` is a file, a folder, or a link (to a file, to a folder, or one that can't be opened). */
function fakeFs(
  files: Readonly<
    Record<string, 'file' | 'folder' | 'link-to-file' | 'link-to-folder' | 'alias' | 'not-runnable'>
  >,
): RunnableFs {
  const missing = (file: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, stat '${file}'`), {
      code: 'ENOENT',
    });
  const kind = (file: string) => {
    const k = files[file];
    if (k === undefined) throw missing(file);
    return k;
  };
  return {
    lstat: async (file) => {
      const k = kind(file);
      return {
        isDirectory: () => k === 'folder',
        isSymbolicLink: () => k.startsWith('link-') || k === 'alias',
      };
    },
    stat: async (file) => {
      const k = kind(file);
      // A Store app's alias is a reparse point no one can open as a file.
      if (k === 'alias')
        throw Object.assign(new Error('UNKNOWN: unknown error, stat'), { code: 'UNKNOWN' });
      const folder = k === 'folder' || k === 'link-to-folder';
      return { isDirectory: () => folder, isFile: () => !folder };
    },
    access: async (file) => {
      if (kind(file) === 'not-runnable')
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  };
}

describe('runnable: what a platform runs when it finds it by name', () => {
  const fs = fakeFs({
    file: 'file',
    folder: 'folder',
    'link-to-file': 'link-to-file',
    'link-to-folder': 'link-to-folder',
    alias: 'alias',
    'not-runnable': 'not-runnable',
  });
  const on = async (platform: NodeJS.Platform, files: readonly string[]) =>
    Promise.all(files.map(async (file) => [file, await runnable(platform, file, fs)] as const));

  test("Windows: libuv's test, there and not a folder, without following a link (a Store app's python.exe runs)", async () => {
    expect(
      await on('win32', [
        'file',
        'not-runnable',
        'link-to-file',
        'alias',
        'folder',
        'link-to-folder',
        'nothing',
      ]),
    ).toEqual([
      ['file', true],
      ['not-runnable', true],
      ['link-to-file', true],
      ['alias', true],
      ['folder', false],
      ['link-to-folder', false],
      ['nothing', false],
    ]);
  });

  test('Linux and macOS: a file, or a link to one, that may be run', async () => {
    expect(
      await on('linux', ['file', 'link-to-file', 'not-runnable', 'alias', 'folder', 'nothing']),
    ).toEqual([
      ['file', true],
      ['link-to-file', true],
      ['not-runnable', false],
      ['alias', false],
      ['folder', false],
      ['nothing', false],
    ]);
  });
});

test("namesFile: a command with a folder in it is a path, as libuv reads one; on Windows a drive's ':' too", () => {
  for (const command of ['python', 'python3.12', 'uv']) {
    expect(namesFile('win32', command)).toBe(false);
    expect(namesFile('linux', command)).toBe(false);
  }
  for (const command of ['C:python.exe', '.\\python', 'tools/python', 'C:\\Python\\python.exe']) {
    expect(namesFile('win32', command)).toBe(true);
  }
  expect(namesFile('linux', './python')).toBe(true);
  expect(namesFile('linux', '/usr/bin/python3')).toBe(true);
  expect(namesFile('linux', 'a\\b')).toBe(false);
  expect(namesFile('linux', 'C:python')).toBe(false);
});

describe.skipIf(process.platform === 'win32')('findOnPath and programPath', () => {
  let bin: string;

  beforeEach(async () => {
    bin = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-path-')));
  });

  afterEach(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  const install = async (name: string) => {
    await writeFile(join(bin, name), '#!/bin/sh\n');
    await chmod(join(bin, name), 0o755);
  };

  test('a program put on PATH after a miss is found at the next call', async () => {
    const env = { PATH: bin };
    expect(await findOnPath('kindgi-tool', env)).toBe(undefined);
    await install('kindgi-tool');
    expect(await findOnPath('kindgi-tool', env)).toBe(join(bin, 'kindgi-tool'));
  });

  test('no PATH: nothing is found', async () => {
    expect(await findOnPath('git', {})).toBe(undefined);
  });

  test("a bare name is the file on the child's PATH, not this process's", async () => {
    await install('kindgi-tool');
    expect(await programPath('kindgi-tool', { PATH: ['', '.', 'bin', bin].join(':') })).toBe(
      join(bin, 'kindgi-tool'),
    );
    await expect(programPath('kindgi-tool', { PATH: '/nowhere' })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('a path, and an empty command, come back as given: libuv searches PATH for neither', async () => {
    const env = { PATH: bin };
    for (const command of ['/usr/bin/env', './kindgi-tool', '.venv/bin/python', '']) {
      expect(await programPath(command, env)).toBe(command);
    }
  });

  test("a program that isn't on PATH: Node's own spawn error, so a caller's not-found path reads as it did", async () => {
    const error = await programPath('kindgi-none', { PATH: bin }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'spawn kindgi-none ENOENT',
      code: 'ENOENT',
      syscall: 'spawn kindgi-none',
      path: 'kindgi-none',
    });
    await expect(programPath('kindgi-none', {})).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test("one on PATH it may not run: spawn's EACCES, unless a later entry holds one it may", async () => {
    const later = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-path-')));
    try {
      await writeFile(join(bin, 'kindgi-tool'), '#!/bin/sh\n');
      await chmod(join(bin, 'kindgi-tool'), 0o644);
      await mkdir(join(bin, 'kindgi-dir'));
      for (const name of ['kindgi-tool', 'kindgi-dir']) {
        expect(await programPath(name, { PATH: bin }).catch((e: unknown) => e)).toMatchObject({
          message: `spawn ${name} EACCES`,
          code: 'EACCES',
          syscall: `spawn ${name}`,
          path: name,
        });
      }
      // In a relative entry, it's the folder the program runs in: not looked at.
      await expect(
        programPath('kindgi-tool', { PATH: relative(process.cwd(), bin) }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(join(later, 'kindgi-tool'), '#!/bin/sh\n');
      await chmod(join(later, 'kindgi-tool'), 0o755);
      expect(await programPath('kindgi-tool', { PATH: [bin, later].join(':') })).toBe(
        join(later, 'kindgi-tool'),
      );
    } finally {
      await rm(later, { recursive: true, force: true });
    }
  });
});

// The scan: every child the CLI starts goes through programPath (or, for
// git, findOnPath). A literal first argument is a bare name; a variable one
// can't be read here, so a file that starts children must import the
// lookup, or be listed below with why it needs none.

const CALL =
  /(?:(?<![\w$])(?:[\w$]+\.)?(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)|(?<![\w$.])exec)\(\s*['"`]/;
const CHILD_PROCESS = /['"](?:node:)?child_process['"]/;
const LOOKUP = /from '(?:\.\.?\/)+program-path\.js'/;
/** A name a file gives a child_process function: `spawn as nodeSpawn`, `run = promisify(execFile)`. */
const ALIAS =
  /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s+as\s+([\w$]+)|([\w$]+)\s*=\s*promisify\(\s*(?:[\w$]+\.)?(?:execFile|exec)\s*\)/g;

/** Whether `text` starts a program by a literal name, by a function's own name or its alias. */
function startsByName(text: string): boolean {
  if (CALL.test(text)) return true;
  return [...text.matchAll(ALIAS)].some((match) => {
    const alias = (match[1] ?? match[2] ?? '').replaceAll('$', '\\$');
    return new RegExp(`(?<![\\w$.])${alias}\\(\\s*['"\`]`).test(text);
  });
}

/** Files that start children with no lookup, and why. */
const NO_LOOKUP: Readonly<Record<string, string>> = {
  'templates/woocommerce/scripts/connect-store.mjs.tmpl':
    "a script in the pack, which can't import the CLI: its own onPath does the same",
};

async function sources(pkg: string): Promise<{ readonly file: string; readonly text: string }[]> {
  const src = fileURLToPath(new URL(`../../${pkg}/src/`, import.meta.url));
  const files = (await readdir(src, { recursive: true }))
    .filter((file) => (file.endsWith('.ts') && !file.endsWith('.d.ts')) || file.endsWith('.tmpl'))
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      file: file.split('\\').join('/'),
      text: await readFile(join(src, file), 'utf8'),
    })),
  );
}

describe('every child is started by the path found on PATH', () => {
  test('the scan sees a bare name, and a file that starts children without the lookup', () => {
    expect(CALL.test("const child = spawn('docker', args);")).toBe(true);
    expect(CALL.test('execFile(\n  `ps`,')).toBe(true);
    expect(CALL.test('cp.execFile("git", [])')).toBe(true);
    expect(CALL.test('spawn(file, args)')).toBe(false);
    expect(CALL.test("PATTERN.exec('text')")).toBe(false);
    expect(CALL.test("spawnOutcome('docker', args)")).toBe(false);
    expect(
      startsByName(
        "import { spawn as nodeSpawn } from 'node:child_process';\nnodeSpawn('npx', args);",
      ),
    ).toBe(true);
    expect(
      startsByName("const run = promisify(cp.execFile);\nawait run(\n  'git', ['status']);"),
    ).toBe(true);
    expect(startsByName('const run = promisify(execFile);\nawait run(process.execPath, []);')).toBe(
      false,
    );
    expect(
      startsByName(
        "import { spawn as nodeSpawn } from 'node:child_process';\nconst deps = { spawn: nodeSpawn };",
      ),
    ).toBe(false);
    expect(CHILD_PROCESS.test("import { spawn } from 'node:child_process';")).toBe(true);
    expect(LOOKUP.test("import { programPath } from '../../program-path.js';")).toBe(true);
  });

  test.each(['cli', 'handler-runtime', 'agents'])(
    '%s: no source starts a program by a literal name',
    async (pkg) => {
      const bare = (await sources(pkg))
        .filter(({ text }) => startsByName(text))
        .map(({ file }) => file);
      expect(bare).toEqual([]);
    },
  );

  test('cli: each file that starts children imports the lookup, or says why it needs none', async () => {
    const files = (await sources('cli')).filter(({ text }) => CHILD_PROCESS.test(text));
    expect(files.length).toBeGreaterThan(10);
    const without = files
      .filter(({ file, text }) => !LOOKUP.test(text) && NO_LOOKUP[file] === undefined)
      .map(({ file }) => file);
    expect(without).toEqual([]);
    // A file listed there that no longer starts a child is taken off.
    const starting = new Set(files.map(({ file }) => file));
    expect(Object.keys(NO_LOOKUP).filter((file) => !starting.has(file))).toEqual([]);
  });
});

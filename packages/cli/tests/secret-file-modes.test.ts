// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The files the CLI keeps a key or token in, on a real disk: owner-only,
 * an older looser one included. Windows has no such modes.
 */

import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { saveHomeConfig } from '../src/config.js';
import { writeRuntimeEnv } from '../src/dev/runtime-env.js';
import { REAL_ENV_RUNNERS } from '../src/env/defaults.js';
import { REAL_KEY_RUNNERS } from '../src/key/defaults.js';
import { runCli } from '../src/main.js';
import { writePrivateFile } from '../src/private-file.js';

/** On, the next renames fail: a rename is the one step a real disk won't fail on cue. */
const renames = vi.hoisted(() => ({ fail: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (renames.fail) throw new Error(`the rename of ${from} failed`);
      return real.rename(from, to);
    },
  };
});

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe.skipIf(process.platform === 'win32')('~/.kindgi/config.json', () => {
  test('`kindgi auth login` writes it 0600, in a ~/.kindgi it makes 0700', async () => {
    const out = await runCli({
      argv: ['auth', 'login', '--url=https://platform.example.com', '--token=kgi_tk_acme'],
      env: {},
      home,
      cwd,
    });
    expect(out.exitCode).toBe(0);
    const path = join(home, '.kindgi', 'config.json');
    expect(await modeOf(path)).toBe(0o600);
    expect(await modeOf(join(home, '.kindgi'))).toBe(0o700);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      apiUrl: 'https://platform.example.com',
      token: 'kgi_tk_acme',
    });
  });

  test('over an old 0644 file in a 0755 folder: a new 0600 file replaces it, the folder is set to 0700, the other keys kept', async () => {
    const dir = join(home, '.kindgi');
    const path = join(dir, 'config.json');
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    await writeFile(
      path,
      JSON.stringify({ apiUrl: 'https://old.example.com', token: 'kgi_tk_old', theme: 'dark' }),
    );
    await chmod(path, 0o644);
    // Another program that opened the old file keeps the old file, not the new key.
    const held = await open(path, 'r');
    try {
      await saveHomeConfig({ apiUrl: 'https://platform.example.com', token: 'kgi_tk_acme' }, home);
      const seen = await held.readFile('utf8');
      expect(seen).toContain('kgi_tk_old');
      expect(seen).not.toContain('kgi_tk_acme');
      expect((await held.stat()).mode & 0o777).toBe(0o644);
    } finally {
      await held.close();
    }

    expect(await modeOf(path)).toBe(0o600);
    expect(await modeOf(dir)).toBe(0o700);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      apiUrl: 'https://platform.example.com',
      token: 'kgi_tk_acme',
      theme: 'dark',
    });
  });

  test('a symlinked one stays a link: the old 0644 file it points to is replaced, 0600, the other keys kept', async () => {
    const dir = join(home, '.kindgi');
    const path = join(dir, 'config.json');
    const linked = join(cwd, 'kindgi-config.json');
    await mkdir(dir, { mode: 0o700 });
    await writeFile(
      linked,
      JSON.stringify({ apiUrl: 'https://old.example.com', token: 'kgi_tk_old', theme: 'dark' }),
    );
    await chmod(linked, 0o644);
    await symlink(linked, path);

    await saveHomeConfig({ apiUrl: 'https://platform.example.com', token: 'kgi_tk_acme' }, home);

    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await modeOf(linked)).toBe(0o600);
    expect(JSON.parse(await readFile(linked, 'utf8'))).toEqual({
      apiUrl: 'https://platform.example.com',
      token: 'kgi_tk_acme',
      theme: 'dark',
    });
    expect(await readdir(cwd)).toEqual(['kindgi-config.json']);
  });
});

describe.skipIf(process.platform === 'win32')('~/.kindgi/keys', () => {
  test('`kindgi key create` makes the folder 0700 and the private key 0600', async () => {
    const out = await runCli({ argv: ['key', 'create', 'acme-signer'], env: {}, home, cwd });
    expect(out.exitCode).toBe(0);
    const keys = join(home, '.kindgi', 'keys');
    expect(await modeOf(keys)).toBe(0o700);
    expect(await modeOf(join(keys, 'acme-signer.pem'))).toBe(0o600);
    expect(await modeOf(join(keys, 'acme-signer.pub.pem'))).toBe(0o644);
  });

  test('a keys folder made 0755 before is set to 0700', async () => {
    const keys = join(home, '.kindgi', 'keys');
    await mkdir(keys, { recursive: true, mode: 0o755 });
    await chmod(keys, 0o755);
    await REAL_KEY_RUNNERS.mkdir(keys, 0o700);
    expect(await modeOf(keys)).toBe(0o700);
  });
});

describe.skipIf(process.platform === 'win32')(
  "a pack's env file, as `kindgi env` writes it",
  () => {
    test('a new one is 0600; one already there keeps its mode', async () => {
      const created = join(cwd, '.env.prod');
      await REAL_ENV_RUNNERS.writeFile(created, 'WOO_USER=shop-agent\n');
      expect(await modeOf(created)).toBe(0o600);

      const kept = join(cwd, '.env.staging');
      await writeFile(kept, 'WOO_USER=old\n');
      await chmod(kept, 0o640);
      await REAL_ENV_RUNNERS.writeFile(kept, 'WOO_USER=shop-agent\n');
      expect(await modeOf(kept)).toBe(0o640);
      expect(await readFile(kept, 'utf8')).toBe('WOO_USER=shop-agent\n');
    });
  },
);

describe.skipIf(process.platform === 'win32')("`kindgi dev`'s .kindgi/dev/runtime.env", () => {
  test('a new one is 0600; an old 0644 one is replaced by a new 0600 file', async () => {
    const path = join(cwd, '.kindgi', 'dev', 'runtime.env');
    await writeRuntimeEnv(path, { ACME_TOKEN: 'old' });
    expect(await modeOf(path)).toBe(0o600);
    await chmod(path, 0o644);
    // Another program that opened the old file keeps the old file, not the new token.
    const held = await open(path, 'r');
    try {
      await writeRuntimeEnv(path, { ACME_TOKEN: 'acme' });
      const seen = await held.readFile('utf8');
      expect(seen).toContain('ACME_TOKEN=old\n');
      expect(seen).not.toContain('ACME_TOKEN=acme');
      expect((await held.stat()).mode & 0o777).toBe(0o644);
    } finally {
      await held.close();
    }
    expect(await modeOf(path)).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain('ACME_TOKEN=acme\n');
  });
});

describe.skipIf(process.platform === 'win32')('writePrivateFile', () => {
  test('a rename that fails leaves the old file as it was, and no temp file', async () => {
    const path = join(cwd, 'config.json');
    await writeFile(path, '{"token":"kgi_tk_old"}\n');
    renames.fail = true;
    try {
      await expect(writePrivateFile(path, '{}\n')).rejects.toThrow(/the rename of .+ failed/);
    } finally {
      renames.fail = false;
    }
    expect(await readFile(path, 'utf8')).toBe('{"token":"kgi_tk_old"}\n');
    expect(await readdir(cwd)).toEqual(['config.json']);
  });

  test("a folder, or a link to a pipe, isn't a regular file: refused and left as it is, with no temp file", async () => {
    const refused = /isn't a regular file, so it was left as it is\./;
    const folder = join(cwd, 'config.json');
    await mkdir(folder);
    await expect(writePrivateFile(folder, '{}\n')).rejects.toThrow(refused);
    // A rename over the pipe would put a file in its place.
    const pipe = join(cwd, 'pipe');
    execFileSync('mkfifo', [pipe]);
    const link = join(cwd, 'kindgi-config.json');
    await symlink(pipe, link);
    await expect(writePrivateFile(link, '{}\n')).rejects.toThrow(refused);
    expect((await lstat(pipe)).isFIFO()).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await readdir(cwd)).sort()).toEqual(['config.json', 'kindgi-config.json', 'pipe']);
  });
});

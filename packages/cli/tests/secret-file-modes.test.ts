// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The files the CLI keeps a key or token in, on a real disk: owner-only,
 * an older looser one included. Windows has no such modes.
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { saveHomeConfig } from '../src/config.js';
import { REAL_ENV_RUNNERS } from '../src/env/defaults.js';
import { REAL_KEY_RUNNERS } from '../src/key/defaults.js';
import { runCli } from '../src/main.js';
import { writePrivateFile } from '../src/private-file.js';

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

describe.skipIf(process.platform === 'win32')('writePrivateFile', () => {
  test('a write that fails leaves what was there, and no temp file', async () => {
    // A folder where the file goes: the rename onto it fails.
    const path = join(cwd, 'config.json');
    await mkdir(path);
    await expect(writePrivateFile(path, '{}\n')).rejects.toThrow();
    expect(await readdir(cwd)).toEqual(['config.json']);
  });
});

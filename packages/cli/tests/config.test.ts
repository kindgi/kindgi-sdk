// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';

const CWD = '/work/acme-pack';
const HOME = '/home/acme';
const HOME_FILE = join(HOME, '.kindgi', 'config.json');
const FOLDER_FILE = join(CWD, '.kindgirc.json');
const SIGNED_IN = 'https://platform.example.com';
const OTHER = 'https://other.example.com';

/** loadConfig over these files (path → contents); the others aren't there. */
function load(
  files: Record<string, Record<string, unknown>>,
  extra: { env?: Record<string, string>; flagUrl?: string; flagToken?: string } = {},
) {
  return loadConfig({
    cwd: CWD,
    home: HOME,
    env: extra.env ?? {},
    ...(extra.flagUrl !== undefined && { flagUrl: extra.flagUrl }),
    ...(extra.flagToken !== undefined && { flagToken: extra.flagToken }),
    readFile: async (path) => (files[path] !== undefined ? JSON.stringify(files[path]) : null),
  });
}

describe('loadConfig: which file each value came from, and the address stored with the key', () => {
  test('a sign-in: both from the home file; the key is for its address', async () => {
    const config = await load({ [HOME_FILE]: { apiUrl: SIGNED_IN, token: 'kgi_tk_home' } });
    expect(config).toEqual({
      apiUrl: SIGNED_IN,
      token: 'kgi_tk_home',
      source: { apiUrl: 'file', token: 'file' },
      files: {
        apiUrl: { path: HOME_FILE, kind: 'home' },
        token: { path: HOME_FILE, kind: 'home' },
      },
      keyAddress: SIGNED_IN,
      storedKeys: [
        { token: 'kgi_tk_home', apiUrl: SIGNED_IN, file: { path: HOME_FILE, kind: 'home' } },
      ],
    });
  });

  test("a folder file's apiUrl over the home one: the key stays for the address in its own file", async () => {
    const config = await load({
      [HOME_FILE]: { apiUrl: SIGNED_IN, token: 'kgi_tk_home' },
      [FOLDER_FILE]: { apiUrl: OTHER },
    });
    expect(config.apiUrl).toBe(OTHER);
    expect(config.files).toEqual({
      apiUrl: { path: FOLDER_FILE, kind: 'folder' },
      token: { path: HOME_FILE, kind: 'home' },
    });
    expect(config.keyAddress).toBe(SIGNED_IN);
  });

  test('a key in a file with no address: no key address', async () => {
    const config = await load({
      [HOME_FILE]: { apiUrl: SIGNED_IN, token: 'kgi_tk_home' },
      [FOLDER_FILE]: { token: 'kgi_tk_folder' },
    });
    expect(config.token).toBe('kgi_tk_folder');
    expect(config.files?.token).toEqual({ path: FOLDER_FILE, kind: 'folder' });
    expect(config.keyAddress).toBeUndefined();
  });

  test('a key or an address given for the command: no file, no key address', async () => {
    const config = await load(
      { [HOME_FILE]: { apiUrl: SIGNED_IN, token: 'kgi_tk_home' } },
      { env: { KINDGI_API_URL: OTHER }, flagToken: 'kgi_tk_flag' },
    );
    expect(config).toEqual({
      apiUrl: OTHER,
      token: 'kgi_tk_flag',
      source: { apiUrl: 'env', token: 'flag' },
    });
  });
});

describe("loadConfig: a folder's .kindgirc.json for a `kindgi dev` runtime", () => {
  test.each(['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000'])(
    'at %s: it wins, and the config without it is there for --hosted',
    async (local) => {
      const config = await load({
        [HOME_FILE]: { apiUrl: SIGNED_IN, token: 'kgi_tk_home' },
        [FOLDER_FILE]: { apiUrl: local, token: 'kgi_tk_dev' },
      });
      expect(config).toMatchObject({ apiUrl: local, token: 'kgi_tk_dev', keyAddress: local });
      expect(config.devRuntime).toEqual({
        file: FOLDER_FILE,
        apiUrl: local,
        without: {
          apiUrl: SIGNED_IN,
          token: 'kgi_tk_home',
          source: { apiUrl: 'file', token: 'file' },
          files: {
            apiUrl: { path: HOME_FILE, kind: 'home' },
            token: { path: HOME_FILE, kind: 'home' },
          },
          keyAddress: SIGNED_IN,
          storedKeys: [
            { token: 'kgi_tk_home', apiUrl: SIGNED_IN, file: { path: HOME_FILE, kind: 'home' } },
          ],
        },
      });
    },
  );

  test('flag and env values stay in the config without it', async () => {
    const config = await load(
      { [FOLDER_FILE]: { apiUrl: 'http://127.0.0.1:4000', token: 'kgi_tk_dev' } },
      { env: { KINDGI_API_TOKEN: 'kgi_tk_env' }, flagUrl: OTHER },
    );
    expect(config.devRuntime?.without).toEqual({
      apiUrl: OTHER,
      token: 'kgi_tk_env',
      source: { apiUrl: 'flag', token: 'env' },
    });
  });

  test.each([
    { packServicePort: 4100, packServiceToken: 'kgi_ps_dev' },
    { packServicePort: 4100 },
    { packServiceToken: 'kgi_ps_dev' },
  ])(
    'one `kindgi dev` wrote (%j beside it), at another address (`--runtime-url`): the same',
    async (devFields) => {
      const devRuntime = 'http://192.168.1.20:4000';
      const config = await load({
        [HOME_FILE]: { apiUrl: SIGNED_IN, token: 'kgi_tk_home' },
        [FOLDER_FILE]: { apiUrl: devRuntime, token: 'kgi_tk_dev', ...devFields },
      });
      expect(config).toMatchObject({ apiUrl: devRuntime, token: 'kgi_tk_dev' });
      expect(config.devRuntime).toMatchObject({
        file: FOLDER_FILE,
        apiUrl: devRuntime,
        without: { apiUrl: SIGNED_IN, token: 'kgi_tk_home', keyAddress: SIGNED_IN },
      });
    },
  );

  test("a folder file at any other address, with nothing of `kindgi dev`'s, is read as it is", async () => {
    const config = await load({
      [HOME_FILE]: { apiUrl: SIGNED_IN, token: 'kgi_tk_home' },
      [FOLDER_FILE]: { apiUrl: OTHER, token: 'kgi_tk_folder', packServicePort: '4100' },
    });
    expect(config).toMatchObject({ apiUrl: OTHER, token: 'kgi_tk_folder', keyAddress: OTHER });
    expect(config.devRuntime).toBeUndefined();
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

/**
 * A stored key (`kindgi auth login`'s ~/.kindgi/config.json, or a folder's
 * .kindgirc.json) goes only to the address stored beside it, on every
 * command, and the key for an address is found by it. A key given for the
 * command (`--token`, KINDGI_API_TOKEN) goes where the command says.
 */

const SIGNED_IN = 'https://platform.example.com';
const OTHER = 'https://other.example.com';
/** The signed-in server under another name. */
const ALIAS = 'https://10.0.0.5';
const DEV = 'http://127.0.0.1:4000';
const HOME_KEY = 'kgi_tk_home_never_printed';
const DEV_KEY = 'kgi_tk_dev_never_printed';
const FOLDER_KEY = 'kgi_tk_folder_never_printed';
const GIVEN_KEY = 'kgi_tk_given_never_printed';
const STORED_KEYS = [HOME_KEY, DEV_KEY, FOLDER_KEY];

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-key-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-key-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const homeFile = () => join(home, '.kindgi', 'config.json');
const folderFile = () => join(cwd, '.kindgirc.json');

async function signedIn(values: Record<string, unknown> = { apiUrl: SIGNED_IN, token: HOME_KEY }) {
  await mkdir(join(home, '.kindgi'), { recursive: true });
  await writeFile(homeFile(), JSON.stringify(values));
}

async function inFolder(values: Record<string, unknown>) {
  await writeFile(folderFile(), JSON.stringify(values));
}

/** `kindgi dev`'s file: its runtime's address and key, and the pack service's port. */
const devFolder = () => inFolder({ apiUrl: DEV, token: DEV_KEY, packServicePort: 4100 });

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
}

/** The CLI, with a fetch that answers 200 and keeps each request's URL and Authorization. */
async function cli(argv: readonly string[], env: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const out = await runCli({
    argv,
    env,
    cwd,
    home,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ tenantId: 't-1', status: 'ok' }), { status: 200 });
    }) as typeof fetch,
  });
  return { ...out, sent };
}

/** Nothing the CLI printed holds a key. */
function printsNoKey(out: { stdout: string; stderr: string }) {
  for (const key of [...STORED_KEYS, GIVEN_KEY]) {
    expect(out.stdout).not.toContain(key);
    expect(out.stderr).not.toContain(key);
  }
}

describe('a key given for the command goes where the command says', () => {
  test.each([
    ['in the env (CI)', [], { KINDGI_API_URL: OTHER, KINDGI_API_TOKEN: GIVEN_KEY }],
    ['as flags', [`--url=${OTHER}`, `--token=${GIVEN_KEY}`], {}],
  ])('the address and the key %s, whatever is signed in: both go', async (_, flags, env) => {
    await signedIn();
    const out = await cli(['auth', 'whoami', ...flags], env);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual([
      { url: `${OTHER}/v1/identity/whoami`, authorization: `Bearer ${GIVEN_KEY}` },
    ]);
  });

  test('--token with the signed-in address: the given key goes there', async () => {
    await signedIn();
    const out = await cli(['auth', 'whoami', `--token=${GIVEN_KEY}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual([
      { url: `${SIGNED_IN}/v1/identity/whoami`, authorization: `Bearer ${GIVEN_KEY}` },
    ]);
  });
});

describe('a stored key goes to its own address', () => {
  test.each(['https://PLATFORM.example.com/', 'https://platform.example.com:443'])(
    'signed in, then the same address exported as %s: the key goes there',
    async (same) => {
      await signedIn();
      const out = await cli(['auth', 'whoami'], { KINDGI_API_URL: same });
      expect(out.exitCode, out.stderr).toBe(0);
      expect(out.sent).toHaveLength(1);
      expect(out.sent[0]?.authorization).toBe(`Bearer ${HOME_KEY}`);
    },
  );

  test("inside a `kindgi dev` folder: the folder's key to its own runtime", async () => {
    await signedIn();
    await devFolder();
    const out = await cli(['auth', 'whoami']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual([
      { url: `${DEV}/v1/identity/whoami`, authorization: `Bearer ${DEV_KEY}` },
    ]);
  });

  test("in a `kindgi dev` folder, --url at the signed-in address: the key signed in for it, not the folder's", async () => {
    await signedIn();
    await devFolder();
    const out = await cli(['auth', 'whoami', `--url=${SIGNED_IN}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual([
      { url: `${SIGNED_IN}/v1/identity/whoami`, authorization: `Bearer ${HOME_KEY}` },
    ]);
  });
});

describe('a stored key for another address is refused before anything is sent', () => {
  test.each([
    ['--url', [`--url=${OTHER}`], {}, () => Promise.resolve()],
    ['KINDGI_API_URL', [], { KINDGI_API_URL: OTHER }, () => Promise.resolve()],
    // A cloned repo's file can name the address: nobody typed it.
    ['<folder>', [], {}, () => inFolder({ apiUrl: OTHER })],
  ])(
    'named by %s: naming both addresses, the file and the fixes',
    async (named, flags, env, setUp) => {
      await signedIn();
      await setUp();
      const where = named === '<folder>' ? `the apiUrl in ${folderFile()}` : named;
      const out = await cli(['auth', 'whoami', ...flags], env);
      expect(out.exitCode).toBe(1);
      expect(out.sent).toEqual([]);
      expect(out.stderr).toContain(
        `kindgi auth whoami would send the API key stored in ${homeFile()}, which is for ${SIGNED_IN}, to ${OTHER}, which ${where} names. The key goes only to its own address: point ${where} at ${SIGNED_IN}, sign in to ${OTHER} with \`kindgi auth login --url ${OTHER} --token <its key>\`, or give that server's key with --token or KINDGI_API_TOKEN.`,
      );
      printsNoKey(out);
    },
  );

  test("an SDK client's command the same: refused before the client is made", async () => {
    await signedIn();
    const made: string[] = [];
    const out = await runCli({
      argv: ['runs', 'list', `--url=${OTHER}`],
      env: {},
      cwd,
      home,
      clientFactory: (url) => {
        made.push(url);
        throw new Error('no client in this test');
      },
    });
    expect(out.exitCode).toBe(1);
    expect(made).toEqual([]);
    expect(out.stderr).toContain(
      `kindgi runs list would send the API key stored in ${homeFile()}, which is for ${SIGNED_IN}, to ${OTHER}, which --url names.`,
    );
    printsNoKey(out);
  });

  test('another name for the same server: refused, then one `kindgi auth login` under that name', async () => {
    await signedIn();
    const refused = await cli(['auth', 'whoami', `--url=${ALIAS}`]);
    expect(refused.exitCode).toBe(1);
    expect(refused.sent).toEqual([]);
    expect(refused.stderr).toContain(`which is for ${SIGNED_IN}, to ${ALIAS}, which --url names.`);

    const login = await cli(['auth', 'login', `--url=${ALIAS}`], { KINDGI_API_TOKEN: HOME_KEY });
    expect(login.exitCode, login.stderr).toBe(0);
    const out = await cli(['auth', 'whoami', `--url=${ALIAS}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual([
      { url: `${ALIAS}/v1/identity/whoami`, authorization: `Bearer ${HOME_KEY}` },
    ]);
  });

  test('a hand-written ~/.kindgi/config.json with only a key, and KINDGI_API_URL: refused, saying to add its address', async () => {
    await signedIn({ token: HOME_KEY });
    const out = await cli(['auth', 'whoami'], { KINDGI_API_URL: SIGNED_IN });
    expect(out.exitCode).toBe(1);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toContain(
      `kindgi auth whoami would send the API key stored in ${homeFile()} to ${SIGNED_IN}, and no address is stored with that key, so nothing shows it's for ${SIGNED_IN}. The key goes only to its own address: add "apiUrl": "${SIGNED_IN}" beside it in ${homeFile()}, if it's that server's key,`,
    );
    printsNoKey(out);
  });

  test("a folder file with only a key: refused, never swapped for the home sign-in's", async () => {
    await signedIn();
    await inFolder({ token: FOLDER_KEY });
    const out = await cli(['auth', 'whoami']);
    expect(out.exitCode).toBe(1);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toContain(
      `would send the API key stored in ${folderFile()} to ${SIGNED_IN}, and no address is stored with that key`,
    );
    printsNoKey(out);
  });

  test('in a `kindgi dev` folder, an address no key is stored for: refused, saying where each key is for', async () => {
    await signedIn();
    await devFolder();
    const out = await cli(['auth', 'whoami', `--url=${OTHER}`]);
    expect(out.exitCode).toBe(1);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toContain(
      `kindgi auth whoami would send the API key stored in ${folderFile()}, which is for ${DEV}, to ${OTHER}, which --url names. ${homeFile()} has one for ${SIGNED_IN}, and none is stored for ${OTHER}. The key goes only to its own address:`,
    );
    printsNoKey(out);
  });

  test('a command that sends no key is not refused: it goes to the address, without one', async () => {
    await signedIn();
    const out = await cli(['health', `--url=${OTHER}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0]?.url.startsWith(OTHER)).toBe(true);
    expect(out.sent[0]?.authorization).toBeNull();
  });
});

describe('kindgi auth login saves a stored key only for its own address', () => {
  test.each([
    ['--url', [`--url=${OTHER}`], {}],
    ['KINDGI_API_URL', [], { KINDGI_API_URL: OTHER }],
  ])(
    'another address by %s, with no key given: refused (exit 2), the file as it was',
    async (_, flags, env) => {
      await signedIn();
      const before = await readFile(homeFile(), 'utf8');
      const out = await cli(['auth', 'login', ...flags], env);
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(
        `kindgi auth login would save the API key stored in ${homeFile()}, which is for ${SIGNED_IN}, as ${OTHER}'s key. A stored key goes only to its own address: give ${OTHER}'s key with --token or KINDGI_API_TOKEN.`,
      );
      expect(await readFile(homeFile(), 'utf8')).toBe(before);
      printsNoKey(out);
    },
  );

  test('an address, for a stored key with none beside it: refused, the file as it was', async () => {
    await signedIn({ token: HOME_KEY });
    const before = await readFile(homeFile(), 'utf8');
    const out = await cli(['auth', 'login', `--url=${SIGNED_IN}`]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      `kindgi auth login would save the API key stored in ${homeFile()}, which has no address stored with it, as ${SIGNED_IN}'s key.`,
    );
    expect(await readFile(homeFile(), 'utf8')).toBe(before);
    printsNoKey(out);
  });

  test.each([
    ['--token', [`--token=${GIVEN_KEY}`], {}],
    ['KINDGI_API_TOKEN', [], { KINDGI_API_TOKEN: GIVEN_KEY }],
  ])('another address, with its key given by %s: saved for it', async (_, flags, env) => {
    await signedIn();
    const out = await cli(['auth', 'login', `--url=${OTHER}`, ...flags], env);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(await readFile(homeFile(), 'utf8'))).toEqual({
      apiUrl: OTHER,
      token: GIVEN_KEY,
    });
  });

  test('again at its own address, with no key given: saved as it was', async () => {
    await signedIn();
    const out = await cli(['auth', 'login']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(await readFile(homeFile(), 'utf8'))).toEqual({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
    });
  });
});

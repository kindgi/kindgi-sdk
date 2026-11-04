// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

/**
 * Kindgi login profiles: named logins in ~/.kindgi/config.json, beside the
 * login without a name. A command goes on one only when it names it
 * (`--profile`, or KINDGI_PROFILE for a shell), a profile's key is never
 * found by its address, and `kindgi auth login --profile`, `list` and
 * `logout` save, show and remove them.
 */

const SIGNED_IN = 'https://platform.example.com';
const PROD = 'https://prod.example.com';
const STAGING = 'https://staging.example.com';
const OTHER = 'https://other.example.com';
const DEV = 'http://127.0.0.1:4000';
const HOME_KEY = 'kgi_tk_home_never_printed';
const PROD_KEY = 'kgi_tk_prod_never_printed';
const STAGING_KEY = 'kgi_tk_staging_never_printed';
const DEV_KEY = 'kgi_tk_dev_never_printed';
const GIVEN_KEY = 'kgi_tk_given_never_printed';
const KEYS = [HOME_KEY, PROD_KEY, STAGING_KEY, DEV_KEY, GIVEN_KEY];

const NAME_RULE = 'lowercase letters, digits and -, 1 to 32 characters, starting with a letter';

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-profile-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-profile-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const homeFile = () => join(home, '.kindgi', 'config.json');
const folderFile = () => join(cwd, '.kindgirc.json');

const prod = { apiUrl: PROD, token: PROD_KEY };
const staging = { apiUrl: STAGING, token: STAGING_KEY };

async function homeHolds(values: Record<string, unknown>) {
  await mkdir(join(home, '.kindgi'), { recursive: true });
  await writeFile(homeFile(), JSON.stringify(values));
}

/** The login without a name, and the profiles prod and staging. */
const signedInWithProfiles = () =>
  homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY, profiles: { prod, staging } });

const homeNow = async () => JSON.parse(await readFile(homeFile(), 'utf8')) as unknown;

/** `kindgi dev`'s file: its runtime's address and key, and the pack service's port. */
const devFolder = () =>
  writeFile(folderFile(), JSON.stringify({ apiUrl: DEV, token: DEV_KEY, packServicePort: 4100 }));

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
}

/**
 * The CLI, with a fetch that answers 200 and keeps each request's URL and
 * Authorization; `stdin` is what `--token-stdin` reads (a function to
 * make the read fail).
 */
async function cli(
  argv: readonly string[],
  env: Record<string, string> = {},
  stdin?: string | (() => Promise<string>),
) {
  const sent: Sent[] = [];
  const readStdin = typeof stdin === 'string' ? async () => stdin : stdin;
  const out = await runCli({
    argv,
    env,
    cwd,
    home,
    ...(readStdin !== undefined && { authLoginSeam: { readStdin } }),
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
  for (const key of KEYS) {
    expect(out.stdout).not.toContain(key);
    expect(out.stderr).not.toContain(key);
  }
}

const whoamiAt = (url: string, key: string): Sent[] => [
  { url: `${url}/v1/identity/whoami`, authorization: `Bearer ${key}` },
];

async function expectPrivate(path: string) {
  if (process.platform === 'win32') return;
  expect((await stat(path)).mode & 0o777).toBe(0o600);
}

describe('a command on a profile goes to its address, with its key', () => {
  test.each([
    ['--profile prod', ['--profile', 'prod'], {}],
    ['KINDGI_PROFILE=prod', [], { KINDGI_PROFILE: 'prod' }],
  ])('named by %s', async (_, flags, env) => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', ...flags], env);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(PROD, PROD_KEY));
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      apiUrl: PROD,
      tokenSource: 'file',
      apiUrlSource: 'file',
      profile: 'prod',
      identity: { tenantId: 't-1', status: 'ok' },
    });
    expect(out.stderr).toBe('');
    printsNoKey(out);
  });

  test('none named: the login without a name, as before', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami'], { KINDGI_PROFILE: '' });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(SIGNED_IN, HOME_KEY));
    expect(JSON.parse(out.stdout)).toMatchObject({ apiUrl: SIGNED_IN, profile: null });
  });

  test('a file from before profiles reads as it did', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY });
    const out = await cli(['auth', 'whoami']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(SIGNED_IN, HOME_KEY));
    expect(JSON.parse(out.stdout)).toMatchObject({
      tokenSource: 'file',
      apiUrlSource: 'file',
      profile: null,
    });
  });

  test('--token with a profile: the given key goes to the profile address', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', '--profile', 'prod', `--token=${GIVEN_KEY}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(PROD, GIVEN_KEY));
    expect(JSON.parse(out.stdout)).toMatchObject({ tokenSource: 'flag', profile: 'prod' });
  });

  test('--url naming the profile address another way: it goes there', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', '--profile', 'prod', `--url=${PROD}/`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(PROD, PROD_KEY));
  });

  test('--url naming another address: refused (exit 2) before anything is sent', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', '--profile', 'prod', `--url=${OTHER}`]);
    expect(out.exitCode).toBe(2);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toBe(
      `--profile prod: the profile's key goes only to its own address, ${PROD}, and --url names another: ${OTHER}. Leave out --url, or name the profile for ${OTHER}.\n`,
    );
    printsNoKey(out);
  });

  test('--profile beats KINDGI_PROFILE, whatever it holds', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', '--profile', 'prod'], {
      KINDGI_PROFILE: 'Not A Name',
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(PROD, PROD_KEY));
    expect(out.stderr).toBe('');
  });

  test.each([
    ['KINDGI_API_URL', { KINDGI_API_URL: OTHER }, "the exported KINDGI_API_URL isn't"],
    ['KINDGI_API_TOKEN', { KINDGI_API_TOKEN: GIVEN_KEY }, "the exported KINDGI_API_TOKEN isn't"],
    [
      'both',
      { KINDGI_API_URL: OTHER, KINDGI_API_TOKEN: GIVEN_KEY },
      "the exported KINDGI_API_URL and KINDGI_API_TOKEN aren't",
    ],
  ])('--profile beats an exported %s, and says so', async (_, env, said) => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', '--profile', 'prod'], env);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(PROD, PROD_KEY));
    expect(out.stderr).toBe(`--profile prod is used: ${said}.\n`);
    printsNoKey(out);
  });

  test('under --quiet the note is still said', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', '--profile', 'prod', '--quiet'], {
      KINDGI_API_URL: OTHER,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe("--profile prod is used: the exported KINDGI_API_URL isn't.\n");
  });

  test.each([
    ['--profile prod', ['--profile', 'prod'], {}],
    ['KINDGI_PROFILE=prod', [], { KINDGI_PROFILE: 'prod' }],
  ])(
    "in a `kindgi dev` folder, %s: the profile's address, saying the folder's runtime is skipped",
    async (_, flags, env) => {
      await signedInWithProfiles();
      await devFolder();
      const out = await cli(['auth', 'whoami', ...flags], env);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(out.sent).toEqual(whoamiAt(PROD, PROD_KEY));
      expect(out.stderr).toBe(
        `kindgi auth whoami goes to ${PROD}, the profile prod's address, not the kindgi dev runtime ${folderFile()} names.\n`,
      );
      printsNoKey(out);
    },
  );

  test("a folder's .kindgirc.json for another server: not read under a profile", async () => {
    await signedInWithProfiles();
    await writeFile(folderFile(), JSON.stringify({ apiUrl: OTHER, token: GIVEN_KEY }));
    const out = await cli(['auth', 'whoami', '--profile', 'prod']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(PROD, PROD_KEY));
    expect(out.stderr).toBe('');
  });

  test('kindgi dev refuses --profile (exit 2): a dev runtime is local', async () => {
    await signedInWithProfiles();
    const out = await cli(['dev', '--profile', 'prod']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      "kindgi dev runs a local runtime, never a profile's: leave --profile out.\n",
    );
  });
});

describe("a profile's key is never found by its address", () => {
  test('no key for the address: the refusal names the profile that holds one', async () => {
    await homeHolds({ profiles: { prod } });
    const out = await cli(['auth', 'whoami', `--url=${PROD}`]);
    expect(out.exitCode).toBe(1);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toContain(
      `API token not configured. Set KINDGI_API_TOKEN, pass --token=..., or run \`kindgi auth login\`. The profile prod holds a key for ${PROD}: add --profile prod.`,
    );
  });

  test('two profiles for the address: both named', async () => {
    await homeHolds({ profiles: { prod, backup: prod } });
    const out = await cli(['auth', 'whoami'], { KINDGI_API_URL: PROD });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      `The profiles prod and backup hold a key for ${PROD}: add --profile prod or --profile backup.`,
    );
  });

  test('the login without a name is for another address: refused, naming the profile first', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', `--url=${PROD}`]);
    expect(out.exitCode).toBe(1);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toContain(
      `kindgi auth whoami would send the API key stored in ${homeFile()}, which is for ${SIGNED_IN}, to ${PROD}, which --url names.`,
    );
    expect(out.stderr).toContain(
      `The key goes only to its own address: add --profile prod (it holds a key for ${PROD}), point --url at ${SIGNED_IN}, sign in to ${PROD} with \`kindgi auth login --profile <name> --url ${PROD} --token-stdin\`, its key on stdin, or give that server's key with --token or KINDGI_API_TOKEN.`,
    );
    printsNoKey(out);
  });

  test('a profile that cannot be used is never named for an address', async () => {
    await homeHolds({ profiles: { broken: { apiUrl: PROD } } });
    const out = await cli(['auth', 'whoami', `--url=${PROD}`]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('API token not configured.');
    expect(out.stderr).not.toContain('--profile broken');
  });
});

describe('a profile that cannot be used is refused (exit 2) before anything is sent', () => {
  test.each([
    ['--profile qa', ['--profile', 'qa'], {}],
    ['KINDGI_PROFILE=qa', [], { KINDGI_PROFILE: 'qa' }],
  ])('a name the file does not hold, by %s: the names it holds', async (by, flags, env) => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami', ...flags], env);
    expect(out.exitCode).toBe(2);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toBe(
      `${by}: ${homeFile()} holds no profile named qa (it holds prod and staging). Save one with \`kindgi auth login --profile qa --url <url> --token-stdin\`.\n`,
    );
  });

  test('no file at all: it holds none', async () => {
    const out = await cli(['auth', 'whoami', '--profile', 'qa']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(`${homeFile()} holds no profile named qa (it holds none).`);
  });

  test('--profile with a name no profile can have: an argument error', async () => {
    const out = await cli(['auth', 'whoami', '--profile', 'Prod_1']);
    expect(out.exitCode).toBe(2);
    expect(out.sent).toEqual([]);
    expect(
      out.stderr.startsWith(`Argument error: --profile takes a profile's name: ${NAME_RULE}.\n`),
    ).toBe(true);
  });

  test('KINDGI_PROFILE with a name no profile can have: refused, the value not repeated', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami'], { KINDGI_PROFILE: 'Prod_1' });
    expect(out.exitCode).toBe(2);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toBe(`KINDGI_PROFILE isn't a profile name: a name is ${NAME_RULE}.\n`);
  });

  test.each([
    [
      'KINDGI_API_URL',
      { KINDGI_API_URL: OTHER },
      'KINDGI_PROFILE and KINDGI_API_URL are both set, and each picks a runtime: unset one, or pass --profile prod.',
    ],
    [
      'KINDGI_API_TOKEN',
      { KINDGI_API_TOKEN: GIVEN_KEY },
      'KINDGI_PROFILE and KINDGI_API_TOKEN are both set, and each picks a runtime: unset one, or pass --profile prod.',
    ],
    [
      'KINDGI_API_URL and KINDGI_API_TOKEN',
      { KINDGI_API_URL: OTHER, KINDGI_API_TOKEN: GIVEN_KEY },
      'KINDGI_PROFILE, KINDGI_API_URL and KINDGI_API_TOKEN are all set, and each picks a runtime: unset KINDGI_PROFILE or the other two, or pass --profile prod.',
    ],
  ])('KINDGI_PROFILE beside %s', async (_, env, said) => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'whoami'], { KINDGI_PROFILE: 'prod', ...env });
    expect(out.exitCode).toBe(2);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toBe(`${said}\n`);
    printsNoKey(out);
  });

  test.each([
    ['with no token', { broken: { apiUrl: PROD } }, 'it has no token'],
    ['with no apiUrl', { broken: { token: PROD_KEY } }, 'it has no apiUrl'],
    ['that is not an object', { broken: 'prod' }, "it isn't an object"],
  ])('a profile %s: why, and how to save or remove it', async (_, profiles, problem) => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY, profiles });
    const out = await cli(['auth', 'whoami', '--profile', 'broken']);
    expect(out.exitCode).toBe(2);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toBe(
      `--profile broken: the profile broken in ${homeFile()} can't be used: ${problem}. Save it again with \`kindgi auth login --profile broken --url <url> --token-stdin --force\`, or remove it with \`kindgi auth logout --profile broken\`.\n`,
    );
    printsNoKey(out);
  });

  test('`profiles` that is not an object: no profile in it can be used; the login without a name still can', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY, profiles: 'prod' });
    const refused = await cli(['auth', 'whoami', '--profile', 'prod']);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("can't be used: `profiles` isn't an object.");

    const out = await cli(['auth', 'whoami']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.sent).toEqual(whoamiAt(SIGNED_IN, HOME_KEY));
  });
});

describe('kindgi auth login --token-stdin reads the key from stdin', () => {
  test('all of it, one trailing newline dropped; the file is private', async () => {
    const out = await cli(
      ['auth', 'login', `--url=${OTHER}`, '--token-stdin'],
      {},
      `${GIVEN_KEY}\n`,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, wrote: homeFile(), apiUrl: OTHER });
    expect(out.stderr).toBe('');
    expect(await homeNow()).toEqual({ apiUrl: OTHER, token: GIVEN_KEY });
    await expectPrivate(homeFile());
    printsNoKey(out);
  });

  test('an empty key: refused (exit 1), nothing written', async () => {
    const out = await cli(['auth', 'login', `--url=${OTHER}`, '--token-stdin'], {}, '\n');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('Empty API key refused.\n');
    await expect(stat(homeFile())).rejects.toThrow();
  });

  test('stdin that cannot be read: refused (exit 1), saying why', async () => {
    const out = await cli(['auth', 'login', `--url=${OTHER}`, '--token-stdin'], {}, async () => {
      throw new Error('stdin closed');
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe("Couldn't read the API key from stdin: stdin closed\n");
  });

  test('with --token too: refused (exit 2)', async () => {
    const out = await cli(
      ['auth', 'login', `--url=${OTHER}`, `--token=${GIVEN_KEY}`, '--token-stdin'],
      {},
      GIVEN_KEY,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('--token and --token-stdin both give the key: use one.\n');
  });

  test("another address's login kept: the key read from stdin is not a stored one, so it's the keep refusal; --force replaces it", async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY });
    const flags = ['auth', 'login', `--url=${OTHER}`, '--token-stdin'];
    const refused = await cli(flags, {}, GIVEN_KEY);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain(`${homeFile()} holds the login for ${SIGNED_IN}.`);
    expect(refused.stderr).not.toContain('would save');
    expect(await homeNow()).toEqual({ apiUrl: SIGNED_IN, token: HOME_KEY });

    const forced = await cli([...flags, '--force'], {}, GIVEN_KEY);
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(await homeNow()).toEqual({ apiUrl: OTHER, token: GIVEN_KEY });
  });
});

describe('kindgi auth login --profile saves a profile beside the other logins', () => {
  test('a new name: saved, the login without a name kept, the file private', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY });
    const out = await cli(
      ['auth', 'login', '--profile', 'prod', `--url=${PROD}`, '--token-stdin'],
      {},
      PROD_KEY,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      wrote: homeFile(),
      profile: 'prod',
      apiUrl: PROD,
    });
    expect(out.stderr).toBe('');
    expect(await homeNow()).toEqual({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
      profiles: { prod },
    });
    await expectPrivate(homeFile());
    printsNoKey(out);
  });

  test('named by KINDGI_PROFILE: the same', async () => {
    const out = await cli(
      ['auth', 'login', `--url=${PROD}`, '--token-stdin'],
      { KINDGI_PROFILE: 'prod' },
      PROD_KEY,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await homeNow()).toEqual({ profiles: { prod } });
  });

  test("a held name and a new key: the key replaced at the profile's own address", async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'login', '--profile', 'prod', '--token-stdin'], {}, GIVEN_KEY);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(await homeNow()).toEqual({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
      profiles: { prod: { apiUrl: PROD, token: GIVEN_KEY }, staging },
    });
  });

  test('a new name with no --url: refused (exit 2)', async () => {
    const out = await cli(['auth', 'login', '--profile', 'qa', '--token-stdin'], {}, GIVEN_KEY);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      'Missing --url=<api-url>: the profile qa has no address stored, and login takes one only from --url.\n',
    );
  });

  test('a new name with no key: refused (exit 2)', async () => {
    const out = await cli(['auth', 'login', '--profile', 'qa', `--url=${PROD}`]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      "Missing qa's key: give it on stdin with --token-stdin, or with --token=<api-token>.\n",
    );
  });

  test('an exported KINDGI_API_URL is not read for a profile: refused, saying so', async () => {
    const out = await cli(
      ['auth', 'login', '--profile', 'qa', '--token-stdin'],
      { KINDGI_API_URL: PROD },
      GIVEN_KEY,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      "--profile qa is used: the exported KINDGI_API_URL isn't.\nkindgi auth login --profile qa doesn't read KINDGI_API_URL: give qa's address with --url.\n",
    );
  });

  test('an exported KINDGI_API_TOKEN is not read for a profile: refused, saying so', async () => {
    const out = await cli(['auth', 'login', '--profile', 'qa', `--url=${PROD}`], {
      KINDGI_API_TOKEN: GIVEN_KEY,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      "--profile qa is used: the exported KINDGI_API_TOKEN isn't.\nkindgi auth login --profile qa doesn't read KINDGI_API_TOKEN: give qa's key with --token-stdin.\n",
    );
    printsNoKey(out);
  });

  test('a held name and an exported KINDGI_API_TOKEN: the profile kept as it is, the exported key never saved', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'login', '--profile', 'prod'], { KINDGI_API_TOKEN: GIVEN_KEY });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toBe("--profile prod is used: the exported KINDGI_API_TOKEN isn't.\n");
    expect(await homeNow()).toEqual({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
      profiles: { prod, staging },
    });
  });

  test('KINDGI_PROFILE beside an exported key: refused (exit 2), nothing written', async () => {
    await signedInWithProfiles();
    const before = await readFile(homeFile(), 'utf8');
    const out = await cli(['auth', 'login', `--url=${PROD}`], {
      KINDGI_PROFILE: 'prod',
      KINDGI_API_TOKEN: GIVEN_KEY,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      'KINDGI_PROFILE and KINDGI_API_TOKEN are both set, and each picks a runtime: unset one, or pass --profile prod.\n',
    );
    expect(await readFile(homeFile(), 'utf8')).toBe(before);
  });

  test("a held name, another address and a new key: the profile's login kept; --force replaces it", async () => {
    await signedInWithProfiles();
    const flags = ['auth', 'login', '--profile', 'prod', `--url=${OTHER}`, '--token-stdin'];
    const refused = await cli(flags, {}, GIVEN_KEY);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toBe(
      `${homeFile()} holds the profile prod's login for ${PROD}. kindgi auth login would replace it with ${OTHER}'s, and its API key would be lost.\nTo keep both, save ${OTHER}'s login under another profile name: \`kindgi auth login --profile <name> --url ${OTHER} --token-stdin\`, with its key on stdin.\nTo replace it, run again with --force.\n`,
    );

    const forced = await cli([...flags, '--force'], {}, GIVEN_KEY);
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(JSON.parse(forced.stdout)).toEqual({
      ok: true,
      wrote: homeFile(),
      profile: 'prod',
      apiUrl: OTHER,
      replaced: { apiUrl: PROD },
    });
    expect(forced.stderr).toContain(
      `Replaced the profile prod's login for ${PROD} in ${homeFile()}: its API key is no longer stored.`,
    );
    expect(await homeNow()).toEqual({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
      profiles: { prod: { apiUrl: OTHER, token: GIVEN_KEY }, staging },
    });
    printsNoKey(forced);
  });

  test('a held name and another address with no key given: its stored key is never saved for that address, --force or not', async () => {
    await signedInWithProfiles();
    const before = await readFile(homeFile(), 'utf8');
    for (const force of [[], ['--force']]) {
      const out = await cli(['auth', 'login', '--profile', 'prod', `--url=${OTHER}`, ...force]);
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toBe(
        `kindgi auth login would save prod's key in ${homeFile()}, which is for ${PROD}, as ${OTHER}'s key. A stored key goes only to its own address: give ${OTHER}'s key with --token-stdin or --token.\n`,
      );
    }
    expect(await readFile(homeFile(), 'utf8')).toBe(before);
  });

  test('a held profile that cannot be used: replaced only with --force', async () => {
    await homeHolds({ profiles: { prod: { apiUrl: PROD } } });
    const flags = ['auth', 'login', '--profile', 'prod', `--url=${PROD}`, '--token-stdin'];
    const refused = await cli(flags, {}, PROD_KEY);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toBe(
      `${homeFile()} holds the profile prod, which can't be used (it has no token). kindgi auth login would replace it with ${PROD}'s.\nTo replace it, run again with --force.\n`,
    );

    const forced = await cli([...flags, '--force'], {}, PROD_KEY);
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(JSON.parse(forced.stdout)).toMatchObject({
      profile: 'prod',
      replaced: { apiUrl: null },
    });
    expect(forced.stderr).toContain(
      `Replaced the profile prod, which can't be used (it has no token), in ${homeFile()}.`,
    );
    expect(await homeNow()).toEqual({ profiles: { prod } });
  });
});

describe('kindgi auth list shows the logins, never a key', () => {
  test('as JSON: the login without a name first, then each profile in the file order', async () => {
    await homeHolds({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
      profiles: { prod, broken: { apiUrl: OTHER } },
    });
    const out = await cli(['auth', 'list']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      file: homeFile(),
      logins: [
        { profile: null, apiUrl: SIGNED_IN, file: homeFile(), usable: true },
        { profile: 'prod', apiUrl: PROD, file: homeFile(), usable: true },
        {
          profile: 'broken',
          apiUrl: OTHER,
          file: homeFile(),
          usable: false,
          problem: 'it has no token',
        },
      ],
    });
    printsNoKey(out);
  });

  test('as a table', async () => {
    await homeHolds({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
      profiles: { prod, broken: { apiUrl: OTHER } },
    });
    const out = await cli(['auth', 'list', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    const rows = out.stdout
      .trimEnd()
      .split('\n')
      .map((line) => line.split(/\s{2,}/));
    expect(rows[0]).toEqual(['PROFILE', 'API URL', 'USABLE']);
    expect(rows.slice(2)).toEqual([
      ['(none)', SIGNED_IN, 'yes'],
      ['prod', PROD, 'yes'],
      ['broken', OTHER, 'no: it has no token'],
    ]);
    expect(out.stderr).toBe('');
    printsNoKey(out);
  });

  test('no file: no logins', async () => {
    const out = await cli(['auth', 'list']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, file: homeFile(), logins: [] });
  });

  test('`profiles` that is not an object: said, beside the login without a name', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY, profiles: 'prod' });
    const json = await cli(['auth', 'list']);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      file: homeFile(),
      logins: [{ profile: null, apiUrl: SIGNED_IN, file: homeFile(), usable: true }],
      problem: "`profiles` isn't an object",
    });

    const table = await cli(['auth', 'list', '--table']);
    expect(table.exitCode, table.stderr).toBe(0);
    expect(table.stderr).toBe(
      `${homeFile()}: \`profiles\` isn't an object, so no profile in it can be used.\n`,
    );
  });
});

describe('kindgi auth logout removes one login', () => {
  test('--profile: that profile, the others kept', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'logout', '--profile', 'prod']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      wrote: homeFile(),
      removed: { profile: 'prod', apiUrl: PROD },
    });
    expect(await homeNow()).toEqual({ apiUrl: SIGNED_IN, token: HOME_KEY, profiles: { staging } });
    await expectPrivate(homeFile());
  });

  test('the last profile: `profiles` goes too', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY, profiles: { prod } });
    const out = await cli(['auth', 'logout', '--profile', 'prod']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await homeNow()).toEqual({ apiUrl: SIGNED_IN, token: HOME_KEY });
  });

  test('no --profile: the login without a name, the profiles kept and still used', async () => {
    await signedInWithProfiles();
    const out = await cli(['auth', 'logout']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      wrote: homeFile(),
      removed: { profile: null, apiUrl: SIGNED_IN },
    });
    expect(await homeNow()).toEqual({ profiles: { prod, staging } });

    const whoami = await cli(['auth', 'whoami', '--profile', 'prod']);
    expect(whoami.exitCode, whoami.stderr).toBe(0);
    expect(whoami.sent).toEqual(whoamiAt(PROD, PROD_KEY));
  });

  test('a name the file does not hold: refused (exit 2), the file as it was', async () => {
    await signedInWithProfiles();
    const before = await readFile(homeFile(), 'utf8');
    const out = await cli(['auth', 'logout', '--profile', 'qa']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      `${homeFile()} holds no profile named qa (it holds prod and staging).\n`,
    );
    expect(await readFile(homeFile(), 'utf8')).toBe(before);
  });

  test('no login without a name: refused (exit 2), naming the profiles', async () => {
    await homeHolds({ profiles: { prod } });
    const out = await cli(['auth', 'logout']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(`${homeFile()} holds no login without a name (its profiles: prod).\n`);
  });

  test('a profile that cannot be used: removed', async () => {
    await homeHolds({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
      profiles: { prod, broken: { apiUrl: OTHER } },
    });
    const out = await cli(['auth', 'logout', '--profile', 'broken']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ removed: { profile: 'broken', apiUrl: OTHER } });
    expect(await homeNow()).toEqual({ apiUrl: SIGNED_IN, token: HOME_KEY, profiles: { prod } });
  });
});

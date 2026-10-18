// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

/**
 * One hosted rule for every command: `--hosted`, or the env the command
 * acts in has `build: 'hosted'`. A hosted command goes to the CLI's own
 * address with its key, never to the `kindgi dev` runtime a folder's
 * .kindgirc.json names. A command that isn't hosted and goes to that
 * runtime says so first, when another address is in reach.
 */

const CLOUD = 'https://platform.example.com';
const DEV = 'http://127.0.0.1:4000';
const CLOUD_KEY = 'kgi_tk_cloud_never_printed';
const DEV_KEY = 'kgi_tk_dev_never_printed';
const GIVEN_KEY = 'kgi_tk_given_never_printed';

/** The pack: `prod` is hosted, `staging` builds on a build server of its own. */
const PACK = {
  pack: { id: 'acme.desk', version: '1.0.0' },
  environments: {
    prod: { build: 'hosted' },
    staging: { build: 'https://build.staging.example.com' },
  },
};

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-hosted-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-hosted-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const homeFile = () => join(home, '.kindgi', 'config.json');
const folderFile = () => join(cwd, '.kindgirc.json');

/** `kindgi auth login`'s file, for Kindgi Cloud. */
async function signedIn() {
  await mkdir(join(home, '.kindgi'), { recursive: true });
  await writeFile(homeFile(), JSON.stringify({ apiUrl: CLOUD, token: CLOUD_KEY }));
}

/** `kindgi dev`'s file: its runtime's address and key, and the pack service's port. */
async function devFolder() {
  await writeFile(
    folderFile(),
    JSON.stringify({ apiUrl: DEV, token: DEV_KEY, packServicePort: 4100 }),
  );
}

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
}

/**
 * The CLI in the pack folder. Its fetch answers 200; its client factory
 * keeps the address and key, then throws, so nothing goes past that.
 */
async function cli(argv: readonly string[], env: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const out = await runCli({
    argv,
    env,
    cwd,
    home,
    buildConfigLoader: async () => PACK,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ tenantId: 't-1', status: 'ok' }), { status: 200 });
    }) as typeof fetch,
    clientFactory: (url, token) => {
      sent.push({ url, authorization: `Bearer ${token}` });
      throw new Error('no client in this test');
    },
    secretsInputSeam: { readStdin: async () => 'acme-value', stdinIsTty: () => false },
  });
  for (const key of [CLOUD_KEY, DEV_KEY, GIVEN_KEY]) {
    expect(out.stdout).not.toContain(key);
    expect(out.stderr).not.toContain(key);
  }
  return { ...out, sent };
}

/** Where each request went: the address alone, for a client, or the URL's origin. */
const origins = (sent: readonly Sent[]) =>
  sent.map((s) => ({ to: new URL(s.url).origin, authorization: s.authorization }));

/**
 * The commands from the guides that call the API, with their own
 * arguments. Those that act in an env (`--env`) take `env`, `staging` by
 * default: not hosted.
 */
const COMMANDS: readonly (readonly [string, (env?: string) => readonly string[]])[] = [
  ['auth whoami', () => ['auth', 'whoami']],
  ['key trust', () => ['key', 'trust', 'acme-desk', `--home=${home}`]],
  [
    'secrets set',
    (env = 'staging') => [
      'secrets',
      'set',
      'ACME_KEY',
      `--env=${env}`,
      '--scope=tenant',
      '--from-stdin',
    ],
  ],
  [
    'providers register',
    (env = 'staging') => ['providers', 'register', '--preset=anthropic', `--env=${env}`],
  ],
  ['runs start', () => ['runs', 'start', '--agent=acme-desk', '--input={}', '--no-wait']],
  ['agents promote', () => ['agents', 'promote', 'acme-desk', '1.0.0', '--tenant']],
];

/** The commands that act in an env. */
const IN_AN_ENV = COMMANDS.filter(
  ([label]) => label === 'secrets set' || label === 'providers register',
);

/** `kindgi key trust` reads the key `kindgi key create` made. */
async function keyMade() {
  const made = await runCli({
    argv: ['key', 'create', 'acme-desk', `--home=${home}`],
    env: {},
    cwd,
    home,
  });
  expect(made.exitCode, made.stderr).toBe(0);
}

const hint = (label: string) =>
  `kindgi ${label} goes to the kindgi dev runtime at ${DEV} (${folderFile()} says so). For ${CLOUD}, pass --hosted.`;

describe('in a folder where `kindgi dev` ran, signed in to Kindgi Cloud', () => {
  beforeEach(async () => {
    await signedIn();
    await devFolder();
    await keyMade();
  });

  test.each(COMMANDS)(
    '%s --hosted: to the Cloud with its key; the dev key never goes',
    async (_, args) => {
      const out = await cli([...args(), '--hosted']);
      expect(origins(out.sent)[0]).toEqual({ to: CLOUD, authorization: `Bearer ${CLOUD_KEY}` });
      expect(out.sent.map((s) => s.authorization)).not.toContain(`Bearer ${DEV_KEY}`);
      expect(out.stderr).not.toContain('kindgi dev runtime');
    },
  );

  test.each(IN_AN_ENV)(
    "%s --env=prod, prod's `build: 'hosted'`: to the Cloud, as with --hosted",
    async (_, args) => {
      const out = await cli(args('prod'));
      expect(origins(out.sent)[0]).toEqual({ to: CLOUD, authorization: `Bearer ${CLOUD_KEY}` });
      expect(out.sent.map((s) => s.authorization)).not.toContain(`Bearer ${DEV_KEY}`);
      expect(out.stderr).not.toContain('kindgi dev runtime');
    },
  );

  test.each(COMMANDS)(
    '%s alone: to the dev runtime, and the first line says how to reach the Cloud',
    async (label, args) => {
      const out = await cli(args());
      expect(origins(out.sent)[0]).toEqual({ to: DEV, authorization: `Bearer ${DEV_KEY}` });
      expect(out.stderr.split('\n')[0]).toBe(hint(label));
    },
  );

  test.each(COMMANDS)(
    '%s with KINDGI_API_URL: the address was named, so no line',
    async (_, args) => {
      const out = await cli(args(), { KINDGI_API_URL: DEV });
      expect(origins(out.sent)[0]).toEqual({ to: DEV, authorization: `Bearer ${DEV_KEY}` });
      expect(out.stderr).not.toContain('kindgi dev runtime');
    },
  );

  test.each(IN_AN_ENV)(
    '%s --env=staging, not hosted: as before, but for the line ahead',
    async (label, args) => {
      const out = await cli(args('staging'));
      await rm(homeFile());
      const before = await cli(args('staging'));
      expect(out.sent).toEqual(before.sent);
      expect(origins(out.sent)[0]).toEqual({ to: DEV, authorization: `Bearer ${DEV_KEY}` });
      expect(out.stdout).toBe(before.stdout);
      expect(out.exitCode).toBe(before.exitCode);
      expect(out.stderr).toBe(`${hint(label)}\n${before.stderr}`);
    },
  );
});

describe('the line, and who gets none', () => {
  test('a key given and no other sign-in: name its address', async () => {
    await devFolder();
    const out = await cli(['auth', 'whoami'], { KINDGI_API_TOKEN: GIVEN_KEY });
    expect(origins(out.sent)).toEqual([{ to: DEV, authorization: `Bearer ${GIVEN_KEY}` }]);
    expect(out.stderr.split('\n')[0]).toBe(
      `kindgi auth whoami goes to the kindgi dev runtime at ${DEV} (${folderFile()} says so). To send it to the address your key is for, pass --url <that address> or export KINDGI_API_URL.`,
    );
  });

  test('the address and the key both given: no line', async () => {
    await signedIn();
    await devFolder();
    const out = await cli(['auth', 'whoami'], { KINDGI_API_URL: DEV, KINDGI_API_TOKEN: GIVEN_KEY });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(origins(out.sent)).toEqual([{ to: DEV, authorization: `Bearer ${GIVEN_KEY}` }]);
    expect(out.stderr).toBe('');
  });

  test('only the dev runtime in reach: no line', async () => {
    await devFolder();
    const out = await cli(['auth', 'whoami']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(origins(out.sent)).toEqual([{ to: DEV, authorization: `Bearer ${DEV_KEY}` }]);
    expect(out.stderr).toBe('');
  });

  test('a command that sends no key: no line', async () => {
    await signedIn();
    await devFolder();
    const out = await cli(['key', 'create', 'acme-desk', `--home=${home}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).not.toContain('kindgi dev runtime');
  });

  test('kindgi dev --hosted is refused: a dev runtime is never hosted', async () => {
    await devFolder();
    const out = await cli(['dev', '--hosted']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      'kindgi dev runs a local runtime, never a hosted one: leave --hosted out.\n',
    );
    expect(out.sent).toEqual([]);
  });

  test('--hosted with no address of its own: refused, saying the dev file is not read', async () => {
    await devFolder();
    const out = await cli(['auth', 'whoami', '--hosted']);
    expect(out.exitCode).toBe(1);
    expect(out.sent).toEqual([]);
    expect(out.stderr).toContain(
      `kindgi auth whoami --hosted goes to the API your key is for, and no API address is set. ${folderFile()} points this folder at a \`kindgi dev\` runtime (${DEV}), which isn't a hosted target, so kindgi auth whoami --hosted doesn't read it.`,
    );
  });

  test('a broken pack config: not hosted by its env block, and the command goes on', async () => {
    await signedIn();
    await devFolder();
    const out = await runCli({
      argv: ['providers', 'register', '--preset=anthropic', '--env=prod'],
      env: {},
      cwd,
      home,
      buildConfigLoader: async () => {
        throw new Error('kindgi.config.ts: unexpected token');
      },
      clientFactory: (url) => {
        throw new Error(`no client in this test (${url})`);
      },
    });
    expect(out.stderr.split('\n')[0]).toBe(hint('providers register'));
    expect(out.stderr).toContain(`no client in this test (${DEV})`);
  });
});

describe('`kindgi auth login --url` for the Cloud, in that folder', () => {
  beforeEach(devFolder);

  test("with no key given: refused, and the dev runtime's key isn't saved for the Cloud", async () => {
    const out = await cli(['auth', 'login', `--url=${CLOUD}`]);
    expect(out.exitCode, out.stderr).toBe(2);
    expect(out.stderr).toContain(
      `kindgi auth login would save the API key stored in ${folderFile()}, which is for ${DEV}, as ${CLOUD}'s key.`,
    );
    expect(out.sent).toEqual([]);
    expect(existsSync(homeFile())).toBe(false);
  });

  test('with KINDGI_API_TOKEN: saved for the Cloud; then `auth whoami --hosted` goes there with it', async () => {
    const login = await cli(['auth', 'login', `--url=${CLOUD}`], { KINDGI_API_TOKEN: CLOUD_KEY });
    expect(login.exitCode, login.stderr).toBe(0);
    expect(JSON.parse(await readFile(homeFile(), 'utf8'))).toMatchObject({
      apiUrl: CLOUD,
      token: CLOUD_KEY,
    });

    const whoami = await cli(['auth', 'whoami', '--hosted']);
    expect(whoami.exitCode, whoami.stderr).toBe(0);
    expect(origins(whoami.sent)).toEqual([{ to: CLOUD, authorization: `Bearer ${CLOUD_KEY}` }]);
  });
});

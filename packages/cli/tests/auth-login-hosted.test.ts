// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { AuthLoginSeam } from '../src/commands/auth.js';
import { runCli } from '../src/main.js';
import { PromptCancelled, type TtySeam } from '../src/terminal-input.js';

/**
 * `kindgi auth login` for Kindgi Cloud: `--hosted` saves Kindgi Cloud's
 * address, and given no key, login asks for one, hidden, when stdin is a
 * terminal. Without a terminal it never asks.
 */

const CLOUD = 'https://platform.kindgi.com';
const SIGNED_IN = 'https://platform.example.com';
const OTHER = 'https://other.example.com';
const DEV = 'http://127.0.0.1:4000';
const HOME_KEY = 'kgi_tk_home_never_printed';
const DEV_KEY = 'kgi_tk_dev_never_printed';
const GIVEN_KEY = 'kgi_tk_given_never_printed';
const TYPED_KEY = 'kgi_tk_typed_never_printed';
const KEYS = [HOME_KEY, DEV_KEY, GIVEN_KEY, TYPED_KEY];

const NO_KEY =
  'Missing the API key: --token-stdin with it on stdin, or --token=<api-token> (or KINDGI_API_TOKEN / existing config).\n';

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-login-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-login-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const homeFile = () => join(home, '.kindgi', 'config.json');

/** Login's refusal to replace the login for SIGNED_IN with Kindgi Cloud's. */
const keptForCloud = () =>
  `${homeFile()} holds the login for ${SIGNED_IN}. kindgi auth login would replace it with ${CLOUD}'s, and its API key would be lost.\nTo keep both, save ${CLOUD}'s login as a profile: \`kindgi auth login --profile <name> --hosted\`, which asks for its key on a terminal (or give it with --token-stdin).\nTo replace it, run again with --force.\n`;

async function homeHolds(values: Record<string, unknown>) {
  await mkdir(join(home, '.kindgi'), { recursive: true });
  await writeFile(homeFile(), JSON.stringify(values));
}

const homeNow = async () => JSON.parse(await readFile(homeFile(), 'utf8')) as unknown;

/** Whether login wrote ~/.kindgi/config.json at all. */
const homeWritten = () =>
  stat(homeFile()).then(
    () => true,
    () => false,
  );

/** A terminal that answers the hidden prompt with `answers` in turn, keeping each prompt. */
function terminal(...answers: readonly (string | Error)[]) {
  const left = [...answers];
  const prompts: string[] = [];
  let closed = 0;
  const tty: TtySeam = {
    promptHidden: async (prompt: string) => {
      prompts.push(prompt);
      const answer = left.shift();
      if (answer === undefined) throw new Error('asked more often than answered');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    close: () => {
      closed += 1;
    },
  };
  return { tty, prompts, closed: () => closed };
}

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
}

/**
 * The CLI, with a fetch that answers 200 and keeps each request's URL and
 * Authorization. `seam` is login's: stdin and the terminal. A terminal is
 * never there unless the test gives one.
 */
async function cli(
  argv: readonly string[],
  options: { readonly env?: Record<string, string>; readonly seam?: AuthLoginSeam } = {},
) {
  const sent: Sent[] = [];
  const out = await runCli({
    argv,
    env: options.env ?? {},
    cwd,
    home,
    authLoginSeam: { stdinIsTty: () => false, ...options.seam },
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

/** A terminal's seam: stdin is one, and `tty` answers. */
const onTerminal = (tty: TtySeam): AuthLoginSeam => ({ stdinIsTty: () => true, tty });

/** Nothing the CLI printed holds a key. */
function printsNoKey(out: { stdout: string; stderr: string }) {
  for (const key of KEYS) {
    expect(out.stdout).not.toContain(key);
    expect(out.stderr).not.toContain(key);
  }
}

describe('kindgi auth login asks for the key, hidden, when stdin is a terminal', () => {
  test('given no key: it asks once, naming the address, and saves the answer', async () => {
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', `--url=${OTHER}`], { seam: onTerminal(term.tty) });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(term.prompts).toEqual([`API key for ${OTHER}: `]);
    expect(term.closed()).toBe(1);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, wrote: homeFile(), apiUrl: OTHER });
    expect(await homeNow()).toEqual({ apiUrl: OTHER, token: TYPED_KEY });
    expect(out.sent).toEqual([]);
    printsNoKey(out);
  });

  test("given no key and no terminal: it never asks, and it's refused as before (exit 2)", async () => {
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', `--url=${OTHER}`], {
      seam: { stdinIsTty: () => false, tty: term.tty },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(NO_KEY);
    expect(term.prompts).toEqual([]);
    expect(await homeWritten()).toBe(false);
  });

  test('with no terminal, the stored key for the address is saved again, as before', async () => {
    await homeHolds({ apiUrl: OTHER, token: HOME_KEY });
    const out = await cli(['auth', 'login', `--url=${OTHER}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await homeNow()).toEqual({ apiUrl: OTHER, token: HOME_KEY });
  });

  test.each([
    ['--token-stdin', ['--token-stdin'], {}],
    ['--token', [`--token=${GIVEN_KEY}`], {}],
    ['KINDGI_API_TOKEN', [], { KINDGI_API_TOKEN: GIVEN_KEY }],
  ] as const)('a key given with %s: no prompt, and that key is saved', async (_way, flags, env) => {
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', `--url=${OTHER}`, ...flags], {
      env,
      seam: { ...onTerminal(term.tty), readStdin: async () => GIVEN_KEY },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(term.prompts).toEqual([]);
    expect(await homeNow()).toEqual({ apiUrl: OTHER, token: GIVEN_KEY });
  });

  test('a stored key is asked over on a terminal: a sign-in again takes the key typed', async () => {
    await homeHolds({ apiUrl: OTHER, token: HOME_KEY });
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', `--url=${OTHER}`], { seam: onTerminal(term.tty) });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(term.prompts).toEqual([`API key for ${OTHER}: `]);
    expect(await homeNow()).toEqual({ apiUrl: OTHER, token: TYPED_KEY });
  });

  test('Ctrl+C at the prompt: cancelled (exit 1), and nothing is saved', async () => {
    const term = terminal(new PromptCancelled());
    const out = await cli(['auth', 'login', `--url=${OTHER}`], { seam: onTerminal(term.tty) });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('Cancelled.\n');
    expect(term.closed()).toBe(1);
    expect(await homeWritten()).toBe(false);
  });

  test('an empty answer: refused (exit 1), and nothing is saved', async () => {
    const term = terminal('');
    const out = await cli(['auth', 'login', `--url=${OTHER}`], { seam: onTerminal(term.tty) });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('Empty API key refused.\n');
    expect(await homeWritten()).toBe(false);
  });

  test('with no address: refused before it asks (exit 2)', async () => {
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login'], { seam: onTerminal(term.tty) });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      'Missing --url=<api-url> (or KINDGI_API_URL / existing config), or --hosted for Kindgi Cloud.\n',
    );
    expect(term.prompts).toEqual([]);
  });
});

describe("kindgi auth login --hosted saves Kindgi Cloud's address", () => {
  test(`with a key: ${CLOUD} is saved as the CLI's own address`, async () => {
    const out = await cli(['auth', 'login', '--hosted', '--token-stdin'], {
      seam: { readStdin: async () => GIVEN_KEY },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, wrote: homeFile(), apiUrl: CLOUD });
    expect(await homeNow()).toEqual({ apiUrl: CLOUD, token: GIVEN_KEY });
    printsNoKey(out);

    // The address is the CLI's own from then on: a hosted command goes there, with the key.
    const whoami = await cli(['auth', 'whoami', '--hosted']);
    expect(whoami.exitCode, whoami.stderr).toBe(0);
    expect(whoami.sent.map((s) => new URL(s.url).origin)).toEqual([CLOUD]);
    expect(whoami.sent[0]?.authorization).toBe(`Bearer ${GIVEN_KEY}`);
  });

  test('on a terminal, the prompt names Kindgi Cloud', async () => {
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', '--hosted'], { seam: onTerminal(term.tty) });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(term.prompts).toEqual([`API key for ${CLOUD}: `]);
    expect(await homeNow()).toEqual({ apiUrl: CLOUD, token: TYPED_KEY });
  });

  test('a --url for another address beside it: refused (exit 2), nothing asked or saved', async () => {
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', '--hosted', `--url=${OTHER}`], {
      seam: onTerminal(term.tty),
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      `--hosted signs in to Kindgi Cloud, at ${CLOUD}, and --url names another address: ${OTHER}. Leave out one of them.\n`,
    );
    expect(term.prompts).toEqual([]);
    expect(await homeWritten()).toBe(false);
  });

  test("a --url that repeats Kindgi Cloud's address: saved, as Kindgi Cloud's", async () => {
    const out = await cli(['auth', 'login', '--hosted', `--url=${CLOUD}/`, `--token=${GIVEN_KEY}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await homeNow()).toEqual({ apiUrl: CLOUD, token: GIVEN_KEY });
  });

  test('an exported KINDGI_API_URL for another address: Kindgi Cloud is still the one saved', async () => {
    const out = await cli(['auth', 'login', '--hosted'], {
      env: { KINDGI_API_URL: OTHER, KINDGI_API_TOKEN: GIVEN_KEY },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await homeNow()).toEqual({ apiUrl: CLOUD, token: GIVEN_KEY });
  });

  test("in a kindgi dev folder: the dev runtime's key is never saved as Kindgi Cloud's", async () => {
    await writeFile(
      join(cwd, '.kindgirc.json'),
      JSON.stringify({ apiUrl: DEV, token: DEV_KEY, packServicePort: 4100 }),
    );
    const out = await cli(['auth', 'login', '--hosted']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(NO_KEY);
    expect(await homeWritten()).toBe(false);
  });

  test('a login for another address is kept: the refusal names --hosted for the profile to save', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY });
    const out = await cli(['auth', 'login', '--hosted', `--token=${GIVEN_KEY}`]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(keptForCloud());
    expect(await homeNow()).toEqual({ apiUrl: SIGNED_IN, token: HOME_KEY });
  });

  test('on a terminal, a login for another address is refused before it asks (exit 2)', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY });
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', '--hosted'], { seam: onTerminal(term.tty) });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(keptForCloud());
    expect(term.prompts).toEqual([]);
    expect(await homeNow()).toEqual({ apiUrl: SIGNED_IN, token: HOME_KEY });
  });

  test('on a terminal with --force: it asks, saves the key typed and says what it replaced', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY });
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', '--hosted', '--force'], { seam: onTerminal(term.tty) });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(term.prompts).toEqual([`API key for ${CLOUD}: `]);
    expect(out.stderr).toContain(`Replaced the login for ${SIGNED_IN} in ${homeFile()}`);
    expect(await homeNow()).toEqual({ apiUrl: CLOUD, token: TYPED_KEY });
    printsNoKey(out);
  });
});

describe('kindgi auth login --hosted --profile <name>: a profile for Kindgi Cloud', () => {
  test('saved under the name, the login without a name kept; a command on the profile goes there', async () => {
    await homeHolds({ apiUrl: SIGNED_IN, token: HOME_KEY });
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', '--hosted', '--profile', 'cloud'], {
      seam: onTerminal(term.tty),
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(term.prompts).toEqual([`API key for ${CLOUD}: `]);
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      wrote: homeFile(),
      profile: 'cloud',
      apiUrl: CLOUD,
    });
    expect(await homeNow()).toEqual({
      apiUrl: SIGNED_IN,
      token: HOME_KEY,
      profiles: { cloud: { apiUrl: CLOUD, token: TYPED_KEY } },
    });
    printsNoKey(out);

    const whoami = await cli(['auth', 'whoami', '--profile', 'cloud']);
    expect(whoami.exitCode, whoami.stderr).toBe(0);
    expect(whoami.sent.map((s) => new URL(s.url).origin)).toEqual([CLOUD]);
    expect(whoami.sent[0]?.authorization).toBe(`Bearer ${TYPED_KEY}`);
  });

  test("an exported KINDGI_API_TOKEN isn't the profile's key: on a terminal, it asks", async () => {
    const term = terminal(TYPED_KEY);
    const out = await cli(['auth', 'login', '--hosted', '--profile', 'cloud'], {
      env: { KINDGI_API_TOKEN: GIVEN_KEY },
      seam: onTerminal(term.tty),
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(term.prompts).toEqual([`API key for ${CLOUD}: `]);
    expect(await homeNow()).toEqual({ profiles: { cloud: { apiUrl: CLOUD, token: TYPED_KEY } } });
  });

  test('with no terminal and no key: refused (exit 2), nothing saved', async () => {
    const out = await cli(['auth', 'login', '--hosted', '--profile', 'cloud']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      "Missing cloud's key: give it on stdin with --token-stdin, or with --token=<api-token>.\n",
    );
    expect(await homeWritten()).toBe(false);
  });
});

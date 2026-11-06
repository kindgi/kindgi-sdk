// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

/**
 * A config file may hold a `project` beside its key. A command that would
 * take the tenant's default project takes that one, while that key is the
 * one it sends, and `kindgi auth login` drops it with the key.
 */

const SIGNED_IN = 'https://platform.example.com';
const OTHER = 'https://other.example.com';
const HOME_KEY = 'kgi_tk_home_never_printed';
const NEW_KEY = 'kgi_tk_new_never_printed';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const DEFAULT_PROJECT = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://acme-store.example';
const REGISTER = [
  'sites',
  'register',
  '--name=Acme store',
  `--origin=${ORIGIN}`,
  `--approvals-url=${ORIGIN}/wp-admin/admin.php?page=kindgi&approval={approvalId}`,
];

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-project-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-project-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const homeFile = () => join(home, '.kindgi', 'config.json');

async function signedIn(values: Record<string, unknown>) {
  await mkdir(join(home, '.kindgi'), { recursive: true });
  await writeFile(homeFile(), JSON.stringify({ apiUrl: SIGNED_IN, token: HOME_KEY, ...values }));
}

/** `kindgi sites register`, with a client that keeps each call. */
async function register(flags: readonly string[] = [], env: Record<string, string> = {}) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: [...REGISTER, ...flags],
    env,
    cwd,
    home,
    clientFactory: () =>
      ({
        projects: {
          getDefault: record('getDefault', { id: DEFAULT_PROJECT }),
          list: record('list', {
            data: [{ id: PROJECT, name: 'Acme shop', slug: 'acme-shop' }],
            hasMore: false,
          }),
          sites: {
            register: record('register', {
              site: { siteId: 's-1', projectId: PROJECT, displayName: 'Acme store' },
              enrollment: { code: 'acme-code-1', expiresAt: '2026-10-10T00:15:00.000Z' },
            }),
          },
        },
      }) as never,
  });
  return { out, calls };
}

/** The project each `register` call went into. */
const registeredIn = (calls: unknown[][]) =>
  calls.filter((c) => c[0] === 'register').map((c) => c[1]);

describe('a command that would take the tenant default project', () => {
  test('takes the project stored with the key, by id, without asking for the default', async () => {
    await signedIn({ project: PROJECT });
    const { out, calls } = await register();
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls.map((c) => c[0])).toEqual(['register']);
    expect(registeredIn(calls)).toEqual([PROJECT]);
  });

  test('a slug stored with the key is looked up', async () => {
    await signedIn({ project: 'acme-shop' });
    const { out, calls } = await register();
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls.map((c) => c[0])).toEqual(['list', 'register']);
    expect(registeredIn(calls)).toEqual([PROJECT]);
  });

  test('a stored slug of no project is refused, naming the file it came from', async () => {
    await signedIn({ project: 'no-such-shop' });
    const { out, calls } = await register();
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      `The project stored with your key in ${homeFile()}: No project of this workspace has the slug "no-such-shop".`,
    );
    expect(out.stderr).toContain('Put the id there, or pass --project.');
    expect(calls.map((c) => c[0])).toEqual(['list']);
  });

  test('--project comes first', async () => {
    await signedIn({ project: PROJECT });
    const { out, calls } = await register([`--project=${DEFAULT_PROJECT}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(registeredIn(calls)).toEqual([DEFAULT_PROJECT]);
  });

  test("a key given in the env isn't the stored one: the tenant default project, as before", async () => {
    await signedIn({ project: PROJECT });
    const { out, calls } = await register([], {
      KINDGI_API_URL: SIGNED_IN,
      KINDGI_API_TOKEN: NEW_KEY,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls.map((c) => c[0])).toEqual(['getDefault', 'register']);
    expect(registeredIn(calls)).toEqual([DEFAULT_PROJECT]);
  });

  test('no project stored: the tenant default project, as before', async () => {
    await signedIn({});
    const { out, calls } = await register();
    expect(out.exitCode, out.stderr).toBe(0);
    expect(registeredIn(calls)).toEqual([DEFAULT_PROJECT]);
  });
});

describe('kindgi auth login and the project stored with the key', () => {
  let sent = 0;
  const login = (flags: readonly string[], env: Record<string, string>) =>
    runCli({
      argv: ['auth', 'login', ...flags],
      env,
      cwd,
      home,
      fetchImpl: (async () => {
        sent += 1;
        return new Response('{}', { status: 500 });
      }) as typeof fetch,
    });
  const saved = async () =>
    JSON.parse(await readFile(homeFile(), 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    sent = 0;
  });

  test('the same key again keeps it, and says nothing of it', async () => {
    await signedIn({ project: PROJECT });
    const out = await login([`--url=${SIGNED_IN}`], { KINDGI_API_TOKEN: HOME_KEY });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await saved()).toEqual({ apiUrl: SIGNED_IN, token: HOME_KEY, project: PROJECT });
    expect(out.stderr).not.toContain('project');
    expect(sent).toBe(0);
  });

  test('a new key for the same address drops it, and says so', async () => {
    await signedIn({ project: PROJECT });
    const out = await login([`--url=${SIGNED_IN}`], { KINDGI_API_TOKEN: NEW_KEY });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await saved()).toEqual({ apiUrl: SIGNED_IN, token: NEW_KEY });
    expect(out.stderr).toContain(
      `⚠ Removed project ${PROJECT} from ${homeFile()}: it was stored with the login this one replaced.`,
    );
    expect(out.stderr).not.toContain(NEW_KEY);
    expect(out.stderr).not.toContain(HOME_KEY);
  });

  test('the same key for another address drops it too, and says so', async () => {
    await signedIn({ project: PROJECT });
    const out = await login([`--url=${OTHER}`], { KINDGI_API_TOKEN: HOME_KEY });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await saved()).toEqual({ apiUrl: OTHER, token: HOME_KEY });
    expect(out.stderr).toContain(
      `⚠ Removed project ${PROJECT} from ${homeFile()}: it was stored with the login this one replaced.`,
    );
    expect(out.stderr).not.toContain('Replaced');
    expect(out.stderr).not.toContain(HOME_KEY);
  });

  test('another address, with --force: both warnings', async () => {
    await signedIn({ project: PROJECT });
    const out = await login([`--url=${OTHER}`, '--force'], { KINDGI_API_TOKEN: NEW_KEY });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await saved()).toEqual({ apiUrl: OTHER, token: NEW_KEY });
    expect(out.stderr).toContain(`⚠ Replaced the login for ${SIGNED_IN} in ${homeFile()}`);
    expect(out.stderr).toContain(`⚠ Removed project ${PROJECT} from ${homeFile()}`);
  });
});

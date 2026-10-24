// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi connection-apps …`: list, get, add (Google and GitHub, secrets by reference), remove. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ConnectionsSeam } from '../src/commands/connections.js';
import { runCli } from '../src/main.js';

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

async function run(
  argv: readonly string[],
  client: Record<string, unknown>,
  connectionsSeam: ConnectionsSeam = { interactive: () => false },
) {
  return runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
    connectionsSeam,
  });
}

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

const P1 = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
const P2 = '0b9f4c1e-1111-4a2b-8c3d-000000000002';
const APP_ID = '7d0e2c55-2222-4b3c-9d4e-000000000002';

const GOOGLE = {
  appId: APP_ID,
  app: 'google',
  label: 'Acme Workspace',
  oauth2: {
    clientId: 'cid.apps.googleusercontent.com',
    clientSecret: { envName: 'prod', name: 'GOOGLE_CLIENT_SECRET' },
  },
  redirectUrl: 'https://kindgi.acme.example/console/connect/callback',
  noticesUrl: `https://kindgi.acme.example/v1/connection-notices/t1/${APP_ID}`,
  createdAt: '2026-10-24T01:00:00.000Z',
  updatedAt: '2026-10-24T01:00:00.000Z',
};

/** A runtime that serves `prod` (whoami's `servedEnv`), or none. */
function identity(served: string | undefined) {
  return {
    whoami: async () =>
      served === undefined ? {} : { servedEnv: { envName: served, refusesOtherEnvs: true } },
  };
}

describe('kindgi connection-apps add', () => {
  test('google: the client id, the secret by <env>/<name>, and its projects', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-apps',
        'add',
        'google',
        '--client-id=cid.apps.googleusercontent.com',
        '--client-secret-ref=prod/GOOGLE_CLIENT_SECRET',
        `--projects=${P1}, ${P2}`,
      ],
      { connectionApps: { create: rec('create', GOOGLE) } },
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        {
          app: 'google',
          projects: [P1, P2],
          oauth2: {
            clientId: 'cid.apps.googleusercontent.com',
            clientSecret: { envName: 'prod', name: 'GOOGLE_CLIENT_SECRET' },
          },
        },
      ],
    ]);
    expect(JSON.parse(out.stdout).redirectUrl).toBe(GOOGLE.redirectUrl);
  });

  test('a bare <name> is under the env the runtime serves', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-apps',
        'add',
        'google',
        '--client-id=cid',
        '--client-secret-ref=GOOGLE_CLIENT_SECRET',
      ],
      { identity: identity('prod'), connectionApps: { create: rec('create', GOOGLE) } },
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        {
          app: 'google',
          oauth2: {
            clientId: 'cid',
            clientSecret: { envName: 'prod', name: 'GOOGLE_CLIENT_SECRET' },
          },
        },
      ],
    ]);
  });

  test("a bare <name> is refused when the runtime doesn't say which env it serves", async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-apps',
        'add',
        'google',
        '--client-id=cid',
        '--client-secret-ref=GOOGLE_CLIENT_SECRET',
      ],
      { identity: identity(undefined), connectionApps: { create: rec('create', GOOGLE) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--client-secret-ref needs its env, <env>/<name>');
    expect(calls).toEqual([]);
  });

  test("a malformed reference is refused without echoing it (it may be a secret's value)", async () => {
    const { calls, rec } = recorder();
    const pasted = 'Sk-Live/a-pasted-value';
    const out = await run(
      ['connection-apps', 'add', 'google', '--client-id=cid', `--client-secret-ref=${pasted}`],
      { connectionApps: { create: rec('create', GOOGLE) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("--client-secret-ref's env (before the /) must be lowercase");
    expect(out.stderr).not.toContain('Sk-Live');
    expect(out.stderr).not.toContain('a-pasted-value');
    expect(calls).toEqual([]);
  });

  test('a reference with no name is refused', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connection-apps', 'add', 'google', '--client-id=cid', '--client-secret-ref=prod/'],
      { connectionApps: { create: rec('create', GOOGLE) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--client-secret-ref must name a secret, <env>/<name>');
    expect(calls).toEqual([]);
  });

  test("google refuses a GitHub App's flags", async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-apps',
        'add',
        'google',
        '--client-id=cid',
        '--client-secret-ref=prod/S',
        '--slug=acme-kindgi',
        '--app-id=12',
      ],
      { connectionApps: { create: rec('create', GOOGLE) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--app-id, --slug: only a GitHub App takes');
    expect(calls).toEqual([]);
  });

  test('google needs --client-id and --client-secret-ref', async () => {
    const { calls, rec } = recorder();
    const noId = await run(['connection-apps', 'add', 'google', '--client-secret-ref=prod/S'], {
      connectionApps: { create: rec('create', GOOGLE) },
    });
    expect(noId.exitCode).toBe(2);
    expect(noId.stderr).toContain('Missing required flag: --client-id=<id>');
    const noSecret = await run(['connection-apps', 'add', 'google', '--client-id=cid'], {
      connectionApps: { create: rec('create', GOOGLE) },
    });
    expect(noSecret.exitCode).toBe(2);
    expect(noSecret.stderr).toContain('Missing required flag: --client-secret-ref=<env>/<name>');
    expect(calls).toEqual([]);
  });

  test("github: the app's number and slug, and its three secrets by reference", async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-apps',
        'add',
        'github',
        '--app-id=123456',
        '--slug=acme-kindgi',
        '--client-id=Iv1.abc',
        '--client-secret-ref=prod/GH_CLIENT_SECRET',
        '--private-key-ref=prod/GH_PRIVATE_KEY',
        '--webhook-secret-ref=prod/GH_WEBHOOK_SECRET',
      ],
      { connectionApps: { create: rec('create', { ...GOOGLE, app: 'github' }) } },
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        {
          app: 'github',
          githubApp: {
            appNumber: 123456,
            slug: 'acme-kindgi',
            clientId: 'Iv1.abc',
            clientSecret: { envName: 'prod', name: 'GH_CLIENT_SECRET' },
            privateKey: { envName: 'prod', name: 'GH_PRIVATE_KEY' },
            webhookSecret: { envName: 'prod', name: 'GH_WEBHOOK_SECRET' },
          },
        },
      ],
    ]);
  });

  test.each([
    [['--slug=acme-kindgi'], "Missing required flag: --app-id=<n>, the GitHub App's number"],
    [['--app-id=0', '--slug=acme-kindgi'], "--app-id is the GitHub App's number, 1 or more"],
    [['--app-id=12'], 'Missing required flag: --slug=<slug>'],
  ] as const)('github with %j is refused', async (flags, said) => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-apps',
        'add',
        'github',
        '--client-id=Iv1.abc',
        '--client-secret-ref=prod/A',
        '--private-key-ref=prod/B',
        '--webhook-secret-ref=prod/C',
        ...flags,
      ],
      { connectionApps: { create: rec('create', GOOGLE) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(said);
    expect(calls).toEqual([]);
  });
});

describe('kindgi connection-apps list and get', () => {
  test('list --table: every project when it names none, and the next page', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connection-apps', 'list', '--limit=5', '--table'], {
      connectionApps: {
        list: rec('list', {
          data: [GOOGLE, { ...GOOGLE, appId: 'a2', label: undefined, projects: [P1] }],
          hasMore: true,
          nextCursor: 'c2',
        }),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['list', { limit: 5 }]]);
    expect(out.stdout).toMatch(/Acme Workspace\s+every/);
    expect(out.stdout).toContain(P1);
    expect(out.stderr).toContain('Next page: --cursor=c2');
  });

  test('get reads one registration', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connection-apps', 'get', APP_ID], {
      connectionApps: { get: rec('get', GOOGLE) },
    });
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['get', APP_ID]]);
    expect(JSON.parse(out.stdout).oauth2.clientSecret).toEqual({
      envName: 'prod',
      name: 'GOOGLE_CLIENT_SECRET',
    });
  });
});

describe('kindgi connection-apps remove', () => {
  test('--yes --with-connections removes it and says how many it disconnected', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connection-apps', 'remove', APP_ID, '--yes', '--with-connections'], {
      connectionApps: { remove: rec('remove', { connectionsRemoved: 2 }) },
    });
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['remove', APP_ID, { withConnections: true }]]);
    expect(out.stdout).toBe(
      `Removed registration ${APP_ID}, and disconnected its 2 connections.\n`,
    );
  });

  test('--json --yes prints what the server answered', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connection-apps', 'remove', APP_ID, '--yes', '--json'], {
      connectionApps: { remove: rec('remove', { connectionsRemoved: 0 }) },
    });
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['remove', APP_ID, {}]]);
    expect(JSON.parse(out.stdout)).toEqual({ connectionsRemoved: 0 });
  });

  test('without --yes and no terminal to ask on, nothing is removed', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connection-apps', 'remove', APP_ID], {
      connectionApps: { get: rec('get', GOOGLE), remove: rec('remove', { connectionsRemoved: 0 }) },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      "kindgi connection-apps remove asks first, and there's no terminal to ask on. Run it with --yes.\n",
    );
    expect(calls).toEqual([]);
  });

  test('at a terminal it asks, naming the registration; a yes removes it', async () => {
    const { calls, rec } = recorder();
    const asked: string[] = [];
    const out = await run(
      ['connection-apps', 'remove', APP_ID, '--with-connections'],
      {
        connectionApps: {
          get: rec('get', GOOGLE),
          remove: rec('remove', { connectionsRemoved: 1 }),
        },
      },
      {
        interactive: () => true,
        confirm: async (q) => {
          asked.push(q);
          return true;
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(asked).toEqual([
      `Remove the google registration Acme Workspace (${APP_ID}), and disconnect every connection through it? [y/N] `,
    ]);
    expect(calls).toEqual([
      ['get', APP_ID],
      ['remove', APP_ID, { withConnections: true }],
    ]);
    expect(out.stdout).toBe(`Removed registration ${APP_ID}, and disconnected its connection.\n`);
  });

  test('at a terminal, a no changes nothing', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connection-apps', 'remove', APP_ID],
      {
        connectionApps: {
          get: rec('get', GOOGLE),
          remove: rec('remove', { connectionsRemoved: 0 }),
        },
      },
      { interactive: () => true, confirm: async () => false },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('kindgi connection-apps remove: nothing changed.\n');
    expect(calls).toEqual([['get', APP_ID]]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi connections …`: list, get, connect (and its wait), update, disconnect (and its question). */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
  stopSignal?: AbortSignal,
) {
  // What it says as it goes (`ctx.progress`), as the CLI streams it to stderr.
  const progress: string[] = [];
  const outcome = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
    connectionsSeam,
    progress: (text) => progress.push(text),
    ...(stopSignal !== undefined && { stopSignal }),
  });
  return { ...outcome, progress };
}

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  /** Answers each call with the next of `results`, the last one again once they run out. */
  const seq =
    (name: string, results: readonly unknown[]) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return results[Math.min(calls.filter(([n]) => n === name).length, results.length) - 1];
    };
  return { calls, rec, seq };
}

const PROJECT = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
const APP_ID = '7d0e2c55-2222-4b3c-9d4e-000000000002';
const CONNECTION_ID = '3f1a9b77-3333-4c5d-8e6f-000000000003';
const REQUEST_ID = '9c2b8a66-4444-4d6e-9f70-000000000004';

const CONNECTION = {
  connectionId: CONNECTION_ID,
  envName: 'prod',
  appId: APP_ID,
  app: 'google',
  owner: { kind: 'member', userId: 'user-ana' },
  account: { id: '1077', label: 'ana@acme.example' },
  permissions: ['gmail.send'],
  state: 'working',
  connectedAt: '2026-10-24T01:00:00.000Z',
  lastUsedAt: '2026-10-24T02:00:00.000Z',
  createdAt: '2026-10-24T01:00:00.000Z',
  createdBy: 'user-ana',
  updatedAt: '2026-10-24T02:00:00.000Z',
};

const REQUEST = {
  requestId: REQUEST_ID,
  envName: 'prod',
  appId: APP_ID,
  app: 'google',
  owner: { kind: 'member', userId: 'user-ana' },
  permissions: ['gmail.send'],
  says: ['Send email as you'],
  state: 'pending',
  connectUrl: `https://kindgi.acme.example/console/connect/${REQUEST_ID}`,
  expiresAt: '2026-10-24T03:00:00.000Z',
  createdAt: '2026-10-24T02:00:00.000Z',
  createdBy: 'user-ana',
};

const ENTRIES = {
  data: [
    {
      id: 'google',
      name: 'Google',
      owners: ['member', 'company'],
      signIn: { kind: 'oauth2' },
      permissions: {
        'gmail.send': { says: 'Send email as you', changes: true },
        'gmail.readonly': { says: 'Read your email', changes: false },
      },
      setupGuide: 'guides/connections/google',
    },
    {
      id: 'github',
      name: 'GitHub',
      owners: ['company'],
      signIn: { kind: 'github-app' },
      permissions: { 'issues.write': { says: 'Label issues', changes: true } },
      setupGuide: 'guides/connections/github',
    },
  ],
};

/** The company's connection named `support`, of the account sales@acme.example. */
const SUPPORT_ID = '5e6f7a88-5555-4e7f-8a81-000000000005';
const SUPPORT = {
  ...CONNECTION,
  connectionId: SUPPORT_ID,
  owner: { kind: 'company' },
  account: { id: '2088', label: 'sales@acme.example' },
  label: 'support',
};
/** Another app's company connection, also named `support`. */
const OTHER_SUPPORT_ID = '6f7a8b99-6666-4f80-9b92-000000000006';
const OTHER_SUPPORT = {
  ...SUPPORT,
  connectionId: OTHER_SUPPORT_ID,
  app: 'microsoft',
  account: { id: '3099', label: 'ops@acme.example' },
};

/** `connections.list` as the server answers it: only what its `app` filter keeps. */
function listing(
  rec: ReturnType<typeof recorder>['rec'],
  rows: readonly { readonly app: string }[],
): (filter?: { readonly app?: string }) => Promise<unknown> {
  return async (filter = {}) => {
    const kept = rows.filter((r) => filter.app === undefined || r.app === filter.app);
    return rec('list', { data: kept, hasMore: false })(filter);
  };
}

/** A waiting connect's seam: a person at the terminal, no real pauses, a clock before the link expires. */
function waitingSeam(overrides: Partial<ConnectionsSeam> = {}): ConnectionsSeam {
  return {
    interactive: () => true,
    pause: async () => {},
    now: () => new Date('2026-10-24T02:01:00.000Z'),
    ...overrides,
  };
}

describe('kindgi connections list and get', () => {
  test('list passes its filters, --mine as the owner filter', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connections',
        'list',
        `--project=${PROJECT}`,
        '--app=google',
        '--mine',
        '--include-removed',
        '--limit=10',
        '--cursor=c1',
      ],
      { connections: { list: rec('list', { data: [CONNECTION], hasMore: false }) } },
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      [
        'list',
        {
          projectId: PROJECT,
          app: 'google',
          owner: 'me',
          includeRemoved: true,
          limit: 10,
          cursor: 'c1',
        },
      ],
    ]);
    expect(JSON.parse(out.stdout).data[0].connectionId).toBe(CONNECTION_ID);
  });

  test('list --table shows whose account, the owner and the state with its reason', async () => {
    const { rec } = recorder();
    const company = {
      ...CONNECTION,
      owner: { kind: 'company' },
      state: 'needs-reconnecting',
      stateReason: 'invalid-grant',
    };
    const out = await run(['connections', 'list', '--table'], {
      connections: { list: rec('list', { data: [company], hasMore: true, nextCursor: 'c2' }) },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/ACCOUNT\s+OWNER\s+STATE/);
    expect(out.stdout).toMatch(
      /ana@acme\.example\s+company\s+needs-reconnecting \(invalid-grant\)/,
    );
    expect(out.stderr).toContain('Next page: --cursor=c2');
    expect(out.stdout).not.toContain('REMOVED');
  });

  test('list --include-removed --table says when each was removed', async () => {
    const { rec } = recorder();
    const removedAt = '2026-10-24T02:30:00.000Z';
    const gone = { ...CONNECTION, state: 'removed', removedAt, removedReason: 'disconnected' };
    const out = await run(['connections', 'list', '--include-removed', '--table'], {
      connections: { list: rec('list', { data: [gone], hasMore: false }) },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/LAST USED\s+REMOVED/);
    expect(out.stdout).toContain(removedAt);
  });

  test("list --table: LABEL first, its account label in its place when it has none; JSON is the wire's", async () => {
    const { rec } = recorder();
    const page = { data: [SUPPORT, CONNECTION], hasMore: false };
    const out = await run(['connections', 'list', '--table'], {
      connections: { list: rec('list', page) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const [header, , labelled, unlabelled] = out.stdout.split('\n');
    expect(header).toMatch(/^LABEL\s+ID\s+APP\s+ACCOUNT\s+OWNER/);
    expect(labelled).toMatch(
      new RegExp(`^support\\s+${SUPPORT_ID}\\s+google\\s+sales@acme\\.example`),
    );
    expect(unlabelled).toMatch(
      new RegExp(`^ana@acme\\.example\\s+${CONNECTION_ID}\\s+google\\s+ana@acme\\.example`),
    );
    const json = await run(['connections', 'list'], { connections: { list: rec('list', page) } });
    expect(JSON.parse(json.stdout)).toEqual(page);
  });

  test("list --table marks a person's main connection after its label, as `(main)`", async () => {
    const { rec } = recorder();
    const page = { data: [{ ...CONNECTION, main: true }, SUPPORT], hasMore: false };
    const out = await run(['connections', 'list', '--table'], {
      connections: { list: rec('list', page) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const [, , main, other] = out.stdout.split('\n');
    expect(main).toMatch(new RegExp(`^ana@acme\\.example \\(main\\)\\s+${CONNECTION_ID}\\s`));
    expect(other).toMatch(new RegExp(`^support\\s+${SUPPORT_ID}\\s`));
    expect(other).not.toContain('(main)');
  });

  // An empty filter read as left out would list every project's or every app's connections.
  test.each([
    ['--project=', '--project takes a value'],
    ['--app=', '--app takes a value'],
  ] as const)('list with %s, given empty, is refused', async (flag, said) => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'list', flag], {
      connections: { list: rec('list', { data: [], hasMore: false }) },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(said);
    expect(calls).toEqual([]);
  });

  test('get reads one connection', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'get', CONNECTION_ID], {
      connections: { get: rec('get', CONNECTION) },
    });
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['get', CONNECTION_ID]]);
    expect(JSON.parse(out.stdout).account.label).toBe('ana@acme.example');
  });
});

describe('kindgi connections connect', () => {
  test('without a terminal: makes the request with its flags and prints the link', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connections',
        'connect',
        'google',
        `--app-id=${APP_ID}`,
        `--project=${PROJECT}`,
        '--permissions=gmail.send, gmail.readonly',
        '--for-company',
      ],
      { connections: { connect: rec('connect', REQUEST) } },
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      [
        'connect',
        {
          app: 'google',
          permissions: ['gmail.send', 'gmail.readonly'],
          appId: APP_ID,
          projectId: PROJECT,
          for: 'company',
        },
      ],
    ]);
    expect(out.stdout).toBe(
      `Open this link to connect google:\n  ${REQUEST.connectUrl}\nIt works until ${REQUEST.expiresAt}.\n`,
    );
  });

  test('without --permissions or a terminal: refused, naming what the app offers', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'connect', 'google'], {
      connectionEntries: { list: rec('entries', ENTRIES) },
      connections: { connect: rec('connect', REQUEST) },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      "Missing --permissions=<key>,…, which of Google's permissions to ask for (there's no terminal to ask on): gmail.send: Send email as you (changes things); gmail.readonly: Read your email",
    );
    expect(calls).toEqual([['entries']]);
  });

  test('without --permissions at a terminal: asks about each, none picked for the person', async () => {
    const { calls, rec } = recorder();
    const asked: string[] = [];
    const out = await run(
      ['connections', 'connect', 'google', '--json'],
      {
        connectionEntries: { list: rec('entries', ENTRIES) },
        connections: { connect: rec('connect', REQUEST) },
      },
      waitingSeam({
        confirm: async (question) => {
          asked.push(question);
          return question.includes('gmail.readonly');
        },
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(asked).toEqual([
      'Ask Google for gmail.send: Send email as you (changes things)? [y/N] ',
      'Ask Google for gmail.readonly: Read your email? [y/N] ',
    ]);
    expect(calls).toEqual([
      ['entries'],
      ['connect', { app: 'google', permissions: ['gmail.readonly'] }],
    ]);
  });

  test('at a terminal, a person who picks no permission asks nothing of the app', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google'],
      {
        connectionEntries: { list: rec('entries', ENTRIES) },
        connections: { connect: rec('connect', REQUEST) },
      },
      waitingSeam({ confirm: async () => false }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      'kindgi connections connect: no permission picked, so nothing was asked.\n',
    );
    expect(calls).toEqual([['entries']]);
  });

  test('an app the server has no entry for is refused, naming the ones it has', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'connect', 'dropbox'], {
      connectionEntries: { list: rec('entries', ENTRIES) },
      connections: { connect: rec('connect', REQUEST) },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      'This server connects no app "dropbox"; it connects google, github',
    );
    expect(calls).toEqual([['entries']]);
  });

  test('--permissions that names none is refused before anything is asked', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'connect', 'google', '--permissions=, ,'], {
      connections: { connect: rec('connect', REQUEST) },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--permissions names no permission');
    expect(calls).toEqual([]);
  });

  // An empty --app-id or --project read as left out would leave the server to pick.
  test.each([
    [['--permissions=gmail.send', '--app-id='], '--app-id takes a value'],
    [['--permissions=gmail.send', '--project='], '--project takes a value'],
    [['--permissions='], '--permissions takes a value'],
  ] as const)('connect with %j, given empty, is refused', async (flags, said) => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'connect', 'google', ...flags], {
      connections: { connect: rec('connect', REQUEST) },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(said);
    expect(calls).toEqual([]);
  });

  test('--json prints the request and does not wait, even at a terminal', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send', '--json'],
      { connections: { connect: rec('connect', REQUEST), getRequest: rec('getRequest', REQUEST) } },
      waitingSeam(),
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).connectUrl).toBe(REQUEST.connectUrl);
    expect(calls.map(([name]) => name)).toEqual(['connect']);
    expect(out.progress).toEqual([]);
  });

  test('at a terminal: shows the link, waits, and says whose account it connected', async () => {
    const { calls, rec, seq } = recorder();
    const done = { ...REQUEST, state: 'connected', connectionId: CONNECTION_ID };
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send'],
      {
        connections: {
          connect: rec('connect', REQUEST),
          getRequest: seq('getRequest', [REQUEST, done]),
          get: rec('get', CONNECTION),
        },
      },
      waitingSeam(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.progress.join('')).toContain(
      `Open this link to connect google:\n  ${REQUEST.connectUrl}\n`,
    );
    expect(out.progress.join('')).toContain('Waiting for the connect to finish');
    expect(calls.map(([name]) => name)).toEqual(['connect', 'getRequest', 'getRequest', 'get']);
    expect(out.stdout).toBe(
      `Connected ana@acme.example at google (connection ${CONNECTION_ID}).\n`,
    );
    expect(out.stderr).toBe('');
  });

  test('at a terminal, given no progress to stream to, the link still goes out before the wait: to stderr', async () => {
    const { rec, seq } = recorder();
    const done = { ...REQUEST, state: 'connected', connectionId: CONNECTION_ID };
    const written: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const out = await runCli({
        argv: [
          'connections',
          'connect',
          'google',
          '--permissions=gmail.send',
          '--url=https://x',
          '--token=t',
        ],
        env: {},
        cwd,
        home,
        clientFactory: () =>
          ({
            connections: {
              connect: rec('connect', REQUEST),
              getRequest: seq('getRequest', [REQUEST, done]),
              get: rec('get', CONNECTION),
            },
          }) as never,
        connectionsSeam: waitingSeam(),
      });
      expect(out.exitCode).toBe(0);
      expect(written.join('')).toContain(
        `Open this link to connect google:\n  ${REQUEST.connectUrl}\n`,
      );
      expect(out.stderr).toBe('');
    } finally {
      write.mockRestore();
    }
  });

  describe("a person's second connection: which of theirs their agents use", () => {
    const done = { ...REQUEST, state: 'connected', connectionId: CONNECTION_ID };
    // Another of Ana's, through the same registration in the same env.
    const work = { ...CONNECTION, connectionId: SUPPORT_ID, label: 'work' };
    const elsewhere = {
      ...CONNECTION,
      connectionId: '9a8b7c66-6666-4d5e-8f90-000000000006',
      envName: 'staging',
      main: true,
    };
    const connectWith = (list: () => Promise<unknown>) => {
      const { calls, rec, seq } = recorder();
      return {
        calls,
        out: run(
          ['connections', 'connect', 'google', '--permissions=gmail.send'],
          {
            connections: {
              connect: rec('connect', REQUEST),
              getRequest: seq('getRequest', [REQUEST, done]),
              get: rec('get', CONNECTION),
              list,
            },
          },
          waitingSeam(),
        ),
      };
    };

    test('their main says it is, and how to make this one main instead', async () => {
      const filters: unknown[] = [];
      const { out } = connectWith(async (...args: unknown[]) => {
        filters.push(args[0]);
        return { data: [CONNECTION, { ...work, main: true }, elsewhere], hasMore: false };
      });
      const said = await out;
      expect(said.exitCode, said.stderr).toBe(0);
      expect(filters).toEqual([{ app: 'google', owner: 'me' }]);
      expect(said.stderr).toBe(
        `work is your main connection at google, the one your agents use when no choice names another: \`kindgi connections update ${CONNECTION_ID} --main\` makes this one your main.\n`,
      );
    });

    test('several and none main says their calls stop until one is, or a choice names one', async () => {
      const { out } = connectWith(async () => ({
        data: [CONNECTION, work, elsewhere],
        hasMore: false,
      }));
      const said = await out;
      expect(said.exitCode, said.stderr).toBe(0);
      expect(said.stderr).toBe(
        'You have 2 connections at google and none is your main, so a call of your agents that needs one stops with connection-not-chosen until you make one your main, or a choice names one: `kindgi connections update <connection> --main`.\n',
      );
    });

    test('their first says nothing, and a list that fails adds nothing: the connect still succeeded', async () => {
      for (const list of [
        async () => ({ data: [CONNECTION, elsewhere], hasMore: false }),
        async () => {
          throw new Error('the list failed');
        },
      ]) {
        const said = await connectWith(list).out;
        expect(said.exitCode, said.stderr).toBe(0);
        expect(said.stdout).toBe(
          `Connected ana@acme.example at google (connection ${CONNECTION_ID}).\n`,
        );
        expect(said.stderr).toBe('');
      }
    });
  });

  test('a company connection says so', async () => {
    const { rec } = recorder();
    const done = { ...REQUEST, state: 'connected', connectionId: CONNECTION_ID };
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send', '--for-company'],
      {
        connections: {
          connect: rec('connect', REQUEST),
          getRequest: rec('getRequest', done),
          get: rec('get', { ...CONNECTION, owner: { kind: 'company' } }),
        },
      },
      waitingSeam(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(
      `Connected ana@acme.example at google, the company's account (connection ${CONNECTION_ID}).\n`,
    );
  });

  test('a partial grant ends declined, yet says whose account it stored and what is missing', async () => {
    const { calls, rec } = recorder();
    const partial = {
      ...REQUEST,
      permissions: ['gmail.send', 'gmail.readonly'],
      state: 'declined',
      connectionId: CONNECTION_ID,
      missing: ['gmail.readonly'],
    };
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send,gmail.readonly'],
      {
        connections: {
          connect: rec('connect', REQUEST),
          getRequest: rec('getRequest', partial),
          get: rec('get', CONNECTION),
        },
      },
      waitingSeam(),
    );
    expect(out.exitCode).toBe(1);
    expect(calls.map(([name]) => name)).toEqual(['connect', 'getRequest', 'get']);
    expect(out.stdout).toBe(
      `Connected ana@acme.example at google (connection ${CONNECTION_ID}), with less than asked.\n`,
    );
    expect(out.stderr).toBe(
      'The app granted less than asked: not gmail.readonly. Tools that need those ask to connect again.\n',
    );
  });

  test.each([
    [
      'a connect that kept nothing from its sign-in names what was not allowed',
      { missing: ['gmail.send'] },
      'Declined at google (not gmail.send): nothing from this sign-in was kept.',
    ],
    [
      'a reconnect allowed less than its connection has leaves it as it was',
      { reconnects: CONNECTION_ID, missing: ['gmail.readonly'] },
      `Declined at google (not gmail.readonly): connection ${CONNECTION_ID} stays as it was.`,
    ],
  ] as const)('declined without a connection: %s', async (_title, extra, said) => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send'],
      {
        connections: {
          connect: rec('connect', REQUEST),
          getRequest: rec('getRequest', { ...REQUEST, state: 'declined', ...extra }),
        },
      },
      waitingSeam(),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(`${said}\n`);
    expect(calls.map(([name]) => name)).toEqual(['connect', 'getRequest']);
  });

  test.each([
    ['declined', {}, 'Declined at google: nothing from this sign-in was kept.'],
    [
      'failed',
      { failure: 'account-mismatch' },
      'The connect failed (account-mismatch): nothing connected.',
    ],
    ['expired', {}, 'The link expired before the connect finished: nothing connected.'],
  ] as const)('a request that ends %s exits 1 and says so', async (state, extra, said) => {
    const { rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send'],
      {
        connections: {
          connect: rec('connect', REQUEST),
          getRequest: rec('getRequest', { ...REQUEST, state, ...extra }),
        },
      },
      waitingSeam(),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(`${said}\n`);
  });

  test("a state this CLI doesn't know ends the wait, said as the server gave it", async () => {
    const { rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send'],
      {
        connections: {
          connect: rec('connect', REQUEST),
          getRequest: rec('getRequest', { ...REQUEST, state: 'cancelled' }),
        },
      },
      waitingSeam(),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('The connect ended cancelled: nothing connected.\n');
  });

  test('stops waiting once the link expired, though the request still reads pending', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send'],
      { connections: { connect: rec('connect', REQUEST), getRequest: rec('getRequest', REQUEST) } },
      waitingSeam({ now: () => new Date('2026-10-24T03:00:00.000Z') }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('The link expired before the connect finished: nothing connected.\n');
    expect(calls.map(([name]) => name)).toEqual(['connect', 'getRequest']);
  });

  test('Ctrl-C stops the wait: the link still works, and it says where to look', async () => {
    const { calls, rec } = recorder();
    const stop = new AbortController();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send'],
      { connections: { connect: rec('connect', REQUEST), getRequest: rec('getRequest', REQUEST) } },
      waitingSeam({ pause: async () => stop.abort() }),
      stop.signal,
    );
    expect(out.exitCode).toBe(130);
    expect(out.stderr).toContain(`Stopped waiting. The link works until ${REQUEST.expiresAt}`);
    expect(out.stderr).toContain('`kindgi connections list --app=google`');
    expect(calls.map(([name]) => name)).toEqual(['connect']);
  });

  describe('--quiet: the link alone, since it is what the person opens', () => {
    const LINK = `${REQUEST.connectUrl}\n`;

    test('without a terminal: stdout is exactly the bare URL, on one line', async () => {
      const { calls, rec } = recorder();
      const out = await run(
        ['connections', 'connect', 'google', '--permissions=gmail.send', '--quiet'],
        {
          connections: { connect: rec('connect', REQUEST) },
        },
      );
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe(LINK);
      expect(out.stderr).toBe('');
      expect(calls.map(([name]) => name)).toEqual(['connect']);
    });

    test('at a terminal: the link first, then it still waits, saying nothing once connected', async () => {
      const { calls, rec, seq } = recorder();
      const results: string[] = [];
      const done = { ...REQUEST, state: 'connected', connectionId: CONNECTION_ID };
      const out = await run(
        ['connections', 'connect', 'google', '--permissions=gmail.send', '--quiet'],
        {
          connections: {
            connect: rec('connect', REQUEST),
            getRequest: seq('getRequest', [REQUEST, done]),
            get: rec('get', CONNECTION),
          },
        },
        waitingSeam({ result: (line) => results.push(line) }),
      );
      expect(out.exitCode).toBe(0);
      expect(results).toEqual([LINK]);
      expect(out.progress).toEqual([]);
      expect(calls.map(([name]) => name)).toEqual(['connect', 'getRequest', 'getRequest', 'get']);
      expect(out.stdout).toBe('');
      expect(out.stderr).toBe('');
    });

    test('a partial grant still says what is missing, and exits 1', async () => {
      const { rec } = recorder();
      const results: string[] = [];
      const partial = {
        ...REQUEST,
        permissions: ['gmail.send', 'gmail.readonly'],
        state: 'declined',
        connectionId: CONNECTION_ID,
        missing: ['gmail.readonly'],
      };
      const out = await run(
        ['connections', 'connect', 'google', '--permissions=gmail.send,gmail.readonly', '--quiet'],
        {
          connections: {
            connect: rec('connect', REQUEST),
            getRequest: rec('getRequest', partial),
            get: rec('get', CONNECTION),
          },
        },
        waitingSeam({ result: (line) => results.push(line) }),
      );
      expect(out.exitCode).toBe(1);
      expect(results).toEqual([LINK]);
      expect(out.stdout).toBe('');
      expect(out.stderr).toBe(
        'The app granted less than asked: not gmail.readonly. Tools that need those ask to connect again.\n',
      );
    });
  });
});

describe('kindgi connections connect --label and --reconnect', () => {
  test('--label goes on the connect as the name asked for', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send', '--label=support'],
      { connections: { connect: rec('connect', REQUEST) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['connect', { app: 'google', permissions: ['gmail.send'], label: 'support' }],
    ]);
  });

  test("--reconnect by name: looked up among the owner's own at the app, sent as its id", async () => {
    const mine = recorder();
    const out = await run(
      [
        'connections',
        'connect',
        'google',
        '--permissions=gmail.send',
        '--reconnect=ana@acme.example',
      ],
      {
        connections: {
          list: listing(mine.rec, [CONNECTION]),
          connect: mine.rec('connect', REQUEST),
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(mine.calls).toEqual([
      ['list', { app: 'google', owner: 'me' }],
      ['connect', { app: 'google', permissions: ['gmail.send'], reconnects: CONNECTION_ID }],
    ]);

    const company = recorder();
    const theirs = await run(
      [
        'connections',
        'connect',
        'google',
        '--permissions=gmail.send',
        '--for-company',
        '--reconnect=support',
      ],
      {
        connections: {
          list: listing(company.rec, [SUPPORT, OTHER_SUPPORT]),
          connect: company.rec('connect', REQUEST),
        },
      },
    );
    expect(theirs.exitCode, theirs.stderr).toBe(0);
    expect(company.calls).toEqual([
      ['list', { app: 'google', ownerKind: 'company' }],
      [
        'connect',
        { app: 'google', permissions: ['gmail.send'], for: 'company', reconnects: SUPPORT_ID },
      ],
    ]);
  });

  test('--reconnect by id is sent as it is, without a lookup', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send', `--reconnect=${SUPPORT_ID}`],
      { connections: { connect: rec('connect', REQUEST) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['connect', { app: 'google', permissions: ['gmail.send'], reconnects: SUPPORT_ID }],
    ]);
  });

  test('--label with --reconnect is refused before any call: a reconnect keeps its name', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connections',
        'connect',
        'google',
        '--permissions=gmail.send',
        '--label=support',
        `--reconnect=${SUPPORT_ID}`,
      ],
      { connections: { connect: rec('connect', REQUEST) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      'a reconnect keeps its name (`kindgi connections update` renames it)',
    );
    expect(calls).toEqual([]);
  });

  test('a connection-not-found for the reconnect names --reconnect', async () => {
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send', `--reconnect=${SUPPORT_ID}`],
      {
        connections: {
          connect: async () => {
            throw new KindgiApiError(
              fromWire(
                {
                  code: 'connection-not-found',
                  message: 'No such connection to reconnect',
                  details: { field: 'reconnects' },
                },
                404,
              ),
            );
          },
        },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('Error [not-found]: --reconnect: No such connection to reconnect\n');
  });

  test('the finish names the label first, then whose account at which app', async () => {
    const done = { ...REQUEST, state: 'connected', connectionId: SUPPORT_ID };
    const said = async (connection: Record<string, unknown>, state = done) => {
      const { rec } = recorder();
      return run(
        ['connections', 'connect', 'google', '--permissions=gmail.send', '--for-company'],
        {
          connections: {
            connect: rec('connect', REQUEST),
            getRequest: rec('getRequest', state),
            get: rec('get', connection),
          },
        },
        waitingSeam(),
      );
    };
    expect((await said(SUPPORT)).stdout).toBe(
      `Connected support (sales@acme.example at google, company) (connection ${SUPPORT_ID}).\n`,
    );
    expect((await said({ ...SUPPORT, owner: CONNECTION.owner })).stdout).toBe(
      `Connected support (sales@acme.example at google) (connection ${SUPPORT_ID}).\n`,
    );
    // A label that is its account's own is said once.
    expect((await said({ ...SUPPORT, label: 'sales@acme.example' })).stdout).toBe(
      `Connected sales@acme.example at google, the company's account (connection ${SUPPORT_ID}).\n`,
    );
    const partial = { ...done, state: 'declined', missing: ['gmail.readonly'] };
    expect((await said(SUPPORT, partial)).stdout).toBe(
      `Connected support (sales@acme.example at google, company) (connection ${SUPPORT_ID}), with less than asked.\n`,
    );
  });
});

describe('kindgi connections update', () => {
  async function rename(
    argv: readonly string[],
    rows: readonly { readonly connectionId: string; readonly app: string }[],
  ) {
    const r = recorder();
    const byId = new Map(rows.map((c) => [c.connectionId, c] as const));
    const out = await run(['connections', 'update', ...argv], {
      connections: {
        list: listing(r.rec, rows),
        get: async (id: string) => r.rec('get', byId.get(id))(id),
        update: async (id: string, input: { label: string }) =>
          r.rec('update', { ...byId.get(id), label: input.label })(id, input),
      },
    });
    return { out, calls: r.calls };
  }

  test('by id: no lookup; says the old name and the new', async () => {
    const { out, calls } = await rename([CONNECTION_ID, '--label=ana'], [CONNECTION]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['get', CONNECTION_ID],
      ['update', CONNECTION_ID, { label: 'ana' }],
    ]);
    expect(out.stderr).toBe(`Renamed ana@acme.example to ana (connection ${CONNECTION_ID}).\n`);
    expect(JSON.parse(out.stdout)).toMatchObject({ connectionId: CONNECTION_ID, label: 'ana' });
  });

  test('by its label, any case; by its account label only when it has no label', async () => {
    const rows = [SUPPORT, CONNECTION];
    const byLabel = await rename(['Support', '--label=helpdesk'], rows);
    expect(byLabel.out.exitCode, byLabel.out.stderr).toBe(0);
    expect(byLabel.calls).toEqual([
      ['list', {}],
      ['update', SUPPORT_ID, { label: 'helpdesk' }],
    ]);
    expect(byLabel.out.stderr).toBe(`Renamed support to helpdesk (connection ${SUPPORT_ID}).\n`);

    const byAccount = await rename(['ana@acme.example', '--label=ana'], rows);
    expect(byAccount.calls.at(-1)).toEqual(['update', CONNECTION_ID, { label: 'ana' }]);

    // support's account is sales@acme.example, but it's named support.
    const named = await rename(['sales@acme.example', '--label=sales'], rows);
    expect(named.out.exitCode).toBe(2);
    expect(named.out.stderr).toContain('No connection is named "sales@acme.example"');
    expect(named.calls).toEqual([['list', {}]]);
  });

  test('a name several connections have is refused, listing them; --app narrows it', async () => {
    const rows = [SUPPORT, OTHER_SUPPORT];
    const both = await rename(['support', '--label=helpdesk'], rows);
    expect(both.out.exitCode).toBe(2);
    expect(both.out.stderr).toContain('"support" names 2 connections:');
    expect(both.out.stderr).toContain(
      `  support  sales@acme.example at google, company  ${SUPPORT_ID}\n`,
    );
    expect(both.out.stderr).toContain(
      `  support  ops@acme.example at microsoft, company  ${OTHER_SUPPORT_ID}\n`,
    );
    expect(both.out.stderr).toContain('--app=<app> narrows it; or pass the connection id.');
    expect(both.calls).toEqual([['list', {}]]);

    const narrowed = await rename(['support', '--app=microsoft', '--label=helpdesk'], rows);
    expect(narrowed.out.exitCode, narrowed.out.stderr).toBe(0);
    expect(narrowed.calls).toEqual([
      ['list', { app: 'microsoft' }],
      ['update', OTHER_SUPPORT_ID, { label: 'helpdesk' }],
    ]);
  });

  test('a name none has is refused, saying how to list them', async () => {
    const none = await rename(['nobody', '--label=x'], [SUPPORT]);
    expect(none.out.exitCode).toBe(2);
    expect(none.out.stderr).toContain(
      'No connection is named "nobody". `kindgi connections list` shows them; pass a connection id instead.',
    );
    const at = await rename(['support', '--app=microsoft', '--label=x'], [SUPPORT]);
    expect(at.out.stderr).toContain(
      'No connection at microsoft is named "support". `kindgi connections list --app=microsoft` shows them',
    );
    expect(at.calls).toEqual([['list', { app: 'microsoft' }]]);
  });

  test('the lookup reads every page', async () => {
    const { calls, rec, seq } = recorder();
    const out = await run(['connections', 'update', 'support', '--label=helpdesk'], {
      connections: {
        list: seq('list', [
          { data: [CONNECTION], hasMore: true, nextCursor: 'c2' },
          { data: [SUPPORT], hasMore: false },
        ]),
        update: rec('update', { ...SUPPORT, label: 'helpdesk' }),
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', {}],
      ['list', { cursor: 'c2' }],
      ['update', SUPPORT_ID, { label: 'helpdesk' }],
    ]);
  });

  test.each([
    [['support'], 'Missing required flag: --label=<name> or --main'],
    [['support', '--label='], '--label takes a value'],
    [['support', '--label=  '], '--label takes a value'],
    [['--label=helpdesk'], 'connection'],
    [['support', '--label=helpdesk', '--main'], '--label or --main, one change at a time'],
  ] as const)('%j is refused before any call', async (argv, said) => {
    const { out, calls } = await rename(argv, [SUPPORT]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(said);
    expect(calls).toEqual([]);
  });
});

describe('kindgi connections update --main', () => {
  /** The person's own connections at google: work, their main, and school. */
  const SCHOOL_ID = '7a8b9cad-7777-4a91-8ca3-000000000007';
  const WORK = { ...CONNECTION, label: 'work', main: true };
  const SCHOOL = {
    ...CONNECTION,
    connectionId: SCHOOL_ID,
    label: 'school',
    account: { id: '1078', label: 'ana@school.acme.example' },
  };

  test('by name: looked up among your own only, made your main, and said so', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'update', 'school', '--main'], {
      connections: {
        list: listing(rec, [WORK, SCHOOL]),
        update: rec('update', { ...SCHOOL, main: true }),
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { owner: 'me' }],
      ['update', SCHOOL_ID, { main: true }],
    ]);
    expect(out.stderr).toBe(
      `Made school your main connection at google (connection ${SCHOOL_ID}).\n`,
    );
    expect(JSON.parse(out.stdout)).toMatchObject({ connectionId: SCHOOL_ID, main: true });
  });

  test('by id: read first; the main one already changes nothing, and says so', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'update', CONNECTION_ID, '--main'], {
      connections: { get: rec('get', WORK), update: rec('update', WORK) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['get', CONNECTION_ID],
      ['update', CONNECTION_ID, { main: true }],
    ]);
    expect(out.stderr).toBe('work is already your main connection at google: nothing changed.\n');
  });

  test("the server's refusal, a company connection's here, is said as it gave it", async () => {
    const out = await run(['connections', 'update', SUPPORT_ID, '--main'], {
      connections: {
        get: async () => SUPPORT,
        update: async () => {
          throw new KindgiApiError(
            fromWire(
              {
                code: 'bad-input',
                message:
                  "The company has no main connection: its agents use the company's through their choices.",
                details: { field: 'main' },
              },
              400,
            ),
          );
        },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "The company has no main connection: its agents use the company's through their choices.",
    );
  });
});

describe('kindgi connections disconnect', () => {
  const removed = {
    ...CONNECTION,
    state: 'removed',
    removedAt: '2026-10-24T02:30:00.000Z',
    removedReason: 'disconnected',
    withdrawn: 'at-app',
  };

  test('--yes disconnects without asking, and says what was done at the app', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'disconnect', CONNECTION_ID, '--yes'], {
      connections: { disconnect: rec('disconnect', removed) },
    });
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['disconnect', CONNECTION_ID]]);
    expect(out.stdout).toBe(
      'Disconnected ana@acme.example at google: its access is withdrawn at the app and its token destroyed here.\n',
    );
  });

  test.each([
    ['app-failed', 'the app refused to withdraw its access, so revoke it there too'],
    ['kept-for-other-connection', 'the grant at the app stays, since another connection uses it'],
    ['not-supported', "the app can't withdraw this connection alone"],
  ] as const)('says what %s means', async (withdrawn, said) => {
    const { rec } = recorder();
    const out = await run(['connections', 'disconnect', CONNECTION_ID, '--yes'], {
      connections: { disconnect: rec('disconnect', { ...removed, withdrawn }) },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(said);
  });

  test.each([
    ['at-app', ''],
    ['kept-for-other-connection', ''],
    [
      'app-failed',
      'Disconnected ana@acme.example at google: the app refused to withdraw its access, so revoke it there too; its token is destroyed here.\n',
    ],
    [
      'not-supported',
      "Disconnected ana@acme.example at google: the app can't withdraw this connection alone, so revoke it there if it should go; its token is destroyed here.\n",
    ],
  ] as const)('--quiet says only what is left to do at the app (%s)', async (withdrawn, said) => {
    const { rec } = recorder();
    const out = await run(['connections', 'disconnect', CONNECTION_ID, '--yes', '--quiet'], {
      connections: { disconnect: rec('disconnect', { ...removed, withdrawn }) },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(said);
  });

  test('--json prints the removed connection', async () => {
    const { rec } = recorder();
    const out = await run(['connections', 'disconnect', CONNECTION_ID, '--yes', '--json'], {
      connections: { disconnect: rec('disconnect', removed) },
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).withdrawn).toBe('at-app');
  });

  test('without --yes and no terminal to ask on, nothing is disconnected', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connections', 'disconnect', CONNECTION_ID], {
      connections: { get: rec('get', CONNECTION), disconnect: rec('disconnect', removed) },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      "kindgi connections disconnect asks first, and there's no terminal to ask on. Run it with --yes.\n",
    );
    expect(calls).toEqual([]);
  });

  test('at a terminal it asks, naming the account; a no changes nothing', async () => {
    const { calls, rec } = recorder();
    const asked: string[] = [];
    const out = await run(
      ['connections', 'disconnect', CONNECTION_ID],
      { connections: { get: rec('get', CONNECTION), disconnect: rec('disconnect', removed) } },
      {
        interactive: () => true,
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(asked).toEqual([
      "Disconnect ana@acme.example at google (user-ana)? Tools that use it stop working until it's connected again. [y/N] ",
    ]);
    expect(out.stderr).toBe('kindgi connections disconnect: nothing changed.\n');
    expect(calls).toEqual([['get', CONNECTION_ID]]);
  });

  test('at a terminal, a yes disconnects', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connections', 'disconnect', CONNECTION_ID],
      {
        connections: {
          get: rec('get', { ...CONNECTION, owner: { kind: 'company' } }),
          disconnect: rec('disconnect', removed),
        },
      },
      { interactive: () => true, confirm: async (q) => q.includes("(the company's account)") },
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      ['get', CONNECTION_ID],
      ['disconnect', CONNECTION_ID],
    ]);
  });
});

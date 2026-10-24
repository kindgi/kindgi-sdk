// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi connections …`: list, get, connect (and its wait), disconnect (and its question). */

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
  stopSignal?: AbortSignal,
) {
  return runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
    connectionsSeam,
    ...(stopSignal !== undefined && { stopSignal }),
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

/** A waiting connect's seam: a person at the terminal, no real pauses, a clock before the link expires. */
function waitingSeam(lines: string[], overrides: Partial<ConnectionsSeam> = {}): ConnectionsSeam {
  return {
    interactive: () => true,
    pause: async () => {},
    now: () => new Date('2026-10-24T02:01:00.000Z'),
    progress: (line) => lines.push(line),
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
      waitingSeam([], {
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
      waitingSeam([], { confirm: async () => false }),
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
    const lines: string[] = [];
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send', '--json'],
      { connections: { connect: rec('connect', REQUEST), getRequest: rec('getRequest', REQUEST) } },
      waitingSeam(lines),
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).connectUrl).toBe(REQUEST.connectUrl);
    expect(calls.map(([name]) => name)).toEqual(['connect']);
    expect(lines).toEqual([]);
  });

  test('at a terminal: shows the link, waits, and says whose account it connected', async () => {
    const { calls, rec, seq } = recorder();
    const lines: string[] = [];
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
      waitingSeam(lines),
    );
    expect(out.exitCode).toBe(0);
    expect(lines.join('')).toContain(
      `Open this link to connect google:\n  ${REQUEST.connectUrl}\n`,
    );
    expect(lines.join('')).toContain('Waiting for the connect to finish');
    expect(calls.map(([name]) => name)).toEqual(['connect', 'getRequest', 'getRequest', 'get']);
    expect(out.stdout).toBe(
      `Connected ana@acme.example at google (connection ${CONNECTION_ID}).\n`,
    );
    expect(out.stderr).toBe('');
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
      waitingSeam([]),
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
      waitingSeam([]),
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
      'a connect that stored nothing names what was not allowed',
      { missing: ['gmail.send'] },
      'Declined at google (not gmail.send): nothing connected.',
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
      waitingSeam([]),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(`${said}\n`);
    expect(calls.map(([name]) => name)).toEqual(['connect', 'getRequest']);
  });

  test.each([
    ['declined', {}, 'Declined at google: nothing connected.'],
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
      waitingSeam([]),
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
      waitingSeam([]),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('The connect ended cancelled: nothing connected.\n');
  });

  test('stops waiting once the link expired, though the request still reads pending', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connections', 'connect', 'google', '--permissions=gmail.send'],
      { connections: { connect: rec('connect', REQUEST), getRequest: rec('getRequest', REQUEST) } },
      waitingSeam([], { now: () => new Date('2026-10-24T03:00:00.000Z') }),
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
      waitingSeam([], { pause: async () => stop.abort() }),
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
      const lines: string[] = [];
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
        waitingSeam(lines, { result: (line) => results.push(line) }),
      );
      expect(out.exitCode).toBe(0);
      expect(results).toEqual([LINK]);
      expect(lines).toEqual([]);
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
        waitingSeam([], { result: (line) => results.push(line) }),
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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi text-triggers`, through the client's `textTriggers`. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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

const ID = '11111111-1111-4111-8111-111111111111';
const BOT = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';
const FRONT_DESK_ID = '5e6f7a88-5555-4e7f-8a81-000000000005';
const SALES_ID = '3f1a9b77-3333-4c5d-8e6f-000000000003';
const TRIGGER = {
  triggerId: ID,
  agentId: 'acme.support',
  projectId: 'p-1',
  owner: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', displayName: 'Ada Lovelace' },
  connectionId: FRONT_DESK_ID,
  runsPerHour: 60,
  perSenderPerHour: 10,
  label: 'front desk',
  status: 'active',
  lastFiredAt: null,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};
const FIRE = {
  fireId: 'f-1',
  triggerId: ID,
  firedAt: '2026-10-26T01:00:00.000Z',
  outcome: 'refused',
  detail: 'over-limit: 10 runs an hour from one sender',
};
const VERSIONS = {
  data: [
    {
      triggerId: ID,
      version: 2,
      createdAt: '2026-10-27T00:00:00.000Z',
      createdBy: BOT,
      cause: 'owner',
      definition: { agentId: 'acme.support', connectionId: FRONT_DESK_ID },
    },
    {
      triggerId: ID,
      version: 1,
      createdAt: '2026-10-26T01:00:00.000Z',
      cause: 'unversioned-edit',
      definition: { agentId: 'acme.support', connectionId: FRONT_DESK_ID },
    },
  ],
  hasMore: true,
  nextCursor: 'c-2',
};
/** The project's company connections of app `texts`: one per business number. */
const CANDIDATES = [
  { connectionId: FRONT_DESK_ID, name: 'front-desk', app: 'texts', accountLabel: '+15550100' },
  { connectionId: SALES_ID, name: 'sales', app: 'texts', accountLabel: '+15550101' },
];

type Record_ = (name: string, result: unknown) => (...args: unknown[]) => Promise<unknown>;

/** The project's company connections, and its Default project's id. */
const lookups = (record: Record_) => ({
  projects: { getDefault: record('getDefault', { id: 'p-default' }) },
  connectionChoices: {
    candidates: record('candidates', { data: CANDIDATES, hasMore: false }),
  },
});

/**
 * `kindgi text-triggers ...` against a recording client; `more` adds to it or
 * replaces some of `textTriggers`'s methods.
 */
async function textTriggers(
  argv: readonly string[],
  taken: Record<string, unknown> = TRIGGER,
  more: (record: Record_) => Record<string, Record<string, unknown>> = () => ({}),
) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['text-triggers', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => {
      const extra = more(record);
      return {
        ...extra,
        textTriggers: {
          list: record('list', { data: [TRIGGER], hasMore: false }),
          get: record('get', TRIGGER),
          getVersion: record('getVersion', VERSIONS.data[0]),
          versions: record('versions', VERSIONS),
          register: record('register', TRIGGER),
          update: record('update', TRIGGER),
          pause: record('pause', TRIGGER),
          resume: record('resume', TRIGGER),
          unregister: record('unregister', { triggerId: ID, unregistered: true }),
          fires: record('fires', { data: [FIRE], hasMore: false }),
          takeOwnership: record('takeOwnership', taken),
          ...extra.textTriggers,
        },
      } as never;
    },
  });
  return { out, calls };
}

/** The server's 409 when another live text trigger answers the connection. */
const connectionTaken = async () => {
  throw new KindgiApiError(
    fromWire(
      {
        code: 'trigger-connection-taken',
        message: `Text trigger "${OTHER}" already answers connection "${FRONT_DESK_ID}"`,
        details: { heldBy: OTHER, connectionId: FRONT_DESK_ID },
      },
      409,
    ),
  );
};

describe('kindgi text-triggers', () => {
  test('create: the connection, limits and label go in the body', async () => {
    const { out, calls } = await textTriggers([
      'create',
      '--agent=acme.support',
      `--connection=${FRONT_DESK_ID}`,
      '--runs-per-hour=30',
      '--per-sender-per-hour=5',
      '--label=front desk',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'register',
        {
          agentId: 'acme.support',
          config: { connectionId: FRONT_DESK_ID, runsPerHour: 30, perSenderPerHour: 5 },
          label: 'front desk',
        },
      ],
    ]);

    const shared = await textTriggers([
      'create',
      '--flow=acme.triage',
      '--flow-version=1.0.0',
      `--connection=${FRONT_DESK_ID}`,
      '--project=p-1',
      `--run-as=${BOT}`,
    ]);
    expect(shared.out.exitCode, shared.out.stderr).toBe(0);
    expect(shared.calls).toEqual([
      [
        'register',
        {
          flowId: 'acme.triage',
          flowVersion: '1.0.0',
          config: { connectionId: FRONT_DESK_ID },
          projectId: 'p-1',
          runAsServiceAccountId: BOT,
        },
      ],
    ]);
  });

  test('create refuses before the call: no --connection, or a limit that is not a whole number', async () => {
    for (const [argv, message] of [
      [['--agent=acme.support'], '--connection=<connection> is required'],
      [['--agent=acme.support', '--connection='], '--connection'],
      [
        ['--agent=acme.support', `--connection=${FRONT_DESK_ID}`, '--runs-per-hour=many'],
        '--runs-per-hour',
      ],
      [
        ['--agent=acme.support', `--connection=${FRONT_DESK_ID}`, '--per-sender-per-hour=1.5'],
        '--per-sender-per-hour',
      ],
    ] as const) {
      const bad = await textTriggers(['create', ...argv]);
      expect(bad.out.exitCode, argv.join(' ')).toBe(2);
      expect(bad.out.stderr).toContain(message);
      expect(bad.calls).toEqual([]);
    }
  });

  test('--run-as=project names the project, at create and take-over', async () => {
    const made = await textTriggers([
      'create',
      '--agent=acme.support',
      `--connection=${FRONT_DESK_ID}`,
      '--run-as=project',
    ]);
    expect(made.out.exitCode, made.out.stderr).toBe(0);
    expect(made.calls).toEqual([
      [
        'register',
        {
          agentId: 'acme.support',
          config: { connectionId: FRONT_DESK_ID },
          runAsProject: true,
        },
      ],
    ]);
    const take = await textTriggers(['take-ownership', ID, '--run-as=project']);
    expect(take.calls).toEqual([['takeOwnership', ID, { runAsProject: true }]]);
  });

  test('update sends only what is given', async () => {
    const pace = await textTriggers(['update', ID, '--per-sender-per-hour=3', '--label=slower']);
    expect(pace.out.exitCode, pace.out.stderr).toBe(0);
    expect(pace.calls).toEqual([
      ['update', ID, { config: { perSenderPerHour: 3 }, label: 'slower' }],
    ]);

    const retargeted = await textTriggers([
      'update',
      ID,
      '--agent=acme.support',
      '--agent-version=2.0.0',
    ]);
    expect(retargeted.calls).toEqual([
      ['update', ID, { agentId: 'acme.support', agentVersion: '2.0.0' }],
    ]);

    // An id passes as it is: no lookup.
    const moved = await textTriggers([
      'update',
      ID,
      `--connection=${SALES_ID}`,
      '--runs-per-hour=600',
    ]);
    expect(moved.out.exitCode, moved.out.stderr).toBe(0);
    expect(moved.calls).toEqual([
      ['update', ID, { config: { connectionId: SALES_ID, runsPerHour: 600 } }],
    ]);
  });

  test('update --clear-label takes the label off; an empty --label names it, and a label is saved trimmed', async () => {
    const cleared = await textTriggers(['update', ID, '--clear-label']);
    expect(cleared.out.exitCode, cleared.out.stderr).toBe(0);
    expect(cleared.calls).toEqual([['update', ID, { label: null }]]);
    for (const empty of ['--label=', '--label= ']) {
      const run = await textTriggers(['update', ID, empty]);
      expect(run.out.exitCode).toBe(2);
      expect(run.out.stderr).toContain('--label takes a value: --clear-label clears it');
      expect(run.calls).toEqual([]);
    }
    const both = await textTriggers(['update', ID, '--label=x', '--clear-label']);
    expect(both.out.exitCode).toBe(2);
    expect(both.out.stderr).toContain('Give --label or --clear-label, not both');
    expect(both.calls).toEqual([]);
    const trimmed = await textTriggers(['update', ID, '--label= x ']);
    expect(trimmed.calls).toEqual([['update', ID, { label: 'x' }]]);
  });

  test('--allow-unattended: repeatable on create and update; `none` clears on update only', async () => {
    const made = await textTriggers([
      'create',
      '--agent=acme.support',
      `--connection=${FRONT_DESK_ID}`,
      '--allow-unattended=acme.lookup',
      '--allow-unattended=acme.note',
    ]);
    expect(made.out.exitCode, made.out.stderr).toBe(0);
    expect(made.calls[0]).toMatchObject([
      'register',
      { toolsAllowedUnattended: ['acme.lookup', 'acme.note'] },
    ]);
    const cleared = await textTriggers(['update', ID, '--allow-unattended=none']);
    expect(cleared.calls).toEqual([['update', ID, { toolsAllowedUnattended: [] }]]);

    const noneAtCreate = await textTriggers([
      'create',
      '--agent=acme.support',
      `--connection=${FRONT_DESK_ID}`,
      '--allow-unattended=none',
    ]);
    expect(noneAtCreate.out.exitCode).not.toBe(0);
    expect(noneAtCreate.calls).toEqual([]);
  });

  test('get, pause, resume, unregister and take-ownership pass the id', async () => {
    for (const [verb, method] of [
      ['get', 'get'],
      ['pause', 'pause'],
      ['resume', 'resume'],
      ['unregister', 'unregister'],
      ['take-ownership', 'takeOwnership'],
    ] as const) {
      const run = await textTriggers([verb, ID]);
      expect(run.out.exitCode, `${verb}: ${run.out.stderr}`).toBe(0);
      expect(run.calls).toEqual([[method, ID]]);
    }
    const take = await textTriggers(['take-ownership', ID, `--run-as=${BOT}`]);
    expect(take.calls).toEqual([['takeOwnership', ID, { runAsServiceAccountId: BOT }]]);
  });

  test('take-ownership names the tools the trigger keeps allowed unattended, when it lists any', async () => {
    const listed = await textTriggers(['take-ownership', ID], {
      ...TRIGGER,
      toolsAllowedUnattended: ['acme.lookup'],
    });
    expect(listed.out.exitCode, listed.out.stderr).toBe(0);
    expect(JSON.parse(listed.out.stdout)).toMatchObject({
      toolsAllowedUnattended: ['acme.lookup'],
    });
    expect(listed.out.stderr).toContain('It keeps its tools allowed unattended (acme.lookup)');
    expect(listed.out.stderr).toContain(
      `kindgi text-triggers update ${ID} --allow-unattended=none`,
    );
    const none = await textTriggers(['take-ownership', ID]);
    expect(none.out.stderr).not.toContain('allowed unattended');
  });

  test('list filters, and the table: what it runs, its connection, limits, status, and whom it runs as', async () => {
    const { out, calls } = await textTriggers(
      ['list', '--project=p-1', '--status=active', '--limit=10', '--table'],
      TRIGGER,
      lookups,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { limit: 10, status: 'active', projectId: 'p-1' }],
      ['candidates', { projectId: 'p-1', app: 'texts' }],
    ]);
    expect(out.stdout).toMatch(/^ID\s+VERSION\s+RUNS\s+CONNECTION\s+PER HOUR\s+STATUS\s+RUNS AS/);
    expect(out.stdout).toMatch(/agent acme\.support\s+front-desk\s+60, 10 a sender\s+active/);
    expect(out.stdout).toContain('Ada Lovelace (personal)');
    const bad = await textTriggers(['list', '--status=stopped']);
    expect(bad.out.exitCode).not.toBe(0);
    expect(bad.calls).toEqual([]);
  });

  test("list --table: a connection it can't name shows its id; JSON reads no connections", async () => {
    const unread = await textTriggers(['list', '--table'], TRIGGER, (record) => ({
      connectionChoices: {
        candidates: async () => {
          throw new Error('not allowed');
        },
      },
      textTriggers: { list: record('list', { data: [TRIGGER], hasMore: false }) },
    }));
    expect(unread.out.exitCode, unread.out.stderr).toBe(0);
    expect(unread.out.stdout).toMatch(new RegExp(`agent acme\\.support\\s+${FRONT_DESK_ID}\\s`));

    // One lookup per project.
    const page = {
      data: [TRIGGER, { ...TRIGGER, triggerId: BOT, connectionId: SALES_ID }],
      hasMore: false,
    };
    const listed = await textTriggers(['list', '--table'], TRIGGER, (record) => ({
      ...lookups(record),
      textTriggers: { list: record('list', page) },
    }));
    expect(listed.calls).toEqual([
      ['list', {}],
      ['candidates', { projectId: 'p-1', app: 'texts' }],
    ]);
    expect(listed.out.stdout).toMatch(/\s+sales\s+60, 10 a sender/);

    const json = await textTriggers(['list'], TRIGGER, lookups);
    expect(json.calls).toEqual([['list', {}]]);
  });

  test('fires as a table: when, outcome, run, and why a text was refused', async () => {
    const { out, calls } = await textTriggers(['fires', ID, '--limit=5', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['fires', ID, { limit: 5 }]]);
    expect(out.stdout).toMatch(/refused\s+over-limit:/);
  });

  test("help: create gives the limits' defaults and says it takes admin; update's help gives no defaults", async () => {
    const create = (await textTriggers(['create', '--help'])).out;
    expect(create.exitCode, create.stderr).toBe(0);
    expect(create.stdout).toContain('1 to 600 (default 60)');
    expect(create.stdout).toContain('1 to 60 (default 10)');
    expect(create.stdout).toContain('it takes `admin` on the project');
    expect(create.stdout).toContain('Never `texts.send`');
    const update = (await textTriggers(['update', '--help'])).out;
    expect(update.exitCode, update.stderr).toBe(0);
    expect(update.stdout).toContain("A flag left out keeps the trigger's value");
    expect(update.stdout).not.toContain('default');
  });

  test("versions: a text trigger's versions, paged; the table names who made each, or Kindgi", async () => {
    const { out, calls } = await textTriggers(['versions', ID, '--limit=2', '--cursor=c-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['versions', ID, { limit: 2, cursor: 'c-1' }]]);
    expect(JSON.parse(out.stdout)).toEqual(VERSIONS);
    const table = await textTriggers(['versions', ID, '--table']);
    expect(table.out.exitCode, table.out.stderr).toBe(0);
    expect(table.out.stdout).toMatch(/^VERSION\s+CREATED\s+BY\s+CAUSE/);
    expect(table.out.stdout).toMatch(
      new RegExp(`2\\s+2026-10-27T00:00:00\\.000Z\\s+${BOT}\\s+owner`),
    );
    expect(table.out.stdout).toMatch(/1\s+2026-10-26T01:00:00\.000Z\s+Kindgi\s+unversioned-edit/);
    expect(table.out.stderr).toContain('c-2');
  });

  test('get <trigger-id> <version> reads that version', async () => {
    const { out, calls } = await textTriggers(['get', ID, '2']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['getVersion', ID, 2]]);
    expect(JSON.parse(out.stdout)).toEqual(VERSIONS.data[0]);
    expect((await textTriggers(['get', ID])).calls).toEqual([['get', ID]]);
  });

  test('get: a <version> that is not a whole number from 1 is refused before any call', async () => {
    for (const bad of ['0', '01', '1.0.0', 'abc']) {
      const { out, calls } = await textTriggers(['get', ID, bad]);
      expect(out.exitCode, bad).not.toBe(0);
      expect(out.stderr).toContain(`<version> must be a whole number from 1, got "${bad}"`);
      expect(calls).toEqual([]);
    }
  });

  test("list --table: the VERSION column is the trigger's current version, empty before its first", async () => {
    const versioned = await textTriggers(['list', '--table'], TRIGGER, (record) => ({
      ...lookups(record),
      textTriggers: {
        list: record('list', { data: [{ ...TRIGGER, version: 3 }], hasMore: false }),
      },
    }));
    expect(versioned.out.exitCode, versioned.out.stderr).toBe(0);
    expect(versioned.out.stdout).toMatch(new RegExp(`${ID}\\s+3\\s+agent acme\\.support`));
    const before = await textTriggers(['list', '--table'], TRIGGER, lookups);
    expect(before.out.stdout).toMatch(new RegExp(`${ID}\\s+agent acme\\.support`));
  });

  test('help lists every subcommand', async () => {
    const { out } = await textTriggers(['--help']);
    for (const verb of ['create', 'update', 'pause', 'resume', 'fires', 'versions', 'unregister']) {
      expect(out.stdout).toMatch(new RegExp(`^ {2}${verb} `, 'm'));
    }
  });
});

describe('kindgi text-triggers --connection', () => {
  test("create: a name is one of the project's company connections of app `texts`", async () => {
    const named = await textTriggers(
      ['create', '--agent=acme.support', '--project=p-1', '--connection=Front-Desk'],
      TRIGGER,
      lookups,
    );
    expect(named.out.exitCode, named.out.stderr).toBe(0);
    expect(named.calls).toEqual([
      ['candidates', { projectId: 'p-1', app: 'texts' }],
      [
        'register',
        { agentId: 'acme.support', config: { connectionId: FRONT_DESK_ID }, projectId: 'p-1' },
      ],
    ]);

    // Left out, the project is the tenant's Default project, as the server reads it.
    const byDefault = await textTriggers(
      ['create', '--agent=acme.support', '--connection=front-desk'],
      TRIGGER,
      lookups,
    );
    expect(byDefault.out.exitCode, byDefault.out.stderr).toBe(0);
    expect(byDefault.calls).toEqual([
      ['getDefault'],
      ['candidates', { projectId: 'p-default', app: 'texts' }],
      ['register', { agentId: 'acme.support', config: { connectionId: FRONT_DESK_ID } }],
    ]);
  });

  test("update: a name is looked up in the trigger's own project", async () => {
    const { out, calls } = await textTriggers(
      ['update', ID, '--connection=sales'],
      TRIGGER,
      lookups,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['get', ID],
      ['candidates', { projectId: 'p-1', app: 'texts' }],
      ['update', ID, { config: { connectionId: SALES_ID } }],
    ]);
  });

  test("a name the project's connections don't have, or have twice, is refused before the create", async () => {
    const none = await textTriggers(
      ['create', '--agent=acme.support', '--project=p-1', '--connection=billing'],
      TRIGGER,
      lookups,
    );
    expect(none.out.exitCode).toBe(2);
    expect(none.out.stderr).toContain(
      `No connection at texts is named "billing". This project's company connections: front-desk, sales.`,
    );
    expect(none.calls.map(([name]) => name)).toEqual(['candidates']);

    const twice = await textTriggers(
      ['create', '--agent=acme.support', '--project=p-1', '--connection=sales'],
      TRIGGER,
      (record) => ({
        connectionChoices: {
          candidates: record('candidates', {
            data: [...CANDIDATES, { ...CANDIDATES[0], connectionId: OTHER, name: 'sales' }],
            hasMore: false,
          }),
        },
      }),
    );
    expect(twice.out.exitCode).toBe(2);
    expect(twice.out.stderr).toContain('"sales" names 2 connections:');
    expect(twice.out.stderr).toContain('Pass the connection id instead.');
    expect(twice.calls.map(([name]) => name)).toEqual(['candidates']);
  });

  test('a connection-not-found names --connection', async () => {
    const gone = await textTriggers(
      ['create', '--agent=acme.support', `--connection=${FRONT_DESK_ID}`],
      TRIGGER,
      (record) => ({
        ...lookups(record),
        textTriggers: {
          register: async () => {
            throw new KindgiApiError(
              fromWire(
                {
                  code: 'connection-not-found',
                  message: 'No such company connection of app texts in the project',
                  details: { field: 'config.connectionId' },
                },
                404,
              ),
            );
          },
        },
      }),
    );
    expect(gone.out.exitCode).toBe(1);
    expect(gone.out.stderr).toBe(
      'Error [not-found]: --connection: No such company connection of app texts in the project\n',
    );
  });

  test('a connection another text trigger answers: create and update name that trigger', async () => {
    const hint = `Text trigger ${OTHER} answers it: \`kindgi text-triggers get ${OTHER}\` shows it, and unregistering it frees the connection.\n`;
    for (const [argv, method] of [
      [['create', '--agent=acme.support', `--connection=${FRONT_DESK_ID}`], 'register'],
      [['update', ID, `--connection=${FRONT_DESK_ID}`], 'update'],
    ] as const) {
      const run = await textTriggers(argv, TRIGGER, () => ({
        textTriggers: { [method]: connectionTaken },
      }));
      expect(run.out.exitCode, argv.join(' ')).toBe(1);
      expect(run.out.stderr).toContain(`already answers connection "${FRONT_DESK_ID}"`);
      expect(run.out.stderr).toContain(hint);
    }

    // Any other error adds nothing.
    const other = await textTriggers(['update', ID, '--label=Desk'], TRIGGER, () => ({
      textTriggers: {
        update: async () => {
          throw new KindgiApiError(
            fromWire({ code: 'trigger-not-found', message: 'No such trigger' }, 404),
          );
        },
      },
    }));
    expect(other.out.exitCode).toBe(1);
    expect(other.out.stderr).toContain('No such trigger');
    expect(other.out.stderr).not.toContain('answers it');
  });
});

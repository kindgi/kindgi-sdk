// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi mail-triggers`, through the client's `mailTriggers`. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const TRIGGER = {
  triggerId: ID,
  agentId: 'acme.support',
  projectId: 'p-1',
  owner: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', displayName: 'Ada Lovelace' },
  mailbox: { app: 'google', as: 'person' },
  pollSeconds: 60,
  runsPerHour: 60,
  label: 'support inbox',
  status: 'active',
  account: { id: 'acct-1', label: 'support@acme.example' },
  lastFiredAt: null,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};
const FIRE = {
  fireId: 'f-1',
  triggerId: ID,
  firedAt: '2026-10-26T01:00:00.000Z',
  outcome: 'pending',
  detail: 'thread-busy: an earlier mail of its thread runs first',
};
const VERSIONS = {
  data: [
    {
      triggerId: ID,
      version: 2,
      createdAt: '2026-10-27T00:00:00.000Z',
      createdBy: BOT,
      cause: 'owner',
      definition: { agentId: 'acme.support' },
    },
    {
      triggerId: ID,
      version: 1,
      createdAt: '2026-10-26T01:00:00.000Z',
      cause: 'unversioned-edit',
      definition: { agentId: 'acme.support' },
    },
  ],
  hasMore: true,
  nextCursor: 'c-2',
};

async function mailTriggers(
  argv: readonly string[],
  taken: Record<string, unknown> = TRIGGER,
  listed: readonly Record<string, unknown>[] = [TRIGGER],
) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['mail-triggers', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        mailTriggers: {
          list: record('list', { data: listed, hasMore: false }),
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
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi mail-triggers', () => {
  test('create: the mailbox is your own unless --as says the company', async () => {
    const { out, calls } = await mailTriggers([
      'create',
      '--agent=acme.support',
      '--mailbox=google',
      '--folder=Label_7',
      '--poll=120',
      '--runs-per-hour=30',
      '--label=support inbox',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'register',
        {
          agentId: 'acme.support',
          config: {
            mailbox: { app: 'google', as: 'person' },
            folder: 'Label_7',
            pollSeconds: 120,
            runsPerHour: 30,
          },
          label: 'support inbox',
        },
      ],
    ]);

    const company = await mailTriggers([
      'create',
      '--flow=acme.triage',
      '--flow-version=1.0.0',
      '--mailbox=microsoft',
      '--as=company',
      '--project=p-1',
      `--run-as=${BOT}`,
    ]);
    expect(company.out.exitCode, company.out.stderr).toBe(0);
    expect(company.calls).toEqual([
      [
        'register',
        {
          flowId: 'acme.triage',
          flowVersion: '1.0.0',
          config: { mailbox: { app: 'microsoft', as: 'company' } },
          projectId: 'p-1',
          runAsServiceAccountId: BOT,
        },
      ],
    ]);
  });

  test('create refuses before the call: no --mailbox, an unknown app or --as, --run-as on a person mailbox', async () => {
    for (const [argv, message] of [
      [['--agent=acme.support'], '--mailbox=google|microsoft is required'],
      [['--agent=acme.support', '--mailbox=yahoo'], '--mailbox must be `google`'],
      [['--agent=acme.support', '--mailbox=google', '--as=team'], '--as must be `person`'],
      [
        ['--agent=acme.support', '--mailbox=google', `--run-as=${BOT}`],
        '--run-as goes with --as=company',
      ],
      [
        ['--agent=acme.support', '--mailbox=google', '--as=person', `--run-as=${BOT}`],
        '--run-as goes with --as=company',
      ],
    ] as const) {
      const bad = await mailTriggers(['create', ...argv]);
      expect(bad.out.exitCode, argv.join(' ')).not.toBe(0);
      expect(bad.out.stderr).toContain(message);
      expect(bad.calls).toEqual([]);
    }
  });

  test('--run-as=project names the project on the company mailbox, at create and take-over; on a person mailbox it stops before the call', async () => {
    const company = await mailTriggers([
      'create',
      '--flow=acme.triage',
      '--flow-version=1.0.0',
      '--mailbox=microsoft',
      '--as=company',
      '--run-as=project',
    ]);
    expect(company.out.exitCode, company.out.stderr).toBe(0);
    expect(company.calls).toEqual([
      [
        'register',
        {
          flowId: 'acme.triage',
          flowVersion: '1.0.0',
          config: { mailbox: { app: 'microsoft', as: 'company' } },
          runAsProject: true,
        },
      ],
    ]);
    const take = await mailTriggers(['take-ownership', ID, '--run-as=project']);
    expect(take.calls).toEqual([['takeOwnership', ID, { runAsProject: true }]]);
    const person = await mailTriggers([
      'create',
      '--agent=acme.support',
      '--mailbox=google',
      '--run-as=project',
    ]);
    expect(person.out.exitCode).not.toBe(0);
    expect(person.out.stderr).toContain('--run-as goes with --as=company');
    expect(person.calls).toEqual([]);
  });

  test('update sends only what is given; --mailbox and --as go together', async () => {
    const pace = await mailTriggers(['update', ID, '--poll=300', '--label=slower']);
    expect(pace.out.exitCode, pace.out.stderr).toBe(0);
    expect(pace.calls).toEqual([['update', ID, { config: { pollSeconds: 300 }, label: 'slower' }]]);

    const moved = await mailTriggers([
      'update',
      ID,
      '--mailbox=google',
      '--as=company',
      '--agent=acme.support',
      '--agent-version=2.0.0',
    ]);
    expect(moved.calls).toEqual([
      [
        'update',
        ID,
        {
          agentId: 'acme.support',
          agentVersion: '2.0.0',
          config: { mailbox: { app: 'google', as: 'company' } },
        },
      ],
    ]);

    for (const half of ['--mailbox=google', '--as=company']) {
      const bad = await mailTriggers(['update', ID, half]);
      expect(bad.out.exitCode).not.toBe(0);
      expect(bad.out.stderr).toContain('--mailbox and --as go together on update');
      expect(bad.calls).toEqual([]);
    }
  });

  test('--allow-unattended: repeatable on create and update; `none` clears on update only', async () => {
    const made = await mailTriggers([
      'create',
      '--agent=acme.support',
      '--mailbox=google',
      '--allow-unattended=acme.reply',
      '--allow-unattended=acme.lookup',
    ]);
    expect(made.out.exitCode, made.out.stderr).toBe(0);
    expect(made.calls[0]).toMatchObject([
      'register',
      { toolsAllowedUnattended: ['acme.reply', 'acme.lookup'] },
    ]);
    const cleared = await mailTriggers(['update', ID, '--allow-unattended=none']);
    expect(cleared.calls).toEqual([['update', ID, { toolsAllowedUnattended: [] }]]);

    const noneAtCreate = await mailTriggers([
      'create',
      '--agent=acme.support',
      '--mailbox=google',
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
      const run = await mailTriggers([verb, ID]);
      expect(run.out.exitCode, `${verb}: ${run.out.stderr}`).toBe(0);
      expect(run.calls).toEqual([[method, ID]]);
    }
    const take = await mailTriggers(['take-ownership', ID, `--run-as=${BOT}`]);
    expect(take.calls).toEqual([['takeOwnership', ID, { runAsServiceAccountId: BOT }]]);
  });

  test('take-ownership names the tools the trigger keeps allowed unattended, when it lists any', async () => {
    const listed = await mailTriggers(['take-ownership', ID], {
      ...TRIGGER,
      toolsAllowedUnattended: ['acme.reply'],
    });
    expect(listed.out.exitCode, listed.out.stderr).toBe(0);
    expect(JSON.parse(listed.out.stdout)).toMatchObject({ toolsAllowedUnattended: ['acme.reply'] });
    expect(listed.out.stderr).toContain('It keeps its tools allowed unattended (acme.reply)');
    expect(listed.out.stderr).toContain(
      `kindgi mail-triggers update ${ID} --allow-unattended=none`,
    );
    const none = await mailTriggers(['take-ownership', ID]);
    expect(none.out.stderr).not.toContain('allowed unattended');
  });

  test('list filters, and the table: what it runs, the mailbox, its account, status, and whom it runs as', async () => {
    const { out, calls } = await mailTriggers([
      'list',
      '--project=p-1',
      '--status=active',
      '--limit=10',
      '--table',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { limit: 10, status: 'active', projectId: 'p-1' }]]);
    expect(out.stdout).toContain('agent acme.support');
    expect(out.stdout).toContain('google person');
    expect(out.stdout).toContain('support@acme.example');
    expect(out.stdout).toMatch(/RUNS AS/);
    expect(out.stdout).toContain('Ada Lovelace (personal)');
    const bad = await mailTriggers(['list', '--status=stopped']);
    expect(bad.out.exitCode).not.toBe(0);
    expect(bad.calls).toEqual([]);
  });

  test('fires as a table: when, outcome, run, and why a mail waits', async () => {
    const { out, calls } = await mailTriggers(['fires', ID, '--limit=5', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['fires', ID, { limit: 5 }]]);
    expect(out.stdout).toMatch(/pending\s+thread-busy:/);
  });

  test("help: create says --as defaults to person; update's help gives no defaults", async () => {
    const create = (await mailTriggers(['create', '--help'])).out;
    expect(create.exitCode, create.stderr).toBe(0);
    expect(create.stdout).toContain('through your connection (default)');
    expect(create.stdout).toContain('which takes `admin` on the project');
    const update = (await mailTriggers(['update', '--help'])).out;
    expect(update.exitCode, update.stderr).toBe(0);
    expect(update.stdout).toContain("A flag left out keeps the trigger's value");
    expect(update.stdout).not.toContain('default');
  });

  test("versions: a mail trigger's versions, paged; the table names who made each, or Kindgi", async () => {
    const { out, calls } = await mailTriggers(['versions', ID, '--limit=2', '--cursor=c-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['versions', ID, { limit: 2, cursor: 'c-1' }]]);
    expect(JSON.parse(out.stdout)).toEqual(VERSIONS);
    const table = await mailTriggers(['versions', ID, '--table']);
    expect(table.out.exitCode, table.out.stderr).toBe(0);
    expect(table.out.stdout).toMatch(/^VERSION\s+CREATED\s+BY\s+CAUSE/);
    expect(table.out.stdout).toMatch(
      new RegExp(`2\\s+2026-10-27T00:00:00\\.000Z\\s+${BOT}\\s+owner`),
    );
    expect(table.out.stdout).toMatch(/1\s+2026-10-26T01:00:00\.000Z\s+Kindgi\s+unversioned-edit/);
    expect(table.out.stderr).toContain('c-2');
  });

  test('get <trigger-id> <version> reads that version', async () => {
    const { out, calls } = await mailTriggers(['get', ID, '2']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['getVersion', ID, 2]]);
    expect(JSON.parse(out.stdout)).toEqual(VERSIONS.data[0]);
    expect((await mailTriggers(['get', ID])).calls).toEqual([['get', ID]]);
  });

  test('get: a <version> that is not a whole number from 1 is refused before any call', async () => {
    for (const bad of ['0', '01', '1.0.0', 'abc', '9007199254740993']) {
      const { out, calls } = await mailTriggers(['get', ID, bad]);
      expect(out.exitCode, bad).not.toBe(0);
      expect(out.stderr).toContain(`<version> must be a whole number from 1, got "${bad}"`);
      expect(calls).toEqual([]);
    }
  });

  test("list --table: the VERSION column is the trigger's current version, empty before its first", async () => {
    const versioned = await mailTriggers(['list', '--table'], TRIGGER, [
      { ...TRIGGER, version: 3 },
    ]);
    expect(versioned.out.exitCode, versioned.out.stderr).toBe(0);
    expect(versioned.out.stdout).toMatch(/^ID\s+VERSION\s+RUNS/);
    expect(versioned.out.stdout).toMatch(new RegExp(`${ID}\\s+3\\s+agent acme\\.support`));
    const before = await mailTriggers(['list', '--table']);
    expect(before.out.stdout).toMatch(new RegExp(`${ID}\\s+agent acme\\.support`));
  });

  test('help lists versions', async () => {
    const { out } = await mailTriggers(['--help']);
    expect(out.stdout).toMatch(/^ {2}versions /m);
  });
});

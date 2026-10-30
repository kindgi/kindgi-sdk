// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi schedules`, through the client's `schedules`. */

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
const SCHEDULE = {
  scheduleId: ID,
  triggerId: ID,
  agentId: 'acme.digest',
  cronExpression: '0 7 * * 1-5',
  timezone: 'America/Toronto',
  status: 'active',
  label: 'weekday digest',
  owner: { kind: 'user', id: '22222222-2222-4222-8222-222222222222', displayName: 'Ada Lovelace' },
  nextFireAt: '2026-10-08T11:00:00.000Z',
  lastFiredAt: null,
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};
const FIRE = {
  fireId: 'f-1',
  scheduleId: ID,
  triggerId: ID,
  scheduledFor: '2026-10-07T11:00:00.000Z',
  firedAt: '2026-10-07T11:00:01.000Z',
  outcome: 'started',
  runId: '22222222-2222-4222-8222-222222222222',
  missedCount: 9,
};
const VERSIONS = {
  data: [
    {
      scheduleId: ID,
      triggerId: ID,
      version: 2,
      createdAt: '2026-10-08T00:00:00.000Z',
      createdBy: '22222222-2222-4222-8222-222222222222',
      cause: 'edit',
      definition: { cronExpression: '0 8 * * 1-5' },
    },
    {
      scheduleId: ID,
      triggerId: ID,
      version: 1,
      createdAt: '2026-10-07T11:00:01.000Z',
      cause: 'first-fire',
      definition: { cronExpression: '0 7 * * 1-5' },
    },
  ],
  hasMore: true,
  nextCursor: 'c-2',
};

async function schedules(
  argv: readonly string[],
  taken: Record<string, unknown> = SCHEDULE,
  listed: readonly Record<string, unknown>[] = [SCHEDULE],
) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['schedules', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        schedules: {
          list: record('list', { data: listed, hasMore: false }),
          get: record('get', SCHEDULE),
          getVersion: record('getVersion', VERSIONS.data[0]),
          versions: record('versions', VERSIONS),
          register: record('register', SCHEDULE),
          update: record('update', SCHEDULE),
          pause: record('pause', SCHEDULE),
          resume: record('resume', SCHEDULE),
          unregister: record('unregister', { scheduleId: ID, unregistered: true }),
          fires: record('fires', { data: [FIRE], hasMore: false }),
          runNow: record('runNow', { ...FIRE, outcome: 'pending', manual: true }),
          takeOwnership: record('takeOwnership', taken),
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi schedules', () => {
  test('create an agent schedule with its policies', async () => {
    const { out, calls } = await schedules([
      'create',
      '--cron=0 7 * * 1-5',
      '--timezone=America/Toronto',
      '--agent=acme.digest',
      '--input={"userMessage":"Summarize the new tickets"}',
      '--catch-up=skip',
      '--overlap=allow',
      '--starting-deadline=120',
      '--label=weekday digest',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'register',
        {
          agentId: 'acme.digest',
          config: {
            cronExpression: '0 7 * * 1-5',
            timezone: 'America/Toronto',
            input: { userMessage: 'Summarize the new tickets' },
          },
          catchUp: 'skip',
          overlap: 'allow',
          startingDeadlineSeconds: 120,
          label: 'weekday digest',
        },
      ],
    ]);
  });

  test('create a flow schedule in a project; --cron is required', async () => {
    const { calls } = await schedules([
      'create',
      '--cron=@daily',
      '--flow=acme.nightly',
      '--flow-version=1.0.0',
      '--project=p-1',
    ]);
    expect(calls[0]?.[1]).toMatchObject({
      flowId: 'acme.nightly',
      flowVersion: '1.0.0',
      projectId: 'p-1',
      config: { cronExpression: '@daily' },
    });
    const missing = await schedules(['create', '--agent=acme.digest']);
    expect(missing.out.exitCode).not.toBe(0);
    expect(missing.out.stderr).toContain('--cron=<expression> is required');
  });

  test('create an improve schedule for a segment; its scope comes from --project and --segment', async () => {
    const { out, calls } = await schedules([
      'create',
      '--cron=0 * * * *',
      '--improve=acme.scorer',
      '--project=p-1',
      '--segment=company:acme',
      '--input={"threshold":{"corrections":10},"monthlyCapUsd":50}',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'register',
        {
          improve: {
            agentId: 'acme.scorer',
            scope: { kind: 'segment', projectId: 'p-1', path: [{ key: 'company', value: 'acme' }] },
          },
          config: {
            cronExpression: '0 * * * *',
            input: { threshold: { corrections: 10 }, monthlyCapUsd: 50 },
          },
          projectId: 'p-1',
        },
      ],
    ]);
    const project = await schedules([
      'create',
      '--cron=0 * * * *',
      '--improve=acme.scorer',
      '--project=p-1',
    ]);
    expect(project.calls[0]?.[1]).toMatchObject({
      improve: { agentId: 'acme.scorer', scope: { kind: 'project', projectId: 'p-1' } },
    });
    for (const [argv, message] of [
      [['--improve=acme.scorer'], '--improve needs its scope'],
      [
        ['--improve=acme.scorer', '--agent=acme.digest', '--project=p-1'],
        'not with --agent or --flow',
      ],
      [['--improve=acme.scorer', '--segment=company:acme'], '--improve needs its scope'],
    ] as const) {
      const bad = await schedules(['create', '--cron=0 * * * *', ...argv]);
      expect(bad.out.exitCode).not.toBe(0);
      expect(bad.out.stderr).toContain(message);
    }
  });

  test('an improve schedule in the table, and a fire that started a pass', async () => {
    const improving = {
      ...SCHEDULE,
      agentId: undefined,
      improve: { agentId: 'acme.scorer', scope: { kind: 'project', projectId: 'p-1' } },
    };
    const out = await runCli({
      argv: ['schedules', 'list', '--table', '--url=https://x', '--token=t'],
      env: {},
      cwd,
      home,
      clientFactory: () =>
        ({ schedules: { list: async () => ({ data: [improving], hasMore: false }) } }) as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toContain('improve acme.scorer (project p-1)');
    const improveRunId = '33333333-3333-4333-8333-333333333333';
    const fires = await runCli({
      argv: ['schedules', 'fires', ID, '--table', '--url=https://x', '--token=t'],
      env: {},
      cwd,
      home,
      clientFactory: () =>
        ({
          schedules: {
            fires: async () => ({
              data: [
                { ...FIRE, runId: undefined, missedCount: undefined, improveRunId },
                {
                  ...FIRE,
                  fireId: 'f-2',
                  runId: undefined,
                  missedCount: undefined,
                  outcome: 'skipped',
                  detail:
                    "Not enough new experts' corrections so far: 4 of 5 answers experts marked wrong (enough: 3 runs, 2 experts).",
                },
              ],
              hasMore: false,
            }),
          },
        }) as never,
    });
    expect(fires.exitCode, fires.stderr).toBe(0);
    expect(fires.stdout).toContain(`pass ${improveRunId}`);
    expect(fires.stdout).toMatch(
      /skipped\s+Not enough new experts' corrections so far: 4 of 5 answers experts marked wrong/,
    );
  });

  test('list as a table, with what each schedule runs', async () => {
    const { out, calls } = await schedules(['list', '--status=active', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { status: 'active' }]]);
    expect(out.stdout).toMatch(/agent acme\.digest\s+0 7 \* \* 1-5\s+America\/Toronto\s+active/);
  });

  test("list --project: one project's schedules; the table names whom each runs as, personal or shared", async () => {
    const { out, calls } = await schedules(['list', `--project=${ID}`, '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { projectId: ID }]]);
    expect(out.stdout).toMatch(/RUNS AS/);
    expect(out.stdout).toMatch(/Ada Lovelace \(personal\)/);
  });

  test('get with upcoming; update; the lifecycle verbs by id', async () => {
    const { calls } = await schedules(['get', ID, '--upcoming=3']);
    expect(calls).toEqual([['get', ID, { upcoming: 3 }]]);
    const updated = await schedules(['update', ID, '--cron=0 8 * * 1-5', '--overlap=skip']);
    expect(updated.calls).toEqual([
      ['update', ID, { config: { cronExpression: '0 8 * * 1-5' }, overlap: 'skip' }],
    ]);
    for (const [verb, method] of [
      ['pause', 'pause'],
      ['resume', 'resume'],
      ['run-now', 'runNow'],
      ['take-ownership', 'takeOwnership'],
      ['unregister', 'unregister'],
    ] as const) {
      const run = await schedules([verb, ID]);
      expect(run.out.exitCode, `${verb}: ${run.out.stderr}`).toBe(0);
      expect(run.calls).toEqual([[method, ID]]);
    }
  });

  test('--run-as names a service account on create and take-over', async () => {
    const BOT = '22222222-2222-4222-8222-222222222222';
    const made = await schedules([
      'create',
      '--cron=0 2 * * *',
      '--agent=acme.digest',
      `--run-as=${BOT}`,
    ]);
    expect(made.out.exitCode, made.out.stderr).toBe(0);
    expect(made.calls[0]).toMatchObject(['register', { runAsServiceAccountId: BOT }]);

    const take = await schedules(['take-ownership', ID, `--run-as=${BOT}`]);
    expect(take.calls).toEqual([['takeOwnership', ID, { runAsServiceAccountId: BOT }]]);
  });

  test("--run-as=project names the project's own account on create and take-over", async () => {
    const made = await schedules([
      'create',
      '--cron=0 2 * * *',
      '--agent=acme.digest',
      '--project=p-1',
      '--run-as=project',
    ]);
    expect(made.out.exitCode, made.out.stderr).toBe(0);
    expect(made.calls[0]).toMatchObject(['register', { runAsProject: true }]);
    expect(made.calls[0]?.[1]).not.toHaveProperty('runAsServiceAccountId');

    const take = await schedules(['take-ownership', ID, '--run-as=project']);
    expect(take.calls).toEqual([['takeOwnership', ID, { runAsProject: true }]]);
  });

  test('--allow-unattended: repeatable on create and update; `none` clears on update only', async () => {
    const made = await schedules([
      'create',
      '--cron=0 2 * * *',
      '--agent=acme.digest',
      '--allow-unattended=acme.send',
      '--allow-unattended=acme.archive',
    ]);
    expect(made.out.exitCode, made.out.stderr).toBe(0);
    expect(made.calls[0]).toMatchObject([
      'register',
      { toolsAllowedUnattended: ['acme.send', 'acme.archive'] },
    ]);
    const cleared = await schedules(['update', ID, '--allow-unattended=none']);
    expect(cleared.calls).toEqual([['update', ID, { toolsAllowedUnattended: [] }]]);
    const retargeted = await schedules([
      'update',
      ID,
      '--flow=acme.nightly',
      '--flow-version=1.0.0',
      '--allow-unattended=acme.refund',
    ]);
    expect(retargeted.calls).toEqual([
      [
        'update',
        ID,
        { flowId: 'acme.nightly', flowVersion: '1.0.0', toolsAllowedUnattended: ['acme.refund'] },
      ],
    ]);

    const noneAtCreate = await schedules([
      'create',
      '--cron=0 2 * * *',
      '--agent=acme.digest',
      '--allow-unattended=none',
    ]);
    expect(noneAtCreate.out.exitCode).not.toBe(0);
    expect(noneAtCreate.calls).toEqual([]);
    const noneWithIds = await schedules([
      'update',
      ID,
      '--allow-unattended=acme.send',
      '--allow-unattended=none',
    ]);
    expect(noneWithIds.out.exitCode).not.toBe(0);
    expect(noneWithIds.out.stderr).toContain('not with tool ids');
    expect(noneWithIds.calls).toEqual([]);
  });

  test('take-ownership names the tools the schedule keeps allowed unattended, when it lists any', async () => {
    const listed = await schedules(['take-ownership', ID], {
      ...SCHEDULE,
      toolsAllowedUnattended: ['acme.send'],
    });
    expect(listed.out.exitCode, listed.out.stderr).toBe(0);
    expect(JSON.parse(listed.out.stdout)).toMatchObject({ toolsAllowedUnattended: ['acme.send'] });
    expect(listed.out.stderr).toContain('It keeps its tools allowed unattended (acme.send)');
    expect(listed.out.stderr).toContain(
      "their calls in its runs still don't wait for a person's yes just because no person started them, now as the new owner.",
    );
    expect(listed.out.stderr).toContain(`kindgi schedules update ${ID} --allow-unattended=none`);
    const none = await schedules(['take-ownership', ID]);
    expect(none.out.stderr).not.toContain('allowed unattended');
  });

  test("update's help gives no defaults: a flag left out keeps the schedule's value", async () => {
    const update = (await schedules(['update', '--help'])).out;
    expect(update.exitCode, update.stderr).toBe(0);
    expect(update.stdout).toContain("A flag left out keeps the schedule's value.");
    expect(update.stdout).toContain('--timezone');
    expect(update.stdout).not.toContain('default');
    const create = (await schedules(['create', '--help'])).out;
    expect(create.stdout).toContain('(default UTC)');
    expect(create.stdout).toContain('(default 600)');
  });

  test('fires as a table: when, for which time, outcome, run, and the missed count', async () => {
    const { out, calls } = await schedules(['fires', ID, '--limit=10', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['fires', ID, { limit: 10 }]]);
    expect(out.stdout).toContain('stood in for 9 missed');
    expect(out.stdout).toMatch(/started\s+2{8}-/);
  });

  test("versions: a schedule's versions, paged; the table names who made each, or Kindgi", async () => {
    const { out, calls } = await schedules(['versions', ID, '--limit=2', '--cursor=c-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['versions', ID, { limit: 2, cursor: 'c-1' }]]);
    expect(JSON.parse(out.stdout)).toEqual(VERSIONS);
    const table = await schedules(['versions', ID, '--table']);
    expect(table.out.exitCode, table.out.stderr).toBe(0);
    expect(table.out.stdout).toMatch(/^VERSION\s+CREATED\s+BY\s+CAUSE/);
    expect(table.out.stdout).toMatch(/2\s+2026-10-08T00:00:00\.000Z\s+2{8}-\S+\s+edit/);
    expect(table.out.stdout).toMatch(/1\s+2026-10-07T11:00:01\.000Z\s+Kindgi\s+first-fire/);
    expect(table.out.stderr).toContain('c-2');
  });

  test('get <schedule-id> <version> reads that version; --upcoming is not with one', async () => {
    const { out, calls } = await schedules(['get', ID, '2']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['getVersion', ID, 2]]);
    expect(JSON.parse(out.stdout)).toEqual(VERSIONS.data[0]);
    expect((await schedules(['get', ID])).calls).toEqual([['get', ID, undefined]]);
    const both = await schedules(['get', ID, '2', '--upcoming=3']);
    expect(both.out.exitCode).not.toBe(0);
    expect(both.out.stderr).toContain('--upcoming');
    expect(both.calls).toEqual([]);
  });

  test('get: a <version> that is not a whole number from 1 is refused before any call', async () => {
    for (const bad of ['0', '01', '1.0.0', 'abc', '9007199254740993']) {
      const { out, calls } = await schedules(['get', ID, bad]);
      expect(out.exitCode, bad).not.toBe(0);
      expect(out.stderr).toContain(`<version> must be a whole number from 1, got "${bad}"`);
      expect(calls).toEqual([]);
    }
  });

  test("list --table: the VERSION column is the schedule's current version, empty before its first", async () => {
    const versioned = await schedules(['list', '--table'], SCHEDULE, [{ ...SCHEDULE, version: 3 }]);
    expect(versioned.out.exitCode, versioned.out.stderr).toBe(0);
    expect(versioned.out.stdout).toMatch(/^ID\s+VERSION\s+RUNS/);
    expect(versioned.out.stdout).toMatch(new RegExp(`${ID}\\s+3\\s+agent acme\\.digest`));
    const before = await schedules(['list', '--table']);
    expect(before.out.stdout).toMatch(new RegExp(`${ID}\\s+agent acme\\.digest`));
  });

  test('help lists versions', async () => {
    const { out } = await schedules(['--help']);
    expect(out.stdout).toMatch(/^ {2}versions /m);
  });
});

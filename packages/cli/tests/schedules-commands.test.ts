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

async function schedules(argv: readonly string[]) {
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
          list: record('list', { data: [SCHEDULE], hasMore: false }),
          get: record('get', SCHEDULE),
          register: record('register', SCHEDULE),
          update: record('update', SCHEDULE),
          pause: record('pause', SCHEDULE),
          resume: record('resume', SCHEDULE),
          unregister: record('unregister', { scheduleId: ID, unregistered: true }),
          fires: record('fires', { data: [FIRE], hasMore: false }),
          runNow: record('runNow', { ...FIRE, outcome: 'pending', manual: true }),
          takeOwnership: record('takeOwnership', SCHEDULE),
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
      '--input={"threshold":{"judgments":10},"monthlyCapUsd":50}',
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
            input: { threshold: { judgments: 10 }, monthlyCapUsd: 50 },
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
    const passId = '33333333-3333-4333-8333-333333333333';
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
                { ...FIRE, runId: undefined, missedCount: undefined, passId },
                {
                  ...FIRE,
                  fireId: 'f-2',
                  runId: undefined,
                  missedCount: undefined,
                  outcome: 'skipped',
                  detail: '4 of 5 trusted "no" judgments',
                },
              ],
              hasMore: false,
            }),
          },
        }) as never,
    });
    expect(fires.exitCode, fires.stderr).toBe(0);
    expect(fires.stdout).toContain(`pass ${passId}`);
    expect(fires.stdout).toMatch(/skipped\s+4 of 5 trusted "no" judgments/);
  });

  test('list as a table, with what each schedule runs', async () => {
    const { out, calls } = await schedules(['list', '--status=active', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { status: 'active' }]]);
    expect(out.stdout).toMatch(/agent acme\.digest\s+0 7 \* \* 1-5\s+America\/Toronto\s+active/);
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

  test('fires as a table: when, for which time, outcome, run, and the missed count', async () => {
    const { out, calls } = await schedules(['fires', ID, '--limit=10', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['fires', ID, { limit: 10 }]]);
    expect(out.stdout).toContain('stood in for 9 missed');
    expect(out.stdout).toMatch(/started\s+2{8}-/);
  });
});

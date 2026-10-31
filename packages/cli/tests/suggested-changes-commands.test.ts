// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi suggested-changes …`: suggested changes. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function run(argv: readonly string[], client: Record<string, unknown>) {
  return runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
  });
}

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string, result: unknown = SUGGESTED_CHANGE) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

const PROJECT = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
const SUGGESTED_CHANGE = {
  id: 'prop-1',
  agentId: 'acme.scorer',
  projectId: PROJECT,
  title: 'Recent filings matter more: acme.weights 1.0.0 → a new version',
  madeBy: { kind: 'person', userId: 'alice' },
  builtOn: { version: '1.4.0' },
  changes: [{ kind: 'block', blockId: 'acme.weights', from: '1.0.0' }],
  why: 'Recent filings matter more',
  fixes: [],
  check: { status: 'running', testSetId: 'acme.judged' },
  status: 'checking',
  createdAt: '2026-10-07T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
};

describe('kindgi suggested-changes create', () => {
  test('settings values from a file, for a project, with the corrections it fixes', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'values.json');
    await writeFile(file, JSON.stringify({ recency: 0.4, fit: 0.6 }));
    const out = await run(
      [
        'suggested-changes',
        'create',
        '--agent=acme.scorer',
        `--project=${PROJECT}`,
        '--block=acme.weights',
        `--values=@${file}`,
        '--why=Recent filings matter more',
        '--fixes=j-1',
        '--fixes=j-2',
        '--idempotency-key=k-1',
      ],
      { suggestedChanges: { create: rec('create') } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        {
          agentId: 'acme.scorer',
          projectId: PROJECT,
          block: 'acme.weights',
          values: { recency: 0.4, fit: 0.6 },
          why: 'Recent filings matter more',
          fixes: ['j-1', 'j-2'],
          idempotencyKey: 'k-1',
        },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toMatchObject({ id: 'prop-1', status: 'checking' });
  });

  test('a prompt template, inline or from a file (as text, not JSON)', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'prompt.txt');
    await writeFile(file, 'You score {{company}} filings.\n');
    for (const template of ['Score it.', `@${file}`]) {
      const out = await run(
        [
          'suggested-changes',
          'create',
          '--agent=acme.scorer',
          `--project=${PROJECT}`,
          '--block=acme.prompt',
          `--template=${template}`,
          '--why=Clearer',
        ],
        { suggestedChanges: { create: rec('create') } },
      );
      expect(out.exitCode, out.stderr).toBe(0);
    }
    expect(calls.map((c) => c[1])).toEqual([
      {
        agentId: 'acme.scorer',
        projectId: PROJECT,
        block: 'acme.prompt',
        template: 'Score it.',
        why: 'Clearer',
      },
      {
        agentId: 'acme.scorer',
        projectId: PROJECT,
        block: 'acme.prompt',
        template: 'You score {{company}} filings.\n',
        why: 'Clearer',
      },
    ]);
  });

  test.each([
    [[], '--agent is required'],
    [['--agent=a'], '--project is required'],
    [['--agent=a', `--project=${PROJECT}`], '--block is required'],
    [['--agent=a', `--project=${PROJECT}`, '--block=b'], '--why is required'],
    [['--agent=a', `--project=${PROJECT}`, '--block=b', '--why=h'], 'Give the new content'],
    [
      ['--agent=a', `--project=${PROJECT}`, '--block=b', '--why=h', '--values={}', '--template=t'],
      'Give the new content',
    ],
    [
      ['--agent=a', `--project=${PROJECT}`, '--block=b', '--why=h', '--values=[1]'],
      '--values must be a JSON object',
    ],
  ])('refuses %j: %s', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run(['suggested-changes', 'create', ...flags], {
      suggestedChanges: { create: rec('create') },
    });
    expect(out.exitCode).toBe(2); // a usage error
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });
});

describe('kindgi suggested-changes check', () => {
  test("checks it again on the project's test cases", async () => {
    const { calls, rec } = recorder();
    const out = await run(['suggested-changes', 'check', 'prop-1', '--idempotency-key=c-1'], {
      suggestedChanges: { check: rec('check') },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['check', 'prop-1', { idempotencyKey: 'c-1' }]]);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'checking' });
  });

  test('--wait reads the suggested change until its check is no longer running', async () => {
    const done = {
      ...SUGGESTED_CHANGE,
      status: 'ready',
      check: {
        status: 'done',
        testSetId: 'acme.judged',
        testSetVersion: '3',
        now: { testRunId: 'run-now', passing: 23, of: 27 },
        with: { testRunId: 'run-with', passing: 25, of: 27 },
        newlyFailing: [],
      },
    };
    const reads = [SUGGESTED_CHANGE, done];
    const gets: string[] = [];
    const out = await run(['suggested-changes', 'check', 'prop-1', '--wait'], {
      suggestedChanges: {
        check: async () => SUGGESTED_CHANGE,
        get: async (id: string) => {
          gets.push(id);
          return reads.shift();
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(gets).toEqual(['prop-1', 'prop-1']);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'ready', check: { status: 'done' } });
  }, 10_000);

  test("the server's nothing-to-check refusal comes through with its fix", async () => {
    const out = await run(['suggested-changes', 'check', 'prop-1'], {
      suggestedChanges: {
        check: async () => {
          throw new KindgiApiError({
            code: 'conflict',
            reason: 'suggested-change-nothing-to-check',
            message:
              "The project's test set has no cases: correct a conversation of the agent in the project first.",
          } as never);
        },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Error [suggested-change-nothing-to-check]');
    expect(out.stderr).toContain('correct a conversation');
  });
});

describe('kindgi suggested-changes pin / add-as-latest / withdraw', () => {
  test('pin takes an optional reason', async () => {
    const { calls, rec } = recorder();
    const client = { suggestedChanges: { pin: rec('pin') } };
    await run(['suggested-changes', 'pin', 'prop-1'], client);
    await run(['suggested-changes', 'pin', 'prop-1', '--reason=Better on acme'], client);
    await run(
      ['suggested-changes', 'pin', 'prop-1', '--reason=Complaints', '--idempotency-key=r'],
      client,
    );
    expect(calls).toEqual([
      ['pin', 'prop-1', {}],
      ['pin', 'prop-1', { reason: 'Better on acme' }],
      ['pin', 'prop-1', { reason: 'Complaints', idempotencyKey: 'r' }],
    ]);
  });

  test('pin --stop-following-latest asks to take its project off Latest; refused without it, the CLI names the flag and add-as-latest', async () => {
    const { calls, rec } = recorder();
    const out = await run(['suggested-changes', 'pin', 'prop-1', '--stop-following-latest'], {
      suggestedChanges: { pin: rec('pin') },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['pin', 'prop-1', { stopFollowingLatest: true }]]);
    const message =
      'Project acme follows Latest, and this pin would take it off it: it would run the pinned version and no longer take each new Latest. Send `stopFollowingLatest: true` to pin anyway.';
    const refused = await run(['suggested-changes', 'pin', 'prop-1'], {
      suggestedChanges: {
        pin: async () => {
          throw new KindgiApiError(fromWire({ code: 'pin-stops-latest', message }, 409));
        },
      },
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toBe(
      `Error [pin-stops-latest]: ${message}\nRun it again with --stop-following-latest to pin anyway, or \`kindgi suggested-changes add-as-latest\` to add it as the Latest instead.\n`,
    );
  });

  test('add-as-latest takes an optional reason', async () => {
    const { calls, rec } = recorder();
    const client = { suggestedChanges: { addAsLatest: rec('addAsLatest') } };
    const out = await run(['suggested-changes', 'add-as-latest', 'prop-1'], client);
    expect(out.exitCode, out.stderr).toBe(0);
    await run(
      [
        'suggested-changes',
        'add-as-latest',
        'prop-1',
        '--reason=Fit first for acme',
        '--idempotency-key=a',
      ],
      client,
    );
    expect(calls).toEqual([
      ['addAsLatest', 'prop-1', {}],
      ['addAsLatest', 'prop-1', { reason: 'Fit first for acme', idempotencyKey: 'a' }],
    ]);
  });

  test('withdraw needs a reason', async () => {
    const { calls, rec } = recorder();
    const client = { suggestedChanges: { withdraw: rec('withdraw') } };
    const missing = await run(['suggested-changes', 'withdraw', 'prop-1'], client);
    expect(missing.exitCode).toBe(2); // a usage error
    expect(missing.stderr).toContain('--reason is required');
    await run(
      ['suggested-changes', 'withdraw', 'prop-1', '--reason=Superseded by a better idea'],
      client,
    );
    expect(calls).toEqual([['withdraw', 'prop-1', { reason: 'Superseded by a better idea' }]]);
  });
});

describe('kindgi suggested-changes list / get', () => {
  test('filters, and a table with the project, change, status and check', async () => {
    const { calls, rec } = recorder();
    const page = {
      data: [
        {
          ...SUGGESTED_CHANGE,
          status: 'ready',
          check: {
            status: 'done',
            testSetId: 'acme.judged',
            now: { testRunId: 'run-now', passing: 23, of: 27 },
            with: { testRunId: 'run-with', passing: 25, of: 27 },
            newlyFailing: [],
          },
        },
        {
          ...SUGGESTED_CHANGE,
          id: 'prop-2',
          status: 'ready',
          check: {
            status: 'done',
            testSetId: 'acme.judged',
            with: { testRunId: 'run-old', passing: 9, of: 12 },
          },
        },
        { ...SUGGESTED_CHANGE, id: 'prop-3' },
        {
          ...SUGGESTED_CHANGE,
          id: 'prop-4',
          madeBy: { kind: 'deploy', deploymentId: 'dep-7' },
          changes: [{ kind: 'code', deploymentId: 'dep-7' }],
        },
      ],
      hasMore: false,
    };
    const out = await run(
      [
        'suggested-changes',
        'list',
        '--agent=acme.scorer',
        `--project=${PROJECT}`,
        '--status=ready',
        '--limit=10',
        '--table',
      ],
      { suggestedChanges: { list: rec('list', page) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { agentId: 'acme.scorer', projectId: PROJECT, status: 'ready', limit: 10 }],
    ]);
    expect(out.stdout).toContain('acme.scorer@1.4.0');
    expect(out.stdout).toContain(PROJECT);
    expect(out.stdout).toContain('acme.weights@1.0.0');
    expect(out.stdout).toContain('code (deploy dep-7)');
    expect(out.stdout).toContain('25/27 (now 23/27)');
    expect(out.stdout).toContain('9/12');
    expect(out.stdout).toContain('running');
  });

  test('an unknown status is refused before any call', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--status=approved', '--status=evaluated']) {
      const out = await run(['suggested-changes', 'list', flag], {
        suggestedChanges: { list: rec('list') },
      });
      expect(out.exitCode).toBe(2); // a usage error
    }
    expect(calls).toEqual([]);
  });

  test('get reads one', async () => {
    const { calls, rec } = recorder();
    const out = await run(['suggested-changes', 'get', 'prop-1'], {
      suggestedChanges: { get: rec('get') },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['get', 'prop-1']]);
  });

  /** A stub client: the suggested change fixes `fixes`, read from `corrections`. */
  function fixing(fixes: readonly string[], read: string[]) {
    const correction = (id: string, status: string, supersededBy?: string) => ({
      id,
      status,
      ...(supersededBy !== undefined && { supersededBy }),
    });
    const corrections: Record<string, unknown> = {
      'c-1': correction('c-1', 'being-fixed', 'c-4'),
      'c-4': correction('c-4', 'open', 'c-5'),
      'c-5': correction('c-5', 'open'),
      'c-2': correction('c-2', 'being-fixed'),
      'c-3': correction('c-3', 'with-owner', 'c-6'),
      'c-9': correction('c-9', 'being-fixed', 'c-10'),
    };
    return {
      suggestedChanges: { get: async () => ({ ...SUGGESTED_CHANGE, fixes }) },
      corrections: {
        get: async (id: string) => {
          read.push(id);
          if (id === 'c-8' || id === 'c-10') {
            throw new KindgiApiError(
              fromWire({ code: 'unavailable', message: 'The runtime is restarting' }, 503),
            );
          }
          const found = corrections[id];
          if (found === undefined) {
            throw new KindgiApiError(
              fromWire({ code: 'not-found', message: `Correction ${id} not found` }, 404),
            );
          }
          return found;
        },
      },
    };
  }

  test('get names each correction it fixes that was replaced since, and the live one', async () => {
    const read: string[] = [];
    const fixes = ['c-1', 'c-2', 'c-3', 'c-7', 'c-8', 'c-9'];
    const out = await run(['suggested-changes', 'get', 'prop-1'], fixing(fixes, read));
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout).fixes).toEqual(fixes);
    expect(out.stderr).toBe(
      [
        'c-1 (in fixes) was replaced by c-5, now open.',
        'c-3 (in fixes) was replaced by c-6.',
        "c-8 (in fixes): couldn't check whether it was replaced: The runtime is restarting",
        "c-9 (in fixes): couldn't check whether it was replaced: The runtime is restarting",
        '',
      ].join('\n'),
    );
    expect(read.sort()).toEqual(
      ['c-1', 'c-10', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6', 'c-7', 'c-8', 'c-9'].sort(),
    );
  });

  test('get --quiet reads no corrections', async () => {
    const read: string[] = [];
    const out = await run(['suggested-changes', 'get', 'prop-1', '--quiet'], fixing(['c-1'], read));
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toBe('');
    expect(read).toEqual([]);
  });

  test('is wired: help lists the group', async () => {
    const out = await run(['suggested-changes', '--help'], {});
    expect(out.exitCode).toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain('add-as-latest');
  });
});

const IMPROVE_RUN = {
  id: 'run-1',
  agentId: 'acme.scorer',
  projectId: PROJECT,
  startsFrom: { version: '1.4.0', follows: 'pin' },
  setAside: { cases: 5, of: 27 },
  tiers: ['prompt', 'settings'],
  objective: 'passRate',
  groupWeights: 'experts-only',
  budget: { maxCostUsd: 5, maxCandidates: 30 },
  requestedBy: 'user:alice',
  status: 'running',
  tried: 0,
  costUsd: '0.00',
  takes: ['c-312', 'c-301'],
  createdAt: '2026-10-07T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
};

const CHECK = {
  ready: false,
  startsFrom: { version: '13', follows: 'pin' },
  items: [
    {
      key: 'wording',
      missing: true,
      fix: {
        where: 'repo',
        text: "Improve rewrites a prompt block's wording with a model. If the instructions are written in code, not in a prompt block, ask your coding agent to move them into one, then deploy. If no model is named to write it, give the run a provider and model, or name them in the version's model-settings block.",
      },
    },
    { key: 'settings', missing: false },
    { key: 'test-cases', missing: false, count: 9 },
    { key: 'permission', missing: false },
    { key: 'one-at-a-time', missing: false },
    { key: 'project', missing: false },
  ],
  estimate: {
    costUsd: '1.90',
    maxCostUsd: '3',
    basis: { replays: 22, proofReplays: 6, meanRunCostUsd: '0.086' },
  },
  month: { spentUsd: '12', capUsd: '50' },
};

/** `improve runs start` for the agent in the project, with `extra` flags. */
const startIn = (...extra: string[]) => [
  'improve',
  'runs',
  'start',
  '--agent=acme.scorer',
  `--project=${PROJECT}`,
  ...extra,
];

describe('kindgi improve runs start', () => {
  test('starts an Improve run in a project, with a budget', async () => {
    const { calls, rec } = recorder();
    const out = await run(startIn('--max-cost=2.5', '--max-candidates=12'), {
      improveRuns: { start: rec('start', IMPROVE_RUN) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'start',
        {
          agentId: 'acme.scorer',
          projectId: PROJECT,
          budget: { maxCostUsd: 2.5, maxCandidates: 12 },
        },
      ],
    ]);
  });

  test('--agent and --project are required, and the old scope and test set flags are gone', async () => {
    const { calls, rec } = recorder();
    const client = { improveRuns: { start: rec('start') } };
    const noProject = await run(['improve', 'runs', 'start', '--agent=acme.scorer'], client);
    expect(noProject.exitCode).toBe(2);
    expect(noProject.stderr).toContain('--project is required');
    const noAgent = await run(['improve', 'runs', 'start', `--project=${PROJECT}`], client);
    expect(noAgent.exitCode).toBe(2);
    expect(noAgent.stderr).toContain('--agent is required');
    for (const flag of [
      '--tenant',
      '--test-set=acme.judged',
      '--run-project=p-2',
      '--from-version=1.0.0',
      '--segment=company:acme',
    ]) {
      const out = await run(startIn(flag), client);
      expect(out.exitCode, flag).toBe(2); // an unknown flag
      expect(out.stderr, flag).toContain(`Unknown option '${flag.split('=')[0]}'`);
    }
    expect(calls).toEqual([]);
  });

  test('--check asks whether it is ready and what it would cost, and starts nothing', async () => {
    const { calls, rec } = recorder();
    const client = { improveRuns: { check: rec('check', CHECK), start: rec('start') } };
    const out = await run(startIn('--check', '--tier=prompt'), client);
    expect(out.exitCode).toBe(3); // not ready: the answer is no
    expect(JSON.parse(out.stdout)).toEqual(CHECK);
    const ready = await run(startIn('--check'), {
      improveRuns: { check: rec('check', { ...CHECK, ready: true }) },
    });
    expect(ready.exitCode, ready.stderr).toBe(0);
    expect(calls).toEqual([
      ['check', { agentId: 'acme.scorer', projectId: PROJECT, tiers: ['prompt'] }],
      ['check', { agentId: 'acme.scorer', projectId: PROJECT }],
    ]);
  });

  test('--check --table lists the items with their fixes, the estimate and the month', async () => {
    const out = await run(startIn('--check', '--table'), {
      improveRuns: { check: async () => CHECK },
    });
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toMatch(
      /wording\s+missing\s+Improve rewrites a prompt block's wording with a model\. .+ name them in the version's model-settings block\. \(in the agent's code, then a deploy\)/,
    );
    expect(out.stdout).toMatch(/test-cases \(9\)\s+ok/);
    expect(out.stdout).toContain('Ready: no');
    expect(out.stdout).toContain('Starts from: 13 (pinned in the project)');
    expect(out.stdout).toContain(
      "Estimate: $1.90, its search stops at $3.00 (22 replays, 6 of them the proof's)",
    );
    expect(out.stdout).toContain("This month: $12.00 of the Improve schedule's $50.00");
  });

  test('--check goes without --wait and --idempotency-key: it starts nothing', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--wait', '--idempotency-key=k']) {
      const out = await run(startIn('--check', flag), {
        improveRuns: { check: rec('check', CHECK) },
      });
      expect(out.exitCode, flag).toBe(2); // a usage error
      expect(out.stderr, flag).toContain('--check starts nothing');
    }
    expect(calls).toEqual([]);
  });

  test("a start that isn't ready is refused, listing each missing item with its fix", async () => {
    const out = await run(startIn(), {
      improveRuns: {
        start: async () => {
          throw new KindgiApiError({
            code: 'conflict',
            reason: 'improve-not-ready',
            message:
              "acme.scorer isn't ready for an Improve run in this project: wording, settings missing (`items` says how to fix each)",
            fields: {
              items: [
                {
                  key: 'wording',
                  missing: true,
                  fix: { where: 'repo', text: 'Move the instructions into a prompt block.' },
                },
                {
                  key: 'settings',
                  missing: true,
                  fix: { where: 'repo', text: 'Mark the settings Improve may tune.' },
                },
              ],
            },
          } as never);
        },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Error [improve-not-ready]');
    expect(out.stderr).toContain(
      "✗ wording: Move the instructions into a prompt block. (in the agent's code, then a deploy)",
    );
    expect(out.stderr).toContain(
      "✗ settings: Mark the settings Improve may tune. (in the agent's code, then a deploy)",
    );
  });

  test('--wait reads the Improve run until it is no longer running', async () => {
    const reads = [
      { ...IMPROVE_RUN, tried: 3 },
      {
        ...IMPROVE_RUN,
        status: 'completed',
        tried: 7,
        costUsd: '0.84',
        outcome: { kind: 'suggested', suggestedChangeId: 'prop-9' },
      },
    ];
    const gets: string[] = [];
    const out = await run(startIn('--wait'), {
      improveRuns: {
        start: async () => IMPROVE_RUN,
        get: async (id: string) => {
          gets.push(id);
          return reads.shift();
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(gets).toEqual(['run-1', 'run-1']);
    expect(JSON.parse(out.stdout)).toMatchObject({
      outcome: { kind: 'suggested', suggestedChangeId: 'prop-9' },
    });
  }, 10_000);

  test('a budget that is not a positive number is refused before any call', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--max-cost=0', '--max-cost=cheap', '--max-candidates=1.5']) {
      const out = await run(startIn(flag), { improveRuns: { start: rec('start') } });
      expect(out.exitCode, flag).toBe(2); // a usage error
    }
    expect(calls).toEqual([]);
  });

  test('passes the tiers and the drafting flags through', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      startIn(
        '--tier=prompt',
        '--tier=settings',
        '--group-weights=as-recorded',
        '--provider=openai',
        '--model=gpt-4o',
        '--drafts=4',
      ),
      { improveRuns: { start: rec('start', IMPROVE_RUN) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'start',
        {
          agentId: 'acme.scorer',
          projectId: PROJECT,
          tiers: ['prompt', 'settings'],
          groupWeights: 'as-recorded',
          model: { providerId: 'openai', model: 'gpt-4o' },
          candidates: 4,
        },
      ],
    ]);
  });

  test('with no --tier, the drafting flags go through: every ready tier is tried', async () => {
    const { calls, rec } = recorder();
    const out = await run(startIn('--drafts=2'), {
      improveRuns: { start: rec('start', IMPROVE_RUN) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['start', { agentId: 'acme.scorer', projectId: PROJECT, candidates: 2 }],
    ]);
  });

  test('--provider and --model must come together', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--provider=openai', '--model=gpt-4o']) {
      const out = await run(startIn(flag), { improveRuns: { start: rec('start') } });
      expect(out.exitCode, flag).toBe(2); // a usage error
    }
    expect(calls).toEqual([]);
  });

  test('--tier only accepts prompt or settings, each once', async () => {
    const { calls, rec } = recorder();
    for (const flags of [['--tier=bogus'], ['--tier=prompt', '--tier=prompt']]) {
      const out = await run(startIn(...flags), { improveRuns: { start: rec('start') } });
      expect(out.exitCode, flags.join(' ')).toBe(2); // a usage error
    }
    expect(calls).toEqual([]);
  });

  test('--provider, --model and --drafts are for the prompt tier', async () => {
    const { calls, rec } = recorder();
    for (const extra of [['--provider=openai', '--model=gpt-4o'], ['--drafts=3']]) {
      const out = await run(startIn('--tier=settings', ...extra), {
        improveRuns: { start: rec('start') },
      });
      expect(out.exitCode, extra.join(' ')).toBe(2); // a usage error
      expect(out.stderr, extra.join(' ')).toContain(
        '--provider, --model and --drafts are for the prompt tier',
      );
    }
    expect(calls).toEqual([]);
  });
});

describe('kindgi improve runs', () => {
  test('list as a table: the version, project, candidates tried, cost, and what each found', async () => {
    const { calls, rec } = recorder();
    const page = {
      data: [
        {
          ...IMPROVE_RUN,
          status: 'completed',
          tried: 7,
          costUsd: '0.84',
          outcome: { kind: 'suggested', suggestedChangeId: 'prop-9' },
        },
        {
          ...IMPROVE_RUN,
          id: 'run-2',
          status: 'completed',
          outcome: { kind: 'nothing-better', reason: 'No change passed more cases.' },
        },
        {
          ...IMPROVE_RUN,
          id: 'run-3',
          status: 'completed',
          outcome: { kind: 'cost-cap', spentUsd: '3.02' },
        },
        { ...IMPROVE_RUN, id: 'run-4' },
        { ...IMPROVE_RUN, id: 'run-5', status: 'cancelled', cancelReason: 'project-suspended' },
      ],
      hasMore: false,
    };
    const out = await run(
      [
        'improve',
        'runs',
        'list',
        '--agent=acme.scorer',
        `--project=${PROJECT}`,
        '--status=completed',
        '--table',
      ],
      { improveRuns: { list: rec('list', page) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { agentId: 'acme.scorer', projectId: PROJECT, status: 'completed' }],
    ]);
    expect(out.stdout).toMatch(/TRIED/);
    expect(out.stdout).toContain(`acme.scorer@1.4.0  ${PROJECT}`);
    expect(out.stdout).toContain('suggested prop-9');
    expect(out.stdout).toContain('nothing better');
    expect(out.stdout).toContain('cost cap ($3.02)');
    expect(out.stdout).toContain('$0.84');
    expect(out.stdout).toContain('$0.00');
    expect(out.stdout).toContain('running');
    expect(out.stdout).toContain('project-suspended');
  });

  test('list --status takes only a status', async () => {
    const { calls, rec } = recorder();
    const out = await run(['improve', 'runs', 'list', '--status=done'], {
      improveRuns: { list: rec('list') },
    });
    expect(out.exitCode).toBe(2); // a usage error
    expect(calls).toEqual([]);
  });

  test('get and cancel name the Improve run', async () => {
    const { calls, rec } = recorder();
    const client = {
      improveRuns: { get: rec('get', IMPROVE_RUN), cancel: rec('cancel', IMPROVE_RUN) },
    };
    await run(['improve', 'runs', 'get', 'run-1'], client);
    await run(['improve', 'runs', 'cancel', 'run-1', '--idempotency-key=k'], client);
    expect(calls).toEqual([
      ['get', 'run-1'],
      ['cancel', 'run-1', { idempotencyKey: 'k' }],
    ]);
  });
});

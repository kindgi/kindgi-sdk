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
  fromVersion: '1.4.0',
  scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
  testSetId: 'acme.judged',
  tiers: ['settings'],
  objective: 'passRate',
  budget: { maxCostUsd: 5, maxCandidates: 30 },
  requestedBy: 'user:alice',
  status: 'running',
  candidatesEvaluated: 0,
  costUsd: '0.00',
  createdAt: '2026-10-07T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
};

describe('kindgi improve runs start', () => {
  test('starts an Improve run for a scope, with a budget', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'improve',
        'runs',
        'start',
        '--agent=acme.scorer',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--test-set=acme.judged',
        '--max-cost=2.5',
        '--max-candidates=12',
      ],
      { improveRuns: { start: rec('start', IMPROVE_RUN) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'start',
        {
          agentId: 'acme.scorer',
          scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
          testSetId: 'acme.judged',
          budget: { maxCostUsd: 2.5, maxCandidates: 12 },
        },
      ],
    ]);
  });

  test('--run-project: the project a tenant-scoped Improve run works in; left out, the API decides', async () => {
    const { calls, rec } = recorder();
    const improve = rec('start', IMPROVE_RUN);
    const named = await run(
      [
        'improve',
        'runs',
        'start',
        '--agent=acme.scorer',
        '--tenant',
        '--test-set=acme.prod-judged',
        `--run-project=${PROJECT}`,
      ],
      { improveRuns: { start: improve } },
    );
    expect(named.exitCode, named.stderr).toBe(0);
    const left = await run(
      ['improve', 'runs', 'start', '--agent=acme.scorer', '--tenant', '--test-set=acme.judged'],
      { improveRuns: { start: improve } },
    );
    expect(left.exitCode, left.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'start',
        {
          agentId: 'acme.scorer',
          scope: { kind: 'tenant' },
          testSetId: 'acme.prod-judged',
          projectId: PROJECT,
        },
      ],
      ['start', { agentId: 'acme.scorer', scope: { kind: 'tenant' }, testSetId: 'acme.judged' }],
    ]);
  });

  test('--wait reads the Improve run until it is no longer running', async () => {
    const reads = [
      { ...IMPROVE_RUN, candidatesEvaluated: 3 },
      {
        ...IMPROVE_RUN,
        status: 'completed',
        candidatesEvaluated: 7,
        costUsd: '0.84',
        outcome: { kind: 'suggested', suggestedChangeId: 'prop-9' },
      },
    ];
    const gets: string[] = [];
    const out = await run(
      ['improve', 'runs', 'start', '--agent=a', '--tenant', '--test-set=s', '--wait'],
      {
        improveRuns: {
          start: async () => IMPROVE_RUN,
          get: async (id: string) => {
            gets.push(id);
            return reads.shift();
          },
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(gets).toEqual(['run-1', 'run-1']);
    expect(JSON.parse(out.stdout)).toMatchObject({
      outcome: { kind: 'suggested', suggestedChangeId: 'prop-9' },
    });
  }, 10_000);

  test('a budget that is not a positive number is refused before any call', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--max-cost=0', '--max-cost=cheap', '--max-candidates=1.5']) {
      const out = await run(
        ['improve', 'runs', 'start', '--agent=a', '--tenant', '--test-set=s', flag],
        { improveRuns: { start: rec('start') } },
      );
      expect(out.exitCode, flag).toBe(2); // a usage error
    }
    expect(calls).toEqual([]);
  });

  test('passes the prompt Improve run tuning flags through', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'improve',
        'runs',
        'start',
        '--agent=acme.scorer',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--test-set=acme.judged',
        '--tier=prompt',
        '--group-weights=as-recorded',
        '--provider=openai',
        '--model=gpt-4o',
        '--drafts=4',
      ],
      { improveRuns: { start: rec('start', IMPROVE_RUN) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'start',
        {
          agentId: 'acme.scorer',
          scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
          testSetId: 'acme.judged',
          tiers: ['prompt'],
          groupWeights: 'as-recorded',
          model: { providerId: 'openai', model: 'gpt-4o' },
          candidates: 4,
        },
      ],
    ]);
  });

  test('--provider and --model must come together', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--provider=openai', '--model=gpt-4o']) {
      const out = await run(
        ['improve', 'runs', 'start', '--agent=a', '--tenant', '--test-set=s', flag],
        { improveRuns: { start: rec('start') } },
      );
      expect(out.exitCode, flag).toBe(2); // a usage error
    }
    expect(calls).toEqual([]);
  });

  test('--tier only accepts settings or prompt', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['improve', 'runs', 'start', '--agent=a', '--tenant', '--test-set=s', '--tier=bogus'],
      { improveRuns: { start: rec('start') } },
    );
    expect(out.exitCode).toBe(2); // a usage error
    expect(calls).toEqual([]);
  });

  test('--tier=prompt needs --provider and --model', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['improve', 'runs', 'start', '--agent=a', '--tenant', '--test-set=s', '--tier=prompt'],
      { improveRuns: { start: rec('start') } },
    );
    expect(out.exitCode).toBe(2); // a usage error
    expect(out.stderr).toContain('--tier=prompt needs --provider and --model.');
    expect(calls).toEqual([]);
  });

  test('--provider, --model and --drafts are for a prompt Improve run', async () => {
    const { calls, rec } = recorder();
    const settingsRun = ['improve', 'runs', 'start', '--agent=a', '--tenant', '--test-set=s'];
    for (const extra of [['--provider=openai', '--model=gpt-4o'], ['--drafts=3']]) {
      const out = await run([...settingsRun, ...extra], {
        improveRuns: { start: rec('start') },
      });
      expect(out.exitCode, extra.join(' ')).toBe(2); // a usage error
      expect(out.stderr, extra.join(' ')).toContain(
        '--provider, --model and --drafts are for --tier=prompt.',
      );
    }
    expect(calls).toEqual([]);
  });
});

describe('kindgi improve runs', () => {
  test('list as a table: candidates, cost, and what each found', async () => {
    const { calls, rec } = recorder();
    const page = {
      data: [
        {
          ...IMPROVE_RUN,
          status: 'completed',
          candidatesEvaluated: 7,
          costUsd: '0.84',
          outcome: { kind: 'suggested', suggestedChangeId: 'prop-9' },
        },
        {
          ...IMPROVE_RUN,
          id: 'run-2',
          status: 'completed',
          outcome: { kind: 'nothing-found', reason: 'no candidate beat the noise' },
        },
        { ...IMPROVE_RUN, id: 'run-3' },
        { ...IMPROVE_RUN, id: 'run-4', status: 'cancelled', cancelReason: 'project-suspended' },
      ],
      hasMore: false,
    };
    const out = await run(['improve', 'runs', 'list', '--agent=acme.scorer', '--table'], {
      improveRuns: { list: rec('list', page) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { agentId: 'acme.scorer' }]]);
    expect(out.stdout).toContain('suggested prop-9');
    expect(out.stdout).toContain('nothing better');
    expect(out.stdout).toContain('$0.84');
    expect(out.stdout).toContain('$0.00');
    expect(out.stdout).toContain('running');
    expect(out.stdout).toContain('project-suspended');
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

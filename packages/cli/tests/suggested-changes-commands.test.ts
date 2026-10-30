// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi suggested-changes …`: suggested changes (evals step 5). */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError } from '@kindgi/client';
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
  fromVersion: '1.4.0',
  scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
  tier: 'settings-block',
  change: {
    blockId: 'acme.weights',
    fromVersion: '1.0.0',
    content: { values: { recency: 0.4 } },
  },
  why: 'Recent filings matter more',
  madeBy: { kind: 'person', by: 'user:alice' },
  status: 'draft',
  createdAt: '2026-10-07T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
};

describe('kindgi suggested-changes draft', () => {
  test('settings values from a file, for a segment, with evidence', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'values.json');
    await writeFile(file, JSON.stringify({ recency: 0.4, fit: 0.6 }));
    const out = await run(
      [
        'suggested-changes',
        'draft',
        '--agent=acme.scorer',
        '--from-version=1.4.0',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--block=acme.weights',
        `--values=@${file}`,
        '--why=Recent filings matter more',
        '--correction=j-1',
        '--correction=j-2',
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
          fromVersion: '1.4.0',
          scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
          tier: 'settings-block',
          change: { blockId: 'acme.weights', content: { values: { recency: 0.4, fit: 0.6 } } },
          why: 'Recent filings matter more',
          evidence: { fixes: ['j-1', 'j-2'] },
          idempotencyKey: 'k-1',
        },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toMatchObject({ id: 'prop-1', status: 'draft' });
  });

  test('a prompt template, inline or from a file (as text, not JSON)', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'prompt.txt');
    await writeFile(file, 'You score {{company}} filings.\n');
    for (const template of ['Score it.', `@${file}`]) {
      const out = await run(
        [
          'suggested-changes',
          'draft',
          '--agent=acme.scorer',
          '--from-version=1.4.0',
          '--tenant',
          '--block=acme.prompt',
          `--template=${template}`,
          '--why=Clearer',
        ],
        { suggestedChanges: { create: rec('create') } },
      );
      expect(out.exitCode, out.stderr).toBe(0);
    }
    expect(calls.map((c) => (c[1] as { tier: string; change: unknown }).change)).toEqual([
      { blockId: 'acme.prompt', content: { template: 'Score it.' } },
      { blockId: 'acme.prompt', content: { template: 'You score {{company}} filings.\n' } },
    ]);
    expect(calls.every((c) => (c[1] as { tier: string }).tier === 'prompt-block')).toBe(true);
  });

  test.each([
    [[], '--agent is required'],
    [['--agent=a'], '--from-version is required'],
    [['--agent=a', '--from-version=1.0.0'], 'Name the scope'],
    [['--agent=a', '--from-version=1.0.0', '--tenant'], '--block is required'],
    [['--agent=a', '--from-version=1.0.0', '--tenant', '--block=b'], '--why is required'],
    [
      ['--agent=a', '--from-version=1.0.0', '--tenant', '--block=b', '--why=h'],
      'Give the new content',
    ],
    [
      [
        '--agent=a',
        '--from-version=1.0.0',
        '--tenant',
        '--block=b',
        '--why=h',
        '--values={}',
        '--template=t',
      ],
      'Give the new content',
    ],
    [
      ['--agent=a', '--from-version=1.0.0', '--tenant', '--block=b', '--why=h', '--values=[1]'],
      '--values must be a JSON object',
    ],
  ])('refuses %j: %s', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run(['suggested-changes', 'draft', ...flags], {
      suggestedChanges: { create: rec('create') },
    });
    expect(out.exitCode).toBe(2); // a usage error
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });
});

describe('kindgi suggested-changes evaluate', () => {
  test('sends the test set and the comparison options', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'suggested-changes',
        'evaluate',
        'prop-1',
        '--test-set=acme.judged',
        '--objective=weightedPrecisionAtK',
        '--k=5',
        '--reads=live',
        '--repetitions=3',
        '--group-weights=experts-only',
      ],
      {
        suggestedChanges: {
          evaluate: rec('evaluate', { ...SUGGESTED_CHANGE, status: 'evaluating' }),
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'evaluate',
        'prop-1',
        {
          testSetId: 'acme.judged',
          objective: 'weightedPrecisionAtK',
          reads: 'live',
          repetitions: 3,
          k: 5,
          groupWeights: 'experts-only',
        },
      ],
    ]);
  });

  test('--wait reads the suggested change until it is no longer evaluating', async () => {
    const reads = [
      { ...SUGGESTED_CHANGE, status: 'evaluating' },
      { ...SUGGESTED_CHANGE, status: 'evaluated', evaluation: { delta: 0.12 } },
    ];
    const gets: string[] = [];
    const out = await run(
      ['suggested-changes', 'evaluate', 'prop-1', '--test-set=acme.judged', '--wait'],
      {
        suggestedChanges: {
          evaluate: async () => ({ ...SUGGESTED_CHANGE, status: 'evaluating' }),
          get: async (id: string) => {
            gets.push(id);
            return reads.shift();
          },
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(gets).toEqual(['prop-1', 'prop-1']);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'evaluated' });
  }, 10_000);

  test('an unknown objective or group weighting is refused before any call', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--objective=accuracy', '--group-weights=all']) {
      const out = await run(['suggested-changes', 'evaluate', 'prop-1', '--test-set=s', flag], {
        suggestedChanges: { evaluate: rec('evaluate') },
      });
      expect(out.exitCode).toBe(2); // a usage error
      expect(out.stderr).toContain('must be one of');
    }
    expect(calls).toEqual([]);
  });

  test('--rescore rescores the latest evaluation, and --wait follows it', async () => {
    const { calls, rec } = recorder();
    const reads = [{ ...SUGGESTED_CHANGE, status: 'evaluated', evaluation: { delta: 0.2 } }];
    const out = await run(['suggested-changes', 'evaluate', 'prop-1', '--rescore', '--wait'], {
      suggestedChanges: {
        rescore: rec('rescore', { ...SUGGESTED_CHANGE, status: 'evaluating' }),
        evaluate: rec('evaluate'),
        get: async () => reads.shift(),
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['rescore', 'prop-1', {}]]);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'evaluated' });
  });

  test('--rescore takes no comparison flag: they come from the evaluation it rescores', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--test-set=acme.judged', '--repetitions=3', '--reads=live']) {
      const out = await run(['suggested-changes', 'evaluate', 'prop-1', '--rescore', flag], {
        suggestedChanges: { rescore: rec('rescore'), evaluate: rec('evaluate') },
      });
      expect(out.exitCode).toBe(2); // a usage error
      expect(out.stderr).toContain(`--rescore cannot be combined with ${flag.split('=')[0]}`);
    }
    expect(calls).toEqual([]);
  });

  test("the server's needs-a-tenant-pin refusal comes through with its fix", async () => {
    const out = await run(['suggested-changes', 'evaluate', 'prop-1', '--test-set=s'], {
      suggestedChanges: {
        evaluate: async () => {
          throw new KindgiApiError({
            code: 'conflict',
            reason: 'suggested-change-needs-pin',
            message:
              'acme.scorer has no live version for the whole tenant: promote one for {kind:"tenant"} first.',
          } as never);
        },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Error [suggested-change-needs-pin]');
    expect(out.stderr).toContain('promote one');
  });
});

describe('kindgi suggested-changes request / withdraw', () => {
  test('request takes an optional reason', async () => {
    const { calls, rec } = recorder();
    const client = { suggestedChanges: { pin: rec('pin') } };
    await run(['suggested-changes', 'request', 'prop-1'], client);
    await run(['suggested-changes', 'request', 'prop-1', '--reason=Better on acme'], client);
    await run(
      ['suggested-changes', 'request', 'prop-1', '--reason=Complaints', '--idempotency-key=r'],
      client,
    );
    expect(calls).toEqual([
      ['pin', 'prop-1', {}],
      ['pin', 'prop-1', { reason: 'Better on acme' }],
      ['pin', 'prop-1', { reason: 'Complaints', idempotencyKey: 'r' }],
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
  test('filters, and a table with the scope, block, status and delta', async () => {
    const { calls, rec } = recorder();
    const page = {
      data: [
        { ...SUGGESTED_CHANGE, status: 'evaluated', evaluation: { delta: 0.12 } },
        { ...SUGGESTED_CHANGE, id: 'prop-2', status: 'not-better', evaluation: { delta: -0.034 } },
        { ...SUGGESTED_CHANGE, id: 'prop-3' },
      ],
      hasMore: false,
    };
    const out = await run(
      [
        'suggested-changes',
        'list',
        '--agent=acme.scorer',
        '--tier=settings-block',
        '--status=evaluated',
        '--limit=10',
        '--table',
      ],
      { suggestedChanges: { list: rec('list', page) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { agentId: 'acme.scorer', tier: 'settings-block', status: 'evaluated', limit: 10 }],
    ]);
    expect(out.stdout).toContain('acme.scorer@1.4.0');
    expect(out.stdout).toContain(`project ${PROJECT} company=acme`);
    expect(out.stdout).toContain('acme.weights@1.0.0');
    expect(out.stdout).toContain('+0.120');
    expect(out.stdout).toContain('-0.034');
  });

  test('a scope keeps the suggested changes for exactly that scope', async () => {
    const { calls, rec } = recorder();
    const list = rec('list', { data: [], hasMore: false });
    await run(['suggested-changes', 'list', '--tenant'], { suggestedChanges: { list } });
    await run(['suggested-changes', 'list', `--project=${PROJECT}`, '--segment=company:acme'], {
      suggestedChanges: { list },
    });
    expect(calls).toEqual([
      ['list', { scope: { kind: 'tenant' } }],
      [
        'list',
        {
          scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
        },
      ],
    ]);
  });

  test('an unknown status or tier is refused before any call', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--status=approved', '--tier=prompt']) {
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

  test('is wired: help lists the group', async () => {
    const out = await run(['suggested-changes', '--help'], {});
    expect(out.exitCode).toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain('evaluate');
  });
});

const IMPROVE_RUN = {
  id: 'run-1',
  agentId: 'acme.scorer',
  fromVersion: '1.4.0',
  scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
  testSetId: 'acme.judged',
  tiers: ['settings'],
  objective: 'weightedYesShare',
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

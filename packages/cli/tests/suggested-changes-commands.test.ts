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

describe('kindgi suggested-changes draft', () => {
  test('settings values from a file, for a project, with the corrections it fixes', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'values.json');
    await writeFile(file, JSON.stringify({ recency: 0.4, fit: 0.6 }));
    const out = await run(
      [
        'suggested-changes',
        'draft',
        '--agent=acme.scorer',
        `--project=${PROJECT}`,
        '--block=acme.weights',
        `--values=@${file}`,
        '--hypothesis=Recent filings matter more',
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
          'draft',
          '--agent=acme.scorer',
          `--project=${PROJECT}`,
          '--block=acme.prompt',
          `--template=${template}`,
          '--hypothesis=Clearer',
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
    [['--agent=a', `--project=${PROJECT}`, '--block=b'], '--hypothesis is required'],
    [['--agent=a', `--project=${PROJECT}`, '--block=b', '--hypothesis=h'], 'Give the new content'],
    [
      [
        '--agent=a',
        `--project=${PROJECT}`,
        '--block=b',
        '--hypothesis=h',
        '--values={}',
        '--template=t',
      ],
      'Give the new content',
    ],
    [
      ['--agent=a', `--project=${PROJECT}`, '--block=b', '--hypothesis=h', '--values=[1]'],
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
  test("checks it again on the project's test cases", async () => {
    const { calls, rec } = recorder();
    const out = await run(['suggested-changes', 'evaluate', 'prop-1', '--idempotency-key=c-1'], {
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
    const out = await run(['suggested-changes', 'evaluate', 'prop-1', '--wait'], {
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
    const out = await run(['suggested-changes', 'evaluate', 'prop-1'], {
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
  test('filters, and a table with the project, block, status and check', async () => {
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

  test('is wired: help lists the group', async () => {
    const out = await run(['suggested-changes', '--help'], {});
    expect(out.exitCode).toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain('evaluate');
  });
});

const PASS = {
  id: 'pass-1',
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

describe('kindgi proposals improve', () => {
  test('starts a pass for a scope, with a budget', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'proposals',
        'improve',
        '--agent=acme.scorer',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--test-set=acme.judged',
        '--max-cost=2.5',
        '--max-candidates=12',
      ],
      { proposals: { improve: rec('improve', PASS) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'improve',
        {
          agentId: 'acme.scorer',
          scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
          testSetId: 'acme.judged',
          budget: { maxCostUsd: 2.5, maxCandidates: 12 },
        },
      ],
    ]);
  });

  test('--pass-project: the project a tenant-scoped pass works in; left out, the API decides', async () => {
    const { calls, rec } = recorder();
    const improve = rec('improve', PASS);
    const named = await run(
      [
        'proposals',
        'improve',
        '--agent=acme.scorer',
        '--tenant',
        '--test-set=acme.prod-judged',
        `--pass-project=${PROJECT}`,
      ],
      { proposals: { improve } },
    );
    expect(named.exitCode, named.stderr).toBe(0);
    const left = await run(
      ['proposals', 'improve', '--agent=acme.scorer', '--tenant', '--test-set=acme.judged'],
      { proposals: { improve } },
    );
    expect(left.exitCode, left.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'improve',
        {
          agentId: 'acme.scorer',
          scope: { kind: 'tenant' },
          testSetId: 'acme.prod-judged',
          projectId: PROJECT,
        },
      ],
      ['improve', { agentId: 'acme.scorer', scope: { kind: 'tenant' }, testSetId: 'acme.judged' }],
    ]);
  });

  test('--wait reads the pass until it is no longer running', async () => {
    const reads = [
      { ...PASS, candidatesEvaluated: 3 },
      {
        ...PASS,
        status: 'completed',
        candidatesEvaluated: 7,
        costUsd: '0.84',
        outcome: { kind: 'proposed', suggestedChangeId: 'prop-9' },
      },
    ];
    const gets: string[] = [];
    const out = await run(
      ['proposals', 'improve', '--agent=a', '--tenant', '--test-set=s', '--wait'],
      {
        proposals: { improve: async () => PASS },
        improvementPasses: {
          get: async (id: string) => {
            gets.push(id);
            return reads.shift();
          },
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(gets).toEqual(['pass-1', 'pass-1']);
    expect(JSON.parse(out.stdout)).toMatchObject({
      outcome: { kind: 'proposed', suggestedChangeId: 'prop-9' },
    });
  }, 10_000);

  test('a budget that is not a positive number is refused before any call', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--max-cost=0', '--max-cost=cheap', '--max-candidates=1.5']) {
      const out = await run(
        ['proposals', 'improve', '--agent=a', '--tenant', '--test-set=s', flag],
        { proposals: { improve: rec('improve') } },
      );
      expect(out.exitCode, flag).toBe(2); // a usage error
    }
    expect(calls).toEqual([]);
  });

  test('passes the prompt-pass tuning flags through', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'proposals',
        'improve',
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
      { proposals: { improve: rec('improve', PASS) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'improve',
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
        ['proposals', 'improve', '--agent=a', '--tenant', '--test-set=s', flag],
        { proposals: { improve: rec('improve') } },
      );
      expect(out.exitCode, flag).toBe(2); // a usage error
    }
    expect(calls).toEqual([]);
  });

  test('--tier only accepts settings or prompt', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['proposals', 'improve', '--agent=a', '--tenant', '--test-set=s', '--tier=bogus'],
      { proposals: { improve: rec('improve') } },
    );
    expect(out.exitCode).toBe(2); // a usage error
    expect(calls).toEqual([]);
  });

  test('--tier=prompt needs --provider and --model', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['proposals', 'improve', '--agent=a', '--tenant', '--test-set=s', '--tier=prompt'],
      { proposals: { improve: rec('improve') } },
    );
    expect(out.exitCode).toBe(2); // a usage error
    expect(out.stderr).toContain('--tier=prompt needs --provider and --model.');
    expect(calls).toEqual([]);
  });

  test('--provider, --model and --drafts are for a prompt pass', async () => {
    const { calls, rec } = recorder();
    const settingsPass = ['proposals', 'improve', '--agent=a', '--tenant', '--test-set=s'];
    for (const extra of [['--provider=openai', '--model=gpt-4o'], ['--drafts=3']]) {
      const out = await run([...settingsPass, ...extra], {
        proposals: { improve: rec('improve') },
      });
      expect(out.exitCode, extra.join(' ')).toBe(2); // a usage error
      expect(out.stderr, extra.join(' ')).toContain(
        '--provider, --model and --drafts are for --tier=prompt.',
      );
    }
    expect(calls).toEqual([]);
  });
});

describe('kindgi proposals passes', () => {
  test('list as a table: candidates, cost, and what each found', async () => {
    const { calls, rec } = recorder();
    const page = {
      data: [
        {
          ...PASS,
          status: 'completed',
          candidatesEvaluated: 7,
          costUsd: '0.84',
          outcome: { kind: 'proposed', suggestedChangeId: 'prop-9' },
        },
        {
          ...PASS,
          id: 'pass-2',
          status: 'completed',
          outcome: { kind: 'nothing-found', reason: 'no candidate beat the noise' },
        },
        { ...PASS, id: 'pass-3' },
        { ...PASS, id: 'pass-4', status: 'cancelled', cancelReason: 'project-suspended' },
      ],
      hasMore: false,
    };
    const out = await run(['proposals', 'passes', 'list', '--agent=acme.scorer', '--table'], {
      improvementPasses: { list: rec('list', page) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { agentId: 'acme.scorer' }]]);
    expect(out.stdout).toContain('proposed prop-9');
    expect(out.stdout).toContain('nothing better');
    expect(out.stdout).toContain('$0.84');
    expect(out.stdout).toContain('$0.00');
    expect(out.stdout).toContain('running');
    expect(out.stdout).toContain('project-suspended');
  });

  test('get and cancel name the pass', async () => {
    const { calls, rec } = recorder();
    const client = { improvementPasses: { get: rec('get', PASS), cancel: rec('cancel', PASS) } };
    await run(['proposals', 'passes', 'get', 'pass-1'], client);
    await run(['proposals', 'passes', 'cancel', 'pass-1', '--idempotency-key=k'], client);
    expect(calls).toEqual([
      ['get', 'pass-1'],
      ['cancel', 'pass-1', { idempotencyKey: 'k' }],
    ]);
  });
});

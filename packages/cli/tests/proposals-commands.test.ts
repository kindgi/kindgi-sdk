// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi proposals …`: improvement proposals (evals step 5). */

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
    (name: string, result: unknown = PROPOSAL) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

const PROJECT = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
const PROPOSAL = {
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
  hypothesis: 'Recent filings matter more',
  drafter: { kind: 'person', by: 'user:alice' },
  status: 'draft',
  createdAt: '2026-10-07T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
};

describe('kindgi proposals draft', () => {
  test('settings values from a file, for a segment, with evidence', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'values.json');
    await writeFile(file, JSON.stringify({ recency: 0.4, fit: 0.6 }));
    const out = await run(
      [
        'proposals',
        'draft',
        '--agent=acme.scorer',
        '--from-version=1.4.0',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--block=acme.weights',
        `--values=@${file}`,
        '--hypothesis=Recent filings matter more',
        '--judgment=j-1',
        '--judgment=j-2',
        '--idempotency-key=k-1',
      ],
      { proposals: { create: rec('create') } },
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
          hypothesis: 'Recent filings matter more',
          evidence: { judgmentIds: ['j-1', 'j-2'] },
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
          'proposals',
          'draft',
          '--agent=acme.scorer',
          '--from-version=1.4.0',
          '--tenant',
          '--block=acme.prompt',
          `--template=${template}`,
          '--hypothesis=Clearer',
        ],
        { proposals: { create: rec('create') } },
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
    [['--agent=a', '--from-version=1.0.0', '--tenant', '--block=b'], '--hypothesis is required'],
    [
      ['--agent=a', '--from-version=1.0.0', '--tenant', '--block=b', '--hypothesis=h'],
      'Give the new content',
    ],
    [
      [
        '--agent=a',
        '--from-version=1.0.0',
        '--tenant',
        '--block=b',
        '--hypothesis=h',
        '--values={}',
        '--template=t',
      ],
      'Give the new content',
    ],
    [
      [
        '--agent=a',
        '--from-version=1.0.0',
        '--tenant',
        '--block=b',
        '--hypothesis=h',
        '--values=[1]',
      ],
      '--values must be a JSON object',
    ],
  ])('refuses %j: %s', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run(['proposals', 'draft', ...flags], {
      proposals: { create: rec('create') },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });
});

describe('kindgi proposals evaluate', () => {
  test('sends the test set and the comparison options', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'proposals',
        'evaluate',
        'prop-1',
        '--test-set=acme.judged',
        '--objective=weightedPrecisionAtK',
        '--k=5',
        '--reads=live',
        '--repetitions=3',
        '--class-weights=restricted-only',
      ],
      { proposals: { evaluate: rec('evaluate', { ...PROPOSAL, status: 'evaluating' }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'evaluate',
        'prop-1',
        {
          suiteId: 'acme.judged',
          objective: 'weightedPrecisionAtK',
          reads: 'live',
          repetitions: 3,
          k: 5,
          classWeights: 'restricted-only',
        },
      ],
    ]);
  });

  test('--wait reads the proposal until it is no longer evaluating', async () => {
    const reads = [
      { ...PROPOSAL, status: 'evaluating' },
      { ...PROPOSAL, status: 'evaluated', evaluation: { delta: 0.12 } },
    ];
    const gets: string[] = [];
    const out = await run(['proposals', 'evaluate', 'prop-1', '--test-set=acme.judged', '--wait'], {
      proposals: {
        evaluate: async () => ({ ...PROPOSAL, status: 'evaluating' }),
        get: async (id: string) => {
          gets.push(id);
          return reads.shift();
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(gets).toEqual(['prop-1', 'prop-1']);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'evaluated' });
  }, 10_000);

  test('an unknown objective or class weighting is refused before any call', async () => {
    const { calls, rec } = recorder();
    for (const flag of ['--objective=accuracy', '--class-weights=all']) {
      const out = await run(['proposals', 'evaluate', 'prop-1', '--test-set=s', flag], {
        proposals: { evaluate: rec('evaluate') },
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('must be one of');
    }
    expect(calls).toEqual([]);
  });

  test("the server's needs-a-tenant-pin refusal comes through with its fix", async () => {
    const out = await run(['proposals', 'evaluate', 'prop-1', '--test-set=s'], {
      proposals: {
        evaluate: async () => {
          throw new KindgiApiError({
            code: 'conflict',
            reason: 'proposal-needs-pin',
            message:
              'acme.scorer has no live version for the whole tenant: promote one for {kind:"tenant"} first.',
          } as never);
        },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Error [proposal-needs-pin]');
    expect(out.stderr).toContain('promote one');
  });
});

describe('kindgi proposals request / rollback / withdraw', () => {
  test('request and rollback take an optional reason', async () => {
    const { calls, rec } = recorder();
    const client = { proposals: { request: rec('request'), rollback: rec('rollback') } };
    await run(['proposals', 'request', 'prop-1'], client);
    await run(['proposals', 'request', 'prop-1', '--reason=Better on acme'], client);
    await run(
      ['proposals', 'rollback', 'prop-1', '--reason=Complaints', '--idempotency-key=r'],
      client,
    );
    expect(calls).toEqual([
      ['request', 'prop-1', {}],
      ['request', 'prop-1', { reason: 'Better on acme' }],
      ['rollback', 'prop-1', { reason: 'Complaints', idempotencyKey: 'r' }],
    ]);
  });

  test('withdraw needs a reason', async () => {
    const { calls, rec } = recorder();
    const client = { proposals: { withdraw: rec('withdraw') } };
    const missing = await run(['proposals', 'withdraw', 'prop-1'], client);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('--reason is required');
    await run(['proposals', 'withdraw', 'prop-1', '--reason=Superseded by a better idea'], client);
    expect(calls).toEqual([['withdraw', 'prop-1', { reason: 'Superseded by a better idea' }]]);
  });
});

describe('kindgi proposals list / get', () => {
  test('filters, and a table with the scope, block, status and delta', async () => {
    const { calls, rec } = recorder();
    const page = {
      data: [
        { ...PROPOSAL, status: 'evaluated', evaluation: { delta: 0.12 } },
        { ...PROPOSAL, id: 'prop-2', status: 'not-better', evaluation: { delta: -0.034 } },
        { ...PROPOSAL, id: 'prop-3' },
      ],
      hasMore: false,
    };
    const out = await run(
      [
        'proposals',
        'list',
        '--agent=acme.scorer',
        '--tier=settings-block',
        '--status=evaluated',
        '--limit=10',
        '--table',
      ],
      { proposals: { list: rec('list', page) } },
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

  test('a scope keeps the proposals for exactly that scope', async () => {
    const { calls, rec } = recorder();
    const list = rec('list', { data: [], hasMore: false });
    await run(['proposals', 'list', '--tenant'], { proposals: { list } });
    await run(['proposals', 'list', `--project=${PROJECT}`, '--segment=company:acme'], {
      proposals: { list },
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
      const out = await run(['proposals', 'list', flag], { proposals: { list: rec('list') } });
      expect(out.exitCode).toBe(1);
    }
    expect(calls).toEqual([]);
  });

  test('get reads one', async () => {
    const { calls, rec } = recorder();
    const out = await run(['proposals', 'get', 'prop-1'], { proposals: { get: rec('get') } });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['get', 'prop-1']]);
  });

  test('is wired: help lists the group', async () => {
    const out = await run(['proposals', '--help'], {});
    expect(out.exitCode).toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain('evaluate');
  });
});

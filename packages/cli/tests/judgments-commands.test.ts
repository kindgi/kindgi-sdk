// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

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

/** Run the CLI against a stub client that records each call. */
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
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

describe('kindgi judgments', () => {
  test('add sends the item, verdict, class and participant', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'judgments',
        'add',
        '--run=r-1',
        '--item=c2',
        '--pointer=/matches/1',
        '--rank=1',
        '--yes',
        '--reason=right company',
        '--class=jc-1',
        '--participant=end-user-1',
      ],
      { judgments: { create: rec('create', { id: 'j-1' }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        {
          runId: 'r-1',
          item: { key: 'c2', pointer: '/matches/1', rank: 1 },
          verdict: 'yes',
          reason: 'right company',
          judgeClassId: 'jc-1',
          participantId: 'end-user-1',
        },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({ id: 'j-1' });
  });

  test('add without a class is unclassified', async () => {
    const { calls, rec } = recorder();
    const out = await run(['judgments', 'add', '--run=r-1', '--item=c1', '--no'], {
      judgments: { create: rec('create') },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['create', { runId: 'r-1', item: { key: 'c1' }, verdict: 'no' }]]);
  });

  test('add needs exactly one of --yes and --no, a run and an item', async () => {
    const client = { judgments: {} };
    const both = await run(['judgments', 'add', '--run=r', '--item=c', '--yes', '--no'], client);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain('exactly one of --yes or --no');
    const neither = await run(['judgments', 'add', '--run=r', '--item=c'], client);
    expect(neither.exitCode).toBe(1);
    const noRun = await run(['judgments', 'add', '--item=c', '--yes'], client);
    expect(noRun.stderr).toContain('--run');
    const noItem = await run(['judgments', 'add', '--run=r', '--yes'], client);
    expect(noItem.stderr).toContain('--item');
  });

  test('list passes the filters, a project as a scope', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'judgments',
        'list',
        '--run=r-1',
        '--agent=acme.matcher',
        '--agent-version=2.0.0',
        '--flow=acme.flow',
        '--verdict=no',
        '--class=jc-1',
        '--participant=u-1',
        '--project=p-1',
        '--limit=5',
        '--cursor=c1',
      ],
      { judgments: { list: rec('list', { data: [], hasMore: false }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'list',
        {
          runId: 'r-1',
          agentId: 'acme.matcher',
          agentVersion: '2.0.0',
          flowId: 'acme.flow',
          verdict: 'no',
          judgeClassId: 'jc-1',
          participantId: 'u-1',
          scope: { kind: 'project', projectId: 'p-1' },
          limit: 5,
          cursor: 'c1',
        },
      ],
    ]);
  });

  test('list refuses --version without --agent, and an unknown verdict', async () => {
    const client = { judgments: {} };
    expect((await run(['judgments', 'list', '--agent-version=1.0.0'], client)).stderr).toContain(
      '--agent-version needs --agent',
    );
    expect((await run(['judgments', 'list', '--verdict=maybe'], client)).stderr).toContain(
      '--verdict must be one of yes, no',
    );
  });

  test('show and remove', async () => {
    const { calls, rec } = recorder();
    const client = {
      judgments: { get: rec('get', { id: 'j-1' }), unregister: rec('unregister', undefined) },
    };
    expect((await run(['judgments', 'show', 'j-1'], client)).exitCode).toBe(0);
    const removed = await run(['judgments', 'remove', 'j-1'], client);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(calls).toEqual([
      ['get', 'j-1'],
      ['unregister', 'j-1'],
    ]);
    expect(JSON.parse(removed.stdout)).toEqual({ judgmentId: 'j-1', removed: true });
  });
});

describe('kindgi judge-classes', () => {
  test('list narrows by scope', async () => {
    const { calls, rec } = recorder();
    const client = { judgeClasses: { list: rec('list', { data: [], hasMore: false }) } };
    await run(['judge-classes', 'list'], client);
    await run(['judge-classes', 'list', '--tenant'], client);
    await run(['judge-classes', 'list', '--project=p-1'], client);
    await run(['judge-classes', 'list', '--agent=acme.matcher', '--project=p-1'], client);
    expect(calls).toEqual([
      ['list', {}],
      ['list', { scope: { kind: 'tenant' } }],
      ['list', { scope: { kind: 'project', projectId: 'p-1' } }],
      ['list', { scope: { kind: 'agent', projectId: 'p-1', agentId: 'acme.matcher' } }],
    ]);
  });

  test('--agent needs --project; --tenant stands alone', async () => {
    const client = { judgeClasses: {} };
    expect((await run(['judge-classes', 'list', '--agent=a'], client)).stderr).toContain(
      '--agent needs --project',
    );
    expect(
      (await run(['judge-classes', 'list', '--tenant', '--project=p'], client)).stderr,
    ).toContain('--tenant cannot be combined');
  });

  test('add creates a class in a scope', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'judge-classes',
        'add',
        '--name=expert',
        '--weight=3',
        '--tenant',
        '--description=Domain experts',
      ],
      { judgeClasses: { create: rec('create', { id: 'jc-1' }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        { scope: { kind: 'tenant' }, name: 'expert', weight: 3, description: 'Domain experts' },
      ],
    ]);
  });

  test('add needs a name, a weight of 0 or more, and a scope', async () => {
    const client = { judgeClasses: {} };
    expect(
      (await run(['judge-classes', 'add', '--weight=1', '--tenant'], client)).stderr,
    ).toContain('--name');
    expect((await run(['judge-classes', 'add', '--name=x', '--tenant'], client)).stderr).toContain(
      '--weight',
    );
    expect(
      (await run(['judge-classes', 'add', '--name=x', '--weight=-1', '--tenant'], client)).stderr,
    ).toContain('--weight must be a number');
    expect(
      (await run(['judge-classes', 'add', '--name=x', '--weight=1'], client)).stderr,
    ).toContain('Give a scope');
  });

  test('set changes weight and/or description; remove retires', async () => {
    const { calls, rec } = recorder();
    const client = {
      judgeClasses: {
        update: rec('update', { id: 'jc-1' }),
        unregister: rec('unregister', undefined),
      },
    };
    expect((await run(['judge-classes', 'set', 'jc-1', '--weight=0'], client)).exitCode).toBe(0);
    expect((await run(['judge-classes', 'set', 'jc-1'], client)).exitCode).toBe(1);
    const removed = await run(['judge-classes', 'remove', 'jc-1'], client);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(calls).toEqual([
      ['update', 'jc-1', { weight: 0 }],
      ['unregister', 'jc-1'],
    ]);
  });
});

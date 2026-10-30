// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CORRECTION_ITEM } from '@kindgi/types';

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

describe('kindgi corrections', () => {
  test('add sends the item, verdict, class and participant', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrections',
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
      { corrections: { create: rec('create', { id: 'j-1' }) } },
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

  test('add sends a correction on the fixed item, without --item', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrections',
        'add',
        '--run=r-1',
        '--no',
        '--correction={"calls":[{"tool":"acme.refund","args":{"amount":25}}],"notCalled":["acme.escalate"]}',
      ],
      { corrections: { create: rec('create', { id: 'j-2' }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        {
          runId: 'r-1',
          item: { key: CORRECTION_ITEM.key, pointer: CORRECTION_ITEM.pointer },
          verdict: 'no',
          correction: {
            calls: [{ tool: 'acme.refund', args: { amount: 25 } }],
            notCalled: ['acme.escalate'],
          },
        },
      ],
    ]);
  });

  test('add refuses --item, --pointer or --rank that fight the correction item', async () => {
    const client = { corrections: { create: recorder().rec('create') } };
    const corr = '--correction={"calls":[],"notCalled":["acme.escalate"]}';
    const wrongItem = await run(
      ['corrections', 'add', '--run=r-1', '--item=c1', '--no', corr],
      client,
    );
    expect(wrongItem.exitCode).toBe(2);
    expect(wrongItem.stderr).toContain(CORRECTION_ITEM.key);
    const wrongPointer = await run(
      ['corrections', 'add', '--run=r-1', '--pointer=/matches/0', '--no', corr],
      client,
    );
    expect(wrongPointer.exitCode).toBe(2);
    expect(wrongPointer.stderr).toContain('whole output');
    const wrongRank = await run(
      ['corrections', 'add', '--run=r-1', '--rank=1', '--no', corr],
      client,
    );
    expect(wrongRank.exitCode).toBe(2);
    expect(wrongRank.stderr).toContain('whole output');
  });

  test('add rejects a malformed --correction', async () => {
    const out = await run(['corrections', 'add', '--run=r-1', '--no', '--correction={bad'], {
      corrections: { create: recorder().rec('create') },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Malformed JSON input');
  });

  test('add without a class is unclassified', async () => {
    const { calls, rec } = recorder();
    const out = await run(['corrections', 'add', '--run=r-1', '--item=c1', '--no'], {
      corrections: { create: rec('create') },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['create', { runId: 'r-1', item: { key: 'c1' }, verdict: 'no' }]]);
  });

  test('add needs exactly one of --yes and --no, a run and an item', async () => {
    const client = { corrections: {} };
    const both = await run(['corrections', 'add', '--run=r', '--item=c', '--yes', '--no'], client);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain('exactly one of --yes or --no');
    const neither = await run(['corrections', 'add', '--run=r', '--item=c'], client);
    expect(neither.exitCode).toBe(2);
    const noRun = await run(['corrections', 'add', '--item=c', '--yes'], client);
    expect(noRun.stderr).toContain('--run');
    const noItem = await run(['corrections', 'add', '--run=r', '--yes'], client);
    expect(noItem.stderr).toContain('--item');
  });

  test('list passes the filters, a project as a scope', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrections',
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
      { corrections: { list: rec('list', { data: [], hasMore: false }) } },
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
    const client = { corrections: {} };
    expect((await run(['corrections', 'list', '--agent-version=1.0.0'], client)).stderr).toContain(
      '--agent-version needs --agent',
    );
    expect((await run(['corrections', 'list', '--verdict=maybe'], client)).stderr).toContain(
      '--verdict must be one of yes, no',
    );
  });

  test('show and remove', async () => {
    const { calls, rec } = recorder();
    const client = {
      corrections: { get: rec('get', { id: 'j-1' }), remove: rec('remove', undefined) },
    };
    expect((await run(['corrections', 'show', 'j-1'], client)).exitCode).toBe(0);
    const removed = await run(['corrections', 'remove', 'j-1'], client);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(calls).toEqual([
      ['get', 'j-1'],
      ['remove', 'j-1'],
    ]);
    expect(JSON.parse(removed.stdout)).toEqual({ correctionId: 'j-1', removed: true });
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

  test('add and set take who may assert a class; set --unrestricted lifts it', async () => {
    const { calls, rec } = recorder();
    const client = {
      judgeClasses: {
        create: rec('create', { id: 'jc-1' }),
        update: rec('update', { id: 'jc-1' }),
      },
    };
    const added = await run(
      [
        'judge-classes',
        'add',
        '--name=expert',
        '--weight=3',
        '--tenant',
        '--min-reviewer-role=senior',
        '--principal-kind=user',
        '--principal-id=user-1',
        '--principal-id=user-2',
      ],
      client,
    );
    expect(added.exitCode, added.stderr).toBe(0);
    await run(['judge-classes', 'set', 'jc-1', '--principal-kind=service'], client);
    await run(['judge-classes', 'set', 'jc-1', '--unrestricted'], client);
    expect(calls).toEqual([
      [
        'create',
        {
          scope: { kind: 'tenant' },
          name: 'expert',
          weight: 3,
          assertableBy: {
            minReviewerRole: 'senior',
            principalKinds: ['user'],
            principalIds: ['user-1', 'user-2'],
          },
        },
      ],
      ['update', 'jc-1', { assertableBy: { principalKinds: ['service'] } }],
      ['update', 'jc-1', { assertableBy: null }],
    ]);
  });

  test('a restriction flag must name a role or kind there is', async () => {
    const client = { judgeClasses: {} };
    const add = ['judge-classes', 'add', '--name=x', '--weight=1', '--tenant'];
    expect((await run([...add, '--min-reviewer-role=chief'], client)).stderr).toContain(
      '--min-reviewer-role must be one of standard, senior, admin',
    );
    expect((await run([...add, '--principal-kind=robot'], client)).stderr).toContain(
      '--principal-kind must be user or service',
    );
    expect(
      (await run(['judge-classes', 'set', 'jc-1', '--unrestricted', '--principal-id=u'], client))
        .stderr,
    ).toContain('--unrestricted cannot be combined');
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
    expect((await run(['judge-classes', 'set', 'jc-1'], client)).exitCode).toBe(2);
    const removed = await run(['judge-classes', 'remove', 'jc-1'], client);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(calls).toEqual([
      ['update', 'jc-1', { weight: 0 }],
      ['unregister', 'jc-1'],
    ]);
  });
});

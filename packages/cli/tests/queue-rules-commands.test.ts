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

describe('kindgi queue-rules', () => {
  test('create sends the name, the match, the sample, the cap and the group', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'queue-rules',
        'create',
        '--project=p-1',
        '--name=experts',
        '--agent=acme.matcher',
        '--agent=acme.refund',
        '--flow=acme.flow',
        '--agent-version=2.0.0',
        '--agent-version=pinned',
        '--status=completed',
        '--include-dry-runs',
        '--sample=0.5',
        '--max-open=20',
        '--group=jc-1',
        '--disabled',
      ],
      { projects: { queueRules: { create: rec('create', { ruleId: 'jr-1' }) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        'p-1',
        {
          name: 'experts',
          when: {
            agentIds: ['acme.matcher', 'acme.refund'],
            flowIds: ['acme.flow'],
            versions: ['2.0.0', 'pinned'],
            status: ['completed'],
            includeDryRuns: true,
          },
          sample: 0.5,
          maxOpen: 20,
          correctorGroupId: 'jc-1',
          enabled: false,
        },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({ ruleId: 'jr-1' });
  });

  test('create with no match flags sends an empty `when`', async () => {
    const { calls, rec } = recorder();
    const out = await run(['queue-rules', 'create', '--project=p-1', '--name=all'], {
      projects: { queueRules: { create: rec('create', { ruleId: 'jr-2' }) } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['create', 'p-1', { name: 'all', when: {} }]]);
  });

  test('create --disabled makes the rule disabled', async () => {
    const { calls, rec } = recorder();
    const out = await run(['queue-rules', 'create', '--project=p-1', '--name=off', '--disabled'], {
      projects: { queueRules: { create: rec('create', { ruleId: 'jr-off' }) } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['create', 'p-1', { name: 'off', when: {}, enabled: false }]]);
  });

  test('create also queues recent runs when asked, and returns both', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'queue-rules',
        'create',
        '--project=p-1',
        '--name=r',
        '--queue-last=100',
        '--queue-since=2026-10-01',
      ],
      {
        projects: {
          queueRules: {
            create: rec('create', { ruleId: 'jr-3' }),
            queueRecent: rec('queueRecent', { queued: 5, alreadyQueued: 1, alreadyReviewed: 2 }),
          },
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['create', 'p-1', { name: 'r', when: {} }],
      ['queueRecent', 'p-1', 'jr-3', { last: 100, since: '2026-10-01T00:00:00.000Z' }],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({
      rule: { ruleId: 'jr-3' },
      queued: { queued: 5, alreadyQueued: 1, alreadyReviewed: 2 },
    });
  });

  test('create needs a name and a valid sample and status', async () => {
    const client = { projects: { queueRules: {} } };
    expect((await run(['queue-rules', 'create', '--project=p-1'], client)).stderr).toContain(
      '--name',
    );
    expect(
      (await run(['queue-rules', 'create', '--project=p-1', '--name=x', '--sample=2'], client))
        .stderr,
    ).toContain('--sample must be a share');
    expect(
      (await run(['queue-rules', 'create', '--project=p-1', '--name=x', '--status=weird'], client))
        .stderr,
    ).toContain('--status takes only');
  });

  test('list, show, versions and results pass their arguments', async () => {
    const { calls, rec } = recorder();
    const client = {
      projects: {
        queueRules: {
          list: rec('list', { data: [], hasMore: false }),
          get: rec('get', { ruleId: 'jr-1' }),
          versions: rec('versions', { data: [], hasMore: false }),
          results: rec('results', { ruleId: 'jr-1', groups: [] }),
        },
      },
    };
    expect(
      (await run(['queue-rules', 'list', '--project=p-1', '--limit=5', '--cursor=c1'], client))
        .exitCode,
    ).toBe(0);
    expect((await run(['queue-rules', 'show', 'jr-1', '--project=p-1'], client)).exitCode).toBe(0);
    expect(
      (await run(['queue-rules', 'versions', 'jr-1', '--project=p-1', '--limit=3'], client))
        .exitCode,
    ).toBe(0);
    expect(
      (await run(['queue-rules', 'results', 'jr-1', '--project=p-1', '--since=2026-10-01'], client))
        .exitCode,
    ).toBe(0);
    expect(calls).toEqual([
      ['list', 'p-1', { limit: 5, cursor: 'c1' }],
      ['get', 'p-1', 'jr-1'],
      ['versions', 'p-1', 'jr-1', { limit: 3 }],
      ['results', 'p-1', 'jr-1', '2026-10-01T00:00:00.000Z'],
    ]);
  });

  test('preview sends the match flat, with the sample, last and an existing rule', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'queue-rules',
        'preview',
        '--project=p-1',
        '--agent=acme.x',
        '--sample=0.5',
        '--last=50',
        '--rule=jr-1',
      ],
      { projects: { queueRules: { preview: rec('preview', { considered: 50, matched: 10 }) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['preview', 'p-1', { agentIds: ['acme.x'], sample: 0.5, last: 50, ruleId: 'jr-1' }],
    ]);
  });

  test('queue-recent passes last and since, and needs at least one', async () => {
    const { calls, rec } = recorder();
    const client = {
      projects: {
        queueRules: {
          queueRecent: rec('queueRecent', { queued: 3, alreadyQueued: 0, alreadyReviewed: 1 }),
        },
      },
    };
    const out = await run(
      ['queue-rules', 'queue-recent', 'jr-1', '--project=p-1', '--last=100', '--since=2026-10-01'],
      client,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    const neither = await run(['queue-rules', 'queue-recent', 'jr-1', '--project=p-1'], client);
    expect(neither.exitCode).toBe(2);
    expect(neither.stderr).toContain('--last');
    expect(calls).toEqual([
      ['queueRecent', 'p-1', 'jr-1', { last: 100, since: '2026-10-01T00:00:00.000Z' }],
    ]);
  });

  test('update sends a patch, the match flags replacing `when` whole', async () => {
    const { calls, rec } = recorder();
    const client = { projects: { queueRules: { update: rec('update', { ruleId: 'jr-1' }) } } };
    await run(
      [
        'queue-rules',
        'update',
        'jr-1',
        '--project=p-1',
        '--name=new',
        '--agent=acme.x',
        '--sample=0.25',
        '--max-open=5',
        '--group=jc-2',
        '--enable',
      ],
      client,
    );
    await run(
      [
        'queue-rules',
        'update',
        'jr-1',
        '--project=p-1',
        '--clear-max-open',
        '--clear-group',
        '--disable',
      ],
      client,
    );
    expect(calls).toEqual([
      [
        'update',
        'p-1',
        'jr-1',
        {
          name: 'new',
          when: { agentIds: ['acme.x'] },
          sample: 0.25,
          maxOpen: 5,
          correctorGroupId: 'jc-2',
          enabled: true,
        },
      ],
      ['update', 'p-1', 'jr-1', { maxOpen: null, correctorGroupId: null, enabled: false }],
    ]);
  });

  test('update refuses conflicting flags and an empty change', async () => {
    const client = { projects: { queueRules: {} } };
    const base = ['queue-rules', 'update', 'jr-1', '--project=p-1'];
    expect((await run([...base, '--max-open=5', '--clear-max-open'], client)).stderr).toContain(
      'Give --max-open or --clear-max-open',
    );
    expect((await run([...base, '--group=jc-1', '--clear-group'], client)).stderr).toContain(
      'Give --group or --clear-group',
    );
    expect((await run([...base, '--enable', '--disable'], client)).stderr).toContain(
      'Give --enable or --disable',
    );
    expect((await run([...base], client)).stderr).toContain('at least one change');
  });

  test('remove unregisters the rule', async () => {
    const { calls, rec } = recorder();
    const out = await run(['queue-rules', 'remove', 'jr-1', '--project=p-1'], {
      projects: {
        queueRules: { unregister: rec('unregister', { ruleId: 'jr-1', unregistered: true }) },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['unregister', 'p-1', 'jr-1']]);
    expect(JSON.parse(out.stdout)).toEqual({ ruleId: 'jr-1', unregistered: true });
  });

  test('without --project it writes into the Default project', async () => {
    const { calls, rec } = recorder();
    const out = await run(['queue-rules', 'list'], {
      projects: {
        getDefault: rec('getDefault', { id: 'default-p' }),
        queueRules: { list: rec('list', { data: [], hasMore: false }) },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['getDefault'], ['list', 'default-p', {}]]);
  });
});

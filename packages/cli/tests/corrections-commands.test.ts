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

describe('kindgi corrections', () => {
  /** A client whose list of the caller's corrections on the run answers `live`. */
  const withLive = (rec: ReturnType<typeof recorder>['rec'], live: unknown[] = []) => ({
    corrections: {
      list: rec('list', { data: live, hasMore: false }),
      create: rec('create', { id: 'c-9' }),
    },
  });

  test("add reads the caller's correction of the run, then sends an item with the group and participant", async () => {
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
        '--why=right company',
        '--group=jc-1',
        '--participant=end-user-1',
      ],
      withLive(rec),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { runId: 'r-1', madeBy: 'me', participantId: 'end-user-1', limit: 100 }],
      [
        'create',
        {
          runId: 'r-1',
          items: [{ key: 'c2', pointer: '/matches/1', rank: 1, verdict: 'right' }],
          why: 'right company',
          correctorGroupId: 'jc-1',
          participantId: 'end-user-1',
        },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({ id: 'c-9' });
  });

  test('--decisions=wrong says what the agent should have called, and not called', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrections',
        'add',
        '--run=r-1',
        '--decisions=wrong',
        '--should-call=acme.refund:{"amount":25}',
        '--should-call=acme.lookup_order',
        '--must-not-call=acme.escalate',
      ],
      withLive(rec),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls[1]).toEqual([
      'create',
      {
        runId: 'r-1',
        decisions: 'wrong',
        shouldCall: [{ tool: 'acme.refund', args: { amount: 25 } }, { tool: 'acme.lookup_order' }],
        mustNotCall: ['acme.escalate'],
      },
    ]);
  });

  test('--answer says whether the answer was right, with what it should have said and why', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrections',
        'add',
        '--run=r-1',
        '--answer=wrong',
        '--should-say=Final-sale items are not refunded.',
        '--why=wrong refund policy',
      ],
      withLive(rec),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls[1]).toEqual([
      'create',
      {
        runId: 'r-1',
        answer: 'wrong',
        shouldSay: 'Final-sale items are not refunded.',
        why: 'wrong refund policy',
      },
    ]);
  });

  test("each call folds into the caller's live correction: the part it names is replaced, the rest kept", async () => {
    const live = {
      id: 'c-1',
      runId: 'r-1',
      decisions: 'wrong',
      mustNotCall: ['acme.escalate'],
      answer: 'wrong',
      why: 'wrong refund policy',
      items: [
        { key: 'm1', pointer: '/matches/0', verdict: 'right' },
        { key: 'm2', pointer: '/matches/1', verdict: 'right' },
      ],
      correctorGroupId: 'jc-1',
    };
    const { calls, rec } = recorder();
    const out = await run(
      ['corrections', 'add', '--run=r-1', '--item=m2', '--pointer=/matches/1', '--no'],
      withLive(rec, [{ ...live, participantId: 'end-user-1' }, live]),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    // Without --participant, the caller's own correction is the one with none.
    expect(calls[1]).toEqual([
      'create',
      {
        runId: 'r-1',
        decisions: 'wrong',
        mustNotCall: ['acme.escalate'],
        answer: 'wrong',
        why: 'wrong refund policy',
        items: [
          { key: 'm1', pointer: '/matches/0', verdict: 'right' },
          { key: 'm2', pointer: '/matches/1', verdict: 'wrong' },
        ],
        correctorGroupId: 'jc-1',
      },
    ]);
  });

  test('a part said wrong again keeps what should have happened unless given anew; said right, it drops it', async () => {
    const live = {
      id: 'c-1',
      runId: 'r-1',
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.lookup_order' }],
      mustNotCall: ['acme.escalate'],
      answer: 'wrong',
      shouldSay: 'Final-sale items are not refunded.',
    };
    const again = recorder();
    const out = await run(
      ['corrections', 'add', '--run=r-1', '--decisions=wrong', '--must-not-call=acme.refund'],
      withLive(again.rec, [live]),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(again.calls[1]?.[1]).toEqual({
      runId: 'r-1',
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.lookup_order' }],
      mustNotCall: ['acme.refund'],
      answer: 'wrong',
      shouldSay: 'Final-sale items are not refunded.',
    });
    const right = recorder();
    const answered = await run(
      ['corrections', 'add', '--run=r-1', '--decisions=right', '--answer=right'],
      withLive(right.rec, [live]),
    );
    expect(answered.exitCode, answered.stderr).toBe(0);
    expect(right.calls[1]?.[1]).toEqual({ runId: 'r-1', decisions: 'right', answer: 'right' });
  });

  test('an item named again under a new pointer replaces its entry', async () => {
    const live = {
      id: 'c-1',
      runId: 'r-1',
      items: [{ key: 'm2', pointer: '/matches/1', verdict: 'right' }],
    };
    const moved = recorder();
    const out = await run(
      ['corrections', 'add', '--run=r-1', '--item=m2', '--pointer=/matches/0', '--no'],
      withLive(moved.rec, [live]),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(moved.calls[1]?.[1]).toMatchObject({
      items: [{ key: 'm2', pointer: '/matches/0', verdict: 'wrong' }],
    });
  });

  test("add refuses what goes with a part it wasn't given, or with that part said right", async () => {
    const client = withLive(recorder().rec);
    for (const [flags, says] of [
      [
        ['--should-call=acme.refund'],
        '--should-call and --must-not-call go with --decisions=wrong',
      ],
      [['--decisions=right', '--must-not-call=acme.refund'], 'go with --decisions=wrong'],
      [['--answer=right', '--should-say=No refund.'], '--should-say goes with --answer=wrong'],
      [['--should-say=No refund.'], '--should-say goes with --answer=wrong'],
      [['--answer=wrong', '--pointer=/matches/0'], 'go with --item=<key>'],
      [['--answer=wrong', '--no'], 'go with --item=<key>'],
      [['--decisions=maybe'], '--decisions must be one of right, wrong'],
    ] as const) {
      const out = await run(['corrections', 'add', '--run=r-1', ...flags], client);
      expect(out.exitCode, flags.join(' ')).toBe(2);
      expect(out.stderr, flags.join(' ')).toContain(says);
    }
  });

  test('--item=answer, --item=output or an empty pointer points to --answer', async () => {
    const client = withLive(recorder().rec);
    for (const flags of [['--item=answer'], ['--item=output'], ['--item=c1', '--pointer=']]) {
      const out = await run(['corrections', 'add', '--run=r-1', ...flags, '--no'], client);
      expect(out.exitCode, flags.join(' ')).toBe(2);
      expect(out.stderr).toContain('--answer=right|wrong');
    }
  });

  test("add rejects --should-call arguments that aren't JSON, and the flags --answer and --why replaced", async () => {
    const client = withLive(recorder().rec);
    const bad = await run(
      ['corrections', 'add', '--run=r-1', '--decisions=wrong', '--should-call=acme.refund:{bad'],
      client,
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("--should-call's arguments must be a JSON object");
    for (const flag of ['--correction={"calls":[]}', '--reason=old']) {
      const out = await run(['corrections', 'add', '--run=r-1', '--answer=right', flag], client);
      expect(out.exitCode, flag).toBe(2);
    }
  });

  test('add without a group, and none before, is unclassified', async () => {
    const { calls, rec } = recorder();
    const out = await run(['corrections', 'add', '--run=r-1', '--item=c1', '--no'], withLive(rec));
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls[1]).toEqual([
      'create',
      { runId: 'r-1', items: [{ key: 'c1', verdict: 'wrong' }] },
    ]);
  });

  test('add needs a run, something to say, and exactly one of --yes and --no with an item', async () => {
    const client = { corrections: {} };
    const both = await run(['corrections', 'add', '--run=r', '--item=c', '--yes', '--no'], client);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain('exactly one of --yes or --no');
    const neither = await run(['corrections', 'add', '--run=r', '--item=c'], client);
    expect(neither.exitCode).toBe(2);
    expect(neither.stderr).toContain('exactly one of --yes or --no');
    const noRun = await run(['corrections', 'add', '--answer=right'], client);
    expect(noRun.stderr).toContain('--run');
    const nothing = await run(['corrections', 'add', '--run=r'], client);
    expect(nothing.exitCode).toBe(2);
    expect(nothing.stderr).toContain('Give --decisions, --answer or --item');
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
        '--group=jc-1',
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
          correctorGroupId: 'jc-1',
          participantId: 'u-1',
          scope: { kind: 'project', projectId: 'p-1' },
          limit: 5,
          cursor: 'c1',
        },
      ],
    ]);
  });

  test('list takes statuses and sortings, repeated or comma-separated', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrections',
        'list',
        '--status=not-fixed,wont-fix',
        '--status=removed',
        '--sorted-to=owner',
        '--sorted-to=none',
      ],
      { corrections: { list: rec('list', { data: [], hasMore: false }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { status: ['not-fixed', 'wont-fix', 'removed'], sortedTo: ['owner', 'none'] }],
    ]);
  });

  test('list refuses a status or sorting there is none of, and has no --verdict', async () => {
    const client = { corrections: {} };
    const status = await run(['corrections', 'list', '--status=open,done'], client);
    expect(status.exitCode).toBe(2);
    expect(status.stderr).toContain('--status must be one of');
    expect(status.stderr).toContain('got "done"');
    const sorted = await run(['corrections', 'list', '--sorted-to=improve,expert'], client);
    expect(sorted.exitCode).toBe(2);
    expect(sorted.stderr).toContain('--sorted-to must be one of');
    expect((await run(['corrections', 'list', '--verdict=wrong'], client)).exitCode).toBe(2);
  });

  test('set re-sorts and changes the status in one PATCH, with the link or reason', async () => {
    const { calls, rec } = recorder();
    const client = { corrections: { change: rec('change', { id: 'c-1', status: 'being-fixed' }) } };
    const fixing = await run(
      [
        'corrections',
        'set',
        'c-1',
        '--sorted-to=developer',
        '--status=being-fixed',
        '--link=https://github.com/acme/agents/pull/7',
      ],
      client,
    );
    expect(fixing.exitCode, fixing.stderr).toBe(0);
    expect(JSON.parse(fixing.stdout)).toEqual({ id: 'c-1', status: 'being-fixed' });
    const wontFix = await run(
      ['corrections', 'set', 'c-1', '--status=wont-fix', '--reason=The policy changed.'],
      client,
    );
    expect(wontFix.exitCode, wontFix.stderr).toBe(0);
    const resorted = await run(['corrections', 'set', 'c-1', '--sorted-to=owner'], client);
    expect(resorted.exitCode, resorted.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'change',
        'c-1',
        {
          sortedTo: 'developer',
          status: 'being-fixed',
          link: 'https://github.com/acme/agents/pull/7',
        },
      ],
      ['change', 'c-1', { status: 'wont-fix', reason: 'The policy changed.' }],
      ['change', 'c-1', { sortedTo: 'owner' }],
    ]);
  });

  test('set needs a correction and --status or --sorted-to, each a value it takes', async () => {
    const client = { corrections: {} };
    const noId = await run(['corrections', 'set', '--status=open'], client);
    expect(noId.exitCode).toBe(2);
    expect(noId.stderr).toContain('correction-id');
    const nothing = await run(['corrections', 'set', 'c-1', '--reason=Why.'], client);
    expect(nothing.exitCode).toBe(2);
    expect(nothing.stderr).toContain('Give --status, --sorted-to, or both');
    // `fixed` comes from a pin or a deploy, and `removed` from `remove`.
    for (const flag of ['--status=fixed', '--status=removed', '--sorted-to=none']) {
      const out = await run(['corrections', 'set', 'c-1', flag], client);
      expect(out.exitCode, flag).toBe(2);
      expect(out.stderr, flag).toContain('must be one of');
    }
    const empty = await run(['corrections', 'set', 'c-1', '--status=open', '--reason='], client);
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain('--reason takes a value');
  });

  test('list takes who made them and since when', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['corrections', 'list', '--agent=acme.matcher', '--from=experts', '--since=2026-10-01'],
      { corrections: { list: rec('list', { data: [], hasMore: false }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { agentId: 'acme.matcher', from: 'experts', since: '2026-10-01T00:00:00.000Z' }],
    ]);
    const client = { corrections: {} };
    const from = await run(['corrections', 'list', '--from=reviewers'], client);
    expect(from.exitCode).toBe(2);
    expect(from.stderr).toContain('--from must be one of experts, end-users, all');
    const since = await run(['corrections', 'list', '--since=last week'], client);
    expect(since.exitCode).toBe(2);
    expect(since.stderr).toContain('--since must be an ISO 8601 time');
  });

  test('list refuses --agent-version without --agent', async () => {
    const client = { corrections: {} };
    expect((await run(['corrections', 'list', '--agent-version=1.0.0'], client)).stderr).toContain(
      '--agent-version needs --agent',
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

describe('kindgi corrector-groups', () => {
  test('list narrows by scope', async () => {
    const { calls, rec } = recorder();
    const client = { correctorGroups: { list: rec('list', { data: [], hasMore: false }) } };
    await run(['corrector-groups', 'list'], client);
    await run(['corrector-groups', 'list', '--tenant'], client);
    await run(['corrector-groups', 'list', '--project=p-1'], client);
    await run(['corrector-groups', 'list', '--agent=acme.matcher', '--project=p-1'], client);
    expect(calls).toEqual([
      ['list', {}],
      ['list', { scope: { kind: 'tenant' } }],
      ['list', { scope: { kind: 'project', projectId: 'p-1' } }],
      ['list', { scope: { kind: 'agent', projectId: 'p-1', agentId: 'acme.matcher' } }],
    ]);
  });

  test('--agent needs --project; --tenant stands alone', async () => {
    const client = { correctorGroups: {} };
    expect((await run(['corrector-groups', 'list', '--agent=a'], client)).stderr).toContain(
      '--agent needs --project',
    );
    expect(
      (await run(['corrector-groups', 'list', '--tenant', '--project=p'], client)).stderr,
    ).toContain('--tenant cannot be combined');
  });

  test('add creates a group in a scope', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrector-groups',
        'add',
        '--name=expert',
        '--weight=3',
        '--tenant',
        '--description=Domain experts',
      ],
      { correctorGroups: { create: rec('create', { id: 'jc-1' }) } },
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
    const client = { correctorGroups: {} };
    expect(
      (await run(['corrector-groups', 'add', '--weight=1', '--tenant'], client)).stderr,
    ).toContain('--name');
    expect(
      (await run(['corrector-groups', 'add', '--name=x', '--tenant'], client)).stderr,
    ).toContain('--weight');
    expect(
      (await run(['corrector-groups', 'add', '--name=x', '--weight=-1', '--tenant'], client))
        .stderr,
    ).toContain('--weight must be a number');
    expect(
      (await run(['corrector-groups', 'add', '--name=x', '--weight=1'], client)).stderr,
    ).toContain('Give a scope');
  });

  test('add and set take who may assert a group; set --unrestricted lifts it', async () => {
    const { calls, rec } = recorder();
    const client = {
      correctorGroups: {
        create: rec('create', { id: 'jc-1' }),
        update: rec('update', { id: 'jc-1' }),
      },
    };
    const added = await run(
      [
        'corrector-groups',
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
    await run(['corrector-groups', 'set', 'jc-1', '--principal-kind=service'], client);
    await run(['corrector-groups', 'set', 'jc-1', '--unrestricted'], client);
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
    const client = { correctorGroups: {} };
    const add = ['corrector-groups', 'add', '--name=x', '--weight=1', '--tenant'];
    expect((await run([...add, '--min-reviewer-role=chief'], client)).stderr).toContain(
      '--min-reviewer-role must be one of standard, senior, admin',
    );
    expect((await run([...add, '--principal-kind=robot'], client)).stderr).toContain(
      '--principal-kind must be user or service',
    );
    expect(
      (await run(['corrector-groups', 'set', 'jc-1', '--unrestricted', '--principal-id=u'], client))
        .stderr,
    ).toContain('--unrestricted cannot be combined');
  });

  test('set changes weight and/or description; remove retires', async () => {
    const { calls, rec } = recorder();
    const client = {
      correctorGroups: {
        update: rec('update', { id: 'jc-1' }),
        unregister: rec('unregister', undefined),
      },
    };
    expect((await run(['corrector-groups', 'set', 'jc-1', '--weight=0'], client)).exitCode).toBe(0);
    expect((await run(['corrector-groups', 'set', 'jc-1'], client)).exitCode).toBe(2);
    const removed = await run(['corrector-groups', 'remove', 'jc-1'], client);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(calls).toEqual([
      ['update', 'jc-1', { weight: 0 }],
      ['unregister', 'jc-1'],
    ]);
  });
});

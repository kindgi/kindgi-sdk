// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
        '--reason=right company',
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

  test('--correction says what the decisions should have been', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrections',
        'add',
        '--run=r-1',
        '--no',
        '--correction={"calls":[{"tool":"acme.refund","args":{"amount":25}}],"notCalled":["acme.escalate"]}',
      ],
      withLive(rec),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls[1]).toEqual([
      'create',
      {
        runId: 'r-1',
        decisions: 'wrong',
        shouldCall: [{ tool: 'acme.refund', args: { amount: 25 } }],
        mustNotCall: ['acme.escalate'],
      },
    ]);
  });

  test('--item=answer, --item=output or an empty pointer is the answer', async () => {
    for (const flag of ['--item=answer', '--item=output', '--pointer=']) {
      const { calls, rec } = recorder();
      const out = await run(
        ['corrections', 'add', '--run=r-1', flag, '--no', '--reason=wrong refund policy'],
        withLive(rec),
      );
      expect(out.exitCode, out.stderr).toBe(0);
      expect(calls[1]).toEqual([
        'create',
        { runId: 'r-1', answer: 'wrong', why: 'wrong refund policy' },
      ]);
    }
  });

  test("each call folds into the caller's live correction: the piece it names is replaced, the rest kept", async () => {
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

  test('an item named again under a new pointer replaces its entry, and a right answer drops what it should have said', async () => {
    const live = {
      id: 'c-1',
      runId: 'r-1',
      answer: 'wrong',
      shouldSay: 'Final-sale items are not refunded.',
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
    const right = recorder();
    const answered = await run(
      ['corrections', 'add', '--run=r-1', '--item=answer', '--yes'],
      withLive(right.rec, [live]),
    );
    expect(answered.exitCode, answered.stderr).toBe(0);
    expect(right.calls[1]?.[1]).toMatchObject({ answer: 'right' });
    expect(right.calls[1]?.[1]).not.toHaveProperty('shouldSay');
  });

  test('add refuses --item, --pointer or --rank with --correction, and --rank on the answer', async () => {
    const client = withLive(recorder().rec);
    const corr = '--correction={"calls":[],"notCalled":["acme.escalate"]}';
    for (const flag of ['--item=c1', '--pointer=/matches/0', '--rank=1']) {
      const out = await run(['corrections', 'add', '--run=r-1', flag, '--no', corr], client);
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain("--correction is about the run's decisions");
    }
    const rankedAnswer = await run(
      ['corrections', 'add', '--run=r-1', '--item=answer', '--rank=0', '--yes'],
      client,
    );
    expect(rankedAnswer.exitCode).toBe(2);
    expect(rankedAnswer.stderr).toContain('not the answer');
  });

  test('add rejects a malformed --correction', async () => {
    const out = await run(
      ['corrections', 'add', '--run=r-1', '--no', '--correction={bad'],
      withLive(recorder().rec),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Malformed JSON input');
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

  /** A body that sends `chunks`, then ends, or breaks off when `cut`. Records a cancel. */
  function body(chunks: string[], { cut = false } = {}) {
    const state = { cancelled: false };
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++] as string));
        else if (cut) controller.error(new Error('connection reset'));
        else controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  const CSV = ['id,projectId\r\n', 'c-1,p-1\r\n', 'c-2,p-1\r\n'];

  test('export prints the CSV once it has all arrived, and passes the filters', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'corrections',
        'export',
        '--agent=acme.matcher',
        '--project=p-1',
        '--status=not-fixed',
        '--status=fixed',
        '--sorted-to=developer',
        '--from=end-users',
        '--since=2026-10-01',
        '--until=2026-11-01T00:00:00Z',
      ],
      { corrections: { export: rec('export', body(CSV).stream) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toBe(CSV.join(''));
    expect(calls).toEqual([
      [
        'export',
        {
          agentId: 'acme.matcher',
          scope: { kind: 'project', projectId: 'p-1' },
          status: ['not-fixed', 'fixed'],
          sortedTo: ['developer'],
          from: 'end-users',
          since: '2026-10-01T00:00:00.000Z',
          until: '2026-11-01T00:00:00.000Z',
          format: 'csv',
        },
      ],
    ]);
  });

  test('--format=jsonl asks for JSON lines', async () => {
    const { calls, rec } = recorder();
    const out = await run(['corrections', 'export', '--agent=a', '--format=jsonl'], {
      corrections: { export: rec('export', body(['{"id":"c-1"}\n']).stream) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toBe('{"id":"c-1"}\n');
    expect(calls[0]?.[1]).toMatchObject({ format: 'jsonl' });
  });

  test('--out writes the file once the whole export has arrived, and leaves no partial', async () => {
    const { rec } = recorder();
    const out = await run(['corrections', 'export', '--agent=a', '--out=october.csv'], {
      corrections: { export: rec('export', body(CSV).stream) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const file = join(cwd, 'october.csv');
    expect(await readFile(file, 'utf8')).toBe(CSV.join(''));
    expect(await readdir(cwd)).toEqual(['october.csv']);
    expect(JSON.parse(out.stdout)).toEqual({
      agentId: 'a',
      format: 'csv',
      file,
      bytes: Buffer.byteLength(CSV.join('')),
    });
  });

  test('an existing --out file is kept unless --force, and no export is asked for', async () => {
    const file = join(cwd, 'october.csv');
    await writeFile(file, 'mine\n');
    const { calls, rec } = recorder();
    const kept = await run(['corrections', 'export', '--agent=a', '--out=october.csv'], {
      corrections: { export: rec('export', body(CSV).stream) },
    });
    expect(kept.exitCode).not.toBe(0);
    expect(kept.stderr).toContain(
      `${file} exists: pass --force to overwrite it, or --out=<other file>`,
    );
    expect(await readFile(file, 'utf8')).toBe('mine\n');
    expect(calls).toEqual([]);
    expect(await readdir(cwd)).toEqual(['october.csv']);

    const forced = await run(
      ['corrections', 'export', '--agent=a', '--out=october.csv', '--force'],
      {
        corrections: { export: rec('export', body(CSV).stream) },
      },
    );
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(CSV.join(''));
    expect(await readdir(cwd)).toEqual(['october.csv']);
  });

  test('a stream cut part way writes nothing: no file, no partial, an existing file as it was', async () => {
    const { rec } = recorder();
    const cut = await run(['corrections', 'export', '--agent=a', '--out=new.csv'], {
      corrections: { export: rec('export', body(CSV.slice(0, 2), { cut: true }).stream) },
    });
    expect(cut.exitCode).not.toBe(0);
    expect(cut.stderr).toContain('the export stopped part way (connection reset)');
    expect(cut.stderr).toContain("wasn't written");
    expect(await readdir(cwd)).toEqual([]);

    const file = join(cwd, 'october.csv');
    await writeFile(file, 'mine\n');
    const forcedCut = await run(
      ['corrections', 'export', '--agent=a', '--out=october.csv', '--force'],
      {
        corrections: { export: rec('export', body(CSV.slice(0, 1), { cut: true }).stream) },
      },
    );
    expect(forcedCut.exitCode).not.toBe(0);
    expect(await readFile(file, 'utf8')).toBe('mine\n');
    expect(await readdir(cwd)).toEqual(['october.csv']);
  });

  test('a stream cut part way prints nothing', async () => {
    const { rec } = recorder();
    const out = await run(['corrections', 'export', '--agent=a'], {
      corrections: { export: rec('export', body(CSV.slice(0, 2), { cut: true }).stream) },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain(
      'the export stopped part way (connection reset): nothing was printed',
    );
  });

  test('export needs --agent, a known --format and --from, and times it can read; none of these sends a request', async () => {
    const { calls, rec } = recorder();
    const client = { corrections: { export: rec('export', body(CSV).stream) } };
    const cases: [string[], string][] = [
      [[], '--agent'],
      [['--agent=a', '--format=xml'], '--format'],
      [['--agent=a', '--from=nobody'], '--from'],
      [['--agent=a', '--since=yesterday'], '--since'],
      [['--agent=a', '--until=soon'], '--until'],
    ];
    for (const [flags, named] of cases) {
      const out = await run(['corrections', 'export', ...flags], client);
      expect(out.exitCode, flags.join(' ')).toBe(2);
      expect(out.stderr).toContain(named);
    }
    expect(calls).toEqual([]);
  });

  test('an API error comes back as the command error', async () => {
    const out = await run(['corrections', 'export', '--agent=a', '--project=p-9'], {
      corrections: {
        export: async () => {
          throw Object.assign(new Error('Not allowed to read project "p-9".'), { status: 403 });
        },
      },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('Not allowed to read project "p-9".');
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

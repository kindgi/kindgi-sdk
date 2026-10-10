// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** What a run waits for (`kindgi runs resume`, T272), from fakes of the three reads. */

import { describe, expect, test } from 'vitest';

import {
  type JournalEntry,
  RESUME_EXIT_CODES,
  type RunWaitPort,
  type WaitingApproval,
  runWaitAnswer,
  runWaitText,
} from '../src/commands/run-waits.js';

const T0 = '2026-10-06T12:00:00.000Z';
let seq = 0;
const entry = (kind: string, payload: object = {}, nodeId?: string): JournalEntry => ({
  sequence: seq++,
  kind,
  payload,
  timestamp: T0,
  ...(nodeId !== undefined && { nodeId }),
});

function port(options: {
  readonly runs: Record<string, string>;
  readonly journal?: readonly JournalEntry[];
  readonly approvals?: readonly WaitingApproval[] | Error;
  readonly pageSize?: number;
}): RunWaitPort & { readonly asked: (readonly string[])[]; readonly sinces: unknown[] } {
  const asked: (readonly string[])[] = [];
  const sinces: unknown[] = [];
  const journal = options.journal ?? [];
  const size = options.pageSize ?? 1000;
  return {
    asked,
    sinces,
    getRun: async (id) => {
      const status = options.runs[id];
      if (status === undefined) throw new Error(`no run ${id}`);
      return { id, status };
    },
    journalPage: async (_id, since) => {
      sinces.push(since);
      const from = journal.filter((e) => since === undefined || e.sequence >= since);
      return { data: from.slice(0, size), hasMore: from.length > size };
    },
    approvalsFor: async (tokens) => {
      asked.push(tokens);
      if (options.approvals instanceof Error) throw options.approvals;
      return options.approvals ?? [];
    },
  };
}

const approval = (id: string, waitTokenId: string, status = 'pending'): WaitingApproval => ({
  id,
  title: 'Refund order 7',
  requiredRole: 'senior',
  status,
  waitTokenId,
});

describe('a run that is not waiting', () => {
  test.each(['completed', 'failed', 'cancelled'])(
    '%s: exit 0, nothing read beyond the run',
    async (status) => {
      const p = port({ runs: { r1: status } });
      const answer = await runWaitAnswer(p, 'r1');
      expect(answer).toEqual({ kind: 'not-waiting', runId: 'r1', status });
      expect(RESUME_EXIT_CODES[answer.kind]).toBe(0);
      expect(p.sinces).toEqual([]);
      expect(runWaitText(answer)).toBe(
        `Run r1 is ${status}: it isn't waiting, so there's nothing to resume.\n`,
      );
    },
  );

  test('running with no retry or lease pending', async () => {
    const journal = [
      entry('step.retry-scheduled', { attempt: 1, nextDelayMs: 500 }, 'n1'),
      entry('step.started', {}, 'n1'),
    ];
    const answer = await runWaitAnswer(port({ runs: { r1: 'running' }, journal }), 'r1');
    expect(answer.kind).toBe('not-waiting');
    expect(runWaitText(answer)).toContain("is running: it isn't waiting on anything");
  });
});

describe('a run waiting on the runtime: exit 4', () => {
  test('queued', async () => {
    const answer = await runWaitAnswer(port({ runs: { r1: 'pending' } }), 'r1');
    expect(answer).toEqual({
      kind: 'runtime',
      runId: 'r1',
      status: 'pending',
      waits: [{ what: 'queued' }],
    });
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(4);
  });

  test('a scheduled retry, and when', async () => {
    const journal = [
      entry('step.started', {}, 'n1'),
      entry('step.retry-scheduled', { attempt: 2, nextDelayMs: 30_000 }, 'n1'),
    ];
    const answer = await runWaitAnswer(port({ runs: { r1: 'running' }, journal }), 'r1');
    expect(answer).toMatchObject({
      kind: 'runtime',
      waits: [{ what: 'retry', nodeId: 'n1', attempt: 2, at: '2026-10-06T12:00:30.000Z' }],
    });
    expect(runWaitText(answer)).toContain(
      'retries step n1 (attempt 2) at 2026-10-06T12:00:30.000Z',
    );
  });

  test('a lease another run holds', async () => {
    const journal = [
      entry(
        'step.concurrency-deferred',
        { concurrencyKey: 'acme-ledger', holderRunId: 'r9', holderNodeId: 'post' },
        'n1',
      ),
    ];
    const answer = await runWaitAnswer(port({ runs: { r1: 'running' }, journal }), 'r1');
    expect(answer).toMatchObject({
      kind: 'runtime',
      waits: [{ what: 'lease', holderRunId: 'r9' }],
    });
    expect(runWaitText(answer)).toContain(
      'waits for the lease "acme-ledger" for step n1, held by run r9 (step post)',
    );
  });

  test('a child run, with its status and when the wait times out; approvals are not asked', async () => {
    const journal = [entry('wait.suspended', { tokenId: 'child:c1:4', timeoutMs: 60_000 }, 'sub')];
    const p = port({ runs: { r1: 'suspended', c1: 'running' }, journal });
    const answer = await runWaitAnswer(p, 'r1');
    expect(answer).toEqual({
      kind: 'runtime',
      runId: 'r1',
      status: 'suspended',
      waits: [
        {
          what: 'child-run',
          childRunId: 'c1',
          childStatus: 'running',
          timesOutAt: '2026-10-06T12:01:00.000Z',
        },
      ],
    });
    expect(p.asked).toEqual([]);
  });

  test('an approval already decided: the runtime continues the run', async () => {
    const journal = [entry('wait.suspended', { tokenId: 'tok-a' }, 'gate')];
    const answer = await runWaitAnswer(
      port({
        runs: { r1: 'suspended' },
        journal,
        approvals: [approval('ap-1', 'tok-a', 'approved')],
      }),
      'r1',
    );
    expect(answer).toMatchObject({
      kind: 'runtime',
      waits: [{ what: 'decided-approval', approvalId: 'ap-1', approvalStatus: 'approved' }],
    });
  });
});

describe('a run waiting for an approval: exit 3', () => {
  test('names the approval and the command that decides it; a resumed wait is not open', async () => {
    const journal = [
      entry('wait.suspended', { tokenId: 'tok-old' }, 'gate'),
      entry('wait.resumed', { tokenId: 'tok-old', value: {} }, 'gate'),
      entry('wait.suspended', { tokenId: 'tok-a' }, 'gate'),
    ];
    const p = port({ runs: { r1: 'suspended' }, journal, approvals: [approval('ap-1', 'tok-a')] });
    const answer = await runWaitAnswer(p, 'r1');
    expect(p.asked).toEqual([['tok-a']]);
    expect(answer).toMatchObject({
      kind: 'approval',
      approvals: [{ id: 'ap-1' }],
      alsoWaitsOn: [],
    });
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(3);
    expect(runWaitText(answer)).toBe(
      'Run r1 waits for approval ap-1 ("Refund order 7"), for a senior reviewer or above. It continues once the approval is decided: kindgi approvals complete ap-1 --decision=approve (or --decision=reject).\n',
    );
  });

  test('from a runtime that ignores the filter: approvals of other waits are dropped', async () => {
    const journal = [entry('wait.suspended', { tokenId: 'tok-a' }, 'gate')];
    const answer = await runWaitAnswer(
      port({
        runs: { r1: 'suspended' },
        journal,
        approvals: [
          approval('ap-other', 'tok-z'),
          approval('ap-1', 'tok-a'),
          approval('ap-other2', 'tok-y'),
        ],
      }),
      'r1',
    );
    expect(answer).toMatchObject({ kind: 'approval', approvals: [{ id: 'ap-1' }] });
  });
});

describe('a wait no approval matches: the fallback line, exit 4', () => {
  test('a runtime that ignores the filter and answers only other approvals', async () => {
    const journal = [entry('wait.suspended', { tokenId: 'tok-a', timeoutMs: 1000 }, 'gate')];
    const answer = await runWaitAnswer(
      port({ runs: { r1: 'suspended' }, journal, approvals: [approval('ap-other', 'tok-z')] }),
      'r1',
    );
    expect(answer).toEqual({
      kind: 'runtime',
      runId: 'r1',
      status: 'suspended',
      waits: [{ what: 'unattributed', tokenId: 'tok-a', timesOutAt: '2026-10-06T12:00:01.000Z' }],
    });
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(4);
    expect(runWaitText(answer)).toBe(
      'Run r1 waits on "tok-a". This runtime can\'t say which approval, if any, that is: kindgi approvals list --status=pending lists the open ones. It times out at 2026-10-06T12:00:01.000Z.\n',
    );
  });

  test('approvals that can’t be read (the caller is no reviewer): said so', async () => {
    const journal = [entry('wait.suspended', { tokenId: 'tok-a' }, 'gate')];
    const answer = await runWaitAnswer(
      port({ runs: { r1: 'suspended' }, journal, approvals: new Error('Not a reviewer.') }),
      'r1',
    );
    expect(answer).toMatchObject({ kind: 'runtime', approvalsUnavailable: 'Not a reviewer.' });
    expect(runWaitText(answer)).toContain("(The approvals couldn't be read: Not a reviewer.)");
  });
});

test('the journal is read page by page, from the sequence after the last', async () => {
  seq = 0;
  const journal = [
    entry('run.started'),
    entry('wait.suspended', { tokenId: 'tok-old' }, 'gate'),
    entry('wait.resumed', { tokenId: 'tok-old' }, 'gate'),
    entry('wait.suspended', { tokenId: 'tok-a' }, 'gate'),
  ];
  const p = port({
    runs: { r1: 'suspended' },
    journal,
    pageSize: 2,
    approvals: [approval('ap-1', 'tok-a')],
  });
  const answer = await runWaitAnswer(p, 'r1');
  expect(p.sinces).toEqual([undefined, 2]);
  expect(answer.kind).toBe('approval');
});

describe('a runtime that answers it with the run (`waitingFor`, 0.1.6 on): used as it is', () => {
  function withWaitingFor(
    waitingFor: NonNullable<Awaited<ReturnType<RunWaitPort['getRun']>>['waitingFor']>,
  ) {
    const base = port({ runs: { r1: 'suspended' } });
    return {
      ...base,
      getRun: async (id: string) => ({ id, status: 'suspended', waitingFor }),
    } satisfies RunWaitPort;
  }

  test('an approval holding a tool call: named, with the call and the command; nothing else is read', async () => {
    const p = withWaitingFor({
      approvals: [
        {
          approvalId: 'ap-9',
          status: 'pending',
          requiredRole: 'senior',
          title: 'Refund order 7',
          tool: { id: 'acme.refund', version: '1.0.0', callId: 'call_1' },
        },
      ],
      other: [],
    });
    const answer = await runWaitAnswer(p, 'r1');
    expect(answer.kind).toBe('approval');
    expect(p.sinces).toEqual([]);
    expect(p.asked).toEqual([]);
    expect(runWaitText(answer)).toBe(
      'Run r1 waits for approval ap-9 ("Refund order 7"), holding call call_1 to acme.refund@1.0.0, for a senior reviewer or above. It continues once the approval is decided: kindgi approvals complete ap-9 --decision=approve (or --decision=reject).\n',
    );
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(3);
  });

  test('only other waits: the runtime answer, in the same words', async () => {
    const p = withWaitingFor({
      approvals: [],
      other: [{ what: 'child-run', childRunId: 'c2', childStatus: 'running' }],
    });
    const answer = await runWaitAnswer(p, 'r1');
    expect(answer).toEqual({
      kind: 'runtime',
      runId: 'r1',
      status: 'suspended',
      waits: [{ what: 'child-run', childRunId: 'c2', childStatus: 'running' }],
    });
    expect(p.sinces).toEqual([]);
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(4);
  });
});

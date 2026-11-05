// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** What a run waits for (`kindgi runs resume`, T272), from fakes of the three reads. */

import { describe, expect, test } from 'vitest';

import {
  type JournalEntry,
  RESUME_EXIT_CODES,
  type RunWaitPort,
  type WaitingApproval,
  type WaitingConnection,
  type WaitingToken,
  onlyTokenWait,
  runWaitAnswer,
  runWaitText,
} from '../src/commands/run-waits.js';
import { UsageError } from '../src/errors.js';

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

describe("a wait for another system's answer (`waitingFor.tokens`): exit 5", () => {
  const T1 = '2026-10-07T12:00:00.000Z';
  const signOff: WaitingToken = {
    tokenId: 'pause:k1:1',
    name: 'manager sign-off',
    tool: { id: 'acme.review', version: '1.0.0' },
    nodeId: 'review',
    createdAt: T0,
    timesOutAt: T1,
  };
  const shipping: WaitingToken = {
    tokenId: 'pause:k2:1',
    tool: { id: 'acme.ship', version: '2.0.0', callId: 'call_2' },
    createdAt: T0,
    timesOutAt: T1,
  };
  function withWaitingFor(
    waitingFor: NonNullable<Awaited<ReturnType<RunWaitPort['getRun']>>['waitingFor']>,
  ) {
    const base = port({ runs: { r1: 'suspended' } });
    return {
      ...base,
      getRun: async (id: string) => ({ id, status: 'suspended', waitingFor }),
    } satisfies RunWaitPort;
  }

  test('one: what it waits for, the call and its step, how it is answered and when it times out; nothing else is read', async () => {
    const p = withWaitingFor({ approvals: [], other: [], tokens: [signOff] });
    const answer = await runWaitAnswer(p, 'r1');
    expect(answer).toEqual({
      kind: 'token',
      runId: 'r1',
      status: 'suspended',
      tokens: [signOff],
      alsoWaitsOn: [],
    });
    expect(p.sinces).toEqual([]);
    expect(p.asked).toEqual([]);
    expect(runWaitText(answer)).toBe(
      'Run r1 waits for "manager sign-off" from another system, for its call to acme.review@1.0.0 in step review. It continues once that system answers through the link the tool handed on, or: kindgi runs resume r1 --output=<json>. It times out at 2026-10-07T12:00:00.000Z.\n',
    );
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(5);
  });

  test('two, one unnamed, and a child run: each names its --waitpoint, and the child run follows', async () => {
    const answer = await runWaitAnswer(
      withWaitingFor({
        approvals: [],
        other: [{ what: 'child-run', childRunId: 'c2', childStatus: 'running' }],
        tokens: [signOff, shipping],
      }),
      'r1',
    );
    expect(answer.kind).toBe('token');
    expect(runWaitText(answer).split('\n')).toEqual([
      'Run r1 waits for "manager sign-off" from another system, for its call to acme.review@1.0.0 in step review. It continues once that system answers through the link the tool handed on, or: kindgi runs resume r1 --output=<json> --waitpoint=pause:k1:1. It times out at 2026-10-07T12:00:00.000Z.',
      'Run r1 waits for an answer from another system, for its call to acme.ship@2.0.0. It continues once that system answers through the link the tool handed on, or: kindgi runs resume r1 --output=<json> --waitpoint=pause:k2:1. It times out at 2026-10-07T12:00:00.000Z.',
      'Run r1 waits for its child run c2 (running); it continues when that run finishes.',
      '',
    ]);
  });

  test('with an approval: exit 3, and the wait for an answer is listed after it', async () => {
    const answer = await runWaitAnswer(
      withWaitingFor({
        approvals: [{ approvalId: 'ap-9', status: 'pending', requiredRole: 'senior' }],
        other: [],
        tokens: [signOff],
      }),
      'r1',
    );
    expect(answer).toMatchObject({ kind: 'approval', tokens: [signOff] });
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(3);
    const [first, second] = runWaitText(answer).split('\n');
    expect(first).toContain('waits for approval ap-9');
    expect(second).toContain('waits for "manager sign-off" from another system');
  });

  test('an empty list is no wait: the runtime answer, and an approval answer lists none', async () => {
    const runtime = await runWaitAnswer(
      withWaitingFor({ approvals: [], other: [{ what: 'no-open-wait' }], tokens: [] }),
      'r1',
    );
    expect(runtime.kind).toBe('runtime');
    const approval = await runWaitAnswer(
      withWaitingFor({
        approvals: [{ approvalId: 'ap-9', status: 'pending', requiredRole: 'senior' }],
        other: [],
        tokens: [],
      }),
      'r1',
    );
    expect(approval).not.toHaveProperty('tokens');
  });

  test('--output with no --waitpoint answers the only wait; none, or several, sends nothing', () => {
    const run = (tokens: readonly WaitingToken[]) => ({
      id: 'r1',
      status: 'suspended',
      waitingFor: { approvals: [], other: [], tokens },
    });
    expect(onlyTokenWait(run([signOff]))).toBe('pause:k1:1');
    expect(() => onlyTokenWait(run([]))).toThrow(
      "Run r1 (suspended) doesn't wait for another system's answer, so nothing was sent. kindgi runs resume r1 says what it waits for.",
    );
    expect(() => onlyTokenWait({ id: 'r1', status: 'running' })).toThrow(
      "Run r1 (running) doesn't wait for another system's answer",
    );
    expect(() => onlyTokenWait(run([signOff, shipping]))).toThrow(UsageError);
    expect(() => onlyTokenWait(run([signOff, shipping]))).toThrow(
      'Run r1 waits for 2 answers: name one with --waitpoint=<id> (pause:k1:1, "manager sign-off", pause:k2:1).',
    );
  });
});

describe("a wait for a person's connect (`waitingFor.connections`): exit 6", () => {
  const T1 = '2026-10-07T12:00:00.000Z';
  const mail: WaitingConnection = {
    name: 'mail',
    requestId: 'cr-1',
    waitToken: 'connect:cr-1',
    app: 'acme-mail',
    appName: 'Acme Mail',
    says: ['Send mail as you', 'Read your mail'],
    connectUrl: 'https://kindgi.example/connect/cr-1',
    expiresAt: T1,
  };
  const signOff: WaitingToken = {
    tokenId: 'pause:k1:1',
    name: 'manager sign-off',
    tool: { id: 'acme.review', version: '1.0.0' },
    createdAt: T0,
    timesOutAt: T1,
  };
  function withWaitingFor(
    waitingFor: NonNullable<Awaited<ReturnType<RunWaitPort['getRun']>>['waitingFor']>,
  ) {
    const base = port({ runs: { r1: 'suspended' } });
    return {
      ...base,
      getRun: async (id: string) => ({ id, status: 'suspended', waitingFor }),
    } satisfies RunWaitPort;
  }

  test('only a connect: what it asks for, where to connect and until when; nothing else is read', async () => {
    const p = withWaitingFor({ approvals: [], other: [], connections: [mail] });
    const answer = await runWaitAnswer(p, 'r1');
    expect(answer).toEqual({
      kind: 'connection',
      runId: 'r1',
      status: 'suspended',
      connections: [mail],
      alsoWaitsOn: [],
    });
    expect(p.sinces).toEqual([]);
    expect(p.asked).toEqual([]);
    expect(runWaitText(answer)).toBe(
      'Run r1 waits for the person who started it to connect Acme Mail for its "mail" connection (it asks for: Send mail as you; Read your mail). It continues once they have, from the run\'s page or this link, which works until 2026-10-07T12:00:00.000Z: https://kindgi.example/connect/cr-1\n',
    );
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(6);
  });

  test('a reconnect that asks for nothing new, and a child run: the reconnect, then the child run', async () => {
    const answer = await runWaitAnswer(
      withWaitingFor({
        approvals: [],
        other: [{ what: 'child-run', childRunId: 'c2', childStatus: 'running' }],
        connections: [{ ...mail, says: [], reconnects: true }],
      }),
      'r1',
    );
    expect(answer.kind).toBe('connection');
    expect(runWaitText(answer).split('\n')).toEqual([
      'Run r1 waits for the person who started it to reconnect Acme Mail for its "mail" connection. It continues once they have, from the run\'s page or this link, which works until 2026-10-07T12:00:00.000Z: https://kindgi.example/connect/cr-1',
      'Run r1 waits for its child run c2 (running); it continues when that run finishes.',
      '',
    ]);
  });

  test('with an approval and an answer from another system: exit 3, and the connect is listed after both', async () => {
    const answer = await runWaitAnswer(
      withWaitingFor({
        approvals: [{ approvalId: 'ap-9', status: 'pending', requiredRole: 'senior' }],
        other: [],
        tokens: [signOff],
        connections: [mail],
      }),
      'r1',
    );
    expect(answer).toMatchObject({ kind: 'approval', tokens: [signOff], connections: [mail] });
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(3);
    const lines = runWaitText(answer).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('waits for approval ap-9');
    expect(lines[1]).toContain('waits for "manager sign-off" from another system');
    expect(lines[2]).toContain('to connect Acme Mail for its "mail" connection');
  });

  test('with an answer from another system: exit 5, and the connect follows it', async () => {
    const answer = await runWaitAnswer(
      withWaitingFor({ approvals: [], other: [], tokens: [signOff], connections: [mail] }),
      'r1',
    );
    expect(answer).toEqual({
      kind: 'token',
      runId: 'r1',
      status: 'suspended',
      tokens: [signOff],
      alsoWaitsOn: [],
      connections: [mail],
    });
    expect(RESUME_EXIT_CODES[answer.kind]).toBe(5);
    const lines = runWaitText(answer).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('waits for "manager sign-off" from another system');
    expect(lines[1]).toContain('to connect Acme Mail for its "mail" connection');
  });

  test('an empty list is no wait: the runtime answer, and an approval answer lists none', async () => {
    const runtime = await runWaitAnswer(
      withWaitingFor({ approvals: [], other: [{ what: 'no-open-wait' }], connections: [] }),
      'r1',
    );
    expect(runtime.kind).toBe('runtime');
    const approval = await runWaitAnswer(
      withWaitingFor({
        approvals: [{ approvalId: 'ap-9', status: 'pending', requiredRole: 'senior' }],
        other: [],
        connections: [],
      }),
      'r1',
    );
    expect(approval).not.toHaveProperty('connections');
  });
});

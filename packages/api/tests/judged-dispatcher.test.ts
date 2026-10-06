// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ReplayToolTrace } from '@kindgi/agents';
import type { ProjectId, RunId, TenantId } from '@kindgi/types';

import type {
  DispatchContext,
  EvalComparison,
  EvalRunSubjectInvokeInput,
  EvalRunSubjectInvokeOutcome,
  EvalSuite,
  JudgedCaseResult,
  JudgedComparisonSummary,
  JudgedEvalCase,
} from '../src/index.js';
import { DEFAULT_COMPARISON, createJudgedDispatcher } from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';

const tenantId = 't-1' as TenantId;

const turn = (answer: string, matches: unknown[] = []) => ({
  appended: [
    { role: 'user', content: 'q' },
    { role: 'agent', content: { text: '', toolCalls: [{ id: 'c1' }] } },
    { role: 'tool', content: {} },
    { role: 'agent', content: answer },
  ],
  output: { matches },
});

const item = (key: string, yesWeight: number, totalWeight: number, extra: object = {}) => ({
  key,
  yes: yesWeight > 0 ? 1 : 0,
  no: yesWeight < totalWeight ? 1 : 0,
  yesWeight,
  totalWeight,
  reasons: [],
  ...extra,
});

const caseA: JudgedEvalCase = {
  caseId: 'case-a',
  subject: { kind: 'agent', id: 'acme.agent', version: '1.0.0' },
  input: 'find acme',
  context: { history: [{ role: 'user', content: 'earlier' }] },
  output: turn('Found 2.', [{ id: 'm1' }, { id: 'm2' }]),
  items: [
    item('answer', 1, 1, { pointer: '/appended/3/content' }),
    item('m1', 2, 2, { pointer: '/output/matches/0', rank: 0 }),
    item('m2', 0, 1, { pointer: '/output/matches/1', rank: 1 }),
  ],
};

const caseB: JudgedEvalCase = {
  caseId: 'case-b',
  subject: { kind: 'agent', id: 'acme.agent', version: '1.0.0' },
  input: 'find b',
  output: turn('B.'),
  items: [item('answer', 0, 1, { pointer: '/appended/3/content' })],
};

const trace = (...sources: ReplayToolTrace['source'][]): ReplayToolTrace[] =>
  sources.map((source, i) => ({
    step: 1,
    callId: `c${i}`,
    toolId: 'acme.tool',
    toolVersion: '1.0.0',
    arguments: {},
    source,
  }));

const answers: Record<string, EvalRunSubjectInvokeOutcome> = {
  'case-a': {
    output: turn('Found 2.', [{ id: 'm2' }, { id: 'm1' }, { id: 'm9' }]),
    runId: 'run-a' as RunId,
    provider: { id: 'p', model: 'm' },
    replay: { of: 'case-a' as RunId, evalRunId: 'eval-1', tools: trace('recorded', 'refused') },
  },
  'case-b': {
    output: turn('B changed.'),
    runId: 'run-b' as RunId,
    provider: { id: 'p', model: 'm' },
    replay: { of: 'case-b' as RunId, evalRunId: 'eval-1', tools: trace('live') },
  },
};

async function compare(options: {
  readonly comparison?: EvalComparison;
  readonly answer?: (input: EvalRunSubjectInvokeInput, call: number) => EvalRunSubjectInvokeOutcome;
  readonly dryRun?: boolean;
}) {
  const cases = inMemoryCaseStore();
  await cases.putCases({ tenantId, suiteId: 'acme.set', version: '1.0.0', cases: [caseA, caseB] });
  const invoked: EvalRunSubjectInvokeInput[] = [];
  const progress: unknown[] = [];
  const suite: EvalSuite = {
    id: 'acme.set',
    tenantId,
    version: '1.0.0',
    kind: 'judged',
    spec: { source: 'judgments', projectId: 'p-judged', caseCount: 2 },
  };
  const ctx: DispatchContext = {
    tenantId,
    runId: 'eval-1' as RunId,
    suite,
    target: { agentId: 'acme.agent' as never, version: '2.0.0' as never },
    dryRun: options.dryRun === true,
    abortSignal: new AbortController().signal,
    projectId: 'p-run' as ProjectId,
    ...(options.comparison !== undefined && { comparison: options.comparison }),
    subject: {
      invoke: async (input) => {
        invoked.push(input);
        const caseId = input.replay?.of as unknown as string;
        return (
          options.answer?.(input, invoked.length) ??
          (answers[caseId] as EvalRunSubjectInvokeOutcome)
        );
      },
    },
    onProgress: (entry) => progress.push(entry),
  };
  const out = await createJudgedDispatcher({ cases }).dispatch(ctx);
  const result = out.result as { summary: JudgedComparisonSummary; perCase: JudgedCaseResult[] };
  return { ...result, invoked, progress, error: out.error };
}

describe('a comparison eval run', () => {
  test('replays each case as the candidate, from its message and history', async () => {
    const { invoked } = await compare({});
    expect(invoked.map((i) => [i.input, i.replay, i.history, i.projectId])).toEqual([
      [
        'find acme',
        { of: 'case-a', evalRunId: 'eval-1' },
        [{ role: 'user', content: 'earlier' }],
        'p-run',
      ],
      ['find b', { of: 'case-b', evalRunId: 'eval-1' }, [], 'p-run'],
    ]);
    expect(invoked[0]?.target).toEqual({ agentId: 'acme.agent', version: '2.0.0' });
  });

  test('the summary: baseline beside candidate, with the evidence behind each', async () => {
    const { summary } = await compare({});
    expect(summary).toMatchObject({
      evalRunId: 'eval-1',
      status: 'completed',
      suite: { id: 'acme.set', version: '1.0.0' },
      candidate: { agentId: 'acme.agent', version: '2.0.0' },
      baseline: {
        kind: 'recorded',
        versions: [{ agentId: 'acme.agent', version: '1.0.0', cases: 2 }],
      },
      scope: { projectId: 'p-judged' },
      cases: 2,
      // Case B read live with no recording; case A's refused write isn't a divergence.
      diverged: 1,
      refusedWrites: 1,
      errors: 0,
      reads: 'recorded',
      repetitions: 1,
      sampling: { models: [{ providerId: 'p', model: 'm', runs: 2 }] },
    });
    const { weightedYesShare, judgedCoverage, weightedPrecisionAtK } = summary.metrics;
    // Baseline: A 3 of 4, B 0 of 1. Candidate: A the same answer and items (3 of 4); B's answer
    // changed, so it has no judged items.
    expect(weightedYesShare).toMatchObject({
      baseline: 0.6,
      candidate: 0.75,
      n: 1,
      weight: 4,
      baselineN: 2,
      baselineWeight: 5,
      direction: 'higher',
    });
    expect(weightedYesShare.delta).toBeCloseTo(0.15);
    // Baseline: every item judged. Candidate: 3 of A's 4 (m9 is new), none of B's 1.
    expect(judgedCoverage).toMatchObject({ baseline: 1, candidate: 0.6, n: 2, baselineN: 2 });
    // The ranked items: m1 (2/2) and m2 (0/1), in either order.
    expect(weightedPrecisionAtK).toMatchObject({ k: 10, n: 1, weight: 3, baselineN: 1 });
    expect(weightedPrecisionAtK.baseline).toBeCloseTo(2 / 3);
    expect(weightedPrecisionAtK.candidate).toBeCloseTo(2 / 3);
    expect(weightedPrecisionAtK.delta).toBeCloseTo(0);
    expect(weightedYesShare).not.toHaveProperty('spread');
  });

  test('k decides how far down the ranked items precision looks', async () => {
    const { summary } = await compare({ comparison: { ...DEFAULT_COMPARISON, k: 1 } });
    // First ranked: m1 (2/2) before, m2 (0/1) now.
    expect(summary.metrics.weightedPrecisionAtK).toMatchObject({
      k: 1,
      baseline: 1,
      candidate: 0,
      delta: -1,
    });
  });

  test('each case: its runs, the items kept, dropped and new, the tool calls, and flags', async () => {
    const { perCase, progress } = await compare({});
    expect(progress).toHaveLength(2);
    expect(perCase[0]).toMatchObject({
      caseId: 'case-a',
      runIds: ['run-a'],
      changes: {
        kept: [
          { key: 'answer' },
          { key: 'm2', rankBefore: 1, rank: 0 },
          { key: 'm1', rankBefore: 0, rank: 1 },
        ],
        dropped: [],
        new: [{ key: 'm9', rank: 2 }],
      },
      diverged: false,
      refusedWrites: 1,
      noContext: false,
      approvalSkipped: false,
    });
    expect(perCase[0]?.tools?.map((t) => t.source)).toEqual(['recorded', 'refused']);
    expect(perCase[1]).toMatchObject({
      caseId: 'case-b',
      changes: { kept: [], dropped: [{ key: 'answer' }], new: [{ key: 'answer' }] },
      diverged: true,
      noContext: true,
    });
  });

  test('with reads live, a live read is not a divergence', async () => {
    const { summary } = await compare({ comparison: { ...DEFAULT_COMPARISON, reads: 'live' } });
    expect(summary.diverged).toBe(0);
  });

  test('repetitions: each case runs that many times, and the spread shows', async () => {
    const { summary, invoked, perCase } = await compare({
      comparison: { ...DEFAULT_COMPARISON, repetitions: 2 },
      answer: (input, call) =>
        // The second pass over case A drops m1.
        call === 2 && input.replay?.of === ('case-a' as RunId)
          ? { ...answers['case-a'], output: turn('Found 2.', [{ id: 'm2' }]) }
          : (answers[input.replay?.of as unknown as string] as EvalRunSubjectInvokeOutcome),
    });
    expect(invoked).toHaveLength(4);
    expect(perCase[0]?.runIds).toEqual(['run-a', 'run-a']);
    // Pass 1: A 3/4 → 0.75. Pass 2: A answer 1/1 + m2 0/1 → 0.5.
    expect(summary.metrics.weightedYesShare.candidate).toBeCloseTo(0.625);
    expect(summary.metrics.weightedYesShare.spread).toBeCloseTo(0.25);
    expect(summary.repetitions).toBe(2);
  });

  test('a case none of whose runs worked is an error; some → partial, all → failed', async () => {
    const someFail = await compare({
      answer: (input) =>
        input.replay?.of === ('case-b' as RunId)
          ? { error: 'agent-not-found', runId: 'run-x' as RunId }
          : (answers['case-a'] as EvalRunSubjectInvokeOutcome),
    });
    expect(someFail.summary).toMatchObject({ status: 'partial', errors: 1, cases: 2 });
    expect(someFail.perCase[1]).toMatchObject({ error: 'agent-not-found', runIds: ['run-x'] });
    // Errored cases leave both sides: the baseline counts case A alone.
    expect(someFail.summary.metrics.weightedYesShare.baselineN).toBe(1);

    const allFail = await compare({
      answer: () => {
        throw new Error('boom');
      },
    });
    expect(allFail.summary).toMatchObject({ status: 'failed', errors: 2 });
    expect(allFail.perCase[0]?.error).toBe('boom');
  });

  test('a dry run counts the cases and runs nothing', async () => {
    const { invoked, ...out } = await compare({ dryRun: true });
    expect(invoked).toEqual([]);
    expect(out).toMatchObject({ dryRun: true, cases: 2 });
  });
});

describe('what a comparison takes', () => {
  const dispatcher = createJudgedDispatcher({ cases: inMemoryCaseStore() });
  const suite = { spec: { caseCount: 3 } } as unknown as EvalSuite;
  const agent = { agentId: 'acme.agent' as never, version: '2.0.0' as never };

  test.each([
    ['a flow', suite, { flowId: 'acme.flow' }, undefined, 'give `agentRef`'],
    ['no version', suite, { agentId: 'acme.agent' }, undefined, '`agentRef.version` is required'],
    [
      'a version baseline',
      suite,
      agent,
      { ...DEFAULT_COMPARISON, baseline: { agentId: 'acme.agent', version: '1.0.0' } },
      "Only `baseline: 'recorded'` runs today",
    ],
    ['an empty set', { spec: { caseCount: 0 } }, agent, undefined, 'no cases'],
  ])('%s is refused', (_name, s, target, comparison, message) => {
    const v = dispatcher.validate?.(s as never, target as never, comparison as never);
    expect(v?.kind).toBe('err');
    expect(v?.kind === 'err' && v.message).toContain(message);
  });

  test('a version of an agent, against the recording, is fine', () => {
    expect(dispatcher.validate?.(suite, agent)).toEqual({ kind: 'ok' });
  });
});

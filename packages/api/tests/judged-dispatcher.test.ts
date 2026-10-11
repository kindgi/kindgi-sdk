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
  JudgedDispatcherOptions,
  JudgedEvalCase,
} from '../src/index.js';
import { DEFAULT_COMPARISON, RESCORE_UNSUPPORTED, createJudgedDispatcher } from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';
import { inMemoryJudgments } from './support/in-memory-judgments.js';
import { validateAgainst } from './support/openapi-schema.js';

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
  readonly agents?: JudgedDispatcherOptions['agents'];
  readonly answer?: (input: EvalRunSubjectInvokeInput, call: number) => EvalRunSubjectInvokeOutcome;
  readonly dryRun?: boolean;
  readonly cases?: readonly JudgedEvalCase[];
}) {
  const cases = inMemoryCaseStore();
  await cases.putCases({
    tenantId,
    suiteId: 'acme.set',
    version: '1.0.0',
    cases: options.cases ?? [caseA, caseB],
  });
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
  const out = await createJudgedDispatcher({
    cases,
    ...(options.agents !== undefined && { agents: options.agents }),
  }).dispatch(ctx);
  const result = out.result as { summary: JudgedComparisonSummary; perCase: JudgedCaseResult[] };
  return { ...result, invoked, progress, error: out.error };
}

/** A result as it reaches the wire, against the schema the clients read it as. */
const wireErrors = (result: { summary: unknown; perCase: unknown }) =>
  validateAgainst(
    'JudgedComparisonResult',
    JSON.parse(JSON.stringify({ summary: result.summary, perCase: result.perCase })),
  );

describe('a comparison eval run', () => {
  test('its result is the OpenAPI JudgedComparisonResult: what the clients read it as', async () => {
    const { summary, perCase } = await compare({
      comparison: { ...DEFAULT_COMPARISON, repetitions: 2 },
      answer: (input, call) =>
        call === 1
          ? { error: 'no model' }
          : (answers[input.replay?.of as unknown as string] as EvalRunSubjectInvokeOutcome),
    });
    expect(wireErrors({ summary, perCase })).toEqual([]);
    // The schema is closed: a field it doesn't name fails it.
    expect(wireErrors({ summary: { ...summary, extra: 1 }, perCase })).not.toEqual([]);
  });

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

  test('a recomputed call (other settings, a tool that reads from nowhere) is not a divergence', async () => {
    const recomputed = (input: EvalRunSubjectInvokeInput): EvalRunSubjectInvokeOutcome => {
      const outcome = answers[input.replay?.of as unknown as string] as EvalRunSubjectInvokeOutcome;
      if (input.replay?.of !== ('case-b' as RunId) || outcome.replay === undefined) return outcome;
      const tools = outcome.replay.tools.map((t) => ({ ...t, recomputed: true as const }));
      return { ...outcome, replay: { ...outcome.replay, tools } };
    };
    const { summary, perCase } = await compare({ answer: (input) => recomputed(input) });
    expect(summary.diverged).toBe(0);
    expect(perCase[1]?.tools?.[0]).toMatchObject({ source: 'live', recomputed: true });
    expect(wireErrors({ summary, perCase })).toEqual([]);
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

  test("the candidate's pinsDigest, read from the registry, for the gate", async () => {
    const asked: unknown[] = [];
    const { summary } = await compare({
      agents: {
        getVersion: async (input) => {
          asked.push(input);
          return { id: 'acme.agent', version: '2.0.0', pinsDigest: 'sha-200' } as never;
        },
      },
    });
    expect(summary.candidate).toEqual({
      kind: 'agent',
      agentId: 'acme.agent',
      version: '2.0.0',
      pinsDigest: 'sha-200',
    });
    expect(asked).toEqual([{ tenantId, agentId: 'acme.agent', version: '2.0.0' }]);
  });

  test('without a registry, or for a version published before pins: no pinsDigest', async () => {
    expect((await compare({})).summary.candidate).toEqual({
      kind: 'agent',
      agentId: 'acme.agent',
      version: '2.0.0',
    });
    const unpinned = await compare({
      agents: { getVersion: async () => ({ id: 'acme.agent', version: '2.0.0' }) as never },
    });
    expect(unpinned.summary.candidate).not.toHaveProperty('pinsDigest');
    expect(wireErrors(unpinned)).toEqual([]);
  });

  test('a dry run counts the cases and runs nothing', async () => {
    const { invoked, ...out } = await compare({ dryRun: true });
    expect(invoked).toEqual([]);
    expect(out).toMatchObject({ dryRun: true, cases: 2 });
  });
});

describe('an erased case (T273 M-5)', () => {
  const erasedB: JudgedEvalCase = {
    caseId: 'case-b',
    subject: caseB.subject,
    input: null,
    output: null,
    items: [],
    erased: true,
  };

  test('is left out of the run and the metrics, and counted; the result is still the wire schema', async () => {
    const { invoked, summary, perCase } = await compare({ cases: [caseA, erasedB] });
    expect(invoked.map((i) => i.replay?.of)).toEqual(['case-a']);
    expect(perCase.map((c) => c.caseId)).toEqual(['case-a']);
    expect(summary).toMatchObject({ cases: 1, erased: 1 });
    expect(wireErrors({ summary, perCase })).toEqual([]);
  });

  test('a dry run counts it too; with none erased, no count', async () => {
    const dry = await compare({ cases: [caseA, erasedB], dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, cases: 1, erased: 1 });
    const { summary } = await compare({});
    expect(summary.erased).toBeUndefined();
  });

  test('erased after it was listed (the runtime refuses its replay): left out and counted, never an error', async () => {
    const { invoked, summary, perCase } = await compare({
      answer: (input) =>
        (input.replay?.of as unknown as string) === 'case-b'
          ? { erased: true, durationMs: 3 }
          : (answers['case-a'] as EvalRunSubjectInvokeOutcome),
    });
    expect(invoked.map((i) => i.replay?.of)).toEqual(['case-a', 'case-b']);
    expect(perCase.map((c) => c.caseId)).toEqual(['case-a']);
    expect(summary).toMatchObject({ cases: 1, erased: 1, errors: 0, status: 'completed' });
    expect(wireErrors({ summary, perCase })).toEqual([]);
  });
});

describe('classWeights (T200)', () => {
  /** Case A judged by a restricted class on its answer and m2 only; case B by none. */
  const restricted = (yesWeight: number, totalWeight: number) => ({
    restricted: { yesWeight, totalWeight },
  });
  const caseARestricted: JudgedEvalCase = {
    ...caseA,
    items: [
      item('answer', 1, 1, { pointer: '/appended/3/content', ...restricted(1, 1) }),
      item('m1', 2, 2, { pointer: '/output/matches/0', rank: 0, ...restricted(0, 0) }),
      item('m2', 0, 1, { pointer: '/output/matches/1', rank: 1, ...restricted(0, 1) }),
    ],
  };

  test('as recorded by default, and the summary says so', async () => {
    const { summary } = await compare({ cases: [caseARestricted, caseB] });
    expect(summary.classWeights).toBe('as-recorded');
    expect(summary.metrics.weightedYesShare).toMatchObject({ baseline: 0.6, baselineWeight: 5 });
  });

  test('restricted-only counts only what restricted classes judged', async () => {
    const result = await compare({
      comparison: { ...DEFAULT_COMPARISON, classWeights: 'restricted-only' },
      cases: [caseARestricted, caseB],
    });
    expect(wireErrors(result)).toEqual([]);
    const { summary } = result;
    expect(summary.classWeights).toBe('restricted-only');
    // Baseline: A's answer (1 of 1) and m2 (0 of 1); m1 and all of B unjudged.
    expect(summary.metrics.weightedYesShare).toMatchObject({
      baseline: 0.5,
      baselineN: 1,
      baselineWeight: 2,
    });
    // Coverage: A has 2 of its 3 items judged, B none of its 1.
    expect(summary.metrics.judgedCoverage.baseline).toBeCloseTo(0.5);
  });
});

describe('what a comparison takes', () => {
  const dispatcher = createJudgedDispatcher({ cases: inMemoryCaseStore() });
  const suite = { spec: { caseCount: 3 } } as unknown as EvalSuite;
  const agent = { agentId: 'acme.agent' as never, version: '2.0.0' as never };

  test.each([
    [
      'a flow without a version',
      suite,
      { flowId: 'acme.flow' },
      undefined,
      '`flowRef.version` is required',
    ],
    ['no version', suite, { agentId: 'acme.agent' }, undefined, '`agentRef.version` is required'],
    [
      'a version baseline',
      suite,
      agent,
      { ...DEFAULT_COMPARISON, baseline: { agentId: 'acme.agent', version: '1.0.0' } },
      "Only `baseline: 'recorded'` runs today",
    ],
    ['an empty set', { spec: { caseCount: 0 } }, agent, undefined, 'no cases'],
    [
      'versions for an agent',
      suite,
      agent,
      { ...DEFAULT_COMPARISON, versions: { agents: { 'acme.helper': '1.0.0' } } },
      'it needs `flowRef`',
    ],
  ])('%s is refused', (_name, s, target, comparison, message) => {
    const v = dispatcher.validate?.(s as never, target as never, comparison as never);
    expect(v?.kind).toBe('err');
    expect(v?.kind === 'err' && v.message).toContain(message);
  });

  test('a version of an agent, against the recording, is fine', () => {
    expect(dispatcher.validate?.(suite, agent)).toEqual({ kind: 'ok' });
  });
});

describe('a comparison of a flow version', () => {
  const flowOutput = (matches: unknown[]) => ({ matches });
  const flowCase = (caseId: string, matches: unknown[]): JudgedEvalCase => ({
    caseId,
    subject: { kind: 'flow', id: 'acme.intake', version: '1.0.0' },
    input: { ticket: caseId },
    output: flowOutput(matches),
    items: [
      {
        key: 'm1',
        pointer: '/matches/0',
        rank: 0,
        yes: 1,
        no: 0,
        yesWeight: 1,
        totalWeight: 1,
        reasons: [],
      },
      {
        key: 'm2',
        pointer: '/matches/1',
        rank: 1,
        yes: 0,
        no: 1,
        yesWeight: 0,
        totalWeight: 1,
        reasons: [],
      },
    ],
  });

  async function compareFlow(answer: (caseId: string) => EvalRunSubjectInvokeOutcome) {
    const cases = inMemoryCaseStore();
    await cases.putCases({
      tenantId,
      suiteId: 'acme.flows',
      version: '1.0.0',
      cases: [
        flowCase('run-f1', [{ id: 'm1' }, { id: 'm2' }]),
        flowCase('run-f2', [{ id: 'm1' }, { id: 'm2' }]),
      ],
    });
    const invoked: EvalRunSubjectInvokeInput[] = [];
    const out = await createJudgedDispatcher({ cases }).dispatch({
      tenantId,
      runId: 'eval-f' as RunId,
      suite: {
        id: 'acme.flows',
        tenantId,
        version: '1.0.0',
        kind: 'judged',
        spec: { caseCount: 2 },
      },
      target: { flowId: 'acme.intake' as never, version: '1.1.0' as never },
      dryRun: false,
      abortSignal: new AbortController().signal,
      subject: {
        invoke: async (input) => {
          invoked.push(input);
          return answer(input.replay?.of as unknown as string);
        },
      },
      onProgress: () => {},
    });
    const result = out.result as { summary: JudgedComparisonSummary; perCase: JudgedCaseResult[] };
    return { ...result, invoked };
  }

  const refusedSend = {
    step: 0,
    callId: 'notify',
    toolId: 'acme.send',
    toolVersion: '1.0.0',
    arguments: { to: 'desk' },
    source: 'refused' as const,
    reason: 'replay: this call changes things and has no recorded result',
  };

  test("replays each case with the flow's input and no history; scores the whole output's items", async () => {
    const { summary, invoked } = await compareFlow(() => ({
      output: flowOutput([{ id: 'm2' }, { id: 'm1' }]),
      runId: 'run-x' as RunId,
    }));
    expect(invoked[0]?.input).toEqual({ ticket: 'run-f1' });
    expect(invoked[0]?.target).toEqual({ flowId: 'acme.intake', version: '1.1.0' });
    expect(invoked[0]).not.toHaveProperty('history');
    expect(summary.candidate).toEqual({ kind: 'flow', flowId: 'acme.intake', version: '1.1.0' });
    expect(summary.baseline).toEqual({
      kind: 'recorded',
      versions: [{ flowId: 'acme.intake', version: '1.0.0', cases: 2 }],
    });
    // Same items, reordered: m1 (1/1) and m2 (0/1) in both.
    expect(summary.metrics.weightedYesShare).toMatchObject({ baseline: 0.5, candidate: 0.5, n: 2 });
    expect(summary.metrics.weightedPrecisionAtK.candidate).toBeCloseTo(0.5);
  });

  test("a flow comparison's result, with a stopped case, is the OpenAPI JudgedComparisonResult", async () => {
    const result = await compareFlow((caseId) =>
      caseId === 'run-f2'
        ? {
            runId: 'run-stop' as RunId,
            stopped: { toolId: 'acme.send', arguments: { to: 'desk' }, reason: refusedSend.reason },
            replay: { of: 'run-f2' as RunId, evalRunId: 'eval-f', tools: [refusedSend] },
          }
        : { output: flowOutput([{ id: 'm1' }]), runId: 'run-ok' as RunId },
    );
    expect(wireErrors(result)).toEqual([]);
  });

  test('a case that stopped at a refused write: counted, with what it would have done, and left out of the metrics', async () => {
    const { summary, perCase } = await compareFlow((caseId) =>
      caseId === 'run-f2'
        ? {
            runId: 'run-stop' as RunId,
            stopped: { toolId: 'acme.send', arguments: { to: 'desk' }, reason: refusedSend.reason },
            replay: { of: 'run-f2' as RunId, evalRunId: 'eval-f', tools: [refusedSend] },
          }
        : { output: flowOutput([{ id: 'm1' }]), runId: 'run-ok' as RunId },
    );
    expect(summary).toMatchObject({
      status: 'completed',
      cases: 2,
      stopped: 1,
      errors: 0,
      refusedWrites: 1,
      diverged: 0,
    });
    // Only run-f1 counts, on both sides: m1 kept (1/1).
    expect(summary.metrics.weightedYesShare).toMatchObject({
      baseline: 0.5,
      candidate: 1,
      n: 1,
      baselineN: 1,
    });
    expect(perCase[1]).toMatchObject({
      caseId: 'run-f2',
      runIds: ['run-stop'],
      stopped: { toolId: 'acme.send', arguments: { to: 'desk' } },
      refusedWrites: 1,
      tools: [refusedSend],
    });
    expect(perCase[1]).not.toHaveProperty('error');
  });

  test('stopping is not an error: all stopped is still completed, all errored is failed', async () => {
    const stoppedAll = await compareFlow(() => ({
      stopped: { toolId: 'acme.send', arguments: {} },
      replay: { of: 'x' as RunId, evalRunId: 'eval-f', tools: [refusedSend] },
    }));
    expect(stoppedAll.summary).toMatchObject({ status: 'completed', stopped: 2, errors: 0 });
    expect(stoppedAll.summary.metrics.weightedYesShare).toMatchObject({ candidate: null, n: 0 });
    const erroredAll = await compareFlow(() => ({ error: 'flow-not-found: no such version' }));
    expect(erroredAll.summary).toMatchObject({ status: 'failed', stopped: 0, errors: 2 });
  });
});

describe('a rescore: the replays scored again, with what people judged on them since', () => {
  /**
   * A first comparison (eval-1), then a rescore of it (eval-2), with
   * `judge` recording judgments on the first comparison's replays in
   * between. `gone` lists replay runs that can't be read again.
   */
  async function rescoreAfter(
    judge: (j: ReturnType<typeof inMemoryJudgments>) => Promise<void>,
    options: { classWeights?: 'restricted-only'; gone?: readonly string[] } = {},
  ) {
    const comparison: EvalComparison = {
      ...DEFAULT_COMPARISON,
      ...(options.classWeights !== undefined && { classWeights: options.classWeights }),
    };
    const first = await compare({ comparison });
    const judgments = inMemoryJudgments();
    await judge(judgments);
    const cases = inMemoryCaseStore();
    await cases.putCases({
      tenantId,
      suiteId: 'acme.set',
      version: '1.0.0',
      cases: [caseA, caseB],
    });
    const outputs: Record<string, unknown> = {
      'run-a': answers['case-a']?.output,
      'run-b': answers['case-b']?.output,
    };
    const invoked: unknown[] = [];
    const ctx: DispatchContext = {
      tenantId,
      runId: 'eval-2' as RunId,
      suite: {
        id: 'acme.set',
        tenantId,
        version: '1.0.0',
        kind: 'judged',
        spec: { source: 'judgments', projectId: 'p-judged', caseCount: 2 },
      },
      target: { agentId: 'acme.agent' as never, version: '2.0.0' as never },
      dryRun: false,
      abortSignal: new AbortController().signal,
      projectId: 'p-run' as ProjectId,
      comparison: { ...comparison, rescoreOf: 'eval-1' },
      subject: {
        invoke: async (input) => {
          invoked.push(input);
          return { error: 'a rescore never replays' };
        },
      },
      onProgress: () => undefined,
    };
    const dispatcher = createJudgedDispatcher({
      cases,
      judgments,
      evalRuns: {
        get: async () => ({
          runId: 'eval-1' as RunId,
          tenantId,
          suiteId: 'acme.set',
          suiteVersion: '1.0.0',
          kind: 'judged',
          status: 'completed',
          dryRun: false,
          startedAt: '2026-10-09T00:00:00.000Z' as never,
          result: { summary: first.summary, perCase: first.perCase },
        }),
      },
      runs: {
        getRun: async (_t, runId) =>
          options.gone?.includes(runId as unknown as string) === true
            ? null
            : { output: outputs[runId as unknown as string] },
      },
    });
    const out = await dispatcher.dispatch(ctx);
    const result = out.result as { summary: JudgedComparisonSummary; perCase: JudgedCaseResult[] };
    return { first, ...result, invoked, error: out.error };
  }

  const judgeAnswer =
    (verdict: 'yes' | 'no', extra: object = {}) =>
    async (j: ReturnType<typeof inMemoryJudgments>) => {
      await j.record({
        tenantId,
        projectId: 'p-run' as ProjectId,
        runId: 'run-b',
        run: {
          subject: { kind: 'agent', id: 'acme.agent', version: '2.0.0' },
          input: 'find b',
          output: answers['case-b']?.output,
        },
        item: { key: 'answer', pointer: '/appended/3/content' },
        verdict,
        assertedBy: { kind: 'user', id: 'lead' },
        ...extra,
      });
    };

  test("a changed answer, judged on its replay, counts: no replay runs, and the evidence says it's fresh", async () => {
    const r = await rescoreAfter(judgeAnswer('yes'));
    expect(r.invoked).toEqual([]);
    expect(r.error).toBeUndefined();
    // Before: case-b's changed answer was a new item, with no evidence.
    const before = r.first.perCase.find((c) => c.caseId === 'case-b');
    expect(before?.candidate[0]?.judgedItems).toBe(0);
    const after = r.perCase.find((c) => c.caseId === 'case-b');
    expect(after?.candidate[0]).toMatchObject({
      judgedItems: 1,
      yesWeight: 1,
      totalWeight: 1,
      fresh: { yesWeight: 1, totalWeight: 1, items: 1 },
    });
    expect(after?.changes?.new).toEqual([
      { key: 'answer', pointer: '/appended/3/content', judged: { yesWeight: 1, totalWeight: 1 } },
    ]);
    expect(r.summary).toMatchObject({ rescoreOf: 'eval-1', cases: 2 });
    expect(r.summary.metrics.weightedYesShare.freshWeight).toBe(1);
    expect(r.summary.metrics.weightedYesShare.candidate).not.toBe(
      r.first.summary.metrics.weightedYesShare.candidate,
    );
    expect(r.summary.metrics.weightedPrecisionAtK).not.toHaveProperty('freshWeight');
    expect(wireErrors(r)).toEqual([]);
  });

  test('with nothing judged since, a rescore scores as the run it rescores', async () => {
    const r = await rescoreAfter(async () => undefined);
    expect(r.summary.metrics).toEqual(r.first.summary.metrics);
    expect(r.perCase.map((c) => c.candidate)).toEqual(r.first.perCase.map((c) => c.candidate));
  });

  test('restricted-only: a fresh judgment counts only if its class was restricted', async () => {
    const unrestricted = await rescoreAfter(judgeAnswer('yes'), {
      classWeights: 'restricted-only',
    });
    expect(
      unrestricted.perCase.find((c) => c.caseId === 'case-b')?.candidate[0]?.fresh,
    ).toBeUndefined();
    const restricted = await rescoreAfter(judgeAnswer('yes', { restricted: true }), {
      classWeights: 'restricted-only',
    });
    expect(restricted.perCase.find((c) => c.caseId === 'case-b')?.candidate[0]?.fresh).toEqual({
      yesWeight: 1,
      totalWeight: 1,
      items: 1,
    });
  });

  test("a case whose replay can't be read again keeps its scores, and is counted", async () => {
    const r = await rescoreAfter(judgeAnswer('yes'), { gone: ['run-b'] });
    const b = r.perCase.find((c) => c.caseId === 'case-b');
    expect(b?.rescored).toBe(false);
    expect(b?.candidate).toEqual(r.first.perCase.find((c) => c.caseId === 'case-b')?.candidate);
    expect(r.summary.notRescored).toBe(1);
    expect(wireErrors(r)).toEqual([]);
  });

  test("a runtime that can't read replays and their judgments again refuses a rescore", () => {
    const plain = createJudgedDispatcher({ cases: inMemoryCaseStore() });
    const suite = { spec: { caseCount: 1 } } as unknown as EvalSuite;
    const target = { agentId: 'acme.agent', version: '2.0.0' } as never;
    expect(plain.validate?.(suite, target, { ...DEFAULT_COMPARISON, rescoreOf: 'eval-1' })).toEqual(
      {
        kind: 'err',
        message: RESCORE_UNSUPPORTED,
      },
    );
    expect(plain.validate?.(suite, target, DEFAULT_COMPARISON)).toEqual({ kind: 'ok' });
  });
});

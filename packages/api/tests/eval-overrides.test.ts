// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An improvement pass's comparisons: settings `overrides` (unpublished
 * values for blocks the candidate pins, checked when the run starts) and
 * a `sample` of the test set (a deterministic search / hold-out split).
 * Neither may gate a promotion except a hold-out sample.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, RunId, TenantId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { sampleCases } from '../src/eval-sample.js';
import type {
  AgentRegistryBinding,
  AgentVersionRecord,
  CorrectedComparisonSummary,
  CorrectedEvalCase,
  TestRun,
  TestRunBinding,
  GatePolicySpec,
  RunHandlerBinding,
  TestSet,
  TestSetRegistryBinding,
  TokenResolver,
} from '../src/index.js';
import {
  createApp,
  createCorrectedDispatcher,
  createInProcessTestRunBinding,
  evaluateGate,
} from '../src/index.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'eval-overrides-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const unused = async () => ({ kind: 'err' as const, error: { code: 'bad-input', message: 'x' } });
const runHandler = {
  invokeAgent: unused,
  invokeFlow: unused,
  resumeRun: unused,
} as unknown as RunHandlerBinding;
const CASES = Array.from({ length: 40 }, (_, i) => `case-${i}`);
const testSet: TestSet = {
  id: 'acme.set',
  tenantId,
  version: '1.0.0',
  kind: 'corrections',
  spec: { source: 'corrections', caseCount: CASES.length },
};

function correctedCase(caseId: string, no = false): CorrectedEvalCase {
  return {
    caseId,
    subject: { kind: 'agent', id: 'acme.agent', version: '1.0.0' },
    input: caseId,
    output: { appended: [{ role: 'agent', content: 'Hi.' }] },
    items: [
      {
        key: 'answer',
        pointer: '/appended/0/content',
        yes: no ? 0 : 1,
        no: no ? 1 : 0,
        yesWeight: no ? 0 : 1,
        totalWeight: 1,
        reasons: [],
      },
    ],
  } as CorrectedEvalCase;
}

describe('sampleCases', () => {
  const sample: { seed: string; holdOutShare: number } = { seed: 'pass-1', holdOutShare: 0.3 };
  const cases = [
    ...Array.from({ length: 10 }, (_, i) => correctedCase(`no-${i}`, true)),
    ...Array.from({ length: 30 }, (_, i) => correctedCase(`yes-${i}`)),
  ];
  const ids = (part: 'search' | 'hold-out', seed = sample.seed) =>
    sampleCases(cases, { ...sample, seed, part }).map((c) => c.caseId);

  test('splits by correction: about the share of the "no" cases and of the others, every case once', () => {
    const holdOut = ids('hold-out');
    const search = ids('search');
    expect(holdOut.length + search.length).toBe(cases.length);
    expect(holdOut.filter((id) => search.includes(id))).toEqual([]);
    expect(holdOut.filter((id) => id.startsWith('no-'))).toHaveLength(3);
    expect(holdOut.filter((id) => id.startsWith('yes-'))).toHaveLength(9);
  });

  test('the same seed splits the same way; another seed differently', () => {
    expect(ids('hold-out')).toEqual(ids('hold-out'));
    expect(ids('hold-out', 'pass-2')).not.toEqual(ids('hold-out'));
  });

  test('cases that carry a correction split on their own: two put one in each part, whatever the seed', () => {
    const corrected = (caseId: string, no = false): CorrectedEvalCase => ({
      ...correctedCase(caseId, no),
      corrections: [{ correctionId: `j-${caseId}`, calls: [] } as never],
    });
    const withTwo = [corrected('fix-1'), corrected('fix-2', true), ...cases];
    for (const seed of ['pass-1', 'pass-2', 'pass-3', 'pass-4', 'pass-5', 'pass-6']) {
      const holdOut = sampleCases(withTwo, { ...sample, seed, part: 'hold-out' }).map(
        (c) => c.caseId,
      );
      expect(
        holdOut.filter((id) => id.startsWith('fix-')),
        seed,
      ).toHaveLength(1);
      // The others still split by correction, as without them.
      expect(
        holdOut.filter((id) => id.startsWith('no-')),
        seed,
      ).toHaveLength(3);
    }
  });

  test('a stratum of two puts one in each part; a stratum of one stays in the search part', () => {
    const two = [correctedCase('a', true), correctedCase('b', true), correctedCase('c')];
    const holdOut = sampleCases(two, { ...sample, part: 'hold-out' }).map((c) => c.caseId);
    expect(holdOut.filter((id) => id !== 'c')).toHaveLength(1);
    expect(holdOut).not.toContain('c');
  });
});

async function setup() {
  const cases = inMemoryCaseStore();
  await cases.putCases({
    tenantId,
    testSetId: testSet.id,
    version: testSet.version,
    cases: CASES.map((caseId) => ({
      caseId,
      subject: { kind: 'agent', id: 'acme.agent', version: '1.0.0' },
      input: caseId,
      output: { appended: [{ role: 'agent', content: 'Hi.' }] },
      items: [
        {
          key: 'answer',
          pointer: '/appended/0/content',
          yes: 1,
          no: 0,
          yesWeight: 1,
          totalWeight: 1,
          reasons: [],
        },
      ],
    })),
  });
  const blocks = inMemoryBlocks([projectId]);
  await blocks.publish({
    tenantId,
    projectId,
    block: {
      id: 'acme.weights',
      version: '1.0.0',
      kind: 'settings',
      content: {
        values: { recency: 0.3 },
        schema: {
          type: 'object',
          properties: { recency: { type: 'number', minimum: 0, maximum: 1 } },
          required: ['recency'],
        },
      },
    },
  });
  await blocks.publish({
    tenantId,
    projectId,
    block: {
      id: 'acme.model',
      version: '1.0.0',
      kind: 'settings',
      content: { values: { temperature: 0.2 } },
    },
  });
  await blocks.publish({
    tenantId,
    projectId,
    block: {
      id: 'acme.prompt',
      version: '1.0.0',
      kind: 'prompt',
      content: {
        template: 'Rank for {{ firm }} with acme.rank.',
        parameters: [{ name: 'firm', type: 'string' }],
      },
    },
  });
  // 3.0.0 names its model itself; 2.0.0 leaves it to its model settings.
  const agents = {
    getVersion: async ({ version }: { version: string }) =>
      version === '2.0.0' || version === '3.0.0'
        ? ({
            id: 'acme.agent',
            version,
            modelSettings: { id: 'acme.model', version: '^1.0.0' },
            ...(version === '3.0.0' && { preferredModel: 'claude-sonnet-5-5' }),
            pins: {
              tools: { 'acme.rank': '1.0.0' },
              prompts: { 'acme.prompt': '1.0.0' },
              settings: { 'acme.weights': '1.0.0', 'acme.model': '1.0.0' },
            },
            pinsDigest: 'sha-2',
          } as unknown as AgentVersionRecord)
        : null,
  } as unknown as AgentRegistryBinding;
  const invoked: string[] = [];
  const registry = {
    get: async ({ testSetId }: { testSetId: string }) =>
      testSetId === testSet.id ? testSet : null,
  } as unknown as TestSetRegistryBinding;
  const binding = createInProcessTestRunBinding({
    testSetRegistry: registry,
    subject: {
      invoke: async (input) => {
        invoked.push(input.replay?.of as unknown as string);
        return {
          output: { appended: [{ role: 'agent', content: 'Hi.' }] },
          runId: randomUUID() as RunId,
        };
      },
    },
    dispatchers: { corrections: createCorrectedDispatcher({ cases, agents }) },
  });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    testSetRegistry: registry,
    testRunBinding: binding,
    agentRegistry: agents,
    blockRegistry: blocks,
  });
  const start = async (body: Record<string, unknown>) => {
    const res = await app.request(`/v1/test-sets/${testSet.id}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        agentRef: { agentId: 'acme.agent', version: '2.0.0' },
        ...body,
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { binding, start, invoked };
}

async function settled(binding: TestRunBinding, runId: string): Promise<TestRun> {
  for (let i = 0; i < 400; i++) {
    const run = await binding.get({ tenantId, testRunId: runId as RunId });
    if (run !== null && run.status !== 'running' && run.status !== 'pending') return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the run did not settle');
}

describe('settings overrides', () => {
  test('a comparison with overrides keeps them on the run and names the blocks on the candidate', async () => {
    const { binding, start } = await setup();
    const res = await start({ overrides: { settings: { 'acme.weights': { recency: 0.9 } } } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const run = await settled(binding, res.body.testRunId);
    expect(run.comparison?.overrides).toEqual({ settings: { 'acme.weights': { recency: 0.9 } } });
    const summary = (run.result?.summary ?? {}) as CorrectedComparisonSummary;
    expect(summary.candidate).toMatchObject({
      kind: 'agent',
      pinsDigest: 'sha-2',
      overrides: { settings: ['acme.weights'] },
    });
  });

  test.each([
    [{ 'acme.other': { x: 1 } }, "doesn't pin settings block"],
    [{ 'acme.weights': { recency: 2 } }, 'must be <= 1'],
  ])(
    'overrides that do not fit the version are refused (400 validation-failed)',
    async (settings, words) => {
      const { start } = await setup();
      const res = await start({ overrides: { settings } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation-failed');
      expect(JSON.stringify(res.body.error.details)).toContain(words);
    },
  );

  test('an override may name the model in the model settings, unless the agent names its own', async () => {
    const { start } = await setup();
    const settings = { 'acme.model': { model: 'claude-haiku-4-5', temperature: 0.2 } };
    expect((await start({ overrides: { settings } })).status).toBe(201);
    const res = await start({
      agentRef: { agentId: 'acme.agent', version: '3.0.0' },
      overrides: { settings },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toEqual([
      {
        path: '/overrides/settings/acme.model',
        message:
          'model-settings block "acme.model": it sets model, and the agent version sets preferredModel: name the model in one place, the block or the agent version',
      },
    ]);
  });

  test('a prompt template for the pinned prompt block runs; one that names what the agent lacks is refused', async () => {
    const { binding, start } = await setup();
    const ok = await start({
      overrides: {
        prompts: {
          'acme.prompt': { template: 'Rank for {{ firm }}, recent first, with acme.rank.' },
        },
      },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const run = await settled(binding, ok.body.testRunId);
    expect((run.result?.summary as CorrectedComparisonSummary).candidate).toMatchObject({
      overrides: { prompts: ['acme.prompt'] },
    });
    const bad = await start({
      overrides: {
        prompts: {
          'acme.prompt': {
            template: 'Rank for {{ firm }}, then call acme.export with {{ customer_list }}.',
          },
        },
      },
    });
    expect(bad.status).toBe(400);
    const details = JSON.stringify(bad.body.error.details);
    expect(details).toContain('acme.export');
    expect(details).toContain('customer_list');
    const unpinned = await start({ overrides: { prompts: { 'acme.other': { template: 'x' } } } });
    expect(unpinned.status).toBe(400);
  });

  test('malformed overrides, and overrides for a flow, are bad input', async () => {
    const { start } = await setup();
    expect((await start({ overrides: { settings: { 'acme.weights': 3 } } })).status).toBe(400);
    expect((await start({ overrides: { other: {} } })).status).toBe(400);
  });
});

describe('a sample of the test set', () => {
  test('replays only the cases of its part, and the summary says which', async () => {
    const { binding, start, invoked } = await setup();
    const sample = { part: 'hold-out', seed: 'pass-1', holdOutShare: 0.3 };
    const res = await start({ sample });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const run = await settled(binding, res.body.testRunId);
    const expected = sampleCases(
      CASES.map((id) => correctedCase(id)),
      sample as Parameters<typeof sampleCases>[1],
    ).map((c) => c.caseId);
    expect([...invoked].sort()).toEqual([...expected].sort());
    const summary = run.result?.summary as CorrectedComparisonSummary;
    expect(summary.cases).toBe(expected.length);
    expect(summary.sample).toEqual(sample);
  });

  test.each([
    [{ part: 'all', seed: 's', holdOutShare: 0.3 }],
    [{ part: 'search', seed: '', holdOutShare: 0.3 }],
    [{ part: 'search', seed: 's', holdOutShare: 0.95 }],
  ])('a malformed sample is bad input: %j', async (sample) => {
    const { start } = await setup();
    expect((await start({ sample })).status).toBe(400);
  });
});

describe('the gate', () => {
  const spec: GatePolicySpec = { metrics: [{ name: 'weightedYesShare', minCandidate: 0.5 }] };
  const m = {
    baseline: 0.5,
    candidate: 0.8,
    delta: 0.3,
    n: 10,
    weight: 10,
    baselineN: 10,
    baselineWeight: 10,
    direction: 'higher' as const,
  };
  const summary = (extra: Partial<CorrectedComparisonSummary>): CorrectedComparisonSummary => ({
    testRunId: 'er',
    status: 'completed',
    completedAt: new Date().toISOString(),
    testSet: { id: testSet.id, version: '1.0.0' },
    candidate: { kind: 'agent', agentId: 'acme.agent', version: '2.0.0', pinsDigest: 'sha-2' },
    baseline: {
      kind: 'recorded',
      versions: [{ agentId: 'acme.agent', version: '1.0.0', cases: 10 }],
    },
    scope: { projectId },
    cases: 10,
    diverged: 0,
    refusedWrites: 0,
    errors: 0,
    stopped: 0,
    reads: 'recorded',
    sampling: { models: [] },
    repetitions: 1,
    metrics: { weightedYesShare: m, judgedCoverage: m, weightedPrecisionAtK: { ...m, k: 10 } },
    ...extra,
  });
  const gate = (s: CorrectedComparisonSummary) =>
    evaluateGate({
      spec,
      promotion: {
        agentId: 'acme.agent',
        version: '2.0.0',
        pinsDigest: 'sha-2',
        scope: { kind: 'project', projectId },
      },
      summary: s,
      servingVersion: '1.0.0',
      now: new Date(),
    });
  const check = (s: CorrectedComparisonSummary, name: string) =>
    gate(s).checks.find((c) => c.name === name);

  test('a test run with overrides fails sameContents: try the published version', () => {
    const s = summary({
      candidate: {
        kind: 'agent',
        agentId: 'acme.agent',
        version: '2.0.0',
        pinsDigest: 'sha-2',
        overrides: { settings: ['acme.weights'] },
      },
    });
    expect(check(s, 'sameContents')).toMatchObject({ passed: false });
    expect(check(s, 'sameContents')?.message).toContain(
      'try the published version on the test cases',
    );
    expect(gate(s).passed).toBe(false);
    const prompts = summary({
      candidate: {
        kind: 'agent',
        agentId: 'acme.agent',
        version: '2.0.0',
        pinsDigest: 'sha-2',
        overrides: { prompts: ['acme.prompt'] },
      },
    });
    expect(check(prompts, 'sameContents')).toMatchObject({ passed: false });
    expect(check(prompts, 'sameContents')?.message).toContain('acme.prompt');
  });

  test('the search part fails comparison.sample; the hold-out part passes it; no sample, no check', () => {
    const search = summary({ sample: { part: 'search', seed: 's', holdOutShare: 0.3 } });
    expect(check(search, 'comparison.sample')).toMatchObject({ passed: false });
    expect(gate(search).passed).toBe(false);
    const holdOut = summary({ sample: { part: 'hold-out', seed: 's', holdOutShare: 0.3 } });
    expect(check(holdOut, 'comparison.sample')).toMatchObject({ passed: true });
    expect(gate(holdOut).passed).toBe(true);
    expect(check(summary({}), 'comparison.sample')).toBeUndefined();
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `POST /v1/eval-suites/{suiteId}/runs` for a test set: a comparison eval run. */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { RunId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import type {
  EvalRun,
  EvalRunBinding,
  EvalSuite,
  EvalSuiteRegistryBinding,
  JudgedComparisonSummary,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { createApp, createInProcessEvalRunBinding, createJudgedDispatcher } from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'eval-comparison-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const unused = async () => ({
  kind: 'err' as const,
  error: { code: 'bad-input', message: 'unused' },
});
const runHandler = {
  invokeAgent: unused,
  invokeFlow: unused,
  resumeRun: unused,
} as unknown as RunHandlerBinding;

const suite: EvalSuite = {
  id: 'acme.set',
  tenantId,
  version: '1.0.0',
  kind: 'judged',
  spec: { source: 'judgments', caseCount: 1 },
};

async function setup() {
  const cases = inMemoryCaseStore();
  await cases.putCases({
    tenantId,
    suiteId: suite.id,
    version: suite.version,
    cases: [
      {
        caseId: 'case-1',
        subject: { kind: 'agent', id: 'acme.agent', version: '1.0.0' },
        input: 'hello',
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
      },
    ],
  });
  const registry = {
    get: async ({ suiteId }: { suiteId: string }) => (suiteId === suite.id ? suite : null),
  } as unknown as EvalSuiteRegistryBinding;
  const binding = createInProcessEvalRunBinding({
    suiteRegistry: registry,
    subject: {
      invoke: async () => ({
        output: { appended: [{ role: 'agent', content: 'Hi.' }] },
        runId: 'replay-1' as RunId,
      }),
    },
    dispatchers: { judged: createJudgedDispatcher({ cases }) },
  });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    evalSuiteRegistry: registry,
    evalRunBinding: binding,
  });
  const start = (body: Record<string, unknown>) =>
    app.request(`/v1/eval-suites/${suite.id}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: randomUUID(),
        agentRef: { agentId: 'acme.agent', version: '2.0.0' },
        ...body,
      }),
    });
  return { app, binding, start };
}

async function settled(binding: EvalRunBinding, runId: string): Promise<EvalRun> {
  for (let i = 0; i < 200; i++) {
    const run = await binding.get({ tenantId, runId: runId as RunId });
    if (run !== null && run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the run did not settle');
}

describe('a comparison eval run over the API', () => {
  test('starts with its settings, keeps them on the run, and ends with the summary', async () => {
    const { app, binding, start } = await setup();
    const res = await start({ reads: 'live', repetitions: 2, k: 5 });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    const run = await settled(binding, runId);
    expect(run.status).toBe('completed');
    const summary = (run.result as { summary: JudgedComparisonSummary }).summary;
    expect(summary).toMatchObject({ status: 'completed', cases: 1, repetitions: 2, reads: 'live' });
    expect(summary.metrics.weightedYesShare).toMatchObject({ baseline: 1, candidate: 1, delta: 0 });

    const got = await app.request(`/v1/eval-runs/${runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await got.json()) as Record<string, unknown>).comparison).toEqual({
      baseline: 'recorded',
      reads: 'live',
      repetitions: 2,
      k: 5,
    });
  });

  test('without settings, the defaults run and nothing is recorded on the run', async () => {
    const { binding, start } = await setup();
    const { runId } = (await (await start({})).json()) as { runId: string };
    const run = await settled(binding, runId);
    expect(run.comparison).toBeUndefined();
    expect((run.result as { summary: JudgedComparisonSummary }).summary).toMatchObject({
      reads: 'recorded',
      repetitions: 1,
    });
  });

  test.each([
    [{ reads: 'sometimes' }, "`reads` must be 'recorded' or 'live'"],
    [{ repetitions: 0 }, '`repetitions` must be an integer from 1 to 10'],
    [{ repetitions: 11 }, '`repetitions` must be an integer from 1 to 10'],
    [{ k: 1.5 }, '`k` must be an integer from 1 to 100'],
    [{ baseline: 'yesterday' }, '`baseline` must be'],
    [{ baseline: { agentId: 'acme.agent' } }, 'needs `agentId` and `version`'],
    [{ baseline: { live: { segments: { tier: 1 } } } }, 'must be an object of strings'],
  ])('%j → 400', async (body, message) => {
    const { start } = await setup();
    const res = await start(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(message);
  });

  test('a baseline that is not the recording is refused when the run starts', async () => {
    const { start } = await setup();
    for (const baseline of [
      { agentId: 'acme.agent', version: '1.0.0' },
      { live: { projectId: 'p-1', segments: { tier: 'gold' } } },
    ]) {
      const res = await start({ baseline });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("Only `baseline: 'recorded'` runs today");
    }
  });

  test('a candidate without a version is refused', async () => {
    const { start } = await setup();
    const res = await start({ agentRef: { agentId: 'acme.agent' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('`agentRef.version` is required');
  });
});

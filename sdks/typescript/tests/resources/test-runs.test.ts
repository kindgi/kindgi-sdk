// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { type TestRunRecord, comparisonOf, createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_TEST_RUN = {
  runId: '00000000-0000-4000-8000-00000000e001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  testSetId: 'testSet.x',
  testSetVersion: '1.0.0',
  kind: 'accuracy',
  agentRef: { agentId: 'acme.drafter', version: '1.0.0' },
  status: 'running',
  dryRun: false,
  startedAt: '2026-09-24T00:00:00Z',
};

describe('test-runs — wire round-trips', () => {
  it('start + list + get + cancel hit the right endpoints', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ runId: SAMPLE_TEST_RUN.runId }) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_TEST_RUN], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_TEST_RUN) },
      { status: 200, body: JSON.stringify(SAMPLE_TEST_RUN) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.testRuns.start(
      'testSet.x',
      { agentRef: SAMPLE_TEST_RUN.agentRef },
      { projectId: 'proj-1', idempotencyKey: 'idem-run' },
    );
    await client.testRuns.list({ testSetId: 'testSet.x', status: 'running' });
    await client.testRuns.get(SAMPLE_TEST_RUN.runId);
    await client.testRuns.cancel(SAMPLE_TEST_RUN.runId);
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/test-sets/testSet.x/runs',
      'GET /v1/test-runs',
      `GET /v1/test-runs/${SAMPLE_TEST_RUN.runId}`,
      `POST /v1/test-runs/${SAMPLE_TEST_RUN.runId}/cancel`,
    ]);
    expect(stub.calls[0]?.headers['idempotency-key']).toBe('idem-run');
  });
});

describe('testRuns.start — projectId (POST /v1/test-sets/:testSetId/runs requires it)', () => {
  it('sends options.projectId in the body next to the run fields', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ runId: '00000000-0000-4000-8000-00000000e001' }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const input = { agentRef: { agentId: 'acme.drafter', version: '1.0.0' }, dryRun: true };

    await client.testRuns.start('testSet.x', input, {
      projectId: 'proj-1',
      idempotencyKey: 'idem-run',
    });

    const req = stub.calls[0]!;
    expect(`${req.method} ${new URL(req.url).pathname}`).toBe('POST /v1/test-sets/testSet.x/runs');
    expect(req.headers['idempotency-key']).toBe('idem-run');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ ...input, projectId: 'proj-1' });
  });
});

/** A comparison's result as the runtime returns it (fits the OpenAPI `CorrectedComparisonResult`). */
const COMPARISON_RESULT = {
  summary: {
    testRunId: 'er-1',
    status: 'completed',
    completedAt: '2026-10-06T08:00:00.000Z',
    testSet: {
      id: 'acme.set',
      version: '1.0.0',
    },
    candidate: {
      kind: 'flow',
      flowId: 'acme.intake',
      version: '1.1.0',
      versions: {
        agents: {
          'acme.drafter': '0.2.0',
        },
      },
    },
    baseline: {
      kind: 'recorded',
      versions: [
        {
          flowId: 'acme.intake',
          version: '1.0.0',
          cases: 2,
        },
      ],
    },
    scope: {
      projectId: 'p-1',
    },
    cases: 2,
    diverged: 0,
    refusedWrites: 1,
    errors: 0,
    stopped: 1,
    reads: 'recorded',
    sampling: {
      models: [
        {
          providerId: 'acme',
          model: 'm-1',
          runs: 1,
        },
      ],
    },
    repetitions: 1,
    metrics: {
      weightedYesShare: {
        baseline: 0.5,
        candidate: 0.75,
        delta: 0.25,
        n: 2,
        weight: 2,
        baselineN: 2,
        baselineWeight: 2,
        direction: 'higher',
      },
      judgedCoverage: {
        baseline: 1,
        candidate: 1,
        delta: 0,
        n: 2,
        weight: 2,
        baselineN: 2,
        baselineWeight: 2,
        direction: 'higher',
      },
      weightedPrecisionAtK: {
        baseline: 0.5,
        candidate: 0.75,
        delta: 0.25,
        n: 2,
        weight: 2,
        baselineN: 2,
        baselineWeight: 2,
        direction: 'higher',
        k: 10,
      },
    },
  },
  perCase: [
    {
      caseId: 'run-1',
      runIds: ['replay-1'],
      baseline: {
        yesWeight: 1,
        totalWeight: 2,
        items: 2,
        correctedItems: 2,
        topK: {
          yesWeight: 1,
          totalWeight: 2,
        },
      },
      candidate: [
        {
          yesWeight: 1.5,
          totalWeight: 2,
          items: 2,
          correctedItems: 2,
          topK: {
            yesWeight: 1.5,
            totalWeight: 2,
          },
        },
      ],
      changes: {
        kept: [
          {
            key: 'm1',
            rankBefore: 0,
            rank: 0,
          },
        ],
        dropped: [],
        new: [
          {
            key: 'm3',
            pointer: '/matches/1',
            rank: 1,
          },
        ],
      },
      tools: [
        {
          step: 0,
          callId: 'look',
          toolId: 'acme.lookup',
          toolVersion: '1.0.0',
          arguments: {
            q: 'x',
          },
          source: 'recorded',
        },
      ],
      diverged: false,
      refusedWrites: 0,
      noContext: false,
      approvalSkipped: false,
    },
    {
      caseId: 'run-2',
      runIds: ['replay-2'],
      baseline: {
        yesWeight: 0,
        totalWeight: 1,
        items: 1,
        correctedItems: 1,
        topK: {
          yesWeight: 0,
          totalWeight: 1,
        },
      },
      candidate: [],
      changes: {
        kept: [],
        dropped: [],
        new: [],
      },
      diverged: false,
      refusedWrites: 1,
      noContext: false,
      approvalSkipped: false,
      stopped: {
        toolId: 'acme.send',
        arguments: {
          to: 'desk',
        },
        reason: 'no recorded result',
      },
    },
  ],
};

describe('comparisonOf', () => {
  const judged = {
    ...SAMPLE_TEST_RUN,
    kind: 'corrections',
    status: 'completed',
    result: COMPARISON_RESULT,
  } as unknown as TestRunRecord;

  it("reads a comparison's result, typed", () => {
    const result = comparisonOf(judged);
    expect(result?.summary.metrics.weightedYesShare.delta).toBe(0.25);
    expect(result?.summary.candidate).toMatchObject({ kind: 'flow', flowId: 'acme.intake' });
    expect(result?.perCase[1]?.stopped?.toolId).toBe('acme.send');
  });

  it('is undefined for another kind of run, a dry run, or one not finished', () => {
    expect(comparisonOf({ ...SAMPLE_TEST_RUN } as unknown as TestRunRecord)).toBeUndefined();
    expect(
      comparisonOf({ ...judged, result: { dryRun: true, cases: 2 } } as unknown as TestRunRecord),
    ).toBeUndefined();
    const { result: _, ...running } = judged;
    expect(comparisonOf({ ...running, status: 'running' } as TestRunRecord)).toBeUndefined();
  });
});

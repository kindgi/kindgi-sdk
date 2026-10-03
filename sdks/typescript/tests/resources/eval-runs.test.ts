// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_EVAL_RUN = {
  runId: '00000000-0000-4000-8000-00000000e001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  suiteId: 'suite.x',
  suiteVersion: '1.0.0',
  kind: 'accuracy',
  agentRef: { agentId: 'acme.drafter', version: '1.0.0' },
  status: 'running',
  dryRun: false,
  startedAt: '2026-09-24T00:00:00Z',
};

describe('eval-runs — wire round-trips', () => {
  it('start + list + get + cancel hit the right endpoints', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ runId: SAMPLE_EVAL_RUN.runId }) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_EVAL_RUN], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_EVAL_RUN) },
      { status: 200, body: JSON.stringify(SAMPLE_EVAL_RUN) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.evalRuns.start(
      'suite.x',
      { agentRef: SAMPLE_EVAL_RUN.agentRef },
      { projectId: 'proj-1', idempotencyKey: 'idem-run' },
    );
    await client.evalRuns.list({ suiteId: 'suite.x', status: 'running' });
    await client.evalRuns.get(SAMPLE_EVAL_RUN.runId);
    await client.evalRuns.cancel(SAMPLE_EVAL_RUN.runId);
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/eval-suites/suite.x/runs',
      'GET /v1/eval-runs',
      `GET /v1/eval-runs/${SAMPLE_EVAL_RUN.runId}`,
      `POST /v1/eval-runs/${SAMPLE_EVAL_RUN.runId}/cancel`,
    ]);
    expect(stub.calls[0]?.headers['idempotency-key']).toBe('idem-run');
  });
});

describe('evalRuns.start — projectId (POST /v1/eval-suites/:suiteId/runs requires it)', () => {
  it('sends options.projectId in the body next to the run fields', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ runId: '00000000-0000-4000-8000-00000000e001' }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const input = { agentRef: { agentId: 'acme.drafter', version: '1.0.0' }, dryRun: true };

    await client.evalRuns.start('suite.x', input, {
      projectId: 'proj-1',
      idempotencyKey: 'idem-run',
    });

    const req = stub.calls[0]!;
    expect(`${req.method} ${new URL(req.url).pathname}`).toBe('POST /v1/eval-suites/suite.x/runs');
    expect(req.headers['idempotency-key']).toBe('idem-run');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ ...input, projectId: 'proj-1' });
  });
});

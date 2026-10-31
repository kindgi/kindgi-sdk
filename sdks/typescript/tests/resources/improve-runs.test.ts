// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { KindgiApiError, createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const PROJECT = '33333333-3333-4333-8333-333333333333';
const IMPROVE_RUN = {
  id: '22222222-2222-4222-8222-222222222222',
  agentId: 'acme.scorer',
  projectId: PROJECT,
  startsFrom: { version: '1.0.0', follows: 'pin' },
  setAside: { cases: 5, of: 27 },
  tiers: ['prompt', 'settings'],
  objective: 'passRate',
  groupWeights: 'experts-only',
  budget: { maxCostUsd: 5, maxCandidates: 30 },
  requestedBy: 'user:u1',
  status: 'running',
  tried: 0,
  costUsd: '0',
  takes: ['c-312', 'c-301'],
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};
const clientWith = (stub: { fetch: typeof fetch }) =>
  createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });

describe('Improve runs', () => {
  it('improveRuns.start POSTs the request and answers the Improve run', async () => {
    const stub = jsonFetch(IMPROVE_RUN, { status: 202 });
    const improveRun = await clientWith(stub).improveRuns.start({
      agentId: 'acme.scorer',
      projectId: PROJECT,
      budget: { maxCandidates: 10 },
      idempotencyKey: 'idem-2',
    });
    expect(improveRun.status).toBe('running');
    const req = stub.calls[0]!;
    expect(req.url).toBe('https://api.example.com/v1/improve-runs');
    expect(req.headers['idempotency-key']).toBe('idem-2');
    expect(JSON.parse(req.body!)).toEqual({
      agentId: 'acme.scorer',
      projectId: PROJECT,
      budget: { maxCandidates: 10 },
    });
  });

  it("a start that isn't ready is a conflict that lists every missing item", async () => {
    const items = [
      { key: 'wording', missing: true, fix: { where: 'repo', text: 'Move the wording.' } },
      { key: 'settings', missing: true, fix: { where: 'repo', text: 'Mark a setting.' } },
    ];
    const stub = errorFetch(409, {
      code: 'improve-not-ready',
      message: 'The Improve run is not ready.',
      details: { items },
    });
    const refused = await clientWith(stub)
      .improveRuns.start({ agentId: 'acme.scorer', projectId: PROJECT })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(KindgiApiError);
    expect((refused as KindgiApiError).error).toMatchObject({
      code: 'conflict',
      reason: 'improve-not-ready',
      serverCode: 'improve-not-ready',
      fields: { items },
    });
  });

  it('a start while one is running is a conflict that names the running Improve run', async () => {
    const stub = errorFetch(409, {
      code: 'improve-run-running',
      message: 'An Improve run of the agent in the project is still running.',
      details: { improveRunId: IMPROVE_RUN.id },
    });
    const refused = await clientWith(stub)
      .improveRuns.start({ agentId: 'acme.scorer', projectId: PROJECT })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(KindgiApiError);
    expect((refused as KindgiApiError).error).toMatchObject({
      code: 'conflict',
      reason: 'improve-run-running',
      serverCode: 'improve-run-running',
      fields: { improveRunId: IMPROVE_RUN.id },
    });
  });

  it('improveRuns.check POSTs the start body and answers the readiness and the estimate', async () => {
    const check = {
      ready: true,
      startsFrom: { version: '1.0.0', follows: 'pin' },
      items: [
        { key: 'wording', missing: false },
        { key: 'test-cases', missing: false, count: 9 },
      ],
      estimate: {
        costUsd: '1.90',
        maxCostUsd: '5',
        basis: { replays: 22, meanRunCostUsd: '0.086' },
      },
      month: { spentUsd: '12', capUsd: '50' },
    };
    const stub = jsonFetch(check);
    const answer = await clientWith(stub).improveRuns.check({
      agentId: 'acme.scorer',
      projectId: PROJECT,
      tiers: ['prompt'],
    });
    expect(answer).toEqual(check);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/improve-runs/check');
    expect(req.headers['idempotency-key']).toBeUndefined();
    expect(JSON.parse(req.body!)).toEqual({
      agentId: 'acme.scorer',
      projectId: PROJECT,
      tiers: ['prompt'],
    });
  });

  it('improveRuns.list, get and cancel', async () => {
    const list = jsonFetch({ data: [IMPROVE_RUN], hasMore: false });
    expect(
      (
        await clientWith(list).improveRuns.list({
          agentId: 'acme.scorer',
          projectId: PROJECT,
          status: 'completed',
        })
      ).data,
    ).toHaveLength(1);
    expect(list.calls[0]!.url).toBe(
      `https://api.example.com/v1/improve-runs?agentId=acme.scorer&projectId=${PROJECT}&status=completed`,
    );
    const get = jsonFetch(IMPROVE_RUN);
    expect((await clientWith(get).improveRuns.get(IMPROVE_RUN.id)).id).toBe(IMPROVE_RUN.id);
    expect(get.calls[0]!.url).toBe(`https://api.example.com/v1/improve-runs/${IMPROVE_RUN.id}`);
    const cancel = jsonFetch({ ...IMPROVE_RUN, status: 'cancelled' });
    expect((await clientWith(cancel).improveRuns.cancel(IMPROVE_RUN.id)).status).toBe('cancelled');
    expect(cancel.calls[0]!.method).toBe('POST');
    expect(cancel.calls[0]!.url).toBe(
      `https://api.example.com/v1/improve-runs/${IMPROVE_RUN.id}/cancel`,
    );
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const IMPROVE_RUN = {
  id: '22222222-2222-4222-8222-222222222222',
  agentId: 'acme.scorer',
  fromVersion: '1.0.0',
  scope: { kind: 'tenant' },
  testSetId: 'acme.scoring-judged',
  tiers: ['settings'],
  objective: 'weightedYesShare',
  budget: { maxCostUsd: 5, maxCandidates: 30 },
  requestedBy: 'user:u1',
  status: 'running',
  candidatesEvaluated: 0,
  costUsd: '0',
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
      scope: { kind: 'tenant' },
      testSetId: 'acme.scoring-judged',
      budget: { maxCandidates: 10 },
      idempotencyKey: 'idem-2',
    });
    expect(improveRun.status).toBe('running');
    const req = stub.calls[0]!;
    expect(req.url).toBe('https://api.example.com/v1/improve-runs');
    expect(req.headers['idempotency-key']).toBe('idem-2');
    expect(JSON.parse(req.body!)).toEqual({
      agentId: 'acme.scorer',
      scope: { kind: 'tenant' },
      testSetId: 'acme.scoring-judged',
      budget: { maxCandidates: 10 },
    });
  });

  it('improveRuns.list, get and cancel', async () => {
    const list = jsonFetch({ data: [IMPROVE_RUN], hasMore: false });
    expect((await clientWith(list).improveRuns.list({ agentId: 'acme.scorer' })).data).toHaveLength(
      1,
    );
    expect(list.calls[0]!.url).toBe('https://api.example.com/v1/improve-runs?agentId=acme.scorer');
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

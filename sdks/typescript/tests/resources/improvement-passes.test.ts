// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const PASS = {
  id: '22222222-2222-4222-8222-222222222222',
  agentId: 'acme.scorer',
  fromVersion: '1.0.0',
  scope: { kind: 'tenant' },
  suiteId: 'acme.scoring-judged',
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

describe('improvement passes', () => {
  it('proposals.improve POSTs the request and answers the pass', async () => {
    const stub = jsonFetch(PASS, { status: 202 });
    const pass = await clientWith(stub).proposals.improve({
      agentId: 'acme.scorer',
      scope: { kind: 'tenant' },
      suiteId: 'acme.scoring-judged',
      budget: { maxCandidates: 10 },
      idempotencyKey: 'idem-2',
    });
    expect(pass.status).toBe('running');
    const req = stub.calls[0]!;
    expect(req.url).toBe('https://api.example.com/v1/proposals/improve');
    expect(req.headers['idempotency-key']).toBe('idem-2');
    expect(JSON.parse(req.body!)).toEqual({
      agentId: 'acme.scorer',
      scope: { kind: 'tenant' },
      suiteId: 'acme.scoring-judged',
      budget: { maxCandidates: 10 },
    });
  });

  it('improvementPasses.list, get and cancel', async () => {
    const list = jsonFetch({ data: [PASS], hasMore: false });
    expect(
      (await clientWith(list).improvementPasses.list({ agentId: 'acme.scorer' })).data,
    ).toHaveLength(1);
    expect(list.calls[0]!.url).toBe(
      'https://api.example.com/v1/improvement-passes?agentId=acme.scorer',
    );
    const get = jsonFetch(PASS);
    expect((await clientWith(get).improvementPasses.get(PASS.id)).id).toBe(PASS.id);
    expect(get.calls[0]!.url).toBe(`https://api.example.com/v1/improvement-passes/${PASS.id}`);
    const cancel = jsonFetch({ ...PASS, status: 'cancelled' });
    expect((await clientWith(cancel).improvementPasses.cancel(PASS.id)).status).toBe('cancelled');
    expect(cancel.calls[0]!.method).toBe('POST');
    expect(cancel.calls[0]!.url).toBe(
      `https://api.example.com/v1/improvement-passes/${PASS.id}/cancel`,
    );
  });
});

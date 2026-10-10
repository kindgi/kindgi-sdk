// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const PROJECT = '00000000-0000-4000-8000-000000000003';
const ID = '11111111-1111-4111-8111-111111111111';

const WIRE_PROPOSAL = {
  id: ID,
  agentId: 'acme.scorer',
  fromVersion: '1.0.0',
  scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
  tier: 'settings-block',
  change: {
    blockId: 'acme.scoring-weights',
    fromVersion: '1.0.0',
    content: { values: { recency: 0.5, fit: 0.5 } },
  },
  hypothesis: 'Recent filings matter more for acme',
  drafter: { kind: 'person', by: 'user:u1' },
  status: 'draft',
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};

function clientWith(stub: { fetch: typeof fetch }) {
  return createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });
}

describe('client.proposals', () => {
  it('create POSTs the draft (no supervisor header) with its idempotency key', async () => {
    const stub = jsonFetch(WIRE_PROPOSAL, { status: 201 });
    const proposal = await clientWith(stub).proposals.create({
      agentId: 'acme.scorer',
      fromVersion: '1.0.0',
      scope: WIRE_PROPOSAL.scope as never,
      tier: 'settings-block',
      change: { blockId: 'acme.scoring-weights', content: { values: { recency: 0.5, fit: 0.5 } } },
      hypothesis: 'Recent filings matter more for acme',
      idempotencyKey: 'idem-1',
    });
    expect(proposal.status).toBe('draft');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/proposals');
    expect(req.headers['x-supervisor-id']).toBeUndefined();
    expect(req.headers['idempotency-key']).toBe('idem-1');
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ agentId: 'acme.scorer', tier: 'settings-block' });
    expect(body.idempotencyKey).toBeUndefined();
  });

  it('list sends its filters and answers a page', async () => {
    const stub = jsonFetch({ data: [WIRE_PROPOSAL], hasMore: false });
    const page = await clientWith(stub).proposals.list({
      agentId: 'acme.scorer',
      status: 'evaluated',
      tier: 'settings-block',
      limit: 5,
    });
    expect(page.data[0]?.id).toBe(ID);
    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe('/v1/proposals');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agentId: 'acme.scorer',
      status: 'evaluated',
      tier: 'settings-block',
      limit: '5',
    });
  });

  it('list sends a live scope as the promotions history takes it', async () => {
    const stub = jsonFetch({ data: [], hasMore: false });
    await clientWith(stub).proposals.list({ scope: WIRE_PROPOSAL.scope as never });
    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get('scopeKind')).toBe('segment');
    expect(url.searchParams.get('scopeId')).toBe(PROJECT);
    expect(url.searchParams.getAll('segment')).toEqual(['company:acme']);
  });

  it.each([
    ['evaluate', { suiteId: 'acme.scoring-judged', repetitions: 3 }],
    ['request', { reason: 'acme wants recency' }],
    ['rollback', { reason: 'acme complained' }],
    ['withdraw', { reason: 'wrong segment' }],
  ] as const)('%s POSTs to /v1/proposals/{id}/%s', async (action, input) => {
    const stub = jsonFetch(WIRE_PROPOSAL, { status: action === 'evaluate' ? 202 : 200 });
    const c = clientWith(stub);
    await (c.proposals[action] as (id: string, input: unknown) => Promise<unknown>)(ID, input);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.example.com/v1/proposals/${ID}/${action}`);
    expect(JSON.parse(req.body!)).toEqual(input);
  });

  it('get reads one; a gate refusal on request surfaces with its code', async () => {
    const got = jsonFetch(WIRE_PROPOSAL);
    expect((await clientWith(got).proposals.get(ID)).id).toBe(ID);
    expect(got.calls[0]!.url).toBe(`https://api.example.com/v1/proposals/${ID}`);

    const refused = errorFetch(422, {
      code: 'gate-failed',
      message: 'The gate refused acme.scorer 1.0.1',
      details: { proposalId: ID },
    });
    await expect(clientWith(refused).proposals.request(ID)).rejects.toMatchObject({
      error: { serverCode: 'gate-failed' },
    });
  });
});

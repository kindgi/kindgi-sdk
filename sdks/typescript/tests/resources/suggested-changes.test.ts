// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const PROJECT = '00000000-0000-4000-8000-000000000003';
const ID = '11111111-1111-4111-8111-111111111111';

const WIRE_SUGGESTED_CHANGE = {
  id: ID,
  agentId: 'acme.scorer',
  projectId: PROJECT,
  title: 'Recent filings matter more for acme: acme.scoring-weights v1.0.0 → v1.0.1',
  madeBy: { kind: 'person', userId: 'u1' },
  builtOn: { version: '1.0.0' },
  version: '1.0.1',
  changes: [{ kind: 'block', blockId: 'acme.scoring-weights', from: '1.0.0', to: '1.0.1' }],
  why: 'Recent filings matter more for acme',
  fixes: [],
  check: { status: 'running', testSetId: 'acme.scoring-judged' },
  status: 'checking',
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};

function clientWith(stub: { fetch: typeof fetch }) {
  return createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });
}

describe('client.suggestedChanges', () => {
  it('create POSTs the change (no supervisor header) with its idempotency key', async () => {
    const stub = jsonFetch(WIRE_SUGGESTED_CHANGE, { status: 201 });
    const suggestedChange = await clientWith(stub).suggestedChanges.create({
      agentId: 'acme.scorer',
      projectId: PROJECT,
      block: 'acme.scoring-weights',
      values: { recency: 0.5, fit: 0.5 },
      why: 'Recent filings matter more for acme',
      idempotencyKey: 'idem-1',
    });
    expect(suggestedChange.status).toBe('checking');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/suggested-changes');
    expect(req.headers['x-supervisor-id']).toBeUndefined();
    expect(req.headers['idempotency-key']).toBe('idem-1');
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body).toEqual({
      agentId: 'acme.scorer',
      projectId: PROJECT,
      block: 'acme.scoring-weights',
      values: { recency: 0.5, fit: 0.5 },
      why: 'Recent filings matter more for acme',
    });
  });

  it('list sends its filters and answers a page', async () => {
    const stub = jsonFetch({ data: [WIRE_SUGGESTED_CHANGE], hasMore: false });
    const page = await clientWith(stub).suggestedChanges.list({
      agentId: 'acme.scorer',
      projectId: PROJECT,
      status: 'ready',
      madeBy: 'improve-run',
      limit: 5,
    });
    expect(page.data[0]?.id).toBe(ID);
    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe('/v1/suggested-changes');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agentId: 'acme.scorer',
      projectId: PROJECT,
      status: 'ready',
      madeBy: 'improve-run',
      limit: '5',
    });
  });

  it('check POSTs an empty body to /v1/suggested-changes/{id}/check', async () => {
    const stub = jsonFetch(WIRE_SUGGESTED_CHANGE, { status: 202 });
    await clientWith(stub).suggestedChanges.check(ID, { idempotencyKey: 'idem-2' });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.example.com/v1/suggested-changes/${ID}/check`);
    expect(req.headers['idempotency-key']).toBe('idem-2');
    expect(JSON.parse(req.body!)).toEqual({});
  });

  it.each([
    ['pin', { reason: 'acme wants recency' }],
    ['withdraw', { reason: 'wrong block' }],
  ] as const)('%s POSTs to /v1/suggested-changes/{id}/%s', async (action, input) => {
    const stub = jsonFetch(WIRE_SUGGESTED_CHANGE);
    const c = clientWith(stub);
    await (c.suggestedChanges[action] as (id: string, input: unknown) => Promise<unknown>)(
      ID,
      input,
    );
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.example.com/v1/suggested-changes/${ID}/${action}`);
    expect(JSON.parse(req.body!)).toEqual(input);
  });

  it('addAsLatest POSTs to /v1/suggested-changes/{id}/add-as-latest, with its reason', async () => {
    const stub = jsonFetch(WIRE_SUGGESTED_CHANGE);
    await clientWith(stub).suggestedChanges.addAsLatest(ID, {
      reason: 'acme runs Latest',
      idempotencyKey: 'idem-3',
    });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.example.com/v1/suggested-changes/${ID}/add-as-latest`);
    expect(req.headers['idempotency-key']).toBe('idem-3');
    expect(JSON.parse(req.body!)).toEqual({ reason: 'acme runs Latest' });
  });

  it('get reads one; a gate refusal on pin surfaces with its code', async () => {
    const got = jsonFetch(WIRE_SUGGESTED_CHANGE);
    expect((await clientWith(got).suggestedChanges.get(ID)).id).toBe(ID);
    expect(got.calls[0]!.url).toBe(`https://api.example.com/v1/suggested-changes/${ID}`);

    const refused = errorFetch(422, {
      code: 'gate-failed',
      message: 'The release gate policy refused acme.scorer 1.0.1',
      details: { suggestedChangeId: ID },
    });
    await expect(clientWith(refused).suggestedChanges.pin(ID)).rejects.toMatchObject({
      error: { serverCode: 'gate-failed' },
    });
  });
});

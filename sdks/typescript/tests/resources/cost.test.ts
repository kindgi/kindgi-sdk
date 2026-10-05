// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_RECORD = {
  id: 'rec-1',
  tenantId: '00000000-0000-4000-8000-000000000002',
  category: 'llm.inference',
  quantity: 1200,
  unit: 'tokens',
  costUsd: 0.024,
  occurredAt: '2026-09-20T12:34:56Z',
};

describe('cost.usage.query', () => {
  it('GETs /v1/cost/records with filter params', async () => {
    const stub = jsonFetch({ data: [WIRE_RECORD], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.cost.usage.query({
      runId: 'r-1' as never,
      category: 'llm.inference',
      from: '2026-09-01T00:00:00Z' as never,
      to: '2026-09-30T23:59:59Z' as never,
      limit: 50,
    });

    expect(page.items[0]?.id).toBe('rec-1');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/cost/records');
    expect(url.searchParams.get('runId')).toBe('r-1');
    expect(url.searchParams.get('category')).toBe('llm.inference');
    expect(url.searchParams.get('from')).toBe('2026-09-01T00:00:00Z');
  });
});

describe('cost.usage.get', () => {
  it('GETs /v1/cost/records/{recordId}', async () => {
    const stub = jsonFetch(WIRE_RECORD);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const r = await client.cost.usage.get('rec-1');
    expect(r.category).toBe('llm.inference');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/cost/records/rec-1');
  });
});

describe('cost.usage.summary', () => {
  it('GETs /v1/cost/aggregate with groupBy joined', async () => {
    const stub = jsonFetch({
      groups: [
        {
          key: { agentId: 'a1' },
          count: 42,
          totalUsd: 1.23,
        },
      ],
      totalUsd: 1.23,
      totalRecords: 42,
      timeRange: {
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-30T23:59:59Z',
      },
      groupBy: ['agentId'],
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const agg = await client.cost.usage.summary({
      from: '2026-09-01T00:00:00Z' as never,
      to: '2026-09-30T23:59:59Z' as never,
      groupBy: ['agentId', 'category'],
    });

    expect(agg.totalUsd).toBe(1.23);
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/cost/aggregate');
    expect(url.searchParams.get('groupBy')).toBe('agentId,category');
  });

  it('maps 401 auth-missing to AuthError', async () => {
    const stub = errorFetch(401, { code: 'auth-missing', message: 'no token' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.cost.usage.summary({ from: 'x' as never, to: 'y' as never }),
    ).rejects.toMatchObject({
      error: { code: 'auth', reason: 'unauthenticated' },
    });
  });
});

describe('cost.budgets (not yet wired)', () => {
  it('get / set / getRemaining all throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.cost.budgets.get()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'cost.budgets.get' },
    });
    await expect(client.cost.budgets.set({ onExceed: 'halt' })).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'cost.budgets.set' },
    });
    await expect(client.cost.budgets.getRemaining()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'cost.budgets.getRemaining' },
    });
    expect(stub.calls.length).toBe(0);
  });
});

describe("cost: an org's spend, a run tree's calls, the vendor's own counts", () => {
  const client = (body: unknown) => {
    const stub = jsonFetch(body);
    return {
      stub,
      client: createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch }),
    };
  };
  const TOKENS = { prompt: 2400, completion: 160, cacheRead: 2000, cacheWrite: 200, reasoning: 60 };

  it("summary: one call sums an org's month by the model actually called, tokens included", async () => {
    const { stub, client: c } = client({
      groups: [
        {
          key: { month: '2026-10', model: 'claude-haiku-4-5' },
          count: 2,
          totalUsd: 0.004,
          tokens: TOKENS,
        },
      ],
      totalUsd: 0.004,
      totalRecords: 2,
      tokens: TOKENS,
      timeRange: { from: '2026-10-01T00:00:00Z', to: '2026-10-04T00:00:00Z' },
      groupBy: ['month', 'model'],
    });
    const result = await c.cost.usage.summary({
      scope: { kind: 'org', orgId: 'org-1' as never },
      from: '2026-10-01T00:00:00Z' as never,
      to: '2026-10-04T00:00:00Z' as never,
      groupBy: ['month', 'model'],
    });
    expect(result.tokens).toEqual(TOKENS);
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/cost/aggregate');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scopeKind: 'org',
      scopeId: 'org-1',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-04T00:00:00Z',
      groupBy: 'month,model',
    });
  });

  it("query: a run tree's model calls, by model; the vendor's own counts when asked", async () => {
    const tree = client({ data: [], hasMore: false });
    await tree.client.cost.usage.query({
      rootRunId: 'run-root' as never,
      model: 'claude-haiku-4-5',
      includeRawUsage: true,
    });
    const subtree = client({ data: [], hasMore: false });
    await subtree.client.cost.usage.query({ runId: 'run-mid' as never, includeDescendants: true });
    const params = (stub: typeof tree.stub) =>
      Object.fromEntries(new URL(stub.calls[0]?.url ?? '').searchParams);
    expect(params(tree.stub)).toEqual({
      rootRunId: 'run-root',
      model: 'claude-haiku-4-5',
      include: 'rawUsage',
    });
    expect(params(subtree.stub)).toEqual({ runId: 'run-mid', includeDescendants: 'true' });
  });

  it('get: the raw usage too, when asked', async () => {
    const { stub, client: c } = client(WIRE_RECORD);
    await c.cost.usage.get('rec-1', { includeRawUsage: true });
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/cost/records/rec-1?include=rawUsage',
    );
  });
});

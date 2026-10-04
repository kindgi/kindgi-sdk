// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  CostAggregateGroup,
  CostBinding,
  CostGroupDimension,
  CostListRecordsInput,
  CostRecord,
  CostTokenTotals,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Cost readback route tests. Uses an in-memory `CostBinding`
 * that stores plain `CostRecord` values and performs the aggregation
 * client-side so the routes' filter + groupBy semantics can be
 * exercised end-to-end without a real database.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'cost-token-abc';

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

function makeRecord(overrides: Partial<CostRecord> = {}): CostRecord {
  const occurredAt = overrides.occurredAt ?? ('2026-09-19T12:00:00.000Z' as Timestamp);
  return {
    id: overrides.id ?? randomUUID(),
    tenantId: overrides.tenantId ?? tenantId,
    category: overrides.category ?? 'llm.inference',
    ...(overrides.providerId !== undefined && { providerId: overrides.providerId }),
    ...(overrides.runId !== undefined && { runId: overrides.runId }),
    ...(overrides.agentId !== undefined && { agentId: overrides.agentId }),
    ...(overrides.conversationId !== undefined && { conversationId: overrides.conversationId }),
    quantity: overrides.quantity ?? 100,
    unit: overrides.unit ?? 'tokens',
    ...(overrides.costUsd !== undefined && { costUsd: overrides.costUsd }),
    occurredAt,
    ...(overrides.metrics !== undefined && { metrics: overrides.metrics }),
    ...(overrides.attributes !== undefined && { attributes: overrides.attributes }),
    ...overrides,
  };
}

const NO_TOKENS: CostTokenTotals = {
  prompt: 0,
  completion: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

function addTokens(t: CostTokenTotals, rec: CostRecord): CostTokenTotals {
  const u = rec.usage;
  if (u === undefined) return t;
  return {
    prompt: t.prompt + u.promptTokens,
    completion: t.completion + u.completionTokens,
    cacheRead: t.cacheRead + (u.cacheReadTokens ?? 0),
    cacheWrite: t.cacheWrite + (u.cacheWriteTokens ?? 0),
    reasoning: t.reasoning + (u.reasoningTokens ?? 0),
  };
}

function makeInMemoryBinding(
  seed: readonly CostRecord[] = [],
  seen: CostListRecordsInput[] = [],
): CostBinding {
  const store = [...seed];

  return {
    async listRecords(input) {
      seen.push(input);
      const { limit, cursor, filter } = input;
      let rows = store.filter((r) => {
        if (filter.runId !== undefined && r.runId !== filter.runId) return false;
        if (filter.agentId !== undefined && r.agentId !== filter.agentId) return false;
        if (filter.conversationId !== undefined && r.conversationId !== filter.conversationId) {
          return false;
        }
        if (filter.category !== undefined && r.category !== filter.category) return false;
        if (filter.providerId !== undefined && r.providerId !== filter.providerId) return false;
        if (filter.model !== undefined && r.model !== filter.model) return false;
        if (filter.rootRunId !== undefined && r.rootRunId !== filter.rootRunId) return false;
        if (filter.from !== undefined && new Date(r.occurredAt).getTime() < filter.from.getTime()) {
          return false;
        }
        if (filter.to !== undefined && new Date(r.occurredAt).getTime() > filter.to.getTime()) {
          return false;
        }
        return true;
      });
      // Fixed sort: occurredAt desc, id desc.
      rows = rows.slice().sort((a, b) => {
        const aTs = new Date(a.occurredAt).getTime();
        const bTs = new Date(b.occurredAt).getTime();
        if (aTs !== bTs) return bTs - aTs;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      let start = 0;
      if (cursor !== undefined) {
        const cur = cursor as unknown as string;
        const idx = rows.findIndex((r) => r.id === cur);
        start = idx < 0 ? rows.length : idx + 1;
      }
      const slice = rows.slice(start, start + limit);
      const hasMore = start + slice.length < rows.length;
      const last = slice[slice.length - 1];
      return {
        data: slice,
        ...(hasMore && last !== undefined && { nextCursor: last.id as unknown as Cursor }),
      };
    },
    async getRecord({ recordId }) {
      return store.find((r) => r.id === recordId) ?? null;
    },
    async aggregate({ groupBy, from, to, filter }) {
      const filtered = store.filter((r) => {
        const ts = new Date(r.occurredAt).getTime();
        if (ts < from.getTime() || ts > to.getTime()) return false;
        if (filter !== undefined) {
          if (filter.category !== undefined && r.category !== filter.category) return false;
          if (filter.providerId !== undefined && r.providerId !== filter.providerId) return false;
          if (filter.agentId !== undefined && r.agentId !== filter.agentId) return false;
          if (filter.runId !== undefined && r.runId !== filter.runId) return false;
          if (filter.conversationId !== undefined && r.conversationId !== filter.conversationId) {
            return false;
          }
        }
        return true;
      });

      const groups = new Map<string, CostAggregateGroup & { key: Record<string, string | null> }>();
      for (const rec of filtered) {
        const key: Record<string, string | null> = {};
        for (const dim of groupBy) {
          key[dim] = extractDim(rec, dim, tenantId);
        }
        const stableKey = JSON.stringify(
          Object.keys(key)
            .sort()
            .map((k) => [k, key[k]]),
        );
        const existing = groups.get(stableKey);
        if (existing === undefined) {
          groups.set(stableKey, {
            key,
            count: 1,
            totalUsd: rec.costUsd ?? 0,
            tokens: addTokens(NO_TOKENS, rec),
          });
        } else {
          groups.set(stableKey, {
            key,
            count: existing.count + 1,
            totalUsd: existing.totalUsd + (rec.costUsd ?? 0),
            tokens: addTokens(existing.tokens, rec),
          });
        }
      }

      const groupArr: CostAggregateGroup[] = [];
      let totalUsd = 0;
      let tokens = NO_TOKENS;
      for (const g of groups.values()) {
        groupArr.push({ key: g.key, count: g.count, totalUsd: g.totalUsd, tokens: g.tokens });
        totalUsd += g.totalUsd;
      }
      for (const rec of filtered) tokens = addTokens(tokens, rec);

      return {
        groups: groupArr,
        totalUsd,
        totalRecords: filtered.length,
        tokens,
        timeRange: {
          from: from.toISOString() as Timestamp,
          to: to.toISOString() as Timestamp,
        },
      };
    },
  };
}

function extractDim(
  rec: CostRecord,
  dim: CostGroupDimension,
  callerTenantId: string,
): string | null {
  switch (dim) {
    case 'agentId':
      return rec.agentId ?? null;
    case 'runId':
      return rec.runId ?? null;
    case 'category':
      return rec.category;
    case 'providerId':
      return rec.providerId ?? null;
    case 'conversationId':
      return rec.conversationId ?? null;
    case 'tenant':
      return callerTenantId;
    case 'day':
      return rec.occurredAt.slice(0, 10);
    case 'month':
      return rec.occurredAt.slice(0, 7);
    case 'model':
      return rec.model ?? null;
    case 'servedModel':
      return rec.servedModel ?? null;
    case 'projectId':
      return rec.projectId ?? null;
    case 'rootRunId':
      return rec.rootRunId ?? null;
    case 'flowId':
      return rec.flowId ?? null;
    default:
      return null;
  }
}

function makeApp(seed: readonly CostRecord[] = [], seen: CostListRecordsInput[] = []) {
  const binding = makeInMemoryBinding(seed, seen);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    cost: binding,
  });
  return { app, binding };
}

describe('API — cost records list', () => {
  test('empty tenant → empty list, hasMore=false', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/cost/records', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('time-window filter narrows results', async () => {
    const { app } = makeApp([
      makeRecord({
        id: 'r-old',
        occurredAt: '2026-09-01T10:00:00.000Z' as Timestamp,
        costUsd: 0.5,
      }),
      makeRecord({
        id: 'r-mid',
        occurredAt: '2026-09-15T10:00:00.000Z' as Timestamp,
        costUsd: 1,
      }),
      makeRecord({
        id: 'r-recent',
        occurredAt: '2026-09-19T10:00:00.000Z' as Timestamp,
        costUsd: 2,
      }),
    ]);
    const url = '/v1/cost/records?from=2026-09-14T00:00:00.000Z&to=2026-09-18T00:00:00.000Z';
    const res = await app.request(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((r) => r.id)).toEqual(['r-mid']);
  });

  test('category filter narrows results', async () => {
    const { app } = makeApp([
      makeRecord({ id: 'llm-1', category: 'llm.inference' }),
      makeRecord({ id: 'tool-1', category: 'tool.invocation' }),
      makeRecord({ id: 'sbx-1', category: 'sandbox.exec' }),
    ]);
    const res = await app.request('/v1/cost/records?category=tool.invocation', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; category: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.id).toBe('tool-1');
    expect(body.data[0]?.category).toBe('tool.invocation');
  });

  test('cursor pagination walks the set without dupes', async () => {
    const seed: CostRecord[] = [];
    for (let i = 0; i < 5; i += 1) {
      seed.push(
        makeRecord({
          id: `r-${i.toString().padStart(2, '0')}`,
          // Give each record a distinct occurredAt so ordering is deterministic.
          occurredAt: new Date(2026, 8, 19, 12, 0, i).toISOString() as Timestamp,
          costUsd: i,
        }),
      );
    }
    const { app } = makeApp(seed);
    const p1 = await app.request('/v1/cost/records?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const b1 = (await p1.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(b1.data).toHaveLength(2);
    expect(b1.hasMore).toBe(true);
    const p2 = await app.request(
      `/v1/cost/records?limit=2&cursor=${encodeURIComponent(b1.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const b2 = (await p2.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(b2.data).toHaveLength(2);
    expect(b2.hasMore).toBe(true);
    const p3 = await app.request(
      `/v1/cost/records?limit=2&cursor=${encodeURIComponent(b2.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const b3 = (await p3.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(b3.data).toHaveLength(1);
    expect(b3.hasMore).toBe(false);
    expect(b3.nextCursor).toBeUndefined();
    const seen = new Set([...b1.data, ...b2.data, ...b3.data].map((r) => r.id));
    expect(seen.size).toBe(5);
  });

  test('malformed `from` timestamp → 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/cost/records?from=not-a-date', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('`from` > `to` → 400', async () => {
    const { app } = makeApp();
    const res = await app.request(
      '/v1/cost/records?from=2026-09-19T00:00:00.000Z&to=2026-09-01T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(400);
  });
});

describe('API — cost records get', () => {
  test('known id → 200 with serialized record', async () => {
    const { app } = makeApp([
      makeRecord({
        id: 'rec-1',
        agentId: 'acme.drafting',
        runId: '00000000-0000-0000-0000-000000000001',
        costUsd: 1.23,
      }),
    ]);
    const res = await app.request('/v1/cost/records/rec-1', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      agentId: string;
      runId: string;
      costUsd: number;
    };
    expect(body.id).toBe('rec-1');
    expect(body.agentId).toBe('acme.drafting');
    expect(body.runId).toBe('00000000-0000-0000-0000-000000000001');
    expect(body.costUsd).toBe(1.23);
  });

  test('unknown id → 404 cost-record-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/cost/records/nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details?: { recordId: string } } };
    expect(body.error.code).toBe('cost-record-not-found');
    expect(body.error.details?.recordId).toBe('nope');
  });
});

describe('API — cost aggregate', () => {
  function seedForAggregate(): CostRecord[] {
    return [
      makeRecord({
        id: 'rec-1',
        agentId: 'acme.drafting',
        category: 'llm.inference',
        costUsd: 1,
        occurredAt: '2026-09-18T12:00:00.000Z' as Timestamp,
      }),
      makeRecord({
        id: 'rec-2',
        agentId: 'acme.drafting',
        category: 'llm.inference',
        costUsd: 2,
        occurredAt: '2026-09-18T14:00:00.000Z' as Timestamp,
      }),
      makeRecord({
        id: 'rec-3',
        agentId: 'acme.review',
        category: 'llm.inference',
        costUsd: 3,
        occurredAt: '2026-09-19T09:00:00.000Z' as Timestamp,
      }),
      makeRecord({
        id: 'rec-4',
        agentId: 'acme.review',
        category: 'tool.invocation',
        costUsd: 0.5,
        occurredAt: '2026-09-19T09:30:00.000Z' as Timestamp,
      }),
    ];
  }

  test('groupBy=day returns per-day bucket sums', async () => {
    const { app } = makeApp(seedForAggregate());
    const res = await app.request(
      '/v1/cost/aggregate?groupBy=day&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ key: Record<string, string | null>; count: number; totalUsd: number }>;
      totalUsd: number;
      totalRecords: number;
      timeRange: { from: string; to: string };
      groupBy: string[];
    };
    const byDay = new Map(body.groups.map((g) => [g.key.day, g]));
    expect(byDay.get('2026-09-18')?.count).toBe(2);
    expect(byDay.get('2026-09-18')?.totalUsd).toBeCloseTo(3);
    expect(byDay.get('2026-09-19')?.count).toBe(2);
    expect(byDay.get('2026-09-19')?.totalUsd).toBeCloseTo(3.5);
    expect(body.totalUsd).toBeCloseTo(6.5);
    expect(body.totalRecords).toBe(4);
    expect(body.groupBy).toEqual(['day']);
  });

  test('groupBy=agentId returns per-agent sum', async () => {
    const { app } = makeApp(seedForAggregate());
    const res = await app.request(
      '/v1/cost/aggregate?groupBy=agentId&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ key: Record<string, string | null>; count: number; totalUsd: number }>;
    };
    const byAgent = new Map(body.groups.map((g) => [g.key.agentId, g]));
    expect(byAgent.get('acme.drafting')?.totalUsd).toBeCloseTo(3);
    expect(byAgent.get('acme.review')?.totalUsd).toBeCloseTo(3.5);
  });

  test('groupBy=agentId,day → multi-dim rollup', async () => {
    const { app } = makeApp(seedForAggregate());
    const res = await app.request(
      '/v1/cost/aggregate?groupBy=agentId,day&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ key: Record<string, string | null>; count: number; totalUsd: number }>;
      groupBy: string[];
    };
    expect(body.groupBy).toEqual(['agentId', 'day']);
    const key = (agentId: string, day: string) =>
      body.groups.find((g) => g.key.agentId === agentId && g.key.day === day);
    expect(key('acme.drafting', '2026-09-18')?.totalUsd).toBeCloseTo(3);
    expect(key('acme.review', '2026-09-19')?.totalUsd).toBeCloseTo(3.5);
    // 4 records × 2 unique (agentId, day) pairs = only ONE group per pair.
    expect(body.groups).toHaveLength(2);
  });

  test('invalid groupBy dimension → 400', async () => {
    const { app } = makeApp();
    const res = await app.request(
      '/v1/cost/aggregate?groupBy=not-a-real-dim&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toMatch(/groupBy/);
  });

  test('missing groupBy → 400', async () => {
    const { app } = makeApp();
    const res = await app.request(
      '/v1/cost/aggregate?from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(400);
  });

  test('missing one endpoint of the time range → 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/cost/aggregate?groupBy=day&from=2026-09-01T00:00:00.000Z', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toMatch(/from/);
  });

  test('both endpoints omitted → default last-30-days window echoed in timeRange', async () => {
    const { app } = makeApp(seedForAggregate());
    const res = await app.request('/v1/cost/aggregate?groupBy=day', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timeRange: { from: string; to: string };
    };
    const from = new Date(body.timeRange.from).getTime();
    const to = new Date(body.timeRange.to).getTime();
    const spanMs = to - from;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    // Slightly permissive on wall-clock — 30 days ± 5 seconds.
    expect(Math.abs(spanMs - thirtyDaysMs)).toBeLessThan(5_000);
  });

  test('category filter narrows the aggregate scope', async () => {
    const { app } = makeApp(seedForAggregate());
    const res = await app.request(
      '/v1/cost/aggregate?groupBy=agentId&category=tool.invocation&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ key: Record<string, string | null>; totalUsd: number }>;
      totalRecords: number;
    };
    expect(body.totalRecords).toBe(1);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.key.agentId).toBe('acme.review');
    expect(body.groups[0]?.totalUsd).toBeCloseTo(0.5);
  });

  test('groupBy=tenant returns caller tenant id as sole bucket', async () => {
    const { app } = makeApp(seedForAggregate());
    const res = await app.request(
      '/v1/cost/aggregate?groupBy=tenant&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ key: Record<string, string | null>; totalUsd: number }>;
    };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.key.tenant).toBe(tenantId);
  });

  test('duplicate dimensions collapse', async () => {
    const { app } = makeApp(seedForAggregate());
    const res = await app.request(
      '/v1/cost/aggregate?groupBy=day,day,day&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groupBy: string[] };
    expect(body.groupBy).toEqual(['day']);
  });
});

describe('API — cost surface unmounted when no binding supplied', () => {
  test('no `cost` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/cost/records', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — cost scope filter', () => {
  function makeSpy() {
    const inner = makeInMemoryBinding();
    let lastListInput: Parameters<CostBinding['listRecords']>[0] | null = null;
    let lastAggregateInput: Parameters<CostBinding['aggregate']>[0] | null = null;
    const spy: CostBinding = {
      ...inner,
      async listRecords(input) {
        lastListInput = input;
        return inner.listRecords(input);
      },
      async aggregate(input) {
        lastAggregateInput = input;
        return inner.aggregate(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      cost: spy,
    });
    return {
      app,
      getListInput: (): typeof lastListInput => lastListInput,
      getAggregateInput: (): typeof lastAggregateInput => lastAggregateInput,
    };
  }

  test('records: ?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getListInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/cost/records?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getListInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('records: ?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getListInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/cost/records?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getListInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('records: no scope params → binding receives scope=undefined', async () => {
    const { app, getListInput } = makeSpy();
    const res = await app.request('/v1/cost/records', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getListInput()?.scope).toBeUndefined();
  });

  test('records: ?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/cost/records?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });

  test('aggregate: ?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getAggregateInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(
      `/v1/cost/aggregate?groupBy=agentId&scopeKind=project&scopeId=${projectId}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    expect(getAggregateInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });
});

describe("API — a model call's cost record (T135)", () => {
  const ROOT = randomUUID();
  const call = (over: Partial<CostRecord> = {}): CostRecord =>
    makeRecord({
      providerId: 'anthropic',
      runId: randomUUID(),
      costUsd: 0.002,
      callId: randomUUID(),
      projectId: randomUUID(),
      rootRunId: ROOT,
      model: 'claude-haiku-4-5',
      servedModel: 'claude-haiku-4-5-20251001',
      status: 'ok',
      usage: {
        promptTokens: 1200,
        completionTokens: 80,
        cacheReadTokens: 1000,
        cacheWriteTokens: 100,
        reasoningTokens: 30,
      },
      durationMs: 640,
      finishReason: 'stop',
      providerRequestId: 'req_1',
      attempts: 2,
      rawUsage: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 100, cache_read_input_tokens: 1000 },
      },
      ...over,
    });
  const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

  test('a record carries the call: model, served model, usage, request id, attempts', async () => {
    const rec = call();
    const { app } = makeApp([rec]);
    const res = await app.request(`/v1/cost/records/${rec.id}`, auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      callId: rec.callId,
      rootRunId: ROOT,
      model: 'claude-haiku-4-5',
      servedModel: 'claude-haiku-4-5-20251001',
      status: 'ok',
      usage: rec.usage,
      providerRequestId: 'req_1',
      attempts: 2,
    });
  });

  test('`include=rawUsage` asks the binding for the vendor’s own counts; an unknown include is refused', async () => {
    const seen: CostListRecordsInput[] = [];
    const { app } = makeApp([call()], seen);
    expect((await app.request('/v1/cost/records', auth)).status).toBe(200);
    expect((await app.request('/v1/cost/records?include=rawUsage', auth)).status).toBe(200);
    expect(seen.map((s) => s.includeRawUsage)).toEqual([undefined, true]);
    const bad = await app.request('/v1/cost/records?include=prompts', auth);
    expect(bad.status).toBe(400);
  });

  test('filters by model and root run; includeDescendants needs a runId', async () => {
    const seen: CostListRecordsInput[] = [];
    const { app } = makeApp([call(), call({ model: 'other', rootRunId: randomUUID() })], seen);
    const byRoot = await app.request(
      `/v1/cost/records?rootRunId=${ROOT}&model=claude-haiku-4-5`,
      auth,
    );
    expect(((await byRoot.json()) as { data: unknown[] }).data).toHaveLength(1);
    const runId = randomUUID();
    await app.request(`/v1/cost/records?runId=${runId}&includeDescendants=true`, auth);
    expect(seen.at(-1)?.filter).toEqual({ runId, includeDescendants: true });
    expect((await app.request('/v1/cost/records?includeDescendants=true', auth)).status).toBe(400);
    expect(
      (await app.request(`/v1/cost/records?runId=${runId}&includeDescendants=yes`, auth)).status,
    ).toBe(400);
  });

  test('aggregate groups by the model actually called, with token sums per group and in total', async () => {
    const { app } = makeApp([
      call(),
      call(),
      call({ model: 'gemini-2.5-pro', usage: { promptTokens: 10, completionTokens: 5 } }),
    ]);
    const res = await app.request(
      '/v1/cost/aggregate?groupBy=model&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z',
      auth,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: { key: Record<string, string>; count: number; tokens: Record<string, number> }[];
      tokens: Record<string, number>;
    };
    const haiku = body.groups.find((g) => g.key.model === 'claude-haiku-4-5');
    expect(haiku).toMatchObject({
      count: 2,
      tokens: { prompt: 2400, completion: 160, cacheRead: 2000, cacheWrite: 200, reasoning: 60 },
    });
    expect(body.tokens).toEqual({
      prompt: 2410,
      completion: 165,
      cacheRead: 2000,
      cacheWrite: 200,
      reasoning: 60,
    });
  });
});

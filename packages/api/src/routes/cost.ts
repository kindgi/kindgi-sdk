// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { Cursor, TenantId, Timestamp } from '@kindgi/types';

import {
  COST_GROUP_DIMENSIONS,
  type CostAggregateGroup,
  type CostBinding,
  type CostGroupDimension,
  type CostRecord,
  type CostRecordFilter,
} from '../cost-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Cost readback routes — part of the admin control plane. Three
 * surfaces:
 *
 *   - `GET  /v1/cost/records`      — paginated raw records with filters
 *   - `GET  /v1/cost/records/:id`  — single record
 *   - `GET  /v1/cost/aggregate`    — multi-dim rollup over a required
 *                                    time window
 *
 * The aggregate endpoint is the primary consumer path (dashboards);
 * the records list is for drilldown. Aggregate always runs over a
 * bounded time range — without one, queries would scan unbounded rows.
 * When the caller gives none, the route applies "last 30 days" and
 * echoes it in the response `timeRange` field for round-trippability.
 *
 * Budgets are not part of this surface.
 */
export function costRouter(binding: CostBinding): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const DEFAULT_AGGREGATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  // ---------- GET /records ----------
  r.get('/records', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const filter = parseRecordFilter(c.req.query());
    if (filter.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: filter.error }, requestId));
    }

    // Thread the ?scopeKind + ?scopeId + ?inherit
    // triplet as a sibling of `filter` (matches the binding's shape:
    // `scope` / `inherit` are top-level on `CostListRecordsInput`).
    const scopeParsed = parseScopeParams(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const page = await binding.listRecords({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      filter: filter.value,
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
    });
    return c.json({
      data: page.data.map(serializeRecord),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /records/:recordId ----------
  r.get('/records/:recordId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const recordId = c.req.param('recordId');

    const record = await binding.getRecord({ tenantId, recordId });
    if (record === null) {
      c.status(statusFor('cost-record-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'cost-record-not-found',
            message: `No cost record with id "${recordId}"`,
            recordId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeRecord(record));
  });

  // ---------- GET /aggregate ----------
  r.get('/aggregate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const query = c.req.query();

    // groupBy — required, comma-separated, each value from the closed set.
    const groupByRaw = query.groupBy;
    if (groupByRaw === undefined || groupByRaw.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`groupBy` is required (comma-separated dimensions)' },
          requestId,
        ),
      );
    }
    const rawDims = groupByRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (rawDims.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`groupBy` must contain at least one dimension' },
          requestId,
        ),
      );
    }
    const groupBy: CostGroupDimension[] = [];
    for (const raw of rawDims) {
      if (!(COST_GROUP_DIMENSIONS as readonly string[]).includes(raw)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `\`groupBy\` value "${raw}" is not a known dimension (one of: ${(
                COST_GROUP_DIMENSIONS as readonly string[]
              ).join(', ')})`,
            },
            requestId,
          ),
        );
      }
      if (!groupBy.includes(raw as CostGroupDimension)) {
        groupBy.push(raw as CostGroupDimension);
      }
    }

    // Time range — required. Default to last 30 days when both absent
    // (documented in the response `timeRange`). If only one endpoint is
    // supplied, reject — half-open defaults invite confusion.
    const fromRaw = query.from;
    const toRaw = query.to;
    let from: Date;
    let to: Date;
    if (fromRaw === undefined && toRaw === undefined) {
      to = new Date();
      from = new Date(to.getTime() - DEFAULT_AGGREGATE_WINDOW_MS);
    } else if (fromRaw === undefined || toRaw === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: '`from` and `to` must be provided together (or both omitted for the default)',
          },
          requestId,
        ),
      );
    } else {
      const parsedFrom = parseIsoDate(fromRaw);
      const parsedTo = parseIsoDate(toRaw);
      if (parsedFrom === null || parsedTo === null) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`from` / `to` must be ISO-8601 timestamps' },
            requestId,
          ),
        );
      }
      if (parsedFrom.getTime() > parsedTo.getTime()) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`from` must be less than or equal to `to`' },
            requestId,
          ),
        );
      }
      from = parsedFrom;
      to = parsedTo;
    }

    const filter = parseRecordFilter(query, { skipTime: true });
    if (filter.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: filter.error }, requestId));
    }

    // Thread the scope triplet into aggregate so a
    // scoped `/records` list and a scoped `/aggregate` reconcile to the
    // same underlying row-set.
    const scopeParsed = parseScopeParams(query, { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const result = await binding.aggregate({
      tenantId,
      groupBy,
      from,
      to,
      ...(Object.keys(filter.value).length > 0 && { filter: filter.value }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
    });

    return c.json({
      groups: result.groups.map(serializeGroup),
      totalUsd: result.totalUsd,
      totalRecords: result.totalRecords,
      timeRange: {
        from: result.timeRange.from,
        to: result.timeRange.to,
      },
      groupBy,
    });
  });

  return r;
}

// -------- helpers --------

function parseRecordFilter(
  query: Readonly<Record<string, string | undefined>>,
  opts: { skipTime?: boolean } = {},
): { kind: 'ok'; value: CostRecordFilter } | { kind: 'err'; error: string } {
  const out: {
    runId?: string;
    agentId?: string;
    conversationId?: string;
    category?: string;
    providerId?: string;
    from?: Date;
    to?: Date;
  } = {};
  const strKeys: Array<
    ['runId' | 'agentId' | 'conversationId' | 'category' | 'providerId', string]
  > = [
    ['runId', 'runId'],
    ['agentId', 'agentId'],
    ['conversationId', 'conversationId'],
    ['category', 'category'],
    ['providerId', 'providerId'],
  ];
  for (const [outKey, qKey] of strKeys) {
    const raw = query[qKey];
    if (raw !== undefined && raw.length > 0) {
      out[outKey] = raw;
    }
  }
  if (opts.skipTime !== true) {
    const fromRaw = query.from;
    if (fromRaw !== undefined && fromRaw.length > 0) {
      const parsed = parseIsoDate(fromRaw);
      if (parsed === null) return { kind: 'err', error: '`from` must be an ISO-8601 timestamp' };
      out.from = parsed;
    }
    const toRaw = query.to;
    if (toRaw !== undefined && toRaw.length > 0) {
      const parsed = parseIsoDate(toRaw);
      if (parsed === null) return { kind: 'err', error: '`to` must be an ISO-8601 timestamp' };
      out.to = parsed;
    }
    if (out.from !== undefined && out.to !== undefined && out.from.getTime() > out.to.getTime()) {
      return { kind: 'err', error: '`from` must be less than or equal to `to`' };
    }
  }
  return { kind: 'ok', value: out };
}

function parseIsoDate(raw: string): Date | null {
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

function serializeRecord(rec: CostRecord): Record<string, unknown> {
  return {
    id: rec.id,
    tenantId: rec.tenantId as unknown as string,
    category: rec.category,
    ...(rec.providerId !== undefined && { providerId: rec.providerId }),
    ...(rec.runId !== undefined && { runId: rec.runId }),
    ...(rec.agentId !== undefined && { agentId: rec.agentId }),
    ...(rec.conversationId !== undefined && { conversationId: rec.conversationId }),
    quantity: rec.quantity,
    unit: rec.unit,
    ...(rec.costUsd !== undefined && { costUsd: rec.costUsd }),
    occurredAt: rec.occurredAt as unknown as string,
    ...(rec.metrics !== undefined && { metrics: rec.metrics }),
    ...(rec.attributes !== undefined && { attributes: rec.attributes }),
  };
}

function serializeGroup(g: CostAggregateGroup): Record<string, unknown> {
  return {
    key: g.key,
    count: g.count,
    totalUsd: g.totalUsd,
  };
}

// Re-export for typing convenience in tests / callers.
export type { Timestamp };

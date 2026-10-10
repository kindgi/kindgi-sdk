// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { Cursor, TenantId, Timestamp } from '@kindgi/types';

import { type ResourceRef, denyPayload, ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import {
  COST_AGGREGATE_DEFAULT_LIMIT,
  COST_AGGREGATE_MAX_LIMIT,
  COST_GROUP_DIMENSIONS,
  type CostAggregateGroup,
  type CostAggregateInput,
  type CostBinding,
  type CostGroupDimension,
  type CostRecord,
  type CostRecordFilter,
  type CostTokenTotals,
} from '../cost-binding.js';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';
import { clampLimit } from './pagination.js';
import { projectIdsCallerMay } from './readable-projects.js';
import { parseScopeParams, scopeResourceRef } from './scope-params.js';

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
export function costRouter(
  binding: CostBinding,
  /**
   * With one: a record needs `read` on its project (the tenant, for one
   * with no project); an aggregate, `read` on the scope it's asked for,
   * and across projects (no scope, or an org) it counts only the projects
   * the caller may read, unless the caller is a tenant admin.
   */
  authorizer?: Authorizer,
  /** The tenant's projects, to check one by one when the authorizer can't list them. */
  projects?: Pick<ProjectBinding, 'list'>,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const recordRef = (tenantId: TenantId, rec: { readonly projectId?: unknown }): ResourceRef =>
    rec.projectId !== undefined && rec.projectId !== null
      ? ref('project', rec.projectId as string)
      : ref('tenant', tenantId as unknown as string);

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
    const include = parseInclude(c.req.query('include'));
    if (include.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: include.error }, requestId));
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
      ...(include.rawUsage && { includeRawUsage: true }),
    });
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (rec) => recordRef(tenantId, rec));
    return c.json({
      data: visible.map(serializeRecord),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /records/:recordId ----------
  r.get('/records/:recordId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const recordId = c.req.param('recordId');
    const include = parseInclude(c.req.query('include'));
    if (include.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: include.error }, requestId));
    }

    const record = await binding.getRecord({
      tenantId,
      recordId,
      ...(include.rawUsage && { includeRawUsage: true }),
    });
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
    const refused = await deniedBy(authorizer, c, 'read', recordRef(tenantId, record));
    if (refused !== undefined) return refused;
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

    // limit — the most groups to return, the most expensive first.
    const limit = parseAggregateLimit(query.limit);
    if (limit === null) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `\`limit\` must be an integer from 1 to ${COST_AGGREGATE_MAX_LIMIT} (default ${COST_AGGREGATE_DEFAULT_LIMIT})`,
          },
          requestId,
        ),
      );
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

    const refused = await deniedBy(
      authorizer,
      c,
      'read',
      scopeResourceRef(scopeParsed.scope, tenantId),
    );
    if (refused !== undefined) return refused;

    // Across projects, only what the caller may read counts (`aggregateReach`).
    const reach = await aggregateReach(c, {
      binding,
      tenantId,
      authorizer,
      projects,
      scope: scopeParsed.scope,
    });
    if (reach.kind === 'refused') return reach.response;

    const result = await binding.aggregate({
      tenantId,
      groupBy,
      from,
      to,
      ...(Object.keys(filter.value).length > 0 && { filter: filter.value }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
      ...(reach.kind === 'projects' && { readableProjectIds: reach.ids }),
      limit,
    });

    // The most expensive groups, capped here too: a binding may return
    // every group. The window's totals stay over every record.
    const groups = [...result.groups].sort((a, b) => compareGroups(a, b, groupBy)).slice(0, limit);
    const totalGroups = Math.max(result.totalGroups ?? 0, result.groups.length);

    return c.json({
      groups: groups.map(serializeGroup),
      totalGroups,
      truncated: totalGroups > groups.length,
      totalUsd: result.totalUsd,
      totalRecords: result.totalRecords,
      tokens: serializeTokens(result.tokens),
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

/**
 * What an aggregate may count for this caller. Across projects (no scope,
 * the tenant, or an org), `read` on the scope lets a member ask, not see
 * every project's spend: only the projects they may read count, applied in
 * the binding's query (`readableProjectIds`). A tenant admin's, a project
 * scope's (already checked) and one without authorization count everything
 * the scope holds. When the readable projects can't be worked out, or the
 * binding can't apply them, the aggregate is refused rather than
 * over-counted.
 */
async function aggregateReach(
  c: Context<AppEnv>,
  args: {
    readonly binding: CostBinding;
    readonly tenantId: TenantId;
    readonly authorizer: Authorizer | undefined;
    readonly projects: Pick<ProjectBinding, 'list'> | undefined;
    readonly scope: CostAggregateInput['scope'] | undefined;
  },
): Promise<
  | { readonly kind: 'all' }
  | { readonly kind: 'projects'; readonly ids: readonly string[] }
  | { readonly kind: 'refused'; readonly response: Response }
> {
  const { binding, tenantId, authorizer, projects, scope } = args;
  if (authorizer === undefined || scope?.kind === 'project') return { kind: 'all' };
  if (await authorizer.can(c, 'admin', ref('tenant', tenantId as unknown as string))) {
    return { kind: 'all' };
  }
  const ids = await projectIdsCallerMay(c, authorizer, projects, 'read');
  if (ids !== undefined && binding.aggregatesReadableProjects === true) {
    return { kind: 'projects', ids };
  }
  const deny = denyPayload(
    'read',
    scope?.kind === 'org' ? 'org' : 'tenant',
    scope?.kind === 'org' ? (scope.orgId as unknown as string) : (tenantId as unknown as string),
    ids === undefined
      ? "the projects you may read can't be listed here, so an aggregate across projects can't be limited to them; ask per project (scopeKind=project)"
      : "this deployment's cost store can't limit an aggregate to the projects you may read; ask per project (scopeKind=project)",
  );
  c.status(403);
  return {
    kind: 'refused',
    response: c.json(
      toWireError(
        {
          code: deny.code,
          message: `Permission denied: ${deny.reason}`,
          action: deny.action,
          resource: deny.resource,
          reason: deny.reason,
        },
        c.get('requestId'),
      ),
    ),
  };
}

function parseRecordFilter(
  query: Readonly<Record<string, string | undefined>>,
  opts: { skipTime?: boolean } = {},
): { kind: 'ok'; value: CostRecordFilter } | { kind: 'err'; error: string } {
  const out: {
    -readonly [K in keyof CostRecordFilter]: CostRecordFilter[K];
  } = {};
  const strKeys = [
    'runId',
    'agentId',
    'conversationId',
    'category',
    'providerId',
    'model',
    'servedModel',
    'rootRunId',
  ] as const;
  for (const key of strKeys) {
    const raw = query[key];
    if (raw !== undefined && raw.length > 0) {
      out[key] = raw;
    }
  }
  const descendants = query.includeDescendants;
  if (descendants !== undefined && descendants.length > 0) {
    if (descendants !== 'true' && descendants !== 'false') {
      return { kind: 'err', error: '`includeDescendants` must be `true` or `false`' };
    }
    if (descendants === 'true') {
      if (out.runId === undefined) {
        return { kind: 'err', error: '`includeDescendants` needs a `runId`' };
      }
      out.includeDescendants = true;
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

/** The `include` query: optional extra fields, comma-separated. Only `rawUsage` today. */
function parseInclude(
  raw: string | undefined,
): { kind: 'ok'; rawUsage: boolean } | { kind: 'err'; error: string } {
  const fields = (raw ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  for (const field of fields) {
    if (field !== 'rawUsage') {
      return { kind: 'err', error: `\`include\` value "${field}" is not known (one of: rawUsage)` };
    }
  }
  return { kind: 'ok', rawUsage: fields.includes('rawUsage') };
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
    ...pick(rec, MODEL_CALL_FIELDS),
  };
}

/** A model call's fields on the wire, as the binding gives them (all optional). */
const MODEL_CALL_FIELDS = [
  'callId',
  'projectId',
  'rootRunId',
  'parentRunId',
  'agentVersion',
  'flowId',
  'nodeId',
  'step',
  'purpose',
  'model',
  'servedModel',
  'fallback',
  'status',
  'usage',
  'durationMs',
  'finishReason',
  'providerRequestId',
  'attempts',
  'error',
  'rawUsage',
] as const satisfies readonly (keyof CostRecord)[];

function pick(rec: CostRecord, keys: readonly (keyof CostRecord)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (rec[key] !== undefined) out[key] = rec[key];
  }
  return out;
}

/** `?limit=` on the aggregate: the default when absent, `null` when it isn't 1..max. */
function parseAggregateLimit(raw: string | undefined): number | null {
  if (raw === undefined) return COST_AGGREGATE_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= COST_AGGREGATE_MAX_LIMIT ? n : null;
}

/**
 * The aggregate's order: `totalUsd` descending, then the key, dimension
 * by dimension in `groupBy` order (code-point order; `null` last).
 */
function compareGroups(
  a: CostAggregateGroup,
  b: CostAggregateGroup,
  groupBy: readonly CostGroupDimension[],
): number {
  if (a.totalUsd !== b.totalUsd) return b.totalUsd - a.totalUsd;
  for (const dim of groupBy) {
    const x = a.key[dim] ?? null;
    const y = b.key[dim] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function serializeGroup(g: CostAggregateGroup): Record<string, unknown> {
  return {
    key: g.key,
    count: g.count,
    totalUsd: g.totalUsd,
    tokens: serializeTokens(g.tokens),
  };
}

function serializeTokens(t: CostTokenTotals): CostTokenTotals {
  return {
    prompt: t.prompt,
    completion: t.completion,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    reasoning: t.reasoning,
  };
}

// Re-export for typing convenience in tests / callers.
export type { Timestamp };

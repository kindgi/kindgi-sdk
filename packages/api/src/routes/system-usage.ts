// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { systemReadAcrossTenants } from '../middleware/system.js';
import type { AppEnv } from '../types.js';
import { USAGE_CLASSES, USAGE_KINDS, type UsageClass, type UsageKind } from '../usage.js';
import { parseTimeInput } from './time-input.js';

/** What usage can be grouped by. `day` is the record's UTC date. */
export const USAGE_GROUP_KEYS = [
  'tenant',
  'project',
  'agent',
  'kind',
  'class',
  'state',
  'day',
] as const;

export type UsageGroupKey = (typeof USAGE_GROUP_KEYS)[number];

/** A `project.production` record's state. */
export const USAGE_STATES = ['on', 'off'] as const;

export type UsageState = (typeof USAGE_STATES)[number];

/** The longest window one read covers, in days. */
export const USAGE_WINDOW_MAX_DAYS = 92;

/** What `GET /v1/system/usage` asks a runtime for. */
export interface SystemUsageQuery {
  /** Records at or after this time. */
  readonly from: Date;
  /** Records before this time. */
  readonly to: Date;
  readonly groupBy: readonly UsageGroupKey[];
  /** Only these kinds; absent: every kind. */
  readonly kinds?: readonly UsageKind[];
  /** Only these classes; absent: every class (and kinds with none). */
  readonly classes?: readonly UsageClass[];
  /** Only these states; absent: every state (and kinds with none). */
  readonly states?: readonly UsageState[];
  /** Only this tenant; absent: every tenant. */
  readonly tenantId?: TenantId;
  readonly limit: number;
  /** Where the last page stopped (its `nextCursor`), opaque. */
  readonly cursor?: string;
}

/** One group: the dimensions grouped by, then counts and sums. */
export interface UsageGroup {
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly kind?: UsageKind;
  readonly class?: UsageClass;
  readonly state?: UsageState;
  /** `YYYY-MM-DD`, the UTC date. */
  readonly day?: string;
  /** Records in the group. */
  readonly count: number;
  /** The sum of their quantities (milliseconds for `run.ended`, tokens for model calls). */
  readonly quantity: number;
  /** The earliest record's time. */
  readonly firstAt: string;
  /** The latest record's time. */
  readonly lastAt: string;
}

export interface SystemUsagePage {
  readonly data: readonly UsageGroup[];
  /**
   * Every record at or before this time is in the answer; a later one may
   * not be yet. A reader re-reads a window until its watermark is past the
   * window's end.
   */
  readonly watermark: string;
  /** More groups: pass it as `cursor`. Absent on the last page. */
  readonly nextCursor?: string;
}

/**
 * Usage across tenants, aggregated: counts, sums and first and last times,
 * never a record's content. A runtime reads each tenant inside that
 * tenant's own row-level security.
 */
export interface SystemUsageBinding {
  read(
    query: SystemUsageQuery,
  ): Promise<
    { readonly kind: 'ok'; readonly page: SystemUsagePage } | { readonly kind: 'cursor-unreadable' }
  >;
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `GET /v1/system/usage` (`system:usage:read`), the control plane's pull:
 * `?from&to` (times with a zone; `to` excluded, at most 92 days),
 * `groupBy` (comma-separated: `tenant`, `project`, `agent`, `kind`,
 * `class`, `state`, `day`; default `tenant,kind`), the filters `kind`,
 * `class`, `state` (each comma-separated) and `tenantId`, then `limit`
 * (default 1000, at most 10000) and `cursor`. It answers
 * `{ data, watermark, nextCursor? }`. The access record marks it a read
 * across every tenant.
 */
export function systemUsageRouter(options: {
  readonly usage: SystemUsageBinding;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { usage, authorizer } = options;
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const denied = systemReadAcrossTenants(c, 'system:usage:read', authorizer);
    if (denied !== undefined) return denied;
    const query = parseUsageQuery((name) => c.req.query(name));
    if (typeof query === 'string') return badInput(c, query);
    // A read of one tenant's usage names that tenant on the access record.
    if (query.tenantId !== undefined) c.set('systemTargetTenant', query.tenantId);
    const read = await usage.read(query);
    if (read.kind === 'cursor-unreadable') {
      return badInput(c, '`cursor` is not one this route gave: start again without it');
    }
    return c.json(read.page);
  });

  return r;
}

/** The query a request asks for, or why it can't be read. */
export function parseUsageQuery(
  param: (name: string) => string | undefined,
): SystemUsageQuery | string {
  const window = parseWindow(param);
  if (typeof window === 'string') return window;
  const filters = parseFilters(param);
  if (typeof filters === 'string') return filters;
  const limitRaw = param('limit');
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return `\`limit\` must be a whole number from 1 to ${MAX_LIMIT}`;
  }
  const cursor = param('cursor');
  return {
    ...window,
    ...filters,
    limit,
    ...(cursor !== undefined && cursor !== '' && { cursor }),
  };
}

/** `from` and `to`: times with a zone, `to` after `from`, at most 92 days apart. */
function parseWindow(
  param: (name: string) => string | undefined,
): { readonly from: Date; readonly to: Date } | string {
  const from = parseTimeInput(param('from'));
  const to = parseTimeInput(param('to'));
  if (from === null || to === null) {
    return '`from` and `to` are required: times with a zone, such as 2026-11-01T00:00:00Z';
  }
  if (to.getTime() <= from.getTime()) return '`to` must be after `from`';
  if (to.getTime() - from.getTime() > USAGE_WINDOW_MAX_DAYS * DAY_MS) {
    return `One read covers at most ${USAGE_WINDOW_MAX_DAYS} days: read a longer span in parts`;
  }
  return { from, to };
}

/** `groupBy` and the filters, each a list of known values. */
function parseFilters(
  param: (name: string) => string | undefined,
): Omit<SystemUsageQuery, 'from' | 'to' | 'limit' | 'cursor'> | string {
  const groupBy = parseList('groupBy', param('groupBy'), USAGE_GROUP_KEYS) ?? ['tenant', 'kind'];
  const kinds = parseList('kind', param('kind'), USAGE_KINDS);
  const classes = parseList('class', param('class'), USAGE_CLASSES);
  const states = parseList('state', param('state'), USAGE_STATES);
  const refused = [groupBy, kinds, classes, states].find((v) => typeof v === 'string');
  if (typeof refused === 'string') return refused;
  const tenantId = param('tenantId');
  if (tenantId !== undefined && !UUID_RE.test(tenantId)) return '`tenantId` must be a tenant id';
  return {
    groupBy: groupBy as readonly UsageGroupKey[],
    ...(kinds !== undefined && { kinds: kinds as readonly UsageKind[] }),
    ...(classes !== undefined && { classes: classes as readonly UsageClass[] }),
    ...(states !== undefined && { states: states as readonly UsageState[] }),
    ...(tenantId !== undefined && { tenantId: tenantId.toLowerCase() as TenantId }),
  };
}

/** A comma-separated list of known values, once each; `undefined` when absent; why not, as a string. */
function parseList<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
): readonly T[] | string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const items = raw.split(',').map((s) => s.trim());
  const unknown = items.filter((s) => !(allowed as readonly string[]).includes(s));
  if (unknown.length > 0) {
    return `\`${name}\` takes ${allowed.join(', ')}; got ${unknown.map((s) => `"${s}"`).join(', ')}`;
  }
  if (new Set(items).size !== items.length) return `\`${name}\` names one twice`;
  return items as T[];
}

function badInput(c: Context<AppEnv>, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, c.get('requestId')));
}

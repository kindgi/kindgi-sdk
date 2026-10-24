// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';
import {
  USAGE_CLASSES,
  USAGE_KINDS,
  USAGE_STATES,
  USAGE_WINDOW_MAX_DAYS,
  type UsageClass,
  type UsageGroupKey,
  type UsageKind,
  type UsageQuery,
  type UsageState,
} from '../usage.js';
import { parseTimeInput } from './time-input.js';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The query string both usage reads take, or why it can't be read:
 * `?from&to` (times with a zone; `to` excluded, at most 92 days),
 * `groupBy` (comma-separated, from `groupKeys`; default `defaultGroupBy`),
 * the filters `kind`, `class` and `state` (each comma-separated), then
 * `limit` (default 1000, at most 10000) and `cursor`.
 */
export function parseUsageQuery(
  param: (name: string) => string | undefined,
  groupKeys: readonly UsageGroupKey[],
  defaultGroupBy: readonly UsageGroupKey[],
): Omit<UsageQuery, 'projectIds'> | string {
  const window = parseWindow(param);
  if (typeof window === 'string') return window;
  const groupBy = parseList('groupBy', param('groupBy'), groupKeys) ?? defaultGroupBy;
  const kinds = parseList('kind', param('kind'), USAGE_KINDS);
  const classes = parseList('class', param('class'), USAGE_CLASSES);
  const states = parseList('state', param('state'), USAGE_STATES);
  const refused = [groupBy, kinds, classes, states].find((v) => typeof v === 'string');
  if (typeof refused === 'string') return refused;
  const limitRaw = param('limit');
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return `\`limit\` must be a whole number from 1 to ${MAX_LIMIT}`;
  }
  const cursor = param('cursor');
  return {
    ...window,
    groupBy: groupBy as readonly UsageGroupKey[],
    ...(kinds !== undefined && { kinds: kinds as readonly UsageKind[] }),
    ...(classes !== undefined && { classes: classes as readonly UsageClass[] }),
    ...(states !== undefined && { states: states as readonly UsageState[] }),
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

export function usageBadInput(c: Context<AppEnv>, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, c.get('requestId')));
}

/** A cursor the binding can't read: one this route didn't give. */
export const CURSOR_UNREADABLE = '`cursor` is not one this route gave: start again without it';

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs/failures`: a project's failed runs over a window, grouped
 * by cause and version (`RunBinding.failureGroups`), so a console shows
 * error groups and "which version broke it" from server counts, never from
 * the pages it loaded. People's decisions (`hitl-*`) come apart from the
 * failures, and runs that failed before causes were recorded come apart
 * too, by subject and version only.
 */

import type { Context } from 'hono';

import type { FailureGrouping, FailureSubject, RunBinding } from '@kindgi/runtime';
import type { TenantId, Timestamp } from '@kindgi/types';

import { ref } from '@kindgi/authz';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';

/** The longest window: outcomes older than a run's retention are gone anyway. */
export const RUN_FAILURES_MAX_WINDOW_DAYS = 90;
export const RUN_FAILURES_DEFAULT_LIMIT = 50;
export const RUN_FAILURES_MAX_LIMIT = 200;

const DAY_MS = 86_400_000;

interface FailuresQuery {
  readonly projectId: string;
  readonly from: Timestamp;
  readonly to: Timestamp;
  readonly subject?: FailureSubject;
  readonly groupBy: FailureGrouping;
  readonly limit: number;
}

/** The query, or what's wrong with it. */
export function parseFailuresQuery(
  query: Readonly<Record<string, string | undefined>>,
):
  | { readonly kind: 'ok'; readonly value: FailuresQuery }
  | { readonly kind: 'err'; readonly message: string } {
  const err = (message: string) => ({ kind: 'err' as const, message });
  const projectId = query.projectId;
  if (projectId === undefined || projectId === '') return err('`projectId` is required');
  const from = time(query.from);
  const to = time(query.to);
  if (from === undefined || to === undefined) {
    return err('`from` and `to` are required, as ISO 8601 times');
  }
  if (Date.parse(from) >= Date.parse(to)) return err('`from` must be before `to`');
  if (Date.parse(to) - Date.parse(from) > RUN_FAILURES_MAX_WINDOW_DAYS * DAY_MS) {
    return err(`The window is at most ${RUN_FAILURES_MAX_WINDOW_DAYS} days`);
  }
  if (query.agentId !== undefined && query.flowId !== undefined) {
    return err('Name an agent (`agentId`) or a flow (`flowId`), not both');
  }
  const subject: FailureSubject | undefined =
    query.agentId !== undefined && query.agentId !== ''
      ? { kind: 'agent', id: query.agentId }
      : query.flowId !== undefined && query.flowId !== ''
        ? { kind: 'flow', id: query.flowId }
        : undefined;
  const dims = (query.groupBy ?? 'code,version').split(',').map((d) => d.trim());
  if (dims.length === 0 || dims.some((d) => d !== 'code' && d !== 'version')) {
    return err('`groupBy` is `code`, `version`, or `code,version`');
  }
  const limit =
    query.limit === undefined || query.limit === ''
      ? RUN_FAILURES_DEFAULT_LIMIT
      : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_FAILURES_MAX_LIMIT) {
    return err(`\`limit\` is a whole number from 1 to ${RUN_FAILURES_MAX_LIMIT}`);
  }
  return {
    kind: 'ok',
    value: {
      projectId,
      from,
      to,
      ...(subject !== undefined && { subject }),
      groupBy: { code: dims.includes('code'), version: dims.includes('version') },
      limit,
    },
  };
}

function time(raw: string | undefined): Timestamp | undefined {
  if (raw === undefined || raw === '' || Number.isNaN(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString() as Timestamp;
}

export function runFailuresHandler(runBinding: RunBinding, authorizer: Authorizer | undefined) {
  return async (c: Context<AppEnv>) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const fail = (code: string, message: string) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };
    const parsed = parseFailuresQuery(c.req.query());
    if (parsed.kind === 'err') return fail('bad-input', parsed.message);
    const { projectId } = parsed.value;
    // Every run in the project is readable by whoever may read the project.
    const refused = await deniedBy(authorizer, c, 'read', ref('project', projectId));
    if (refused !== undefined) return refused;
    if (runBinding.failureGroups === undefined) {
      return fail(
        'run-failures-not-supported',
        'This deployment cannot group failed runs by cause.',
      );
    }
    const groups = await runBinding.failureGroups({
      tenantId: tenantId as unknown as string,
      ...parsed.value,
    });
    return c.json({ from: parsed.value.from, to: parsed.value.to, ...groups });
  };
}

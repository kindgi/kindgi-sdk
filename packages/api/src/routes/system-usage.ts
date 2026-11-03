// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { TenantId } from '@kindgi/types';

import type { Authorizer } from '../middleware/authorize.js';
import { systemReadAcrossTenants } from '../middleware/system.js';
import type { AppEnv } from '../types.js';
import { USAGE_GROUP_KEYS, type UsageBinding } from '../usage.js';
import { CURSOR_UNREADABLE, parseUsageQuery, usageBadInput } from './usage-query.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /v1/system/usage` (`system:usage:read`), the control plane's pull:
 * the usage query (`usage-query.ts`; `groupBy` from `tenant`, `project`,
 * `agent`, `kind`, `class`, `state`, `day`, default `tenant,kind`) and a
 * `tenantId` filter. It answers `{ data, watermark, nextCursor? }`. A test
 * tenant's usage and one whose setup is pending are left out, even when
 * `tenantId` names one, as the binding says. The access record marks it a
 * read across every tenant, or of the one named.
 */
export function systemUsageRouter(options: {
  readonly usage: UsageBinding;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { usage, authorizer } = options;
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const denied = systemReadAcrossTenants(c, 'system:usage:read', authorizer);
    if (denied !== undefined) return denied;
    const query = parseUsageQuery((name) => c.req.query(name), USAGE_GROUP_KEYS, [
      'tenant',
      'kind',
    ]);
    if (typeof query === 'string') return usageBadInput(c, query);
    const raw = c.req.query('tenantId');
    if (raw !== undefined && !UUID_RE.test(raw)) {
      return usageBadInput(c, '`tenantId` must be a tenant id');
    }
    const tenantId = raw?.toLowerCase() as TenantId | undefined;
    // A read of one tenant's usage names that tenant on the access record.
    if (tenantId !== undefined) c.set('systemTargetTenant', tenantId as unknown as string);
    const read = await usage.acrossTenants({
      ...query,
      ...(tenantId !== undefined && { tenantId }),
    });
    if (read.kind === 'cursor-unreadable') return usageBadInput(c, CURSOR_UNREADABLE);
    return c.json(read.page);
  });

  return r;
}

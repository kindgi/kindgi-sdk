// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import { RETENTION_DOMAINS, type RetentionDomain } from '@kindgi/policy-contract';
import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { RetentionBinding } from '../retention-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * Retention resource routes — admin surface for the retention
 * pipeline.
 *
 *   - `GET  /v1/retention/scheduled`      tombstoned rows scheduled for deletion
 *                                         (`?pastGraceOnly=true`: only what a
 *                                         sweep would purge now)
 *   - `POST /v1/retention/sweep`          "purge every past-grace tombstone in this tenant"
 *   - `POST /v1/retention/sweep/:domain`  same but narrowed to one domain
 *
 * PEP: reads and writes both require `admin` on `tenant:<tenantId>`,
 * matching how the other tenant-scoped admin knobs gate.
 */
export function retentionRouter(binding: RetentionBinding, authorizer?: Authorizer): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Every retention op is tenant-admin only.
  if (authorizer !== undefined) {
    r.use('/*', async (c, next) => {
      const tenantId = c.get('tenantId') as TenantId;
      const mw = authorizer.authorize('admin', async () =>
        ref('tenant', tenantId as unknown as string),
      );
      return mw(c, next);
    });
  }

  r.get('/scheduled', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const url = new URL(c.req.url);

    const domain = parseDomain(url.searchParams.get('domain'));
    if (domain === 'invalid') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `\`domain\` must be one of: ${RETENTION_DOMAINS.join(', ')}`,
          },
          requestId,
        ),
      );
    }

    const limit = clampLimit(url.searchParams.get('limit') ?? undefined);
    const pastGraceRaw = url.searchParams.get('pastGraceOnly');
    const pastGraceOnly = pastGraceRaw === 'true';

    const page = await binding.scheduled({
      tenantId,
      limit,
      pastGraceOnly,
      ...(domain !== undefined && { domain }),
    });

    return c.json(page);
  });

  r.post('/sweep', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown = {};
    try {
      const raw = await c.req.text();
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (typeof body !== 'object' || body === null) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const parsed = parseSweepBody(body as Record<string, unknown>);
    if (parsed.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsed.message }, requestId));
    }

    const result = await binding.sweep({
      tenantId,
      ...(parsed.value.domain !== undefined && { domain: parsed.value.domain }),
      ...(parsed.value.maxPerDomain !== undefined && { maxPerDomain: parsed.value.maxPerDomain }),
    });
    return c.json(result);
  });

  r.post('/sweep/:domain', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const domain = parseDomain(c.req.param('domain'));
    if (domain === undefined || domain === 'invalid') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `\`:domain\` must be one of: ${RETENTION_DOMAINS.filter((d) => d !== '*').join(', ')}`,
          },
          requestId,
        ),
      );
    }

    let body: unknown = {};
    try {
      const raw = await c.req.text();
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (typeof body !== 'object' || body === null) body = {};

    const parsed = parseSweepBody(body as Record<string, unknown>);
    if (parsed.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsed.message }, requestId));
    }

    const result = await binding.sweep({
      tenantId,
      domain,
      ...(parsed.value.maxPerDomain !== undefined && { maxPerDomain: parsed.value.maxPerDomain }),
    });
    return c.json(result);
  });

  return r;
}

function parseDomain(raw: string | null | undefined): RetentionDomain | 'invalid' | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if ((RETENTION_DOMAINS as readonly string[]).includes(raw)) return raw as RetentionDomain;
  return 'invalid';
}

function parseSweepBody(body: Record<string, unknown>):
  | {
      readonly kind: 'ok';
      readonly value: {
        readonly domain?: RetentionDomain;
        readonly maxPerDomain?: number;
      };
    }
  | { readonly kind: 'err'; readonly message: string } {
  const value: { domain?: RetentionDomain; maxPerDomain?: number } = {};
  if ('domain' in body) {
    const parsed = parseDomain(String(body.domain));
    if (parsed === 'invalid') {
      return {
        kind: 'err',
        message: `\`domain\` must be one of: ${RETENTION_DOMAINS.join(', ')}`,
      };
    }
    if (parsed !== undefined) value.domain = parsed;
  }
  if ('maxPerDomain' in body) {
    const n = body.maxPerDomain;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > 10_000) {
      return {
        kind: 'err',
        message: '`maxPerDomain` must be a positive integer ≤ 10000',
      };
    }
    value.maxPerDomain = n;
  }
  return { kind: 'ok', value };
}

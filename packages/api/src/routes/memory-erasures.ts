// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  MemoryErasureBinding,
  MemoryErasureLedgerEntry,
  MemoryErasureSelector,
  MemoryErasureSelectorKind,
} from '../memory-erasure-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { callerRef } from './memory-access.js';
import { clampLimit } from './pagination.js';

/**
 * Erasing a person's words (T273 M-5):
 *
 *   - `POST /v1/memory/erasures`          start one (202); `409 legal-hold`
 *                                         when a fact it reaches is held
 *   - `GET  /v1/memory/erasures`          newest first, in pages
 *   - `GET  /v1/memory/erasures/export`   the whole ledger, content-free,
 *                                         to keep off-box
 *   - `GET  /v1/memory/erasures/:id`      one, and how far it got
 *   - `POST /v1/memory/erasures/:id/resume`  try again now; `force`: stop
 *                                         waiting for a shared flow's run
 *   - `POST /v1/memory/erasures/replay`   after a backup restore: the
 *                                         exported ledger back, its
 *                                         erasures run again
 *
 * PEP: a tenant admin only, for every selector (`admin` on
 * `tenant:<tenantId>`), as retention; a service account only through an
 * explicit tenant-admin grant.
 */
export function memoryErasuresRouter(
  binding: MemoryErasureBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  if (authorizer !== undefined) {
    r.use('/*', async (c, next) => {
      const tenantId = c.get('tenantId') as TenantId;
      const mw = authorizer.authorize('admin', async () =>
        ref('tenant', tenantId as unknown as string),
      );
      return mw(c, next);
    });
  }

  r.post('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await jsonBody(c);
    const selector = parseSelector(body);
    if (typeof selector === 'string') return fail(c, 'bad-input', selector);
    const outcome = await binding.create({ tenantId, selector, requestedBy: callerRef(c) });
    if (outcome.kind === 'refused') {
      const { code, message, factIds } = outcome.refusal;
      return fail(c, code, message, factIds !== undefined ? { factIds: [...factIds] } : {});
    }
    c.status(202);
    return c.json({
      ...outcome.erasure,
      ...(outcome.warnings.length > 0 && { warnings: outcome.warnings }),
    });
  });

  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const cursor = c.req.query('cursor');
    const page = await binding.list(tenantId, {
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor !== '' && { cursor }),
    });
    if (page === undefined) return fail(c, 'bad-input', '`cursor` is not one this list issued');
    return c.json({
      data: page.data,
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
    });
  });

  r.get('/export', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    return c.json({ data: await binding.exportLedger(tenantId) });
  });

  r.post('/replay', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await jsonBody(c);
    const entries = parseLedger(body);
    if (typeof entries === 'string') return fail(c, 'bad-input', entries);
    return c.json(await binding.replay(tenantId, entries));
  });

  r.post('/:erasureId/resume', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const id = c.req.param('erasureId');
    const body = (await jsonBody(c)) ?? {};
    const force = (body as { force?: unknown }).force;
    if (
      typeof body !== 'object' ||
      Array.isArray(body) ||
      (force !== undefined && typeof force !== 'boolean')
    ) {
      return fail(c, 'bad-input', 'The body is `{force?: boolean}`');
    }
    const erasure = UUID.test(id)
      ? await binding.resume(tenantId, id, { ...(force === true && { force: true }) })
      : undefined;
    if (erasure === undefined) return fail(c, 'not-found', `No erasure ${id}`);
    return c.json(erasure);
  });

  r.get('/:erasureId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const id = c.req.param('erasureId');
    const erasure = UUID.test(id) ? await binding.get(tenantId, id) : undefined;
    if (erasure === undefined) return fail(c, 'not-found', `No erasure ${id}`);
    return c.json(erasure);
  });

  return r;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_KINDS = ['participant', 'external'] as const;
const SELECTOR_KINDS: readonly MemoryErasureSelectorKind[] = [
  'fact',
  'participant',
  'external',
  'conversation',
];
const STATUSES = ['pending', 'running', 'waiting-on-run', 'completed', 'failed'] as const;
const MAX_ID = 256;
const MAX_LEDGER = 10_000;

function fail(
  c: Context<AppEnv>,
  code: string,
  message: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  c.status(statusFor(code as never) as never);
  return c.json(toWireError({ code, message, ...extra }, c.get('requestId')));
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= MAX_ID;

/** Exactly one of `factId`, `subject` or `conversationId`; or why not. */
function parseSelector(body: unknown): MemoryErasureSelector | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'The body must be an object naming one of `factId`, `subject` or `conversationId`';
  }
  const b = body as Record<string, unknown>;
  const named = ['factId', 'subject', 'conversationId'].filter((k) => b[k] !== undefined);
  if (named.length !== 1) {
    return 'Name exactly one of `factId`, `subject` (`{kind, id}`) or `conversationId`';
  }
  const unknown = Object.keys(b).filter(
    (k) => !['factId', 'subject', 'conversationId'].includes(k),
  );
  if (unknown.length > 0) return `Unknown field \`${unknown[0]}\``;
  if (b.factId !== undefined) {
    return isId(b.factId) ? { factId: b.factId } : '`factId` must be a non-empty string';
  }
  if (b.conversationId !== undefined) {
    return isId(b.conversationId)
      ? { conversationId: b.conversationId }
      : '`conversationId` must be a non-empty string';
  }
  const s = b.subject as { kind?: unknown; id?: unknown } | null;
  if (s === null || typeof s !== 'object') return '`subject` must be `{kind, id}`';
  if (s.kind === 'user') {
    return "Erasing a Kindgi user isn't offered: `subject.kind` must be `participant` (an app's end user) or `external`";
  }
  if (!SUBJECT_KINDS.includes(s.kind as (typeof SUBJECT_KINDS)[number])) {
    return '`subject.kind` must be `participant` or `external`';
  }
  if (!isId(s.id)) return '`subject.id` must be a non-empty string';
  return { subject: { kind: s.kind as (typeof SUBJECT_KINDS)[number], id: s.id } };
}

/** `{erasures: MemoryErasureLedgerEntry[]}`, as `GET /export` gave it; or why not. */
function parseLedger(body: unknown): MemoryErasureLedgerEntry[] | string {
  const list = (body as { erasures?: unknown } | null)?.erasures;
  if (!Array.isArray(list)) return 'The body must be `{erasures: [...]}`, as the export gave them';
  if (list.length > MAX_LEDGER) return `At most ${MAX_LEDGER} erasures per replay`;
  const out: MemoryErasureLedgerEntry[] = [];
  for (const [i, raw] of list.entries()) {
    const e = raw as Record<string, unknown> | null;
    const at = `erasures[${i}]`;
    if (e === null || typeof e !== 'object') return `${at} must be an object`;
    if (typeof e.id !== 'string' || !UUID.test(e.id)) return `${at}.id must be a uuid`;
    if (!SELECTOR_KINDS.includes(e.selectorKind as MemoryErasureSelectorKind)) {
      return `${at}.selectorKind must be one of ${SELECTOR_KINDS.join(', ')}`;
    }
    if (
      e.selectorHmac !== undefined &&
      (typeof e.selectorHmac !== 'string' || !/^[0-9a-f]{64}$/.test(e.selectorHmac))
    ) {
      return `${at}.selectorHmac must be 64 hex characters`;
    }
    if (e.keyId !== undefined && !isId(e.keyId)) return `${at}.keyId must be a string`;
    if (!isId(e.requestedBy)) return `${at}.requestedBy must be a string`;
    if (!STATUSES.includes(e.status as (typeof STATUSES)[number])) {
      return `${at}.status must be one of ${STATUSES.join(', ')}`;
    }
    for (const k of ['createdAt', 'completedAt'] as const) {
      const v = e[k];
      if (v === undefined && k === 'completedAt') continue;
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return `${at}.${k} must be a time`;
    }
    out.push({
      id: e.id,
      selectorKind: e.selectorKind as MemoryErasureSelectorKind,
      ...(typeof e.selectorHmac === 'string' && { selectorHmac: e.selectorHmac }),
      ...(typeof e.keyId === 'string' && { keyId: e.keyId }),
      requestedBy: e.requestedBy as string,
      status: e.status as (typeof STATUSES)[number],
      createdAt: e.createdAt as string,
      ...(typeof e.completedAt === 'string' && { completedAt: e.completedAt }),
    });
  }
  return out;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ApiTokenId, ProjectId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  API_TOKEN_ROLES,
  type ApiTokenRecord,
  type ApiTokenRole,
  type TokenAdmin,
} from '../token-admin.js';
import type { AppEnv } from '../types.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

/**
 * API keys: mint, list, read, revoke. Every route is tenant-admin only:
 * `admin` on the tenant when authorization is on, otherwise the
 * `tenant-admin` scope on the caller's token.
 *
 * A caller can only give a new key what it holds itself: every
 * capability it grants must be one of its own.
 */
export function tokensRouter(admin: TokenAdmin, authorizer?: Authorizer): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/*', requireTenantAdmin(authorizer));

  // ---------- POST / (mint) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error, requestId);
    const parsed = parseMintBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error, requestId);

    const held = new Set(c.get('capabilities') ?? []);
    const notHeld = parsed.value.capabilities.filter((cap) => !held.has(cap));
    if (notHeld.length > 0) {
      return fail(
        c,
        {
          code: 'permission-denied',
          message: `A key can only be given capabilities its minter holds; you don't hold: ${notHeld.join(', ')}`,
        },
        requestId,
      );
    }

    const createdBy = callerRef(c);
    const minted = await admin.mint({
      tenantId,
      role: parsed.value.role,
      capabilities: parsed.value.capabilities,
      ...(parsed.value.label !== undefined && { label: parsed.value.label }),
      ...(parsed.value.expiresAt !== undefined && { expiresAt: parsed.value.expiresAt }),
      ...(parsed.value.projectId !== undefined && { projectId: parsed.value.projectId }),
      ...(createdBy !== undefined && { createdBy }),
    });
    c.status(201);
    return c.json({ ...toWire(minted.record), token: minted.token });
  });

  // ---------- GET / (list, newest first; never secrets) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const rawCursor = c.req.query('cursor');
    let after: { createdAt: Date; tokenId: ApiTokenId } | undefined;
    if (rawCursor !== undefined) {
      const decoded = decodeCursor(rawCursor);
      if (decoded === null || Number.isNaN(Date.parse(decoded.createdAt))) {
        return fail(c, { code: 'bad-input', message: '`cursor` is not a valid cursor' }, requestId);
      }
      after = { createdAt: new Date(decoded.createdAt), tokenId: decoded.id as ApiTokenId };
    }
    const records = await admin.list({ tenantId, limit: limit + 1, ...(after && { after }) });
    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(0, limit) : records;
    const last = page[page.length - 1];
    return c.json({
      data: page.map(toWire),
      hasMore,
      ...(hasMore &&
        last !== undefined && {
          nextCursor: encodeCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.tokenId as unknown as string,
          }),
        }),
    });
  });

  // ---------- GET /:tokenId ----------
  r.get('/:tokenId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const tokenId = c.req.param('tokenId') as ApiTokenId;
    const record = await admin.get({ tenantId, tokenId });
    if (record === undefined) return notFound(c, tokenId, requestId);
    return c.json(toWire(record));
  });

  // ---------- POST /:tokenId/revoke ----------
  r.post('/:tokenId/revoke', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const tokenId = c.req.param('tokenId') as ApiTokenId;

    const outcome = await admin.revoke({ tenantId, tokenId });
    if (outcome.kind === 'not-found') return notFound(c, tokenId, requestId);
    return c.json({ tokenId: tokenId as unknown as string, revoked: true });
  });

  return r;
}

function requireTenantAdmin(authorizer: Authorizer | undefined): MiddlewareHandler<AppEnv> {
  if (authorizer !== undefined) {
    return async (c, next) => {
      const tenantId = c.get('tenantId') as TenantId;
      const mw = authorizer.authorize('admin', async () =>
        ref('tenant', tenantId as unknown as string),
      );
      return mw(c, next);
    };
  }
  return async (c, next) => {
    if (!(c.get('scopes') ?? []).includes('tenant-admin')) {
      return fail(
        c,
        { code: 'permission-denied', message: 'Managing API keys needs a tenant admin' },
        c.get('requestId'),
      );
    }
    await next();
    return;
  };
}

/** The caller as a principal reference: `user:<id>` or `service_account:<tokenId>`. */
function callerRef(c: Context<AppEnv>): string | undefined {
  const userId = c.get('userId');
  if (userId !== undefined) return `user:${userId as unknown as string}`;
  const tokenId = c.get('tokenId');
  if (tokenId !== undefined) return `service_account:${tokenId as unknown as string}`;
  return undefined;
}

function toWire(record: ApiTokenRecord): Record<string, unknown> {
  return {
    tokenId: record.tokenId as unknown as string,
    role: record.role,
    capabilities: record.capabilities,
    ...(record.label !== undefined && { label: record.label }),
    ...(record.projectId !== undefined && { projectId: record.projectId as unknown as string }),
    ...(record.createdBy !== undefined && { createdBy: record.createdBy }),
    createdAt: record.createdAt.toISOString(),
    ...(record.expiresAt !== undefined && { expiresAt: record.expiresAt.toISOString() }),
    ...(record.revokedAt !== undefined && { revokedAt: record.revokedAt.toISOString() }),
    ...(record.lastUsedAt !== undefined && { lastUsedAt: record.lastUsedAt.toISOString() }),
  };
}

type WireError = { readonly code: string; readonly message: string };

function fail(c: Context<AppEnv>, error: WireError, requestId: string): Response {
  c.status(statusFor(error.code) as never);
  return c.json(toWireError(error, requestId));
}

function notFound(c: Context<AppEnv>, tokenId: ApiTokenId, requestId: string): Response {
  return fail(
    c,
    { code: 'not-found', message: `No token with id ${tokenId as unknown as string}` },
    requestId,
  );
}

/**
 * An empty body is allowed on mint. Parse when the caller declared a JSON
 * body or sent any content, so a plain `POST` with no body still works.
 */
async function readJsonBody(
  c: Context<AppEnv>,
): Promise<{ kind: 'ok'; value: unknown } | { kind: 'err'; error: WireError }> {
  const hasBody =
    (c.req.header('content-type') ?? '').includes('json') ||
    (c.req.header('content-length') !== undefined && c.req.header('content-length') !== '0');
  if (!hasBody) return { kind: 'ok', value: {} };
  try {
    const text = await c.req.text();
    return { kind: 'ok', value: text.length > 0 ? JSON.parse(text) : {} };
  } catch {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: 'Request body must be valid JSON' },
    };
  }
}

type ParsedMintBody = {
  readonly role: ApiTokenRole;
  readonly capabilities: readonly string[];
  readonly label?: string;
  readonly expiresAt?: Date;
  readonly projectId?: ProjectId;
};

type Parsed<T> = { kind: 'ok'; value: T } | { kind: 'err'; error: WireError };

const MAX_CAPABILITY_LENGTH = 100;

function badInput(message: string): { kind: 'err'; error: WireError } {
  return { kind: 'err', error: { code: 'bad-input', message } };
}

function parseMintBody(body: unknown): Parsed<ParsedMintBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const b = body as Record<string, unknown>;

  const role = parseRole(b.role);
  if (role.kind === 'err') return role;
  const capabilities = parseCapabilities(b.capabilities);
  if (capabilities.kind === 'err') return capabilities;
  const out: {
    role: ApiTokenRole;
    capabilities: readonly string[];
    label?: string;
    expiresAt?: Date;
    projectId?: ProjectId;
  } = { role: role.value, capabilities: capabilities.value };

  if (b.label !== undefined) {
    if (typeof b.label !== 'string') return badInput('`label` must be a string');
    out.label = b.label;
  }
  if (b.expiresAt !== undefined) {
    if (typeof b.expiresAt !== 'string') return badInput('`expiresAt` must be an ISO date string');
    const parsed = new Date(b.expiresAt);
    if (Number.isNaN(parsed.getTime())) return badInput('`expiresAt` is not a valid ISO date');
    out.expiresAt = parsed;
  }
  if (b.projectId !== undefined) {
    if (typeof b.projectId !== 'string') {
      return badInput('`projectId` must be a string when supplied');
    }
    out.projectId = b.projectId as ProjectId;
  }
  return { kind: 'ok', value: out };
}

/** `role`: `admin` | `member`; `member` when absent (least privilege). */
function parseRole(raw: unknown): Parsed<ApiTokenRole> {
  if (raw === undefined) return { kind: 'ok', value: 'member' };
  if (typeof raw !== 'string' || !API_TOKEN_ROLES.includes(raw as ApiTokenRole)) {
    return badInput(`\`role\` must be one of: ${API_TOKEN_ROLES.join(', ')}`);
  }
  return { kind: 'ok', value: raw as ApiTokenRole };
}

/** `capabilities`: distinct non-empty strings; none when absent. */
function parseCapabilities(raw: unknown): Parsed<readonly string[]> {
  if (raw === undefined) return { kind: 'ok', value: [] };
  if (!Array.isArray(raw)) return badInput('`capabilities` must be an array of strings');
  const out: string[] = [];
  for (const cap of raw) {
    if (typeof cap !== 'string' || cap.length === 0 || cap.length > MAX_CAPABILITY_LENGTH) {
      return badInput(
        `\`capabilities\` must hold non-empty strings of at most ${MAX_CAPABILITY_LENGTH} characters`,
      );
    }
    if (!out.includes(cap)) out.push(cap);
  }
  return { kind: 'ok', value: out };
}

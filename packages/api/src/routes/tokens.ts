// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import type { ApiTokenId, ProjectId, TenantId } from '@kindgi/types';

import { callerPrincipal, callerRef, isTenantAdmin, principalToWire } from '../caller.js';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  API_TOKEN_ROLES,
  type ApiTokenRecord,
  type ApiTokenRole,
  type TokenAdmin,
  type TokenPrincipal,
} from '../token-admin.js';
import type { AppEnv } from '../types.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

/**
 * API keys: mint, list, read, revoke. A key acts for one principal (a
 * person or a service account) with that principal's grants; its role is
 * a ceiling under them and its project a narrowing.
 *
 * - **Your own keys:** a person, or a service account's key, may mint,
 *   list, read and revoke the keys that act for them.
 * - **Someone else's:** only a tenant admin (`admin` on the tenant when
 *   authorization is on, otherwise the `tenant-admin` scope) mints keys
 *   for another principal, and sees and revokes every key. A tenant admin
 *   whose token names no principal mints, as before principals, keys
 *   that are their own service account.
 * - **What a new key may hold:** an `admin` key needs a tenant admin
 *   minting it (and, for someone else, a principal that is one: the store
 *   refuses `role-exceeds-principal`). Every capability granted must be
 *   one the minter holds. A minter narrowed to a project mints only keys
 *   narrowed to the same project.
 */
export function tokensRouter(admin: TokenAdmin, authorizer?: Authorizer): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/*', requireOwnerOrAdmin(authorizer));

  // ---------- POST / (mint) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error, requestId);
    const parsed = parseMintBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error, requestId);

    const owner = keyOwner(c);
    const principal = parsed.value.for ?? owner;
    const refused = await mintRefusal(c, authorizer, owner, principal, parsed.value);
    if (refused !== undefined) return fail(c, refused, requestId);

    const createdBy = callerRef(c);
    const minted = await admin.mint({
      tenantId,
      ...(principal !== undefined && { principal }),
      role: parsed.value.role,
      capabilities: parsed.value.capabilities,
      ...(parsed.value.label !== undefined && { label: parsed.value.label }),
      ...(parsed.value.expiresAt !== undefined && { expiresAt: parsed.value.expiresAt }),
      ...(parsed.value.projectId !== undefined && { projectId: parsed.value.projectId }),
      ...(createdBy !== undefined && { createdBy }),
    });
    if (!('token' in minted)) {
      return fail(c, { code: minted.kind, message: minted.message }, requestId);
    }
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
    const filter = parsePrincipalQuery(c.req.query('principal'));
    if (filter.kind === 'err') return fail(c, filter.error, requestId);
    // An admin sees every key (or one principal's); anyone else, their own.
    const principal = (await isTenantAdmin(c, authorizer)) ? filter.value : keyOwner(c);
    const records = await admin.list({
      tenantId,
      limit: limit + 1,
      ...(principal !== undefined && { principal }),
      ...(after && { after }),
    });
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
    const tokenId = c.req.param('tokenId') as ApiTokenId;
    const record = await visibleKey(c, admin, authorizer, tokenId);
    if (record === undefined) return notFound(c, tokenId, requestId);
    return c.json(toWire(record));
  });

  // ---------- POST /:tokenId/revoke ----------
  r.post('/:tokenId/revoke', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const tokenId = c.req.param('tokenId') as ApiTokenId;
    // Someone else's key reads as missing, as it does for `get`.
    if ((await visibleKey(c, admin, authorizer, tokenId)) === undefined) {
      return notFound(c, tokenId, requestId);
    }
    const revokedBy = callerRef(c);
    const outcome = await admin.revoke({
      tenantId,
      tokenId,
      ...(revokedBy !== undefined && { revokedBy }),
    });
    if (outcome.kind === 'not-found') return notFound(c, tokenId, requestId);
    return c.json({ tokenId: tokenId as unknown as string, revoked: true });
  });

  return r;
}

/** A caller with keys of their own, or a tenant admin. */
function requireOwnerOrAdmin(authorizer: Authorizer | undefined): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (keyOwner(c) === undefined && !(await isTenantAdmin(c, authorizer))) {
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

/**
 * Whom the caller's own keys act for: the person, or the service account
 * the caller's key acts for. A token naming neither (a key from before
 * principals, a static token) has no keys of its own.
 */
function keyOwner(c: Context<AppEnv>): TokenPrincipal | undefined {
  const caller = callerPrincipal(c);
  if (caller?.kind === 'service-account' && c.get('serviceAccountId') === undefined) {
    return undefined;
  }
  return caller;
}

function samePrincipal(a: TokenPrincipal, b: TokenPrincipal | undefined): boolean {
  if (b === undefined) return false;
  if (a.kind === 'user') return b.kind === 'user' && b.userId === a.userId;
  return b.kind === 'service-account' && b.serviceAccountId === a.serviceAccountId;
}

/** Why the route refuses this mint before the store sees it, if it does. */
async function mintRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  owner: TokenPrincipal | undefined,
  principal: TokenPrincipal | undefined,
  body: ParsedMintBody,
): Promise<WireError | undefined> {
  const forSomeoneElse = principal !== undefined && !samePrincipal(principal, owner);
  if ((forSomeoneElse || body.role === 'admin') && !(await isTenantAdmin(c, authorizer))) {
    return {
      code: 'permission-denied',
      message: forSomeoneElse
        ? 'Only a tenant admin mints keys for someone else'
        : 'Only a tenant admin mints an admin key',
    };
  }
  const held = new Set(c.get('capabilities') ?? []);
  const notHeld = body.capabilities.filter((cap) => !held.has(cap));
  if (notHeld.length > 0) {
    return {
      code: 'permission-denied',
      message: `A key can only be given capabilities its minter holds; you don't hold: ${notHeld.join(', ')}`,
    };
  }
  const narrowedTo = c.get('tokenProjectId');
  if (narrowedTo !== undefined && body.projectId !== (narrowedTo as unknown as ProjectId)) {
    return {
      code: 'key-project-mismatch',
      message: `Your key is limited to project ${narrowedTo}: a key it mints must be limited to it too`,
    };
  }
  return undefined;
}

/** A key the caller may see: any, for a tenant admin; otherwise only their own. */
async function visibleKey(
  c: Context<AppEnv>,
  admin: TokenAdmin,
  authorizer: Authorizer | undefined,
  tokenId: ApiTokenId,
): Promise<ApiTokenRecord | undefined> {
  const tenantId = c.get('tenantId') as TenantId;
  const record = await admin.get({ tenantId, tokenId });
  if (record === undefined) return undefined;
  if (await isTenantAdmin(c, authorizer)) return record;
  return record.principal !== undefined && samePrincipal(record.principal, keyOwner(c))
    ? record
    : undefined;
}

function toWire(record: ApiTokenRecord): Record<string, unknown> {
  return {
    tokenId: record.tokenId as unknown as string,
    ...(record.principal !== undefined && { principal: principalToWire(record.principal) }),
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
  readonly for?: TokenPrincipal;
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
  const principal = parseFor(b.for);
  if (principal.kind === 'err') return principal;
  const out: {
    for?: TokenPrincipal;
    role: ApiTokenRole;
    capabilities: readonly string[];
    label?: string;
    expiresAt?: Date;
    projectId?: ProjectId;
  } = {
    ...(principal.value !== undefined && { for: principal.value }),
    role: role.value,
    capabilities: capabilities.value,
  };

  if (b.label !== undefined) {
    if (typeof b.label !== 'string') return badInput('`label` must be a string');
    out.label = b.label;
  }
  if (b.expiresAt !== undefined) {
    const expiresAt = parseExpiresAt(b.expiresAt);
    if (expiresAt.kind === 'err') return expiresAt;
    out.expiresAt = expiresAt.value;
  }
  if (b.projectId !== undefined) {
    if (typeof b.projectId !== 'string') {
      return badInput('`projectId` must be a string when supplied');
    }
    out.projectId = b.projectId as ProjectId;
  }
  return { kind: 'ok', value: out };
}

/** `expiresAt`: an ISO date string. */
function parseExpiresAt(raw: unknown): Parsed<Date> {
  if (typeof raw !== 'string') return badInput('`expiresAt` must be an ISO date string');
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return badInput('`expiresAt` is not a valid ISO date');
  return { kind: 'ok', value: parsed };
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

/** `for`, when present: whom the key acts for. */
function parseFor(raw: unknown): Parsed<TokenPrincipal | undefined> {
  return raw === undefined ? { kind: 'ok', value: undefined } : parsePrincipalBody(raw);
}

/** `for`: `{kind: 'user' | 'service-account', id}`. */
function parsePrincipalBody(raw: unknown): Parsed<TokenPrincipal> {
  const b = (raw ?? {}) as { kind?: unknown; id?: unknown };
  if (typeof b.id !== 'string' || b.id.length === 0) {
    return badInput('`for.id` must be the id of a person or a service account');
  }
  if (b.kind === 'user') return { kind: 'ok', value: { kind: 'user', userId: b.id } };
  if (b.kind === 'service-account') {
    return { kind: 'ok', value: { kind: 'service-account', serviceAccountId: b.id } };
  }
  return badInput("`for.kind` must be 'user' or 'service-account'");
}

/** `?principal=user:<id>` or `?principal=service-account:<id>`: one principal's keys (admins). */
function parsePrincipalQuery(raw: string | undefined): Parsed<TokenPrincipal | undefined> {
  if (raw === undefined || raw === '') return { kind: 'ok', value: undefined };
  const colon = raw.indexOf(':');
  const kind = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (colon <= 0 || id === '') {
    return badInput('`principal` is `user:<id>` or `service-account:<id>`');
  }
  return parsePrincipalBody({ kind, id });
}

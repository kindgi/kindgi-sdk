// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { Fact, MemoryReaders, MemoryScope } from '@kindgi/memory';
import type { FactId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  MemoryBinding,
  MemoryFactChangeOutcome,
  MemoryRetrievalHit,
} from '../memory-binding.js';
import type { AppEnv } from '../types.js';
import {
  type MemoryAccessDeps,
  callerAttribution,
  callerRef,
  memoryReadersFor,
  memoryWriteProblem,
} from './memory-access.js';
import {
  parseScopeParam,
  parseTime,
  parseVersion,
  validateRetrieveIntent,
  validateSupersedeBody,
  validateWriteFactBody,
} from './memory-parse.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Memory resource routes.
 *
 * Storage is caller-plugged via `MemoryBinding`. The API package does
 * not own memory persistence, retrieval, or embeddings: deployments
 * wire a binding that wraps the memory subsystem alongside their own
 * `EmbeddingProviderRegistry` and per-type retrieval policies.
 *
 * A fact keeps its id across revisions: supersede writes the next one,
 * delete tombstones it (the retention sweep removes it later), verify
 * marks it verified. Every read sees only what the caller may
 * (`memory-access.ts`): the binding applies it inside its query, and a
 * fact the caller can't see is not found. Every write is checked against
 * the scope it names.
 */
export function memoryRouter(binding: MemoryBinding, access: MemoryAccessDeps = {}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- GET /facts (list, cursor-paginated) ----------
  r.get('/facts', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const typeRaw = c.req.query('type');
    const scopeRaw = c.req.query('scope');

    let scope: Partial<MemoryScope> | undefined;
    if (scopeRaw !== undefined && scopeRaw.length > 0) {
      const parsed = parseScopeParam(scopeRaw);
      if (parsed === null) {
        return fail(c, 'bad-input', 'Query parameter `scope` must be a JSON object');
      }
      scope = parsed;
    }
    if (scopeNamesOtherTenant(scope, tenantId)) return failScopeMismatch(c);
    const asOf = parseTime(c.req.query('asOf'), 'asOf');
    if (asOf.kind === 'err') return fail(c, 'bad-input', asOf.message);

    // `?scopeKind` + `?scopeId` + `?inherit` narrow by the platform scope
    // (`platformScope`); `?scope=` is the memory scope. Both coexist.
    const scopeParsed = parseScopeParams(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const page = await binding.listFacts({
      tenantId,
      readers: await memoryReadersFor(c, access),
      limit,
      ...(asOf.value !== undefined && { asOf: asOf.value }),
      ...(cursorRaw !== undefined &&
        cursorRaw.length > 0 && {
          cursor: cursorRaw as import('@kindgi/types').Cursor,
        }),
      ...(typeRaw !== undefined && typeRaw.length > 0 && { type: typeRaw }),
      ...(scope !== undefined && { scope }),
      ...(scopeParsed.scope !== undefined && { platformScope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
    });
    return c.json({
      data: page.data.map(serializeFact),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /facts/:factId (?version | ?asOf) ----------
  r.get('/facts/:factId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const factId = c.req.param('factId') as FactId;
    const version = parseVersion(c.req.query('version'), 'version');
    if (version.kind === 'err') return fail(c, 'bad-input', version.message);
    const asOf = parseTime(c.req.query('asOf'), 'asOf');
    if (asOf.kind === 'err') return fail(c, 'bad-input', asOf.message);
    const fact = await binding.getFact({
      tenantId,
      factId,
      readers: await memoryReadersFor(c, access),
      ...(version.value !== undefined && { version: version.value }),
      ...(asOf.value !== undefined && { asOf: asOf.value }),
    });
    if (fact === null) return failNotFound(c, factId);
    return c.json(serializeFact(fact));
  });

  // ---------- GET /facts/:factId/revisions ----------
  r.get('/facts/:factId/revisions', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const factId = c.req.param('factId') as FactId;
    if (binding.listRevisions === undefined) return unsupported(c, 'fact history');
    const revisions = await binding.listRevisions({
      tenantId,
      factId,
      readers: await memoryReadersFor(c, access),
    });
    if (revisions === null) return failNotFound(c, factId);
    return c.json({ data: revisions.map(serializeFact) });
  });

  // ---------- POST /facts (write) ----------
  r.post('/facts', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readObject(c);
    if (typeof body === 'string') return fail(c, 'bad-input', body);
    const validation = validateWriteFactBody(body);
    if (validation.kind === 'err') return fail(c, 'bad-input', validation.message);
    const { scope, ...rest } = validation.value;
    if (scopeNamesOtherTenant(scope, tenantId)) return failScopeMismatch(c);
    const refused = await memoryWriteProblem(c, access, scope);
    if (refused !== undefined) return fail(c, 'permission-denied', refused);

    const outcome = await binding.writeFact({
      tenantId,
      scope,
      ...rest,
      attributedTo: callerAttribution(c),
    });
    if (outcome.kind === 'embedding-unavailable') return fail(c, 'bad-input', outcome.message);
    if (outcome.kind === 'error') return fail(c, outcome.code, outcome.message);
    c.status(201);
    return c.json(serializeFact(outcome.fact));
  });

  // ---------- POST /facts/:factId/supersede ----------
  r.post('/facts/:factId/supersede', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const factId = c.req.param('factId') as FactId;
    const body = await readObject(c);
    if (typeof body === 'string') return fail(c, 'bad-input', body);
    const validation = validateSupersedeBody(body);
    if (validation.kind === 'err') return fail(c, 'bad-input', validation.message);
    const target = await writableFact(c, factId);
    if (target.kind === 'response') return target.response;
    const outcome = await binding.supersedeFact({
      tenantId,
      factId,
      readers: target.readers,
      ...validation.value,
      attributedTo: callerAttribution(c),
    });
    return changeResponse(c, factId, outcome);
  });

  // ---------- DELETE /facts/:factId (tombstone) ----------
  r.delete('/facts/:factId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const factId = c.req.param('factId') as FactId;
    if (binding.deleteFact === undefined) return unsupported(c, 'deleting facts');
    const expectVersion = parseVersion(c.req.query('expectVersion'), 'expectVersion');
    if (expectVersion.kind === 'err') return fail(c, 'bad-input', expectVersion.message);
    const target = await writableFact(c, factId);
    if (target.kind === 'response') return target.response;
    const outcome = await binding.deleteFact({
      tenantId,
      factId,
      readers: target.readers,
      by: callerRef(c),
      ...(expectVersion.value !== undefined && { expectVersion: expectVersion.value }),
    });
    return changeResponse(c, factId, outcome);
  });

  // ---------- POST /facts/:factId/verify ----------
  r.post('/facts/:factId/verify', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const factId = c.req.param('factId') as FactId;
    if (binding.verifyFact === undefined) return unsupported(c, 'verifying facts');
    const body = await readObject(c, { emptyIsObject: true });
    if (typeof body === 'string') return fail(c, 'bad-input', body);
    const expectVersion = parseVersion(body.expectVersion, 'expectVersion');
    if (expectVersion.kind === 'err') return fail(c, 'bad-input', expectVersion.message);
    const target = await writableFact(c, factId);
    if (target.kind === 'response') return target.response;
    const outcome = await binding.verifyFact({
      tenantId,
      factId,
      readers: target.readers,
      by: callerRef(c),
      ...(expectVersion.value !== undefined && { expectVersion: expectVersion.value }),
    });
    return changeResponse(c, factId, outcome);
  });

  // ---------- POST /retrieve ----------
  r.post('/retrieve', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readObject(c);
    if (typeof body === 'string') return fail(c, 'bad-input', body);
    const validation = validateRetrieveIntent(body);
    if (validation.kind === 'err') return fail(c, 'bad-input', validation.message);
    if (scopeNamesOtherTenant(validation.value.scope, tenantId)) return failScopeMismatch(c);
    const outcome = await binding.retrieve({
      tenantId,
      intent: validation.value,
      readers: await memoryReadersFor(c, access),
    });
    if (outcome.kind === 'embedding-unavailable') return fail(c, 'bad-input', outcome.message);
    if (outcome.kind === 'error') return fail(c, outcome.code, outcome.message);
    return c.json({ results: outcome.results.map(serializeRetrievalHit) });
  });

  /**
   * The fact the caller may see and change: its current revision is read
   * (as the caller sees it), and the caller must be allowed to write in
   * its scope.
   */
  async function writableFact(
    c: Context<AppEnv>,
    factId: FactId,
  ): Promise<
    | { readonly kind: 'ok'; readonly readers: MemoryReaders }
    | { readonly kind: 'response'; readonly response: Response }
  > {
    const tenantId = c.get('tenantId') as TenantId;
    const readers = await memoryReadersFor(c, access);
    const current = await binding.getFact({ tenantId, factId, readers });
    if (current === null) return { kind: 'response', response: failNotFound(c, factId) };
    const refused = await memoryWriteProblem(c, access, current.scope);
    if (refused !== undefined) {
      return { kind: 'response', response: fail(c, 'permission-denied', refused) };
    }
    return { kind: 'ok', readers };
  }

  return r;
}

// -------------------- responses --------------------

function fail(c: Context<AppEnv>, code: string, message: string, extra = {}): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message, ...extra }, c.get('requestId')));
}

function failNotFound(c: Context<AppEnv>, factId: FactId): Response {
  return fail(c, 'fact-not-found', `No fact with id "${factId as unknown as string}"`, {
    factId: factId as unknown as string,
  });
}

function failScopeMismatch(c: Context<AppEnv>): Response {
  return fail(c, 'scope-mismatch', '`scope.tenantId` does not match the caller tenant.');
}

function unsupported(c: Context<AppEnv>, what: string): Response {
  return fail(c, 'memory-operation-unsupported', `This runtime's memory doesn't support ${what}.`);
}

function changeResponse(
  c: Context<AppEnv>,
  factId: FactId,
  outcome: MemoryFactChangeOutcome,
): Response {
  switch (outcome.kind) {
    case 'ok':
      return c.json(serializeFact(outcome.fact));
    case 'not-found':
      return failNotFound(c, factId);
    case 'fact-changed':
      return fail(
        c,
        'fact-changed',
        `Fact "${factId as unknown as string}" is at revision ${outcome.current.version} now: read it again, then retry.`,
        { factId: factId as unknown as string, currentVersion: outcome.current.version },
      );
    case 'legal-hold':
      return fail(c, 'legal-hold', outcome.message, { factId: factId as unknown as string });
    case 'error':
      return fail(c, outcome.code, outcome.message);
  }
}

async function readObject(
  c: Context<AppEnv>,
  options: { readonly emptyIsObject?: boolean } = {},
): Promise<Record<string, unknown> | string> {
  const text = await c.req.text();
  if (text.trim() === '' && options.emptyIsObject === true) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return 'Request body must be valid JSON';
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be an object';
  }
  return body as Record<string, unknown>;
}

// -------------------- serialization --------------------

function serializeFact(f: Fact): Record<string, unknown> {
  return {
    id: f.id as unknown as string,
    ...(f.revisionId !== undefined && { revisionId: f.revisionId }),
    type: f.type,
    scope: f.scope,
    version: f.version,
    createdAt: f.createdAt as unknown as string,
    ...(f.updatedAt !== undefined && { updatedAt: f.updatedAt as unknown as string }),
    ...(f.content !== undefined && { content: f.content }),
    ...(f.contentRef !== undefined && { contentRef: f.contentRef }),
    ...(f.contentHash !== undefined && { contentHash: f.contentHash }),
    ...(f.size !== undefined && { size: f.size }),
    ...(f.embeddingModel !== undefined && { embeddingModel: f.embeddingModel }),
    ...(f.retention !== undefined && { retention: f.retention }),
    ...(f.source !== undefined && { source: f.source }),
    ...(f.causedByLogId !== undefined && { causedByLogId: f.causedByLogId }),
    ...(f.supersedes !== undefined && { supersedes: f.supersedes as unknown as string }),
    ...(f.trust !== undefined && { trust: f.trust }),
    ...(f.verifiedBy !== undefined && { verifiedBy: f.verifiedBy }),
    ...(f.verifiedAt !== undefined && { verifiedAt: f.verifiedAt }),
    ...(f.attributedTo !== undefined && { attributedTo: f.attributedTo }),
    ...(f.generatedBy !== undefined && { generatedBy: f.generatedBy }),
    ...(f.subjects !== undefined && { subjects: f.subjects }),
    ...(f.validFrom !== undefined && { validFrom: f.validFrom }),
    ...(f.validUntil !== undefined && { validUntil: f.validUntil }),
    ...(f.observedAt !== undefined && { observedAt: f.observedAt }),
    ...(f.invalidatedAt !== undefined && { invalidatedAt: f.invalidatedAt }),
    ...(f.invalidatedBy !== undefined && { invalidatedBy: f.invalidatedBy }),
    ...(f.invalidationReason !== undefined && { invalidationReason: f.invalidationReason }),
    ...(f.review !== undefined && { review: f.review }),
  };
}

function serializeRetrievalHit(h: MemoryRetrievalHit): Record<string, unknown> {
  return {
    fact: serializeFact(h.fact),
    ...(h.score !== undefined && { score: h.score }),
  };
}

// -------------------- request parsing --------------------

/**
 * A memory scope in a request may name a tenant; it must be the caller's
 * (derived from the token). Same rule as the secrets, env and policy
 * routes: a request can never read or write another tenant's memory.
 */
function scopeNamesOtherTenant(
  scope: Partial<MemoryScope> | undefined,
  tenantId: TenantId,
): boolean {
  return scope?.tenantId !== undefined && scope.tenantId !== tenantId;
}

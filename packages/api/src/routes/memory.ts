// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { Fact, MemoryScope, Retention } from '@kindgi/memory';
import type { FactId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { MemoryBinding, MemoryRetrievalHit, MemoryRetrieveIntent } from '../memory-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Memory resource routes.
 *
 * Storage is caller-plugged via `MemoryBinding`. The API package does
 * not own memory persistence, retrieval, or embeddings — deployments
 * wire a binding that wraps the memory subsystem alongside their own
 * `EmbeddingProviderRegistry` and per-type retrieval policies.
 *
 * Facts are append-only: supersession replaces delete. Physical removal
 * is left to the retention sweep.
 */
export function memoryRouter(binding: MemoryBinding): Hono<AppEnv> {
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
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: 'Query parameter `scope` must be a JSON object' },
            requestId,
          ),
        );
      }
      scope = parsed;
    }
    if (scopeNamesOtherTenant(scope, tenantId)) {
      c.status(statusFor('scope-mismatch') as never);
      return c.json(toWireError(SCOPE_MISMATCH, requestId));
    }

    // Thread the ?scopeKind + ?scopeId + ?inherit
    // triplet into `platformScope` (NOT `scope`). The JSON-encoded
    // `?scope=` query param + `scope: Partial<MemoryScope>` field above
    // are a separate filter — both coexist by design.
    const scopeParsed = parseScopeParams(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const page = await binding.listFacts({
      tenantId,
      limit,
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

  // ---------- GET /facts/:factId ----------
  r.get('/facts/:factId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const factId = c.req.param('factId') as FactId;

    const fact = await binding.getFact({ tenantId, factId });
    if (fact === null) {
      c.status(statusFor('fact-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'fact-not-found',
            message: `No fact with id "${factId as unknown as string}"`,
            factId: factId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeFact(fact));
  });

  // ---------- POST /facts (write) ----------
  r.post('/facts', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }

    const validation = validateWriteFactBody(body as Record<string, unknown>);
    if (validation.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: validation.message }, requestId));
    }
    const { type, scope, content, retention, contentHash } = validation.value;
    if (scopeNamesOtherTenant(scope, tenantId)) {
      c.status(statusFor('scope-mismatch') as never);
      return c.json(toWireError(SCOPE_MISMATCH, requestId));
    }

    const outcome = await binding.writeFact({
      tenantId,
      type,
      scope,
      content,
      ...(retention !== undefined && { retention }),
      ...(contentHash !== undefined && { contentHash }),
    });
    if (outcome.kind === 'embedding-unavailable') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: outcome.message }, requestId));
    }
    if (outcome.kind === 'error') {
      c.status(statusFor(outcome.code) as never);
      return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
    }
    c.status(201);
    return c.json(serializeFact(outcome.fact));
  });

  // ---------- POST /facts/:factId/supersede ----------
  r.post('/facts/:factId/supersede', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const factId = c.req.param('factId') as FactId;

    const outcome = await binding.supersedeFact({ tenantId, factId });
    if (!outcome.superseded) {
      c.status(statusFor('fact-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'fact-not-found',
            message: `No fact with id "${factId as unknown as string}" to supersede`,
            factId: factId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json({
      factId: factId as unknown as string,
      superseded: true,
    });
  });

  // ---------- POST /retrieve ----------
  r.post('/retrieve', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }

    const validation = validateRetrieveIntent(body as Record<string, unknown>);
    if (validation.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: validation.message }, requestId));
    }

    if (scopeNamesOtherTenant(validation.value.scope, tenantId)) {
      c.status(statusFor('scope-mismatch') as never);
      return c.json(toWireError(SCOPE_MISMATCH, requestId));
    }

    const outcome = await binding.retrieve({ tenantId, intent: validation.value });
    if (outcome.kind === 'embedding-unavailable') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: outcome.message }, requestId));
    }
    if (outcome.kind === 'error') {
      c.status(statusFor(outcome.code) as never);
      return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
    }
    return c.json({
      results: outcome.results.map(serializeRetrievalHit),
    });
  });

  return r;
}

// -------------------- serialization --------------------

function serializeFact(f: Fact): Record<string, unknown> {
  return {
    id: f.id as unknown as string,
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
  };
}

function serializeRetrievalHit(h: MemoryRetrievalHit): Record<string, unknown> {
  return {
    fact: serializeFact(h.fact),
    ...(h.score !== undefined && { score: h.score }),
  };
}

// -------------------- request parsing --------------------

const SCOPE_MISMATCH = {
  code: 'scope-mismatch',
  message: '`scope.tenantId` does not match the caller tenant.',
} as const;

/**
 * A memory scope in a request may name a tenant; it must be the caller's
 * (derived from the token). Same rule as the secrets, env and policy
 * routes — a request can never read or write another tenant's memory.
 */
function scopeNamesOtherTenant(
  scope: Partial<MemoryScope> | undefined,
  tenantId: TenantId,
): boolean {
  return scope?.tenantId !== undefined && scope.tenantId !== tenantId;
}

function parseScopeParam(raw: string): Partial<MemoryScope> | null {
  try {
    const decoded = JSON.parse(raw) as unknown;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    return decoded as Partial<MemoryScope>;
  } catch {
    return null;
  }
}

// -------------------- validators --------------------

type ValidationResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

interface ValidatedWriteFactBody {
  readonly type: string;
  readonly scope: MemoryScope;
  readonly content: unknown;
  readonly retention?: Retention;
  readonly contentHash?: string;
}

function validateWriteFactBody(
  body: Record<string, unknown>,
): ValidationResult<ValidatedWriteFactBody> {
  const type = body.type;
  if (typeof type !== 'string' || type.length === 0) {
    return { kind: 'err', message: 'Field `type` must be a non-empty string' };
  }
  const rawScope = body.scope;
  if (rawScope === null || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    return { kind: 'err', message: 'Field `scope` must be an object' };
  }
  const scope = rawScope as MemoryScope;
  if (typeof (scope as { tenantId?: unknown }).tenantId !== 'string') {
    return { kind: 'err', message: 'Field `scope.tenantId` must be a string' };
  }
  if (!('content' in body)) {
    return { kind: 'err', message: 'Field `content` is required' };
  }
  const rawRetention = body.retention;
  let retention: Retention | undefined;
  if (rawRetention !== undefined) {
    if (rawRetention === null || typeof rawRetention !== 'object' || Array.isArray(rawRetention)) {
      return { kind: 'err', message: 'Field `retention` must be an object when present' };
    }
    retention = rawRetention as Retention;
  }
  const rawContentHash = body.contentHash;
  let contentHash: string | undefined;
  if (rawContentHash !== undefined) {
    if (typeof rawContentHash !== 'string' || rawContentHash.length === 0) {
      return {
        kind: 'err',
        message: 'Field `contentHash` must be a non-empty string when present',
      };
    }
    contentHash = rawContentHash;
  }
  return {
    kind: 'ok',
    value: {
      type,
      scope,
      content: body.content,
      ...(retention !== undefined && { retention }),
      ...(contentHash !== undefined && { contentHash }),
    },
  };
}

function validateRetrieveIntent(
  body: Record<string, unknown>,
): ValidationResult<MemoryRetrieveIntent> {
  const mode = body.mode;
  if (mode !== 'list' && mode !== 'keyword' && mode !== 'semantic' && mode !== 'both') {
    return {
      kind: 'err',
      message: 'Field `mode` must be one of "list", "keyword", "semantic", "both"',
    };
  }
  let query: string | undefined;
  const rawQuery = body.query;
  if (rawQuery !== undefined) {
    if (typeof rawQuery !== 'string') {
      return { kind: 'err', message: 'Field `query` must be a string when present' };
    }
    query = rawQuery;
  }
  if ((mode === 'keyword' || mode === 'semantic' || mode === 'both') && query === undefined) {
    return {
      kind: 'err',
      message: `Field \`query\` is required when \`mode\` is "${mode}"`,
    };
  }
  let type: string | undefined;
  const rawType = body.type;
  if (rawType !== undefined) {
    if (typeof rawType !== 'string' || rawType.length === 0) {
      return { kind: 'err', message: 'Field `type` must be a non-empty string when present' };
    }
    type = rawType;
  }
  let scope: Partial<MemoryScope> | undefined;
  const rawScope = body.scope;
  if (rawScope !== undefined) {
    if (rawScope === null || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
      return { kind: 'err', message: 'Field `scope` must be an object when present' };
    }
    scope = rawScope as Partial<MemoryScope>;
  }
  let limit: number | undefined;
  const rawLimit = body.limit;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1) {
      return { kind: 'err', message: 'Field `limit` must be a positive number when present' };
    }
    limit = Math.floor(rawLimit);
  }
  let embeddingModel: string | undefined;
  const rawEmbeddingModel = body.embeddingModel;
  if (rawEmbeddingModel !== undefined) {
    if (typeof rawEmbeddingModel !== 'string' || rawEmbeddingModel.length === 0) {
      return {
        kind: 'err',
        message: 'Field `embeddingModel` must be a non-empty string when present',
      };
    }
    embeddingModel = rawEmbeddingModel;
  }
  return {
    kind: 'ok',
    value: {
      mode,
      ...(query !== undefined && { query }),
      ...(type !== undefined && { type }),
      ...(scope !== undefined && { scope }),
      ...(limit !== undefined && { limit }),
      ...(embeddingModel !== undefined && { embeddingModel }),
    },
  };
}

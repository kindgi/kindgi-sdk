// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { tuplesForCreate } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, TenantId } from '@kindgi/types';
import { makeEnvName } from '@kindgi/types';

import type { EnvBinding, EnvRecord, EnvSetOutcome } from '../env-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { capabilityRefusal } from './denied.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams, queryScopeResourceRef } from './scope-params.js';
import { auditWrite } from './write-audit.js';

/**
 * `/v1/env/*` — HTTP surface for `EnvBinding`. Four endpoints, one
 * binding, one uniform scope + envName + name key shape.
 *
 * Wire rules:
 *   - `envName` required on every request; missing → 400 `env-name-required`.
 *   - `scopeKind` required on every request; missing → 400 `scope-kind-required`.
 *   - `scopeId` cross-field validation (tenant forbids, org+project require).
 *   - Body-vs-query mismatch on writes → 400 `env-name-mismatch` /
 *     `scope-mismatch`.
 *   - `PUT /v1/env/:name` accepts `Idempotency-Key` (middleware handles).
 *
 * Env is non-sensitive by definition — `value` returns on every
 * read path. Capability gate: `env:write` for PUT + DELETE; unset →
 * 403 `permission-denied` (fail-closed).
 */
/**
 * `auditEvents`: where each write is recorded (`env-set`, `env-deleted`): the
 * caller, the scope, the request and the backend's answer, never a value.
 * Absent: none.
 */
export function envRouter(
  envBinding: EnvBinding,
  authorizer?: Authorizer,
  auditEvents?: AuditEventBinding,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Authorization PEP — scope-anchored. Env reads are STRICT (scope admins
  // or explicit `reader` grants), as for secrets. Every route takes its
  // scope from `?scopeKind` + `?scopeId`, the same parameters the handlers
  // act on.
  if (authorizer !== undefined) {
    const scopeFromQuery = (c: import('hono').Context<AppEnv>) =>
      queryScopeResourceRef((n) => c.req.query(n), { tenantId: c.get('tenantId') as TenantId });
    r.use('/', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const mw = authorizer.authorize('admin', scopeFromQuery);
      return mw(c, next);
    });
    // `/:name/*` also matches `/:name`: one check per request.
    r.use('/:name/*', async (c, next) => {
      const mw = authorizer.authorize('admin', scopeFromQuery);
      return mw(c, next);
    });
  }

  // ------------------------------ GET / ------------------------------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }

    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const namePrefix = c.req.query('namePrefix');

    const page = await envBinding.list({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(namePrefix !== undefined && namePrefix.length > 0 && { namePrefix }),
    });
    return c.json({
      data: page.data.map(serializeEnvRecord),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ------------------------ GET /:name ------------------------------
  r.get('/:name', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }

    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const rec = await envBinding.get({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      name,
    });
    if (rec === null) {
      c.status(statusFor('env-not-found') as never);
      return c.json(
        toWireError({ code: 'env-not-found', message: `No env entry "${name}".`, name }, requestId),
      );
    }
    return c.json(serializeEnvRecord(rec));
  });

  // ------------------------- PUT /:name -----------------------------
  r.put('/:name', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');

    const missing = capabilityRefusal(c, authorizer, 'env:write');
    if (missing !== undefined) return missing;

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
    const b = body as Record<string, unknown>;

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }

    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    // Body-vs-query cross-field validation.
    if (b.envName !== undefined && b.envName !== envNameResult.envName) {
      c.status(statusFor('env-name-mismatch') as never);
      return c.json(
        toWireError(
          {
            code: 'env-name-mismatch',
            message: `Body \`envName\` "${String(b.envName)}" does not match query envName "${envNameResult.envName as unknown as string}".`,
          },
          requestId,
        ),
      );
    }
    if (b.scope !== undefined && !scopesEqual(b.scope, scopeResult.scope)) {
      c.status(statusFor('scope-mismatch') as never);
      return c.json(
        toWireError(
          {
            code: 'scope-mismatch',
            message: 'Body `scope` does not match query scopeKind/scopeId.',
          },
          requestId,
        ),
      );
    }
    if (b.name !== undefined && b.name !== name) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: 'Body `name` does not match path `:name`.',
          },
          requestId,
        ),
      );
    }
    if (typeof b.value !== 'string') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`value` is required and must be a string' },
          requestId,
        ),
      );
    }
    if (b.ifRevision !== undefined && typeof b.ifRevision !== 'number') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`ifRevision` must be a number when present' },
          requestId,
        ),
      );
    }
    if (
      b.tags !== undefined &&
      (b.tags === null || typeof b.tags !== 'object' || Array.isArray(b.tags))
    ) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`tags` must be a string map when present' },
          requestId,
        ),
      );
    }

    const setScope = scopeResult.scope;
    const outcome: EnvSetOutcome = await envBinding.set({
      scope: setScope,
      envName: envNameResult.envName,
      name,
      value: b.value,
      ...(b.tags !== undefined && { tags: b.tags as Readonly<Record<string, string>> }),
      ...(b.ifRevision !== undefined && { ifRevision: b.ifRevision as number }),
      enqueueTuples: (envRowId) =>
        tuplesForCreate({ kind: 'env', id: envRowId, tenantId, scope: setScope }),
    });

    const setAudit = {
      kind: 'env-set',
      scope: setScope,
      envName: envNameResult.envName,
      name,
    } as const;
    if (outcome.kind === 'ok') {
      await auditWrite(c, auditEvents, {
        ...setAudit,
        outcome: 'succeeded',
        version: outcome.record.revision,
      });
      return c.json(serializeEnvRecord(outcome.record));
    }
    await auditWrite(c, auditEvents, {
      ...setAudit,
      outcome: 'failed',
      errorCode: outcome.kind === 'revision-conflict' ? 'env-write-conflict' : outcome.code,
    });
    if (outcome.kind === 'revision-conflict') {
      c.status(statusFor('env-write-conflict') as never);
      return c.json(
        toWireError(
          {
            code: 'env-write-conflict',
            message: `Stored revision is ${outcome.currentRevision}; retry with the current value.`,
            currentRevision: outcome.currentRevision,
          },
          requestId,
        ),
      );
    }
    c.status(statusFor(outcome.code) as never);
    return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
  });

  // ---------------------- DELETE /:name -----------------------------
  r.delete('/:name', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');

    const missing = capabilityRefusal(c, authorizer, 'env:write');
    if (missing !== undefined) return missing;

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }

    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const outcome = await envBinding.delete({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      name,
    });
    // Only a delete that removed something is recorded.
    if (outcome.deleted) {
      await auditWrite(c, auditEvents, {
        kind: 'env-deleted',
        scope: scopeResult.scope,
        envName: envNameResult.envName,
        name,
        outcome: 'succeeded',
      });
    }
    return c.json({ deleted: outcome.deleted });
  });

  return r;
}

// -------------------- shared helpers (also used by secrets router) --------------------

type EnvNameResult =
  | { readonly kind: 'ok'; readonly envName: EnvName }
  | { readonly kind: 'err'; readonly code: string; readonly message: string };

export function requireEnvName(raw: string | undefined): EnvNameResult {
  if (raw === undefined || raw.length === 0) {
    return {
      kind: 'err',
      code: 'env-name-required',
      message: '`envName` query parameter is required',
    };
  }
  const validated = makeEnvName(raw);
  if (validated === null) {
    return {
      kind: 'err',
      code: 'env-name-required',
      message: '`envName` must match RFC-1035-like grammar [a-z][a-z0-9-]{0,62}.',
    };
  }
  return { kind: 'ok', envName: validated };
}

type ScopeResult =
  | { readonly kind: 'ok'; readonly scope: Scope }
  | { readonly kind: 'err'; readonly code: string; readonly message: string };

/**
 * Env + Secrets routes require an explicit scope (Tenant / Org /
 * Project) on every request — the base `parseScopeParams` treats scope
 * as optional (for content-scoped bindings that filter). Missing
 * `scopeKind` here is a hard error.
 */
export function requireScope(
  query: Record<string, string> | ((name: string) => string | undefined),
  tenantId: TenantId,
): ScopeResult {
  const parsed = parseScopeParams(query, { tenantId });
  if (parsed.kind === 'err') {
    // Distinguish the "orphan scopeId" and "wrong scopeKind" cases
    // (both surface as `scope-invalid` in parseScopeParams). Env +
    // Secrets routes prefer the tighter `scope-kind-required` /
    // `scope-mismatch` codes. Fall back to `scope-invalid` for
    // everything else.
    return { kind: 'err', code: 'scope-invalid', message: parsed.message };
  }
  if (parsed.scope === undefined) {
    return {
      kind: 'err',
      code: 'scope-kind-required',
      message: '`scopeKind` query parameter is required.',
    };
  }
  return { kind: 'ok', scope: parsed.scope };
}

/**
 * Structural equality — scope kinds + ids MUST match. `tenantId` on
 * `a` (the body scope) is tolerated when absent: the SDK strips it
 * because the server derives tenantId authoritatively from the bearer
 * (mirrors the body-scope tenant check in `routes/secrets.ts`). When present, it
 * must still match `b.tenantId` — defense-in-depth against a body that
 * explicitly disagrees with the session.
 */
export function scopesEqual(a: unknown, b: Scope): boolean {
  if (a === null || typeof a !== 'object') return false;
  const ao = a as Record<string, unknown>;
  if (ao.kind !== b.kind) return false;
  if (ao.tenantId !== undefined && ao.tenantId !== (b.tenantId as unknown as string)) return false;
  if (b.kind === 'org') {
    return ao.orgId === (b.orgId as unknown as string);
  }
  if (b.kind === 'project') {
    return ao.projectId === (b.projectId as unknown as string);
  }
  return true;
}

function serializeEnvRecord(rec: EnvRecord): Record<string, unknown> {
  return {
    scope: rec.scope as unknown as Record<string, unknown>,
    envName: rec.envName as unknown as string,
    name: rec.name,
    value: rec.value,
    revision: rec.revision,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    ...(rec.tags !== undefined && { tags: rec.tags }),
  };
}

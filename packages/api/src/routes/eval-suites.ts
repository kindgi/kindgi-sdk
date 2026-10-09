// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import type { Cursor, ProjectId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import {
  EVAL_KINDS,
  type EvalKind,
  type EvalSuite,
  type EvalSuiteRegistryBinding,
} from '../eval-suite-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Evaluation-suite resource routes — part of the admin control plane.
 * Full versioned CRUD, mirroring
 * `policies` 1:1.
 *
 * The registry is intentionally kind-neutral: the wire body carries a
 * `kind` discriminator and a `spec` object whose shape is dictated by
 * that kind. The route validates the top-level shape (id, tenantId,
 * semver version, kind ∈ closed enum, spec is an object) — deeper
 * validation of `spec` is the runtime consumer's responsibility (they
 * own the semantics for their kind).
 *
 * Registry-only. Actual eval runs (dispatch to eval-judge adapters,
 * HITL delegation for `human-review`, custom-handler dispatch via
 * handler-as-code) live in the eval-runs surface — the same
 * discipline that split policies (registry) from policy enforcement
 * (consumer).
 */
export function evalSuitesRouter(
  binding: EvalSuiteRegistryBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Authorization — same checks as the agents routes.
  if (authorizer !== undefined) {
    r.use('/', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const tenantId = c.get('tenantId') as TenantId;
      const mw = authorizer.authorize('admin', async () => {
        try {
          const body = await c.req.json();
          const pid =
            body !== null && typeof body === 'object'
              ? (body as Record<string, unknown>).projectId
              : undefined;
          if (typeof pid === 'string' && pid.length > 0) return ref('project', pid);
        } catch {
          // POST handler validates + returns 400
        }
        return ref('tenant', tenantId as unknown as string);
      });
      return mw(c, next);
    });
    r.use('/', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      // A project filter needs read on that project. Parse it as the
      // handler does (`?scopeKind=project&scopeId=`).
      const s = parseScopeParams((n) => c.req.query(n), {
        tenantId: c.get('tenantId') as TenantId,
      });
      if (s.kind !== 'ok' || s.scope?.kind !== 'project') return next();
      const scopeProjectId = s.scope.projectId as unknown as string;
      const mw = authorizer.authorize('read', () => ref('project', scopeProjectId));
      return mw(c, next);
    });
    r.use('/:suiteId/*', async (c, next) => {
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const suiteId = c.req.param('suiteId') ?? '';
      const mw = authorizer.authorize(action, () => ref('eval_suite', suiteId));
      return mw(c, next);
    });
    r.use('/:suiteId', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const suiteId = c.req.param('suiteId') ?? '';
      const mw = authorizer.authorize('read', () => ref('eval_suite', suiteId));
      return mw(c, next);
    });
  }

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const kindRaw = c.req.query('kind');
    const nameRaw = c.req.query('name');

    if (kindRaw !== undefined && kindRaw.length > 0 && !isEvalKind(kindRaw)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `Unknown eval kind "${kindRaw}". Expected one of: ${EVAL_KINDS.join(', ')}.`,
          },
          requestId,
        ),
      );
    }

    const scopeParsed = parseScopeParams(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(kindRaw !== undefined && kindRaw.length > 0 && { evalKind: kindRaw as EvalKind }),
      ...(nameRaw !== undefined && nameRaw.length > 0 && { nameFilter: nameRaw }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
    });
    // Only what the caller may read (T243 A), as `GET …/:id` asks.
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (a) =>
            ref('eval_suite', a.id as unknown as string),
          );
    return c.json({
      data: visible.map(serializeEvalSuite),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:suiteId (latest version) ----------
  r.get('/:suiteId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');

    const suite = await binding.get({ tenantId, suiteId });
    if (suite === null) {
      // 410 gone (head exists, no active version) vs 404 not-found.
      const exists = await binding.headExists({ tenantId, suiteId });
      if (exists) {
        c.status(statusFor('eval-suite-gone') as never);
        return c.json(
          toWireError(
            {
              code: 'eval-suite-gone',
              message: `Eval suite "${suiteId}" has no active versions; reinstate a tombstoned version or publish a new one`,
              suiteId,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite registered with id "${suiteId}"`,
            suiteId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeEvalSuite(suite));
  });

  // ---------- GET /:suiteId/versions (list versions) ----------
  r.get('/:suiteId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');

    // Confirm the id exists at all — an empty versions list from the
    // binding is ambiguous (no versions vs. unknown id), so we do a
    // preliminary `get` to flip an unknown id to a `404`.
    const latest = await binding.get({ tenantId, suiteId });
    if (latest === null) {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite registered with id "${suiteId}"`,
            suiteId,
          },
          requestId,
        ),
      );
    }

    const page = await binding.listVersions({
      tenantId,
      suiteId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
    });
    return c.json({
      data: page.data.map(serializeEvalSuite),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:suiteId/versions/:version ----------
  r.get('/:suiteId/versions/:version', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const version = c.req.param('version');

    const suite = await binding.getVersion({ tenantId, suiteId, version });
    if (suite === null) {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite "${suiteId}" at version "${version}"`,
            suiteId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeEvalSuite(suite));
  });

  // ---------- POST / (publish) ----------
  r.post('/', async (c) => {
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

    // `projectId` is REQUIRED on the POST body.
    // Missing / empty / non-string → 400 bad-input. Absent from the
    // eval-suite-shape validator on purpose — the caller controls what
    // project the suite lands in; the suite definition itself is
    // project-agnostic.
    const bodyObj = body as Record<string, unknown>;
    const projectIdRaw = bodyObj.projectId;
    if (typeof projectIdRaw !== 'string' || projectIdRaw.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`projectId` is required' }, requestId),
      );
    }
    const projectId = projectIdRaw as ProjectId;

    // Validate the wire shape. Deeper `spec` validation is the runtime
    // consumer's responsibility (each eval kind has its own contract);
    // the registry only guarantees the top-level shape. `projectId`
    // is stripped before validation — the suite definition itself is
    // project-agnostic.
    const { projectId: _pid, ...bodyWithoutProjectId } = bodyObj;
    const validation = validateEvalSuite(bodyWithoutProjectId, tenantId);
    if (validation.kind === 'err') {
      c.status(statusFor('validation-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: validation.error.message,
            issues: validation.error.issues as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await binding.publish({
      tenantId,
      projectId,
      suite: validation.value,
      enqueueTuples: (suiteId) =>
        tuplesForCreate({ kind: 'eval_suite', id: suiteId, tenantId, projectId }, creatorUserId),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('eval-suite-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-already-registered',
            message: `Eval suite "${outcome.suiteId}" version "${outcome.version}" is already registered`,
            suiteId: outcome.suiteId,
            version: outcome.version,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'project-mismatch') {
      return projectMismatch(c, 'eval-suite', outcome.suiteId, outcome.projectId);
    }
    if (outcome.kind === 'project-not-found') {
      // Caller supplied a `projectId` that does not resolve within
      // this tenant. Distinct signal from `already-registered` so the
      // client can prompt for a valid project rather than assume the
      // version was already used. Answered as `400 bad-input`; the
      // caller learns from the message which field was invalid.
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `\`projectId\` "${outcome.projectId as unknown as string}" does not resolve to a project in this tenant`,
          },
          requestId,
        ),
      );
    }
    c.status(201);
    return c.json({ suiteId: outcome.suiteId, version: outcome.version });
  });

  // ---------- POST /:suiteId/versions/:version/unregister ----------
  r.post('/:suiteId/versions/:version/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const version = c.req.param('version');

    const outcome = await binding.unregister({ tenantId, suiteId, version });
    if (!outcome.unregistered) {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite "${suiteId}" at version "${version}" to unregister`,
            suiteId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({ suiteId, version, unregistered: true });
  });

  // ---------- POST /:suiteId/versions/:version/reinstate ----------
  r.post('/:suiteId/versions/:version/reinstate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const suiteId = c.req.param('suiteId');
    const version = c.req.param('version');
    const outcome = await binding.reinstateVersion({ tenantId, suiteId, version });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('eval-suite-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'eval-suite-not-found',
            message: `No eval suite "${suiteId}" at version "${version}" to reinstate`,
            suiteId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({
      suiteId: outcome.suiteId,
      version: outcome.version,
      wasTombstoned: outcome.wasTombstoned,
    });
  });

  return r;
}

function serializeEvalSuite(s: EvalSuite): Record<string, unknown> {
  return {
    id: s.id,
    tenantId: s.tenantId as unknown as string,
    version: s.version,
    kind: s.kind,
    ...(s.description !== undefined && { description: s.description }),
    spec: s.spec,
  };
}

function isEvalKind(value: string): value is EvalKind {
  return (EVAL_KINDS as readonly string[]).includes(value);
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Wire-shape validator for `EvalSuite`. Confirms the top-level fields
 * the registry needs (id, tenantId, semver version, kind ∈ closed enum,
 * spec is an object). Deeper validation of `spec` is the runtime
 * consumer's responsibility per eval kind.
 */
function validateEvalSuite(
  body: unknown,
  tenantId: TenantId,
):
  | { kind: 'ok'; value: EvalSuite }
  | {
      kind: 'err';
      error: { message: string; issues: readonly { path: string; message: string }[] };
    } {
  const b = body as Partial<EvalSuite> & Record<string, unknown>;
  const issues: { path: string; message: string }[] = [];

  if (typeof b.id !== 'string' || b.id.length === 0) {
    issues.push({ path: 'id', message: 'evalSuite.id must be a non-empty string' });
  }
  if (typeof b.version !== 'string' || !SEMVER_RE.test(b.version)) {
    issues.push({
      path: 'version',
      message: 'evalSuite.version must be a semver string (e.g. "1.0.0")',
    });
  }
  if (typeof b.kind !== 'string' || !isEvalKind(b.kind)) {
    issues.push({
      path: 'kind',
      message: `evalSuite.kind must be one of: ${EVAL_KINDS.join(', ')}`,
    });
  }
  // tenantId is optional on the wire — when present, it must match the
  // caller's tenant (server-derived from the token). Cross-tenant
  // publish is not allowed.
  if (b.tenantId !== undefined) {
    if (
      typeof b.tenantId !== 'string' ||
      (b.tenantId as unknown as string) !== (tenantId as unknown as string)
    ) {
      issues.push({
        path: 'tenantId',
        message: 'evalSuite.tenantId must match the caller tenant',
      });
    }
  }
  if (
    b.spec === undefined ||
    b.spec === null ||
    typeof b.spec !== 'object' ||
    Array.isArray(b.spec)
  ) {
    issues.push({ path: 'spec', message: 'evalSuite.spec must be an object' });
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    issues.push({ path: 'description', message: 'evalSuite.description must be a string' });
  }

  if (issues.length > 0) {
    return {
      kind: 'err',
      error: { message: issues[0]?.message ?? 'evalSuite validation failed', issues },
    };
  }

  const value: EvalSuite = {
    id: b.id as string,
    tenantId,
    version: b.version as string,
    kind: b.kind as EvalKind,
    ...(typeof b.description === 'string' && { description: b.description }),
    spec: b.spec as Readonly<Record<string, unknown>>,
  };
  return { kind: 'ok', value };
}

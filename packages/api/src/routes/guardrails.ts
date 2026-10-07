// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import { type Guardrail, validateGuardrailSpec } from '@kindgi/guardrails';
import type { Cursor, GuardrailId, ProjectId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { GuardrailRegistryBinding } from '../guardrail-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { refuseWritesWhenReadOnly } from '../registry-read-only.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Guardrails resource routes, paired with tools.
 *
 * Registry storage is caller-plugged via `GuardrailRegistryBinding`.
 * The API package does not own persistence — deployments wire a durable
 * store; tests can wrap an in-memory one.
 *
 * Registration is metadata-only: the body is a full `Guardrail` shape
 * (id + kind + check-id + action). The actual `check` implementation
 * must already be registered with the runtime — deployments publish
 * guardrails whose check code is already bundled server-side. Check
 * code is not uploaded over this surface.
 */
/**
 * Optional side-effect callback fired after a successful write
 * (register, unregister) to a guardrail. Lets an in-process
 * runtime cache (e.g. a per-tenant guardrail cache) invalidate
 * its per-tenant snapshot so the next agent turn picks up the
 * new/dropped guardrail without a process restart. Mirror of
 * `ToolWriteHook` / `ProviderWriteHook`.
 */
export type GuardrailWriteHook = (params: {
  readonly tenantId: TenantId;
  readonly guardrailId: GuardrailId;
  readonly kind: 'register' | 'unregister';
}) => void | Promise<void>;

export function guardrailsRouter(
  binding: GuardrailRegistryBinding,
  authorizer?: Authorizer,
  onWrite?: GuardrailWriteHook,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // A read-only registry (under `kindgi dev`, the pack's files) refuses
  // every write before anything else runs.
  r.use(
    '*',
    refuseWritesWhenReadOnly(() => binding.readOnly),
  );

  // Authorization (PEP) — mirrors agents. Cascade via `guardrail#parent@project`
  // written in-tx by register; direct check via `ref('guardrail', id)`.
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
    r.use('/:guardrailId/*', async (c, next) => {
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const guardrailId = c.req.param('guardrailId') ?? '';
      const mw = authorizer.authorize(action, () => ref('guardrail', guardrailId));
      return mw(c, next);
    });
    r.use('/:guardrailId', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const guardrailId = c.req.param('guardrailId') ?? '';
      const mw = authorizer.authorize('read', () => ref('guardrail', guardrailId));
      return mw(c, next);
    });
  }

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const nameRaw = c.req.query('name');

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
      ...(nameRaw !== undefined && nameRaw.length > 0 && { nameFilter: nameRaw }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
    });
    return c.json({
      data: page.data.map(serializeGuardrail),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:guardrailId ----------
  r.get('/:guardrailId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const guardrailId = c.req.param('guardrailId') as GuardrailId;

    const guardrail = await binding.get({ tenantId, guardrailId });
    if (guardrail === null) {
      c.status(statusFor('guardrail-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'guardrail-not-found',
            message: `No guardrail registered with id "${guardrailId as unknown as string}"`,
            guardrailId: guardrailId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeGuardrail(guardrail));
  });

  // ---------- POST / (register) ----------
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
    // Missing / empty / non-string → 400 bad-input. Stripped from the
    // spec before `validateGuardrailSpec` because the spec schema
    // rejects unknown top-level keys (the guardrail definition itself
    // is project-agnostic — the caller controls what project the
    // guardrail lands in).
    const bodyObj = body as Record<string, unknown>;
    const projectIdRaw = bodyObj.projectId;
    if (typeof projectIdRaw !== 'string' || projectIdRaw.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`projectId` is required' }, requestId),
      );
    }
    const projectId = projectIdRaw as ProjectId;
    const { projectId: _pid, ...bodyWithoutProjectId } = bodyObj;

    const validated = validateGuardrailSpec(bodyWithoutProjectId);
    if (validated.kind === 'err') {
      c.status(statusFor('validation-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: validated.error.message,
            issues: validated.error.issues as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await binding.register({
      tenantId,
      projectId,
      guardrail: validated.value,
      enqueueTuples: (guardrailId) =>
        tuplesForCreate(
          { kind: 'guardrail', id: guardrailId as GuardrailId, tenantId, projectId },
          creatorUserId,
        ),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('guardrail-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'guardrail-already-registered',
            message: `Guardrail "${outcome.guardrailId as unknown as string}" is already registered`,
            guardrailId: outcome.guardrailId as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'project-not-found') {
      // Caller supplied a `projectId` that does not resolve within
      // this tenant. Distinct signal from `already-registered` so the
      // client can prompt for a valid project rather than assume the
      // id was already used. `bad-input` is the closest existing
      // error code — the shape (400 + code) is stable; the caller
      // learns from the message which field was invalid.
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
    if (onWrite !== undefined) {
      try {
        await onWrite({
          tenantId,
          guardrailId: outcome.guardrailId,
          kind: 'register',
        });
      } catch {
        // Post-write hooks are advisory (cache invalidation etc.).
        // A hook failure does NOT roll back the register — the row
        // is durably stored; a stale in-memory cache will self-heal
        // on the next boot.
      }
    }
    c.status(201);
    return c.json({
      guardrailId: outcome.guardrailId as unknown as string,
    });
  });

  // ---------- POST /:guardrailId/unregister ----------
  r.post('/:guardrailId/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const guardrailId = c.req.param('guardrailId') as GuardrailId;

    const outcome = await binding.unregister({ tenantId, guardrailId });
    if (!outcome.unregistered) {
      c.status(statusFor('guardrail-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'guardrail-not-found',
            message: `No guardrail "${guardrailId as unknown as string}" to unregister`,
            guardrailId: guardrailId as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (onWrite !== undefined) {
      try {
        await onWrite({ tenantId, guardrailId, kind: 'unregister' });
      } catch {
        // See register path — hooks are advisory.
      }
    }
    return c.json({
      guardrailId: guardrailId as unknown as string,
      unregistered: true,
    });
  });

  return r;
}

function serializeGuardrail(i: Guardrail): Record<string, unknown> {
  return {
    id: i.id as unknown as string,
    ...(i.name !== undefined && { name: i.name }),
    ...(i.description !== undefined && { description: i.description }),
    kind: i.kind,
    ...(i.check !== undefined && { check: i.check }),
    ...(i.config !== undefined && { config: i.config }),
    action: i.action,
    ...(i.severity !== undefined && { severity: i.severity }),
    ...(i.scope !== undefined && { scope: i.scope }),
    ...(i.budget !== undefined && { budget: i.budget }),
    ...(i.judgeCapabilities !== undefined && { judgeCapabilities: i.judgeCapabilities }),
  };
}

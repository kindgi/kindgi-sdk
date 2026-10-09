// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import { type ToolManifest, validateToolManifest } from '@kindgi/tools';
import type { Cursor, ProjectId, TenantId, ToolId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { refuseWritesWhenReadOnly } from '../registry-read-only.js';
import type { ToolRegistryBinding } from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Tools resource routes.
 *
 * Registry storage is caller-plugged via `ToolRegistryBinding`. The
 * API package does not own persistence — deployments wire a durable
 * store; tests can wrap the in-memory `@kindgi/tools` `ToolRegistry`.
 *
 * Registration is metadata-only: the body is a `ToolManifest` (a
 * `Tool` minus its runtime `handler` closure). The actual handler
 * must already be registered with the runtime — deployments publish
 * tools whose code is already bundled server-side. Handler code is not
 * uploaded over this surface.
 */
/**
 * Optional side-effect callback fired after a successful write
 * (publish, unregister, reinstate) to a tool version. Lets an
 * in-process runtime cache (e.g. a per-tenant tool cache)
 * invalidate its per-tenant snapshot so the next agent run picks
 * up the new manifest without a process restart.
 */
export type ToolWriteHook = (params: {
  readonly tenantId: TenantId;
  readonly toolId: ToolId;
  readonly version: string;
  readonly kind: 'publish' | 'unregister' | 'reinstate';
}) => void | Promise<void>;

export function toolsRouter(
  binding: ToolRegistryBinding,
  authorizer?: Authorizer,
  onWrite?: ToolWriteHook,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // A read-only registry (under `kindgi dev`, the pack's files) refuses
  // every write before anything else runs.
  r.use(
    '*',
    refuseWritesWhenReadOnly(() => binding.readOnly),
  );

  // Authorization (PEP) — mirrors agents. Cascade via `tool#parent@project`
  // written in-tx by publish; direct check via `ref('tool', businessId)`.
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
    r.use('/:toolId/*', async (c, next) => {
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const toolId = c.req.param('toolId') ?? '';
      const mw = authorizer.authorize(action, () => ref('tool', toolId));
      return mw(c, next);
    });
    r.use('/:toolId', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const toolId = c.req.param('toolId') ?? '';
      const mw = authorizer.authorize('read', () => ref('tool', toolId));
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
    // Only what the caller may read (T243 A), as `GET …/:id` asks.
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (a) =>
            ref('tool', a.id as unknown as string),
          );
    return c.json({
      data: visible.map(serializeTool),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:toolId (latest version) ----------
  r.get('/:toolId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const toolId = c.req.param('toolId') as ToolId;

    const tool = await binding.get({ tenantId, toolId });
    if (tool === null) {
      // Distinguish 410 gone (identity exists — head row present, no
      // active version) from 404 not-found (never registered). Retirement
      // is derived from the tool having no latest version; the head row is
      // the identity marker.
      const exists = await binding.headExists({ tenantId, toolId });
      if (exists) {
        c.status(statusFor('tool-gone') as never);
        return c.json(
          toWireError(
            {
              code: 'tool-gone',
              message: `Tool "${toolId as unknown as string}" has no active versions; reinstate a tombstoned version or publish a new one`,
              toolId: toolId as unknown as string,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('tool-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'tool-not-found',
            message: `No tool registered with id "${toolId as unknown as string}"`,
            toolId: toolId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeTool(tool));
  });

  // ---------- GET /:toolId/versions (list versions, cursor-paginated) ----------
  r.get('/:toolId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const toolId = c.req.param('toolId') as ToolId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    // `?includeTombstoned=true` opts into surfacing tombstoned versions
    // alongside active ones. Rows carry `unregisteredAt` (ISO string) iff
    // tombstoned. Absent / `false` / any other string → active-only
    // (the default).
    const includeTombstoned = c.req.query('includeTombstoned') === 'true';

    // Confirm the id exists at all. Retired tools (all versions
    // tombstoned) still have a head row → 200 with a page listing the
    // tombstoned versions. Never-registered ids → 404.
    const exists = await binding.headExists({ tenantId, toolId });
    if (!exists) {
      c.status(statusFor('tool-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'tool-not-found',
            message: `No tool registered with id "${toolId as unknown as string}"`,
            toolId: toolId as unknown as string,
          },
          requestId,
        ),
      );
    }

    const page = await binding.listVersions({
      tenantId,
      toolId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(includeTombstoned && { includeTombstoned: true }),
    });
    return c.json({
      data: page.data.map(serializeToolVersionRow),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:toolId/versions/:version ----------
  r.get('/:toolId/versions/:version', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const toolId = c.req.param('toolId') as ToolId;
    const version = c.req.param('version') as never;

    const tool = await binding.getVersion({ tenantId, toolId, version });
    if (tool === null) {
      c.status(statusFor('tool-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'tool-not-found',
            message: `No tool "${toolId as unknown as string}" at version "${version as unknown as string}"`,
            toolId: toolId as unknown as string,
            version: version as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeTool(tool));
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
    // Missing / empty / non-string → 400 bad-input. Absent from the
    // tool-manifest validator on purpose — the caller controls what
    // project the tool lands in; the manifest itself is project-
    // agnostic (validateToolManifest rejects unknown top-level keys).
    const bodyObj = body as Record<string, unknown>;
    const projectIdRaw = bodyObj.projectId;
    if (typeof projectIdRaw !== 'string' || projectIdRaw.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`projectId` is required' }, requestId),
      );
    }
    const projectId = projectIdRaw as ProjectId;
    // Strip `projectId` before validation — the tool manifest itself
    // is project-agnostic. `validateToolManifest` rejects unknown
    // top-level keys via additionalProperties: false.
    const { projectId: _pid, ...bodyWithoutProjectId } = bodyObj;

    const validated = validateToolManifest(bodyWithoutProjectId);
    if (validated.kind === 'err') {
      const err = validated.error;
      c.status(statusFor('validation-failed') as never);
      const issues =
        err.code === 'invalid-tool-definition'
          ? (err.issues as unknown as Record<string, unknown>[])
          : [{ path: err.code === 'invalid-schema' ? `/${err.where}` : '', message: err.message }];
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: err.message,
            issues,
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
      tool: validated.value,
      enqueueTuples: (toolId) =>
        tuplesForCreate({ kind: 'tool', id: toolId as ToolId, tenantId, projectId }, creatorUserId),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('tool-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'tool-already-registered',
            message: `Tool "${outcome.toolId as unknown as string}" version "${outcome.version as unknown as string}" is already registered`,
            toolId: outcome.toolId as unknown as string,
            version: outcome.version as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'project-mismatch') {
      return projectMismatch(c, 'tool', outcome.toolId as unknown as string, outcome.projectId);
    }
    if (outcome.kind === 'project-not-found') {
      // Caller supplied a `projectId` that does not resolve within
      // this tenant. Distinct signal from `already-registered` so the
      // client can prompt for a valid project rather than assume the
      // tool was already registered. `bad-input` is the closest
      // existing error code — the shape (400 + code) is stable; the
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
    if (onWrite !== undefined) {
      try {
        await onWrite({
          tenantId,
          toolId: outcome.toolId as ToolId,
          version: outcome.version as unknown as string,
          kind: 'publish',
        });
      } catch {
        // Post-write hooks are advisory (cache invalidation etc.).
        // A hook failure does NOT roll back the publish — the row
        // is durably stored; a stale in-memory cache will self-heal
        // on the next boot.
      }
    }
    c.status(201);
    return c.json({
      toolId: outcome.toolId as unknown as string,
      version: outcome.version as unknown as string,
    });
  });

  // ---------- POST /:toolId/versions/:version/unregister ----------
  r.post('/:toolId/versions/:version/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const toolId = c.req.param('toolId') as ToolId;
    const version = c.req.param('version') as never;

    const outcome = await binding.unregister({ tenantId, toolId, version });
    if (!outcome.unregistered) {
      c.status(statusFor('tool-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'tool-not-found',
            message: `No tool "${toolId as unknown as string}" at version "${version as unknown as string}" to unregister`,
            toolId: toolId as unknown as string,
            version: version as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (onWrite !== undefined) {
      try {
        await onWrite({ tenantId, toolId, version, kind: 'unregister' });
      } catch {
        // See publish path — hooks are advisory.
      }
    }
    return c.json({
      toolId: toolId as unknown as string,
      version: version as unknown as string,
      unregistered: true,
    });
  });

  // ---------- POST /:toolId/versions/:version/reinstate ----------
  // Un-tombstone a specific version — clears its `unregisteredAt` and
  // recomputes the tool's latest version across active versions. Restores
  // the manifest bytes verbatim (semver hygiene: reinstate never mutates).
  // Idempotent: reinstating an active version returns
  // `wasTombstoned: false`. Mirrors the agents/flows pattern.
  r.post('/:toolId/versions/:version/reinstate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const toolId = c.req.param('toolId') as ToolId;
    const version = c.req.param('version') as never;

    const outcome = await binding.reinstateVersion({ tenantId, toolId, version });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('tool-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'tool-not-found',
            message: `No tool "${toolId as unknown as string}" at version "${version as unknown as string}" to reinstate`,
            toolId: toolId as unknown as string,
            version: version as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (onWrite !== undefined) {
      try {
        await onWrite({
          tenantId,
          toolId: outcome.toolId as ToolId,
          version: outcome.version as unknown as string,
          kind: 'reinstate',
        });
      } catch {
        // See publish path — hooks are advisory.
      }
    }
    return c.json({
      toolId: outcome.toolId as unknown as string,
      version: outcome.version as unknown as string,
      wasTombstoned: outcome.wasTombstoned,
    });
  });

  return r;
}

/**
 * The manifest as the wire carries it: every `ToolManifest` field the
 * `Tool` schema declares (a mirror of `@kindgi/specs/tool.schema.json`),
 * including where the code runs (`codeArtifactRef`) and the declarative
 * `spec`. A secret appears only as a reference (`secretRef`), never a value.
 */
function serializeTool(t: ToolManifest): Record<string, unknown> {
  return {
    id: t.id as unknown as string,
    description: t.description,
    ...(t.version !== undefined && { version: t.version }),
    input: t.input,
    output: t.output,
    ...(t.needs !== undefined && { needs: t.needs }),
    ...(t.effects !== undefined && { effects: t.effects }),
    ...(t.transport !== undefined && { transport: t.transport }),
    ...(t.mcpEndpoint !== undefined && { mcpEndpoint: t.mcpEndpoint }),
    ...(t.metadata !== undefined && { metadata: t.metadata }),
    ...(t.mutating !== undefined && { mutating: t.mutating }),
    ...(t.sandbox !== undefined && { sandbox: t.sandbox }),
    ...(t.limits !== undefined && { limits: t.limits }),
    ...(t.network !== undefined && { network: t.network }),
    ...(t.needsSpec !== undefined && { needsSpec: t.needsSpec }),
    ...(t.codeArtifactRef !== undefined && { codeArtifactRef: t.codeArtifactRef }),
    ...(t.spec !== undefined && { spec: t.spec }),
  };
}

/**
 * Serializer for `listVersions` rows — the same shape as `serializeTool`
 * plus `unregisteredAt` when the row carries it. Kept separate so the
 * head-level `get` / `resolve` routes don't accidentally start emitting
 * a field consumers don't expect.
 */
function serializeToolVersionRow(
  t: ToolManifest & { readonly unregisteredAt?: string },
): Record<string, unknown> {
  return {
    ...serializeTool(t),
    ...(t.unregisteredAt !== undefined && { unregisteredAt: t.unregisteredAt }),
  };
}

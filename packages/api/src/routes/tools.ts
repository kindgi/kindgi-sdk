// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import { toolSecretNames, validateToolManifest } from '@kindgi/tools';
import type { Cursor, EnvName, ProjectId, TenantId, ToolId, UserId } from '@kindgi/types';

import { environmentTakesPromotionsResponse, laterEnvironment } from '../environment-entry.js';
import type { EnvironmentOrderBinding } from '../environment-orders-binding.js';
import { statusFor, toWireError } from '../errors.js';
import {
  type ItemRights,
  type ItemServing,
  itemMiddleware,
  itemPathCheck,
  shownLatest,
} from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { publishCompilesMiddleware } from '../middleware/publish-compiles.js';
import { type ProviderKeys, refuseProviderKeys } from '../provider-keys.js';
import { reservedToolMetadataKeys, reservedToolMetadataMessage } from '../reference-scope.js';
import { refuseWritesWhenReadOnly } from '../registry-read-only.js';
import { type SecretScopeDeps, secretScopesFor, toolSecretRefs } from '../secret-scope.js';
import type {
  ToolKindMismatch,
  ToolRecord,
  ToolRegistryBinding,
  ToolReinstateVersionOutcome,
  ToolVersionRow,
} from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseScopeParams } from './scope-params.js';
import { isRegistryVersionsCursor } from './versions-cursor.js';

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
  options: {
    readonly providerKeys?: ProviderKeys;
    /** Where each secret a tool names is read is recorded at publish (`secret-scope.ts`). */
    readonly secrets?: SecretScopeDeps['secrets'];
    readonly projects?: SecretScopeDeps['projects'];
    /** The env the runtime serves: where the secrets a tool's code declares are read. */
    readonly envName?: EnvName;
    /**
     * The tenant's environment orders: a publish into a later environment is
     * refused (`environment-entry.ts`). Absent: no project is a later
     * environment.
     */
    readonly environmentOrders?: Pick<EnvironmentOrderBinding, 'orderOf'>;
    /** Rights on a tool more than one project serves (`item-rights.ts`); absent → the tool's own. */
    readonly itemRights?: ItemRights;
    /** With no authorizer: which projects serve it, for `?projectId=` (`itemServingOf`). */
    readonly itemServing?: ItemServing;
  } = {},
): Hono<AppEnv> {
  const itemRights = options.itemRights;
  const r = new Hono<AppEnv>();
  // Every schema a publish compiles counts against its tenant's budget.
  const publishCompiles = publishCompilesMiddleware();
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
    // An item more than one project serves is checked on those projects
    // instead (`item-rights.ts`).
    r.use(
      '/:toolId/*',
      itemMiddleware({
        authorizer,
        rights: itemRights,
        kind: 'tool',
        id: (c) => c.req.param('toolId') ?? '',
        today: (c) => (c.req.method === 'GET' ? 'read' : 'admin'),
        check: itemPathCheck,
        versionNotFound: toolVersionNotFound,
      }),
    );
    r.use(
      '/:toolId',
      itemMiddleware({
        authorizer,
        rights: itemRights,
        kind: 'tool',
        id: (c) => c.req.param('toolId') ?? '',
        today: (c) => (c.req.method === 'GET' ? 'read' : undefined),
        check: () => ({ rule: 'read' }),
        versionNotFound: toolVersionNotFound,
      }),
    );
  }

  /** A version of the tool that isn't there, or that the caller can't see: one 404 for both. */
  function toolVersionNotFound(c: Context<AppEnv>, version: string): Response {
    const toolId = c.req.param('toolId') ?? '';
    c.status(statusFor('tool-not-found') as never);
    return c.json(
      toWireError(
        {
          code: 'tool-not-found',
          message: `No tool "${toolId}" at version "${version}"`,
          toolId,
          version,
        },
        c.get('requestId'),
      ),
    );
  }

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const nameRaw = c.req.query('name');
    // `?includeRetired=true` lists retired items too (no active version),
    // each as its highest version with `unregisteredAt`. Anything else →
    // items with an active version only (the default).
    const includeRetired = c.req.query('includeRetired') === 'true';

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
      ...(includeRetired && { includeRetired: true }),
    });
    // Only what the caller may read (T243 A), as `GET …/:id` asks.
    const visible =
      authorizer === undefined
        ? page.data
        : itemRights === undefined
          ? await authorizer.filterByCan(c, 'read', page.data, (a) =>
              ref('tool', a.id as unknown as string),
            )
          : await itemRights.filterItems(c, 'tool', page.data, {
              idOf: (a) => a.id as unknown as string,
              todayRef: (a) => ref('tool', a.id as unknown as string),
              versions: {
                versionOf: (a) => a.version as unknown as string,
                getVersion: (id, version) =>
                  binding.getVersion({ tenantId, toolId: id as ToolId, version: version as never }),
              },
              retired: (a) => a.unregisteredAt !== undefined,
            });
    return c.json({
      data: visible.map(serializeToolVersionRow),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:toolId (latest version) ----------
  r.get('/:toolId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const toolId = c.req.param('toolId') as ToolId;

    const latest = await binding.get({ tenantId, toolId });
    if (latest === null) {
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
    // The newest version the caller can see, or the newest in
    // `?projectId=` (`item-rights.ts`).
    const shown = await shownLatest(
      c,
      itemRights ?? options.itemServing,
      'tool',
      toolId as unknown as string,
      latest,
      {
        versionOf: (t) => t.version as unknown as string,
        projectOf: (t) => t.projectId as unknown as string | undefined,
        getVersion: (version) =>
          binding.getVersion({ tenantId, toolId, version: version as never }),
      },
    );
    if (shown.kind === 'bad-input') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: shown.message }, requestId));
    }
    if (shown.kind === 'not-found') {
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
    return c.json(serializeTool(shown.row));
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
    if (cursorRaw !== undefined && cursorRaw.length > 0 && !isRegistryVersionsCursor(cursorRaw)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
      );
    }

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
    // A tool more than one project serves: only the versions the caller
    // can see (`item-rights.ts`).
    const projects = await itemRights?.multi(c, 'tool', toolId as unknown as string);
    const data =
      itemRights === undefined || projects === undefined
        ? page.data
        : await itemRights.visibleVersions(
            c,
            'tool',
            toolId as unknown as string,
            projects,
            page.data,
            (t) => t.version as unknown as string,
          );
    return c.json({
      data: data.map(serializeToolVersionRow),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:toolId/versions/:version ----------
  r.get('/:toolId/versions/:version', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const toolId = c.req.param('toolId') as ToolId;
    const version = c.req.param('version') as never;

    const tool = await binding.getVersion({ tenantId, toolId, version });
    if (tool === null) return toolVersionNotFound(c, version as unknown as string);
    return c.json(serializeTool(tool));
  });

  // ---------- POST / (register) ----------
  r.post('/', publishCompiles, async (c) => {
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
    const later = await laterEnvironment(options.environmentOrders, tenantId, projectId);
    if (later !== undefined) {
      return environmentTakesPromotionsResponse(
        c,
        requestId,
        authorizer,
        { kind: 'publish', noun: 'tool' },
        later,
      );
    }
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

    // The runtime's own metadata (`kindgi.*`) is never a published tool's.
    const reserved = reservedToolMetadataKeys(validated.value.metadata);
    if (reserved.length > 0) {
      c.status(statusFor('validation-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: reservedToolMetadataMessage(reserved[0] as string),
            issues: reserved.map((key) => ({
              path: `/metadata/${key}`,
              message: reservedToolMetadataMessage(key),
            })),
          },
          requestId,
        ),
      );
    }

    // A model provider's key is never a tool's.
    const refusal = await refuseProviderKeys(
      options.providerKeys,
      tenantId,
      toolSecretNames(validated.value),
      'a tool',
    );
    if (refusal !== undefined) {
      c.status(statusFor(refusal.code) as never);
      return c.json(toWireError(refusal, requestId));
    }

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    // Where each secret it names is read: decided now, as its publisher
    // may read them, and kept with this version (`secret-scope.ts`).
    const secretScopes = await secretScopesFor(
      c,
      { secrets: options.secrets, projects: options.projects, authorizer },
      { kind: 'project', tenantId, projectId },
      toolSecretRefs(validated.value, options.envName),
    );
    const outcome = await binding.publish({
      tenantId,
      projectId,
      tool: validated.value,
      ...(secretScopes !== undefined && { secretScopes }),
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
    if (outcome.kind === 'kind-mismatch') {
      c.status(statusFor('tool-kind-mismatch') as never);
      return c.json(toWireError(kindMismatch(outcome, 'publish'), requestId));
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

    // A model provider's key is never a tool's: a version naming one, retired
    // before its provider was registered, stays retired.
    if (options.providerKeys !== undefined) {
      const retired = await binding.getVersion({ tenantId, toolId, version });
      const refusal =
        retired === null
          ? undefined
          : await refuseProviderKeys(
              options.providerKeys,
              tenantId,
              toolSecretNames(retired),
              'a tool',
            );
      if (refusal !== undefined) {
        c.status(statusFor(refusal.code) as never);
        return c.json(toWireError(refusal, requestId));
      }
    }

    const outcome = await binding.reinstateVersion({ tenantId, toolId, version });
    if (outcome.kind !== 'ok') {
      const refusal = reinstateRefusal(outcome);
      c.status(statusFor(refusal.code) as never);
      return c.json(toWireError(refusal, requestId));
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

/** A reinstate's refusal: no such version (`404 tool-not-found`), or `409 tool-kind-mismatch`. */
function reinstateRefusal(outcome: Exclude<ToolReinstateVersionOutcome, { readonly kind: 'ok' }>) {
  if (outcome.kind === 'kind-mismatch') return kindMismatch(outcome, 'reinstate');
  const toolId = outcome.toolId as unknown as string;
  const version = outcome.version as unknown as string;
  return {
    code: 'tool-not-found' as const,
    message: `No tool "${toolId}" at version "${version}" to reinstate`,
    toolId,
    version,
  };
}

/**
 * `409 tool-kind-mismatch`'s body: the version is of another kind than the
 * tool's active versions (`ToolKindMismatch`), and nothing was written.
 * `endpointId` is the one the tool's versions name in their metadata,
 * which reading the tool shows.
 */
function kindMismatch(outcome: ToolKindMismatch, write: 'publish' | 'reinstate') {
  const toolId = outcome.toolId as unknown as string;
  const version = outcome.version as unknown as string;
  const { endpointId } = outcome;
  const done = write === 'publish' ? 'published' : 'reinstated';
  const fix =
    endpointId === undefined
      ? 'unregister its published versions first'
      : write === 'publish'
        ? 'publish this one under another id, or unregister the endpoint first'
        : 'unregister the endpoint first';
  const is =
    endpointId === undefined
      ? `Tool "${toolId}" is a tool published here, and version "${version}" is an MCP endpoint's`
      : `Tool "${toolId}" is MCP endpoint "${endpointId}"'s tool, and version "${version}" isn't`;
  return {
    code: 'tool-kind-mismatch' as const,
    message: `${is}, so it can't be ${done} under that id; ${fix}`,
    toolId,
    version,
    ...(endpointId !== undefined && { endpointId }),
  };
}

/**
 * The manifest as the wire carries it: every `ToolManifest` field the
 * `Tool` schema declares (a mirror of `@kindgi/specs/tool.schema.json`),
 * including where the code runs (`codeArtifactRef`) and the declarative
 * `spec`, and the tool's project and where each secret it names is read
 * (`secretScopes`) when the registry records them. A secret appears only
 * as a reference (`secretRef`), never a value.
 */
function serializeTool(t: ToolRecord): Record<string, unknown> {
  return {
    id: t.id as unknown as string,
    ...(t.projectId !== undefined && { projectId: t.projectId as unknown as string }),
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
    ...(t.needsApprovalWhenUnattended !== undefined && {
      needsApprovalWhenUnattended: t.needsApprovalWhenUnattended,
    }),
    ...(t.pauses !== undefined && { pauses: t.pauses }),
    ...(t.sandbox !== undefined && { sandbox: t.sandbox }),
    ...(t.limits !== undefined && { limits: t.limits }),
    ...(t.network !== undefined && { network: t.network }),
    ...(t.needsSpec !== undefined && { needsSpec: t.needsSpec }),
    ...(t.codeArtifactRef !== undefined && { codeArtifactRef: t.codeArtifactRef }),
    ...(t.spec !== undefined && { spec: t.spec }),
    ...(t.secretScopes !== undefined && { secretScopes: t.secretScopes }),
  };
}

/**
 * Serializer for `listVersions` rows — the same shape as `serializeTool`
 * plus `unregisteredAt` when the row carries it. Kept separate so the
 * head-level `get` / `resolve` routes don't accidentally start emitting
 * a field consumers don't expect.
 */
function serializeToolVersionRow(t: ToolVersionRow): Record<string, unknown> {
  return {
    ...serializeTool(t),
    ...(t.unregisteredAt !== undefined && { unregisteredAt: t.unregisteredAt }),
  };
}

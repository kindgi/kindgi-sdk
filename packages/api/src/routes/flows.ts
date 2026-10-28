// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import { type Flow, type FlowError, flowPinsDigest, loadFlow } from '@kindgi/flow';
import type { Cursor, FlowId, ProjectId, TenantId, UserId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type { UnpinnableRef } from '../agent-pins.js';
import { environmentTakesPromotionsResponse, laterEnvironment } from '../environment-entry.js';
import type { EnvironmentOrderBinding } from '../environment-orders-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { FlowRegistryBinding, FlowVersionRecord } from '../flow-binding.js';
import { resolveFlowPins } from '../flow-pins.js';
import {
  type ItemRights,
  type ItemServing,
  itemMiddleware,
  itemPathCheck,
  shownLatest,
} from '../item-rights.js';
import type { LiveVersionBinding } from '../live-version-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { publishCompilesMiddleware } from '../middleware/publish-compiles.js';
import {
  type ReferenceScopeBinding,
  flowReferences,
  outOfScopeResponse,
  referencesOutOfScope,
} from '../reference-scope.js';
import { refuseWritesWhenReadOnly } from '../registry-read-only.js';
import type { ToolRegistryBinding } from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import { includeRetiredOf } from './include-retired.js';
import { refuseUnissuedCursor } from './issued-cursor.js';
import { clampLimit } from './pagination.js';
import { projectMismatch } from './project-mismatch.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Flows resource routes.
 *
 * Registry storage is caller-plugged via `FlowRegistryBinding`,
 * mirroring `AgentRegistryBinding` 1:1. The API package does not own
 * persistence — the binding implementation supplies the store (tests
 * wrap an in-memory `Map`-backed adapter).
 *
 * Publish is data-as-code: the body is a full `Flow` definition
 * (`@kindgi/specs/flow.schema.json`). Validation runs through
 * `@kindgi/flow.loadFlow(...)` so a flow published through the
 * API is byte-identical to one constructed in-process.
 *
 * Run initiation stays at `POST /v1/runs` (one primitive,
 * discriminated subject). No
 * `/v1/flows/:flowId/run` route is added here.
 *
 * With `pinning` (the tool and agent registries), a published version is
 * pinned: each tool it runs resolves once, at publish, to its latest
 * version, and each agent it runs at no named version to what a run in
 * the flow's project would get, its live version there with
 * `pinning.live`, else its latest. Every run of that version uses those
 * (`pins`, see `resolveFlowPins`); one with no published version refuses
 * the publish. Without `pinning`, versions carry no pins and bind the
 * latest versions per run.
 */
export function flowsRouter(
  binding: FlowRegistryBinding,
  authorizer?: Authorizer,
  pinning?: FlowPinning,
  referenceScope?: ReferenceScopeBinding,
  /**
   * The tenant's environment orders: a publish into a later environment is
   * refused (`environment-entry.ts`). Absent: no project is a later
   * environment.
   */
  environmentOrders?: Pick<EnvironmentOrderBinding, 'orderOf'>,
  /** Rights on a flow more than one project serves (`item-rights.ts`); absent → the flow's own. */
  itemRights?: ItemRights,
  /** With no authorizer: which projects serve it, for `?projectId=` (`itemServingOf`). */
  itemServing?: ItemServing,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Every schema a publish compiles counts against its tenant's budget.
  const publishCompiles = publishCompilesMiddleware();
  // A read-only registry (under `kindgi dev`, the pack's files) refuses
  // every write before anything else runs.
  r.use(
    '*',
    refuseWritesWhenReadOnly(() => binding.readOnly),
  );

  // Authorization — mirrors agents 1:1. Check the resource directly;
  // permissions cascade from the parent project because publish writes
  // the parent tuple in the same transaction.
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
      '/:flowId/*',
      itemMiddleware({
        authorizer,
        rights: itemRights,
        kind: 'flow',
        id: (c) => c.req.param('flowId') ?? '',
        today: (c) => (c.req.method === 'GET' ? 'read' : 'admin'),
        check: itemPathCheck,
        versionNotFound: flowVersionNotFound,
      }),
    );
    r.use(
      '/:flowId',
      itemMiddleware({
        authorizer,
        rights: itemRights,
        kind: 'flow',
        id: (c) => c.req.param('flowId') ?? '',
        today: (c) => (c.req.method === 'GET' ? 'read' : undefined),
        check: () => ({ rule: 'read' }),
        versionNotFound: flowVersionNotFound,
      }),
    );
  }

  /** A version of the flow that isn't there, or that the caller can't see: one 404 for both. */
  function flowVersionNotFound(c: Context<AppEnv>, version: string): Response {
    const flowId = c.req.param('flowId') ?? '';
    c.status(statusFor('flow-not-found') as never);
    return c.json(
      toWireError(
        {
          code: 'flow-not-found',
          message: `No flow "${flowId}" at version "${version}"`,
          flowId,
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
      ...includeRetiredOf(c),
    });
    // Only what the caller may read (T243 A), as `GET …/:id` asks.
    const visible =
      authorizer === undefined
        ? page.data
        : itemRights === undefined
          ? await authorizer.filterByCan(c, 'read', page.data, (a) =>
              ref('flow', a.id as unknown as string),
            )
          : await itemRights.filterItems(c, 'flow', page.data, {
              idOf: (a) => a.id as unknown as string,
              todayRef: (a) => ref('flow', a.id as unknown as string),
              versions: {
                versionOf: (a) => a.version as unknown as string,
                getVersion: (id, version) =>
                  binding.getVersion({ tenantId, flowId: id as FlowId, version }),
              },
              retired: (a) => a.unregisteredAt !== undefined,
            });
    return c.json({
      data: visible.map(serializeGraph),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:flowId (latest version) ----------
  r.get('/:flowId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const flowId = c.req.param('flowId') as FlowId;

    const latest = await binding.get({ tenantId, flowId });
    if (latest === null) {
      // 410 gone (head exists, no active version) vs 404 not-found
      // (never registered).
      const exists = await binding.headExists({ tenantId, flowId });
      if (exists) {
        c.status(statusFor('flow-gone') as never);
        return c.json(
          toWireError(
            {
              code: 'flow-gone',
              message: `Flow "${flowId as unknown as string}" has no active versions; reinstate a tombstoned version or publish a new one`,
              flowId: flowId as unknown as string,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('flow-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'flow-not-found',
            message: `No flow registered with id "${flowId as unknown as string}"`,
            flowId: flowId as unknown as string,
          },
          requestId,
        ),
      );
    }
    // The newest version the caller can see, or the newest in
    // `?projectId=` (`item-rights.ts`).
    const shown = await shownLatest(
      c,
      itemRights ?? itemServing,
      'flow',
      flowId as unknown as string,
      latest,
      {
        versionOf: (f) => f.version as unknown as string,
        projectOf: (f) => f.projectId as unknown as string | undefined,
        getVersion: (version) => binding.getVersion({ tenantId, flowId, version }),
      },
    );
    if (shown.kind === 'bad-input') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: shown.message }, requestId));
    }
    if (shown.kind === 'not-found') {
      c.status(statusFor('flow-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'flow-not-found',
            message: `No flow registered with id "${flowId as unknown as string}"`,
            flowId: flowId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeGraph(shown.row));
  });

  // ---------- GET /:flowId/versions (list versions) ----------
  r.get('/:flowId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const flowId = c.req.param('flowId') as FlowId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const refused = refuseUnissuedCursor(c, binding, 'versions', cursorRaw);
    if (refused !== undefined) return refused;
    // `?includeTombstoned=true` lists unregistered versions too, each
    // with `unregisteredAt`. Anything else → active versions only.
    const includeTombstoned = c.req.query('includeTombstoned') === 'true';

    // Confirm the id exists at all: an empty versions list from the
    // binding is ambiguous (no versions vs. unknown id). A retired flow
    // (every version unregistered) still has its head row, so it answers
    // 200, with its versions under `includeTombstoned`; a never-registered
    // id is 404. As tools and policies do.
    const exists = await binding.headExists({ tenantId, flowId });
    if (!exists) {
      c.status(statusFor('flow-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'flow-not-found',
            message: `No flow registered with id "${flowId as unknown as string}"`,
            flowId: flowId as unknown as string,
          },
          requestId,
        ),
      );
    }

    const page = await binding.listVersions({
      tenantId,
      flowId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(includeTombstoned && { includeTombstoned: true }),
    });
    // A flow more than one project serves: only the versions the caller
    // can see (`item-rights.ts`).
    const projects = await itemRights?.multi(c, 'flow', flowId as unknown as string);
    const data =
      itemRights === undefined || projects === undefined
        ? page.data
        : await itemRights.visibleVersions(
            c,
            'flow',
            flowId as unknown as string,
            projects,
            page.data,
            (f) => f.version as unknown as string,
          );
    return c.json({
      data: data.map(serializeGraph),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:flowId/versions/:version ----------
  r.get('/:flowId/versions/:version', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const flowId = c.req.param('flowId') as FlowId;
    const version = c.req.param('version');

    const flow = await binding.getVersion({ tenantId, flowId, version });
    if (flow === null) return flowVersionNotFound(c, version);
    return c.json(serializeGraph(flow));
  });

  // ---------- POST / (publish) ----------
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
    // flow-shape validator on purpose — the caller controls what
    // project the flow lands in; the flow definition itself is
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
    const later = await laterEnvironment(environmentOrders, tenantId, projectId);
    if (later !== undefined) {
      return environmentTakesPromotionsResponse(
        c,
        requestId,
        authorizer,
        { kind: 'publish', noun: 'flow' },
        later,
      );
    }

    // Validate via loadFlow — same rules as the runtime loader, so a
    // flow published through the API is byte-identical to one
    // constructed in-process. `loadFlow` returns a Result rather than
    // throwing. `projectId` is stripped from the wire body before
    // validation — the flow definition itself is project-agnostic
    // (loadFlow rejects unknown top-level keys).
    const { projectId: _pid, ...bodyWithoutProjectId } = bodyObj;
    const loaded = loadFlow(bodyWithoutProjectId);
    if (loaded.kind === 'err') {
      c.status(statusFor('validation-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: loaded.error.message,
            issues: toIssues(loaded.error) as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }

    // Every tool, agent and subflow it names must be one its project
    // reaches (`reference-scope.ts`): asked before pinning, so an item that
    // doesn't exist and one out of reach get the same answer.
    const outOfScope = await referencesOutOfScope(
      referenceScope,
      tenantId,
      projectId,
      flowReferences(loaded.value),
    );
    if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);

    // Pin the version: every tool and unversioned agent resolves now,
    // once, to the version its runs use. One with no published version
    // refuses the publish rather than store a partly pinned version.
    const pinned = await pinFlow(pinning, tenantId, projectId, loaded.value);
    if (pinned.kind === 'unpinnable') {
      c.status(statusFor('validation-failed') as never);
      return c.json(toWireError(unpinnableFlow(loaded.value, pinned.issues), requestId));
    }
    const flow = pinned.flow;

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
    const outcome = await binding.publish({
      tenantId,
      projectId,
      flow,
      enqueueTuples: (flowId) =>
        tuplesForCreate({ kind: 'flow', id: flowId as FlowId, tenantId, projectId }, creatorUserId),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('flow-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'flow-already-registered',
            message: `Flow "${outcome.flowId as unknown as string}" version "${outcome.version}" is already registered`,
            flowId: outcome.flowId as unknown as string,
            version: outcome.version,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'project-mismatch') {
      return projectMismatch(c, 'flow', outcome.flowId as unknown as string, outcome.projectId);
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
    return c.json({
      flowId: outcome.flowId as unknown as string,
      version: outcome.version,
    });
  });

  // ---------- POST /:flowId/versions/:version/unregister ----------
  r.post('/:flowId/versions/:version/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const flowId = c.req.param('flowId') as FlowId;
    const version = c.req.param('version');

    const outcome = await binding.unregister({ tenantId, flowId, version });
    if (!outcome.unregistered) {
      c.status(statusFor('flow-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'flow-not-found',
            message: `No flow "${flowId as unknown as string}" at version "${version}" to unregister`,
            flowId: flowId as unknown as string,
            version: version,
          },
          requestId,
        ),
      );
    }
    return c.json({
      flowId: flowId as unknown as string,
      version: version,
      unregistered: true,
    });
  });

  // ---------- POST /:flowId/versions/:version/reinstate ----------
  r.post('/:flowId/versions/:version/reinstate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const flowId = c.req.param('flowId') as FlowId;
    const version = c.req.param('version');

    // Reinstating makes a version's references live again, so they're
    // asked as at publish (`reference-scope.ts`): a version from before
    // the check, naming what its project doesn't reach, stays retired.
    const retired = await binding.getVersion({ tenantId, flowId, version });
    if (retired?.unregisteredAt !== undefined && retired.projectId !== undefined) {
      const outOfScope = await referencesOutOfScope(
        referenceScope,
        tenantId,
        retired.projectId,
        flowReferences(retired),
      );
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }

    const outcome = await binding.reinstateVersion({ tenantId, flowId, version });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('flow-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'flow-not-found',
            message: `No flow "${flowId as unknown as string}" at version "${version}" to reinstate`,
            flowId: flowId as unknown as string,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({
      flowId: outcome.flowId as unknown as string,
      version: outcome.version,
      wasTombstoned: outcome.wasTombstoned,
    });
  });

  return r;
}

/** The registries a published flow version is pinned against. */
export interface FlowPinning {
  readonly tools: ToolRegistryBinding;
  readonly agents: AgentRegistryBinding;
  /** The agents' live versions: an agent step pins the one live for the flow's project. */
  readonly live?: LiveVersionBinding;
}

/** The flow with its pins, or the references with no published version; as it is without `pinning`. */
async function pinFlow(
  pinning: FlowPinning | undefined,
  tenantId: TenantId,
  projectId: ProjectId,
  flow: Flow,
): Promise<
  | { readonly kind: 'ok'; readonly flow: Flow }
  | { readonly kind: 'unpinnable'; readonly issues: readonly UnpinnableRef[] }
> {
  if (pinning === undefined) return { kind: 'ok', flow };
  const resolved = await resolveFlowPins(
    pinning.tools,
    pinning.agents,
    tenantId,
    flow,
    pinning.live !== undefined ? { binding: pinning.live, projectId } : undefined,
  );
  if (resolved.kind === 'unpinnable') return resolved;
  return {
    kind: 'ok',
    flow: { ...flow, pins: resolved.pins, pinsDigest: flowPinsDigest(resolved.pins) },
  };
}

/** The `validation-failed` error naming each tool or agent a flow runs that isn't published. */
function unpinnableFlow(flow: Flow, issues: readonly UnpinnableRef[]) {
  return {
    code: 'validation-failed' as const,
    message: `Flow "${flow.id as unknown as string}" runs tools or agents that aren't published (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    issues: issues as unknown as Record<string, unknown>[],
  };
}

function serializeGraph(g: FlowVersionRecord): Record<string, unknown> {
  return {
    id: g.id as unknown as string,
    version: g.version,
    ...(g.projectId !== undefined && { projectId: g.projectId as unknown as string }),
    ...(g.name !== undefined && { name: g.name }),
    ...(g.description !== undefined && { description: g.description }),
    nodes: g.nodes,
    edges: g.edges,
    ...(g.maxParallelism !== undefined && { maxParallelism: g.maxParallelism }),
    ...(g.metadata !== undefined && { metadata: g.metadata }),
    ...(g.pins !== undefined && { pins: g.pins }),
    ...(g.pinsDigest !== undefined && { pinsDigest: g.pinsDigest }),
    ...(g.derivedFrom !== undefined && { derivedFrom: g.derivedFrom }),
    ...(g.unregisteredAt !== undefined && { unregisteredAt: g.unregisteredAt }),
  };
}

/**
 * Normalize any `FlowError` to a flat `issues[]` list so the wire
 * response shape is uniform. Errors that already carry an `issues`
 * array (schema-validation-failed, loop-invalid-output-schema) pass
 * through unchanged; the discrete errors project their structural
 * fields into a single-element issues list keyed by the natural path.
 */
function toIssues(err: FlowError): readonly { readonly path: string; readonly message: string }[] {
  if ('issues' in err) return err.issues;
  const path = derivePath(err);
  return [{ path, message: err.message }];
}

function derivePath(err: FlowError): string {
  if ('edgeId' in err && err.edgeId !== undefined) {
    return `edges/${err.edgeId as unknown as string}`;
  }
  if ('nodeId' in err && err.nodeId !== undefined) {
    return `nodes/${err.nodeId as unknown as string}`;
  }
  if ('loopNodeId' in err && err.loopNodeId !== undefined) {
    return `nodes/${err.loopNodeId as unknown as string}`;
  }
  return '';
}

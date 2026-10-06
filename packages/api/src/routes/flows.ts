// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import { type Flow, type FlowError, flowPinsDigest, loadFlow } from '@kindgi/flow';
import type { Cursor, FlowId, ProjectId, TenantId, UserId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type { UnpinnableRef } from '../agent-pins.js';
import { statusFor, toWireError } from '../errors.js';
import type { FlowRegistryBinding, FlowVersionRecord } from '../flow-binding.js';
import { resolveFlowPins } from '../flow-pins.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ToolRegistryBinding } from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
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
 * pinned: each tool it runs, and each agent it runs at no named version,
 * resolves once, at publish, to the latest version, which every run of
 * that version uses (`pins`, see `resolveFlowPins`); one with no
 * published version refuses the publish. Without it, versions carry no
 * pins and bind the latest versions per run.
 */
export function flowsRouter(
  binding: FlowRegistryBinding,
  authorizer?: Authorizer,
  pinning?: { readonly tools: ToolRegistryBinding; readonly agents: AgentRegistryBinding },
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

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
    r.use('/:flowId/*', async (c, next) => {
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const flowId = c.req.param('flowId') ?? '';
      const mw = authorizer.authorize(action, () => ref('flow', flowId));
      return mw(c, next);
    });
    r.use('/:flowId', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const flowId = c.req.param('flowId') ?? '';
      const mw = authorizer.authorize('read', () => ref('flow', flowId));
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
      data: page.data.map(serializeGraph),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:flowId (latest version) ----------
  r.get('/:flowId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const flowId = c.req.param('flowId') as FlowId;

    const flow = await binding.get({ tenantId, flowId });
    if (flow === null) {
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
    return c.json(serializeGraph(flow));
  });

  // ---------- GET /:flowId/versions (list versions) ----------
  r.get('/:flowId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const flowId = c.req.param('flowId') as FlowId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');

    // Confirm the id exists at all — an empty versions list from the
    // binding is ambiguous (no versions vs. unknown id), so we do a
    // preliminary `get` to flip an unknown id to a `404`.
    const latest = await binding.get({ tenantId, flowId });
    if (latest === null) {
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
    });
    return c.json({
      data: page.data.map(serializeGraph),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:flowId/versions/:version ----------
  r.get('/:flowId/versions/:version', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const flowId = c.req.param('flowId') as FlowId;
    const version = c.req.param('version');

    const flow = await binding.getVersion({ tenantId, flowId, version });
    if (flow === null) {
      c.status(statusFor('flow-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'flow-not-found',
            message: `No flow "${flowId as unknown as string}" at version "${version}"`,
            flowId: flowId as unknown as string,
            version: version,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeGraph(flow));
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

    // Pin the version: every tool and unversioned agent resolves now,
    // once, to the version its runs use. One with no published version
    // refuses the publish rather than store a partly pinned version.
    const pinned = await pinFlow(pinning, tenantId, loaded.value);
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

/** The flow with its pins, or the references with no published version; as it is without `pinning`. */
async function pinFlow(
  pinning:
    | { readonly tools: ToolRegistryBinding; readonly agents: AgentRegistryBinding }
    | undefined,
  tenantId: TenantId,
  flow: Flow,
): Promise<
  | { readonly kind: 'ok'; readonly flow: Flow }
  | { readonly kind: 'unpinnable'; readonly issues: readonly UnpinnableRef[] }
> {
  if (pinning === undefined) return { kind: 'ok', flow };
  const resolved = await resolveFlowPins(pinning.tools, pinning.agents, tenantId, flow);
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

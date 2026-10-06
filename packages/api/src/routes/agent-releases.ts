// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import type { Cursor, LiveScope, OrgId, ProjectId, Semver, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { AgentReleaseBindings, Promotion, PromotionActor } from '../live-version-binding.js';
import type { AppEnv } from '../types.js';
import { liveScopeToWire, parseLiveScopeBody } from './live-scope-wire.js';
import { clampLimit } from './pagination.js';
import { parseSegmentsQuery } from './segments.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The routes that change what's live: authorized as `promote` on the agent, not `admin`. */
export function isPromotionWrite(method: string, path: string): boolean {
  return method === 'POST' && /\/(promotions|live\/rollback|live\/unpin)$/.test(path);
}

/**
 * Live versions of an agent per scope, and the promotions that set them
 * (evals step 4):
 *   GET  /:agentId/live            the version a run would use for a project and segment path
 *   GET  /:agentId/live-versions   every pin
 *   POST /:agentId/promotions      make a version live for a scope
 *   GET  /:agentId/promotions[/:id]  the history
 *   POST /:agentId/live/rollback   back to the scope's previous live version
 *   POST /:agentId/live/unpin      remove the scope's pin (it falls back to the scope above)
 */
export function mountAgentReleaseRoutes(
  r: Hono<AppEnv>,
  registry: AgentRegistryBinding,
  releases: AgentReleaseBindings,
): void {
  r.get('/:agentId/live', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const projectId = c.req.query('projectId');
    if (projectId !== undefined && !UUID_RE.test(projectId)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`projectId` must be a project id (a UUID)' },
          requestId,
        ),
      );
    }
    const segments = parseSegmentsQuery(c.req.queries('segment') ?? []);
    if (segments.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: segments.message }, requestId));
    }
    if (segments.segments !== undefined && projectId === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: 'A `segment` path needs a `projectId`' },
          requestId,
        ),
      );
    }
    const resolved = await releases.live.resolve({
      tenantId,
      agentId,
      ...(projectId !== undefined && { projectId: projectId as ProjectId }),
      ...(segments.segments !== undefined && { segments: segments.segments }),
    });
    if (resolved !== null) {
      return c.json({
        agentId,
        version: resolved.version as unknown as string,
        via: 'live',
        liveScope: liveScopeToWire(resolved.scope),
      });
    }
    // Nothing pinned on the way up: what a run gets is the latest registered version.
    const latest = await registry.get({ tenantId, agentId: agentId as AgentId });
    if (latest === null) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          { code: 'agent-not-found', message: `No agent "${agentId}" is registered` },
          requestId,
        ),
      );
    }
    return c.json({ agentId, version: latest.version as unknown as string, via: 'latest' });
  });

  r.get('/:agentId/live-versions', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const pins = await releases.live.list({ tenantId, agentId: c.req.param('agentId') });
    return c.json({
      data: pins.map((p) => ({
        agentId: p.agentId,
        scope: liveScopeToWire(p.scope),
        version: p.version as unknown as string,
        promotionId: p.promotionId,
        setAt: p.setAt as unknown as string,
      })),
    });
  });

  r.post('/:agentId/promotions', async (c) => {
    const requestId = c.get('requestId');
    const body = await readBody(c);
    if (body === undefined) return badJson(c, requestId);
    const scope = parseLiveScopeBody(body.scope);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    if (typeof body.version !== 'string' || body.version.length === 0) {
      return badInput(c, requestId, '`version` is required: the agent version to make live');
    }
    const text = optionalText(body, ['reason', 'evalRunId']);
    if (text.kind === 'err') return badInput(c, requestId, text.message);
    const outcome = await releases.promotions.promote({
      tenantId: c.get('tenantId') as TenantId,
      agentId: c.req.param('agentId'),
      version: body.version as Semver,
      scope: scope.scope,
      requestedBy: actorOf(c),
      ...text.value,
    });
    if (outcome.kind === 'err') return failed(c, requestId, outcome.error);
    c.status(201);
    return c.json(serializePromotion(outcome.value));
  });

  r.get('/:agentId/promotions', async (c) => {
    const requestId = c.get('requestId');
    const scope = scopeFromQuery((n) => c.req.query(n), c.req.queries('segment') ?? []);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    const cursor = c.req.query('cursor');
    const page = await releases.promotions.list({
      tenantId: c.get('tenantId') as TenantId,
      agentId: c.req.param('agentId'),
      limit: clampLimit(c.req.query('limit')),
      ...(scope.scope !== undefined && { scope: scope.scope }),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    return c.json({
      data: page.data.map(serializePromotion),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:agentId/promotions/:promotionId', async (c) => {
    const requestId = c.get('requestId');
    const found = await releases.promotions.get(
      c.get('tenantId') as TenantId,
      c.req.param('promotionId'),
    );
    if (found === null || found.agentId !== c.req.param('agentId')) {
      c.status(statusFor('promotion-not-found') as never);
      return c.json(
        toWireError(
          { code: 'promotion-not-found', message: 'No such promotion for this agent' },
          requestId,
        ),
      );
    }
    return c.json(serializePromotion(found));
  });

  r.post('/:agentId/live/rollback', async (c) => {
    const requestId = c.get('requestId');
    const body = await readBody(c);
    if (body === undefined) return badJson(c, requestId);
    const scope = parseLiveScopeBody(body.scope);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    if (
      body.toVersion !== undefined &&
      (typeof body.toVersion !== 'string' || body.toVersion === '')
    ) {
      return badInput(c, requestId, '`toVersion` must be a version when supplied');
    }
    const text = optionalText(body, ['reason']);
    if (text.kind === 'err') return badInput(c, requestId, text.message);
    const outcome = await releases.promotions.rollback({
      tenantId: c.get('tenantId') as TenantId,
      agentId: c.req.param('agentId'),
      scope: scope.scope,
      requestedBy: actorOf(c),
      ...(typeof body.toVersion === 'string' && { toVersion: body.toVersion as Semver }),
      ...text.value,
    });
    if (outcome.kind === 'err') return failed(c, requestId, outcome.error);
    return c.json(serializePromotion(outcome.value));
  });

  r.post('/:agentId/live/unpin', async (c) => {
    const requestId = c.get('requestId');
    const body = await readBody(c);
    if (body === undefined) return badJson(c, requestId);
    const scope = parseLiveScopeBody(body.scope);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    const text = optionalText(body, ['reason']);
    if (text.kind === 'err') return badInput(c, requestId, text.message);
    const outcome = await releases.promotions.unpin({
      tenantId: c.get('tenantId') as TenantId,
      agentId: c.req.param('agentId'),
      scope: scope.scope,
      requestedBy: actorOf(c),
      ...text.value,
    });
    if (outcome.kind === 'err') return failed(c, requestId, outcome.error);
    return c.json(serializePromotion(outcome.value));
  });
}

type Ctx = Context<AppEnv>;

async function readBody(c: Ctx): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function badJson(c: Ctx, requestId: string) {
  return badInput(c, requestId, 'Request body must be a JSON object');
}

function badInput(c: Ctx, requestId: string, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function failed(c: Ctx, requestId: string, error: { code: string; message: string }) {
  c.status(statusFor(error.code) as never);
  return c.json(toWireError(error, requestId));
}

/** Optional short strings (`reason`, `evalRunId`): absent, or a non-empty string. */
function optionalText(
  body: Readonly<Record<string, unknown>>,
  fields: readonly ('reason' | 'evalRunId')[],
):
  | { kind: 'ok'; value: { reason?: string; evalRunId?: string } }
  | { kind: 'err'; message: string } {
  const value: { reason?: string; evalRunId?: string } = {};
  for (const field of fields) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim() === '' || v.length > 2000) {
      return { kind: 'err', message: `\`${field}\` must be a non-empty string when supplied` };
    }
    value[field] = v;
  }
  return { kind: 'ok', value };
}

/** Who asked, from the request's principal. */
function actorOf(c: Ctx): PromotionActor {
  const actor = c.get('principal')?.actor;
  if (actor === undefined) return { kind: 'service', id: 'unknown' };
  return { kind: actor.kind === 'user' ? 'user' : 'service', id: actor.id };
}

/** `?scopeKind=tenant|org|project|segment&scopeId=…&segment=key:value` for the history filter. */
function scopeFromQuery(
  query: (name: string) => string | undefined,
  segmentValues: readonly string[],
): { kind: 'ok'; scope?: LiveScope } | { kind: 'err'; message: string } {
  const kind = query('scopeKind');
  const id = query('scopeId');
  if (kind === undefined || kind === '') {
    return id === undefined
      ? { kind: 'ok' }
      : { kind: 'err', message: '`scopeId` needs `scopeKind`' };
  }
  if (kind === 'tenant') return { kind: 'ok', scope: { kind: 'tenant' } };
  if (id === undefined || !UUID_RE.test(id)) {
    return { kind: 'err', message: '`scopeId` must be an org or project id (a UUID)' };
  }
  if (kind === 'org') return { kind: 'ok', scope: { kind: 'org', orgId: id as OrgId } };
  if (kind === 'project')
    return { kind: 'ok', scope: { kind: 'project', projectId: id as ProjectId } };
  if (kind === 'segment') {
    const path = parseSegmentsQuery(segmentValues);
    if (path.kind === 'err') return path;
    if (path.segments === undefined)
      return { kind: 'err', message: 'A segment scope needs `segment`' };
    return {
      kind: 'ok',
      scope: { kind: 'segment', projectId: id as ProjectId, path: path.segments },
    };
  }
  return { kind: 'err', message: '`scopeKind` must be one of tenant, org, project, segment' };
}

export function serializePromotion(p: Promotion): Record<string, unknown> {
  return {
    id: p.id,
    agentId: p.agentId,
    scope: liveScopeToWire(p.scope),
    action: p.action,
    fromVersion: p.fromVersion as unknown as string | null,
    toVersion: p.toVersion as unknown as string | null,
    requestedBy: p.requestedBy,
    ...(p.reason !== undefined && { reason: p.reason }),
    ...(p.evalRunId !== undefined && { evalRunId: p.evalRunId }),
    createdAt: p.createdAt as unknown as string,
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { AgentPinScope, Cursor, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ReleaseGateBinding, ReleaseGateError } from '../release-gate-binding.js';
import type { AppEnv } from '../types.js';
import { parseAgentPinScopeBody } from './agent-pin-scope-wire.js';
import { scopeFromQuery } from './agent-pins.js';
import { clampLimit } from './pagination.js';
import { parseReleaseGateSpec } from './release-gate-spec.js';
import { serializeReleaseGate } from './release-gate-wire.js';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Release gates: what an agent version must show before it is pinned for
 * a scope. The same registry shape as retention policies:
 *   GET  /                                      each gate's latest active version (?agentId=, scope)
 *   GET  /:releaseGateId                        its latest active version
 *   GET  /:releaseGateId/versions[/:version]    every version, or one
 *   POST /                                      publish {id, version, agentId, scope, spec, description?}
 *   POST /:releaseGateId/versions/:version/unregister|reinstate
 *
 * Writes need `admin` on the tenant: whoever may pin mustn't be able to
 * loosen the gate on their own pin. Reads need `read` on the gate's
 * scope (a segment's: its project), as corrector groups do: one the
 * caller can't read answers 404, as if it weren't there, and the list
 * shows only those they can.
 */
export function releaseGatesRouter(
  binding: ReleaseGateBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  if (authorizer !== undefined) {
    r.use('*', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const tenantId = c.get('tenantId') as unknown as string;
      return authorizer.authorize('admin', () => ref('tenant', tenantId))(c, next);
    });
  }

  /** Whether the caller may read a release gate: `read` on its scope. */
  const canRead = async (c: Ctx, gate: { readonly scope: AgentPinScope }): Promise<boolean> =>
    authorizer === undefined ||
    authorizer.can(c, 'read', scopeRef(c.get('tenantId') as TenantId, gate.scope));

  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const scope = scopeFromQuery((n) => c.req.query(n), c.req.queries('segment') ?? []);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    const agentId = c.req.query('agentId');
    const cursor = c.req.query('cursor');
    const page = await binding.list({
      tenantId: c.get('tenantId') as TenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(agentId !== undefined && agentId.length > 0 && { agentId }),
      ...(scope.scope !== undefined && { scope: scope.scope }),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (p) =>
            scopeRef(c.get('tenantId') as TenantId, p.scope),
          );
    return c.json({
      data: visible.map(serializeReleaseGate),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:releaseGateId', async (c) => {
    const found = await binding.get({
      tenantId: c.get('tenantId') as TenantId,
      id: c.req.param('releaseGateId'),
    });
    if (found === null || !(await canRead(c, found))) {
      return notFound(c, c.req.param('releaseGateId'));
    }
    return c.json(serializeReleaseGate(found));
  });

  r.get('/:releaseGateId/versions', async (c) => {
    const versions = await binding.listVersions({
      tenantId: c.get('tenantId') as TenantId,
      id: c.req.param('releaseGateId'),
    });
    // A gate's versions share its scope (`release-gate-scope-changed`).
    const first = versions[0];
    if (first === undefined || !(await canRead(c, first))) {
      return notFound(c, c.req.param('releaseGateId'));
    }
    return c.json({ data: versions.map(serializeReleaseGate), hasMore: false });
  });

  r.get('/:releaseGateId/versions/:version', async (c) => {
    const found = await binding.getVersion({
      tenantId: c.get('tenantId') as TenantId,
      id: c.req.param('releaseGateId'),
      version: c.req.param('version'),
    });
    if (found === null || !(await canRead(c, found))) {
      return notFound(c, c.req.param('releaseGateId'), c.req.param('version'));
    }
    return c.json(serializeReleaseGate(found));
  });

  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badInput(c, requestId, 'Request body must be a JSON object');
    }
    const parsed = parsePublishBody(body);
    if (parsed.kind === 'err') {
      c.status(statusFor('validation-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: `The release gate isn't valid: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
            issues: parsed.issues,
          },
          requestId,
        ),
      );
    }
    const outcome = await binding.publish({
      tenantId: c.get('tenantId') as TenantId,
      ...parsed.value,
    });
    if (outcome.kind === 'err') return failed(c, requestId, outcome.error);
    c.status(201);
    return c.json(serializeReleaseGate(outcome.value));
  });

  for (const action of ['unregister', 'reinstate'] as const) {
    r.post(`/:releaseGateId/versions/:version/${action}`, async (c) => {
      const outcome = await binding[action]({
        tenantId: c.get('tenantId') as TenantId,
        id: c.req.param('releaseGateId'),
        version: c.req.param('version'),
      });
      if (outcome.kind === 'err') return failed(c, c.get('requestId'), outcome.error);
      return c.json(serializeReleaseGate(outcome.value));
    });
  }

  return r;
}

type Ctx = Context<AppEnv>;

/** The resource a release gate's scope is: what reading it needs `read` on. */
function scopeRef(tenantId: TenantId, scope: AgentPinScope) {
  switch (scope.kind) {
    case 'tenant':
      return ref('tenant', tenantId as unknown as string);
    case 'org':
      return ref('org', scope.orgId as unknown as string);
    case 'project':
    case 'segment':
      return ref('project', scope.projectId as unknown as string);
  }
}

function badInput(c: Ctx, requestId: string, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function notFound(c: Ctx, releaseGateId: string, version?: string) {
  c.status(statusFor('release-gate-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'release-gate-not-found',
        message:
          version === undefined
            ? `No active release gate "${releaseGateId}"`
            : `Release gate "${releaseGateId}" has no version ${version}`,
        releaseGateId,
      },
      c.get('requestId'),
    ),
  );
}

function failed(c: Ctx, requestId: string, error: ReleaseGateError) {
  c.status(statusFor(error.code) as never);
  return c.json(toWireError({ ...error }, requestId));
}

type Issue = { readonly path: string; readonly message: string };

function parsePublishBody(body: unknown):
  | {
      kind: 'ok';
      value: Omit<Parameters<ReleaseGateBinding['publish']>[0], 'tenantId'>;
    }
  | { kind: 'err'; issues: readonly Issue[] } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', issues: [{ path: '', message: 'the body must be a JSON object' }] };
  }
  const b = body as Record<string, unknown>;
  const issues: Issue[] = [];
  for (const key of Object.keys(b)) {
    if (!['id', 'version', 'agentId', 'scope', 'spec', 'description'].includes(key)) {
      issues.push({ path: `/${key}`, message: `\`${key}\` isn't a release gate field` });
    }
  }
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) {
    issues.push({
      path: '/id',
      message:
        '`id` must be lowercase letters, digits, `.`, `_` or `-` (e.g. "acme.drafting-prod")',
    });
  }
  if (typeof b.version !== 'string' || !SEMVER_RE.test(b.version)) {
    issues.push({ path: '/version', message: '`version` must be a semver version (e.g. "1.0.0")' });
  }
  if (typeof b.agentId !== 'string' || b.agentId === '') {
    issues.push({ path: '/agentId', message: '`agentId` is required: the agent the gate checks' });
  }
  const scope = parseAgentPinScopeBody(b.scope);
  if (scope.kind === 'err') issues.push({ path: '/scope', message: scope.message });
  const spec = parseReleaseGateSpec(b.spec);
  if (spec.kind === 'err') issues.push(...spec.issues);
  if (b.description !== undefined && (typeof b.description !== 'string' || b.description === '')) {
    issues.push({ path: '/description', message: '`description` must be a non-empty string' });
  }
  if (issues.length > 0 || scope.kind === 'err' || spec.kind === 'err') {
    return { kind: 'err', issues };
  }
  return {
    kind: 'ok',
    value: {
      id: b.id as string,
      version: b.version as string,
      agentId: b.agentId as string,
      scope: scope.scope,
      spec: spec.spec,
      ...(typeof b.description === 'string' && { description: b.description }),
    },
  };
}

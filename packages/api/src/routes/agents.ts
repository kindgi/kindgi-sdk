// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import {
  type Agent,
  type AgentId,
  type DefineAgentSpec,
  defineAgent,
  pinsDigest,
} from '@kindgi/agents';
import { type Principal, ref, tuplesForCreate } from '@kindgi/authz';
import type { Cursor, ProjectId, Semver, TenantId, UserId } from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from '../agent-binding.js';
import { resolveAgentPins } from '../agent-pins.js';
import type { BlockRegistryBinding } from '../block-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ToolRegistryBinding } from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams } from './scope-params.js';

/**
 * Agents resource routes.
 *
 * Registry storage is caller-plugged via `AgentRegistryBinding`. The
 * API package does not own persistence — the binding implementation
 * supplies the store (tests wrap the in-memory `AgentRegistry` from
 * `@kindgi/agents`).
 *
 * Publish is data-as-code: the body is a full `DefineAgentSpec` (the
 * same value `defineAgent(...)` accepts).
 *
 * With `toolRegistry`, a published version is pinned: each tool range
 * resolves once, at publish, to the exact version every run of that
 * version uses (`pins`, see `resolveAgentPins`), and a range that
 * matches no published version refuses the publish. Without it,
 * versions carry no pins and resolve their ranges per run.
 */
export function agentsRouter(
  binding: AgentRegistryBinding,
  authorizer?: Authorizer,
  toolRegistry?: ToolRegistryBinding,
  blockRegistry?: BlockRegistryBinding,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Authorization — check the resource directly (ref('agent', businessId));
  // permissions cascade from the parent project because the
  // AgentRegistryBinding's `publish` writes the `agent:X#parent@project:Y`
  // tuple via the enqueueTuples hook (see AgentPublishInput contract).
  //
  //   POST /                                         → admin on body.projectId
  //   GET /:agentId, GET /:agentId/versions[/…]      → read on the agent
  //   POST /:agentId/versions/:version/unregister    → admin on the agent
  //   POST /:agentId/versions/:version/reinstate     → admin on the agent
  //   GET / (list)                                   → tenant-scoped fetch;
  //                                                    with a project scope
  //                                                    (?scopeKind=project&scopeId=),
  //                                                    require read on that project
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
    r.use('/:agentId/*', async (c, next) => {
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const agentId = c.req.param('agentId') ?? '';
      const mw = authorizer.authorize(action, () => ref('agent', agentId));
      return mw(c, next);
    });
    r.use('/:agentId', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const agentId = c.req.param('agentId') ?? '';
      const mw = authorizer.authorize('read', () => ref('agent', agentId));
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
      data: page.data.map(serializeAgent),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:agentId (latest version) ----------
  r.get('/:agentId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;

    const agent = await binding.get({ tenantId, agentId });
    if (agent === null) {
      // Distinguish 410 gone (identity exists — head row present, no
      // active version) from 404 not-found (never registered).
      // Retirement is a derived state (no active
      // versions); the head row is the identity marker.
      const exists = await binding.headExists({ tenantId, agentId });
      if (exists) {
        c.status(statusFor('agent-gone') as never);
        return c.json(
          toWireError(
            {
              code: 'agent-gone',
              message: `Agent "${agentId as unknown as string}" has no active versions; reinstate a tombstoned version or publish a new one`,
              agentId: agentId as unknown as string,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent registered with id "${agentId as unknown as string}"`,
            agentId: agentId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeAgent(agent));
  });

  // ---------- GET /:agentId/versions (list versions) ----------
  r.get('/:agentId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');

    // Confirm the id exists at all — an empty versions list from the
    // binding is ambiguous (no versions vs. unknown id), so we do a
    // preliminary `get` to flip an unknown id to a `404`.
    const latest = await binding.get({ tenantId, agentId });
    if (latest === null) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent registered with id "${agentId as unknown as string}"`,
            agentId: agentId as unknown as string,
          },
          requestId,
        ),
      );
    }

    const page = await binding.listVersions({
      tenantId,
      agentId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
    });
    return c.json({
      data: page.data.map(serializeAgent),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:agentId/versions/:version ----------
  r.get('/:agentId/versions/:version', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const version = c.req.param('version') as Semver;

    const agent = await binding.getVersion({ tenantId, agentId, version });
    if (agent === null) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent "${agentId as unknown as string}" at version "${version as unknown as string}"`,
            agentId: agentId as unknown as string,
            version: version as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeAgent(agent));
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
    // agent-shape validator on purpose — the caller controls what
    // project the agent lands in; the agent definition itself is
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

    // Validate via defineAgent — same rules as the runtime primitive,
    // so an agent published through the API is byte-identical to one
    // constructed in-process. `defineAgent` returns a Result rather
    // than throwing. `projectId` is stripped from the spec passed to
    // `defineAgent` — the agent definition itself is project-agnostic
    // (the runtime primitive doesn't know about projects).
    const { projectId: _pid, ...specWithoutProjectId } = bodyObj;
    const defined = defineAgent(specWithoutProjectId as unknown as DefineAgentSpec);
    if (defined.kind === 'err') {
      c.status(statusFor('invalid-agent') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: defined.error.message,
            issues: defined.error.issues as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }

    // Pin the version: every tool range resolves now, once, to the
    // version its runs use. A range nothing satisfies refuses the
    // publish rather than store a partly pinned version.
    let agent: Agent = defined.value;
    if (toolRegistry !== undefined) {
      const resolved = await resolveAgentPins(toolRegistry, tenantId, defined.value, blockRegistry);
      if (resolved.kind === 'unpinnable') {
        c.status(statusFor('invalid-agent') as never);
        return c.json(
          toWireError(
            {
              code: 'validation-failed',
              message: `Agent "${defined.value.id as unknown as string}" uses tool versions that aren't published (${resolved.issues.length} issue${resolved.issues.length === 1 ? '' : 's'})`,
              issues: resolved.issues as unknown as Record<string, unknown>[],
            },
            requestId,
          ),
        );
      }
      agent = { ...agent, pins: resolved.pins, pinsDigest: pinsDigest(resolved.pins) };
    }

    const principal = c.get('principal') as Principal | undefined;
    const creatorUserId =
      principal?.actor.kind === 'user'
        ? (principal.actor.id as UserId)
        : ('00000000-0000-0000-0000-000000000000' as UserId);
    const outcome = await binding.publish({
      tenantId,
      projectId,
      agent,
      // Write the authorization tuples in the same transaction as the
      // registry row. The binding calls this with the business
      // `agentId`.
      enqueueTuples: (agentId) =>
        tuplesForCreate(
          { kind: 'agent', id: agentId as AgentId, tenantId, projectId },
          creatorUserId,
        ),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('agent-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-already-registered',
            message: `Agent "${outcome.agentId as unknown as string}" version "${outcome.version as unknown as string}" is already registered`,
            agentId: outcome.agentId as unknown as string,
            version: outcome.version as unknown as string,
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
      agentId: outcome.agentId as unknown as string,
      version: outcome.version as unknown as string,
    });
  });

  // ---------- POST /:agentId/versions/:version/unregister ----------
  r.post('/:agentId/versions/:version/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const version = c.req.param('version') as Semver;

    const outcome = await binding.unregister({ tenantId, agentId, version });
    if (!outcome.unregistered) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent "${agentId as unknown as string}" at version "${version as unknown as string}" to unregister`,
            agentId: agentId as unknown as string,
            version: version as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json({
      agentId: agentId as unknown as string,
      version: version as unknown as string,
      unregistered: true,
    });
  });

  // ---------- POST /:agentId/versions/:version/reinstate ----------
  // Un-tombstone a specific version — clears the version's tombstone
  // and recomputes the agent's latest version across active
  // versions. Restores the manifest bytes verbatim (semver hygiene:
  // reinstate never mutates). Idempotent: reinstating an active
  // version returns `wasTombstoned: false`.
  r.post('/:agentId/versions/:version/reinstate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId') as AgentId;
    const version = c.req.param('version') as Semver;

    const outcome = await binding.reinstateVersion({ tenantId, agentId, version });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'agent-not-found',
            message: `No agent "${agentId as unknown as string}" at version "${version as unknown as string}" to reinstate`,
            agentId: agentId as unknown as string,
            version: version as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json({
      agentId: outcome.agentId as unknown as string,
      version: outcome.version as unknown as string,
      wasTombstoned: outcome.wasTombstoned,
    });
  });

  return r;
}

function serializeAgent(a: AgentVersionRecord): Record<string, unknown> {
  return {
    id: a.id as unknown as string,
    version: a.version as unknown as string,
    name: a.name,
    ...(a.description !== undefined && { description: a.description }),
    instructions: a.instructions,
    ...(a.parameters !== undefined && { parameters: a.parameters }),
    ...(a.settings !== undefined && { settings: a.settings }),
    ...(a.modelSettings !== undefined && { modelSettings: a.modelSettings }),
    capabilities: a.capabilities,
    tools: a.tools,
    retrieval: a.retrieval,
    guardrails: a.guardrails,
    ...(a.conversationPolicy !== undefined && { conversationPolicy: a.conversationPolicy }),
    ...(a.budget !== undefined && { budget: a.budget }),
    ...(a.tags !== undefined && { tags: a.tags }),
    ...(a.preferredProvider !== undefined && { preferredProvider: a.preferredProvider }),
    ...(a.preferredModel !== undefined && { preferredModel: a.preferredModel }),
    ...(a.pins !== undefined && { pins: a.pins }),
    ...(a.pinsDigest !== undefined && { pinsDigest: a.pinsDigest }),
    ...(a.derivedFrom !== undefined && { derivedFrom: a.derivedFrom }),
    ...(a.unregisteredAt !== undefined && { unregisteredAt: a.unregisteredAt }),
  };
}

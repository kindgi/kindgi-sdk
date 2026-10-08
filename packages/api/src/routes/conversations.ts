// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type {
  Conversation,
  ConversationBinding,
  ConversationId,
  ConversationMessage,
  ConversationPageCursor,
} from '@kindgi/agents';
import { type ResourceRef, ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { RunBinding } from '@kindgi/runtime';
import type { AgentId, ProjectId, Semver, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';
import { parseListScope } from './scope-params.js';
import { refuseMalformedUuidParam } from './uuid-param.js';

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Conversations resource routes. All storage access goes through the
 * `ConversationBinding` — the router never touches storage directly.
 * Messages sort is `sequence asc` (natural conversation reading
 * order); conversation list sort is `openedAt DESC, id DESC`
 * (most-recently-opened first).
 */
/**
 * A `:conversationId` that isn't a conversation id is a 400
 * (`uuid-param.ts`), not a 500 from the uuid cast (as `runs` does).
 */
const refuseMalformedConversationId = refuseMalformedUuidParam(
  'conversationId',
  'a conversation id',
);

export function conversationsRouter(
  conversationBinding: ConversationBinding,
  runBinding: RunBinding,
  /**
   * When wired, a `projectId` given to `POST /` must be one of the
   * tenant's projects, and an omitted one is the tenant's Default project.
   */
  projectBinding?: ProjectBinding,
  /**
   * With one (T243 A): reading a conversation or its messages needs `read`
   * on its project (its agent, for one from before projects); opening or
   * closing one needs `execute` on its agent, as starting a run does.
   */
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const statusRaw = c.req.query('status');
    let statusFilter: 'open' | 'closed' | undefined;
    if (statusRaw !== undefined && statusRaw.length > 0) {
      if (statusRaw !== 'open' && statusRaw !== 'closed') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`status` must be one of: open, closed' },
            requestId,
          ),
        );
      }
      statusFilter = statusRaw;
    }

    const agentIdRaw = c.req.query('agentId');

    // Replay conversations (a comparison's replays) are left out unless asked for.
    const replaysRaw = c.req.query('replays');
    if (
      replaysRaw !== undefined &&
      replaysRaw !== 'exclude' &&
      replaysRaw !== 'include' &&
      replaysRaw !== 'only'
    ) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`replays` must be `exclude`, `include` or `only`' },
          requestId,
        ),
      );
    }

    const scopeParsed = parseListScope(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    let before: ConversationPageCursor | undefined;
    const rawCursor = c.req.query('cursor');
    if (rawCursor !== undefined && rawCursor.length > 0) {
      const decoded = decodeCursor(rawCursor);
      if (decoded === null) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
        );
      }
      before = { openedAt: decoded.createdAt, id: decoded.id as unknown as ConversationId };
    }

    const listResult = await conversationBinding.listConversationsPage({
      tenantId,
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(agentIdRaw !== undefined && agentIdRaw.length > 0 && { agentId: agentIdRaw as AgentId }),
      ...(statusFilter !== undefined && { status: statusFilter }),
      replays: replaysRaw ?? 'exclude',
      ...(before !== undefined && { before }),
      limit,
    });
    if (listResult.kind === 'err') {
      c.status(statusFor(listResult.error.code) as never);
      return c.json(toWireError(listResult.error as never, requestId));
    }
    const { data, hasMore } = listResult.value;
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor({
            createdAt: last.openedAt as unknown as string,
            id: last.id as unknown as string,
          })
        : undefined;
    const visible =
      authorizer === undefined
        ? data
        : await authorizer.filterByCan(c, 'read', data, conversationRef);
    return c.json({
      data: visible.map(serializeConversation),
      hasMore,
      ...(nextCursor !== undefined && { nextCursor }),
    });
  });

  // ---------- GET /:conversationId ----------
  r.get('/:conversationId', refuseMalformedConversationId, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const conversationId = c.req.param('conversationId') as ConversationId;

    const got = await conversationBinding.getConversation(tenantId, conversationId);
    if (got.kind === 'err') {
      c.status(statusFor(got.error.code) as never);
      return c.json(toWireError(got.error as never, requestId));
    }
    const refused = await deniedBy(authorizer, c, 'read', conversationRef(got.value));
    if (refused !== undefined) return refused;
    return c.json(serializeConversation(got.value));
  });

  // ---------- POST / (open) ----------
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
    const parsed = parseOpenBody(body);
    if (parsed.kind === 'err') {
      c.status(statusFor(parsed.error.code) as never);
      return c.json(toWireError(parsed.error, requestId));
    }
    const supplied = parsed.value.projectId;
    if (
      supplied !== undefined &&
      projectBinding !== undefined &&
      (await projectBinding.get(tenantId, supplied)) === undefined
    ) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `\`projectId\` "${supplied as unknown as string}" does not resolve to a project in this tenant`,
          },
          requestId,
        ),
      );
    }
    // Omitted: the tenant's Default project, as for a run. No Default (or
    // no project binding): no project, never a refusal.
    const projectId = supplied ?? (await projectBinding?.getDefault(tenantId))?.id;
    const refused = await deniedBy(
      authorizer,
      c,
      'execute',
      ref('agent', parsed.value.agentId as unknown as string),
    );
    if (refused !== undefined) return refused;

    const opened = await conversationBinding.openConversation({
      tenantId,
      ...(projectId !== undefined && { projectId }),
      agentId: parsed.value.agentId,
      agentVersion: parsed.value.agentVersion,
      title: parsed.value.title,
      scope: parsed.value.scope,
      ...(parsed.value.participantId !== undefined && {
        participantId: parsed.value.participantId,
      }),
      ...(parsed.value.metadata !== undefined && { metadata: parsed.value.metadata }),
    });
    if (opened.kind === 'err') {
      c.status(statusFor(opened.error.code) as never);
      return c.json(toWireError(opened.error as never, requestId));
    }
    c.status(201);
    return c.json(serializeConversation(opened.value));
  });

  // ---------- POST /:conversationId/close (idempotent) ----------
  r.post('/:conversationId/close', refuseMalformedConversationId, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const conversationId = c.req.param('conversationId') as ConversationId;

    const existing = await conversationBinding.getConversation(tenantId, conversationId);
    if (existing.kind === 'err') {
      c.status(statusFor(existing.error.code) as never);
      return c.json(toWireError(existing.error as never, requestId));
    }
    const refused = await deniedBy(
      authorizer,
      c,
      'execute',
      ref('agent', existing.value.agentId as unknown as string),
    );
    if (refused !== undefined) return refused;
    // Close is idempotent — closing an already-closed conversation
    // returns 200 with the current row, no error and no timestamp bump.
    if (existing.value.closedAt !== undefined) {
      return c.json(serializeConversation(existing.value));
    }
    const closed = await conversationBinding.closeConversation(
      tenantId,
      conversationId,
      runBinding,
    );
    if (closed.kind === 'err') {
      c.status(statusFor(closed.error.code) as never);
      return c.json(toWireError(closed.error as never, requestId));
    }
    return c.json(serializeConversation(closed.value));
  });

  // ---------- GET /:conversationId/messages (cursor-paginated, sequence asc) ----------
  r.get('/:conversationId/messages', refuseMalformedConversationId, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const conversationId = c.req.param('conversationId') as ConversationId;
    const limit = clampLimit(c.req.query('limit'));

    const rawCursor = c.req.query('cursor');
    let sinceSequence: number | undefined;
    if (rawCursor !== undefined && rawCursor.length > 0) {
      const decoded = decodeMessageCursor(rawCursor);
      if (decoded === null) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
        );
      }
      // Advance past the last-seen sequence. `readMessages`' sinceSequence
      // is inclusive (`>= n`), so bump by one for exclusive resume.
      sinceSequence = decoded + 1;
    }

    if (authorizer !== undefined) {
      const got = await conversationBinding.getConversation(tenantId, conversationId);
      if (got.kind === 'err') {
        c.status(statusFor(got.error.code) as never);
        return c.json(toWireError(got.error as never, requestId));
      }
      const refused = await deniedBy(authorizer, c, 'read', conversationRef(got.value));
      if (refused !== undefined) return refused;
    }
    const result = await conversationBinding.readMessages({
      tenantId,
      conversationId,
      ...(sinceSequence !== undefined && { sinceSequence }),
      limit: limit + 1,
    });
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(toWireError(result.error as never, requestId));
    }
    const all = result.value;
    const hasMore = all.length > limit;
    const page = hasMore ? all.slice(0, limit) : all;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeMessageCursor(last.sequence) : undefined;
    return c.json({
      data: page.map(serializeMessage),
      hasMore,
      ...(nextCursor !== undefined && { nextCursor }),
    });
  });

  return r;
}

/**
 * What a conversation is checked on: its project, or its agent for one
 * opened before conversations recorded a project. (A `conversation`
 * object has no parent tuple, so a check on it would refuse everyone.)
 */
function conversationRef(conv: Conversation): ResourceRef {
  return conv.projectId !== undefined
    ? ref('project', conv.projectId as unknown as string)
    : ref('agent', conv.agentId as unknown as string);
}

// ============ serializers ============

function serializeConversation(c: Conversation): Record<string, unknown> {
  return {
    id: c.id as unknown as string,
    tenantId: c.tenantId as unknown as string,
    agentId: c.agentId as unknown as string,
    agentVersion: c.agentVersion as unknown as string,
    title: c.title,
    ...(c.participantId !== undefined && { participantId: c.participantId }),
    ...(c.projectId !== undefined && { projectId: c.projectId as unknown as string }),
    scope: c.scope,
    status: (c.closedAt === undefined ? 'open' : 'closed') as 'open' | 'closed',
    openedAt: c.openedAt as unknown as string,
    ...(c.closedAt !== undefined && { closedAt: c.closedAt as unknown as string }),
    turnCount: c.turnCount,
    ...(c.lastMessageAt !== undefined && { lastMessageAt: c.lastMessageAt as unknown as string }),
    ...(c.metadata !== undefined && { metadata: c.metadata }),
  };
}

function serializeMessage(m: ConversationMessage): Record<string, unknown> {
  return {
    sequence: m.sequence,
    role: m.role,
    content: m.content,
    ...(m.toolCall !== undefined && { toolCall: m.toolCall }),
    ...(m.actor !== undefined && { actor: m.actor }),
    createdAt: m.createdAt as unknown as string,
  };
}

// ============ cursor helpers ============

function encodeMessageCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence }), 'utf8').toString('base64url');
}

function decodeMessageCursor(raw: string): number | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { sequence?: unknown }).sequence !== 'number'
    ) {
      return null;
    }
    return (parsed as { sequence: number }).sequence;
  } catch {
    return null;
  }
}

// ============ body parsers ============

interface ParsedOpenBody {
  readonly agentId: AgentId;
  readonly agentVersion: Semver;
  readonly title: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly projectId?: ProjectId;
  readonly participantId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function parseOpenBody(
  body: unknown,
):
  | { kind: 'ok'; value: ParsedOpenBody }
  | { kind: 'err'; error: { code: string; message: string } } {
  if (body === null || typeof body !== 'object') {
    return { kind: 'err', error: { code: 'bad-input', message: 'Request body must be an object' } };
  }
  const b = body as Record<string, unknown>;
  const agentId = b.agentId;
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`agentId` must be a non-empty string' },
    };
  }
  const agentVersion = b.agentVersion;
  if (typeof agentVersion !== 'string' || agentVersion.length === 0) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`agentVersion` must be a non-empty string' },
    };
  }
  const titleRaw = b.title;
  if (titleRaw !== undefined && typeof titleRaw !== 'string') {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`title` must be a string when supplied' },
    };
  }
  // Default title when omitted — the underlying runtime rejects blanks.
  // Callers who want a first-turn auto-title supply that themselves.
  const title =
    titleRaw !== undefined && titleRaw.trim().length > 0 ? titleRaw : 'Untitled conversation';

  const scopeRaw = b.scope;
  let scope: Readonly<Record<string, unknown>>;
  if (scopeRaw === undefined) {
    scope = {};
  } else if (scopeRaw === null || typeof scopeRaw !== 'object' || Array.isArray(scopeRaw)) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`scope` must be an object when supplied' },
    };
  } else {
    scope = scopeRaw as Readonly<Record<string, unknown>>;
  }

  const projectIdRaw = b.projectId;
  if (
    projectIdRaw !== undefined &&
    (typeof projectIdRaw !== 'string' || !PROJECT_ID_RE.test(projectIdRaw))
  ) {
    return {
      kind: 'err',
      error: {
        code: 'bad-input',
        message: '`projectId` must be a project id (a UUID) when supplied',
      },
    };
  }

  const participantIdRaw = b.participantId;
  if (participantIdRaw !== undefined && typeof participantIdRaw !== 'string') {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`participantId` must be a string when supplied' },
    };
  }

  const metadataRaw = b.metadata;
  let metadata: Readonly<Record<string, unknown>> | undefined;
  if (metadataRaw !== undefined) {
    if (metadataRaw === null || typeof metadataRaw !== 'object' || Array.isArray(metadataRaw)) {
      return {
        kind: 'err',
        error: { code: 'bad-input', message: '`metadata` must be an object when supplied' },
      };
    }
    metadata = metadataRaw as Readonly<Record<string, unknown>>;
  }

  return {
    kind: 'ok',
    value: {
      agentId: agentId as AgentId,
      agentVersion: agentVersion as Semver,
      title,
      scope,
      ...(projectIdRaw !== undefined && { projectId: projectIdRaw as ProjectId }),
      ...(participantIdRaw !== undefined && { participantId: participantIdRaw }),
      ...(metadata !== undefined && { metadata }),
    },
  };
}

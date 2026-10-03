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
import type { RunBinding } from '@kindgi/runtime';
import type { AgentId, Semver, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

/**
 * Conversations resource routes. All storage access goes through the
 * `ConversationBinding` — the router never touches storage directly.
 * Messages sort is `sequence asc` (natural conversation reading
 * order); conversation list sort is `openedAt DESC, id DESC`
 * (most-recently-opened first).
 */
export function conversationsRouter(
  conversationBinding: ConversationBinding,
  runBinding: RunBinding,
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
      ...(agentIdRaw !== undefined && agentIdRaw.length > 0 && { agentId: agentIdRaw as AgentId }),
      ...(statusFilter !== undefined && { status: statusFilter }),
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
    return c.json({
      data: data.map(serializeConversation),
      hasMore,
      ...(nextCursor !== undefined && { nextCursor }),
    });
  });

  // ---------- GET /:conversationId ----------
  r.get('/:conversationId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const conversationId = c.req.param('conversationId') as ConversationId;

    const got = await conversationBinding.getConversation(tenantId, conversationId);
    if (got.kind === 'err') {
      c.status(statusFor(got.error.code) as never);
      return c.json(toWireError(got.error as never, requestId));
    }
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

    const opened = await conversationBinding.openConversation({
      tenantId,
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
  r.post('/:conversationId/close', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const conversationId = c.req.param('conversationId') as ConversationId;

    const existing = await conversationBinding.getConversation(tenantId, conversationId);
    if (existing.kind === 'err') {
      c.status(statusFor(existing.error.code) as never);
      return c.json(toWireError(existing.error as never, requestId));
    }
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
  r.get('/:conversationId/messages', async (c) => {
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

// ============ serializers ============

function serializeConversation(c: Conversation): Record<string, unknown> {
  return {
    id: c.id as unknown as string,
    tenantId: c.tenantId as unknown as string,
    agentId: c.agentId as unknown as string,
    agentVersion: c.agentVersion as unknown as string,
    title: c.title,
    ...(c.participantId !== undefined && { participantId: c.participantId }),
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
      ...(participantIdRaw !== undefined && { participantId: participantIdRaw }),
      ...(metadata !== undefined && { metadata }),
    },
  };
}

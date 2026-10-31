// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type {
  Conversation,
  ConversationBinding,
  ConversationId,
  ConversationMessage,
  ConversationPageCursor,
} from '@kindgi/agents';
import { type ResourceRef, denyPayload, ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { RunBinding } from '@kindgi/runtime';
import type { AgentId, ProjectId, Semver, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import { callerRef } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import { type ItemRights, runIn } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { databaseBusyAnswer } from '../middleware/error-mapper.js';
import {
  type ReferenceScopeBinding,
  outOfScopeResponse,
  referencesOutOfScope,
} from '../reference-scope.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';
import { clampLimit, decodeCursor, encodeCursor, isCursorTime } from './pagination.js';
import { participantRefusal } from './participant-access.js';
import { parseListScope } from './scope-params.js';
import { conversationNotFound, hiddenOr, unreadable } from './turn-access.js';
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
   * tenant's projects; an omitted one is the agent's own project, or the
   * tenant's Default for an agent `agentRegistry` doesn't place.
   */
  projectBinding?: ProjectBinding,
  /**
   * With one: reading a conversation or its messages needs `read` on its
   * project (its agent, for one from before projects); opening or closing
   * one needs `execute` on its agent, as starting a run does; unregistering
   * one needs `write` on its project (or agent). A caller refused on a
   * conversation they can't read gets the answer for one that doesn't
   * exist (`hiddenOr`); one who can read it keeps the 403.
   */
  authorizer?: Authorizer,
  /** What a conversation's project may run (`reference-scope.ts`); absent → as named. */
  referenceScope?: ReferenceScopeBinding,
  /** Where an agent is filed: a conversation opened without `projectId` goes there. */
  agentRegistry?: AgentRegistryBinding,
  /**
   * Rights on an agent more than one project serves (`item-rights.ts`):
   * opening or closing a conversation in one of its projects is that
   * project's `call`, and a project-scoped key's conversation opened
   * without `projectId` goes to the key's project. Absent: every agent has
   * one project.
   */
  itemRights?: ItemRights,
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

    // "My conversations": the ones the caller opened. Only `me`: a list of
    // someone else's isn't a filter this route offers.
    const openedByRaw = c.req.query('openedBy');
    if (openedByRaw !== undefined && openedByRaw !== 'me') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`openedBy` must be `me`' }, requestId),
      );
    }
    const openedBy = openedByRaw === 'me' ? callerRef(c) : undefined;
    // Every page of the list says it holds only the caller's own, an empty
    // one too, so a client can tell a runtime that ignores the filter.
    const filtered = openedByRaw === 'me' ? { openedBy: 'me' as const } : {};
    // A caller with no principal opened nothing it could be listed by.
    if (openedByRaw === 'me' && openedBy === undefined) {
      return c.json({ data: [], hasMore: false, ...filtered });
    }

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
      if (decoded === null || !isCursorTime(decoded.createdAt)) {
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
      ...(openedBy !== undefined && { openedBy }),
      replays: replaysRaw ?? 'exclude',
      ...(before !== undefined && { before }),
      limit,
    });
    if (listResult.kind === 'err') {
      const busy = databaseBusyAnswer(listResult.error, c);
      if (busy !== undefined) return busy;
      c.status(statusFor(listResult.error.code) as never);
      return c.json(toWireError(listResult.error as never, requestId));
    }
    const { data, hasMore, next } = listResult.value;
    const last = data[data.length - 1];
    // The binding's exact position when it gives one (`openedAt` to the
    // microsecond); else the last row's, as a binding before it answers.
    const position =
      next ?? (last !== undefined ? { openedAt: last.openedAt, id: last.id } : undefined);
    const nextCursor =
      hasMore && position !== undefined
        ? encodeCursor({
            createdAt: position.openedAt as unknown as string,
            id: position.id as unknown as string,
          })
        : undefined;
    // The binding narrows; this keeps a page right from one that doesn't.
    const theirs = openedBy === undefined ? data : data.filter((row) => row.openedBy === openedBy);
    const visible =
      authorizer === undefined
        ? theirs
        : await authorizer.filterByCan(c, 'read', theirs, conversationRef);
    return c.json({
      data: visible.map(serializeConversation),
      hasMore,
      ...(nextCursor !== undefined && { nextCursor }),
      ...filtered,
    });
  });

  // ---------- GET /:conversationId ----------
  r.get('/:conversationId', refuseMalformedConversationId, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const conversationId = c.req.param('conversationId') as ConversationId;

    const got = await conversationBinding.getConversation(tenantId, conversationId);
    if (got.kind === 'err') {
      const busy = databaseBusyAnswer(got.error, c);
      if (busy !== undefined) return busy;
      return lookupFailed(c, conversationId, got.error, requestId);
    }
    // One the caller can't read is answered as if it didn't exist.
    if (await unreadable(c, authorizer, got.value)) return conversationNotFound(c, conversationId);
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
    const agentId = parsed.value.agentId as unknown as string;
    // The agent's projects when more than one serves it (`item-rights.ts`).
    const served =
      authorizer === undefined ? undefined : await itemRights?.multi(c, 'agent', agentId);
    // Opening it in a project the caller names needs `write` there, as a run
    // naming one outside its agent's projects does: its turns land there.
    // Named one of its projects, for an agent more than one project serves,
    // `call` there is the whole check instead (`openIn`), as for a run.
    // Checked first, so a caller without it learns nothing of which projects
    // exist.
    if (authorizer !== undefined && supplied !== undefined && served?.includes(supplied) !== true) {
      const named = ref('project', supplied as unknown as string);
      const decision = await authorizer.check(c, 'write', named);
      if (!decision.allowed) {
        const deny = denyPayload('write', named.type, named.id, decision.reason);
        c.status(403);
        return c.json(
          toWireError(
            {
              code: deny.code,
              message: `Permission denied: opening a conversation in project ${named.id} needs write on it; omit \`projectId\` to open it in the agent's own project`,
              action: deny.action,
              resource: deny.resource,
              reason: deny.reason,
            },
            requestId,
          ),
        );
      }
    }
    // Omitted: the agent's own project, as for a run. An agent the registry
    // doesn't place (or from before projects): the tenant's Default. No
    // Default (or no project binding): no project, never a refusal.
    const own = async () =>
      (
        await agentRegistry?.getVersion({
          tenantId,
          agentId: parsed.value.agentId,
          version: parsed.value.agentVersion,
        })
      )?.projectId ?? (await projectBinding?.getDefault(tenantId))?.id;
    // Also before the named project's existence: a caller refused there gets
    // the same answer whether it exists or not.
    const open = await openIn(c, authorizer, itemRights, served, agentId, supplied, own);
    if (open.refused !== undefined) return open.refused;
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
    const projectId = open.projectId;
    // Its agent, at the version its turns run, must be its project's to
    // reach (`reference-scope.ts`).
    if (projectId !== undefined) {
      const outOfScope = await referencesOutOfScope(referenceScope, tenantId, projectId, [
        {
          path: '/agentId',
          kind: 'agent',
          id: parsed.value.agentId as unknown as string,
          version: parsed.value.agentVersion as unknown as string,
        },
      ]);
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }
    // Opening it for a participant: its turns run with their memory.
    const notAllowed = await participantRefusal(c, authorizer, {
      participantId: parsed.value.participantId,
      projectId: projectId as unknown as string | undefined,
    });
    if (notAllowed !== undefined) return notAllowed;

    // Who opened it: the caller, never the body.
    const openedBy = callerRef(c);
    const opened = await conversationBinding.openConversation({
      tenantId,
      ...(projectId !== undefined && { projectId }),
      ...(openedBy !== undefined && { openedBy }),
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
    if (existing.kind === 'err') return lookupFailed(c, conversationId, existing.error, requestId);
    // An agent more than one project serves: closing a conversation in one
    // of its projects is that project's `call`.
    const agentId = existing.value.agentId as unknown as string;
    const served =
      authorizer === undefined ? undefined : await itemRights?.multi(c, 'agent', agentId);
    const own = existing.value.projectId as unknown as string | undefined;
    const refused =
      served !== undefined &&
      itemRights !== undefined &&
      own !== undefined &&
      served.includes(own as ProjectId)
        ? await runIn(
            c,
            itemRights,
            { kind: 'agent', id: agentId },
            own,
            `closing a conversation with agent "${agentId}"`,
          )
        : await deniedBy(authorizer, c, 'execute', ref('agent', agentId));
    // Refused: as if it didn't exist, unless the caller can read it. Read
    // isn't needed to close one: a project's `call` closes what it opens.
    if (refused !== undefined) {
      return hiddenOr(c, authorizer, conversationId, existing.value, refused);
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

  // ---------- POST /:conversationId/unregister ----------
  // A tombstone: from now on no read, list or recall returns the
  // conversation, and no message can be added; the retention sweep
  // removes it after the tenant's grace. Unregistered already, or never: 404.
  // It needs `write` on the conversation's project (its agent, for one from
  // before projects): an editor or above. Reading it isn't enough, nor is
  // `execute`, which opening and closing one take. A caller who can't read
  // it is answered as if it didn't exist; one who can, 403.
  r.post('/:conversationId/unregister', refuseMalformedConversationId, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const conversationId = c.req.param('conversationId') as ConversationId;
    if (conversationBinding.unregisterConversation === undefined) {
      c.status(statusFor('conversation-unregister-unsupported') as never);
      return c.json(
        toWireError(
          {
            code: 'conversation-unregister-unsupported',
            message: "This runtime can't unregister conversations.",
          },
          requestId,
        ),
      );
    }
    const existing = await conversationBinding.getConversation(tenantId, conversationId);
    if (existing.kind === 'err') return lookupFailed(c, conversationId, existing.error, requestId);
    const refused = await deniedBy(authorizer, c, 'write', conversationRef(existing.value));
    if (refused !== undefined) {
      return hiddenOr(c, authorizer, conversationId, existing.value, refused);
    }
    const unregistered = await conversationBinding.unregisterConversation(tenantId, conversationId);
    if (unregistered.kind === 'err') {
      c.status(statusFor(unregistered.error.code) as never);
      return c.json(toWireError(unregistered.error as never, requestId));
    }
    return c.json(serializeConversation(unregistered.value));
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
        const busy = databaseBusyAnswer(got.error, c);
        if (busy !== undefined) return busy;
        return lookupFailed(c, conversationId, got.error, requestId);
      }
      if (await unreadable(c, authorizer, got.value)) {
        return conversationNotFound(c, conversationId);
      }
    }
    const result = await conversationBinding.readMessages({
      tenantId,
      conversationId,
      ...(sinceSequence !== undefined && { sinceSequence }),
      limit: limit + 1,
    });
    if (result.kind === 'err') {
      const busy = databaseBusyAnswer(result.error, c);
      if (busy !== undefined) return busy;
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
 * Where a conversation opens, and whether the caller may open it there:
 * `execute` on its agent, or, for an agent more than one project serves
 * (`served`, its projects) opened in one of its projects, that project's
 * `call` alone (`item-rights.ts`). Unnamed, a project-scoped key's
 * conversation goes to the key's project when it serves the agent, as its
 * unnamed run does; else to `own()`. A refused caller is never placed.
 */
async function openIn(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  itemRights: ItemRights | undefined,
  served: readonly ProjectId[] | undefined,
  agentId: string,
  supplied: ProjectId | undefined,
  own: () => Promise<ProjectId | undefined>,
): Promise<{ readonly projectId?: ProjectId | undefined; readonly refused?: Response }> {
  if (served === undefined || itemRights === undefined) {
    const refused = await deniedBy(authorizer, c, 'execute', ref('agent', agentId));
    if (refused !== undefined) return { refused };
    return { projectId: supplied ?? (await own()) };
  }
  const keyProject = c.get('tokenProjectId') as ProjectId | undefined;
  const placed =
    supplied === undefined && keyProject !== undefined && served.includes(keyProject)
      ? keyProject
      : undefined;
  const projectId = supplied ?? placed ?? (await own());
  const refused =
    projectId !== undefined && served.includes(projectId)
      ? await runIn(
          c,
          itemRights,
          { kind: 'agent', id: agentId },
          projectId,
          `opening a conversation with agent "${agentId}"`,
        )
      : await deniedBy(authorizer, c, 'execute', ref('agent', agentId));
  return refused !== undefined ? { refused } : { projectId };
}

/**
 * A failed lookup by id, answered: a conversation that isn't there as
 * `conversationNotFound`, the answer one the caller can't read gets too, so
 * the two stay the same whatever the binding's message; any other error as
 * the binding gave it.
 */
function lookupFailed(
  c: Context<AppEnv>,
  conversationId: string,
  error: { readonly code: string },
  requestId: string,
): Response {
  if (error.code === 'conversation-not-found') return conversationNotFound(c, conversationId);
  c.status(statusFor(error.code) as never);
  return c.json(toWireError(error as never, requestId));
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
    ...(c.openedBy !== undefined && { openedBy: c.openedBy }),
    scope: c.scope,
    status: (c.closedAt === undefined ? 'open' : 'closed') as 'open' | 'closed',
    openedAt: c.openedAt as unknown as string,
    ...(c.closedAt !== undefined && { closedAt: c.closedAt as unknown as string }),
    ...(c.unregisteredAt !== undefined && {
      unregisteredAt: c.unregisteredAt as unknown as string,
    }),
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
    ...(m.files !== undefined && m.files.length > 0 && { files: m.files }),
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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Filter, Page, ThreadId } from '@kindgi/types';

import type { ScopeRef } from '../scope-wire.js';
import { scopeToQuery } from '../scope-wire.js';
import { singleStatusQuery } from '../status-query.js';
import type { Transport } from '../transport.js';
import type {
  Conversation,
  ConversationMessage,
  ConversationStatus,
  OpenConversationInput,
} from '../types.js';

/**
 * Conversations resource — durable multi-turn threads.
 *
 * A conversation groups agent invocations into a user-visible thread.
 * Distinct from `Run`: one conversation contains N runs (one per
 * turn). Messages inside a conversation persist as memory facts of
 * type `agent-message` scoped to `threadId = conversationId` (see
 * `@kindgi/agents`).
 *
 * Flow:
 *   1. `open()` — establishes the thread; returns the full
 *      `Conversation` row (wire returns 201 with the row body).
 *   2. Each turn: `runs.start({ agent, input, conversation })` — the
 *      SDK's runs surface accepts a conversation reference so the
 *      turn appends to the same thread.
 *   3. `messages(id)` — read the accumulated message history.
 *   4. `close(id)` — freezes the thread; subsequent turns rejected.
 *
 * There is no `append` operation for user messages — that's
 * `runs.start`'s job (starting a turn with the user's input). Agent
 * and tool messages are written by the runtime as the turn executes.
 */
export interface ConversationsClient {
  /**
   * Open a new conversation. Server persists the thread row and returns
   * the full `Conversation` row (201) — server-generated `id`, pinned
   * `openedAt`, initial `turnCount`. Agent + version are pinned at open
   * time — the conversation refuses subsequent turns with a different
   * `(agent, version)` (see `@kindgi/agents`: resuming with a different
   * version is refused because agent semantics may have changed).
   *
   * @wire `POST /v1/conversations` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1conversations/post`.
   */
  open(
    input: OpenConversationInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Conversation>;

  /**
   * @wire `GET /v1/conversations/{conversationId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1conversations~1{conversationId}/get`.
   */
  get(id: ThreadId): Promise<Conversation>;

  /**
   * @wire `GET /v1/conversations` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1conversations/get`.
   */
  list(filter?: ConversationFilter): Promise<Page<Conversation>>;

  /**
   * Close a conversation. Idempotent on already-closed threads — the
   * wire returns the current row unchanged in that case (no error, no
   * timestamp bump). Subsequent `runs.start` against this conversation
   * returns `conflict/conversation-closed`.
   *
   * @wire `POST /v1/conversations/{conversationId}/close` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1conversations~1{conversationId}~1close/post`.
   *   Returns the closed `Conversation` row (updated `status` /
   *   `closedAt`).
   */
  close(id: ThreadId, options?: { readonly idempotencyKey?: string }): Promise<Conversation>;

  /**
   * Paginated message history — `sequence asc` (natural conversation
   * reading order), distinct from most list endpoints which use
   * `createdAt desc`. Consumers wanting the raw fact rows can query
   * `client.memory.facts.list({ type: 'agent-message', scope: { threadId: id } })`.
   *
   * @wire `GET /v1/conversations/{conversationId}/messages` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1conversations~1{conversationId}~1messages/get`.
   *
   * `role` / `sinceTurn` are accepted but have no effect: the SDK does
   * not send them and the API does not filter by them.
   */
  messages(id: ThreadId, filter?: MessageFilter): Promise<Page<ConversationMessage>>;
}

export interface ConversationFilter extends Omit<Filter<ConversationStatus>, 'status'> {
  /**
   * One status. `GET /v1/conversations` filters by a single `?status=`;
   * passing several is rejected client-side with `invalid-request`.
   */
  readonly status?: ConversationStatus;
  /** Only one project's conversations (`kind: 'project'`), or every project's in an org (`kind: 'org'`). */
  readonly scope?: ScopeRef;
  readonly agent?: import('@kindgi/types').AgentId;
  readonly participantId?: string;
  /**
   * Replay conversations (a comparison's replays, `metadata.replayOf`):
   * left out by default (`exclude`); `include` lists them with the
   * others, `only` lists just them.
   */
  readonly replays?: 'exclude' | 'include' | 'only';
}

export interface MessageFilter extends Filter {
  readonly role?: import('../types.js').MessageRole;
  readonly sinceTurn?: number;
}

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export function makeConversationsClient(transport: Transport): ConversationsClient {
  return {
    async open(input, options) {
      return transport.request<Conversation>({
        method: 'POST',
        path: '/v1/conversations',
        body: {
          agentId: input.agentId as unknown as string,
          agentVersion: input.agentVersion,
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.scope !== undefined && { scope: input.scope }),
          ...(input.participantId !== undefined && { participantId: input.participantId }),
          ...(input.metadata !== undefined && { metadata: input.metadata }),
        },
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    async get(id) {
      return transport.request<Conversation>({
        method: 'GET',
        path: `/v1/conversations/${encodeURIComponent(id as unknown as string)}`,
      });
    },

    async list(filter) {
      const statusParam = singleStatusQuery('conversations.list', filter?.status);
      const page = await transport.request<WirePage<Conversation>>({
        method: 'GET',
        path: '/v1/conversations',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(statusParam !== undefined && { status: statusParam }),
          ...(filter?.scope !== undefined && scopeToQuery(filter.scope)),
          ...(filter?.agent !== undefined && { agentId: filter.agent as unknown as string }),
          ...(filter?.replays !== undefined && { replays: filter.replays }),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
      };
    },

    async close(id, options) {
      return transport.request<Conversation>({
        method: 'POST',
        path: `/v1/conversations/${encodeURIComponent(id as unknown as string)}/close`,
        body: {},
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    async messages(id, filter) {
      const page = await transport.request<WirePage<ConversationMessage>>({
        method: 'GET',
        path: `/v1/conversations/${encodeURIComponent(id as unknown as string)}/messages`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
      };
    },
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { RunBinding } from '@kindgi/runtime';
import type { ListScope, ProjectId, Result, ScopeSegment, Semver, TenantId } from '@kindgi/types';

import type { AgentError } from './errors.js';
import type {
  AgentId,
  Conversation,
  ConversationId,
  ConversationMessage,
  MessageRole,
} from './types.js';

// ============ Input shapes ============

export interface OpenConversationInput {
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly agentVersion: Semver;
  readonly title: string;
  readonly participantId?: string;
  /** The project the conversation is in: its turns' project. Lists filter by it. */
  readonly projectId?: ProjectId;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ListConversationsInput {
  readonly tenantId: TenantId;
  readonly agentId?: AgentId;
  readonly participantId?: string;
  /** If true, only conversations without a `closedAt` are returned. Default false. */
  readonly openOnly?: boolean;
  readonly limit?: number;
}

export interface AppendMessageInput {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly content: string | Readonly<Record<string, unknown>>;
  readonly actor?: string;
  readonly toolCall?: { readonly toolId: string; readonly invocationId: string };
  /**
   * When true, this message is a mid-turn assistant emission (e.g. the
   * assistant message that contains tool calls before the final
   * response). `turnCount` is NOT incremented for these — one turn is
   * one user↔agent exchange, not one message. Default false; the final
   * assistant response for a turn omits this flag (counts as a turn).
   */
  readonly isIntermediate?: boolean;
  /**
   * What the conversation-recall index keeps with the message, from the
   * turn (the conversation row has neither): the user the turn acts for,
   * and the run's segment path. A user's message and an agent's final
   * answer are indexed; tool messages and tool-call turns are not.
   * Absent: indexed without them.
   */
  readonly recall?: {
    readonly userId?: string;
    readonly segments?: readonly ScopeSegment[];
  };
}

export interface ReadMessagesInput {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly sinceSequence?: number;
  /** Only messages before this sequence. */
  readonly beforeSequence?: number;
  /**
   * Only the newest `last` messages (after the other bounds), oldest
   * first: a turn's history window. A binding that ignores it returns
   * them all, and the caller keeps the newest.
   */
  readonly last?: number;
  readonly limit?: number;
}

/**
 * Keyset marker used by `listConversationsPage`. When present, only
 * rows strictly before this marker (by `openedAt` desc, then `id`
 * desc) are returned. The api route encodes / decodes this to an
 * opaque wire cursor.
 */
export interface ConversationPageCursor {
  /** ISO 8601 `openedAt` timestamp of the last row from the previous page. */
  readonly openedAt: string;
  readonly id: ConversationId;
}

export interface ListConversationsPageInput {
  readonly tenantId: TenantId;
  /**
   * Only one project's conversations, or every project's in an org.
   * Absent: the tenant's. A conversation opened without a project is
   * listed only without a scope.
   */
  readonly scope?: ListScope;
  readonly agentId?: AgentId;
  /** When set, filter to open (no closedAt) or closed (closedAt set) rows only. */
  readonly status?: 'open' | 'closed';
  /**
   * Replay conversations (opened by a comparison's replay turn: their
   * `metadata` has `replayOf`): `exclude` leaves them out, `only` returns
   * just them. Absent = include, so internal callers see every
   * conversation; the HTTP route defaults to `exclude`.
   */
  readonly replays?: 'exclude' | 'include' | 'only';
  /** Keyset for the next page — see `ConversationPageCursor`. */
  readonly before?: ConversationPageCursor;
  /**
   * Row cap PER PAGE. Impls fetch `limit + 1` internally to compute
   * `hasMore` without a second query.
   */
  readonly limit: number;
}

export interface ConversationPage {
  readonly data: readonly Conversation[];
  readonly hasMore: boolean;
}

/**
 * `ConversationBinding` — the public seam between @kindgi/agents and
 * whatever conversation-store implementation a deployment plugs in
 * (the Kindgi runtime ships a Postgres-backed one; alternatives possible).
 *
 * Every method is tenant-scoped: RLS (or the moral equivalent for
 * non-Postgres impls) is expected to be enforced inside the binding.
 * Callers pass the tenant on every method — the binding does not
 * carry request-scoped identity.
 *
 * `closeConversation` accepts an optional `RunBinding` so the impl can
 * cascade-cancel pending waitpoints owned by runs in the closing
 * conversation. Impls without access to the run lifecycle skip the
 * cascade.
 *
 * `appendMessage` / `readMessages` route message content through the
 * memory subsystem — impls capture a `MemoryQueryBinding` at
 * construction and expose it here transparently.
 */
export interface ConversationBinding {
  openConversation(input: OpenConversationInput): Promise<Result<Conversation, AgentError>>;

  getConversation(
    tenantId: TenantId,
    id: ConversationId,
  ): Promise<Result<Conversation, AgentError>>;

  listConversations(
    input: ListConversationsInput,
  ): Promise<Result<readonly Conversation[], AgentError>>;

  /**
   * Cursor-paginated + keyset-ordered variant of `listConversations`
   * for the HTTP surface. Sort: `openedAt DESC, id DESC` (chronological
   * — most-recently-opened first, id disambiguating). Fills the
   * `hasMore` marker inline. Filters: `agentId`, `status` (`open` /
   * `closed`), `before` keyset.
   */
  listConversationsPage(
    input: ListConversationsPageInput,
  ): Promise<Result<ConversationPage, AgentError>>;

  closeConversation(
    tenantId: TenantId,
    id: ConversationId,
    runBinding?: RunBinding,
  ): Promise<Result<Conversation, AgentError>>;

  /**
   * Unregister a conversation: a tombstone (`unregisteredAt`). From then
   * on no read, list or recall returns it, and no message can be added;
   * the retention sweep removes it after the tenant's grace. Optional: a
   * binding without it can't unregister (the route answers 501).
   */
  unregisterConversation?(
    tenantId: TenantId,
    id: ConversationId,
  ): Promise<Result<Conversation, AgentError>>;

  /**
   * @deprecated Removed with the conversation-recall index: deleting a
   * row left its messages behind. Unregister instead
   * (`unregisterConversation`). Optional only so a runtime built before
   * it still compiles; the next release drops it.
   */
  deleteConversation?(tenantId: TenantId, id: ConversationId): Promise<Result<void, AgentError>>;

  appendMessage(input: AppendMessageInput): Promise<Result<ConversationMessage, AgentError>>;

  readMessages(
    input: ReadMessagesInput,
  ): Promise<Result<readonly ConversationMessage[], AgentError>>;
}

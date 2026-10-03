// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { RunBinding } from '@kindgi/runtime';
import type { Result, Semver, TenantId } from '@kindgi/types';

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
}

export interface ReadMessagesInput {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly sinceSequence?: number;
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
  readonly agentId?: AgentId;
  /** When set, filter to open (no closedAt) or closed (closedAt set) rows only. */
  readonly status?: 'open' | 'closed';
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

  deleteConversation(tenantId: TenantId, id: ConversationId): Promise<Result<void, AgentError>>;

  appendMessage(input: AppendMessageInput): Promise<Result<ConversationMessage, AgentError>>;

  readMessages(
    input: ReadMessagesInput,
  ): Promise<Result<readonly ConversationMessage[], AgentError>>;
}

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
  /** Who opens it: the caller's principal, as the server knows it, never a body's. */
  readonly openedBy?: string;
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
  /** The message came from outside (`ConversationMessage.fromEvent`): kept with it. */
  readonly fromEvent?: true;
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
 * Keyset marker used by `listConversationsPage` of a binding that sorts
 * by opening (its page has no `order`). When present, only rows strictly before
 * this marker (by `openedAt` desc, then `id` desc) are returned. The api
 * route encodes / decodes this to an opaque wire cursor.
 */
export interface ConversationPageCursor {
  /**
   * `openedAt` of the last row from the previous page. As a binding's
   * `ConversationPage.next` gives it, the stored value exactly (Postgres
   * keeps microseconds: `opened_at::text`); a cursor from before carries
   * the row's ISO 8601 `openedAt`. A binding compares it as given, never
   * through a JS `Date`, which keeps milliseconds and would skip the rows
   * opened earlier in the same millisecond.
   */
  readonly openedAt: string;
  readonly id: ConversationId;
}

/**
 * Keyset marker used by `listConversationsPage` of a binding that sorts
 * by last activity (its page's `order` is `last-activity`). When present, only
 * rows strictly before it (by `lastActivityAt` desc, then `id` desc) are
 * returned. A conversation only ever gets later, so none shows twice as
 * the list pages; one that something happens in meanwhile moves above
 * the marker, and that pass doesn't show it.
 */
export interface ConversationActivityCursor {
  /**
   * `lastActivityAt` of the last row from the previous page, as the
   * binding's `ConversationPage.nextByActivity` gives it: the stored value
   * exactly, to the microsecond. Compared as given, never through a JS
   * `Date`.
   */
  readonly lastActivityAt: string;
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
   * Only the conversations this principal opened (`user:<id>`,
   * `service_account:<id>`). A binding that ignores it lists more: the
   * route keeps only these.
   */
  readonly openedBy?: string;
  /**
   * Replay conversations (opened by a comparison's replay turn: their
   * `metadata` has `replayOf`): `exclude` leaves them out, `only` returns
   * just them. Absent = include, so internal callers see every
   * conversation; the HTTP route defaults to `exclude`.
   */
  readonly replays?: 'exclude' | 'include' | 'only';
  /**
   * Keyset for the next page of a binding that sorts by opening — see
   * `ConversationPageCursor`. A binding that sorts by last activity
   * ignores it: its page's `order` tells the caller the cursor was from
   * the other sort.
   */
  readonly before?: ConversationPageCursor;
  /**
   * Keyset for the next page of a binding that sorts by last activity —
   * see `ConversationActivityCursor`. A binding that sorts by opening
   * ignores it.
   */
  readonly beforeActivity?: ConversationActivityCursor;
  /**
   * Row cap PER PAGE. Impls fetch `limit + 1` internally to compute
   * `hasMore` without a second query.
   */
  readonly limit: number;
}

export interface ConversationPage {
  readonly data: readonly Conversation[];
  readonly hasMore: boolean;
  /**
   * How the page is sorted. `last-activity`: by `lastActivityAt DESC, id
   * DESC`, paged by `beforeActivity` / `nextByActivity`. Absent: by
   * `openedAt DESC, id DESC`, paged by `before` / `next`.
   */
  readonly order?: 'last-activity';
  /**
   * Where the next page starts: the last row's position as stored
   * (`openedAt` to the microsecond, and `id`). Set when `hasMore`. Absent
   * from a binding that doesn't give it: the caller then uses the last
   * row's `openedAt` and `id`.
   */
  readonly next?: ConversationPageCursor;
  /**
   * Where the next page starts, from a binding that sorts by last
   * activity: the last row's `lastActivityAt` as stored, and `id`. Set
   * when `hasMore`.
   */
  readonly nextByActivity?: ConversationActivityCursor;
}

/** Who closes a conversation, and whether its policy does. */
export interface ConversationClose {
  /**
   * Who closes it, as the record of the close names its actor: the
   * caller (`user:<id>`, `service_account:<id>`, ...), or
   * `AUTO_CLOSE_ACTOR` when its policy does.
   */
  readonly actor: string;
  /**
   * Its policy closes it (`conversationPolicy.autoCloseAfterInactiveSeconds`):
   * only if nothing has happened in it for this many seconds, by
   * `autoCloseDue` with its runs: no message, no turn posted or ended, and
   * no run in it in flight.
   */
  readonly afterInactiveSeconds?: number;
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
 * cascade. Its `ConversationClose` says who closes it, for the record of
 * the close an impl keeps.
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
   * for the HTTP surface, sorted as its page's `order` says (id
   * disambiguating).
   * Fills the `hasMore` marker inline. Filters: `agentId`, `status`
   * (`open` / `closed`), and the keyset.
   */
  listConversationsPage(
    input: ListConversationsPageInput,
  ): Promise<Result<ConversationPage, AgentError>>;

  /**
   * Close it: from then on it takes no turns. One already closed is
   * answered as it is, closed once. Without `close`, an impl that keeps a
   * record of the close names its actor `unknown`. With
   * `close.afterInactiveSeconds`, its policy closes it, and only if nothing
   * has happened in it for that long (`autoCloseDue`, with its runs),
   * checked as it closes: one that isn't idle (a message reached it since,
   * a turn was posted, one of its runs is in flight or just ended) is
   * answered open, as it is. A close by the policy cancels no wait: a
   * conversation with a run waiting isn't idle.
   */
  closeConversation(
    tenantId: TenantId,
    id: ConversationId,
    runBinding?: RunBinding,
    close?: ConversationClose,
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

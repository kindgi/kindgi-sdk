// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EmbeddingProviderRegistry } from '@kindgi/embedding';
import type { ScopeSegment, TenantId, Timestamp } from '@kindgi/types';

import type { MemoryReaders } from './types.js';

/**
 * One message of an earlier conversation, as recall finds it: a user's
 * message or an agent's answer (tool calls and the turns that made them
 * are not indexed), with the indexed messages either side for context.
 */
export interface RecalledMessage {
  readonly conversationId: string;
  readonly sequence: number;
  readonly role: 'user' | 'agent';
  readonly text: string;
  readonly createdAt: Timestamp;
  /** The agent the conversation was with. */
  readonly agentId: string;
  readonly projectId?: string;
  /** The conversation's end user (the app's own id for them). */
  readonly participantId?: string;
  /** The Kindgi user its turns acted for, when one did. */
  readonly userId?: string;
  /** The indexed message just before it in its conversation, if any. */
  readonly before?: { readonly role: 'user' | 'agent'; readonly text: string };
  /** The indexed message just after it, if any. */
  readonly after?: { readonly role: 'user' | 'agent'; readonly text: string };
}

/** A recalled message and how well it matched (a full-text rank or a cosine similarity). */
export interface RecallHit {
  readonly message: RecalledMessage;
  readonly score?: number;
}

/**
 * What one recall narrows to, within what the readers may see. Always
 * one agent's conversations. Every other field given must match.
 */
export interface RecallSelection {
  readonly agentId: string;
  /** Only this conversation (with `beforeSequence`: its messages older than that). */
  readonly conversationId?: string;
  readonly beforeSequence?: number;
  /** Every conversation but this one. */
  readonly excludeConversationId?: string;
  readonly participantId?: string;
  readonly userId?: string;
  readonly projectId?: string;
  /** Conversations whose segment path starts with this one (the same customer). */
  readonly segmentsPrefix?: readonly ScopeSegment[];
}

export interface SearchConversationsInput {
  readonly tenantId: TenantId;
  /** What the reader may see (`isRecallReadableBy`), applied in the query before the limit. */
  readonly readers: MemoryReaders;
  /** The narrowings, merged: a message matching any of them. */
  readonly selections: readonly RecallSelection[];
  /** `list`: the newest first, no query. `keyword`: full-text. `semantic`: by meaning. */
  readonly mode: 'list' | 'keyword' | 'semantic';
  readonly query?: string;
  /** For `semantic`: the registry the query is embedded with. */
  readonly embeddingRegistry?: EmbeddingProviderRegistry;
  readonly embeddingModel?: string;
  readonly topK: number;
}

/** The containers a recalled message's conversation is in, as the recall guard sees them. */
export interface RecallRow {
  readonly conversationId: string;
  readonly projectId?: string;
  readonly participantId?: string;
  readonly userId?: string;
}

/**
 * Whether `readers` may recall a message of this conversation: the recall
 * guard, as every binding applies it inside its query (a SQL binding's
 * guard must agree with this one, case for case). Stricter than facts'
 * (`isReadableBy`): a conversation is always someone's.
 *   - **Its project:** one the readers have, or act in for every end user
 *     (`onBehalfOfProjectIds`). A conversation without a project passes
 *     only by its person or the conversation itself.
 *   - **Its person:** its end user when it has one, else the Kindgi user
 *     its turns acted for. The readers must be that person
 *     (`participantIds`, or `userIds` for a conversation without an end
 *     user), be in the conversation (`threadIds`), or act in its project
 *     for every end user. An app's credential is one Kindgi user for all
 *     of its end users, so the user never opens an end user's
 *     conversation. A conversation naming no person is readable only
 *     from inside it, or for its whole project.
 */
export function isRecallReadableBy(row: RecallRow, readers: MemoryReaders): boolean {
  if (readers.all === true) return true;
  const has = <T>(ids: readonly T[] | undefined, id: T | undefined) =>
    id !== undefined && ids?.includes(id) === true;
  const project = row.projectId;
  const onBehalf = has(readers.onBehalfOfProjectIds as readonly string[] | undefined, project);
  if (
    project !== undefined &&
    !(has(readers.projectIds as readonly string[] | undefined, project) || onBehalf)
  ) {
    return false;
  }
  const isPerson =
    row.participantId !== undefined
      ? has(readers.participantIds, row.participantId)
      : has(readers.userIds as readonly string[] | undefined, row.userId);
  return (
    isPerson ||
    has(readers.threadIds as readonly string[] | undefined, row.conversationId) ||
    onBehalf
  );
}

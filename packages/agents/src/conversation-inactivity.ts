// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// When an agent's `conversationPolicy.autoCloseAfterInactiveSeconds`
// closes a conversation: nothing has been said in it for that long. One
// rule for every place that applies it: a turn's start (`POST /v1/runs`,
// and the turn's own setup), a turn's resume, and the server's sweep,
// which states the same rule in SQL.
//

import type { ConversationPolicy } from './types.js';

/**
 * Who closes a conversation its policy closes, as the record of the
 * close names its actor: the server, by the agent's policy, not a caller.
 */
export const AUTO_CLOSE_ACTOR = 'system:conversation-auto-close';

/** A conversation as far as its inactivity goes: ISO 8601 times. */
export interface ConversationActivity {
  readonly openedAt: string;
  /** Absent until its first message. */
  readonly lastMessageAt?: string | undefined;
  /** Absent while it's open. */
  readonly closedAt?: string | undefined;
}

/** Why a conversation's policy closes it now. */
export interface AutoCloseDue {
  /** Since when nothing has been said in it (`inactiveSince`). */
  readonly since: Date;
  /** The policy's `autoCloseAfterInactiveSeconds`. */
  readonly afterSeconds: number;
}

/** Since when nothing has been said in a conversation: its last message, or its opening before any. */
export function inactiveSince(conversation: ConversationActivity): Date {
  return new Date(conversation.lastMessageAt ?? conversation.openedAt);
}

/**
 * Whether a conversation's policy closes it at `now`: it's open, the
 * policy sets `autoCloseAfterInactiveSeconds`, and nothing has been said in
 * it for at least that long. Its inactivity when it does.
 */
export function autoCloseDue(
  conversation: ConversationActivity,
  policy: Pick<ConversationPolicy, 'autoCloseAfterInactiveSeconds'> | undefined,
  now: Date,
): AutoCloseDue | undefined {
  const afterSeconds = policy?.autoCloseAfterInactiveSeconds;
  if (afterSeconds === undefined || conversation.closedAt !== undefined) return undefined;
  const since = inactiveSince(conversation);
  return now.getTime() - since.getTime() >= afterSeconds * 1000
    ? { since, afterSeconds }
    : undefined;
}

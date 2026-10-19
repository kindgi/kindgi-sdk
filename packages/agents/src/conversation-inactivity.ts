// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// When an agent's `conversationPolicy.autoCloseAfterInactiveSeconds`
// closes a conversation: nothing has happened in it for that long, no
// message and no turn in progress or waiting. One rule for every place
// that applies it: `POST /v1/runs` before a turn is posted into one, and
// the binding as it closes one, and the server's sweep, which state the
// same rule in SQL.
//

import type { ConversationPolicy } from './types.js';

/**
 * Who closes a conversation its policy closes, as the record of the
 * close names its actor: the server, by the agent's policy, not a caller.
 */
export const AUTO_CLOSE_ACTOR = 'system:conversation-auto-close';

/** A conversation's runs, as far as its inactivity goes: ISO 8601 times. */
export interface ConversationRunsActivity {
  /**
   * A run in it is in flight: queued, running, or waiting (on an approval,
   * the session gate, or anything else it waits on). It holds the
   * conversation open however long it takes.
   */
  readonly inFlight: boolean;
  /** When the last turn was posted into it (its run made). Absent: none was. */
  readonly lastPostedAt?: string | undefined;
  /** When the last of its runs ended. Absent: none has. */
  readonly lastEndedAt?: string | undefined;
}

/** A conversation as far as its inactivity goes: ISO 8601 times. */
export interface ConversationActivity {
  readonly openedAt: string;
  /** Absent until its first message. */
  readonly lastMessageAt?: string | undefined;
  /** Absent while it's open. */
  readonly closedAt?: string | undefined;
  /**
   * Its runs. Absent where they aren't read (a conversation's own record):
   * then `autoCloseDue` says only that it may be due, since its runs can
   * only make it later, and the binding decides as it closes, with them.
   */
  readonly runs?: ConversationRunsActivity | undefined;
}

/** Why a conversation's policy closes it now. */
export interface AutoCloseDue {
  /** Since when nothing has happened in it (`inactiveSince`). */
  readonly since: Date;
  /** The policy's `autoCloseAfterInactiveSeconds`. */
  readonly afterSeconds: number;
}

/**
 * Since when nothing has happened in a conversation: the latest of its
 * last message, the last turn posted into it, the end of its last run,
 * and its opening.
 */
export function inactiveSince(conversation: ConversationActivity): Date {
  const times = [
    conversation.openedAt,
    conversation.lastMessageAt,
    conversation.runs?.lastPostedAt,
    conversation.runs?.lastEndedAt,
  ].flatMap((at) => (at === undefined ? [] : [new Date(at).getTime()]));
  return new Date(Math.max(...times));
}

/**
 * Whether a conversation's policy closes it at `now`: it's open, the
 * policy sets `autoCloseAfterInactiveSeconds`, no run in it is in flight,
 * and nothing has happened in it for at least that long. Its inactivity
 * when it does.
 */
export function autoCloseDue(
  conversation: ConversationActivity,
  policy: Pick<ConversationPolicy, 'autoCloseAfterInactiveSeconds'> | undefined,
  now: Date,
): AutoCloseDue | undefined {
  const afterSeconds = policy?.autoCloseAfterInactiveSeconds;
  if (afterSeconds === undefined || conversation.closedAt !== undefined) return undefined;
  if (conversation.runs?.inFlight === true) return undefined;
  const since = inactiveSince(conversation);
  return now.getTime() - since.getTime() >= afterSeconds * 1000
    ? { since, afterSeconds }
    : undefined;
}

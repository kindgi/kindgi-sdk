// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What both apps' mail calls share: their failures as `MailCallError`, and
 * checks on what they're given. Not a package subpath.
 */

import { AppRefused } from './app-request.js';
import {
  MailCallError,
  type MailFoundMessage,
  type MailFunctions,
  type MailTurnBudget,
} from './mail.js';

/**
 * An app's mail calls with each refusal (`AppRefused`) thrown as a
 * `MailCallError`: its status and reason (when it has a code's form),
 * never the app's words. Anything
 * else goes through as thrown: a 401's `ConnectionRejectedError`, an
 * abort's reason, a bad input or answer.
 */
export function mailCalls(calls: MailFunctions): MailFunctions {
  return {
    start: (call, input) => failingTyped(calls.start(call, input)),
    changes: (call, input) => failingTyped(calls.changes(call, input)),
    since: (call, input) => failingTyped(calls.since(call, input)),
    read: (call, input) => failingTyped(calls.read(call, input)),
  };
}

/** A reason as the apps give one: a code, never words. */
const REASON = /^[A-Za-z0-9_.-]{1,100}$/;

async function failingTyped<T>(result: Promise<T>): Promise<T> {
  try {
    return await result;
  } catch (err) {
    if (err instanceof AppRefused) {
      const reason = err.reason !== undefined && REASON.test(err.reason) ? err.reason : undefined;
      throw new MailCallError(err.status, reason);
    }
    throw err;
  }
}

/** The most mails a budget lets a read take: one page of Outlook's `$top`. */
const THREAD_MAILS_MAX = 1000;

/** A budget of whole numbers: at least 1 character, and 1 to 1,000 mails. */
export function checkBudget(budget: MailTurnBudget): void {
  const { mailChars, turnChars, threadMails } = budget;
  if (
    !Number.isInteger(mailChars) ||
    mailChars < 1 ||
    !Number.isInteger(turnChars) ||
    turnChars < 1 ||
    !Number.isInteger(threadMails) ||
    threadMails < 1 ||
    threadMails > THREAD_MAILS_MAX
  ) {
    throw new Error('The budget is whole numbers: at least 1 character, and 1 to 1,000 mails.');
  }
}

/**
 * Found mail oldest first by when it was received, ties by id. One with
 * no time, or one that isn't a time, takes the time of the one before it
 * in the order given, so it sorts next to it.
 */
export function oldestFirst(found: readonly MailFoundMessage[]): MailFoundMessage[] {
  let last = Number.NEGATIVE_INFINITY;
  return found
    .map((m) => {
      const at = Date.parse(m.receivedAt ?? '');
      last = Number.isNaN(at) ? last : at;
      return { m, at: last };
    })
    .sort((a, b) => a.at - b.at || byId(a.m.messageId, b.m.messageId))
    .map(({ m }) => m);
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The mails of a thread a read takes, oldest first: all of them when
 * they're at most `most`, else the first, the newest `most - 1`, and the
 * mail `mailId` when it isn't one of those. `notRead` counts the rest.
 */
export function pickThread<T extends { readonly id: string }>(
  kept: readonly T[],
  mailId: string,
  most: number,
): { readonly picked: T[]; readonly notRead: number } {
  if (kept.length <= most) return { picked: [...kept], notRead: 0 };
  const newest = kept.length - (most - 1);
  const picked = kept.filter((m, i) => i === 0 || i >= newest || m.id === mailId);
  return { picked, notRead: kept.length - picked.length };
}

/** A `since`'s `max`: a whole number from 1 to `most`. */
export function checkMax(max: number, most: number): void {
  if (!Number.isInteger(max) || max < 1 || max > most) {
    throw new Error(`\`max\` is a whole number from 1 to ${most}.`);
  }
}

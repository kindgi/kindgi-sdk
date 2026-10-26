// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What both apps' mail calls share: their failures as `MailCallError`, and
 * checks on what they're given. Not a package subpath.
 */

import { AppRefused } from './app-request.js';
import { MailCallError, type MailFunctions, type MailThreadBudget } from './mail.js';

/**
 * An app's mail calls with each refusal (`AppRefused`) thrown as a
 * `MailCallError`: its status and reason, never the app's words. Anything
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

async function failingTyped<T>(result: Promise<T>): Promise<T> {
  try {
    return await result;
  } catch (err) {
    if (err instanceof AppRefused) throw new MailCallError(err.status, err.reason);
    throw err;
  }
}

/** A budget of whole numbers: at least 1 character, and 0 or more earlier messages. */
export function checkBudget(budget: MailThreadBudget): void {
  const { messageChars, earlier, earlierChars } = budget;
  if (
    !Number.isInteger(messageChars) ||
    messageChars < 1 ||
    !Number.isInteger(earlier) ||
    earlier < 0 ||
    !Number.isInteger(earlierChars) ||
    earlierChars < 1
  ) {
    throw new Error(
      'The budget is whole numbers: at least 1 character, and 0 or more earlier messages.',
    );
  }
}

/** A `since`'s `max`: a whole number from 1 to `most`. */
export function checkMax(max: number, most: number): void {
  if (!Number.isInteger(max) || max < 1 || max > most) {
    throw new Error(`\`max\` is a whole number from 1 to ${most}.`);
  }
}

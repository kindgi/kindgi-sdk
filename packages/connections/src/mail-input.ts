// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Checks on what the mail calls are given, for both apps. Not a package subpath. */

import type { MailThreadBudget } from './mail.js';

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

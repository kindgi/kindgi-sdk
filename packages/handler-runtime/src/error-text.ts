// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describeCauses, scrubText } from '@kindgi/log';

/** `scrubText`'s form for an error a run shows: a token whole, a URL's secret parameters. */
const FULL_MASK = { fullMask: true } as const;

/**
 * What a thrown value says, for a failure's message: `Name: message`, and
 * then its causes (`; caused by …`, `describeCauses`), so `fetch failed`
 * says why. A value that isn't an error is `String(err)`. The text is
 * masked with `scrubText`'s full mask: the message reaches the run's
 * record, the console and the model, which are more readers than a log's.
 * Text with no cause and no secret shape reads as it did.
 */
export function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${scrubText(String(err.message), FULL_MASK)}${describeCauses(err)}`;
  }
  return scrubText(String(err), FULL_MASK);
}

/**
 * Handlers may throw arbitrary values (Error, string, plain objects,
 * undefined). The wire protocol carries `cause` as JSON — serialize to
 * a shape JSON.stringify handles cleanly. Preserve the original message
 * + name when `err` is an Error; fall back to a stringified rep otherwise.
 */
export function serializeCause(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (err === undefined) return null;
  if (
    err === null ||
    typeof err === 'string' ||
    typeof err === 'number' ||
    typeof err === 'boolean'
  ) {
    return err;
  }
  try {
    JSON.stringify(err);
    return err;
  } catch {
    return String(err);
  }
}

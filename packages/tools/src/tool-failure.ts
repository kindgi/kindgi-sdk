// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool's own failure: the tool ran and says this call can't give an
 * answer, in its own code and words for a person. `invokeTool` reports
 * it as `tool-failed` (not `handler-error`: nothing crashed), with the
 * tool's code as `reason`, its message as written and its `details`.
 *
 * Which to use:
 * - an outcome the caller acts on goes in the output schema
 *   (`{ found: false }`);
 * - a call that can't give an answer throws `ToolFailure`;
 * - a bug just throws.
 *
 * A `ToolFailure` doesn't undo what the tool did before it.
 *
 * Recognized by a registered symbol, not `instanceof`, so a runtime and
 * a tool that load different copies of this package still agree.
 */
const TOOL_FAILURE = Symbol.for('kindgi.tools.tool-failure');

/** A tool failure's code: kebab case, a letter first, at most 64 characters. */
export const TOOL_FAILURE_CODE = /^[a-z][a-z0-9-]{0,63}$/;

/** The most characters of a tool failure's message that are kept. */
export const TOOL_FAILURE_MESSAGE_MAX = 1000;

/** The most bytes a tool failure's `details` may take as JSON (UTF-8). */
export const TOOL_FAILURE_DETAILS_MAX_BYTES = 4096;

/** A JSON object of the tool's facts about a failure. */
export type ToolFailureDetails = Readonly<Record<string, unknown>>;

export interface ToolFailureOptions {
  /**
   * The tool's facts about the failure, as a JSON object of at most
   * 4 KiB (`{ orderId: 'Z-9' }`). It reaches the run's failure and the
   * model, so it never holds a secret, and never a wait or a retry hint.
   */
  readonly details?: ToolFailureDetails;
}

export class ToolFailure extends Error {
  readonly [TOOL_FAILURE] = true;
  /**
   * The tool's code for why the call failed (`order-not-found`). A
   * fixed word of the tool's, never built from its input: runs are
   * grouped by it, and it outlives the run's erasure.
   */
  readonly code: string;
  /** The tool's facts, as a JSON copy of what it gave; absent when it gave none. */
  declare readonly details?: ToolFailureDetails;

  /**
   * @param code The tool's code for why, in kebab case (`order-not-found`).
   * @param message Words for a person, said as written (`No order Z-9`).
   *   Not empty; cut at 1,000 characters.
   * @throws TypeError when the code isn't kebab case, the message is
   *   empty, or `details` isn't a JSON object of at most 4 KiB. The call
   *   then fails as a crash (`handler-error`) that says why.
   */
  constructor(code: string, message: string, options: ToolFailureOptions = {}) {
    if (typeof code !== 'string' || !TOOL_FAILURE_CODE.test(code)) {
      throw new TypeError(
        `ToolFailure's code must be kebab case, a letter first, at most 64 characters: ${JSON.stringify(String(code).slice(0, 80))}`,
      );
    }
    if (typeof message !== 'string' || message.trim() === '') {
      throw new TypeError(`ToolFailure "${code}" needs a message for a person`);
    }
    const details = options.details === undefined ? undefined : jsonDetails(code, options.details);
    super(cut(message));
    this.name = 'ToolFailure';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Is `value` a `ToolFailure` (from any copy of this package)? */
export function isToolFailure(value: unknown): value is ToolFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [TOOL_FAILURE]?: unknown })[TOOL_FAILURE] === true
  );
}

/** The message's first 1,000 characters (code points, so no pair is split). */
function cut(message: string): string {
  if (message.length <= TOOL_FAILURE_MESSAGE_MAX) return message;
  return Array.from(message).slice(0, TOOL_FAILURE_MESSAGE_MAX).join('');
}

/** `details` as a JSON copy, or a TypeError that says why it can't be one. */
function jsonDetails(code: string, details: unknown): ToolFailureDetails {
  let json: string | undefined;
  try {
    json = JSON.stringify(details);
  } catch (cause) {
    throw new TypeError(`ToolFailure "${code}"'s details aren't JSON`, { cause });
  }
  if (json === undefined) throw new TypeError(`ToolFailure "${code}"'s details aren't JSON`);
  // The copy is what's checked: a `toJSON` may make anything of the value.
  const copy: unknown = JSON.parse(json);
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) {
    throw new TypeError(`ToolFailure "${code}"'s details must be a JSON object`);
  }
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > TOOL_FAILURE_DETAILS_MAX_BYTES) {
    throw new TypeError(
      `ToolFailure "${code}"'s details take ${bytes} bytes as JSON, more than ${TOOL_FAILURE_DETAILS_MAX_BYTES}`,
    );
  }
  return copy as ToolFailureDetails;
}

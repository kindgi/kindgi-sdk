// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A runtime's refusal to run a tool: something the tool declares wasn't
 * there — a secret it declares couldn't be resolved, say. A runtime that
 * wraps a tool's handler throws it before calling the tool's own code;
 * `invokeTool` reports it as `precondition-failed` (not `handler-error`:
 * the handler never ran), with the runtime's `reason` code.
 *
 * Recognized by a registered symbol, not `instanceof`, so a runtime and
 * a tool that load different copies of this package still agree.
 */
const PRECONDITION_FAILED = Symbol.for('kindgi.tools.precondition-failed');

export class ToolPreconditionError extends Error {
  readonly [PRECONDITION_FAILED] = true;

  /**
   * @param reason The runtime's code for what was missing
   *   (`secret-unavailable`, `env-not-configured`, …).
   * @param message What was missing, by name; never a secret's value.
   */
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolPreconditionError';
  }
}

/** Is `value` a `ToolPreconditionError` (from any copy of this package)? */
export function isToolPreconditionError(value: unknown): value is ToolPreconditionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [PRECONDITION_FAILED]?: unknown })[PRECONDITION_FAILED] === true
  );
}

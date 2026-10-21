// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool call that waits for another system's answer.
 *
 * A pack tool that declares `pauses: true` gets a wait token with each
 * call (`ctx.waitToken`): it hands the token's link to the system that
 * will answer, then returns `ctx.pause()`. The run waits until that system
 * posts its answer to the link, or until the pause's time passes; the
 * answer, valid against the tool's output schema, becomes the call's
 * result.
 *
 * Two values carry a pause, one on each side of the runtime:
 * - `ToolPauseAnswer`, what a pack tool's handler returns (`ctx.pause()`);
 * - `ToolPause`, what a caller of the tool gets from `invokeToolOrPause`
 *   once the runtime has applied the deadline: the token to wait on, and
 *   for how long.
 */

/** The longest a pause may wait: 24 days, in milliseconds. */
export const MAX_PAUSE_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000;
/** How long a pause waits when its tool names no `timeoutMs`: 24 hours. */
export const DEFAULT_PAUSE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** The longest a pause's `name` may be. */
export const MAX_PAUSE_NAME_LENGTH = 200;

/** A call's wait token: its id, and the link the other system posts its answer to. */
export interface WaitToken {
  /** The same every time this attempt of the call runs (a retry of its step gets a new token). */
  readonly id: string;
  /**
   * `POST` the answer here, as a JSON body, with no `Authorization`
   * header: the link is the credential. Hand it only to the system that
   * answers. A re-run after a crash gets a new link to the same wait, and
   * either link completes it. Hand on the new one only if the old one
   * never went out, and dedupe on `idempotencyKey`.
   */
  readonly url: string;
}

/** What a pausing tool passes to `ctx.pause`. */
export interface ToolPauseOptions {
  /**
   * How long the run waits for the answer, in milliseconds: from 1 to
   * `MAX_PAUSE_TIMEOUT_MS` (24 days). Default: 24 hours. When it passes,
   * the call fails with `wait-token-timed-out`.
   */
  readonly timeoutMs?: number;
  /** What the run waits for, in a few words (`the carrier's pickup confirmation`): 1 to 200 characters. */
  readonly name?: string;
}

declare const pauseAnswerBrand: unique symbol;

/** What `ctx.pause()` returns. A pausing tool's handler returns it as its result. */
export interface ToolPauseAnswer {
  readonly [pauseAnswerBrand]: true;
  readonly timeoutMs?: number;
  readonly name?: string;
}

/**
 * What the handler of a tool that declares `pauses: true` gets beside the
 * usual context. Reading `waitToken` when the runtime sent none (one that
 * can't pause yet) throws, so the tool fails before it hands on a link.
 */
export interface PauseContext {
  readonly waitToken: WaitToken;
  pause(options?: ToolPauseOptions): ToolPauseAnswer;
}

/**
 * A call that waits: the token the caller parks on, and for how long.
 * `timeoutMs` is always set: the runtime applies the default and the
 * limit before it hands the pause on.
 */
export interface ToolPause {
  readonly tokenId: string;
  readonly timeoutMs: number;
  readonly name?: string;
}

/**
 * Marks a `pauseOutcome`. Registered, so a runtime and a tool that load
 * different copies of this package still agree.
 */
const TOOL_PAUSE = Symbol.for('kindgi.tool-pause');

/**
 * What a tool handler returns when its call waits: only the runtime's own
 * handler for a pack tool returns one. `invokeToolOrPause` recognizes it
 * before checking the output; `invokeTool` refuses it.
 *
 * @throws RangeError when `tokenId` is empty, `timeoutMs` isn't a whole
 *   number from 1 to `MAX_PAUSE_TIMEOUT_MS`, or `name` isn't 1 to
 *   `MAX_PAUSE_NAME_LENGTH` characters.
 */
export function pauseOutcome(pause: ToolPause): unknown {
  return Object.freeze({ [TOOL_PAUSE]: true, pause: checked(pause) });
}

/**
 * The pause a handler's return value carries, if it's a `pauseOutcome`.
 * The mark is registered, so any code can make one: the pause is checked
 * again here.
 *
 * @throws RangeError as `pauseOutcome` does, when the marked value's pause
 *   is out of bounds.
 */
export function pauseOf(value: unknown): ToolPause | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const marked = value as { readonly [TOOL_PAUSE]?: unknown; readonly pause?: unknown };
  if (marked[TOOL_PAUSE] !== true) return undefined;
  if (typeof marked.pause !== 'object' || marked.pause === null) {
    throw new RangeError('A pause needs the id of the wait token it waits on');
  }
  return checked(marked.pause as ToolPause);
}

/** A plain copy of a pause within the bounds, with no mark, so a caller can keep it in a journal. */
function checked(pause: ToolPause): ToolPause {
  if (typeof pause.tokenId !== 'string' || pause.tokenId.length === 0) {
    throw new RangeError('A pause needs the id of the wait token it waits on');
  }
  if (
    !Number.isInteger(pause.timeoutMs) ||
    pause.timeoutMs < 1 ||
    pause.timeoutMs > MAX_PAUSE_TIMEOUT_MS
  ) {
    throw new RangeError(
      `A pause waits from 1 to ${MAX_PAUSE_TIMEOUT_MS} ms (24 days), not ${String(pause.timeoutMs)}`,
    );
  }
  // In code points, as the schema's `maxLength` and a Python pack count it.
  const { name } = pause;
  if (
    name !== undefined &&
    (typeof name !== 'string' || name.length === 0 || [...name].length > MAX_PAUSE_NAME_LENGTH)
  ) {
    throw new RangeError(`A pause's name is 1 to ${MAX_PAUSE_NAME_LENGTH} characters`);
  }
  return toolPause(pause);
}

/** A plain copy with no mark, so a caller can keep it in a journal. */
function toolPause(pause: ToolPause): ToolPause {
  return {
    tokenId: pause.tokenId,
    timeoutMs: pause.timeoutMs,
    ...(pause.name !== undefined && { name: pause.name }),
  };
}

/**
 * Marks a `ToolRerunsExhaustedError`. Registered for the same reason as
 * `TOOL_PAUSE`.
 */
const RERUNS_EXHAUSTED = Symbol.for('kindgi.tools.wait-token-reruns-exhausted');

/**
 * The runtime's refusal to run a pausing tool's call again: the call ran
 * the most times a crash before its wait may make it run. A runtime that
 * wraps a pack tool's handler throws it instead of calling the pack;
 * `invokeTool` reports it as `wait-token-reruns-exhausted`.
 */
export class ToolRerunsExhaustedError extends Error {
  readonly [RERUNS_EXHAUSTED] = true;

  /**
   * @param tokenId The wait token the call would have waited on.
   * @param runs How many times the call has run.
   */
  constructor(
    readonly tokenId: string,
    readonly runs: number,
  ) {
    super(
      `The call ran ${runs} times without reaching its wait, the most a crash may make it run; it isn't run again`,
    );
    this.name = 'ToolRerunsExhaustedError';
  }
}

/** Is `value` a `ToolRerunsExhaustedError` (from any copy of this package)? */
export function isToolRerunsExhaustedError(value: unknown): value is ToolRerunsExhaustedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [RERUNS_EXHAUSTED]?: unknown })[RERUNS_EXHAUSTED] === true
  );
}

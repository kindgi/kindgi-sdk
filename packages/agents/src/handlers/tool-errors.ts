// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Retrying failed tool calls. A failure the turn's policy retries goes
 * back to the model as the call's result — what failed and why — and
 * the turn continues; the model can correct the call. Each retry costs a
 * step, so `budget.maxSteps` still bounds the turn. A failure the policy
 * doesn't retry, or one past `maxRetries`, fails the turn as before.
 *
 * Retries are counted from the turn's messages (the results this module
 * writes carry a marker), so a replayed turn counts the same.
 */

import type { ModelMessage } from '@kindgi/capabilities';
import { TOOL_ERROR_KINDS, type ToolErrorKind, type ToolErrorsSpec } from '@kindgi/policy-contract';

import type { TurnContext } from './context.js';
import { loopMessages } from './history.js';

/** Without an agent setting: one retry, for failures where nothing ran. */
export const DEFAULT_TOOL_ERRORS: Required<ToolErrorsSpec> = {
  maxRetries: 1,
  retryOn: ['invalid-arguments', 'unknown-tool'],
};

/** The policy a turn applies. */
export interface ToolErrorPolicy {
  readonly maxRetries: number;
  readonly retryOn: ReadonlySet<ToolErrorKind>;
}

/**
 * The agent's setting (or the default), capped by the workspace's
 * `tool-errors` policy: the fewer retries, and only the kinds both
 * allow — like every workspace policy, it can only make the turn stricter.
 */
export function effectiveToolErrorPolicy(
  agent: ToolErrorsSpec | undefined,
  tenantCap: ToolErrorsSpec | undefined,
): ToolErrorPolicy {
  const maxRetries = Math.min(
    agent?.maxRetries ?? DEFAULT_TOOL_ERRORS.maxRetries,
    tenantCap?.maxRetries ?? Number.POSITIVE_INFINITY,
  );
  const allowed = new Set(tenantCap?.retryOn ?? TOOL_ERROR_KINDS);
  const retryOn = (agent?.retryOn ?? DEFAULT_TOOL_ERRORS.retryOn).filter((k) => allowed.has(k));
  return { maxRetries, retryOn: new Set(retryOn) };
}

/**
 * Which kind of failure a tool call's error is: arguments that failed
 * the input schema, a tool the agent doesn't have, a tool that failed
 * the call on purpose (`ToolFailure`), or a tool that ran and failed.
 */
export function toolErrorKindOf(error: {
  readonly code: string;
  readonly cause?: unknown;
}): ToolErrorKind {
  if (error.code === 'unresolved-tool') return 'unknown-tool';
  const inner = (error.cause as { readonly code?: unknown } | undefined)?.code;
  if (inner === 'input-validation-failed') return 'invalid-arguments';
  return inner === 'tool-failed' ? 'tool-failed' : 'tool-error';
}

/** A tool's own failure (`ToolFailure`), as a failed call's error carries it. */
export interface ToolFailureFacts {
  /** The tool's own code for why (`order-not-found`). */
  readonly reason: string;
  /** Its words for a person, masked. */
  readonly message: string;
  /** Its facts, masked; absent when it gave none. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * The tool's own failure inside a failed call's error, if the tool threw
 * `ToolFailure` (`invokeTool` answers `tool-failed` with its `reason`).
 */
export function toolFailureOf(error: {
  readonly code: string;
  readonly cause?: unknown;
}): ToolFailureFacts | undefined {
  const inner = error.cause as
    | {
        readonly code?: unknown;
        readonly reason?: unknown;
        readonly message?: unknown;
        readonly details?: unknown;
      }
    | undefined;
  if (inner?.code !== 'tool-failed') return undefined;
  if (typeof inner.reason !== 'string' || typeof inner.message !== 'string') return undefined;
  const { details } = inner;
  const facts = { reason: inner.reason, message: inner.message };
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? { ...facts, details: details as Readonly<Record<string, unknown>> }
    : facts;
}

/** Marks the results this module writes, so they can be counted. */
const RETRY_MARKER = 'tool-error-retry';

/** What the model sees for a failed call it may retry. */
export interface ToolErrorResult {
  readonly kindgi: typeof RETRY_MARKER;
  readonly status: 'failed';
  readonly error: {
    readonly kind: ToolErrorKind;
    readonly message: string;
    readonly issues?: readonly unknown[];
    /** For `tool-failed`: the tool's own code for why. */
    readonly reason?: string;
    /** For `tool-failed`, when the tool gave them: its facts. */
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly instruction: string;
}

const INSTRUCTIONS: Readonly<Record<ToolErrorKind, string>> = {
  'invalid-arguments': "Fix the arguments to match the tool's input schema and call it again.",
  'unknown-tool': 'Call one of the tools you were given instead.',
  'tool-error': 'The tool failed. Call it again if a retry makes sense, or answer without it.',
  'tool-failed':
    'The tool said this call failed, and why. Tell the person, or try another way; the same call gives the same answer.',
};

export function toolErrorResult(
  kind: ToolErrorKind,
  message: string,
  issues: readonly unknown[] | undefined,
  failure?: ToolFailureFacts,
): ToolErrorResult {
  return {
    kindgi: RETRY_MARKER,
    status: 'failed',
    error: {
      kind,
      message,
      ...(issues !== undefined && { issues }),
      ...(failure !== undefined && { reason: failure.reason }),
      ...(failure?.details !== undefined && { details: failure.details }),
    },
    instruction: INSTRUCTIONS[kind],
  };
}

/**
 * Retries this turn has taken: the marked tool results the turn's loop
 * added to `messages` (`loopMessages`). Earlier turns' results come back
 * as history, before them, and don't count; nor does a message of the
 * person's that starts with a marker move where the turn starts.
 */
export function toolRetriesSoFar(ctx: TurnContext, messages: readonly ModelMessage[]): number {
  return loopMessages(ctx, messages, "the turn's tool retries").filter(isRetryResult).length;
}

function isRetryResult(m: ModelMessage): boolean {
  if (m.role !== 'tool') return false;
  try {
    return (JSON.parse(m.content) as { readonly kindgi?: unknown }).kindgi === RETRY_MARKER;
  } catch {
    return false;
  }
}

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

import { isRepairMessage } from './structured-output.js';

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
 * The agent's setting (or the default), capped by the tenant's
 * `tool-errors` policy: the fewer retries, and only the kinds both
 * allow — like every tenant policy, it can only make the turn stricter.
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
 * the input schema, a tool the agent doesn't have, or a tool that ran
 * and failed.
 */
export function toolErrorKindOf(error: {
  readonly code: string;
  readonly cause?: unknown;
}): ToolErrorKind {
  if (error.code === 'unresolved-tool') return 'unknown-tool';
  const inner = (error.cause as { readonly code?: unknown } | undefined)?.code;
  return inner === 'input-validation-failed' ? 'invalid-arguments' : 'tool-error';
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
  };
  readonly instruction: string;
}

const INSTRUCTIONS: Readonly<Record<ToolErrorKind, string>> = {
  'invalid-arguments': "Fix the arguments to match the tool's input schema and call it again.",
  'unknown-tool': 'Call one of the tools you were given instead.',
  'tool-error': 'The tool failed. Call it again if a retry makes sense, or answer without it.',
};

export function toolErrorResult(
  kind: ToolErrorKind,
  message: string,
  issues: readonly unknown[] | undefined,
): ToolErrorResult {
  return {
    kindgi: RETRY_MARKER,
    status: 'failed',
    error: { kind, message, ...(issues !== undefined && { issues }) },
    instruction: INSTRUCTIONS[kind],
  };
}

/**
 * Retries this turn has taken: the marked tool results after the turn's
 * user message. Earlier turns' results come back as history; they don't
 * count.
 */
export function toolRetriesSoFar(messages: readonly ModelMessage[]): number {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.role === 'user' && !isRepairMessage(m)) {
      start = i + 1;
      break;
    }
  }
  return messages.slice(start).filter(isRetryResult).length;
}

function isRetryResult(m: ModelMessage): boolean {
  if (m.role !== 'tool') return false;
  try {
    return (JSON.parse(m.content) as { readonly kindgi?: unknown }).kindgi === RETRY_MARKER;
  } catch {
    return false;
  }
}

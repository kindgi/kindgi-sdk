// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What an agent turn does when a tool call fails: send the failure back
 * to the model as the call's result, so it can correct the call, up to
 * `maxRetries` times per turn — for the kinds of failure in `retryOn`.
 * Anything else, and a failure past the retries, fails the turn.
 *
 * The same shape is an agent's `toolErrors` and the spec of a
 * `tool-errors` tenant policy. A tenant policy caps the agent's: the
 * fewer retries wins, and only kinds both allow are retried.
 */

/**
 * The failures a turn can retry:
 *   - `invalid-arguments` — the call's arguments don't fit the tool's
 *     input schema. Nothing ran.
 *   - `unknown-tool` — the model named a tool the agent doesn't have.
 *     Nothing ran.
 *   - `tool-error` — the tool ran and failed (it threw, or its output
 *     didn't fit its schema). A mutating tool may have changed something
 *     before failing, so retrying it is a deliberate choice.
 */
export const TOOL_ERROR_KINDS = ['invalid-arguments', 'unknown-tool', 'tool-error'] as const;
export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number];

/** The most retries a turn may take on failed tool calls. */
export const MAX_TOOL_ERROR_RETRIES = 10;

export interface ToolErrorsSpec {
  /** Failed calls sent back to the model per turn, 0–10. */
  readonly maxRetries?: number;
  /** Which failures are sent back; the rest fail the turn. */
  readonly retryOn?: readonly ToolErrorKind[];
}

export interface ToolErrorsSpecIssue {
  /** JSON Pointer into the spec, e.g. `/retryOn/1`. */
  readonly path: string;
  readonly message: string;
}

/**
 * Validate an unknown value as a `ToolErrorsSpec`: `maxRetries` an
 * integer from 0 to `MAX_TOOL_ERROR_RETRIES`, `retryOn` a list of known
 * kinds without repeats, nothing else.
 */
export function validateToolErrorsSpec(
  input: unknown,
):
  | { readonly kind: 'ok'; readonly value: ToolErrorsSpec }
  | { readonly kind: 'err'; readonly issues: readonly ToolErrorsSpecIssue[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { kind: 'err', issues: [{ path: '', message: 'must be an object' }] };
  }
  const spec = input as Record<string, unknown>;
  const issues: ToolErrorsSpecIssue[] = [
    ...Object.keys(spec)
      .filter((key) => key !== 'maxRetries' && key !== 'retryOn')
      .map((key) => ({ path: `/${key}`, message: 'is not a tool-errors setting' })),
    ...maxRetriesIssues(spec.maxRetries),
    ...retryOnIssues(spec.retryOn),
  ];
  return issues.length > 0
    ? { kind: 'err', issues }
    : { kind: 'ok', value: spec as ToolErrorsSpec };
}

function maxRetriesIssues(value: unknown): ToolErrorsSpecIssue[] {
  if (value === undefined) return [];
  return Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_TOOL_ERROR_RETRIES
    ? []
    : [
        {
          path: '/maxRetries',
          message: `must be an integer from 0 to ${MAX_TOOL_ERROR_RETRIES}`,
        },
      ];
}

function retryOnIssues(value: unknown): ToolErrorsSpecIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [{ path: '/retryOn', message: 'must be a list' }];
  const seen = new Set<unknown>();
  return value.flatMap((kind, i) => {
    if (!(TOOL_ERROR_KINDS as readonly unknown[]).includes(kind)) {
      return [{ path: `/retryOn/${i}`, message: `must be one of ${TOOL_ERROR_KINDS.join(', ')}` }];
    }
    if (seen.has(kind)) return [{ path: `/retryOn/${i}`, message: 'is listed twice' }];
    seen.add(kind);
    return [];
  });
}

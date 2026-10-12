// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type InvokeAgentError, parseFailureMessage } from '@kindgi/agents';

/** Why a run failed, on the wire (`Run.failure`). */
export interface RunFailure {
  /** The error's own code (`budget-exceeded`, `capability-routing-failed`, …), or `run-failed`. */
  readonly code: string;
  readonly message: string;
  /** What the error came from, when it says (e.g. the router's reasons, by provider). */
  readonly cause?: unknown;
  /**
   * The error's own reason, when it gives one: for a turn that ended at its
   * approval, `timeout` (nobody decided in time) or `approval-withdrawn`.
   * Absent from an older runtime, and from errors without one: read `code`.
   */
  readonly reason?: string;
  /**
   * The error's own facts, for a code that has them: for
   * `rate-limit-exceeded`, `limit` and `budgetMs`, as the API's 429 names
   * them. Never a wait: one read back later is stale. Absent for any
   * other code, and from an older runtime.
   */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A field of the turn error with code `C`, other than the ones a `RunFailure` has. */
type Detail<C extends InvokeAgentError['code']> = Exclude<
  Extract<keyof Extract<InvokeAgentError, { readonly code: C }>, string>,
  'code' | 'message' | 'cause' | 'reason'
>;

/**
 * The fields a turn's error keeps in `details` when its run is read back,
 * by code. Only these: an error's other fields can hold the turn's
 * content (a tool's input), and a wait (`retryAfterMs`) is stale by then.
 */
const DETAILS_BY_CODE: { readonly [C in InvokeAgentError['code']]?: readonly Detail<C>[] } = {
  'rate-limit-exceeded': ['limit', 'budgetMs'],
};

/** `error`'s `DETAILS_BY_CODE` fields that it has, or `undefined` for none. */
function detailsOf(error: InvokeAgentError): Readonly<Record<string, unknown>> | undefined {
  const fields: readonly string[] = DETAILS_BY_CODE[error.code] ?? [];
  const own = error as unknown as Readonly<Record<string, unknown>>;
  const details = Object.fromEntries(
    fields.filter((field) => own[field] !== undefined).map((field) => [field, own[field]]),
  );
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * A failed run's error, so a caller needn't parse `failureMessage`. An
 * agent turn's failure reads back as its typed error, the way
 * `invokeAgent` reads a run (`parseFailureMessage`; with several joined,
 * the first). Any other is `run-failed`, in the run's own words.
 * Absent unless the run is `failed`.
 */
export function runFailure(row: {
  readonly runId: unknown;
  readonly status: string;
  readonly failureMessage?: string | null;
}): RunFailure | undefined {
  if (row.status !== 'failed') return undefined;
  const raw = row.failureMessage ?? undefined;
  const error = parseFailureMessage(raw);
  if (error !== undefined) {
    const { cause, reason } = error as { readonly cause?: unknown; readonly reason?: unknown };
    const details = detailsOf(error);
    return {
      code: error.code,
      message: error.message,
      ...(cause !== undefined && cause !== null && { cause }),
      ...(typeof reason === 'string' && reason !== '' && { reason }),
      ...(details !== undefined && { details }),
    };
  }
  return {
    code: 'run-failed',
    message: raw !== undefined && raw !== '' ? raw : `Run ${String(row.runId)} failed`,
  };
}

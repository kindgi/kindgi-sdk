// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { parseFailureMessage } from '@kindgi/agents';

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
    return {
      code: error.code,
      message: error.message,
      ...(cause !== undefined && cause !== null && { cause }),
      ...(typeof reason === 'string' && reason !== '' && { reason }),
    };
  }
  return {
    code: 'run-failed',
    message: raw !== undefined && raw !== '' ? raw : `Run ${String(row.runId)} failed`,
  };
}

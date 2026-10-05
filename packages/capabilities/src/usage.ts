// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';

import type { ModelUsageRecord, UsageSink } from './types.js';

/** How `recordModelUsage` tries a sink that fails. */
export interface RecordModelUsageOptions {
  /** Tries in all, the first included. Default 3. */
  readonly tries?: number;
  /** The wait before the second try; each later wait is 4× the one before. Default 50 ms. */
  readonly backoffMs?: number;
}

/**
 * Record one model call in `sink`, trying again when the sink fails: a
 * record is idempotent by `callId`, so a retry can't count a call twice.
 * `err` carries the last failure when every try failed; the caller
 * decides what that means for its step.
 */
export async function recordModelUsage(
  sink: UsageSink,
  call: ModelUsageRecord,
  options: RecordModelUsageOptions = {},
): Promise<Result<void, unknown>> {
  const tries = Math.max(1, options.tries ?? 3);
  let wait = options.backoffMs ?? 50;
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      await sink.record(call);
      return { kind: 'ok', value: undefined };
    } catch (error) {
      last = error;
      if (attempt < tries) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait *= 4;
      }
    }
  }
  return { kind: 'err', error: last };
}

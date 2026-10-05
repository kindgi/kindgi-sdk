// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi runs start` waits for a run by following it, not by holding the
 * start request open. The run starts in the background (`wait: false`), so
 * its id is known at once, and the CLI reads it (`runs.get`) until it
 * leaves `pending`/`running`: it finished, or it waits on an approval,
 * where a waiting start used to answer. A long run no longer times out the
 * start request with no id to follow it by: whatever stops the wait (the
 * reads failing, Ctrl+C) says which run goes on, and how to look at it.
 */

import type { Run } from '@kindgi/client';

/** Statuses `runs start` waits through. */
const IN_PROGRESS: ReadonlySet<string> = new Set(['pending', 'running']);

/** Pauses between reads: quick at first, then every 2 s. */
const PAUSES_MS: readonly number[] = [250, 500, 1_000, 2_000];

/** Reads that fail in a row before the CLI stops following. */
const MAX_FAILED_READS = 5;

export interface FollowRunOptions {
  /** Read the run by id (the client's `runs.get`). */
  readonly get: (id: string) => Promise<Run>;
  /** The pause before each read; tests pass `() => 0`. */
  readonly pauseMs?: (read: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The command that shows a run, for the hints. */
export function runsGetHint(id: string): string {
  return `kindgi runs get ${id}`;
}

/**
 * The run as it is when it stops being in progress. The fields only the
 * start answer carries (the public run token) are kept.
 */
export async function followRun(started: Run, options: FollowRunOptions): Promise<Run> {
  if (!IN_PROGRESS.has(started.status)) return started;
  const pauseMs =
    options.pauseMs ?? ((read: number) => PAUSES_MS[Math.min(read, PAUSES_MS.length - 1)] ?? 2_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let failed = 0;
  for (let read = 0; ; read += 1) {
    await sleep(pauseMs(read));
    let current: Run;
    try {
      current = await options.get(started.id);
    } catch (err) {
      failed += 1;
      if (failed >= MAX_FAILED_READS) {
        throw new Error(
          `could not follow run ${started.id}: ${(err as Error).message}. The run goes on: ${runsGetHint(started.id)}`,
        );
      }
      continue;
    }
    failed = 0;
    if (!IN_PROGRESS.has(current.status)) return { ...startOnly(started), ...current };
  }
}

/** The start answer's own fields, which a read of the run doesn't carry. */
function startOnly(started: Run): Partial<Run> {
  const fields = started as unknown as Record<string, unknown>;
  return Object.fromEntries(
    ['publicAccessToken', 'publicAccessTokenExpiresAt']
      .filter((key) => fields[key] !== undefined)
      .map((key) => [key, fields[key]]),
  ) as Partial<Run>;
}

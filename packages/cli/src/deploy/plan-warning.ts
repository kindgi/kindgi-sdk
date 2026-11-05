// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The lines a deploy or a promotion prints when its answer carries
 * `planWarning`: the runtime counts the flows and agents in production
 * against its license key's plan, and one of the counts is at its plan
 * or past it.
 */

/** One count, at its plan or past it (`PlanCount` in `@kindgi/api`). */
export interface PlanCountRecord {
  /** The plan's number. */
  readonly plan: number;
  /** The most the key runs: the plan's number and a margin. */
  readonly most: number;
  /** How many run in production, with the write. */
  readonly inUse: number;
}

/** Each count at its plan or past it (`PlanWarning` in `@kindgi/api`). */
export interface PlanWarningRecord {
  readonly flows?: PlanCountRecord;
  readonly agents?: PlanCountRecord;
}

/**
 * A line for each count, flows first, each after `indent`:
 * `⚠ 10 of your plan's 10 agents run in production. Past 12, new ones are refused.`
 * None without a warning.
 */
export function planWarningLines(warning: PlanWarningRecord | undefined, indent = ''): string[] {
  if (warning === undefined) return [];
  const counts = [
    ['flow', warning.flows],
    ['agent', warning.agents],
  ] as const;
  return counts.flatMap(([noun, count]) =>
    count === undefined
      ? []
      : [
          `${indent}⚠ ${count.inUse} of your plan's ${count.plan} ${count.plan === 1 ? noun : `${noun}s`} ` +
            `${count.inUse === 1 ? 'runs' : 'run'} in production. Past ${count.most}, new ones are refused.`,
        ],
  );
}

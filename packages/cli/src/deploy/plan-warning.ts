// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The lines a deploy or a promotion prints when its answer carries
 * `planWarning`: the runtime counts the flows and agents in production
 * against its license key's plan, or against the workspace's own limits,
 * and one of the counts is at its plan or past it.
 */

/** One count, at its plan or past it (`PlanCount` in `@kindgi/api`). */
export interface PlanCountRecord {
  /** The plan's number. */
  readonly plan: number;
  /** The most that may run: the plan's number and a margin. */
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
 * `⚠ 11 agents run in production; your plan has 10. Past 12, new ones are refused.`
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
          `${indent}⚠ ${count.inUse} ${count.inUse === 1 ? `${noun} runs` : `${noun}s run`} in production; ` +
            `your plan has ${count.plan}. Past ${count.most}, new ones are refused.`,
        ],
  );
}

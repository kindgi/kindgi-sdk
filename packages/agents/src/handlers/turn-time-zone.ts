// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { TenantBudgetError } from '@kindgi/bounds';
import type { Fact } from '@kindgi/memory';

import type { TurnContext } from './context.js';

/** The memory fact type a workspace keeps its time zone as: `{ timeZone: 'America/Toronto' }`. */
export const TIME_ZONE_FACT_TYPE = 'time-zone';

/** The zone a turn's tools get when the workspace sets none, or it can't be read. */
export const DEFAULT_TIME_ZONE = 'UTC';

/**
 * How many workspace-wide `time-zone` facts the read looks at. A workspace
 * keeps one current fact (the console changes it by superseding it, and
 * clears it with a tombstone), so this is far above anything real.
 */
const TIME_ZONE_FACTS_READ = 20;

/** Why a turn's zone fell back to UTC though the workspace may set one. */
export type TimeZoneProblem = 'read-failed' | 'bad-name';

/** The turn's zone, and why it's UTC when it fell back. */
export interface TurnTimeZone {
  readonly timeZone: string;
  readonly problem?: TimeZoneProblem;
}

/**
 * Set the turn's zone (`TurnContext.timeZone`) when the turn offers a
 * tool: `journaled`, the zone `setup` recorded, for a resumed turn; else
 * the workspace's, read now (`readWorkspaceTimeZone`). A turn that offers
 * no tool doesn't read it. Answers what was set, for `setup` to journal.
 */
export async function resolveTurnTimeZone(
  ctx: TurnContext,
  journaled?: string,
): Promise<TurnTimeZone | undefined> {
  if ((ctx.tools?.definitions.length ?? 0) === 0) return undefined;
  const zone = journaled !== undefined ? { timeZone: journaled } : await readWorkspaceTimeZone(ctx);
  ctx.timeZone = zone.timeZone;
  return zone;
}

/**
 * The name `Intl` knows `name` by, or `undefined` when it isn't a zone it
 * knows. A name counts when `Intl.DateTimeFormat` takes it, the way a
 * schedule's cron takes its zone, so an alias such as `US/Eastern` counts
 * too; the answer is the name `Intl` resolves it to.
 */
export function knownTimeZone(name: string): string | undefined {
  if (name.trim() === '') return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * The workspace's time zone, read once for the turn: the newest
 * workspace-wide `time-zone` fact a person or a service wrote (an agent's
 * own fact doesn't count, so a message can't move the workspace's dates).
 * `UTC` when there's none; when the read fails (`read-failed`); and when
 * the fact's `timeZone` isn't a zone name (`bad-name`). Never fails the
 * turn, except that a tenant budget's refusal is the turn's, as it is
 * wherever the turn's work hits one.
 */
export async function readWorkspaceTimeZone(ctx: TurnContext): Promise<TurnTimeZone> {
  let listed: Awaited<ReturnType<TurnContext['bindings']['memoryBinding']['listFacts']>>;
  try {
    // No readers: the guard answers workspace-wide facts only.
    listed = await ctx.bindings.memoryBinding.listFacts<unknown>({
      tenantId: ctx.input.tenantId,
      type: TIME_ZONE_FACT_TYPE,
      limit: TIME_ZONE_FACTS_READ,
    });
  } catch (cause) {
    if (cause instanceof TenantBudgetError) throw cause;
    return { timeZone: DEFAULT_TIME_ZONE, problem: 'read-failed' };
  }
  if (listed.kind === 'err') return { timeZone: DEFAULT_TIME_ZONE, problem: 'read-failed' };
  const fact = newest(listed.value.filter(isWorkspaceSetting));
  if (fact === undefined) return { timeZone: DEFAULT_TIME_ZONE };
  const named = zoneNameOf(fact.content);
  const known = named === undefined ? undefined : knownTimeZone(named);
  return known === undefined
    ? { timeZone: DEFAULT_TIME_ZONE, problem: 'bad-name' }
    : { timeZone: known };
}

/** A fact scoped to the workspace alone, not written by an agent. */
function isWorkspaceSetting(fact: Fact<unknown>): boolean {
  const { tenantId: _tenant, ...narrower } = fact.scope;
  if (Object.values(narrower).some((value) => value !== undefined)) return false;
  return fact.attributedTo?.kind !== 'agent';
}

function newest(facts: readonly Fact<unknown>[]): Fact<unknown> | undefined {
  let found: Fact<unknown> | undefined;
  for (const fact of facts) {
    if (found === undefined || changedAt(fact) > changedAt(found)) found = fact;
  }
  return found;
}

function changedAt(fact: Fact<unknown>): number {
  return Date.parse(String(fact.updatedAt ?? fact.createdAt));
}

function zoneNameOf(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const value = (content as { readonly timeZone?: unknown }).timeZone;
  return typeof value === 'string' ? value : undefined;
}

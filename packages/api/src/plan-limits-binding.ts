// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, TenantId } from '@kindgi/types';

/**
 * Host-plugged plan limits: how many agents and how many flows may run in
 * production. The runtime counts each agent or flow once, however many
 * projects in production or versions run it, and only in projects in
 * production. A write that would take a count past its most is refused,
 * whole. What runs keeps running: an id already counted is never new, so
 * a new version, an edit or a redeploy of one goes through.
 *
 * The writes that can add an id to a project in production ask it:
 * deploy, promote, agent and flow publish, reinstate, putting a project
 * in production, and the agent version a suggested change's check makes.
 * `admit` wraps only a route's writes, after its own checks; `check`
 * answers the two dry checks, with nothing held and nothing written.
 * Without it, every route writes as it would, and nothing is counted.
 *
 * Neither is re-entrant: a write `admit` wraps never calls `admit` or
 * `check`. A read the binding needs that fails rejects, with nothing
 * written, and the route answers it as any store failure.
 *
 * When `write` rejects, `admit` rejects with that same error, unchanged:
 * the routes answer a write's own refusals (a deploy's tool schema
 * budget, a publish refused) from the error they threw.
 */
export interface PlanLimitsBinding {
  admit<T>(input: PlanLimitsInput, write: () => Promise<T>): Promise<PlanAdmission<T>>;
  check(input: PlanLimitsInput): Promise<PlanCheck>;
}

/** What a write lands, and where. */
export interface PlanLimitsInput {
  readonly tenantId: TenantId;
  /**
   * The project the write lands in. Every form but reinstate always
   * names one. A reinstate names the project its version was made in,
   * and none when the store records none: a reinstated version counts
   * wherever it runs either way.
   */
  readonly projectId?: ProjectId;
  /**
   * The agent and flow ids the write lands in it; `whole-project` for
   * putting the project in production, when every id it runs counts; or
   * one retired version made active again, which counts wherever that
   * version runs.
   */
  readonly adding: PlanAdding | 'whole-project' | PlanReinstating;
}

/** Agent and flow ids, each list without repeats. */
export interface PlanAdding {
  readonly agents: readonly string[];
  readonly flows: readonly string[];
}

/** A retired agent or flow version being reinstated. */
export interface PlanReinstating {
  readonly reinstate: {
    readonly limit: PlanLimit;
    readonly id: string;
    readonly version: string;
  };
}

/** The two counts. */
export type PlanLimit = 'flows' | 'agents';

/**
 * Whose numbers a count is held to: the license key's, across the
 * runtime (`installation`), or the tenant's own limits (`tenant`,
 * `TenantLimits.flowsInProduction` and `agentsInProduction`).
 */
export type PlanScope = 'installation' | 'tenant';

/**
 * A count against its plan: the plan's own number, the most that may run
 * (the plan and a margin), and how many run in production.
 */
export interface PlanCount {
  readonly plan: number;
  readonly most: number;
  readonly inUse: number;
}

/** One count a write would pass. */
export interface PlanOver {
  readonly limit: PlanLimit;
  /** How many of this count's ids the write adds to production. */
  readonly adding: number;
  /**
   * Whose numbers it passes. Absent: the license key's (`installation`).
   * When both would refuse, the binding names one.
   */
  readonly scope?: PlanScope;
  /**
   * The count's numbers, before the write. Absent when this tenant may not
   * see them: they count other tenants too. A tenant's own limits are
   * always its to see.
   */
  readonly numbers?: PlanCount;
}

/**
 * The counts at or past their plan after a write, with how many run
 * then. At least one member: a write under both plans has none.
 */
export interface PlanWarning {
  readonly flows?: PlanCount;
  readonly agents?: PlanCount;
}

/** A write refused: none of the flows and agents it adds is added. */
export interface PlanRefused {
  readonly kind: 'refused';
  /** Every count the write would pass, flows first. */
  readonly over: readonly [PlanOver, ...PlanOver[]];
  /** The ids the write would add to production, both counts'. */
  readonly newIds: PlanAdding;
}

/**
 * What `admit` answers: refused, `busy` (the count couldn't be had in
 * time, and nothing ran), or the write's value with any warning.
 */
export type PlanAdmission<T> =
  | PlanRefused
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly value: T; readonly warning?: PlanWarning };

/** What `check` answers: what `admit` would, with nothing written. */
export type PlanCheck = PlanRefused | { readonly kind: 'ok'; readonly warning?: PlanWarning };

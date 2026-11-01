// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { RetentionDomain } from '@kindgi/policy-contract';
import type { TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the retention pipeline — the API routes
 * (`/v1/retention/scheduled`, `/v1/retention/sweep`,
 * `/v1/retention/sweep/:domain`) call this binding; the Kindgi runtime
 * provides an implementation backed by its retention executor.
 *
 * Wire shape is deliberately kept minimal — the deep types (candidates,
 * per-domain entries, missing-adapter marker) live in the runtime. The
 * api package keeps a leaner projection here so the route body is easy
 * to reason about.
 */
export interface RetentionBinding {
  /**
   * Enumerate tombstoned rows across every domain with an adapter
   * registered. `pastGraceOnly = false` returns both in-grace and
   * past-grace candidates — the "Scheduled for deletion" view uses
   * that. `true` returns only rows the sweeper would purge right now.
   */
  scheduled(input: RetentionScheduledInput): Promise<RetentionScheduledPage>;

  /**
   * Trigger a sweep across every domain (or `domain` if provided).
   * Idempotent — a second call after a successful sweep returns
   * `purged: 0` per domain. While the tenant's purge runs, a runtime that
   * keeps sweeps off it answers `RetentionSweepRefused` and sweeps
   * nothing: the purge deletes the tenant's rows itself.
   */
  sweep(input: RetentionSweepInput): Promise<RetentionSweepResult | RetentionSweepRefused>;
}

export interface RetentionScheduledInput {
  readonly tenantId: TenantId;
  readonly domain?: RetentionDomain;
  /** Rows per domain at most: each domain is read up to `limit`. */
  readonly limit: number;
  readonly pastGraceOnly?: boolean;
  readonly now?: Date;
  /** Where a previous page stopped (its `nextCursor`, the runtime's own encoding). */
  readonly cursor?: string;
}

export interface RetentionScheduledItem {
  readonly domain: RetentionDomain;
  readonly id: string;
  readonly unregisteredAt: string;
  readonly purgeAt: string;
  readonly pastGrace: boolean;
  /** The retention policy that covers the domain. Absent when none does and the server's limit decides (`limitApplied`). */
  readonly policyId?: string;
  readonly policyVersion?: string;
  /** How long the row is kept, in seconds (`-1`: a hold, never purged). */
  readonly graceSeconds: number;
  /**
   * The server's retention limit for the domain (`RetentionLimits`) set
   * `graceSeconds`: no policy covers the domain, or its policy keeps rows
   * longer than the limit, or holds them.
   */
  readonly limitApplied?: true;
}

export interface RetentionScheduledPage {
  readonly data: readonly RetentionScheduledItem[];
  /** Domains a retention policy exists for but no adapter is wired in this deployment. */
  readonly domainsMissingAdapter: readonly RetentionDomain[];
  /** Domains that have an adapter but no matching policy and no limit (`RetentionLimits`) — tombstones sit forever. */
  readonly unpolicedDomains: readonly RetentionDomain[];
  /** Domains more than one retention policy covers (see `RetentionPolicyConflict`). */
  readonly conflicts?: readonly RetentionPolicyConflict[];
  /**
   * More rows are scheduled than this page holds: some domain stopped at
   * `limit`. A runtime that doesn't say leaves it out, and the route then
   * reports `true` when some domain's rows fill `limit` (there may be more).
   */
  readonly hasMore?: boolean;
  /** Pass as `cursor` to continue where this page stopped. Absent: nothing more, or no way to continue. */
  readonly nextCursor?: string;
}

/**
 * A domain more than one retention policy covers. Publishing refuses a
 * second policy for a domain (`409 policy-scope-taken`), so only policies
 * stored before that rule can do this. The one whose latest version is
 * highest applies, and on equal versions the lower policy id; unregister
 * the others.
 */
export interface RetentionPolicyConflict {
  readonly domain: RetentionDomain;
  /** Every policy id that covers the domain, sorted. */
  readonly policyIds: readonly string[];
  /** The one of them that applies. */
  readonly appliedPolicyId: string;
}

/**
 * The most a retention policy may keep a domain's tombstoned rows, per
 * domain, in whole seconds (at least 1): `createApp`'s `retentionLimits`.
 * A policy for a limited domain that keeps rows longer, or holds them
 * (`graceSeconds: -1`), is refused when it's published or reinstated
 * (`400 retention-over-limit`). A `*` policy isn't: the runtime caps each
 * limited domain at its limit when it sweeps, and applies the limit to a
 * limited domain no policy covers. A domain with no limit takes any grace.
 */
export type RetentionLimits = Readonly<
  Partial<Record<Exclude<RetentionDomain, '*'>, { readonly seconds: number }>>
>;

export interface RetentionSweepInput {
  readonly tenantId: TenantId;
  readonly domain?: RetentionDomain;
  readonly maxPerDomain?: number;
  readonly now?: Date;
}

export interface RetentionSweepResult {
  readonly perDomain: readonly {
    readonly domain: RetentionDomain;
    readonly purged: number;
    readonly remaining: number;
    readonly policyId?: string;
    /** The server's retention limit set the grace (see `RetentionScheduledItem.limitApplied`). */
    readonly limitApplied?: true;
    readonly missingAdapter?: true;
  }[];
  readonly totalPurged: number;
  /** Domains more than one retention policy covers (see `RetentionPolicyConflict`). */
  readonly conflicts?: readonly RetentionPolicyConflict[];
}

/**
 * A sweep that didn't run: the tenant's purge is running
 * (`tenant-purging`). The sweep routes answer it with `409 tenant-closing`.
 */
export interface RetentionSweepRefused {
  readonly refused: 'tenant-purging';
}

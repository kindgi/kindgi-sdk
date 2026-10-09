// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for erasing a person's words
 * (`/v1/memory/erasures`). The API package validates, authorizes (a
 * tenant admin only) and shapes the wire; the binding runs the erasure:
 * memory facts, conversations, the runs that served them, and what they
 * left in provenance, as the deployment's runtime knows its stores. An
 * erasure runs in the background; `create` answers once it's recorded.
 *
 * A completed erasure keeps no identifier: what's left is its ledger row
 * (the selector's kind, a keyed hash of it, who, when, how much), which
 * an operator exports off-box and replays after restoring a backup.
 */
export interface MemoryErasureBinding {
  create(input: {
    readonly tenantId: TenantId;
    readonly selector: MemoryErasureSelector;
    /** `user:<id>` or `service:<id>`: who asked. */
    readonly requestedBy: string;
  }): Promise<CreateMemoryErasureOutcome>;
  get(tenantId: TenantId, id: string): Promise<MemoryErasure | undefined>;
  /** Newest first. `undefined` when the cursor isn't one this binding issued. */
  list(
    tenantId: TenantId,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<{ readonly data: readonly MemoryErasure[]; readonly nextCursor?: string } | undefined>;
  /** The whole ledger, content-free, oldest first. */
  exportLedger(tenantId: TenantId): Promise<readonly MemoryErasureLedgerEntry[]>;
  /**
   * Try an unfinished erasure again now; with `force`, stop waiting for a
   * run in a flow that serves other people (it's cancelled). A finished
   * one comes back as it is; `undefined` when there's no such erasure.
   */
  resume(
    tenantId: TenantId,
    id: string,
    options: { readonly force?: boolean },
  ): Promise<MemoryErasure | undefined>;
  /** After a backup restore: restore the ledger and run its erasures again. */
  replay(
    tenantId: TenantId,
    entries: readonly MemoryErasureLedgerEntry[],
  ): Promise<ReplayMemoryErasuresResult>;
}

/**
 * Whose words to erase: one fact, a person (an app's end user
 * `participant`, or an `external` subject facts name), or one
 * conversation. Erasing a Kindgi user isn't offered.
 */
export type MemoryErasureSelector =
  | { readonly factId: string }
  | {
      readonly subject: {
        readonly kind: 'participant' | 'external';
        readonly id: string;
      };
    }
  | { readonly conversationId: string };

export type MemoryErasureSelectorKind = 'fact' | 'participant' | 'external' | 'conversation';

/**
 * `waiting-on-run`: a turn of the person's sits in a flow that serves
 * other people; the erasure waits for it (`waitingOn`) until its
 * deadline, then cancels it. `resume` with `force` stops the wait.
 */
export type MemoryErasureStatus = 'pending' | 'running' | 'waiting-on-run' | 'completed' | 'failed';

export interface MemoryErasure {
  readonly id: string;
  readonly selectorKind: MemoryErasureSelectorKind;
  /** Only while it runs: a completed or failed erasure keeps no identifier. */
  readonly selector?: MemoryErasureSelector;
  readonly status: MemoryErasureStatus;
  /**
   * Where a running erasure is: `seed`, `expand`, `settle` (the person's
   * unfinished runs end, or it waits for them, before anything is
   * cleared), `erase`, then `done`.
   */
  readonly phase: 'seed' | 'expand' | 'settle' | 'erase' | 'done';
  readonly requestedBy: string;
  /** A replay after a backup restore can find this person again (a keyed hash was kept). */
  readonly matchable: boolean;
  /** What each store cleared or deleted, by store. */
  readonly counts: Readonly<Record<string, number>>;
  /** Failed attempts so far. */
  readonly attempts: number;
  /** The last failure's code, or why it's waiting (`not-yet:<reason>`). Never content. */
  readonly lastError?: string;
  /** The run it waits (or waited) for, and until when; kept as the record of the wait. */
  readonly waitingOn?: { readonly runId: string; readonly until?: string };
  /** A tenant admin said not to wait. */
  readonly forced?: true;
  /**
   * Runs of the person's kept appearing, round after round: the erasure
   * went on to erase after its last round rather than wait any longer.
   */
  readonly settleRoundsCapped?: true;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly replayedAt?: string;
}

/** One ledger row, as exported off-box and given back to a replay. Content-free. */
export interface MemoryErasureLedgerEntry {
  readonly id: string;
  readonly selectorKind: MemoryErasureSelectorKind;
  /** HMAC-SHA256 (hex) of the selector under the tenant's ledger key; absent without one. */
  readonly selectorHmac?: string;
  /** Which ledger key made `selectorHmac`. */
  readonly keyId?: string;
  readonly requestedBy: string;
  readonly status: MemoryErasureStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface MemoryErasureWarning {
  /** `erasure-unmatchable`: no ledger key, so a replay after a restore can't find this person. */
  readonly code: 'erasure-unmatchable';
  readonly message: string;
}

export type CreateMemoryErasureOutcome =
  | {
      readonly kind: 'created';
      readonly erasure: MemoryErasure;
      readonly warnings: readonly MemoryErasureWarning[];
    }
  | {
      readonly kind: 'refused';
      /** Legal hold on a fact it reaches: nothing started. */
      readonly refusal: {
        readonly code: 'legal-hold';
        readonly message: string;
        readonly factIds?: readonly string[];
      };
    };

export interface ReplayMemoryErasuresResult {
  /** Matched to an id in the tenant again: run again. */
  readonly replayed: readonly string[];
  /** Put back in the ledger; nothing in the tenant matches (nothing to erase). */
  readonly restored: readonly string[];
  /** No keyed hash, or a key this deployment doesn't hold. */
  readonly unmatched: readonly {
    readonly id: string;
    readonly reason: 'no-keyed-hash' | 'unknown-key';
  }[];
}

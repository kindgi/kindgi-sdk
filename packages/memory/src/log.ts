// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LogEntryId, RunId, Timestamp } from '@kindgi/types';

import type { MemoryScope } from './types.js';

/** Kind identifiers for LogEntry — matches the enum in `@kindgi/specs/memory.schema.json`. */
export const LOG_KINDS = [
  'user-message',
  'agent-message',
  'system-message',
  'tool-call',
  'tool-result',
  'internal-thought',
  'retrieval',
  'artifact-produced',
  'event-emitted',
  'event-received',
  'guardrail-triggered',
  'wait-suspended',
  'wait-resumed',
] as const;

export type LogKind = (typeof LOG_KINDS)[number];

/**
 * One event in the append-only log for a run / thread / session. Immutable
 * once written. Ordered by (sequence, timestamp) within `(tenantId, runId)`.
 *
 * Every entry commits to a hash of the previous entry in the same
 * `(tenantId, runId)` chain via `prevHash` → `entryHash`. Tamper with any
 * past entry and every subsequent entry's `prevHash` breaks — the whole
 * chain is one Merkle-lite structure.
 */
export interface LogEntry {
  readonly id: LogEntryId;
  readonly kind: LogKind;
  readonly scope: MemoryScope;
  readonly runId: RunId;
  readonly actor?: string;
  readonly timestamp: Timestamp;
  /** Monotonic sequence within `(tenantId, runId)`. */
  readonly sequence: number;
  readonly payload?: unknown;
  readonly contentHash?: string;
  /** Zero-hash for sequence 0. */
  readonly prevHash: string;
  readonly entryHash: string;
  readonly causedByLogId?: string;
  /**
   * How `entryHash` was computed. `2`: over the payload's hash
   * (`contentHash`), so a payload cleared by an erasure still verifies.
   * `1` (entries from before): over the payload itself. Absent: 1.
   */
  readonly hashVersion?: 1 | 2;
  /** When an erasure cleared `payload` (its `contentHash` stays). */
  readonly payloadErasedAt?: Timestamp;
}

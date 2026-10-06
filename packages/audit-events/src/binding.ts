// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, TenantId } from '@kindgi/types';

import type { AuditEventValidationError, InvalidCursorError, PersistenceError } from './errors.js';
import type { AuditEvent, AuditEventFilter, AuditEventPage } from './types.js';

/**
 * Caller-plugged, tenant-scoped write + query surface for the unified
 * audit substrate.
 *
 * Contracts:
 *   - `append` — batched write; groups by tenant, one insert per
 *     tenant per call. Duplicates on `(tenantId, id)` are silent
 *     (idempotent — safer than throwing when the caller re-fires
 *     from a retry loop).
 *   - `query` — cursor-paginated read; opaque cursor tokens encode
 *     `(timestamp, id)` for keyset pagination, oldest first or, with
 *     `order: 'desc'`, newest first.
 *   - `purge` — delete rows matching `(tenantId, kind, olderThan)`;
 *     retention cleanup calls this per kind. Legal-hold kinds are
 *     excluded by the caller (the compliance classifier decides).
 *
 * Signing lives at the export layer (compliance export), not on the
 * write path. Row content is stable; signature is deterministic from
 * canonical bytes.
 */
export interface AuditEventBinding {
  append(
    events: readonly AuditEvent[],
  ): Promise<Result<void, PersistenceError | AuditEventValidationError>>;

  query(
    input: AuditEventQueryInput,
  ): Promise<Result<AuditEventPage, PersistenceError | InvalidCursorError>>;

  purge(input: AuditEventPurgeInput): Promise<Result<AuditEventPurgeResult, PersistenceError>>;

  describe(): { readonly name: string; readonly version: string };
}

export interface AuditEventQueryInput {
  readonly tenantId: TenantId;
  readonly filter?: AuditEventFilter;
  readonly cursor?: string;
  readonly limit?: number;
  /**
   * `asc` (absent): oldest first. `desc`: newest first. `nextCursor`
   * continues in the same order. A binding that predates `order` pages
   * oldest first.
   */
  readonly order?: AuditEventOrder;
}

/** The order `query` pages in, by `(timestamp, id)`. */
export type AuditEventOrder = 'asc' | 'desc';

export interface AuditEventPurgeInput {
  readonly tenantId: TenantId;
  /**
   * Event kind to purge. One purge = one kind — keeps retention
   * cleanup's per-kind granularity explicit. Legal-hold kinds should
   * never reach this call.
   */
  readonly kind: string;
  /** ISO timestamp cutoff. Rows with `timestamp < olderThan` are deleted. */
  readonly olderThan: string;
}

export interface AuditEventPurgeResult {
  readonly deleted: number;
}

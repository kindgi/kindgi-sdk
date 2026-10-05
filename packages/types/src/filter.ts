// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Brand, OrgId, ProjectId } from './ids.js';
import type { Timestamp } from './temporal.js';

/**
 * Opaque pagination cursor. Producers return a `Cursor`; consumers pass
 * it back verbatim to the next list call. The value is implementation-
 * defined (usually a timestamp or opaque token) — callers must not
 * parse or construct one by hand.
 */
export type Cursor = Brand<string, 'Cursor'>;

/**
 * Shared list-filter shape. List inputs extend this (e.g. the team and
 * project bindings in `@kindgi/platform`) so resources share one
 * facet-filter shape.
 *
 * `TStatus` narrows the `status` field per-resource (e.g. the
 * `ApprovalStatus`, `FixProposalStatus` and `ObservationStatus` unions
 * in `@kindgi/api`).
 *
 * All fields are optional. A caller can pass an empty `Filter` to get
 * the default page.
 */
export interface Filter<TStatus extends string = string> {
  /**
   * Filter to one status or a set of statuses. The resource-specific
   * input type narrows TStatus so consumers get autocomplete on the
   * allowed values.
   */
  readonly status?: TStatus | readonly TStatus[];
  /**
   * Lower bound on the resource's canonical timestamp — typically
   * `createdAt` or `observedAt`. Inclusive. Absent = no lower bound.
   */
  readonly since?: Timestamp;
  /**
   * Upper bound on the resource's canonical timestamp. Inclusive.
   * Absent = no upper bound.
   */
  readonly until?: Timestamp;
  /**
   * Max items to return. Producers clamp to a resource-specific ceiling
   * (typically 500). Default page size is producer-defined.
   */
  readonly limit?: number;
  /** Opaque cursor from a prior list call's `nextCursor` field. */
  readonly cursor?: Cursor;
}

/**
 * Shared list-result envelope. List producers that use it return
 * `{ items, nextCursor? }`. Consumers keep calling with `cursor:
 * result.nextCursor` until it's absent.
 *
 * `truncated: true` explicitly signals "more items exist beyond the
 * cursor" for aggregators that don't paginate but should still know
 * they missed data.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: Cursor;
  readonly truncated?: boolean;
}

/**
 * A list's content scope: one project's records, or those of every
 * project in an org. Absent: the whole tenant. Lists of content (runs,
 * approvals, conversations, provenance) take it; on the wire it is
 * `?scopeKind=project|org&scopeId=…`. It narrows a list, it isn't an
 * authorization boundary.
 */
export type ListScope =
  | { readonly kind: 'project'; readonly projectId: ProjectId }
  | { readonly kind: 'org'; readonly orgId: OrgId };

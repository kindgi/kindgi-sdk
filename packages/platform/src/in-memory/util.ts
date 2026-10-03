// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Shared helpers for the in-memory reference adapters.
 *
 * - `nowTimestamp()` — monotonic-ish `Timestamp` from `Date.now()`.
 *   Uses a per-call increment fallback so two calls in the same
 *   millisecond still produce a strictly-increasing pair (matters for
 *   `list` ordering by `createdAt`).
 * - `paginate(all, limit, cursor)` — takes a sorted array + optional
 *   `limit` + optional opaque `Cursor` and returns a `Page<T>`. Cursor
 *   encoding is `String(offset)` — trivial for the in-memory adapter,
 *   opaque to callers per the `Cursor` doc-comment in
 *   `packages/types/src/filter.ts`.
 */

import type { Cursor, Page, Timestamp } from '@kindgi/types';

// Monotonic counter so back-to-back calls inside a single millisecond
// still produce strictly-increasing `Timestamp` values. Kept module-
// local; not exposed.
let lastMs = 0;
let lastCounter = 0;

export function nowTimestamp(): Timestamp {
  const ms = Date.now();
  if (ms === lastMs) {
    lastCounter += 1;
  } else {
    lastMs = ms;
    lastCounter = 0;
  }
  const date = new Date(ms).toISOString();
  // Encode the sub-ms counter as a trailing `#NNNN` suffix so the
  // resulting string still sorts lexicographically in creation order —
  // the in-memory adapter only compares strings.
  const suffix = lastCounter === 0 ? '' : `#${String(lastCounter).padStart(4, '0')}`;
  return `${date}${suffix}` as Timestamp;
}

/**
 * Default page size when a caller passes no `limit` ("small default,
 * high ceiling").
 */
export const DEFAULT_PAGE_LIMIT = 100;

/**
 * Maximum page size — clamps runaway `limit` values so a caller
 * can't accidentally exfiltrate an entire table.
 */
export const MAX_PAGE_LIMIT = 500;

export function paginate<T>(
  all: readonly T[],
  limit: number | undefined,
  cursor: Cursor | undefined,
): Page<T> {
  const effectiveLimit = Math.min(Math.max(1, limit ?? DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
  const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const slice = all.slice(safeOffset, safeOffset + effectiveLimit);
  const nextOffset = safeOffset + slice.length;
  const hasMore = nextOffset < all.length;
  if (hasMore) {
    return {
      items: slice,
      nextCursor: String(nextOffset) as Cursor,
    };
  }
  return { items: slice };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Brand } from './ids.js';

/**
 * An ISO 8601 timestamp string, always UTC (trailing 'Z').
 *
 * Example: '2026-09-16T14:23:45.123Z'
 *
 * Kept as a string rather than a Date object for two reasons:
 *   1. JSON-serializable by construction — no `.toISOString()` traps at boundaries.
 *   2. Deterministic ordering by lexicographic sort, which matches temporal order
 *      for well-formed ISO 8601 UTC strings. Anything that orders records by
 *      timestamp (e.g. run replay) relies on this.
 */
export type Timestamp = Brand<string, 'Timestamp'>;

/**
 * A duration expressed in milliseconds.
 *
 * Branded to distinguish from arbitrary numbers at call sites like
 * `wait(500)` vs `wait(500 as DurationMs)`.
 */
export type DurationMs = Brand<number, 'DurationMs'>;

/**
 * A duration expressed as an ISO 8601 duration string.
 *
 * Example: 'PT30S' (30 seconds), 'PT2H' (2 hours), 'P1D' (1 day).
 *
 * Preferred over `DurationMs` in declarative artifacts (task flows, retention
 * policies) because it's human-readable and unambiguous across serialization.
 */
export type IsoDuration = Brand<string, 'IsoDuration'>;

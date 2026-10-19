// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The reserved item every correction is recorded under.
 *
 * A correction judges a run's decisions as a whole — the output at pointer
 * `''` — so, unlike an ordinary judgment, it isn't tied to one item of the
 * output. It is recorded under this one reserved, Kindgi-owned key, which no
 * caller is expected to hold as an item id. The key is reserved: a judgment on
 * it is accepted only when it carries a correction at pointer `''`; any other
 * judgment there, at any pointer, is a 400, and a correction on any other key
 * is a 400. Pinning every correction to this one item makes "one correction
 * per run per expert" fall out of the existing per-item uniqueness: a second
 * correction by the same expert on the same run lands here and replaces the
 * first, so it counts once. The CLI and the console record it here.
 */
export const CORRECTION_ITEM = {
  /** The reserved, Kindgi-owned item key a correction is recorded under. */
  key: 'kindgi:correction',
  /** A JSON Pointer to the whole output. */
  pointer: '',
} as const;

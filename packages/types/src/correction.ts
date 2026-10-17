// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The fixed item every correction is recorded under.
 *
 * A correction judges a run's decisions as a whole — the output at pointer
 * `''` — so, unlike an ordinary judgment, it isn't tied to one item of the
 * output. Pinning it to a single item key makes "one correction per run per
 * expert" fall out of the existing per-item uniqueness: a second correction by
 * the same expert on the same run lands on this same item and replaces the
 * first, so it counts once. The API answers 400 to a correction on any other
 * item; the CLI and the console record it here.
 */
export const CORRECTION_ITEM = {
  /** The judged item's stable key. */
  key: 'decision',
  /** A JSON Pointer to the whole output. */
  pointer: '',
} as const;

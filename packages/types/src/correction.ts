// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The reserved item every correction with expected decisions is recorded under.
 *
 * Expected decisions cover a run's decisions as a whole — the output at
 * pointer `''` — so, unlike an ordinary correction, they aren't tied to one
 * item of the output. They are recorded under this one reserved, Kindgi-owned
 * key, which no caller is expected to hold as an item id. The key is reserved:
 * a correction on it is accepted only when it carries expected decisions at
 * pointer `''`; any other correction there, at any pointer, is a 400, and
 * expected decisions on any other key are a 400. Pinning all expected
 * decisions to this one item makes "one per run per expert" fall out of the
 * existing per-item uniqueness: a second one by the same expert on the same
 * run lands here and replaces the first, so it counts once. The CLI and the
 * console record them here.
 */
export const CORRECTION_ITEM = {
  /** The reserved, Kindgi-owned item key expected decisions are recorded under. */
  key: 'kindgi:correction',
  /** A JSON Pointer to the whole output. */
  pointer: '',
} as const;

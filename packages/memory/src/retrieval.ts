// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Fact } from './types.js';

/** Result of a retrieval search — fact plus a numeric score. */
export interface RetrievalHit<TContent = unknown> {
  readonly fact: Fact<TContent>;
  /**
   * Score interpretation depends on the search kind. Keyword scores are
   * full-text ranks, such as Postgres `ts_rank_cd` (unbounded positive;
   * higher = better). Semantic uses cosine similarity in [-1, 1]
   * (higher = better).
   */
  readonly score: number;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The `k` of reciprocal rank fusion: how much the top ranks dominate (60 is the usual choice). */
export const RRF_K = 60;

/** One fused item: its score and its 1-based rank in each leg that found it. */
export interface Fused<T> {
  readonly item: T;
  /** `Σ 1 / (k + rank)` over the legs that found it. */
  readonly score: number;
  /** Its rank in each leg, by the leg's name; absent where that leg didn't find it. */
  readonly ranks: Readonly<Record<string, number>>;
}

/**
 * Reciprocal rank fusion of ranked result lists ("legs", each best
 * first): every item scores `Σ 1 / (k + rank)` over the legs that found
 * it, so agreement between legs wins and raw scores (a full-text rank, a
 * cosine similarity) never need to be compared. Ties keep the order of
 * the first leg that found them. Items are matched across legs by `key`;
 * the first leg's copy of an item is kept.
 */
export function fuseByRank<T>(
  legs: Readonly<Record<string, readonly T[]>>,
  key: (item: T) => string,
  k: number = RRF_K,
): readonly Fused<T>[] {
  const fused = new Map<
    string,
    { item: T; score: number; ranks: Record<string, number>; first: number }
  >();
  let seen = 0;
  for (const [leg, items] of Object.entries(legs)) {
    items.forEach((item, i) => {
      const id = key(item);
      const rank = i + 1;
      const entry = fused.get(id);
      if (entry === undefined) {
        fused.set(id, { item, score: 1 / (k + rank), ranks: { [leg]: rank }, first: seen++ });
      } else if (entry.ranks[leg] === undefined) {
        entry.score += 1 / (k + rank);
        entry.ranks[leg] = rank;
      }
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .map(({ item, score, ranks }) => ({ item, score, ranks }));
}

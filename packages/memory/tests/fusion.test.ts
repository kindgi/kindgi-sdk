// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { RRF_K, fuseByRank } from '../src/index.js';

const id = (s: string) => s;

describe('fuseByRank', () => {
  test('an item both legs found outranks items one leg ranked higher', () => {
    const fused = fuseByRank({ keyword: ['a', 'b', 'c'], semantic: ['d', 'c', 'a'] }, id);
    expect(fused.map((f) => f.item)).toEqual(['a', 'c', 'd', 'b']);
    expect(fused[0]).toEqual({
      item: 'a',
      score: 1 / (RRF_K + 1) + 1 / (RRF_K + 3),
      ranks: { keyword: 1, semantic: 3 },
    });
    expect(fused.find((f) => f.item === 'b')?.ranks).toEqual({ keyword: 2 });
  });

  test('ties keep the order the legs found them in', () => {
    const fused = fuseByRank({ keyword: ['a', 'b'], semantic: ['c', 'd'] }, id);
    expect(fused.map((f) => f.item)).toEqual(['a', 'c', 'b', 'd']);
  });

  test('one leg, or none, is that leg in order', () => {
    expect(fuseByRank({ keyword: ['x', 'y'] }, id).map((f) => f.item)).toEqual(['x', 'y']);
    expect(fuseByRank({}, id)).toEqual([]);
  });

  test('a duplicate inside one leg counts once, at its best rank', () => {
    const fused = fuseByRank({ keyword: ['a', 'a', 'b'] }, id);
    expect(fused.map((f) => [f.item, f.ranks.keyword])).toEqual([
      ['a', 1],
      ['b', 3],
    ]);
  });
});

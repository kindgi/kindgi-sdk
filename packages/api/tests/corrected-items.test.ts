// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  itemChanges,
  matchCorrected,
  outputItems,
  scoreItems,
  valueAt,
} from '../src/corrected-items.js';

/** An agent turn's output: a tool-call message, then the answer, and a typed result. */
const turn = (answer: string, matches: unknown[]) => ({
  appended: [
    { role: 'user', content: 'find acme' },
    { role: 'agent', content: { text: '', toolCalls: [{ id: 'c1' }] } },
    { role: 'tool', content: { found: 3 } },
    { role: 'agent', content: answer },
  ],
  output: { matches },
});

describe('outputItems', () => {
  test("an agent turn's answer (its last agent message that isn't a tool call) and its listed results", () => {
    const items = outputItems(turn('Found 2.', [{ id: 'm1' }, { id: 'm2' }]), true);
    expect(items.map((i) => [i.key, i.pointer, i.rank, i.ownKey])).toEqual([
      ['answer', '/appended/3/content', undefined, false],
      ['m1', '/output/matches/0', 0, true],
      ['m2', '/output/matches/1', 1, true],
    ]);
  });

  test('an element without an id, or with a repeated one, is keyed by its place', () => {
    const items = outputItems(turn('x', [{ id: 'm1' }, { id: 'm1' }, { title: 'no id' }]), true);
    expect(items.slice(1).map((i) => [i.key, i.ownKey])).toEqual([
      ['m1', true],
      ['/output/matches/1', false],
      ['/output/matches/2', false],
    ]);
  });

  test("a flow run's whole output, then its lists", () => {
    expect(outputItems({ results: [{ key: 'r1' }] }, false).map((i) => i.key)).toEqual([
      'output',
      'r1',
    ]);
    expect(outputItems(null, false)).toEqual([]);
  });
});

test('valueAt follows a JSON Pointer, escapes included', () => {
  const doc = { 'a/b': [{ 'c~d': 1 }] };
  expect(valueAt(doc, '/a~1b/0/c~0d')).toBe(1);
  expect(valueAt(doc, '')).toBe(doc);
  expect(valueAt(doc, '/missing/0')).toBeUndefined();
  expect(valueAt(doc, 'no-slash')).toBeUndefined();
});

describe('matchCorrected: a correction carries over to the same item', () => {
  const before = turn('Found 2.', [{ id: 'm1', score: 0.9 }, { id: 'm2' }, { title: 'n' }]);
  const corrected = [
    { key: 'answer', pointer: '/appended/3/content', yesWeight: 1, totalWeight: 1 },
    { key: 'm1', pointer: '/output/matches/0', rank: 0, yesWeight: 2, totalWeight: 2 },
    {
      key: '/output/matches/2',
      pointer: '/output/matches/2',
      rank: 2,
      yesWeight: 0,
      totalWeight: 1,
    },
  ];

  test('by its own id, whatever else changed about it', () => {
    const after = turn('Found 2.', [{ id: 'm2' }, { id: 'm1', score: 0.1 }]);
    const m = matchCorrected(outputItems(after, true), corrected, before);
    expect(m.find((x) => x.item.key === 'm1')?.corrected?.key).toBe('m1');
  });

  test('the answer only when it says the same; a changed answer is a new item', () => {
    const same = matchCorrected(outputItems(turn('Found 2.', []), true), corrected, before);
    expect(same[0]?.corrected?.key).toBe('answer');
    const changed = matchCorrected(outputItems(turn('Found two.', []), true), corrected, before);
    expect(changed[0]?.corrected).toBeUndefined();
  });

  test('an element keyed by its place only when its content is the same', () => {
    const moved = turn('x', [{ id: 'm1' }, { id: 'm2' }, { title: 'other' }]);
    expect(
      matchCorrected(outputItems(moved, true), corrected, before)[3]?.corrected,
    ).toBeUndefined();
    const kept = turn('x', [{ id: 'm1' }, { id: 'm2' }, { title: 'n' }]);
    expect(matchCorrected(outputItems(kept, true), corrected, before)[3]?.corrected?.key).toBe(
      '/output/matches/2',
    );
  });

  test('content compares canonically (key order does not matter)', () => {
    const b = turn('x', [{ a: 1, b: 2 }]);
    const j = [
      { key: '/output/matches/0', pointer: '/output/matches/0', yesWeight: 1, totalWeight: 1 },
    ];
    const a = turn('x', [{ b: 2, a: 1 }]);
    expect(matchCorrected(outputItems(a, true), j, b)[1]?.corrected).toBeDefined();
  });
});

describe('scoreItems and itemChanges', () => {
  const corrected = [
    { key: 'm1', rank: 0, yesWeight: 2, totalWeight: 2 },
    { key: 'm2', rank: 1, yesWeight: 0, totalWeight: 1.5 },
    { key: 'm3', rank: 2, yesWeight: 1, totalWeight: 1 },
  ];
  const after = turn('new answer', [{ id: 'm2' }, { id: 'new' }, { id: 'm1' }]);
  const matched = matchCorrected(outputItems(after, true), corrected, {});

  test('sums the corrected items, and the corrected ones among the first k ranked', () => {
    const score = scoreItems(matched, 2);
    expect(score).toEqual({
      yesWeight: 2,
      totalWeight: 3.5,
      items: 4,
      correctedItems: 2,
      // Ranks 0 and 1: m2 (corrected) and `new` (not corrected, skipped).
      topK: { yesWeight: 0, totalWeight: 1.5 },
    });
    expect(scoreItems(matched, 10).topK).toEqual({ yesWeight: 2, totalWeight: 3.5 });
  });

  test('kept with their ranks before and now, dropped, and new ones', () => {
    expect(itemChanges(matched, corrected)).toEqual({
      kept: [
        { key: 'm2', rankBefore: 1, rank: 0 },
        { key: 'm1', rankBefore: 0, rank: 2 },
      ],
      dropped: [{ key: 'm3', rankBefore: 2 }],
      new: [
        { key: 'answer', pointer: '/appended/3/content' },
        { key: 'new', pointer: '/output/matches/1', rank: 1 },
      ],
    });
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { includeListOf } from '../src/routes/include-list.js';

const KNOWN = ['output', 'waitingFor'] as const;

describe('includeListOf', () => {
  test('reads one value, the comma form and repeated keys alike', () => {
    for (const raw of [
      ['output,waitingFor'],
      ['output', 'waitingFor'],
      [' output , waitingFor '],
    ]) {
      const read = includeListOf(raw, KNOWN);
      expect(read.kind === 'ok' && [...read.value], JSON.stringify(raw)).toEqual([
        'output',
        'waitingFor',
      ]);
    }
    const one = includeListOf(['output'], KNOWN);
    expect(one.kind === 'ok' && [...one.value]).toEqual(['output']);
  });

  test('nothing given, an empty value and empty items add nothing', () => {
    for (const raw of [undefined, [], [''], [',', ' ']]) {
      const read = includeListOf(raw, KNOWN);
      expect(read.kind === 'ok' && read.value.size, JSON.stringify(raw)).toBe(0);
    }
  });

  test('refuses what the list does not know, naming it and what it takes', () => {
    expect(includeListOf(['output,keys', 'notes'], KNOWN)).toEqual({
      kind: 'err',
      message:
        'Unknown `include` value(s): keys, notes. Expected one or more of: output, waitingFor',
    });
  });

  test("the refusal starts with the words a client matches to tell an older runtime's", () => {
    const refused = includeListOf(['waitingFor'], ['output']);
    expect(refused.kind === 'err' && refused.message.startsWith('Unknown `include` value(s)')).toBe(
      true,
    );
  });
});

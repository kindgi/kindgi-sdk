// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { satisfiesSpecifiers } from '../src/build/version-specifier.js';

describe('satisfiesSpecifiers', () => {
  test.each([
    ['0.12.15', '>=0.12.15,<0.13', true],
    ['0.13.0', '>=0.12.15,<0.13', false],
    ['0.12.14', '>=0.12.15,<0.13', false],
    ['0.12.15', '==0.12.15', true],
    ['0.12.15', '==0.12.*', true],
    ['0.13.1', '==0.12.*', false],
    ['0.12.15', '!=0.12.*', false],
    ['0.12.15', '~=0.12.0', true],
    ['0.13.0', '~=0.12.0', false],
    ['0.12.15', '>0.12', true],
    ['0.12.15', '<=0.12.15', true],
    ['0.12.15', ' >= 0.10 , < 1 ', true],
  ] as const)('%s in "%s" → %s', (version, specifiers, expected) => {
    expect(satisfiesSpecifiers(version, specifiers)).toBe(expected);
  });

  test("what it doesn't read is undefined, not a refusal", () => {
    expect(satisfiesSpecifiers('0.12.15', '>=0.12.0a1')).toBeUndefined();
    expect(satisfiesSpecifiers('0.12.15', '')).toBeUndefined();
    expect(satisfiesSpecifiers('0.12.15', '~=1')).toBeUndefined();
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { UUID_RE } from '../src/index.js';

const V4 = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('UUID_RE', () => {
  test.each([
    ['a version 4 id', V4],
    ['a version 1 id', 'c232ab00-9414-11ec-b3c8-9f6bdeced846'],
    ['a version 7 id', '01890a5d-ac96-774b-bcce-b302099a8057'],
    ['the nil id', '00000000-0000-0000-0000-000000000000'],
    ['upper case', V4.toUpperCase()],
    ['mixed case', '0F8FAD5B-d9cb-469f-A165-70867728950e'],
  ])('takes %s', (_, id) => {
    expect(UUID_RE.test(id)).toBe(true);
  });

  test.each([
    ['an empty string', ''],
    ['braces', `{${V4}}`],
    ['no hyphens', V4.replaceAll('-', '')],
    ['31 hex digits', V4.slice(0, -1)],
    ['33 hex digits', `${V4}0`],
    ['a hyphen out of place', '0f8fad5bd-9cb-469f-a165-70867728950e'],
    ['a letter past f', V4.replace('d9cb', 'd9cg')],
    ['a space before', ` ${V4}`],
    ['a space after', `${V4} `],
    ['a newline after', `${V4}\n`],
    ['a urn prefix', `urn:uuid:${V4}`],
  ])('refuses %s', (_, text) => {
    expect(UUID_RE.test(text)).toBe(false);
  });

  test('keeps no state between calls: no g or y flag', () => {
    expect(UUID_RE.flags).toBe('i');
    expect([UUID_RE.test(V4), UUID_RE.test(V4)]).toEqual([true, true]);
  });
});

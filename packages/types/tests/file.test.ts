// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { isFileValue } from '../src/index.js';

/** sha256 of the four bytes `test`. */
const SHA256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

describe('isFileValue', () => {
  const value = {
    type: 'kindgi.file',
    artifactId: 'photo',
    name: 'photo.jpg',
    contentType: 'image/jpeg',
    size: 4,
    sha256: SHA256,
  };

  test("a file value's shape, with or without its optional fields", () => {
    expect(isFileValue(value)).toBe(true);
    expect(isFileValue({ ...value, name: undefined, pages: 3, notShown: 'gone' })).toBe(true);
  });

  test.each([
    ['another type', { type: 'file' }],
    ['an empty artifactId', { artifactId: '' }],
    ['a size that is not whole', { size: 1.5 }],
    ['a negative size', { size: -1 }],
    ['an uppercase sha256', { sha256: SHA256.toUpperCase() }],
    ['a short sha256', { sha256: 'abc' }],
    ['a name that is not text', { name: 7 }],
    ['no pages', { pages: 0 }],
    ['pages as text', { pages: '3' }],
    ['an unknown reason', { notShown: 'hidden' }],
  ])('not with %s', (_, change) => {
    expect(isFileValue({ ...value, ...change })).toBe(false);
  });

  test('not a value that is not an object', () => {
    expect(isFileValue(null)).toBe(false);
    expect(isFileValue('photo')).toBe(false);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  SLUG,
  SLUG_MAX,
  TENANT_SLUG,
  TENANT_SLUG_MAX,
  isSlug,
  isTenantSlug,
  slugOf,
} from '../src/index.js';

const longest = `a${'b'.repeat(SLUG_MAX - 1)}`;

describe('SLUG: an org, project or team slug', () => {
  test.each(['a', '0', 'a-b', 'a--b', 'a-', 'shop-eu-2', longest])('takes %j', (slug) => {
    expect(isSlug(slug)).toBe(true);
    expect(SLUG.test(slug)).toBe(true);
  });

  test.each(['', 'Foo', 'a b', 'a/b', 'a_b', '-a', 'caf\u00e9', `${longest}c`])(
    'refuses %j',
    (slug) => {
      expect(isSlug(slug)).toBe(false);
    },
  );

  test('a value that is not a string is not a slug', () => {
    expect(isSlug(5)).toBe(false);
    expect(isSlug(undefined)).toBe(false);
  });
});

describe('TENANT_SLUG: a workspace slug', () => {
  test.each(['a', 'a-b', 'shop-eu-2', `a${'b'.repeat(TENANT_SLUG_MAX - 1)}`])(
    'takes %j',
    (slug) => {
      expect(isTenantSlug(slug)).toBe(true);
      expect(TENANT_SLUG.test(slug)).toBe(true);
    },
  );

  test.each(['', 'a-', 'a--b', '-a', 'Foo', `a${'b'.repeat(TENANT_SLUG_MAX)}`])(
    'refuses %j',
    (slug) => {
      expect(isTenantSlug(slug)).toBe(false);
    },
  );
});

describe('slugOf', () => {
  test('makes a slug each rule takes', () => {
    for (const name of ['Shop EU', 'Caf\u00e9 & Bar', '  --Mixed__Case--  ', 'x'.repeat(100)]) {
      const slug = slugOf(name);
      expect(isSlug(slug)).toBe(true);
      expect(isTenantSlug(slug)).toBe(true);
    }
  });

  test('keeps the letter of an accent, and gives nothing for a name with no letter or digit', () => {
    expect(slugOf('Caf\u00e9')).toBe('cafe');
    expect(slugOf('***')).toBe('');
  });
});

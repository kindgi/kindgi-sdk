// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { ambiguousRefusal, renamedRefusal, resolveAgainst } from '../src/project-ref.js';

const ID = '3f4a5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c';
const SHOP = { id: 'p-shop', name: 'Shop', slug: 'shop', orgId: 'org-a', formerSlugs: ['store'] };
const BLOG = { id: 'p-blog', name: 'Blog', slug: 'blog', orgId: 'org-b', formerSlugs: [] };

describe('resolveAgainst', () => {
  test('an id goes as it is, listed or not', () => {
    expect(resolveAgainst([], ID)).toEqual({ kind: 'ok', id: ID });
  });

  test("a project's slug names it; a slug none has, or had, names none", () => {
    expect(resolveAgainst([SHOP, BLOG], 'shop')).toEqual({ kind: 'ok', id: 'p-shop' });
    expect(resolveAgainst([SHOP, BLOG], 'news')).toEqual({ kind: 'none' });
  });

  test('a slug only a renamed project had is renamed, never the project', () => {
    expect(resolveAgainst([SHOP, BLOG], 'store')).toEqual({ kind: 'renamed', project: SHOP });
  });

  test('a project that took its old slug back is named by it, and the one it left is renamed', () => {
    const back = { ...SHOP, slug: 'store', formerSlugs: ['shop'] };
    expect(resolveAgainst([back], 'store')).toEqual({ kind: 'ok', id: 'p-shop' });
    expect(resolveAgainst([back], 'shop')).toEqual({ kind: 'renamed', project: back });
  });

  test('a slug one project has and another had is ambiguous, and so is one two had', () => {
    const shopEu = {
      id: 'p-shop-eu',
      name: 'Shop EU',
      slug: 'store',
      orgId: 'org-eu',
      formerSlugs: [],
    };
    expect(resolveAgainst([SHOP, shopEu], 'store')).toEqual({
      kind: 'ambiguous',
      matches: [shopEu],
      renamed: [SHOP],
    });
    const blogWas = { ...BLOG, formerSlugs: ['store'] };
    expect(resolveAgainst([SHOP, blogWas], 'store')).toEqual({
      kind: 'ambiguous',
      matches: [],
      renamed: [SHOP, blogWas],
    });
  });

  test('a runtime that keeps no old slugs: rows without formerSlugs resolve as before', () => {
    const plain = { id: 'p-shop', name: 'Shop', slug: 'shop', orgId: 'org-a' };
    expect(resolveAgainst([plain], 'shop')).toEqual({ kind: 'ok', id: 'p-shop' });
    expect(resolveAgainst([plain], 'store')).toEqual({ kind: 'none' });
  });
});

describe('the refusals', () => {
  test('renamed: the project, its new slug, and where to change it', () => {
    expect(renamedRefusal('store', SHOP, '--project')).toBe(
      '"store" was the slug of project p-shop (Shop, org org-a) until it was renamed to "shop". Change --project to "shop" or to the project\'s id.',
    );
  });

  test('ambiguous: the projects that have it, then those that had it', () => {
    const shopEu = { id: 'p-shop-eu', name: 'Shop EU', slug: 'store', orgId: 'org-eu' };
    expect(ambiguousRefusal('store', [shopEu], [SHOP])).toBe(
      '"store" is the slug of project p-shop-eu (Shop EU, org org-eu) and was the slug of project p-shop (Shop, org org-a) until it was renamed to "shop". Pass the project id instead.',
    );
    expect(ambiguousRefusal('store', [], [SHOP, BLOG])).toBe(
      '"store" was the slug of project p-shop (Shop, org org-a) until it was renamed to "shop", and of project p-blog (Blog, org org-b) until it was renamed to "blog". Pass the project id instead.',
    );
  });
});

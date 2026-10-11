// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { docsUrl } from '../src/index.js';

const PAGE = 'guides/sso/oidc/';

describe("docsUrl: a docs page on a version's release line", () => {
  test.each([
    ['0.1.5', 'https://docs.kindgi.com/v0.1/guides/sso/oidc/'],
    ['0.1.6-rc.1', 'https://docs.kindgi.com/v0.1/guides/sso/oidc/'],
    ['0.1.5.1', 'https://docs.kindgi.com/v0.1/guides/sso/oidc/'],
    ['0.2.0', 'https://docs.kindgi.com/v0.2/guides/sso/oidc/'],
    ['1.12.3', 'https://docs.kindgi.com/v1.12/guides/sso/oidc/'],
  ])('%s: %s', (version, url) => {
    expect(docsUrl(PAGE, version)).toBe(url);
  });

  test('a leading slash names the same page', () => {
    expect(docsUrl(`/${PAGE}`, '0.1.5')).toBe(docsUrl(PAGE, '0.1.5'));
  });

  test("no version, or one that isn't (a broken install's), links the root", () => {
    expect(docsUrl(PAGE)).toBe('https://docs.kindgi.com/guides/sso/oidc/');
    expect(docsUrl(PAGE, 'unknown')).toBe('https://docs.kindgi.com/guides/sso/oidc/');
  });
});

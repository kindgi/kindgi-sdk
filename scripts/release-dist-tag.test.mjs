// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/release-dist-tag.mjs`: a release candidate publishes under
 * `next`, never `latest`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { distTagFor } from './release-dist-tag.mjs';

describe('distTagFor', () => {
  test('a release publishes under latest', () => {
    assert.equal(distTagFor('0.1.4'), 'latest');
    assert.equal(distTagFor('1.0.0'), 'latest');
  });

  test('a pre-release publishes under next', () => {
    assert.equal(distTagFor('0.1.4-rc.0'), 'next');
    assert.equal(distTagFor('0.2.0-rc.12'), 'next');
    assert.equal(distTagFor('1.0.0-beta.1'), 'next');
    assert.equal(distTagFor('1.0.0-alpha.0'), 'next');
  });

  test('a version the Python release can not spell is refused', () => {
    assert.throws(() => distTagFor('0.1.4-preview.1'), /no PEP 440 spelling/);
    assert.throws(() => distTagFor('0.1.4-rc'), /no PEP 440 spelling/);
  });
});

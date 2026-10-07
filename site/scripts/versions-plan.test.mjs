// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan } from './versions-plan.mjs';

const tag = (v) => `@kindgi/sdk@${v}`;
const tags = (...versions) => versions.map(tag);
const summary = (p) => ({
  lines: p.lines.map((l) => l.tag),
  next: p.next?.tag,
});

test('releases only: each line from its newest release, newest line first', () => {
  assert.deepEqual(summary(plan(tags('0.1.0', '0.1.2', '0.1.1', '0.2.0'))), {
    lines: [tag('0.2.0'), tag('0.1.2')],
    next: undefined,
  });
});

test('a release candidate never builds a line, and is next while newer than every release', () => {
  assert.deepEqual(summary(plan(tags('0.1.2', '0.1.3', '0.1.4-rc.0'))), {
    lines: [tag('0.1.3')],
    next: tag('0.1.4-rc.0'),
  });
});

test('next is the newest pre-release, numerically (rc.10 after rc.9)', () => {
  assert.deepEqual(summary(plan(tags('0.1.3', '0.1.4-rc.9', '0.1.4-rc.10', '0.1.4-rc.2'))), {
    lines: [tag('0.1.3')],
    next: tag('0.1.4-rc.10'),
  });
});

test('once the release ships, its release candidates are older: no next', () => {
  assert.deepEqual(summary(plan(tags('0.1.3', '0.1.4-rc.0', '0.1.4-rc.1', '0.1.4'))), {
    lines: [tag('0.1.4')],
    next: undefined,
  });
});

test('the next release cycle gets its own next', () => {
  assert.deepEqual(summary(plan(tags('0.1.4-rc.1', '0.1.4', '0.1.5-rc.0'))), {
    lines: [tag('0.1.4')],
    next: tag('0.1.5-rc.0'),
  });
});

test('a new minor line in release candidates is next, not a line', () => {
  assert.deepEqual(summary(plan(tags('0.1.4', '0.2.0-rc.0'))), {
    lines: [tag('0.1.4')],
    next: tag('0.2.0-rc.0'),
  });
});

test('tags that are not versions are ignored', () => {
  assert.deepEqual(summary(plan([...tags('0.1.3'), '@kindgi/sdk@latest', '@kindgi/sdk@0.1'])), {
    lines: [tag('0.1.3')],
    next: undefined,
  });
});

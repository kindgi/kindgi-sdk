// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menu, plan, redirects } from './versions-plan.mjs';

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

test('every release is listed, newest first; lines keep their newest release', () => {
  const p = plan(tags('0.1.0', '0.1.2', '0.1.1', '0.2.0', '0.2.1-rc.0'));
  assert.deepEqual(
    p.releases.map((r) => r.tag),
    tags('0.2.0', '0.1.2', '0.1.1', '0.1.0'),
  );
  assert.deepEqual(
    p.lines.map((l) => l.tag),
    tags('0.2.0', '0.1.2'),
  );
});

test('versions.json: the root, each release under its own path, and next', () => {
  assert.deepEqual(menu(plan(tags('0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4-rc.3'))), {
    latest: '0.1.3',
    versions: [
      { version: '0.1.3', line: '0.1', path: '/' },
      { version: '0.1.3', line: '0.1', path: '/v0.1.3/' },
      { version: '0.1.2', line: '0.1', path: '/v0.1.2/' },
      { version: '0.1.1', line: '0.1', path: '/v0.1.1/' },
      { version: '0.1.0', line: '0.1', path: '/v0.1.0/' },
      { version: '0.1.4-rc.3', line: '0.1', path: '/next/', next: true },
    ],
  });
});

test('versions.json: no next once its release ships', () => {
  const { latest, versions } = menu(plan(tags('0.1.3', '0.1.4-rc.3', '0.1.4')));
  assert.equal(latest, '0.1.4');
  assert.deepEqual(
    versions.map((v) => v.path),
    ['/', '/v0.1.4/', '/v0.1.3/'],
  );
});

test('_redirects: each line path goes to its newest release, page for page', () => {
  assert.equal(
    redirects(plan(tags('0.1.2', '0.1.3', '0.2.0'))),
    '/v0.2 /v0.2.0/ 301\n/v0.2/* /v0.2.0/:splat 301\n/v0.1 /v0.1.3/ 301\n/v0.1/* /v0.1.3/:splat 301\n',
  );
});

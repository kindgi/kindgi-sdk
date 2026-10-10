// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TUTORIALS,
  missingImports,
  pinOf,
  pinnedTutorials,
  slugOf,
  tutorialRedirects,
} from './tutorials-overlay.mjs';
import { parse, plan } from './versions-plan.mjs';

const page = (frontmatter, body = 'Steps.') => `---\n${frontmatter}\n---\n\n${body}\n`;
const pinned = (version) => page(`title: A tutorial\ntested: ${version}`);
const unpinned = page('title: Build a support desk');
const root = parse('0.1.6');

test('the pin: a release version in the frontmatter, quoted or not', () => {
  assert.equal(pinOf(pinned('0.1.6'), 'a.md').version, '0.1.6');
  assert.equal(pinOf(pinned('"0.1.6"'), 'a.md').version, '0.1.6');
  assert.equal(pinOf(pinned("'0.1.6'"), 'a.md').version, '0.1.6');
});

test('no pin: no frontmatter, or none named tested', () => {
  assert.equal(pinOf(unpinned, 'a.md'), undefined);
  assert.equal(pinOf('No frontmatter.\n\ntested: 0.1.6\n', 'a.md'), undefined);
});

test('a pin that is not a release stops the build, naming the page', () => {
  assert.throws(
    () => pinOf(pinned('0.1.6-rc.0'), 'site/x.md'),
    /site\/x\.md: "tested: 0\.1\.6-rc\.0" isn't a Kindgi release/,
  );
  assert.throws(() => pinOf(pinned('latest'), 'site/x.md'), /isn't a Kindgi release/);
  assert.throws(() => pinOf(pinned('0.1.5.1'), 'site/x.md'), /isn't a Kindgi release/);
});

test('slugs: a page, a folder index, the section index', () => {
  assert.equal(slugOf('add-kindgi.md'), 'add-kindgi');
  assert.equal(slugOf('woo/index.mdx'), 'woo');
  assert.equal(slugOf('index.md'), '');
});

test('a tutorial pinned at or below the newest release is taken from main', () => {
  const overlay = pinnedTutorials(
    [
      { path: 'add-kindgi.md', source: pinned('0.1.6') },
      { path: 'older.md', source: pinned('0.1.5') },
    ],
    root,
  );
  assert.deepEqual(overlay.take, ['add-kindgi.md', 'older.md']);
  assert.deepEqual(overlay.pages, ['add-kindgi', 'older']);
  assert.deepEqual(overlay.later, []);
});

test('control: an unpinned tutorial on main never reaches /', () => {
  const overlay = pinnedTutorials(
    [
      { path: 'support-desk-typescript.md', source: unpinned },
      { path: 'support-desk-python.md', source: unpinned },
      { path: 'index.md', source: page('title: Tutorials') },
    ],
    root,
  );
  assert.deepEqual(overlay, { take: [], pages: [], later: [] });
});

test('a tutorial pinned to a newer release waits for it', () => {
  const overlay = pinnedTutorials([{ path: 'woo.md', source: pinned('0.1.7') }], root);
  assert.deepEqual(overlay.take, []);
  assert.deepEqual(overlay.pages, []);
  assert.deepEqual(overlay.later, [{ path: 'woo.md', pin: '0.1.7' }]);
});

test('a pinned folder brings its pictures; an unpinned folder brings nothing', () => {
  const overlay = pinnedTutorials(
    [
      { path: 'woo/index.mdx', source: pinned('0.1.6') },
      { path: 'woo/refund.png' },
      { path: 'drupal/index.mdx', source: unpinned },
      { path: 'drupal/review.png' },
    ],
    root,
  );
  assert.deepEqual(overlay.take, ['woo/index.mdx', 'woo/refund.png']);
  assert.deepEqual(overlay.pages, ['woo']);
});

test("a pinned page needs its imports in the newest release's site", () => {
  const file = `${TUTORIALS}woo/index.mdx`;
  const source = [
    pinned('0.1.6'),
    "import { Tabs, TabItem } from '@astrojs/starlight/components';",
    "import Shot from '../../../../components/Shot.astro';",
    "import Card from '~/components/Card.astro';",
    "import New from '@acme/new-widget/Widget.astro';",
  ].join('\n');
  const has = new Set(['site/node_modules/@astrojs/starlight', 'site/src/components/Card.astro']);
  assert.deepEqual(
    missingImports(source, file, (p) => has.has(p)),
    ['../../../../components/Shot.astro', '@acme/new-widget/Widget.astro'],
  );
  has.add('site/src/components/Shot.astro');
  has.add('site/node_modules/@acme/new-widget');
  assert.deepEqual(
    missingImports(source, file, (p) => has.has(p)),
    [],
  );
});

test('a plain markdown page imports nothing', () => {
  assert.deepEqual(
    missingImports("import X from './x';", `${TUTORIALS}a.md`, () => false),
    [],
  );
});

test("_redirects: every release's and next's copy of a pinned page goes to /tutorials/", () => {
  const tags = (...v) => v.map((x) => `@kindgi/sdk@${x}`);
  assert.equal(
    tutorialRedirects(plan(tags('0.1.5', '0.1.6', '0.1.7-rc.0')), ['add-kindgi']),
    [
      '/v0.1.6/tutorials/add-kindgi /tutorials/add-kindgi/ 301',
      '/v0.1.6/tutorials/add-kindgi/ /tutorials/add-kindgi/ 301',
      '/v0.1.5/tutorials/add-kindgi /tutorials/add-kindgi/ 301',
      '/v0.1.5/tutorials/add-kindgi/ /tutorials/add-kindgi/ 301',
      '/next/tutorials/add-kindgi /tutorials/add-kindgi/ 301',
      '/next/tutorials/add-kindgi/ /tutorials/add-kindgi/ 301',
      '',
    ].join('\n'),
  );
});

test('_redirects: nothing for unpinned tutorials, and the section index only when it is pinned', () => {
  const tags = (...v) => v.map((x) => `@kindgi/sdk@${x}`);
  assert.equal(tutorialRedirects(plan(tags('0.1.6')), []), '');
  assert.equal(
    tutorialRedirects(plan(tags('0.1.6')), ['']),
    '/v0.1.6/tutorials /tutorials/ 301\n/v0.1.6/tutorials/ /tutorials/ 301\n',
  );
});

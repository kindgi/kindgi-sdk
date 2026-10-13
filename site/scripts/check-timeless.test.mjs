// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, datedPhrases, proseOf } from './check-timeless.mjs';

const phrases = (source) =>
  datedPhrases(source, '0.1.7').map(({ line, phrase }) => `${line}: ${phrase}`);

test('a version as a point in time dates a page', () => {
  assert.deepEqual(
    phrases(
      [
        'From 0.1.7, `init` sets this up.',
        'This was fixed in 0.1.1 and changed in Kindgi 0.1.4.',
        'A project made before 0.1.6 keeps its owner, since 0.1.3.',
        'The API may still change in 0.1.6.',
        'Runtime 0.1.5.1 is the same as of 0.1.5.1.',
      ].join('\n'),
    ),
    [
      '1: From 0.1.7',
      '2: fixed in 0.1.1',
      '2: changed in Kindgi 0.1.4',
      '3: before 0.1.6',
      '3: since 0.1.3',
      '4: in 0.1.6',
      '5: as of 0.1.5.1',
    ],
  );
});

test('a phrase split across two lines by the hard wrap still dates a page', () => {
  assert.deepEqual(
    phrases(
      [
        'The banner says so. From',
        '0.1.7, `init` sets this up.',
        '',
        '- A list item from',
        '- 0.1.6 is another.',
      ].join('\n'),
    ),
    ['1: From 0.1.7'],
  );
});

test('a version and everything before it dates a page, once', () => {
  assert.deepEqual(
    phrases(
      [
        ':::note[On Kindgi 0.1.6 and earlier]',
        'It fixes one security bug in 0.1.5 and earlier, and one in 0.1.4 or older.',
      ].join('\n'),
    ),
    ['1: 0.1.6 and earlier', '2: 0.1.5 and earlier', '2: 0.1.4 or older'],
  );
});

test('"On" a version dates a page too', () => {
  assert.deepEqual(
    phrases(
      'On 0.1.6 and 0.1.7, authorization also needs a restart.\nOn Kindgi 0.1.5, it differs.',
    ),
    ['1: On 0.1.6', '2: On Kindgi 0.1.5'],
  );
});

test('a four-part version is read whole', () => {
  assert.deepEqual(
    phrases(
      [
        'as in 0.1.4.1 or later',
        'It runs on 0.1.5.1 or later.',
        'A bug in 0.1.4.1 and earlier.',
      ].join('\n'),
    ),
    ['3: 0.1.4.1 and earlier'],
  );
});

test("an agent's or a dependency's version, with a later major than Kindgi's, doesn't date a page", () => {
  assert.deepEqual(
    phrases(
      [
        'A conversation started on 1.2.0. Then 1.0.0 went live for the tenant.',
        'Derived from 1.0.0, as of 2.1.0.1, with new data-block versions.',
        'The extra pins cryptography (fixed in 48.0.1); it changed in 0.1.6.',
        'Agent 1.0.0 and earlier stay readable. From 0.2.0 it differs.',
      ].join('\n'),
    ),
    ['3: changed in 0.1.6', '4: From 0.2.0'],
  );
});

test('a requirement or a range is fine', () => {
  assert.deepEqual(
    phrases(
      [
        'Approvals need Kindgi 0.1.7 or later.',
        'It works in 0.1.5 and later.',
        'Not in the Java SDK in 0.1.x: call the HTTP API.',
        'Install 0.1.7 with `pnpm add @kindgi/cli@0.1.7`.',
      ].join('\n'),
    ),
    [],
  );
});

test('time words date a page', () => {
  assert.deepEqual(
    phrases(
      'What it gives today.\nIt currently runs one instance, for now.\nA fix is planned, coming soon.',
    ),
    ['1: today', '2: currently', '2: for now', '3: A fix is planned', '3: coming soon'],
  );
});

test("code, image text, link targets and comments aren't prose", () => {
  const prose = proseOf(
    'Run `kindgi dev` today ![shown today](a.png) [the notes](../operate/#from-016-to-017) <!-- today -->',
  );
  assert.equal(prose.replace(/\s+/g, ' ').trim(), 'Run today [the notes]');
  assert.deepEqual(
    phrases(
      [
        '```text',
        'It is currently in processing, fixed in 0.1.1.',
        '```',
        'See [the 0.1.7 notes](../operate/#from-016-to-017).',
        '~~~~sh',
        'echo today',
        '~~~~',
      ].join('\n'),
    ),
    [],
  );
});

test("the title and description are checked, the rest of the front matter isn't", () => {
  assert.deepEqual(
    phrases(
      [
        '---',
        'title: What it gives today',
        'description: Fixed in 0.1.1.',
        'sidebar:',
        '  label: today',
        '---',
        'Body.',
      ].join('\n'),
    ),
    ['2: today', '3: Fixed in 0.1.1'],
  );
});

test('a version history box and a line that says why are allowed', () => {
  assert.deepEqual(
    phrases(
      [
        ':::note[Version history]',
        '- Added in 0.1.5.',
        '- Changed in 0.1.7.',
        ':::',
        'The quote says "today". <!-- timeless: a customer quote -->',
        'The reply says "currently". {/* timeless: the model\'s own words */}',
        'Changed in 0.1.7.',
      ].join('\n'),
    ),
    ['7: Changed in 0.1.7'],
  );
});

test('a page may have fewer dated phrases than its baseline, never more', () => {
  const hit = { line: 1, phrase: 'today' };
  const hits = new Map([
    ['guides/a', [hit, hit]],
    ['guides/b', [hit]],
    ['guides/new', [hit]],
  ]);
  const { over, under } = compare(hits, { 'guides/a': 1, 'guides/b': 3, 'guides/gone': 2 });
  assert.deepEqual(
    over.map(({ page, allowed, hits: list }) => [page, allowed, list.length]),
    [
      ['guides/a', 1, 2],
      ['guides/new', 0, 1],
    ],
  );
  assert.deepEqual(
    under.map(({ page, allowed, count }) => [page, allowed, count]),
    [
      ['guides/b', 3, 1],
      ['guides/gone', 2, 0],
    ],
  );
});

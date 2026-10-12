// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, shrink, tabGroups } from './check-tabs.mjs';

/** A language tab group with these tabs; a tab given as `[label, firstLine]` has that first line. */
function group(...tabs) {
  const items = tabs.map((tab) => {
    const [label, first] = Array.isArray(tab) ? tab : [tab, '```ts\nconst x = 1;\n```'];
    return `<TabItem label="${label}">\n\n${first}\n\n</TabItem>`;
  });
  return ['<Tabs syncKey="lang">', ...items, '</Tabs>'].join('\n');
}

const ALL = ['TypeScript', 'Python', 'Java', 'Scala'];
const pages = (entries) => new Map(entries.map(([page, source]) => [page, tabGroups(source)]));

test('groups are named by the heading above them, and a second under one heading gets #2', () => {
  const source = [
    group('TypeScript'),
    '## Test it',
    group('TypeScript', 'Python'),
    'Some prose.',
    group('Java'),
    '### `ctx.log` and [logs](../logs/)',
    group('Scala'),
  ].join('\n\n');
  assert.deepEqual(
    tabGroups(source).map(({ name, tabs }) => [name, tabs.map((t) => t.label)]),
    [
      ['(the page’s start)', ['TypeScript']],
      ['Test it', ['TypeScript', 'Python']],
      ['Test it #2', ['Java']],
      ['ctx.log and logs', ['Scala']],
    ],
  );
});

test('tabs and headings inside a code block are not read', () => {
  const source = [
    '## Real',
    '```mdx',
    '## Not a heading',
    '<Tabs syncKey="lang">',
    '<TabItem label="Java">',
    '</TabItem>',
    '</Tabs>',
    '```',
    group(...ALL),
  ].join('\n');
  assert.deepEqual(
    tabGroups(source).map(({ name }) => name),
    ['Real'],
  );
});

test('tabs that are not the language tabs are not checked', () => {
  const source = '<Tabs syncKey="pm">\n<TabItem label="pnpm">\n\nx\n\n</TabItem>\n</Tabs>';
  assert.deepEqual(tabGroups(source), []);
});

test('a page with every language in every group passes', () => {
  assert.deepEqual(check(pages([['guides/x', `## A\n\n${group(...ALL)}`]]), {}), []);
});

test('a new missing tab fails: a page with no baseline, or more missing than its count', () => {
  const found = pages([
    [
      'guides/x',
      `## A\n\n${group('TypeScript', 'Python')}\n\n## B\n\n${group(...ALL.slice(0, 3))}`,
    ],
  ]);
  assert.deepEqual(check(found, {}), [
    'guides/x: 1 group(s) with no Java tab, 0 allowed (line 3, "A"). Add one, with the feature, or a first line "Not in the Java SDK." and what to do instead',
    'guides/x: 2 group(s) with no Scala tab, 0 allowed (line 3, "A"; line 22, "B"). Add one, with the feature, or a first line "Not in the Scala SDK." and what to do instead',
  ]);
  // The baseline allows one group without Scala: the page has two.
  assert.deepEqual(check(found, { 'guides/x': { Java: 1, Scala: 1 } }), [
    'guides/x: 2 group(s) with no Scala tab, 1 allowed (line 3, "A"; line 22, "B"). Add one, with the feature, or a first line "Not in the Scala SDK." and what to do instead',
  ]);
});

test('missing tabs the baseline counts pass, whatever their headings are called now', () => {
  const baseline = { 'guides/x': { Java: 1, Scala: 1 } };
  const before = pages([['guides/x', `## A\n\n${group('TypeScript', 'Python')}`]]);
  const renamed = pages([
    ['guides/x', `## Send the key from your app\n\n${group('TypeScript', 'Python')}`],
  ]);
  assert.deepEqual(check(before, baseline), []);
  assert.deepEqual(check(renamed, baseline), []);
});

test('a count above what the page lacks now fails, so the baseline cannot go stale', () => {
  const found = pages([
    ['guides/x', `## A\n\n${group(...ALL)}\n\n## B\n\n${group('TypeScript', 'Python', 'Java')}`],
  ]);
  assert.deepEqual(check(found, { 'guides/x': { Java: 2, Scala: 2 } }), [
    'guides/x: tabs-baseline.json allows 2 group(s) with no Java tab, and the page has 0: lower it (--write-baseline)',
    'guides/x: tabs-baseline.json allows 2 group(s) with no Scala tab, and the page has 1: lower it (--write-baseline)',
  ]);
});

test('a baseline entry for a page that is gone fails', () => {
  assert.deepEqual(check(pages([]), { 'guides/gone': { Scala: 1 } }), [
    'guides/gone: tabs-baseline.json allows 1 group(s) with no Scala tab, and the page has 0: lower it (--write-baseline)',
  ]);
});

test('a tab that says its SDK lacks the feature counts as the tab', () => {
  const source = `## A\n\n${group(
    'TypeScript',
    'Python',
    ['Java', 'Not in the Java SDK. Call the HTTP API instead.'],
    ['Scala', 'Not in the Scala SDK. Call the HTTP API instead.'],
  )}`;
  assert.deepEqual(check(pages([['guides/x', source]]), {}), []);
});

test('a "Not in" tab naming another SDK than its own fails', () => {
  const source = `## A\n\n${group('TypeScript', 'Python', 'Java', ['Scala', 'Not in the Java SDK.'])}`;
  assert.deepEqual(check(pages([['guides/x', source]]), {}), [
    'guides/x (line 3, "A"): the Scala tab says "Not in the Java SDK"',
  ]);
});

test('a Tier 1 page needs every language, whatever the baseline says, and no "Not in" tab', () => {
  const missing = pages([
    ['guides/tools/write-a-tool', `## A\n\n${group('TypeScript', 'Python', 'Java')}`],
  ]);
  assert.deepEqual(check(missing, { 'guides/tools/write-a-tool': { Scala: 1 } }), [
    'guides/tools/write-a-tool: a Tier 1 page needs a Scala tab in every group (line 3, "A")',
  ]);
  const notIn = pages([
    [
      'guides/tools/write-a-tool',
      `## A\n\n${group('TypeScript', 'Python', 'Java', ['Scala', 'Not in the Scala SDK.'])}`,
    ],
  ]);
  assert.deepEqual(check(notIn, {}), [
    'guides/tools/write-a-tool (line 3, "A"): a Tier 1 page has the feature in every language, but its Scala tab says it\'s not in the SDK',
  ]);
});

test('--write-baseline lowers the counts to what pages lack, and raises and adds none', () => {
  const found = pages([
    ['guides/x', `## A\n\n${group('TypeScript', 'Python', 'Java')}\n\n## B\n\n${group(...ALL)}`],
    ['guides/new', `## C\n\n${group('TypeScript')}`],
  ]);
  assert.deepEqual(
    shrink({ 'guides/x': { Java: 1, Scala: 2 }, 'guides/gone': { Java: 1 } }, found),
    { 'guides/x': { Scala: 1 } },
  );
});

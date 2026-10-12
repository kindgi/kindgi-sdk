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

test('a new missing tab fails, on a page with no baseline or a group the baseline does not list', () => {
  const found = pages([
    [
      'guides/x',
      `## A\n\n${group('TypeScript', 'Python')}\n\n## B\n\n${group(...ALL.slice(0, 3))}`,
    ],
  ]);
  assert.deepEqual(check(found, {}), [
    'guides/x (line 3, "A"): no tab for Java, Scala. Add one, with the feature, or a first line "Not in the Java SDK." and what to do instead',
    'guides/x (line 22, "B"): no tab for Scala. Add one, with the feature, or a first line "Not in the Scala SDK." and what to do instead',
  ]);
  // The baseline lists A's missing Java only: Scala is still new.
  assert.deepEqual(check(found, { 'guides/x': { A: ['Java', 'Scala'], B: [] } }).length, 1);
  assert.deepEqual(check(found, { 'guides/x': { A: ['Java'], B: ['Scala'] } }), [
    'guides/x (line 3, "A"): no tab for Scala. Add one, with the feature, or a first line "Not in the Scala SDK." and what to do instead',
  ]);
});

test('missing tabs the baseline lists pass', () => {
  const found = pages([['guides/x', `## A\n\n${group('TypeScript', 'Python')}`]]);
  assert.deepEqual(check(found, { 'guides/x': { A: ['Java', 'Scala'] } }), []);
});

test('a baseline entry for a tab the page has gained fails, so the baseline cannot go stale', () => {
  const found = pages([['guides/x', `## A\n\n${group(...ALL)}`]]);
  assert.deepEqual(check(found, { 'guides/x': { A: ['Java', 'Scala'] } }), [
    'guides/x ("A"): tabs-baseline.json lists Java, Scala, which the group has now: take them off (--write-baseline)',
  ]);
});

test('a baseline entry for a group or a page that is gone fails', () => {
  const found = pages([['guides/x', `## Renamed\n\n${group(...ALL)}`]]);
  assert.deepEqual(check(found, { 'guides/x': { A: ['Java'] }, 'guides/gone': { B: ['Scala'] } }), [
    'guides/x ("A"): tabs-baseline.json lists Java, which is no longer a group: take it off (--write-baseline)',
    'guides/gone ("B"): tabs-baseline.json lists Scala, which is no longer a group: take it off (--write-baseline)',
  ]);
});

test('a tab that says its SDK lacks the feature counts as the tab', () => {
  const source = `## A\n\n${group('TypeScript', 'Python', ['Java', 'Not in the Java SDK. Call the HTTP API instead.'], ['Scala', 'Not in the Scala SDK. Call the HTTP API instead.'])}`;
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
  assert.deepEqual(check(missing, { 'guides/tools/write-a-tool': { A: ['Scala'] } }), [
    'guides/tools/write-a-tool (line 3, "A"): a Tier 1 page needs a tab for Scala',
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

test('--write-baseline takes off what pages have gained and adds nothing', () => {
  const found = pages([
    ['guides/x', `## A\n\n${group('TypeScript', 'Python', 'Java')}\n\n## B\n\n${group(...ALL)}`],
    ['guides/new', `## C\n\n${group('TypeScript')}`],
  ]);
  assert.deepEqual(
    shrink(
      { 'guides/x': { A: ['Java', 'Scala'], B: ['Scala'] }, 'guides/gone': { D: ['Java'] } },
      found,
    ),
    { 'guides/x': { A: ['Scala'] } },
  );
});

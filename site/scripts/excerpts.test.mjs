// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { excerpts, isExcerpt, metaWords, uncopied } from './excerpts.mjs';

test("a fence's bare words, not its values", () => {
  assert.deepEqual(metaWords('excerpt'), ['excerpt']);
  assert.deepEqual(metaWords('title="an excerpt of it" excerpt'), ['excerpt']);
  assert.deepEqual(metaWords('tutorial=run {1,3} /excerpt/ wrap'), ['wrap']);
  assert.deepEqual(metaWords(''), []);
});

test('an excerpt: the fence says so, or the block has `…`', () => {
  const block = { language: 'ts', meta: '', code: 'kindgi.runs.start(input);', named: false };
  assert.equal(isExcerpt(block), false);
  assert.equal(isExcerpt({ ...block, meta: 'excerpt' }), true);
  assert.equal(isExcerpt({ ...block, code: 'const run = …;' }), true);
  assert.equal(isExcerpt({ ...block, language: 'json', code: '{ "items": […] }' }), true);
  assert.equal(isExcerpt({ ...block, language: 'sh', code: 'kindgi runs list' }), false);
});

test("a whole compiled file's `…` is its own text; the fence word still counts", () => {
  const file = { language: 'ts', meta: '', code: "say('One more thing…');", named: true };
  assert.equal(isExcerpt(file), false);
  assert.equal(isExcerpt({ ...file, language: 'python' }), false);
  assert.equal(isExcerpt({ ...file, meta: 'excerpt' }), true);
  // A named block in a language that isn't compiled isn't checked whole: `…` makes it an excerpt.
  assert.equal(isExcerpt({ ...file, language: 'json' }), true);
});

test('a signature: the fence says so, whatever the block holds', () => {
  const signature = {
    language: 'python',
    meta: 'signature',
    code: 'get(agent_id: str, /) -> Agent',
    named: false,
  };
  assert.equal(uncopied(signature), 'signature');
  assert.equal(uncopied({ ...signature, code: 'start(input: …) -> Run' }), 'signature');
  assert.equal(uncopied({ ...signature, meta: '' }), undefined);
  assert.equal(uncopied({ ...signature, meta: '', code: 'start(…)' }), 'excerpt');
  // A word inside a value isn't the fence's word.
  assert.equal(uncopied({ ...signature, meta: 'title="signature"' }), undefined);
});

/** The frame the frames plugin renders: a figure with a header, the code, and the copy button. */
function frame() {
  const element = (tagName, className, children = []) => ({
    type: 'element',
    tagName,
    properties: { className },
    children,
  });
  return element(
    'figure',
    ['frame'],
    [element('figcaption', ['header']), element('pre', []), element('div', ['copy'])],
  );
}

function render({ language = 'ts', meta = '', code, title }) {
  const renderData = { blockAst: frame() };
  const codeBlock = { language, meta, code, props: title === undefined ? {} : { title } };
  excerpts().hooks.postprocessRenderedBlock({ codeBlock, renderData });
  return renderData.blockAst;
}

const classes = (node) => node.properties.className;
const childClasses = (figure) => figure.children.map((child) => classes(child)[0] ?? child.tagName);

test("an excerpt's frame: the class, no copy button, and the label at its foot", () => {
  const figure = render({ meta: 'excerpt', code: 'kindgi.runs.start(input);' });
  assert.deepEqual(classes(figure), ['frame', 'is-excerpt']);
  assert.deepEqual(childClasses(figure), ['header', 'pre', 'excerpt']);
  assert.deepEqual(figure.children.at(-1).children, [{ type: 'text', value: 'Excerpt' }]);
});

test("a signature's frame: its own class and label, no copy button", () => {
  const figure = render({
    language: 'python',
    meta: 'signature',
    code: 'get(agent_id: str) -> Agent',
  });
  assert.deepEqual(classes(figure), ['frame', 'is-signature']);
  assert.deepEqual(childClasses(figure), ['header', 'pre', 'signature']);
  assert.deepEqual(figure.children.at(-1).children, [{ type: 'text', value: 'Signature' }]);
});

test('a block offered for copying keeps its frame as it is', () => {
  const figure = render({ code: 'kindgi.runs.start(input);' });
  assert.deepEqual(classes(figure), ['frame']);
  assert.deepEqual(childClasses(figure), ['header', 'pre', 'copy']);
});

test('a whole file (its name moved into the title) keeps its copy button despite a `…` in it', () => {
  const whole = render({ code: "say('One more thing…');", title: 'scripts/close.ts' });
  assert.deepEqual(childClasses(whole), ['header', 'pre', 'copy']);
  // A title from the fence doesn't name a whole file: the `…` makes it an excerpt.
  const titled = render({ meta: 'title="close.ts"', code: 'say(…);', title: 'close.ts' });
  assert.deepEqual(childClasses(titled), ['header', 'pre', 'excerpt']);
});

test('the plugin refuses to run before the frames plugin has made the frame', () => {
  const renderData = {
    blockAst: { type: 'element', tagName: 'pre', properties: {}, children: [] },
  };
  const codeBlock = { language: 'ts', meta: 'excerpt', code: 'x', props: {} };
  assert.throws(
    () => excerpts().hooks.postprocessRenderedBlock({ codeBlock, renderData }),
    /must run after the frames plugin/,
  );
});

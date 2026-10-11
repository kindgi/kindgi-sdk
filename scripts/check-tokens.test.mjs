// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { contrast, contrastFailures, renderCss, shapeProblems } from './check-tokens.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sample = (colors, pairs = []) => ({
  prefix: 'kg',
  colors,
  values: { radius: { value: '0', use: 'Square.' } },
  contrast: { pairs },
});

test('contrast is 21:1 for black on white, 1:1 for a colour on itself, and the same both ways', () => {
  assert.equal(contrast('#000000', '#FFFFFF'), 21);
  assert.equal(contrast('#6C1A5A', '#6C1A5A'), 1);
  assert.equal(contrast('#535D6E', '#F3F4F7'), contrast('#F3F4F7', '#535D6E'));
});

test('a pair under its minimum fails, in the theme where it falls short', () => {
  const tokens = sample(
    {
      text: { light: '#1C2433', dark: '#5E6A80', use: 'Text.' },
      page: { light: '#F3F4F7', dark: '#10151F', use: 'Page.' },
    },
    [['text', 'page', 4.5]],
  );
  const failures = contrastFailures(tokens);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].theme, 'dark');
  assert.ok(failures[0].ratio < 4.5);
});

test("a colour that isn't #RRGGBB, a missing dark value and a pair naming an unknown role are each reported", () => {
  const problems = shapeProblems(
    sample(
      {
        text: { light: '#1c2433', dark: '#E6E8EE', use: 'Text.' },
        page: { light: '#F3F4F7', use: 'Page.' },
      },
      [['text', 'paper', 4.5]],
    ),
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /colors\.text\.light/);
  assert.match(problems[1], /colors\.page\.dark/);
  assert.match(problems[2], /no colour "paper"/);
});

test('the CSS sets light on :root and dark for the system setting and for an explicit choice, all prefixed', () => {
  const css = renderCss(sample({ page: { light: '#F3F4F7', dark: '#10151F', use: 'Page.' } }));
  assert.match(
    css,
    /:root \{\n {2}color-scheme: light;\n {2}\/\* Page\. \*\/\n {2}--kg-page: #f3f4f7;/,
  );
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme="light"\]\):not\(\.light\) \{/,
  );
  assert.match(
    css,
    /:root\[data-theme="dark"\],\n:root\.dark \{\n {2}color-scheme: dark;\n {2}--kg-page: #10151f;/,
  );
  assert.match(css, /--kg-radius: 0;/);
});

test("the repository's tokens pass every contrast pair, and tokens.css is what tokens.json writes", () => {
  const tokens = JSON.parse(readFileSync(join(ROOT, 'design', 'tokens.json'), 'utf8'));
  assert.deepEqual(shapeProblems(tokens), []);
  assert.deepEqual(contrastFailures(tokens), []);
  assert.equal(readFileSync(join(ROOT, 'design', 'tokens.css'), 'utf8'), renderCss(tokens));
});

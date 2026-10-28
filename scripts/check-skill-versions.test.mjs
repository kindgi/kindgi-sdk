// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/check-skill-versions.mjs`: a pull request that changes a skill's
 * folder bumps the version in its `SKILL.md`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { skillOf, skillVersion, unbumped, withoutDocsLine } from './check-skill-versions.mjs';

/** A file's name, built so check-refs doesn't read it as a document reference. */
const md = (name) => `${name}.md`;
const DIR = 'packages/sdk/skills/kindgi-x/';
const ENTRY = `${DIR}SKILL.md`;
const TOPIC = `${DIR}${md('path-a')}`;
const entry = (version, body = '# x') =>
  `---\nname: kindgi-x\nversion: "${version}"\n---\n${body}\n`;

/** Two trees, by path: what `unbumped` reads through git in the script. */
function tree(base, head) {
  const sides = { base, head };
  return {
    read: (side, path) => sides[side][path],
    list: (side, dir) => Object.keys(sides[side]).filter((path) => path.startsWith(dir)),
  };
}

describe('skillOf', () => {
  test("names the skill of a file in a skill's folder", () => {
    assert.equal(skillOf(ENTRY), 'kindgi-x');
    assert.equal(skillOf(TOPIC), 'kindgi-x');
    assert.equal(skillOf('packages/sdk/skills/kindgi-x'), undefined);
    assert.equal(skillOf('packages/sdk/src/index.ts'), undefined);
  });
});

describe('skillVersion', () => {
  test("reads the frontmatter's version, quoted or not", () => {
    assert.equal(skillVersion(entry('1.2.3')), '1.2.3');
    assert.equal(skillVersion('---\nversion: 0.4.1\n---\n'), '0.4.1');
    assert.equal(skillVersion('# no frontmatter\nversion: 1.0.0\n'), undefined);
  });
});

describe('withoutDocsLine', () => {
  test("takes a link's release line out, and nothing else", () => {
    assert.equal(
      withoutDocsLine(
        'See https://docs.kindgi.com/v0.3/start/ and https://docs.kindgi.com/v0.1.10/x/.',
      ),
      'See https://docs.kindgi.com/start/ and https://docs.kindgi.com/v0.1.10/x/.',
    );
  });
});

describe('unbumped', () => {
  test('a changed file of a skill whose version stayed is named', () => {
    const base = { [ENTRY]: entry('1.0.0'), [TOPIC]: '# a\n' };
    const head = { [ENTRY]: entry('1.0.0'), [TOPIC]: '# a, again\n' };
    assert.deepEqual(unbumped([TOPIC], tree(base, head)), ['kindgi-x']);
  });

  test('a bumped version passes', () => {
    const base = { [ENTRY]: entry('1.0.0'), [TOPIC]: '# a\n' };
    const head = { [ENTRY]: entry('1.1.0'), [TOPIC]: '# a, again\n' };
    assert.deepEqual(unbumped([ENTRY, TOPIC], tree(base, head)), []);
  });

  test('a file added or removed is a change', () => {
    const base = { [ENTRY]: entry('1.0.0') };
    const head = { [ENTRY]: entry('1.0.0'), [TOPIC]: '# a\n' };
    assert.deepEqual(unbumped([TOPIC], tree(base, head)), ['kindgi-x']);
    assert.deepEqual(unbumped([TOPIC], tree(head, base)), ['kindgi-x']);
  });

  test('a skill added or removed needs nothing', () => {
    const skill = { [ENTRY]: entry('1.0.0'), [TOPIC]: '# a\n' };
    assert.deepEqual(unbumped([ENTRY, TOPIC], tree({}, skill)), []);
    assert.deepEqual(unbumped([ENTRY, TOPIC], tree(skill, {})), []);
  });

  test('moving the docs links to a new release line is no change', () => {
    const link = (line) => `https://docs.kindgi.com/v${line}/start/`;
    const base = { [ENTRY]: entry('1.0.0', link('0.2')), [TOPIC]: link('0.2') };
    const head = { [ENTRY]: entry('1.0.0', link('0.3')), [TOPIC]: link('0.3') };
    assert.deepEqual(unbumped([ENTRY, TOPIC], tree(base, head)), []);
  });

  test("files outside a skill's folder aren't read", () => {
    assert.deepEqual(unbumped(['packages/sdk/src/index.ts', 'README.md'], tree({}, {})), []);
  });
});

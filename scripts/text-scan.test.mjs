// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/text-scan.mjs` and `scripts/check-pr-text.mjs`, against a
 * made-up name: the real list's names never appear in a test.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { prTextProblems, prTexts } from './check-pr-text.mjs';
import { NAME_HIT, loadNames, nameHits, scanText, tokenize } from './text-scan.mjs';

const SALT = 'kindgi-names-v1';
const hash = (text) => createHash('sha256').update(`${SALT}:${text}`).digest('hex');
/** A list for a made-up codename, `zorblax`, with the phrase "zorblax ai os" accepted. */
const FIXTURE = {
  v: 1,
  salt: SALT,
  maxPhrase: 3,
  tokens: [hash('zorblax')],
  allowed: [hash('zorblax ai os')],
};
const names = loadNames(FIXTURE);
/** An internal scratch path, built so the repository's own checks don't flag this file. */
const scratch = (name) => `.${'scratch'}/${name}`;

describe('tokenize', () => {
  test('runs of letters, digits and underscores, lower-cased', () => {
    assert.deepEqual(tokenize('The Zorblax-API: @zorblax/storage, ZORBLAX_LIB.'), [
      'the',
      'zorblax',
      'api',
      'zorblax',
      'storage',
      'zorblax_lib',
    ]);
  });
});

describe('nameHits', () => {
  test('a listed token is a hit, wherever it is', () => {
    assert.equal(nameHits('the zorblax runtime', names), 1);
    assert.equal(nameHits('import from "@zorblax/storage"', names), 1);
    assert.equal(nameHits("zorblax's release and Zorblax again", names), 2);
  });

  test('inside an accepted phrase, part of a longer token, or not listed: no hit', () => {
    assert.equal(nameHits('Kindgi, the zorblax AI OS', names), 0);
    assert.equal(nameHits('zorblaxty and ZORBLAX_LIB', names), 0);
    assert.equal(nameHits('the runtime', names), 0);
  });
});

describe('scanText', () => {
  test('a marker keeps its line; a name is reported by where, never by what', () => {
    const problems = scanText(`fine\nsee ${scratch('notes.txt')}\nthe zorblax repo`, { names });
    assert.deepEqual(problems, [
      { line: 2, what: 'scratch path', excerpt: `see ${scratch('notes.txt')}` },
      { line: 3, what: NAME_HIT },
    ]);
    assert.ok(!JSON.stringify(problems).includes('zorblax'));
  });
});

describe('check-pr-text', () => {
  const event = (pr) => ({ pull_request: pr });

  test('the title and description are checked; a non-PR event has nothing to check', () => {
    const texts = prTexts(event({ title: 'feat: a thing', body: `Design in ${scratch('x.txt')}` }));
    assert.deepEqual(texts, [
      { where: 'the title', text: 'feat: a thing' },
      { where: 'the description', text: `Design in ${scratch('x.txt')}` },
    ]);
    assert.deepEqual(prTexts({ merge_group: {} }), []);
    assert.deepEqual(prTextProblems(texts, { names }), [
      `the description, line 1: scratch path: Design in ${scratch('x.txt')}`,
    ]);
  });

  test("the pull request's own commits are read from base..head", () => {
    const calls = [];
    const git = (args) => {
      calls.push(args);
      return 'aaaaaaaaaa\x00fix: one\n\nthe zorblax half\n\x01\nbbbbbbbbbb\x00docs: two\n\x01';
    };
    const texts = prTexts(
      event({ title: 't', body: '', base: { sha: 'base1' }, head: { sha: 'head1' } }),
      git,
    );
    assert.deepEqual(calls, [['log', '--format=%H%x00%B%x01', 'base1..head1']]);
    assert.deepEqual(
      texts.slice(2).map((t) => t.where),
      ['commit aaaaaaa', 'commit bbbbbbb'],
    );
    assert.deepEqual(prTextProblems(texts, { names }), [`commit aaaaaaa, line 3: ${NAME_HIT}`]);
  });

  test('the command fails on a problem and passes clean text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kindgi-pr-text-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const namesFile = join(dir, 'names.json');
    writeFileSync(namesFile, JSON.stringify(FIXTURE));
    const script = fileURLToPath(new URL('./check-pr-text.mjs', import.meta.url));
    const run = (pr) => {
      const file = join(dir, 'event.json');
      writeFileSync(file, JSON.stringify(event(pr)));
      return spawnSync(process.execPath, [script, '--event', file, '--names', namesFile], {
        encoding: 'utf8',
      });
    };
    const bad = run({ title: 'feat: the zorblax half', body: 'ok' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /the title, line 1: a name the repository doesn't use/);
    assert.doesNotMatch(bad.stderr, /zorblax/);
    assert.equal(run({ title: 'feat: the runtime half', body: 'the zorblax AI OS' }).status, 0);
  });
});

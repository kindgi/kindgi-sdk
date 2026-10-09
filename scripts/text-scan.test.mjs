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

import { commitMessageText, prTextProblems, prTexts } from './check-pr-text.mjs';
import {
  ID_MARKERS,
  MARKERS,
  NAME_HIT,
  loadNames,
  nameHits,
  scanText,
  tokenize,
} from './text-scan.mjs';

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
/** An internal reference, assembled from parts for the same reason. */
const ref = (...parts) => parts.join('');

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

describe("internal tracking references, in a pull request's text", () => {
  const pr = { names, markers: [...MARKERS, ...ID_MARKERS] };
  const whats = (text, options = pr) => scanText(text, options).map((p) => p.what);

  test('ticket, step and check ids, process rule numbers, release batches', () => {
    assert.deepEqual(whats(`fix: the retry (${ref('T', 292)})`), ['internal tracking id']);
    assert.deepEqual(whats(`the sign-in half (${ref('T', '94c')})`), ['internal tracking id']);
    assert.deepEqual(whats(`memory, ${ref('M-', 2)}`), ['internal step id']);
    assert.deepEqual(whats(`live check ${ref('L-A', 5)} and ${ref('L-B', 10)}`), [
      'internal step id',
    ]);
    assert.deepEqual(whats(`additive (${ref('protocol ', 16)})`), ['internal process rule']);
    assert.deepEqual(whats(`0.1.5, ${ref('wave ', 2)}`), ['internal release batch']);
    assert.deepEqual(whats(`after ${ref('pin ', 'batch')} 24`), ['internal release batch']);
  });

  test('real terms that look a little like them are left alone', () => {
    for (const text of [
      'started at T12:00:00Z',
      'on 2026-10-09T15:00',
      'an NVIDIA T4',
      '{"orderId":"A-1042"}',
      'pack protocol 2.5.0, and the log line says protocol 2',
      'ECDSA over P-256, SHA-1, UTF-8, ISO-8859-1',
      'a wave of retries',
    ]) {
      assert.deepEqual(whats(text), [], text);
    }
  });

  test("a repository file isn't checked for them: only a pull request's text", () => {
    assert.deepEqual(whats(`see ${ref('T', 292)}`, { names }), []);
  });

  test('an allowed term is blanked out, as a whole word only', () => {
    const allowed = { ...pr, allowed: [ref('X-', 1)] };
    assert.deepEqual(whats(`the ${ref('X-', 1)} board`, allowed), []);
    assert.deepEqual(whats(`the ${ref('X-', 1)} and ${ref('Y-', 1)}`, allowed), [
      'internal step id',
    ]);
    assert.deepEqual(whats(`a ${ref('X-', 1, 'b')}`, allowed), ['internal step id']);
  });

  test('a commit is checked for them by default; the excerpt is the line', () => {
    const git = () => `aaaaaaaaaa\x00fix: one\n\nfound in ${ref('T', 292)}\n\x01`;
    const texts = prTexts(
      { pull_request: { title: 't', body: '', base: { sha: 'b' }, head: { sha: 'h' } } },
      git,
    );
    assert.deepEqual(prTextProblems(texts, { names }), [
      `commit aaaaaaa, line 3: internal tracking id: found in ${ref('T', 292)}`,
    ]);
  });
});

describe('check-pr-text --message (the commit-msg hook)', () => {
  test('a message as git stores it: no comment lines, nothing below the scissors', () => {
    const raw = [
      'fix: one',
      '',
      `# On branch fix/${ref('T', 292)}`,
      'the body',
      '# ------------------------ >8 ------------------------',
      `diff --git a/x b/x (${ref('T', 293)})`,
    ].join('\n');
    assert.equal(commitMessageText(raw), 'fix: one\n\n\nthe body');
    assert.equal(commitMessageText(raw.replaceAll('#', ';'), ';'), 'fix: one\n\n\nthe body');
  });

  test('the command fails on a problem, naming the line, and passes clean text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kindgi-commit-msg-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const namesFile = join(dir, 'names.json');
    writeFileSync(namesFile, JSON.stringify(FIXTURE));
    const script = fileURLToPath(new URL('./check-pr-text.mjs', import.meta.url));
    const run = (message) => {
      const file = join(dir, 'COMMIT_EDITMSG');
      writeFileSync(file, message);
      return spawnSync(process.execPath, [script, '--message', file, '--names', namesFile], {
        cwd: dir,
        encoding: 'utf8',
      });
    };
    const bad = run(`fix: one\n\nthe ${ref('M-', 2)} half\n`);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /the commit message, line 3: internal step id/);
    assert.equal(run(`fix: one\n\n# ${ref('T', 292)} in a comment\n`).status, 0);
    assert.equal(run('fix: the zorblax half\n').status, 1);
  });
});

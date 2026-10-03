// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  EnvValueNotRepresentableError,
  envLinesToRecord,
  parseEnvFile,
  renderEntry,
  setKey,
  unsetKey,
} from '../src/index.js';

describe('renderEntry — quoting', () => {
  test.each([
    ['plain', 'abc-123_x.y', 'K=abc-123_x.y'],
    ['url', 'postgres://u:p@h:5432/db', 'K=postgres://u:p@h:5432/db'],
    ['empty', '', 'K=""'],
    ['whitespace', 'hello world', 'K="hello world"'],
    ['hash', 'a#b', 'K="a#b"'],
    ['newline → \\n in double quotes', 'a\nb', 'K="a\\nb"'],
    ['double quote → single quotes', 'say "hi"', `K='say "hi"'`],
    ['literal \\n sequence → single quotes', 'a\\nb', "K='a\\nb'"],
    ['both quotes → backticks', `"a" 'b'`, 'K=`"a" \'b\'`'],
    ['dollar is escaped', 'cost $5', 'K="cost \\$5"'],
  ])('%s', (_name, value, expected) => {
    expect(renderEntry('K', value)).toBe(expected);
  });

  test('export prefix', () => {
    expect(renderEntry('K', 'v', { exported: true })).toBe('export K=v');
  });

  test('unrepresentable values throw instead of writing a different value', () => {
    expect(() => renderEntry('K', `"a" 'b' \`c\` \\n`)).toThrow(EnvValueNotRepresentableError);
  });
});

describe('setKey', () => {
  test('appends to empty input', () => {
    const { contents, overwritten } = setKey('', 'FOO', 'bar');
    expect(overwritten).toBe(false);
    expect(contents).toBe('FOO=bar\n');
  });

  test('appends when key is absent, preserves existing keys', () => {
    const { contents, overwritten } = setKey('AAA=1\nBBB=2\n', 'CCC', '3');
    expect(overwritten).toBe(false);
    expect(contents).toBe('AAA=1\nBBB=2\nCCC=3\n');
  });

  test('replaces the value in place when key exists', () => {
    const { contents, overwritten } = setKey('AAA=1\nBBB=2\nCCC=3\n', 'BBB', 'newval');
    expect(overwritten).toBe(true);
    expect(contents).toBe('AAA=1\nBBB=newval\nCCC=3\n');
  });

  test('with duplicates, replaces the LAST occurrence — the one readers see', () => {
    const { contents } = setKey('A=first\nB=x\nA=second\n', 'A', 'new');
    expect(contents).toBe('A=first\nB=x\nA=new\n');
    expect(envLinesToRecord(parseEnvFile(contents)).A).toBe('new');
  });

  test('keeps the export prefix of the entry it replaces', () => {
    expect(setKey('export A=1\n', 'A', '2').contents).toBe('export A=2\n');
  });

  test('replaces a multi-line entry as a whole', () => {
    expect(setKey('A="one\ntwo"\nB=1\n', 'A', 'x').contents).toBe('A=x\nB=1\n');
  });

  test('preserves comments, blank lines, hand-written quoting and malformed lines', () => {
    const source = "# header\nAAA='quoted'  # note\n\nlowercase line\nBBB=2\n";
    expect(setKey(source, 'BBB', '99').contents).toBe(
      "# header\nAAA='quoted'  # note\n\nlowercase line\nBBB=99\n",
    );
  });

  test('refuses keys that are not POSIX env names', () => {
    expect(() => setKey('', 'lower', 'x')).toThrow(TypeError);
  });
});

describe('unsetKey', () => {
  test('idempotent when key is absent', () => {
    const { contents, removed } = unsetKey('AAA=1\n', 'MISSING');
    expect(removed).toBe(false);
    expect(contents).toBe('AAA=1\n');
  });

  test('removes the key and preserves surrounding lines', () => {
    const { contents, removed } = unsetKey('# header\nAAA=1\nBBB=2\nCCC=3\n', 'BBB');
    expect(removed).toBe(true);
    expect(contents).toBe('# header\nAAA=1\nCCC=3\n');
  });

  test('removes every entry for the key when duplicates exist', () => {
    expect(unsetKey('AAA=1\nAAA=2\n', 'AAA').contents).toBe('');
  });

  test('removes a multi-line entry as a whole', () => {
    expect(unsetKey('A="one\ntwo"\nB=1\n', 'A').contents).toBe('B=1\n');
  });
});

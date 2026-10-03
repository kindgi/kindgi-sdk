// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { envLinesToRecord, parseEntryRaw, parseEnvFile, serializeEnvFile } from '../src/index.js';

describe('parseEnvFile — structure', () => {
  test('empty input yields no lines', () => {
    expect(parseEnvFile('')).toEqual([]);
  });

  test('parses KEY=value entries', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux\n')).toEqual([
      { kind: 'entry', raw: 'FOO=bar', key: 'FOO', value: 'bar' },
      { kind: 'entry', raw: 'BAZ=qux', key: 'BAZ', value: 'qux' },
    ]);
  });

  test('strips surrounding quotes on value', () => {
    expect(parseEnvFile('FOO="hello world"\n')[0]).toEqual({
      kind: 'entry',
      raw: 'FOO="hello world"',
      key: 'FOO',
      value: 'hello world',
    });
  });

  test('records the export prefix', () => {
    expect(parseEnvFile('export FOO=1\n')[0]).toEqual({
      kind: 'entry',
      raw: 'export FOO=1',
      key: 'FOO',
      value: '1',
      exported: true,
    });
  });

  test('preserves comments and blank lines', () => {
    const lines = parseEnvFile('# top\nFOO=1\n\n# bottom\n');
    expect(lines.map((l) => l.kind)).toEqual(['comment', 'entry', 'blank', 'comment']);
  });

  test('marks non-entry lines as malformed (dotenv ignores them; we keep them)', () => {
    const [line] = parseEnvFile('not-an-entry\n');
    expect(line?.kind).toBe('malformed');
    expect(line?.reason).toContain('KEY=value');
  });

  test('lowercase, dotted and dashed keys are entries (dotenv accepts them)', () => {
    const r = envLinesToRecord(parseEnvFile('foo=1\na.b=2\na-b=3\n'));
    expect(r).toEqual({ foo: '1', 'a.b': '2', 'a-b': '3' });
  });

  test('handles CRLF line endings', () => {
    expect(envLinesToRecord(parseEnvFile('FOO=1\r\nBAR=2\r\n'))).toEqual({ FOO: '1', BAR: '2' });
  });

  test('a multi-line quoted value is ONE entry whose raw spans its lines', () => {
    const lines = parseEnvFile('A="one\ntwo"\nB=3\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ kind: 'entry', raw: 'A="one\ntwo"', key: 'A', value: 'one\ntwo' });
  });

  test('inline comments are not part of an unquoted value', () => {
    expect(envLinesToRecord(parseEnvFile('A=value # note\n'))).toEqual({ A: 'value' });
  });
});

describe('parseEntryRaw', () => {
  test('returns the entry when the text is exactly one entry', () => {
    expect(parseEntryRaw("A='x y'")?.value).toBe('x y');
  });

  test('undefined for zero or several lines, or a non-entry', () => {
    expect(parseEntryRaw('')).toBeUndefined();
    expect(parseEntryRaw('A=1\nB=2')).toBeUndefined();
    expect(parseEntryRaw('# comment')).toBeUndefined();
  });
});

describe('serializeEnvFile', () => {
  test('hand-written entries survive byte-for-byte (quotes, export, inline comments)', () => {
    const source =
      '# top\nexport A=\'single\'\nB="double"  # why\nC=plain\nD=`tick`\nE="multi\nline"\n\n';
    expect(serializeEnvFile(parseEnvFile(source))).toBe(source);
  });

  test('an entry whose raw no longer matches its value is re-rendered', () => {
    const stale = [{ kind: 'entry' as const, raw: 'FOO=old', key: 'FOO', value: 'new value' }];
    expect(serializeEnvFile(stale)).toBe('FOO="new value"\n');
  });

  test('re-rendering keeps the export prefix', () => {
    const stale = [
      { kind: 'entry' as const, raw: 'export FOO=old', key: 'FOO', value: 'new', exported: true },
    ];
    expect(serializeEnvFile(stale)).toBe('export FOO=new\n');
  });

  test('preserves malformed lines verbatim (never silently drops)', () => {
    const source = 'not-an-entry\n';
    expect(serializeEnvFile(parseEnvFile(source))).toBe(source);
  });
});

describe('envLinesToRecord', () => {
  test('flattens entries; skips comments/blanks/malformed', () => {
    const lines = parseEnvFile('# c\nFOO=1\n\nBAR=2\nnot-an-entry\n');
    expect(envLinesToRecord(lines)).toEqual({ FOO: '1', BAR: '2' });
  });

  test('last write wins on duplicate keys', () => {
    expect(envLinesToRecord(parseEnvFile('FOO=1\nFOO=2\n'))).toEqual({ FOO: '2' });
  });
});

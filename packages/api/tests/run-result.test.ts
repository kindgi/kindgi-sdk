// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/api/src/run-result/** packages/api/package.json

/**
 * `@kindgi/api/run-result`: the status words, the answer a run gave, and
 * that answer split into blocks by its shape, within a limit. The console
 * and the chat's run view both draw from it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { RunStatusSchema } from '../src/openapi/schemas.js';
import { pickedAnswer } from '../src/run-result/answer.js';
import {
  RESULT_LIMIT,
  RUN_STATUS_WORDS,
  answerBlocks,
  answerOfText,
  answerValue,
  clipText,
} from '../src/run-result/index.js';

const AGENT = { id: 'acme.clauses', conversationId: 'c1' };
const LIMIT = 8_000;

describe('answerBlocks: the kinds', () => {
  test('null, absent, [] and {} give no blocks', () => {
    for (const answer of [null, undefined, [], {}]) {
      expect(answerBlocks(answer, LIMIT)).toEqual({ blocks: [], truncated: false });
    }
  });

  test('an empty answer, or one of only white space, gives no blocks; an empty field stays', () => {
    for (const answer of ['', '   ', ' \n\t\n ']) {
      expect(answerBlocks(answer, LIMIT)).toEqual({ blocks: [], truncated: false });
    }
    expect(answerBlocks({ note: '', clause: 4 }, LIMIT).blocks).toEqual([
      {
        kind: 'fields',
        fields: [
          { name: 'note', value: '' },
          { name: 'clause', value: '4' },
        ],
        long: false,
      },
    ]);
  });

  test('a string on one line, at most 280 characters, is a value; else text', () => {
    expect(answerBlocks('Clause 4 differs.', LIMIT).blocks).toEqual([
      { kind: 'value', value: 'Clause 4 differs.' },
    ]);
    expect(answerBlocks('x'.repeat(280), LIMIT).blocks[0]?.kind).toBe('value');
    expect(answerBlocks('x'.repeat(281), LIMIT).blocks).toEqual([
      { kind: 'text', text: 'x'.repeat(281), long: false },
    ]);
    expect(answerBlocks('two\nlines', LIMIT).blocks).toEqual([
      { kind: 'text', text: 'two\nlines', long: false },
    ]);
  });

  test('a number or a boolean is a value, as its JSON', () => {
    expect(answerBlocks(42.5, LIMIT).blocks).toEqual([{ kind: 'value', value: '42.5' }]);
    expect(answerBlocks(false, LIMIT).blocks).toEqual([{ kind: 'value', value: 'false' }]);
  });

  test('an array of objects of scalars is records, its keys in the order they first appear', () => {
    expect(
      answerBlocks(
        [
          { a: 1, b: 'x' },
          { b: 'y', c: null },
        ],
        LIMIT,
      ).blocks,
    ).toEqual([
      {
        kind: 'records',
        columns: ['a', 'b', 'c'],
        rows: [
          ['1', 'x', ''],
          ['', 'y', ''],
        ],
        long: false,
      },
    ]);
  });

  test('a long string stays in its row', () => {
    const note = 'line\n'.repeat(40);
    const [block] = answerBlocks([{ clause: 4, note }], LIMIT).blocks;
    expect(block).toMatchObject({
      kind: 'records',
      columns: ['clause', 'note'],
      rows: [['4', note]],
    });
  });

  test('12 different keys are records; 13 are one text of the JSON, so no key is left out unseen', () => {
    const keys = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(answerBlocks([keys(12)], LIMIT).blocks[0]?.kind).toBe('records');
    const thirteen = [keys(6), { ...keys(13) }];
    expect(answerBlocks(thirteen, LIMIT).blocks).toEqual([
      { kind: 'text', text: JSON.stringify(thirteen, null, 2), long: false },
    ]);
  });

  test('an array of scalars, or a mixed one, is one text of its JSON', () => {
    expect(answerBlocks([1, 'two'], LIMIT).blocks).toEqual([
      { kind: 'text', text: JSON.stringify([1, 'two'], null, 2), long: false },
    ]);
    expect(answerBlocks([{ a: 1 }, 2], LIMIT).blocks[0]?.kind).toBe('text');
  });

  test('an object of value-sized scalars is one untitled fields block; null is an empty value', () => {
    expect(answerBlocks({ name: 'A', count: 2, ok: false, none: null }, LIMIT).blocks).toEqual([
      {
        kind: 'fields',
        fields: [
          { name: 'name', value: 'A' },
          { name: 'count', value: '2' },
          { name: 'ok', value: 'false' },
          { name: 'none', value: '' },
        ],
        long: false,
      },
    ]);
  });

  test('a long string in an object is its own text block, titled with its key', () => {
    const answer = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${'w'.repeat(60)}`).join('\n');
    expect(answerBlocks({ answer, confidence: 'high' }, LIMIT).blocks).toEqual([
      { kind: 'text', title: 'answer', text: answer, long: true },
      { kind: 'fields', fields: [{ name: 'confidence', value: 'high' }], long: false },
    ]);
  });

  test("an object's blocks are in key order; its scalars sit at the first one's place", () => {
    const answer = {
      a: 1,
      list: [{ x: 1 }],
      b: 'two',
      nested: { k: 'v', none: null },
      deep: { k: { z: 1 } },
      empty: [],
      none: {},
      scalars: [1, 2],
    };
    expect(answerBlocks(answer, LIMIT).blocks).toEqual([
      {
        kind: 'fields',
        fields: [
          { name: 'a', value: '1' },
          { name: 'b', value: 'two' },
        ],
        long: false,
      },
      { kind: 'records', title: 'list', columns: ['x'], rows: [['1']], long: false },
      {
        kind: 'fields',
        title: 'nested',
        fields: [
          { name: 'k', value: 'v' },
          { name: 'none', value: '' },
        ],
        long: false,
      },
      { kind: 'text', title: 'deep', text: JSON.stringify({ k: { z: 1 } }, null, 2), long: false },
      { kind: 'text', title: 'scalars', text: JSON.stringify([1, 2], null, 2), long: false },
    ]);
  });
});

describe('answerBlocks: long', () => {
  test('past 1,200 drawn characters, title included', () => {
    expect(answerBlocks('x\n'.repeat(600), LIMIT).blocks[0]).toMatchObject({ long: false });
    expect(answerBlocks(`${'x\n'.repeat(600)}y`, LIMIT).blocks[0]).toMatchObject({ long: true });
    expect(answerBlocks({ ab: `${'x\n'.repeat(599)}y` }, LIMIT).blocks[0]).toMatchObject({
      title: 'ab',
      long: true,
    });
  });

  test('past 12 fields, or 1,200 drawn characters of them', () => {
    const fields = (n: number, size: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, 'v'.repeat(size)]));
    expect(answerBlocks(fields(12, 1), LIMIT).blocks[0]).toMatchObject({ long: false });
    expect(answerBlocks(fields(13, 1), LIMIT).blocks[0]).toMatchObject({ long: true });
    expect(answerBlocks(fields(8, 250), LIMIT).blocks[0]).toMatchObject({ long: true });
  });

  test('past 10 rows, or 1,200 drawn characters of them: 3 rows of 2,000-character cells are long', () => {
    const rows = (n: number, size: number) =>
      Array.from({ length: n }, () => ({ c: 'v'.repeat(size) }));
    expect(answerBlocks(rows(10, 1), LIMIT).blocks[0]).toMatchObject({ long: false });
    expect(answerBlocks(rows(11, 1), LIMIT).blocks[0]).toMatchObject({ long: true });
    expect(answerBlocks(rows(3, 2_000), LIMIT).blocks[0]).toMatchObject({ long: true });
  });
});

describe('answerBlocks: the limit', () => {
  test('an answer that fits is whole', () => {
    expect(answerBlocks('x'.repeat(10), 10)).toEqual({
      blocks: [{ kind: 'value', value: 'x'.repeat(10) }],
      truncated: false,
    });
  });

  test('a text is cut at the limit, and says so', () => {
    const { blocks, truncated } = answerBlocks(`a\n${'x'.repeat(100)}`, 50);
    expect(blocks).toEqual([{ kind: 'text', text: `a\n${'x'.repeat(48)}`, long: false }]);
    expect(truncated).toBe(true);
  });

  test('fields are kept while they fit; the one that crosses is cut, the rest left out', () => {
    expect(answerBlocks({ a: '1234', b: '5678', c: '9' }, 8)).toEqual({
      blocks: [
        {
          kind: 'fields',
          fields: [
            { name: 'a', value: '1234' },
            { name: 'b', value: '56' },
          ],
          long: false,
        },
      ],
      truncated: true,
    });
    // A field whose value doesn't fit at all is left out.
    expect(answerBlocks({ a: '1234', b: '5678' }, 6).blocks).toEqual([
      { kind: 'fields', fields: [{ name: 'a', value: '1234' }], long: false },
    ]);
  });

  test('rows are kept while they fit; the one that crosses is cut, the rest left out', () => {
    const rows = [{ c: 'aaaa' }, { c: 'bbbb' }, { c: 'cccc' }, { c: 'dddd' }];
    expect(answerBlocks(rows, 11)).toEqual({
      blocks: [
        { kind: 'records', columns: ['c'], rows: [['aaaa'], ['bbbb'], ['cc']], long: false },
      ],
      truncated: true,
    });
  });

  test('the blocks after the cut are left out', () => {
    const answer = { first: 'x\n'.repeat(150), second: 'y\n'.repeat(150) };
    const { blocks, truncated } = answerBlocks(answer, 'first'.length + 300 + 2);
    expect(blocks).toEqual([
      { kind: 'text', title: 'first', text: 'x\n'.repeat(150), long: false },
    ]);
    expect(truncated).toBe(true);
  });

  test('titles, field names and column names count', () => {
    expect(answerBlocks({ title: 'x\n'.repeat(200) }, 400).blocks).toEqual([
      { kind: 'text', title: 'title', text: 'x\n'.repeat(200).slice(0, 395), long: false },
    ]);
    expect(answerBlocks({ name: 'abc' }, 6).blocks).toEqual([
      { kind: 'fields', fields: [{ name: 'name', value: 'ab' }], long: false },
    ]);
    expect(answerBlocks([{ column: 'abc' }], 6)).toEqual({ blocks: [], truncated: true });
  });

  test('a cut never ends in half a character', () => {
    const { blocks, truncated } = answerBlocks(`${'a'.repeat(9)}😀`, 10);
    expect(blocks).toEqual([{ kind: 'value', value: 'a'.repeat(9) }]);
    expect(truncated).toBe(true);
  });

  test("the console's limit is 100,000", () => {
    expect(RESULT_LIMIT).toBe(100_000);
    expect(answerBlocks('x\n'.repeat(60_000), RESULT_LIMIT).blocks[0]).toMatchObject({
      kind: 'text',
      long: true,
    });
  });
});

describe('answerValue: what a run answered', () => {
  test("an agent's typed output, else its reply's content", () => {
    expect(
      answerValue({
        agent: AGENT,
        output: { response: { content: 'prose' }, output: { differs: [4] } },
      }),
    ).toEqual({ differs: [4] });
    expect(
      answerValue({ agent: AGENT, output: { response: { content: 'prose' }, output: null } }),
    ).toBe('prose');
    expect(answerValue({ agent: AGENT, output: { response: {} } })).toBeUndefined();
  });

  test("a flow's output, whole", () => {
    expect(answerValue({ output: { differs: [4] } })).toEqual({ differs: [4] });
    expect(answerValue({ output: 'done' })).toBe('done');
  });

  test('no output, no answer', () => {
    expect(answerValue({})).toBeUndefined();
    expect(answerValue({ output: null })).toBeUndefined();
    expect(answerValue({ agent: AGENT, output: null })).toBeUndefined();
  });

  test('JSON written as text is read, for agents and flows alike', () => {
    expect(
      answerValue({ agent: AGENT, output: { response: { content: '```json\n{"a":1}\n```' } } }),
    ).toEqual({ a: 1 });
    expect(answerValue({ output: '[1,2]' })).toEqual([1, 2]);
  });

  test('the pick is the one the chat text is made from', () => {
    const typed = { agent: AGENT, output: { response: { content: '{"a":1}' }, output: null } };
    expect(pickedAnswer(typed)).toBe('{"a":1}');
    expect(answerValue(typed)).toEqual({ a: 1 });
  });
});

describe('answerOfText: JSON written as text', () => {
  test('an object or array, bare or in one ``` or ```json fence, is read as its value', () => {
    expect(answerOfText('{"a":1}')).toEqual({ a: 1 });
    expect(answerOfText('  [1, 2]\n')).toEqual([1, 2]);
    expect(answerOfText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(answerOfText('\n```\n[1]\n```  ')).toEqual([1]);
  });

  test('anything else comes back as it was sent, untrimmed', () => {
    for (const text of [' {broken ', ' 42 ', '```\nplain\n```', 'Clause 4 differs.', '"quoted"']) {
      expect(answerOfText(text)).toBe(text);
    }
  });

  test('a value that is not a string comes back as it is', () => {
    const value = { a: 1 };
    expect(answerOfText(value)).toBe(value);
    expect(answerOfText(42)).toBe(42);
    expect(answerOfText(undefined)).toBeUndefined();
  });
});

describe('RUN_STATUS_WORDS', () => {
  test('has a word for exactly every run status the API answers', () => {
    expect(Object.keys(RUN_STATUS_WORDS).sort()).toEqual(
      [...(RunStatusSchema.enum as string[])].sort(),
    );
  });

  test('the words, which the console and the docs quote', () => {
    expect(RUN_STATUS_WORDS).toEqual({
      pending: 'Waiting to start',
      running: 'Running',
      suspended: 'Waiting',
      completed: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
    });
  });
});

describe('clipText', () => {
  test('cuts at the limit, never in half a character', () => {
    expect(clipText('abcdef', 3)).toBe('abc');
    expect(clipText('ab😀', 3)).toBe('ab');
    expect(clipText('abc', 3)).toBe('abc');
  });
});

describe('the subpath', () => {
  const dir = join(import.meta.dirname, '../src/run-result');

  test('imports nothing but types and its own files, so a browser bundle can take it', () => {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const [, clause, from] of source.matchAll(
        /^(?:import|export)\s+(.*?)\s+from\s+'([^']+)';$/gms,
      )) {
        if (clause?.startsWith('type ')) continue;
        expect(from, `${file}: ${clause}`).toMatch(/^\.\/[a-z-]+\.js$/);
      }
    }
  });

  test("the package's exports name ./run-result", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports['./run-result']).toEqual({
      types: './dist/run-result/index.d.ts',
      import: './dist/run-result/index.js',
      default: './dist/run-result/index.js',
    });
  });
});

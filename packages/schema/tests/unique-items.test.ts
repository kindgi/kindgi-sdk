// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The linear `uniqueItems` (hosted) against Ajv's own (self-hosted): the
 * same verdict and the same errors on random JSON arrays, and an array of
 * 300,000 objects checked in time Ajv's pairwise compare can't reach.
 */

import { HOSTED_BOUNDS, SELF_HOSTED_BOUNDS } from '@kindgi/bounds';
import type { TenantInputBounds } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import type { Options, ValidateFunction } from 'ajv';
import { describe, expect, test } from 'vitest';

import { boundedAjv } from '../src/bounded.js';
import { lastRepeat } from '../src/unique-items.js';

/** An Ajv 2020-12 validator for `schema`, compiled under `bounds`. */
function compileUnder(
  bounds: TenantInputBounds,
  schema: object,
  options: Options = {},
): ValidateFunction {
  const restore = overrideTenantInputBounds(bounds);
  try {
    return boundedAjv('2020-12', { strict: false, allErrors: true, ...options }).compile(schema);
  } finally {
    restore();
  }
}

/** Hosted's validator and Ajv's own, for `schema`. */
function both(schema: object, options: Options = {}) {
  return {
    linear: compileUnder(HOSTED_BOUNDS, schema, options),
    ajvs: compileUnder(SELF_HOSTED_BOUNDS, schema, options),
  };
}

/** The verdict and the errors, as a test compares them. */
function outcome(validate: ValidateFunction, data: unknown) {
  const valid = validate(data);
  return { valid, errors: validate.errors ?? null };
}

/** A seeded PRNG (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Node =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'array'; readonly items: readonly Node[] }
  | { readonly kind: 'object'; readonly entries: readonly (readonly [string, Node])[] };

// Few values, so items repeat often: `-0` and `0`, `1` and `1.0` are the
// same to Ajv; `constructor` and `__proto__` are keys `fast-deep-equal`
// reads in its own way, or that `JSON.parse` makes an own key of.
const LITERALS = ['null', 'true', 'false', '0', '-0', '1', '1.0', '2', '"a"', '"b"', '""', '"0"'];
const KEYS = ['a', 'b', 'c', 'constructor', '__proto__'];

function node(next: () => number, depth: number): Node {
  const roll = next();
  if (depth >= 3 || roll < 0.5) {
    return { kind: 'literal', text: LITERALS[Math.floor(next() * LITERALS.length)] as string };
  }
  const size = Math.floor(next() * 4);
  if (roll < 0.7) {
    return { kind: 'array', items: Array.from({ length: size }, () => node(next, depth + 1)) };
  }
  const keys = KEYS.filter(() => next() < 0.4);
  return { kind: 'object', entries: keys.map((key) => [key, node(next, depth + 1)] as const) };
}

/** `value` as JSON text, each object's keys in a random order. */
function text(value: Node, next: () => number): string {
  if (value.kind === 'literal') return value.text;
  if (value.kind === 'array') return `[${value.items.map((item) => text(item, next)).join(',')}]`;
  const entries = [...value.entries].sort(() => next() - 0.5);
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${text(inner, next)}`).join(',')}}`;
}

/** A random array, its items drawn from a few values so some repeat; parsed from JSON text. */
function randomArray(next: () => number): unknown[] {
  const pool = Array.from({ length: 1 + Math.floor(next() * 4) }, () => node(next, 0));
  const length = Math.floor(next() * 9);
  const items = Array.from({ length }, () => pool[Math.floor(next() * pool.length)] as Node);
  return JSON.parse(`[${items.map((item) => text(item, next)).join(',')}]`) as unknown[];
}

const SCHEMAS: readonly (readonly [string, object])[] = [
  ['no item type', { uniqueItems: true }],
  ['object items', { uniqueItems: true, items: { type: 'object' } }],
  [
    'every type',
    {
      uniqueItems: true,
      items: { type: ['object', 'array', 'number', 'string', 'boolean', 'null'] },
    },
  ],
  // Ajv's own code, linear already: the same on both.
  ['scalar items', { uniqueItems: true, items: { type: ['number', 'string', 'boolean', 'null'] } }],
  ['nested', { type: 'array', items: { type: 'array', uniqueItems: true } }],
];

describe('uniqueItems on hosted gives Ajv’s verdict and errors', () => {
  for (const [name, schema] of SCHEMAS) {
    test(`random JSON arrays: ${name}`, () => {
      const { linear, ajvs } = both(schema);
      const next = random(0x6b1d + name.length);
      let repeats = 0;
      for (let run = 0; run < 3_000; run += 1) {
        const data = name === 'nested' ? [[0], randomArray(next)] : randomArray(next);
        const expected = outcome(ajvs, data);
        expect(outcome(linear, data), JSON.stringify(data)).toEqual(expected);
        if (expected.errors?.some((error) => error.keyword === 'uniqueItems')) repeats += 1;
      }
      // Both verdicts come up often, so agreeing isn't vacuous.
      expect(repeats).toBeGreaterThan(600);
      expect(repeats).toBeLessThan(2_400);
    });
  }

  test('`uniqueItems` from `$data`', () => {
    const schema = {
      type: 'object',
      properties: { unique: { type: 'boolean' }, list: { uniqueItems: { $data: '1/unique' } } },
    };
    const { linear, ajvs } = both(schema, { $data: true });
    const next = random(0x5eed);
    for (let run = 0; run < 1_000; run += 1) {
      const data = { unique: next() < 0.7, list: randomArray(next) };
      expect(outcome(linear, data), JSON.stringify(data)).toEqual(outcome(ajvs, data));
    }
  });

  test('the pair reported and its message are Ajv’s', () => {
    const { linear } = both({ uniqueItems: true });
    const data = [{ a: 1, b: 2 }, [1], { b: 2, a: 1 }, 0, [1], -0];
    expect(linear(data)).toBe(false);
    expect(linear.errors).toEqual([
      {
        instancePath: '',
        schemaPath: '#/uniqueItems',
        keyword: 'uniqueItems',
        params: { i: 5, j: 3 },
        message: 'must NOT have duplicate items (items ## 3 and 5 are identical)',
      },
    ]);
  });

  test('own `constructor` objects: never equal to another, as `fast-deep-equal` has it', () => {
    const { linear, ajvs } = both({ uniqueItems: true });
    const shared = { a: 1 };
    for (const data of [
      JSON.parse('[{"constructor":{}},{"constructor":{}}]'),
      JSON.parse('[{"constructor":[]},{"constructor":[]}]'),
      JSON.parse('[{"constructor":1},{"constructor":1}]'),
      JSON.parse('[{"constructor":null},{"constructor":null}]'),
      [{ constructor: shared }, { constructor: shared }],
    ]) {
      expect(outcome(linear, data), JSON.stringify(data)).toEqual(outcome(ajvs, data));
    }
  });

  test('items JSON can’t carry: compared pair by pair, as Ajv does', () => {
    const { linear, ajvs } = both({ uniqueItems: true });
    for (const data of [
      [new Date(0), new Date(0)],
      [new Date(0), new Date(1)],
      [{ a: new Date(0) }, { a: new Date(0) }],
      [/a/, /a/],
      [1, Number.NaN, Number.NaN],
      [undefined, undefined],
    ]) {
      expect(outcome(linear, data), String(data)).toEqual(outcome(ajvs, data));
    }
  });

  test('an own `valueOf` key: compared by keys, where `fast-deep-equal` throws', () => {
    const data = JSON.parse('[{"valueOf":1},{"valueOf":1}]');
    const { linear, ajvs } = both({ uniqueItems: true });
    expect(() => ajvs(data)).toThrow(TypeError);
    expect(outcome(linear, data).valid).toBe(false);
    expect(lastRepeat(JSON.parse('[{"toString":1},{"toString":2}]'))).toBeUndefined();
  });

  test('as many distinct objects as 2 MiB of JSON holds: linear', () => {
    const { linear } = both({ type: 'array', uniqueItems: true });
    const items: { readonly a: number }[] = [];
    // `[`, then `{"a":0},{"a":1},…`: every item distinct, the worst case
    // for Ajv's compare, which can't stop early.
    for (let bytes = 1; ; ) {
      const item = { a: items.length };
      bytes += JSON.stringify(item).length + 1;
      if (bytes > 2 * 1024 * 1024) break;
      items.push(item);
    }
    expect(items.length).toBeGreaterThan(165_000);
    const started = performance.now();
    expect(linear(items)).toBe(true);
    expect(linear([...items, { a: 7 }])).toBe(false);
    expect(linear.errors?.[0]?.params).toEqual({ i: items.length, j: 7 });
    // Ajv's own compare is about 1.5 × 10^10 pairs here: minutes.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

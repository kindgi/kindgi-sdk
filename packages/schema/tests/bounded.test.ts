// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Schemas under the process's bounds: on RE2 (hosted), every check runs in
 * time linear in the data; on either, a schema is measured before it's
 * compiled, and compiled once.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  HOSTED_BOUNDS,
  SELF_HOSTED_BOUNDS,
  compileTenantPattern,
  runAsTenant,
  tenantPatternSyntaxProblem,
} from '@kindgi/bounds';
import type { TenantInputBounds } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { SPECS_SCHEMAS_DIR } from '@kindgi/specs';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { boundedAjv } from '../src/bounded.js';
import {
  SchemaCompileBudgetError,
  compileInlineSchema,
  compileJsonSchema,
  loadSpecRegistry,
} from '../src/index.js';
import { linearUniqueItems } from '../src/unique-items.js';

let restore: (() => void) | undefined;

function under(bounds: TenantInputBounds): void {
  restore?.();
  restore = overrideTenantInputBounds(bounds);
}

afterEach(() => {
  restore?.();
  restore = undefined;
});

/** The error `compileJsonSchema(schema)` throws, or undefined when it compiles. */
function refusal(schema: Readonly<Record<string, unknown>>): string | undefined {
  try {
    compileJsonSchema(schema);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('on the hosted bounds', () => {
  test('a pattern runs on RE2, and each pattern is its own', () => {
    under(HOSTED_BOUNDS);
    const validate = compileJsonSchema({
      type: 'object',
      properties: {
        a: { type: 'string', pattern: '^x+$' },
        b: { type: 'string', pattern: '^y+$' },
      },
      patternProperties: { '^z': { type: 'number' } },
      propertyNames: { pattern: '^[abz]' },
    });
    expect(validate({ a: 'xx', b: 'yy', z1: 1 })).toBe(true);
    expect(validate({ a: 'yy' })).toBe(false);
    expect(validate({ b: 'xx' })).toBe(false);
    expect(validate({ z1: 'one' })).toBe(false);
    expect(validate({ c: 1 })).toBe(false);
  });

  test('a pattern RE2 refuses: the schema doesn’t compile, saying why', () => {
    under(HOSTED_BOUNDS);
    expect(refusal({ type: 'string', pattern: '^(?=a)a$' })).toBe(
      'The schema\'s pattern "^(?=a)a$" isn\'t a regular expression that compiles: RE2, the engine patterns run on here, has no lookahead or lookbehind (`(?=` at index 1).',
    );
    expect(refusal({ type: 'object', patternProperties: { '(a)\\1': {} } })).toMatch(
      /^The schema's pattern "\(a\)\\\\1" isn't a regular expression that compiles: .*no backreferences/,
    );
    expect(refusal({ type: 'object', propertyNames: { pattern: '(?<!a)b' } })).toMatch(
      /no lookahead or lookbehind/,
    );
    const inline = compileInlineSchema({ type: 'string', pattern: '^(?=a)' });
    expect(inline.kind === 'err' && inline.error.message).toMatch(
      /^Inline schema failed to compile: The schema's pattern "\^\(\?=a\)" isn't/,
    );
  });

  test('`format: regex` is a pattern whose syntax `compileTenantPattern` accepts, in its flag mode', () => {
    under(HOSTED_BOUNDS);
    const validate = compileJsonSchema({ type: 'string', format: 'regex' });
    for (const source of ['^a+$', '(?=a)', '[', 'a'.repeat(1_025), ']', '\\p{L}', '(a)\\1']) {
      expect(validate(source), source).toBe(compileTenantPattern(source).kind === 'ok');
    }
    // Without `u`, as `compileTenantPattern` reads a pattern with no flags:
    // `]` is the character, where with `u` V8 refuses it.
    expect(validate(']')).toBe(true);
    expect(tenantPatternSyntaxProblem(']', 'u')).toBe(
      'Invalid regular expression: /]/u: Lone quantifier brackets',
    );
    // RE2 refuses this only for its size, when it's compiled.
    expect(validate('a{1001}')).toBe(true);
    expect(compileTenantPattern('a{1001}').kind).toBe('refused');
  });

  test('`format: regex` builds no RE2 program per value: 2 MiB of them in linear time', () => {
    under(HOSTED_BOUNDS);
    const validate = compileJsonSchema({
      type: 'array',
      items: { type: 'string', format: 'regex' },
    });
    const values: string[] = [];
    let bytes = 2;
    for (let k = 0; bytes < 2 * 1024 * 1024; k += 1) {
      const value = `.{1000}.{1000}.{1000}${k}`;
      values.push(value);
      bytes += value.length + 3;
    }
    const started = performance.now();
    expect(validate(values)).toBe(true);
    // Building RE2's program for each value took about a minute.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('`format: url` gives ajv-formats’ verdicts, in linear time', () => {
    const urls = [
      'http://example.com',
      'https://user@example.com/a?b=c#d',
      'ftp://user:pass@example.com:21/x',
      'http://user:@example.com',
      'http://u:p:q@example.com',
      'http://:p@example.com',
      'http://@example.com',
      'http://a@b@example.com',
      'http://10.0.0.1',
      'http://192.0.2.1:8080/',
      'http://localhost',
      'http://exa mple.com',
      'mailto:a@example.com',
      'http://ex-ample.co.uk/',
      'http://-example.com',
    ];
    // Random strings around the user-info part, where the two differ in writing.
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const alphabet = ['a', 'b', ':', '@', '.', '/', '1', ' ', 'com', '-'];
    for (let run = 0; run < 5_000; run += 1) {
      const length = Math.floor(next() * 12);
      const middle = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]);
      urls.push(`http://${middle.join('')}.com`);
    }
    const hosted = boundedAjvFor(HOSTED_BOUNDS).compile({ type: 'string', format: 'url' });
    const full = boundedAjvFor(SELF_HOSTED_BOUNDS).compile({ type: 'string', format: 'url' });
    let valid = 0;
    for (const url of urls) {
      expect(hosted(url), url).toBe(full(url));
      if (full(url)) valid += 1;
    }
    expect(valid).toBeGreaterThan(500);
    // ajv-formats' own takes seconds on this at 128 KiB.
    const long = `ftp://a@${'urn:uuid:'.repeat(14_564)}!`;
    const started = performance.now();
    expect(hosted(long)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('formats are ajv-formats’ fast ones: a date is checked for its shape', () => {
    under(HOSTED_BOUNDS);
    const validate = compileJsonSchema({ type: 'string', format: 'date' });
    expect(validate('2026-02-30')).toBe(true);
    expect(validate('2026-2-3')).toBe(false);
  });

  test('format bounds compare in linear time: 1 MiB values of each shape', () => {
    under(HOSTED_BOUNDS);
    const n = 1024 * 1024;
    // What a compare parses or splits the longest: separators, and a long
    // fraction of a second. Each is compared whether its format holds or not.
    const values = [
      ' '.repeat(n),
      't'.repeat(n),
      ':'.repeat(n),
      `2020-01-01${' '.repeat(n)}`,
      `12:00:00.${'1'.repeat(n)}z`,
      `2020-01-01T12:00:00.${'1'.repeat(n)}x`,
    ];
    for (const [format, bound] of BOUNDED_FORMATS) {
      const validate = compileJsonSchema({
        type: 'string',
        format,
        formatMinimum: bound,
        formatMaximum: bound,
      });
      const started = performance.now();
      for (const value of values) validate(value);
      expect(performance.now() - started, format).toBeLessThan(1_000);
    }
  });

  test('`uniqueItems` is the linear one', () => {
    expect(boundedAjvFor(HOSTED_BOUNDS).getKeyword('uniqueItems')).toMatchObject({
      code: linearUniqueItems().code,
    });
  });

  test('Kindgi’s own schemas compile, their patterns on V8', async () => {
    under(HOSTED_BOUNDS);
    const registry = await loadSpecRegistry(SPECS_SCHEMAS_DIR);
    expect(registry.kind === 'err' ? registry.error : 'ok').toBe('ok');
  });

  test('every pattern in Kindgi’s own schemas runs on RE2 too, but these, linear on V8', () => {
    // A pattern here runs on a tenant's data on V8: each one is linear
    // there, and says why.
    const V8_ONLY: Readonly<Record<string, string>> = {
      // A fixed-length lookahead, then one loop over a class.
      '^(?!KINDGI_)[A-Za-z_][A-Za-z0-9_]*$': 'pack-index.schema.json',
    };
    under(HOSTED_BOUNDS);
    const refused: Record<string, string> = {};
    for (const file of readdirSync(SPECS_SCHEMAS_DIR).filter((f) => f.endsWith('.json'))) {
      const schema: unknown = JSON.parse(readFileSync(join(SPECS_SCHEMAS_DIR, file), 'utf8'));
      for (const pattern of patternsIn(schema)) {
        if (compileTenantPattern(pattern, 'u').kind === 'refused') refused[pattern] = file;
      }
    }
    expect(refused).toEqual(V8_ONLY);
  });
});

describe('on the self-hosted bounds', () => {
  test('patterns run on V8, formats are the full ones, `uniqueItems` is Ajv’s', () => {
    under(SELF_HOSTED_BOUNDS);
    expect(compileJsonSchema({ type: 'string', pattern: '^(?=a)a$' })('a')).toBe(true);
    expect(compileJsonSchema({ type: 'string', format: 'regex' })('(?=a)')).toBe(true);
    expect(compileJsonSchema({ type: 'string', format: 'date' })('2026-02-30')).toBe(false);
    expect(boundedAjvFor(SELF_HOSTED_BOUNDS).getKeyword('uniqueItems')).not.toMatchObject({
      code: linearUniqueItems().code,
    });
  });
});

/**
 * The formats ajv-formats compares, each with a bound, and a value before
 * it, one equal to it and one after it.
 */
const BOUNDED_FORMATS = [
  ['date', '2020-01-01', '2019-12-31', '2020-01-01', '2020-01-02'],
  ['time', '12:00:00Z', '11:59:59Z', '13:00:00+01:00', '12:00:01Z'],
  [
    'date-time',
    '2020-01-01T12:00:00Z',
    '2020-01-01T11:59:59Z',
    '2020-01-01T13:00:00+01:00',
    '2020-01-02T00:00:00Z',
  ],
  ['iso-time', '12:00:00', '11:59:59', '12:00:00', '12:00:01'],
  [
    'iso-date-time',
    '2020-01-01T12:00:00',
    '2019-12-31T23:59:59',
    '2020-01-01 12:00:00',
    '2020-01-02T00:00:00',
  ],
] as const;

/** Each format bound, and whether it lets through the value before, at and after it. */
const FORMAT_BOUNDS = {
  formatMinimum: [false, true, true],
  formatMaximum: [true, true, false],
  formatExclusiveMinimum: [false, false, true],
  formatExclusiveMaximum: [true, false, false],
} as const;

describe.each([
  ['hosted', HOSTED_BOUNDS],
  ['self-hosted', SELF_HOSTED_BOUNDS],
] as const)('format bounds (%s)', (_, bounds) => {
  test.each(BOUNDED_FORMATS)(
    '`%s`: each bound compiles, and compares',
    (format, bound, ...values) => {
      under(bounds);
      for (const [keyword, verdicts] of Object.entries(FORMAT_BOUNDS)) {
        const validate = compileJsonSchema({ type: 'string', format, [keyword]: bound });
        expect(
          values.map((value) => validate(value)),
          keyword,
        ).toEqual(verdicts);
      }
    },
  );

  test('a value past its bound: the bound’s error, naming the limit', () => {
    under(bounds);
    const validate = compileJsonSchema({
      type: 'string',
      format: 'date',
      formatMinimum: '2020-01-01',
    });
    expect(validate('2019-12-31')).toBe(false);
    expect(validate.errors).toEqual([
      expect.objectContaining({
        keyword: 'formatMinimum',
        params: { comparison: '>=', limit: '2020-01-01' },
      }),
    ]);
  });
});

/** A schema `levels` objects deep: `{ items: { items: … } }`. */
function nested(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let level = 1; level < levels; level += 1) schema = { type: 'array', items: schema };
  return schema;
}

describe.each([
  ['hosted', HOSTED_BOUNDS],
  ['self-hosted', SELF_HOSTED_BOUNDS],
] as const)('a schema is measured before it’s compiled (%s)', (_, bounds) => {
  test('nested `schemaMaxDepth` deep compiles; one more is refused', () => {
    under(bounds);
    expect(refusal(nested(bounds.schemaMaxDepth))).toBeUndefined();
    expect(refusal(nested(bounds.schemaMaxDepth + 1))).toBe(
      `The schema nests objects and arrays more than ${bounds.schemaMaxDepth} deep, the limit.`,
    );
  });

  test('over `schemaMaxBytes` as JSON: refused, saying its size', () => {
    under(bounds);
    const description = 'a'.repeat(bounds.schemaMaxBytes);
    const schema = { type: 'string', description };
    const bytes = Buffer.byteLength(JSON.stringify(schema));
    expect(refusal(schema)).toBe(
      `The schema is ${bytes} bytes as JSON, over the limit of ${bounds.schemaMaxBytes}.`,
    );
    const fits = { type: 'string', description: description.slice(bytes - bounds.schemaMaxBytes) };
    expect(Buffer.byteLength(JSON.stringify(fits))).toBe(bounds.schemaMaxBytes);
    expect(refusal(fits)).toBeUndefined();
  });

  test('a `$ref` is compiled once, where its target is, not copied into each use', () => {
    under(bounds);
    const uses = 150;
    const properties = (prefix: string, value: (k: number) => object) =>
      Object.fromEntries(Array.from({ length: uses }, (_, k) => [`${prefix}${k}`, value(k)]));
    const validate = compileJsonSchema({
      $defs: { item: { type: 'object', properties: properties('p', () => ({ type: 'string' })) } },
      type: 'object',
      properties: properties('r', () => ({ $ref: '#/$defs/item' })),
    });
    // Each use inlined, the code would be about 150 × 150 checks: over 2 MB.
    expect(validate.toString().length).toBeLessThan(200_000);
    expect(validate({ r0: { p0: 'a' }, r149: { p149: 'b' } })).toBe(true);
    expect(validate({ r149: { p149: 1 } })).toBe(false);
  });

  test('more values than its bytes could hold: refused before it’s written out', () => {
    under(bounds);
    const shared = { enum: Array.from({ length: 1_000 }, (_, k) => k) };
    const length = Math.ceil(bounds.schemaMaxBytes / 1_000);
    const schema = { anyOf: Array.from({ length }, () => shared) };
    expect(refusal(schema)).toBe(
      `The schema is more than ${bounds.schemaMaxBytes} bytes as JSON, the limit.`,
    );
  });
});

describe('a compiled schema is kept', () => {
  test('the same schema: the same validator', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const first = compileJsonSchema(schema);
    expect(compileJsonSchema(structuredClone(schema))).toBe(first);
    const inline = compileInlineSchema(structuredClone(schema));
    expect(inline.kind).toBe('ok');
  });

  test('keys in another order: another validator, with that order’s defaults', () => {
    const ab = compileJsonSchema(
      { type: 'object', properties: { a: { default: 1 }, b: { default: 2 } } },
      { useDefaults: true },
    );
    const ba = compileJsonSchema(
      { type: 'object', properties: { b: { default: 2 }, a: { default: 1 } } },
      { useDefaults: true },
    );
    expect(ba).not.toBe(ab);
    const filled: Record<string, unknown> = {};
    ba(filled);
    expect(Object.keys(filled)).toEqual(['b', 'a']);
  });

  test('the options are part of the key', () => {
    const schema = { type: 'object', properties: { a: { default: 1 } } };
    expect(compileJsonSchema(schema, { useDefaults: true })).not.toBe(compileJsonSchema(schema));
    expect(compileJsonSchema(schema, { strict: false })).not.toBe(compileJsonSchema(schema));
  });

  test('a schema that doesn’t compile throws the same error again', () => {
    const schema = { type: 'string', minLength: 'one' };
    let first: unknown;
    try {
      compileJsonSchema(schema);
    } catch (error) {
      first = error;
    }
    expect(first).toBeInstanceOf(Error);
    expect(() => compileJsonSchema(schema)).toThrow(first as Error);
    try {
      compileJsonSchema(schema);
    } catch (error) {
      expect(error).toBe(first);
    }
  });

  test('`schemaCacheEntries` kept, the least recently used dropped', () => {
    under({ ...SELF_HOSTED_BOUNDS, schemaCacheEntries: 2 });
    const schema = (n: number) => ({ type: 'string', maxLength: n });
    const one = compileJsonSchema(schema(1));
    const two = compileJsonSchema(schema(2));
    expect(compileJsonSchema(schema(1))).toBe(one);
    compileJsonSchema(schema(3));
    expect(compileJsonSchema(schema(1))).toBe(one);
    expect(compileJsonSchema(schema(2))).not.toBe(two);
  });

  test('`schemaCacheMaxBytes` of schema JSON kept, the least recently used dropped', () => {
    const schema = (n: number) => ({ type: 'string', maxLength: n });
    const bytes = JSON.stringify(schema(1)).length;
    under({ ...SELF_HOSTED_BOUNDS, schemaCacheMaxBytes: 2.5 * bytes });
    const one = compileJsonSchema(schema(1));
    const two = compileJsonSchema(schema(2));
    expect(compileJsonSchema(schema(1))).toBe(one);
    compileJsonSchema(schema(3));
    expect(compileJsonSchema(schema(1))).toBe(one);
    expect(compileJsonSchema(schema(2))).not.toBe(two);
  });

  test('a schema that doesn’t compile is kept, weighing nothing', () => {
    const schema = { type: 'string', maxLength: 1 };
    under({ ...SELF_HOSTED_BOUNDS, schemaCacheMaxBytes: JSON.stringify(schema).length });
    const one = compileJsonSchema(schema);
    for (const n of [1, 2, 3]) {
      expect(() => compileJsonSchema({ type: 'string', minLength: `${n}`.repeat(100) })).toThrow();
    }
    expect(compileJsonSchema(schema)).toBe(one);
  });

  test('other bounds: compiled again, under them', () => {
    under(SELF_HOSTED_BOUNDS);
    const schema = { type: 'string', pattern: '^a' };
    const v8 = compileJsonSchema(schema);
    under(HOSTED_BOUNDS);
    expect(compileJsonSchema(schema)).not.toBe(v8);
  });

  test('a kept inline schema holds its cache key, not its validator', () => {
    const schema = (n: number) => ({ type: 'string', maxLength: n });
    under({ ...SELF_HOSTED_BOUNDS, schemaCacheEntries: 1, schemaCompileBudgetMs: 0 });
    runAsTenant('tenant-a', () => {
      const kept = compileInlineSchema(schema(1));
      if (kept.kind !== 'ok') throw new Error('compiles');
      expect(kept.value.validate('a').kind).toBe('ok');
      // The cache drops it: validating compiles it again, a recompile the budget counts.
      compileJsonSchema(schema(2));
      expect(() => kept.value.validate('a')).toThrow(SchemaCompileBudgetError);
    });
    // Outside a tenant's scope nothing is counted: compiled again, it validates.
    const kept = compileInlineSchema(schema(1));
    if (kept.kind !== 'ok') throw new Error('compiles');
    compileJsonSchema(schema(2));
    expect(kept.value.validate('ab').kind).toBe('err');
  });

  test('a schema holding a value JSON can’t carry: compiled each time', () => {
    const schema = { type: 'string', description: undefined };
    expect(compileJsonSchema(schema)).not.toBe(compileJsonSchema(schema));
  });
});

describe('the compile budget', () => {
  const schema = (n: number) => ({ type: 'string', maxLength: n });

  /** Each compile takes 5 ms, by `performance.now`; `Date` is the test's. */
  function clocked(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 5;
      return now;
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('a recompile past it is refused; what’s kept still serves, and the refusal isn’t kept', () => {
    clocked();
    under({ ...SELF_HOSTED_BOUNDS, schemaCacheEntries: 1, schemaCompileBudgetMs: 1 });
    runAsTenant('tenant-a', () => {
      compileJsonSchema(schema(1));
      compileJsonSchema(schema(2));
      // Dropped for the second, so compiled again: it counts, and spends the budget.
      const one = compileJsonSchema(schema(1));
      expect(() => compileJsonSchema(schema(2))).toThrow(SchemaCompileBudgetError);
      expect(compileJsonSchema(schema(1))).toBe(one);
      vi.setSystemTime(Date.now() + 60_000);
      expect(compileJsonSchema(schema(2))).not.toBe(one);
    });
  });

  test('another tenant, or no tenant, has its own', () => {
    clocked();
    under({ ...SELF_HOSTED_BOUNDS, schemaCacheEntries: 1, schemaCompileBudgetMs: 1 });
    runAsTenant('tenant-a', () => compileJsonSchema(schema(1)), { compiles: 'all' });
    expect(() =>
      runAsTenant('tenant-a', () => compileJsonSchema(schema(2)), { compiles: 'all' }),
    ).toThrow(SchemaCompileBudgetError);
    // Thrown, not a compile's error: it isn't the schema's.
    expect(() =>
      runAsTenant('tenant-a', () => compileInlineSchema(schema(2)), { compiles: 'all' }),
    ).toThrow(SchemaCompileBudgetError);
    runAsTenant('tenant-b', () => compileJsonSchema(schema(2)), { compiles: 'all' });
    for (const n of [3, 4, 5]) compileJsonSchema(schema(n));
  });

  test('self-hosted, none', () => {
    clocked();
    under({ ...SELF_HOSTED_BOUNDS, schemaCacheEntries: 1 });
    runAsTenant(
      'tenant-a',
      () => {
        for (const n of [1, 2, 1, 2, 1]) compileJsonSchema(schema(n));
      },
      { compiles: 'all' },
    );
  });
});

/** Every `pattern` and `patternProperties` key in `schema`. */
function patternsIn(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const own = Object.entries(schema).flatMap(([key, value]) => {
    if (key === 'pattern' && typeof value === 'string') return [value];
    if (key === 'patternProperties' && typeof value === 'object' && value !== null) {
      return Object.keys(value);
    }
    return [];
  });
  return [...own, ...Object.values(schema).flatMap(patternsIn)];
}

function boundedAjvFor(bounds: TenantInputBounds) {
  under(bounds);
  return boundedAjv('2020-12', { strict: true, allErrors: true });
}

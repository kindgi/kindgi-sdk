// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A schema compiles in the dialect it declares: a draft-07 schema (what
 * the TypeScript MCP SDK emits) means draft-07's keywords, not 2020-12's.
 */

import { describe, expect, test } from 'vitest';

import {
  ALLOW_UNION_TYPES,
  compileInlineSchema,
  compileJsonSchema,
  createSpecRegistry,
  jsonSchemaDialect,
} from '../src/index.js';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** A pair of numbers, as draft-07 (and 2019-09) write a tuple. */
const pairItems = { type: 'array', items: [{ type: 'number' }, { type: 'number' }], minItems: 2 };

describe('jsonSchemaDialect', () => {
  test('2020-12 when the schema declares none', () => {
    expect(jsonSchemaDialect({ type: 'object' })).toBe('2020-12');
  });

  test('each supported $schema, with or without its trailing #', () => {
    for (const [uri, dialect] of [
      ['http://json-schema.org/draft-06/schema', 'draft-06'],
      ['http://json-schema.org/draft-07/schema', 'draft-07'],
      ['https://json-schema.org/draft/2019-09/schema', '2019-09'],
      ['https://json-schema.org/draft/2020-12/schema', '2020-12'],
    ] as const) {
      expect(jsonSchemaDialect({ $schema: uri })).toBe(dialect);
      expect(jsonSchemaDialect({ $schema: `${uri}#` })).toBe(dialect);
    }
  });

  test('another dialect is refused, naming it and the ones supported', () => {
    expect(() => jsonSchemaDialect({ $schema: 'http://json-schema.org/draft-04/schema#' })).toThrow(
      `The schema's $schema "http://json-schema.org/draft-04/schema#" isn't a JSON Schema dialect Kindgi validates: draft-06, draft-07, 2019-09 or 2020-12.`,
    );
    expect(() => jsonSchemaDialect({ $schema: 7 })).toThrow(/\$schema 7 isn't a JSON Schema/);
  });
});

describe('compileJsonSchema', () => {
  test('draft-07: an array-form items is a tuple', () => {
    const validate = compileJsonSchema({ $schema: DRAFT_07, ...pairItems }, { strict: false });
    expect(validate([1, 2])).toBe(true);
    expect(validate([1, 'two'])).toBe(false);
  });

  test('2020-12 has no array-form items (prefixItems instead), so the same schema is refused', () => {
    expect(() => compileJsonSchema(pairItems, { strict: false })).toThrow(/items/);
    const validate = compileJsonSchema({
      type: 'array',
      prefixItems: [{ type: 'number' }, { type: 'number' }],
      items: false,
      minItems: 2,
    });
    expect(validate([1, 'two'])).toBe(false);
  });

  test('draft-07: definitions and $ref', () => {
    const validate = compileJsonSchema({
      $schema: DRAFT_07,
      definitions: { city: { type: 'string', enum: ['Paris', 'Lima'] } },
      type: 'object',
      properties: { city: { $ref: '#/definitions/city' } },
      required: ['city'],
    });
    expect(validate({ city: 'Lima' })).toBe(true);
    expect(validate({ city: 'Oslo' })).toBe(false);
  });

  test('draft-07: formats are checked', () => {
    const validate = compileJsonSchema({ $schema: DRAFT_07, type: 'string', format: 'email' });
    expect(validate('a@example.com')).toBe(true);
    expect(validate('not an email')).toBe(false);
  });

  test('draft-06 and 2019-09 compile in their own dialects', () => {
    const draft06 = compileJsonSchema({
      $schema: 'http://json-schema.org/draft-06/schema#',
      type: 'array',
      contains: { const: 'x' },
    });
    expect(draft06(['a', 'x'])).toBe(true);
    expect(draft06(['a'])).toBe(false);

    const draft201909 = compileJsonSchema(
      { $schema: 'https://json-schema.org/draft/2019-09/schema', ...pairItems },
      { strict: false },
    );
    expect(draft201909([1, 'two'])).toBe(false);
  });

  test('dialects limits the ones a schema may declare', () => {
    const only2020 = { dialects: ['2020-12'] } as const;
    expect(() => compileJsonSchema({ type: 'string' }, only2020)).not.toThrow();
    expect(() => compileJsonSchema({ $schema: DRAFT_07, type: 'string' }, only2020)).toThrow(
      `The schema's $schema "${DRAFT_07}" isn't a JSON Schema dialect Kindgi validates here: 2020-12.`,
    );
    expect(() =>
      jsonSchemaDialect({ $schema: DRAFT_07 }, ['draft-06', '2019-09', '2020-12']),
    ).toThrow(/validates here: draft-06, 2019-09 or 2020-12\.$/);
  });

  test('an unsupported dialect throws rather than validating by another', () => {
    expect(() =>
      compileJsonSchema({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'string' }),
    ).toThrow(/isn't a JSON Schema dialect Kindgi validates/);
  });

  test('strict (the default) refuses what is valid JSON Schema but loosely written; lenient compiles it', () => {
    const loose = { $schema: DRAFT_07, type: 'array', items: [{ type: 'number' }] };
    const extension = { $schema: DRAFT_07, type: 'string', 'x-label': 'Name' };
    for (const schema of [loose, extension]) {
      expect(() => compileJsonSchema(schema), JSON.stringify(schema)).toThrow(/strict mode/);
      expect(() => compileJsonSchema(schema, { strict: false })).not.toThrow();
    }
    // A union of types isn't loose: both modes take it.
    const union = { $schema: DRAFT_07, type: ['string', 'number'] };
    for (const strict of [true, false]) {
      const validate = compileJsonSchema(union, { strict });
      expect(validate(3)).toBe(true);
      expect(validate(null)).toBe(false);
    }
  });

  test('useDefaults fills in defaults, in any dialect', () => {
    const validate = compileJsonSchema(
      {
        $schema: DRAFT_07,
        type: 'object',
        properties: { units: { type: 'string', default: 'metric' } },
      },
      { useDefaults: true },
    );
    const data: Record<string, unknown> = {};
    expect(validate(data)).toBe(true);
    expect(data).toEqual({ units: 'metric' });
  });
});

describe('a union of types (`type: [...]`)', () => {
  // What Zod 4 writes for `z.union([z.string(), z.number(), z.boolean(), z.null()])`.
  const scalar = {
    type: 'object',
    properties: { value: { type: ['string', 'number', 'boolean', 'null'] } },
    required: ['value'],
    additionalProperties: false,
  };

  test('every compiler takes it, strict or not, and validates by it', () => {
    const strict = compileJsonSchema(scalar);
    const loose = compileJsonSchema(scalar, { strict: false });
    const inline = compileInlineSchema(scalar);
    if (inline.kind !== 'ok') throw new Error(inline.error.message);
    for (const value of ['a', 1, true, null]) {
      expect(strict({ value }), String(value)).toBe(true);
      expect(loose({ value }), String(value)).toBe(true);
      expect(inline.value.validate({ value }).kind, String(value)).toBe('ok');
    }
    expect(strict({ value: [1] })).toBe(false);
    expect(inline.value.validate({ value: {} }).kind).toBe('err');
    expect(ALLOW_UNION_TYPES).toBe(true);
  });

  test('a spec registry takes it too', () => {
    const registry = createSpecRegistry([{ $id: 'https://specs.example/scalar.json', ...scalar }]);
    expect(registry.kind).toBe('ok');
  });
});

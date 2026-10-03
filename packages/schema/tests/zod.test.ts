// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';
import * as z from 'zod';

import {
  isJsonSchemaObject,
  isZodSchema,
  loadZodConverter,
  parseWithSchema,
  schemaKindOf,
  toJSONSchema,
  toJSONSchemaSync,
} from '../src/index.js';

describe('@kindgi/schema — Zod-optional utils', () => {
  test('isZodSchema detects Zod v4 schemas structurally', () => {
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema(z.object({ a: z.number() }))).toBe(true);
  });

  test('isZodSchema rejects JSON Schema objects + plain values', () => {
    expect(isZodSchema({ type: 'string' })).toBe(false);
    expect(isZodSchema({ properties: { a: { type: 'number' } } })).toBe(false);
    expect(isZodSchema(null)).toBe(false);
    expect(isZodSchema('string')).toBe(false);
    expect(isZodSchema(undefined)).toBe(false);
  });

  test('isJsonSchemaObject narrows to plain objects, excludes Zod', () => {
    expect(isJsonSchemaObject({ type: 'string' })).toBe(true);
    expect(isJsonSchemaObject(z.string())).toBe(false);
    expect(isJsonSchemaObject(null)).toBe(false);
    expect(isJsonSchemaObject(42)).toBe(false);
  });

  test('schemaKindOf routes on authoring surface', () => {
    expect(schemaKindOf(z.string())).toBe('zod');
    expect(schemaKindOf({ type: 'string' })).toBe('json-schema');
  });

  test('toJSONSchema passes JSON Schema objects through unchanged', async () => {
    const input = { type: 'object', properties: { a: { type: 'string' } } } as const;
    const result = await toJSONSchema(input, 'output');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toBe(input);
    }
  });

  test('toJSONSchema converts Zod schemas via z.toJSONSchema()', async () => {
    const schema = z.object({ name: z.string(), age: z.number().int() });
    const result = await toJSONSchema(schema, 'output');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toMatchObject({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
      });
    }
  });

  test('toJSONSchemaSync converts when converter is provided', async () => {
    const converter = await loadZodConverter();
    expect(converter).toBeDefined();
    const schema = z.string();
    const result = toJSONSchemaSync(schema, converter, 'output');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toMatchObject({ type: 'string' });
    }
  });

  test('toJSONSchemaSync returns clean error when converter missing for Zod input', () => {
    const schema = z.string();
    const result = toJSONSchemaSync(schema, undefined, 'output');
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('invalid-zod-conversion');
      expect(result.error.message).toContain('zod');
    }
  });

  test('toJSONSchemaSync passes JSON Schema through without needing converter', () => {
    const input = { type: 'number' } as const;
    const result = toJSONSchemaSync(input, undefined, 'output');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toBe(input);
    }
  });

  test('toJSONSchema surfaces unrepresentable Zod constructs as invalid-zod-conversion', async () => {
    // z.function() has no direct JSON Schema equivalent and z.toJSONSchema throws by default.
    const schema = z.function();
    const result = await toJSONSchema(schema, 'output');
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('invalid-zod-conversion');
    }
  });
});

describe('io: the input and output sides of a schema', () => {
  const schema = z.object({ name: z.string(), greeting: z.string().default('Kia ora') });

  test('input: a defaulted field is optional; output: it is required', async () => {
    const input = await toJSONSchema(schema, 'input');
    const output = await toJSONSchema(schema, 'output');
    if (input.kind === 'err' || output.kind === 'err') throw new Error('conversion failed');
    expect(input.value.required).toEqual(['name']);
    expect(output.value.required).toEqual(['name', 'greeting']);
    expect(
      (input.value.properties as Record<string, { default?: unknown }>).greeting?.default,
    ).toBe('Kia ora');
  });

  test('the sync variant passes io to the converter', async () => {
    const converter = await loadZodConverter();
    const input = toJSONSchemaSync(schema, converter, 'input');
    if (input.kind === 'err') throw new Error('conversion failed');
    expect(input.value.required).toEqual(['name']);
  });
});

describe('parseWithSchema', () => {
  test('fills defaults, applies transforms', async () => {
    const schema = z.object({
      name: z.string().transform((s) => s.trim()),
      greeting: z.string().default('Kia ora'),
    });
    expect(await parseWithSchema(schema, { name: '  Ada ' })).toEqual({
      kind: 'ok',
      value: { name: 'Ada', greeting: 'Kia ora' },
    });
  });

  test('reports refinement failures as issues with their path', async () => {
    const schema = z.object({ n: z.number().refine((v) => v > 0, 'must be positive') });
    expect(await parseWithSchema(schema, { n: -1 })).toEqual({
      kind: 'err',
      issues: [{ message: 'must be positive', path: ['n'] }],
    });
  });
});

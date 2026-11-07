// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { afterEach, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { z as z3 } from 'zod/v3';

import {
  type AnySchema,
  isJsonSchemaObject,
  isZodSchema,
  loadZodConverter,
  toJSONSchema,
  toJSONSchemaSync,
} from '../src/index.js';
import { __resetZodConverterCacheForTests } from '../src/zod.js';

/** zod 3's API, from zod 4's own `zod/v3`: `_def` and `safeParse`, no `_zod`, as in zod 3.x. */
const zod3Object = z3.object({ orderId: z3.string() }) as unknown as AnySchema;
/** One as zod before 3.24 made it, with no `~standard`. */
const zod3String = { _def: { typeName: 'ZodString' }, safeParse: () => ({ success: true }) };

const ZOD3_MESSAGE =
  "The schema is from zod 3 (the zod 3.x package, or `zod/v3`), and Kindgi takes zod 4 schemas: write it as a JSON Schema object, e.g. `{ type: 'object', additionalProperties: false, required: ['orderId'], properties: { orderId: { type: 'string' } } }`, or import `z` from `zod` 4 (>=4.0.0).";

describe('a schema from zod 3', () => {
  test.each([
    ['zod/v3', zod3Object],
    ['before zod 3.24', zod3String],
  ])('both converters refuse it by name, with the JSON Schema way (%s)', async (_which, schema) => {
    const results = [
      toJSONSchemaSync(schema, undefined, 'input'),
      await toJSONSchema(schema, 'output'),
    ];
    for (const result of results) {
      expect(result.kind).toBe('err');
      if (result.kind !== 'err') continue;
      expect(result.error.code).toBe('invalid-zod-conversion');
      expect(result.error.message).toBe(ZOD3_MESSAGE);
      expect((result.error.cause as Error).message).toBe('zod 3 schema');
    }
  });

  test("isn't a JSON Schema object", () => {
    expect(isJsonSchemaObject(zod3Object)).toBe(false);
    expect(isJsonSchemaObject(zod3String)).toBe(false);
  });

  test('a JSON Schema object with a `_def` key, and no function, still passes as is', () => {
    const json = { type: 'object', _def: { note: 'a keyword of its own' } };
    expect(isJsonSchemaObject(json)).toBe(true);
    expect(toJSONSchemaSync(json, undefined, 'input')).toEqual({ kind: 'ok', value: json });
  });

  test('a value with `_zod` is never called zod 3', () => {
    // Not a zod 4 schema either (no `~standard`), so it goes on as is, to the compiler.
    const value = { _zod: {}, _def: {}, safeParse: () => ({ success: true }) };
    expect(toJSONSchemaSync(value, undefined, 'input')).toEqual({ kind: 'ok', value });
  });

  test('a zod 4 schema, with its own `_def` and `safeParse`, is still zod 4 and converts', async () => {
    const schema = z.object({ orderId: z.string() });
    expect(isZodSchema(schema)).toBe(true);
    expect(isJsonSchemaObject(schema)).toBe(false);
    const result = toJSONSchemaSync(schema, await loadZodConverter(), 'input');
    expect(result).toMatchObject({ kind: 'ok', value: { type: 'object', required: ['orderId'] } });
  });
});

describe('the installed zod, as the load finds it', () => {
  afterEach(() => {
    vi.doUnmock('zod');
    __resetZodConverterCacheForTests();
  });

  /**
   * zod 3's own module: no `toJSONSchema`. It's named, as undefined, since a
   * mock refuses an export it doesn't define.
   */
  function installZod3(): void {
    vi.doMock('zod', () => ({ toJSONSchema: undefined, z: {} }));
    __resetZodConverterCacheForTests();
  }

  test('a zod 4 schema (`zod/v4` from zod 3) is told the installed zod is older, not missing', async () => {
    installZod3();
    expect(await loadZodConverter()).toBeUndefined();
    const schema = z.object({ orderId: z.string() });
    const results = [
      await toJSONSchema(schema, 'input'),
      toJSONSchemaSync(schema, undefined, 'input'),
    ];
    for (const result of results) {
      expect(result.kind).toBe('err');
      if (result.kind !== 'err') continue;
      expect(result.error.code).toBe('invalid-zod-conversion');
      expect(result.error.message).toBe(
        "Zod schema passed but the installed `zod` is older than zod 4: it has no `toJSONSchema`, and `zod/v4` from zod 3 isn't enough. Install `zod` (>=4.0.0) or author with a JSON Schema object.",
      );
      expect((result.error.cause as Error).message).toBe('zod before 4 installed');
    }
  });

  test('a reset forgets it: with no converter loaded, zod is not installed', async () => {
    installZod3();
    await loadZodConverter();
    __resetZodConverterCacheForTests();
    const result = toJSONSchemaSync(z.string(), undefined, 'input');
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.message).toBe(
        'Zod schema passed but the `zod` peer dependency is not installed. Install `zod` (>=4.0.0) or author with a JSON Schema object.',
      );
      expect((result.error.cause as Error).message).toBe('zod peer dep not installed');
    }
  });

  test("a zod that won't load: the error keeps what loading it threw", async () => {
    const broken = new Error('a broken zod install');
    vi.doMock('zod', () => {
      throw broken;
    });
    __resetZodConverterCacheForTests();
    expect(await loadZodConverter()).toBeUndefined();
    const result = toJSONSchemaSync(z.string(), undefined, 'input');
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.message).toBe(
      'Zod schema passed but the `zod` peer dependency is not installed. Install `zod` (>=4.0.0) or author with a JSON Schema object.',
    );
    // The thrown error itself, or an error naming it as its cause: vitest wraps a mock's throw.
    const causes: unknown[] = [];
    let cause: unknown = result.error.cause;
    for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
      causes.push(cause);
      cause = (cause as { cause?: unknown }).cause;
    }
    expect(causes).toContain(broken);
  });

  test('with zod 4 back, the converter loads and converts', async () => {
    installZod3();
    await loadZodConverter();
    vi.doUnmock('zod');
    __resetZodConverterCacheForTests();
    const converter = await loadZodConverter();
    expect(typeof converter).toBe('function');
    const result = toJSONSchemaSync(z.object({ orderId: z.string() }), converter, 'input');
    expect(result.kind).toBe('ok');
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { compileInlineSchema, createSpecRegistry } from './registry.js';

const flowSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://kindgi.com/schemas/v1/test-flow.schema.json',
  $comment: 'schema-version: 1.0.0',
  title: 'TestGraph',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'nodes'],
  properties: {
    id: { type: 'string', minLength: 1 },
    nodes: { type: 'array', items: { type: 'string' } },
  },
};

const toolSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://kindgi.com/schemas/v1/test-tool.schema.json',
  $comment: 'schema-version: 1.0.0',
  title: 'TestTool',
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string' },
  },
};

// A pack schema that references the tool schema by $id — this exercises
// cross-schema $ref resolution, the whole reason for two-pass registration.
const packSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://kindgi.com/schemas/v1/test-pack.schema.json',
  $comment: 'schema-version: 1.0.0',
  title: 'TestPack',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tools'],
  properties: {
    id: { type: 'string' },
    tools: {
      type: 'array',
      items: { $ref: 'https://kindgi.com/schemas/v1/test-tool.schema.json' },
    },
  },
};

describe('createSpecRegistry', () => {
  test('empty registry succeeds with no schemas', () => {
    const result = createSpecRegistry([]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.ids()).toEqual([]);
    }
  });

  test('registers schemas and exposes their $ids', () => {
    const result = createSpecRegistry([flowSchema, toolSchema]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.ids()).toEqual([
        'https://kindgi.com/schemas/v1/test-flow.schema.json',
        'https://kindgi.com/schemas/v1/test-tool.schema.json',
      ]);
    }
  });

  test('rejects a schema missing $id', () => {
    const result = createSpecRegistry([{ type: 'object' }]);
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('schema-compile-error');
      expect(result.error.message).toContain('$id');
    }
  });

  test('rejects a non-object schema', () => {
    const result = createSpecRegistry(['not-a-schema']);
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('schema-compile-error');
    }
  });

  test('resolves cross-schema $refs when all schemas are registered together', () => {
    const result = createSpecRegistry([toolSchema, packSchema]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const packOk = result.value.validate('https://kindgi.com/schemas/v1/test-pack.schema.json', {
        id: 'p',
        tools: [{ id: 't1' }],
      });
      expect(packOk.kind).toBe('ok');
    }
  });
});

describe('compileInlineSchema', () => {
  test('compiles a minimal valid schema', () => {
    const r = compileInlineSchema({ type: 'object' });
    expect(r.kind).toBe('ok');
  });

  test('returns err on a schema with an unknown keyword (strict mode)', () => {
    const r = compileInlineSchema({ thisIsNotAJsonSchemaKeyword: true });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-compile-error');
  });

  test('returns err on a non-object schema', () => {
    const r = compileInlineSchema('not-a-schema');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-compile-error');
  });

  test('validate() accepts conforming data', () => {
    const r = compileInlineSchema({
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: { name: { type: 'string' } },
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const ok = r.value.validate({ name: 'alice' });
    expect(ok.kind).toBe('ok');
  });

  test('validate() rejects data that violates the schema', () => {
    const r = compileInlineSchema({
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: { name: { type: 'string' } },
    });
    if (r.kind !== 'ok') throw new Error('compile failed');
    const bad = r.value.validate({});
    expect(bad.kind).toBe('err');
    if (bad.kind === 'err') expect(bad.error.code).toBe('validation-error');
  });

  test('validate() returns the input value on success (identity, cast to T)', () => {
    const r = compileInlineSchema({ type: 'object' });
    if (r.kind !== 'ok') throw new Error('compile failed');
    const input = { hello: 'world' };
    const ok = r.value.validate<{ hello: string }>(input);
    if (ok.kind === 'ok') {
      expect(ok.value).toBe(input);
      expect(ok.value.hello).toBe('world');
    }
  });

  test('source is round-trippable', () => {
    const schema = { type: 'object' };
    const r = compileInlineSchema(schema);
    if (r.kind !== 'ok') throw new Error('compile failed');
    expect(r.value.source).toBe(schema);
  });
});

describe('SpecRegistry.validate', () => {
  test('accepts data that matches the schema', () => {
    const setup = createSpecRegistry([flowSchema]);
    if (setup.kind === 'err') throw new Error('setup failed');
    const result = setup.value.validate('https://kindgi.com/schemas/v1/test-flow.schema.json', {
      id: 'g1',
      nodes: ['a', 'b'],
    });
    expect(result.kind).toBe('ok');
  });

  test('rejects data that fails the schema with a validation-error', () => {
    const setup = createSpecRegistry([flowSchema]);
    if (setup.kind === 'err') throw new Error('setup failed');
    const result = setup.value.validate('https://kindgi.com/schemas/v1/test-flow.schema.json', {
      id: '',
      nodes: 'not-an-array',
    });
    expect(result.kind).toBe('err');
    if (result.kind === 'err' && result.error.code === 'validation-error') {
      expect(result.error.errors.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected validation-error');
    }
  });

  test('returns schema-not-found for an unknown $id', () => {
    const setup = createSpecRegistry([flowSchema]);
    if (setup.kind === 'err') throw new Error('setup failed');
    const result = setup.value.validate('https://kindgi.com/schemas/v1/nope.schema.json', {});
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('schema-not-found');
    }
  });
});

describe('SpecRegistry.getSchema', () => {
  test('returns the raw schema for a known $id', () => {
    const setup = createSpecRegistry([flowSchema]);
    if (setup.kind === 'err') throw new Error('setup failed');
    const result = setup.value.getSchema('https://kindgi.com/schemas/v1/test-flow.schema.json');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toBe(flowSchema);
    }
  });

  test('returns schema-not-found for an unknown $id', () => {
    const setup = createSpecRegistry([]);
    if (setup.kind === 'err') throw new Error('setup failed');
    const result = setup.value.getSchema('https://kindgi.com/schemas/v1/nope.schema.json');
    expect(result.kind).toBe('err');
  });
});

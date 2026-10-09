// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A data block's definition: a dotted id, a plain semver version, and
 * content for its kind. A prompt's template parses as Liquid and its
 * parameters follow an agent's rules; settings values are an object that
 * satisfies the block's schema when it has one.
 */

import { describe, expect, test } from 'vitest';

import { settingsSchemaIssues, tunableKeys, validateBlock } from '../src/index.js';

const issues = (input: unknown) => {
  const r = validateBlock(input);
  return r.kind === 'err' ? r.error.issues.map((i) => i.path) : [];
};

describe('validateBlock', () => {
  test('a prompt and a settings block are valid', () => {
    expect(
      validateBlock({
        id: 'acme.intake-prompt',
        version: '1.0.0',
        kind: 'prompt',
        content: { template: 'Hello {{ firm }}', parameters: [{ name: 'firm', type: 'string' }] },
      }).kind,
    ).toBe('ok');
    expect(
      validateBlock({
        id: 'acme.weights',
        version: '1.0.0',
        kind: 'settings',
        content: { values: { recency: 0.3 }, schema: { type: 'object' } },
        description: 'Weights',
      }),
    ).toMatchObject({ kind: 'ok', value: { description: 'Weights' } });
  });

  test('the id, version and kind are checked', () => {
    expect(issues({ id: 'Acme', version: '1.0', kind: 'other' })).toEqual([
      '/id',
      '/version',
      '/kind',
    ]);
  });

  test("a prompt's template must parse as Liquid, and its parameters follow an agent's rules", () => {
    expect(
      issues({
        id: 'acme.p',
        version: '1.0.0',
        kind: 'prompt',
        content: { template: '{% if %}', parameters: [{ name: 'today', type: 'string' }] },
      }),
    ).toEqual(['/content/template', '/content/parameters/0/name']);
  });

  test('settings values are an object satisfying the schema', () => {
    expect(
      issues({ id: 'acme.s', version: '1.0.0', kind: 'settings', content: { values: [] } }),
    ).toEqual(['/content/values']);
    expect(
      issues({
        id: 'acme.s',
        version: '1.0.0',
        kind: 'settings',
        content: {
          values: { a: 'x' },
          schema: { type: 'object', properties: { a: { type: 'number' } } },
        },
      }),
    ).toEqual(['/content/values/a']);
    expect(settingsSchemaIssues({ a: 1 }, { type: 'object', required: ['b'] })).toHaveLength(1);
  });
});

describe('tunable settings keys', () => {
  const block = (properties: Record<string, unknown>, values: Record<string, unknown> = {}) =>
    validateBlock({
      id: 'acme.weights',
      version: '1.0.0',
      kind: 'settings',
      content: { values, schema: { type: 'object', properties } },
    });

  test('a bounded number, an integer and an enum may be marked; tunableKeys lists them', () => {
    const properties = {
      recency: { type: 'number', minimum: 0, maximum: 1, 'x-kindgi-tunable': true },
      topN: { type: 'integer', minimum: 1, maximum: 20, 'x-kindgi-tunable': true },
      tone: { enum: ['plain', 'formal'], 'x-kindgi-tunable': true },
      floor: { type: 'number', minimum: 0, maximum: 1 },
    };
    const r = block(properties, { recency: 0.3, topN: 5, tone: 'plain', floor: 0.1 });
    expect(r.kind).toBe('ok');
    expect(tunableKeys({ type: 'object', properties })).toEqual([
      { key: 'recency', kind: 'number', minimum: 0, maximum: 1 },
      { key: 'topN', kind: 'integer', minimum: 1, maximum: 20 },
      { key: 'tone', kind: 'enum', values: ['plain', 'formal'] },
    ]);
  });

  test.each([
    ['a number without a maximum', { type: 'number', minimum: 0, 'x-kindgi-tunable': true }],
    ['a string', { type: 'string', 'x-kindgi-tunable': true }],
    ['an enum of one', { enum: ['plain'], 'x-kindgi-tunable': true }],
    [
      'a mark that is not true',
      { type: 'number', minimum: 0, maximum: 1, 'x-kindgi-tunable': 'yes' },
    ],
  ])('marking %s is refused at publish', (_name, prop) => {
    const r = block({ k: prop });
    expect(r.kind === 'err' && r.error.issues.map((i) => i.path)).toEqual([
      '/content/schema/properties/k/x-kindgi-tunable',
    ]);
  });

  test('nothing is tunable unless marked, and a schema-less block has none', () => {
    expect(
      tunableKeys({
        type: 'object',
        properties: { a: { type: 'number', minimum: 0, maximum: 1 } },
      }),
    ).toEqual([]);
    expect(tunableKeys(undefined)).toEqual([]);
  });
});

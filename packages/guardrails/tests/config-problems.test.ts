// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  describeGuardrailConfigProblems,
  guardrailConfigProblems,
  validateGuardrailSpec,
} from '../src/index.js';

const SCHEMA = {
  type: 'object',
  properties: { maxChars: { type: 'integer', exclusiveMinimum: 0, default: 500 } },
  required: ['maxChars'],
  additionalProperties: false,
};

const input = (config: unknown) => ({ configSchema: SCHEMA, config });
const named = { guardrailId: 'acme.strict-length', check: 'my-pack.checks.answer-length' };

describe('guardrailConfigProblems', () => {
  test('a config that fits: none', () => {
    expect(guardrailConfigProblems(input({ maxChars: 60 }))).toEqual([]);
  });

  test('each issue: a JSON pointer into the guardrail, and what is wrong there', () => {
    expect(guardrailConfigProblems(input({ maxChars: -5, extra: true }))).toEqual([
      { path: '/config', message: 'must NOT have additional properties' },
      { path: '/config/maxChars', message: 'must be > 0' },
    ]);
  });

  test('checked as declared: a default does not stand in for a required setting', () => {
    expect(guardrailConfigProblems(input(undefined))).toEqual([
      { path: '/config', message: "must have required property 'maxChars'" },
    ]);
  });

  test("a schema that doesn't compile: none (the pack's to fix; its pack service refuses every call)", () => {
    expect(
      guardrailConfigProblems({
        ...input({ maxChars: -5 }),
        configSchema: { type: 'no-such-type' },
      }),
    ).toEqual([]);
  });

  test('a keyword Ajv does not know does not stop the check', () => {
    const annotated = { ...SCHEMA, 'x-generator': 'pydantic' };
    expect(
      guardrailConfigProblems({ ...input({ maxChars: 0 }), configSchema: annotated }).map(
        (p) => p.path,
      ),
    ).toEqual(['/config/maxChars']);
  });
});

describe('describeGuardrailConfigProblems', () => {
  test('the guardrail, the check and the first problem, worded as the indexer words it', () => {
    expect(
      describeGuardrailConfigProblems(named, [
        { path: '/config/maxChars', message: 'must be > 0' },
      ]),
    ).toBe(
      'Guardrail "acme.strict-length"\'s config doesn\'t fit check "my-pack.checks.answer-length"\'s configSchema at /maxChars: must be > 0',
    );
  });

  test('at the root, no location; more than one, how many more', () => {
    expect(
      describeGuardrailConfigProblems(named, [
        { path: '/config', message: "must have required property 'maxChars'" },
        { path: '/config/mode', message: 'must be string' },
      ]),
    ).toBe(
      "Guardrail \"acme.strict-length\"'s config doesn't fit check \"my-pack.checks.answer-length\"'s configSchema: must have required property 'maxChars' (and 1 more)",
    );
  });
});

describe('Guardrail.configSchema', () => {
  test('the spec takes it', () => {
    const spec = {
      id: 'my-pack.answer-length',
      kind: 'zero-llm',
      check: 'my-pack.checks.answer-length',
      action: { 'on-violation': 'halt' },
      configSchema: SCHEMA,
    };
    const r = validateGuardrailSpec(spec);
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.value.configSchema).toEqual(SCHEMA);
  });
});

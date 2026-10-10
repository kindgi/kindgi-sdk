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

  test('each issue: a JSON pointer into the guardrail, and the setting with what it takes', () => {
    expect(guardrailConfigProblems(input({ maxChars: -5, extra: true }))).toEqual([
      { path: '/config', message: 'config must NOT have additional properties.' },
      { path: '/config/maxChars', message: 'config.maxChars must be > 0.' },
    ]);
  });

  test('checked as declared: a default does not stand in for a required setting', () => {
    expect(guardrailConfigProblems(input(undefined))).toEqual([
      { path: '/config', message: "config must have required property 'maxChars'." },
    ]);
  });

  test('a nested setting is named by its steps', () => {
    const nested = {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          items: { type: 'object', properties: { 'a/b': { type: 'string' } } },
        },
      },
    };
    expect(
      guardrailConfigProblems({ configSchema: nested, config: { rules: [{ 'a/b': 1 }] } }),
    ).toEqual([{ path: '/config/rules/0/a~1b', message: 'config.rules.0.a/b must be string.' }]);
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
  test('one sentence: the guardrail, the check and the first problem', () => {
    expect(
      describeGuardrailConfigProblems(named, [
        { path: '/config/maxChars', message: 'config.maxChars must be > 0.' },
      ]),
    ).toBe(
      'Guardrail "acme.strict-length" doesn\'t fit check "my-pack.checks.answer-length": config.maxChars must be > 0.',
    );
  });

  test('more than one: how many more', () => {
    expect(
      describeGuardrailConfigProblems(named, [
        { path: '/config', message: "config must have required property 'maxChars'." },
        { path: '/config/mode', message: 'config.mode must be string.' },
      ]),
    ).toBe(
      'Guardrail "acme.strict-length" doesn\'t fit check "my-pack.checks.answer-length": config must have required property \'maxChars\' (and 1 more).',
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

describe('Guardrail.checkBuiltIn', () => {
  const naming = {
    id: 'my-pack.grounded',
    kind: 'zero-llm',
    check: 'must-cite',
    action: { 'on-violation': 'halt' },
    codeArtifactRef: { kind: 'filesystem', modulePath: 'guardrails/grounded.ts' },
  };

  test('the spec takes the marker (true), and only true', () => {
    const marked = validateGuardrailSpec({ ...naming, checkBuiltIn: true });
    expect(marked.kind === 'ok' && marked.value.checkBuiltIn).toBe(true);
    expect(validateGuardrailSpec({ ...naming, checkBuiltIn: false }).kind).toBe('err');
    expect(validateGuardrailSpec(naming).kind).toBe('ok');
  });
});

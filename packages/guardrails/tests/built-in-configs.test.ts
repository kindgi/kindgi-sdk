// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The built-in checks' configs: each publishes its JSON Schema, refuses a config that doesn't
 * fit it (a missing setting, a wrong type, a setting it doesn't know, a regex that won't
 * compile), and the zero-llm strategy treats a refused config as a check that can't run.
 */

import { describe, expect, test } from 'vitest';

import type { GuardrailId, RunId, TenantId } from '@kindgi/types';

import {
  BUILT_IN_CHECK_IDS,
  type Guardrail,
  type RunTrace,
  createCheckRegistry,
  evaluateGuardrail,
} from '../src/index.js';

const registry = createCheckRegistry();
const problemsOf = (id: string, config: unknown) =>
  registry.get(id)?.configProblems?.(config) ?? ['no configProblems'];

describe('each built-in publishes its config schema and checks a config against it', () => {
  test('every built-in has a schema, configProblems and validateConfig', () => {
    for (const id of BUILT_IN_CHECK_IDS) {
      const check = registry.get(id);
      expect(check?.configSchema, id).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(typeof check?.configProblems, id).toBe('function');
      expect(typeof check?.validateConfig, id).toBe('function');
    }
  });

  test.each([
    ['must-cite', {}],
    ['must-cite', { minCitations: 2, sourcePattern: '\\(source: [^)]+\\)' }],
    ['never-call-tool', { tools: ['acme.refund', { id: 'acme.delete', version: '1.0.0' }] }],
    ['max-tool-calls', {}],
    ['max-tool-calls', { max: 0 }],
    ['output-matches', { pattern: '^Order', flags: 'i', negate: false }],
    ['tool-order', { sequence: ['acme.lookup', 'acme.refund'] }],
    ['required-substring', { patterns: ['Terms apply'], caseSensitive: true }],
    ['forbidden-substring', { patterns: ['SSN'] }],
  ] as const)('%s %j: fits', (id, config) => {
    expect(problemsOf(id, config)).toEqual([]);
    expect(registry.get(id)?.validateConfig?.(config)).toBeUndefined();
  });

  test.each([
    // The typo that silently disabled the rule: a list it doesn't get.
    ['never-call-tool', { tools: 'acme.refund' }, '/config/tools', 'must be array'],
    ['never-call-tool', {}, '/config', "must have required property 'tools'"],
    ['never-call-tool', { tools: [] }, '/config/tools', 'must NOT have fewer than 1 items'],
    ['must-cite', { minCitations: '2' }, '/config/minCitations', 'must be integer'],
    // A misspelt setting is refused, never ignored.
    ['must-cite', { minCitation: 2 }, '/config', 'must NOT have additional properties'],
    ['max-tool-calls', { max: -1 }, '/config/max', 'must be >= 0'],
    ['output-matches', {}, '/config', "must have required property 'pattern'"],
    ['output-matches', { pattern: 'a', flags: 'x' }, '/config/flags', 'must match pattern'],
    ['tool-order', { sequence: [] }, '/config/sequence', 'must NOT have fewer than 1 items'],
    [
      'required-substring',
      { patterns: [''] },
      '/config/patterns/0',
      'must NOT have fewer than 1 characters',
    ],
    ['forbidden-substring', { patterns: 'SSN' }, '/config/patterns', 'must be array'],
  ] as const)('%s %j: refused at %s', (id, config, path, words) => {
    const problems = problemsOf(id, config);
    expect(problems).toContainEqual({ path, message: expect.stringContaining(words) });
    expect(registry.get(id)?.validateConfig?.(config)).toEqual(expect.any(String));
  });

  test("a regular expression that won't compile is refused, named", () => {
    expect(problemsOf('output-matches', { pattern: '(unclosed' })).toEqual([
      {
        path: '/config/pattern',
        message: expect.stringContaining("config.pattern isn't a regular expression that compiles"),
      },
    ]);
    expect(problemsOf('must-cite', { sourcePattern: '[' })).toEqual([
      expect.objectContaining({ path: '/config/sourcePattern' }),
    ]);
  });
});

describe('evaluation: a config the check refuses is a check that can’t run', () => {
  const trace = {
    tenantId: 'acme' as TenantId,
    runId: 'run-1' as RunId,
    output: 'Order A-1 shipped.',
    toolCalls: [{ toolId: 'acme.refund', toolName: 'acme.refund' }],
    toolResults: [],
    modelCalls: [],
    mode: 'runtime',
  } as unknown as RunTrace;
  const guardrail = (config: Record<string, unknown>): Guardrail =>
    ({
      id: 'acme.no-refunds' as GuardrailId,
      kind: 'zero-llm',
      check: 'never-call-tool',
      config,
      action: { 'on-violation': 'halt' },
    }) as Guardrail;

  test('the typo: invalid-check-config with its issues, never a pass', async () => {
    const outcome = await evaluateGuardrail(guardrail({ tools: 'acme.refund' }), registry, trace);
    expect(outcome).toEqual({
      kind: 'err',
      error: {
        code: 'invalid-check-config',
        message: expect.stringContaining(
          `Guardrail "acme.no-refunds"'s config doesn't fit check "never-call-tool": config.tools must be array`,
        ),
        issues: [{ path: '/config/tools', message: 'config.tools must be array.' }],
        guardrailId: 'acme.no-refunds',
      },
    });
  });

  test('a config that fits runs the check: here, a violation', async () => {
    const outcome = await evaluateGuardrail(guardrail({ tools: ['acme.refund'] }), registry, trace);
    expect(outcome).toMatchObject({
      kind: 'ok',
      value: { result: { passed: false }, action: 'halt' },
    });
  });
});

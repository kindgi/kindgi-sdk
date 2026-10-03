// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, expectTypeOf, test } from 'vitest';
import * as z from 'zod';

import type { GuardrailId, RunId, TenantId } from '@kindgi/types';

import {
  createCheckRegistry,
  defineCheck,
  defineGuardrail,
  evaluateGuardrail,
} from '../src/index.js';
import type { EvaluationBindings, Guardrail, RunTrace } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;

const trace: RunTrace = {
  runId: crypto.randomUUID() as RunId,
  tenantId: TENANT,
  output: 'sample output text with [source-1]',
  toolCalls: [],
  toolResults: [],
  modelCalls: [],
  mode: 'runtime',
};

describe('defineCheck — Zod-optional authoring surface', () => {
  test('accepts a Zod configSchema and derives validateConfig', () => {
    const configSchema = z.object({
      minCitations: z.number().int().min(1),
      sourcePattern: z.string().optional(),
    });
    const check = defineCheck({
      id: 'zod.must-cite' as string,
      kind: 'zero-llm',
      configSchema,
      evaluate: async (config, t) => {
        expectTypeOf(config).toEqualTypeOf<{
          minCitations: number;
          sourcePattern?: string;
        }>();
        const re = new RegExp(config.sourcePattern ?? '\\[[^\\]]+\\]', 'g');
        const matches = (t.output ?? '').match(re) ?? [];
        return matches.length >= config.minCitations
          ? { passed: true }
          : { passed: false, reason: `expected >= ${config.minCitations}` };
      },
    });
    expect(check.id).toBe('zod.must-cite');
    expect(check.validateConfig).toBeDefined();
    expect(check.configZod).toBe(configSchema);
    expect(check.configJsonSchema).toMatchObject({
      type: 'object',
      properties: {
        minCitations: { type: 'integer' },
      },
    });
  });

  test('accepts a JSON Schema configSchema and derives validateConfig', () => {
    const check = defineCheck({
      id: 'json.max-tool-calls',
      kind: 'zero-llm',
      configSchema: {
        type: 'object',
        properties: { max: { type: 'integer', minimum: 1 } },
        required: ['max'],
        additionalProperties: false,
      },
      evaluate: async (config, t) => {
        const max = (config as { max: number }).max;
        return t.toolCalls.length <= max ? { passed: true } : { passed: false };
      },
    });
    expect(check.validateConfig).toBeDefined();
    expect(check.configZod).toBeUndefined();
    expect(check.configJsonSchema).toMatchObject({ type: 'object' });
  });

  test('validateConfig accepts a valid config', () => {
    const check = defineCheck({
      id: 'zod.demo',
      kind: 'zero-llm',
      configSchema: z.object({ n: z.number().int() }),
      evaluate: async () => ({ passed: true }),
    });
    expect(check.validateConfig?.({ n: 5 })).toBeUndefined();
  });

  test('validateConfig rejects a bad config', () => {
    const check = defineCheck({
      id: 'zod.demo-2',
      kind: 'zero-llm',
      configSchema: z.object({ n: z.number().int() }),
      evaluate: async () => ({ passed: true }),
    });
    const reason = check.validateConfig?.({ n: 'not-a-number' });
    expect(reason).toBeDefined();
    expect(typeof reason).toBe('string');
  });

  test('omitting configSchema leaves validateConfig untouched', () => {
    const check = defineCheck({
      id: 'no-schema',
      kind: 'zero-llm',
      evaluate: async () => ({ passed: true }),
    });
    expect(check.validateConfig).toBeUndefined();
    expect(check.configZod).toBeUndefined();
    expect(check.configJsonSchema).toBeUndefined();
  });

  test('caller-supplied validateConfig chains after the schema-derived one', () => {
    const check = defineCheck({
      id: 'chained',
      kind: 'zero-llm',
      configSchema: z.object({ n: z.number().int() }),
      validateConfig: (config) => {
        const n = (config as { n: number }).n;
        return n < 0 ? 'n must be non-negative' : undefined;
      },
      evaluate: async () => ({ passed: true }),
    });
    // Schema check fails first.
    expect(check.validateConfig?.({ n: 'wrong' })).toBeDefined();
    // Schema passes, caller validator fails.
    expect(check.validateConfig?.({ n: -1 })).toBe('n must be non-negative');
    // Both pass.
    expect(check.validateConfig?.({ n: 5 })).toBeUndefined();
  });

  test('defineGuardrail surfaces validation failure via invalid-check-config', () => {
    const check = defineCheck({
      id: 'inv-validated',
      kind: 'zero-llm',
      configSchema: z.object({ threshold: z.number().min(0).max(1) }),
      evaluate: async () => ({ passed: true }),
    });
    const registry = createCheckRegistry([check]);
    const guardrail: Guardrail = {
      id: 'inv-1' as GuardrailId,
      kind: 'zero-llm',
      check: 'inv-validated',
      config: { threshold: 5 }, // out of range
      action: { 'on-violation': 'halt' },
    };
    const r = defineGuardrail(guardrail, registry);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('invalid-check-config');
  });

  test('end-to-end: defineCheck with Zod → defineGuardrail → evaluate', async () => {
    const check = defineCheck({
      id: 'zod.e2e',
      kind: 'zero-llm',
      configSchema: z.object({ minLen: z.number().int().min(1) }),
      evaluate: async (config, t) => {
        const output = t.output ?? '';
        return output.length >= config.minLen
          ? { passed: true }
          : { passed: false, reason: `output too short (${output.length} < ${config.minLen})` };
      },
    });
    const registry = createCheckRegistry([check]);
    const guardrail = defineGuardrail(
      {
        id: 'inv-len' as GuardrailId,
        kind: 'zero-llm',
        check: 'zod.e2e',
        config: { minLen: 5 },
        action: { 'on-violation': 'log-only' },
      },
      registry,
    );
    if (guardrail.kind !== 'ok') throw new Error(guardrail.error.message);
    const bindings: EvaluationBindings = {};
    const result = await evaluateGuardrail(guardrail.value, registry, trace, bindings);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.result.passed).toBe(true);
    }
  });

  test('TS: z.infer<typeof check.configZod> gives the expected type', () => {
    const schema = z.object({ answer: z.number() });
    const check = defineCheck({
      id: 'infer',
      kind: 'zero-llm',
      configSchema: schema,
      evaluate: async () => ({ passed: true }),
    });
    type C = z.infer<typeof check.configZod>;
    expectTypeOf<C>().toEqualTypeOf<{ answer: number }>();
  });

  test('invalid Zod (function) throws with invalid-check-definition', () => {
    expect(() => {
      defineCheck({
        id: 'bad',
        kind: 'zero-llm',
        configSchema: z.function() as unknown as z.ZodType,
        evaluate: async () => ({ passed: true }),
      });
    }).toThrow(/configSchema/);
  });

  test('wire form: configJsonSchema is a plain JSON Schema object regardless of authoring', () => {
    const zodCheck = defineCheck({
      id: 'wire-1',
      kind: 'zero-llm',
      configSchema: z.object({ x: z.number() }),
      evaluate: async () => ({ passed: true }),
    });
    const jsonCheck = defineCheck({
      id: 'wire-2',
      kind: 'zero-llm',
      configSchema: {
        type: 'object',
        properties: { x: { type: 'number' } },
      },
      evaluate: async () => ({ passed: true }),
    });
    // Both round-trip through JSON.
    expect(JSON.parse(JSON.stringify(zodCheck.configJsonSchema))).toEqual(
      zodCheck.configJsonSchema,
    );
    expect(JSON.parse(JSON.stringify(jsonCheck.configJsonSchema))).toEqual(
      jsonCheck.configJsonSchema,
    );
  });

  test('runtime: evaluate receives the config unchanged', async () => {
    let received: unknown;
    const check = defineCheck({
      id: 'pass-through',
      kind: 'zero-llm',
      configSchema: z.object({ tag: z.string() }),
      evaluate: async (config) => {
        received = config;
        return { passed: true };
      },
    });
    const registry = createCheckRegistry([check]);
    const guardrail = defineGuardrail(
      {
        id: 'inv-pt' as GuardrailId,
        kind: 'zero-llm',
        check: 'pass-through',
        config: { tag: 'hello' },
        action: { 'on-violation': 'log-only' },
      },
      registry,
    );
    if (guardrail.kind !== 'ok') throw new Error(guardrail.error.message);
    await evaluateGuardrail(guardrail.value, registry, trace, {});
    expect(received).toEqual({ tag: 'hello' });
  });

  test('empty Zod configSchema (no fields) is accepted', () => {
    const check = defineCheck({
      id: 'empty',
      kind: 'zero-llm',
      configSchema: z.object({}),
      evaluate: async () => ({ passed: true }),
    });
    expect(check.configJsonSchema).toMatchObject({ type: 'object' });
    expect(check.validateConfig?.({})).toBeUndefined();
  });
});

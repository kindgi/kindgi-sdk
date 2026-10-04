// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `defineCheck`'s `evaluate` gets the config its `configSchema` resolves:
 * the schema's defaults applied (a guardrail that declares no config gets
 * them all), and a config that doesn't fit refused, naming where. Python's
 * guardrails do the same. Without a schema, the config as declared.
 */

import { describe, expect, test } from 'vitest';
import * as z from 'zod';

import type { RunId, TenantId } from '@kindgi/types';

import { defineCheck } from '../src/index.js';
import type { RunTrace } from '../src/index.js';

const trace: RunTrace = {
  runId: crypto.randomUUID() as RunId,
  tenantId: '00000000-0000-0000-0000-000000000001' as TenantId,
  output: '',
  toolCalls: [],
  toolResults: [],
  modelCalls: [],
  mode: 'runtime',
};

/** A check that records the config its `evaluate` got. */
function recording(configSchema?: Parameters<typeof defineCheck>[0]['configSchema']) {
  const seen: unknown[] = [];
  const check = defineCheck({
    id: 'acme.checks.recording',
    kind: 'zero-llm',
    ...(configSchema !== undefined && { configSchema }),
    evaluate: async (config) => {
      seen.push(config);
      return { passed: true };
    },
  });
  return { check, seen };
}

describe('defineCheck: the config evaluate gets', () => {
  test("Zod: the schema's defaults apply, to a declared config and to none", async () => {
    const { check, seen } = recording(
      z.object({ minLength: z.number().int().min(0).default(1), label: z.string().optional() }),
    );
    await check.evaluate({}, trace, {});
    await check.evaluate(undefined as never, trace, {});
    await check.evaluate({ minLength: 3, label: 'x' }, trace, {});
    expect(seen).toEqual([{ minLength: 1 }, { minLength: 1 }, { minLength: 3, label: 'x' }]);
  });

  test("Zod: a config that doesn't fit is refused, naming where", async () => {
    const { check, seen } = recording(z.object({ maxChars: z.number().int().min(0) }));
    await expect(check.evaluate({ maxChars: -5 }, trace, {})).rejects.toThrow(
      /^Check "acme\.checks\.recording": the guardrail's config doesn't fit its configSchema at maxChars: /,
    );
    expect(seen).toEqual([]);
  });

  test("JSON Schema: the schema's defaults apply, on a copy of the declared config", async () => {
    const { check, seen } = recording({
      type: 'object',
      properties: { minLength: { type: 'integer', minimum: 0, default: 1 } },
      additionalProperties: false,
    });
    const declared = {};
    await check.evaluate(declared, trace, {});
    expect(seen).toEqual([{ minLength: 1 }]);
    expect(declared).toEqual({});
  });

  test("JSON Schema: a config that doesn't fit is refused, naming where", async () => {
    const { check } = recording({
      type: 'object',
      properties: { maxChars: { type: 'integer', minimum: 0 } },
    });
    await expect(check.evaluate({ maxChars: -5 }, trace, {})).rejects.toThrow(
      /the guardrail's config doesn't fit its configSchema at \/maxChars: must be >= 0/,
    );
  });

  test('no configSchema: the config as declared', async () => {
    const { check, seen } = recording();
    const declared = { anything: 'goes' };
    await check.evaluate(declared, trace, {});
    expect(seen[0]).toBe(declared);
  });
});

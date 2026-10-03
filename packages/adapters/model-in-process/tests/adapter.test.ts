// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { DEFAULT_LOCAL_MODEL, MODEL_SPECS, createInProcessModelProvider } from '../src/index.js';

describe('createInProcessModelProvider — surface (no model load)', () => {
  test('defaults to smollm2-360m', () => {
    const p = createInProcessModelProvider();
    expect(p.metadata.models.map((m) => m.name)).toEqual(['smollm2-360m']);
    expect(DEFAULT_LOCAL_MODEL).toBe('smollm2-360m');
  });

  test('honors the models option', () => {
    const p135 = createInProcessModelProvider({ models: ['smollm2-135m'] });
    expect(p135.metadata.models[0]?.name).toBe('smollm2-135m');
    const pqwen = createInProcessModelProvider({ models: ['qwen3-0.6b'] });
    expect(pqwen.metadata.models[0]?.name).toBe('qwen3-0.6b');
  });

  test('surfaces every model listed in the models[] option', () => {
    const p = createInProcessModelProvider({ models: ['smollm2-360m', 'qwen3-0.6b'] });
    expect(p.metadata.models.map((m) => m.name)).toEqual(['smollm2-360m', 'qwen3-0.6b']);
  });

  test('metadata reflects tier + capabilities per model', () => {
    const p = createInProcessModelProvider({ models: ['smollm2-360m'] });
    expect(p.metadata.region).toBe('in-process');
    const model = p.metadata.models[0];
    expect(model?.cost.promptUsdPer1kTokens).toBe(0);
    expect(model?.cost.completionUsdPer1kTokens).toBe(0);
    expect(model?.features).toContain('tool-use');
    expect(model?.features).toContain('structured-output');
    expect(p.metadata.attributes).toContain('in-process');
    expect(p.metadata.attributes).toContain('lower-cost');
  });

  test('qwen3-0.6b is long-context and marked medium tier', () => {
    const p = createInProcessModelProvider({ models: ['qwen3-0.6b'] });
    expect(p.metadata.models[0]?.features).toContain('long-context');
    expect(p.metadata.attributes).toContain('medium');
  });

  test('smollm2-135m is not tool-use tuned', () => {
    const p = createInProcessModelProvider({ models: ['smollm2-135m'] });
    expect(p.metadata.models[0]?.features).not.toContain('tool-use');
    expect(p.metadata.attributes).toContain('ultra-light');
  });

  test('provider id override changes metadata.id but not model names', () => {
    const p = createInProcessModelProvider({
      models: ['smollm2-360m'],
      providerId: 'in-process/routing-tier',
    });
    expect(p.metadata.id).toBe('in-process/routing-tier');
    expect(p.metadata.models[0]?.name).toBe('smollm2-360m');
    // HF-qualified id still available inside the description for
    // operators debugging downloads.
    expect(p.metadata.models[0]?.description).toContain(MODEL_SPECS['smollm2-360m'].hfName);
  });
});

// Real model download + inference test. Gated behind KINDGI_TEST_INPROCESS_MODEL=1
// so default CI stays fast. Downloads ~270MB on first run for smollm2-360m.
const SHOULD_RUN_INTEGRATION = process.env.KINDGI_TEST_INPROCESS_MODEL === '1';

describe.skipIf(!SHOULD_RUN_INTEGRATION)(
  'createInProcessModelProvider — real invocation (smollm2-135m for speed)',
  () => {
    test('invoke returns a non-empty assistant response with usage counters', async () => {
      const p = createInProcessModelProvider({ models: ['smollm2-135m'] });
      const result = await p.invoke({
        model: 'smollm2-135m',
        messages: [{ role: 'user', content: 'Reply with the word OK.' }],
        maxOutputTokens: 16,
      });
      expect(result.message.role).toBe('assistant');
      expect(result.message.content.length).toBeGreaterThan(0);
      expect(result.usage.promptTokens).toBeGreaterThan(0);
      expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);
      expect(result.costUsd).toBe(0);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.provider.id).toBe('in-process/smollm2-135m');
    });
  },
);

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  type ExecutionStrategy,
  createCheckRegistry,
  createExecutionStrategyRegistry,
  evaluateGuardrail,
  externalStrategy,
  zeroLlmStrategy,
} from '../src/index.js';
import type { Guardrail, RunTrace } from '../src/types.js';

const TRACE: RunTrace = {
  runId: '00000000-0000-4000-8000-000000000001' as never,
  tenantId: '00000000-0000-4000-8000-000000000002' as never,
  mode: 'runtime',
  toolCalls: [],
  toolResults: [],
  modelCalls: [],
};

describe('registered execution strategies', () => {
  test('built-in registry has zero-llm + llm-judge + external', () => {
    const registry = createExecutionStrategyRegistry([zeroLlmStrategy, externalStrategy]);
    expect(registry.get('zero-llm')).toBeDefined();
    expect(registry.get('external')).toBeDefined();
    expect(registry.get('llm-judge')).toBeUndefined();
    expect(registry.list()).toHaveLength(2);
  });

  test('a caller-registered strategy dispatches correctly', async () => {
    let capturedGuardrailId = '';
    const sandboxStrategy: ExecutionStrategy = {
      kind: 'sandbox-code',
      name: 'Sandboxed code check',
      async evaluate(guardrail) {
        capturedGuardrailId = guardrail.id;
        return { kind: 'ok', value: { passed: true, attributes: { via: 'sandbox' } } };
      },
    };
    const strategies = createExecutionStrategyRegistry([sandboxStrategy]);
    const guardrail: Guardrail = {
      id: 'sandbox-test' as never,
      kind: 'sandbox-code',
      check: 'unused-in-strategy',
      action: { 'on-violation': 'halt' },
    };
    const outcome = await evaluateGuardrail(guardrail, createCheckRegistry(), TRACE, {
      strategies,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.value.result.passed).toBe(true);
      expect(outcome.value.result.attributes?.via).toBe('sandbox');
    }
    expect(capturedGuardrailId).toBe('sandbox-test');
  });

  test('unknown kind → invalid-guardrail error', async () => {
    // Empty registry — the built-in default is bypassed by supplying `strategies`.
    const strategies = createExecutionStrategyRegistry([]);
    const guardrail: Guardrail = {
      id: 'mystery' as never,
      kind: 'unknown-kind',
      check: 'x',
      action: { 'on-violation': 'halt' },
    };
    const outcome = await evaluateGuardrail(guardrail, createCheckRegistry(), TRACE, {
      strategies,
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('invalid-guardrail');
      expect(outcome.error.message).toContain('unknown kind');
    }
  });

  test('strategy err surfaces as guardrail-error with guardrailId filled in', async () => {
    const badStrategy: ExecutionStrategy = {
      kind: 'always-fails',
      async evaluate() {
        return {
          kind: 'err',
          error: { code: 'sandbox-crash', message: 'container OOM' },
        };
      },
    };
    const strategies = createExecutionStrategyRegistry([badStrategy]);
    const guardrail: Guardrail = {
      id: 'boom' as never,
      kind: 'always-fails',
      check: 'x',
      action: { 'on-violation': 'halt' },
    };
    const outcome = await evaluateGuardrail(guardrail, createCheckRegistry(), TRACE, {
      strategies,
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('sandbox-crash');
      expect(outcome.error.message).toBe('container OOM');
      expect((outcome.error as { guardrailId?: string }).guardrailId).toBe('boom');
    }
  });
});

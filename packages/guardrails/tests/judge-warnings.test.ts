// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A judge's model call can warn about its answer (`ModelCallResult.warnings`):
 * a temperature its model doesn't take, say. The warnings go on with the
 * judgment (`CheckResult.warnings`), so the turn can say them.
 */

import { describe, expect, test } from 'vitest';

import type { ModelCallWarning, ModelProvider } from '@kindgi/capabilities';
import type { GuardrailId, RunId, TenantId } from '@kindgi/types';

import { createCheckRegistry, evaluateGuardrail } from '../src/index.js';
import type { Guardrail, RunTrace } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;

const trace: RunTrace = {
  runId: '00000000-0000-0000-0000-0000000000aa' as RunId,
  tenantId: TENANT,
  output: 'Your order shipped on Monday.',
  toolCalls: [],
  toolResults: [],
  modelCalls: [],
  mode: 'runtime',
};

const guardrail: Guardrail = {
  id: 'acme.on-topic' as GuardrailId,
  kind: 'llm-judge',
  check: 'acme.judge',
  config: { rubric: 'Does the answer stay on the order?', temperature: 0.2 },
  action: { 'on-violation': 'log-only' },
  judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
};

/** A judge on `acme-large`, which takes no temperature, answering `content` with `warnings`. */
function judge(content: string, warnings?: readonly ModelCallWarning[]): ModelProvider {
  return {
    metadata: {
      id: 'acme-llm',
      region: 'test',
      models: [
        {
          name: 'acme-large',
          contextWindow: 8000,
          features: ['tool-use'],
          sampling: false,
          cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
        },
      ],
    },
    invoke: async () => ({
      message: { role: 'assistant', content },
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 20 },
      costUsd: 0,
      durationMs: 50,
      provider: { id: 'acme-llm', model: 'acme-large' },
      ...(warnings !== undefined && { warnings }),
    }),
  };
}

async function judged(provider: ModelProvider) {
  const checks = createCheckRegistry();
  checks.register({
    id: 'acme.judge',
    kind: 'llm-judge',
    evaluate: async () => ({ passed: true }),
  });
  const outcome = await evaluateGuardrail(guardrail, checks, trace, { judgeProvider: provider });
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.value.result;
}

const SAMPLING: ModelCallWarning = {
  code: 'sampling-unsupported',
  message:
    "acme-large doesn't take a temperature, so the call went without one (it asked for 0.2).",
};

describe("a judge's model-call warnings", () => {
  test('go on with its judgment, a pass', async () => {
    const result = await judged(judge('PASS\nOn the order.', [SAMPLING]));
    expect(result.passed).toBe(true);
    expect(result.warnings).toEqual([SAMPLING]);
  });

  test('go on with its judgment, a failure, each of them in order', async () => {
    const other: ModelCallWarning = { code: 'acme-preview', message: 'acme-large is a preview.' };
    const result = await judged(judge('FAIL\nIt talks about the weather.', [SAMPLING, other]));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('weather');
    expect(result.warnings).toEqual([SAMPLING, other]);
  });

  test('a call that warned about nothing adds no warnings', async () => {
    expect(await judged(judge('PASS\nOn the order.'))).not.toHaveProperty('warnings');
    expect(await judged(judge('PASS\nOn the order.', []))).not.toHaveProperty('warnings');
  });
});

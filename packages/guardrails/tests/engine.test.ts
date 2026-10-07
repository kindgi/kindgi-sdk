// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelProvider, ModelUsageRecord, TenantPolicy } from '@kindgi/capabilities';
import { createProviderRegistry } from '@kindgi/capabilities';
import type { AgentId, GuardrailId, RunId, TenantId, Timestamp, ToolId } from '@kindgi/types';

import {
  createCheckRegistry,
  defineGuardrail,
  evaluateAll,
  evaluateGuardrail,
  violations,
} from '../src/index.js';
import type { EvaluationBindings, Guardrail, RunTrace } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const OTHER_TENANT = '00000000-0000-0000-0000-000000000002' as TenantId;

function baseTrace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: crypto.randomUUID() as RunId,
    tenantId: TENANT,
    output: '',
    toolCalls: [],
    toolResults: [],
    modelCalls: [],
    mode: 'runtime',
    ...over,
  };
}

function mustCiteGuardrail(over: Partial<Guardrail> = {}): Guardrail {
  return {
    id: 'inv-must-cite' as GuardrailId,
    kind: 'zero-llm',
    check: 'must-cite',
    config: { minCitations: 1 },
    action: { 'on-violation': 'halt' },
    severity: 'error',
    ...over,
  };
}

describe('defineGuardrail', () => {
  test('accepts a valid zero-llm guardrail', () => {
    const registry = createCheckRegistry();
    const r = defineGuardrail(mustCiteGuardrail(), registry);
    expect(r.kind).toBe('ok');
  });

  test('rejects reference to unregistered check', () => {
    const registry = createCheckRegistry();
    const r = defineGuardrail(mustCiteGuardrail({ check: 'not-a-real-check' }), registry);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('unknown-check');
  });

  test('rejects when guardrail kind does not match check kind', () => {
    const registry = createCheckRegistry();
    // must-cite is registered as zero-llm; declare as llm-judge → mismatch.
    const r = defineGuardrail(mustCiteGuardrail({ kind: 'llm-judge' }), registry);
    expect(r.kind).toBe('err');
  });

  test('accepts any action name, but rejects a malformed action shape', () => {
    const registry = createCheckRegistry();
    // `on-violation` is open: an unknown name is accepted at define time and
    // fails with `unknown-action` only when the guardrail fires.
    const custom = defineGuardrail(
      mustCiteGuardrail({ action: { 'on-violation': 'obliterate' } }),
      registry,
    );
    expect(custom.kind).toBe('ok');

    const malformed: readonly Guardrail['action'][] = [
      { 'on-violation': '' },
      { 'on-violation': 'halt', notAField: true } as unknown as Guardrail['action'],
      {} as unknown as Guardrail['action'],
    ];
    for (const action of malformed) {
      expect(defineGuardrail(mustCiteGuardrail({ action }), registry).kind).toBe('err');
    }
  });

  test('accepts an adapter kind when a check of that kind is registered', () => {
    const registry = createCheckRegistry();
    registry.register({
      id: 'acme.sandboxed-check',
      kind: 'sandbox-code',
      evaluate: async () => ({ passed: true }),
    });
    const ok = defineGuardrail(
      mustCiteGuardrail({ kind: 'sandbox-code', check: 'acme.sandboxed-check', config: {} }),
      registry,
    );
    expect(ok.kind).toBe('ok');
    // The kind guard stays: a `sandbox-code` guardrail can't point at a zero-llm check.
    const mismatch = defineGuardrail(mustCiteGuardrail({ kind: 'sandbox-code' }), registry);
    expect(mismatch.kind).toBe('err');
    // An empty kind fails the schema.
    expect(defineGuardrail(mustCiteGuardrail({ kind: '' }), registry).kind).toBe('err');
  });

  test('rejects a guardrail without `check` at the schema step (guardrail schema 1.1.0)', () => {
    const registry = createCheckRegistry();
    const { check: _check, ...withoutCheck } = mustCiteGuardrail();
    const r = defineGuardrail(withoutCheck as unknown as Guardrail, registry);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.code).toBe('invalid-guardrail');
      if (r.error.code === 'invalid-guardrail') {
        expect(r.error.issues.some((i) => i.message.includes('check'))).toBe(true);
      }
    }
  });

  test('accepts the runtime extensions the Guardrail type declares', () => {
    const registry = createCheckRegistry();
    const r = defineGuardrail(
      mustCiteGuardrail({
        sandbox: 'context-isolated',
        limits: { memMB: 128, cpuMs: 500 },
        network: { kind: 'none' },
        needsSpec: { config: { region: { type: 'string' } } },
        codeArtifactRef: { kind: 'filesystem', modulePath: '/abs/guardrails/must-cite.js' },
      }),
      registry,
    );
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error));
    expect(r.value.sandbox).toBe('context-isolated');
  });

  test('rejects a retry action without `maxAttempts`', () => {
    const registry = createCheckRegistry();
    const bad = mustCiteGuardrail({
      action: { 'on-violation': 'retry', retry: {} as { maxAttempts: number } },
    });
    expect(defineGuardrail(bad, registry).kind).toBe('err');
    const ok = mustCiteGuardrail({
      action: { 'on-violation': 'retry', retry: { maxAttempts: 3 } },
    });
    expect(defineGuardrail(ok, registry).kind).toBe('ok');
  });
});

describe('evaluateGuardrail — zero-llm', () => {
  test('pass path returns action=noop', async () => {
    const registry = createCheckRegistry();
    const outcome = await evaluateGuardrail(
      mustCiteGuardrail(),
      registry,
      baseTrace({ output: 'per [Smith] the rule applies' }),
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.value.result.passed).toBe(true);
      expect(outcome.value.action).toBe('noop');
    }
  });

  test('fail path returns action=halt for halt-on-violation guardrail', async () => {
    const registry = createCheckRegistry();
    const outcome = await evaluateGuardrail(
      mustCiteGuardrail(),
      registry,
      baseTrace({ output: 'no citations here' }),
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.value.result.passed).toBe(false);
      expect(outcome.value.action).toBe('halt');
      expect(outcome.value.severity).toBe('error');
    }
  });

  test('fail with retry action', async () => {
    const registry = createCheckRegistry();
    const outcome = await evaluateGuardrail(
      mustCiteGuardrail({
        action: { 'on-violation': 'retry', retry: { maxAttempts: 3 } },
      }),
      registry,
      baseTrace({ output: 'no citations' }),
    );
    if (outcome.kind === 'ok') expect(outcome.value.action).toBe('retry');
  });
});

describe('evaluateGuardrail — scope filtering', () => {
  test('ci-only skips at runtime', async () => {
    const registry = createCheckRegistry();
    const outcome = await evaluateGuardrail(
      mustCiteGuardrail({ scope: { when: 'ci-only' } }),
      registry,
      baseTrace({ mode: 'runtime' }),
    );
    expect(outcome.kind).toBe('skip');
    if (outcome.kind === 'skip') expect(outcome.reason.reason).toBe('wrong-mode');
  });

  test('runtime-only skips at ci', async () => {
    const registry = createCheckRegistry();
    const outcome = await evaluateGuardrail(
      mustCiteGuardrail({ scope: { when: 'runtime-only' } }),
      registry,
      baseTrace({ mode: 'ci' }),
    );
    expect(outcome.kind).toBe('skip');
  });

  test('tenant filter narrows applicability', async () => {
    const registry = createCheckRegistry();
    const outcome = await evaluateGuardrail(
      mustCiteGuardrail({ scope: { tenants: [OTHER_TENANT] } }),
      registry,
      baseTrace({ tenantId: TENANT }),
    );
    expect(outcome.kind).toBe('skip');
    if (outcome.kind === 'skip') expect(outcome.reason.reason).toBe('wrong-tenant');
  });

  test('agent filter narrows applicability', async () => {
    const registry = createCheckRegistry();
    const outcome = await evaluateGuardrail(
      mustCiteGuardrail({ scope: { agents: ['agent-a' as AgentId] } }),
      registry,
      baseTrace({ agentId: 'agent-b' as AgentId }),
    );
    expect(outcome.kind).toBe('skip');
  });
});

describe('evaluateAll + violations', () => {
  test('evaluates every guardrail and extracts violations only', async () => {
    const registry = createCheckRegistry();
    const guardrails: Guardrail[] = [
      mustCiteGuardrail({ id: 'inv-1' as GuardrailId }),
      {
        id: 'inv-2' as GuardrailId,
        kind: 'zero-llm',
        check: 'max-tool-calls',
        config: { max: 2 },
        action: { 'on-violation': 'log-only' },
      },
    ];
    const trace = baseTrace({
      output: 'no citations',
      toolCalls: Array.from({ length: 5 }, (_, i) => ({
        toolId: `t-${i}` as ToolId,
        toolName: `t-${i}`,
        arguments: {},
        at: '2026-09-17T12:00:00.000Z' as Timestamp,
      })),
    });
    const outcomes = await evaluateAll(guardrails, registry, trace);
    expect(outcomes).toHaveLength(2);
    const violated = violations(outcomes);
    expect(violated).toHaveLength(2);
    expect(violated.map((v) => v.guardrailId)).toEqual(['inv-1', 'inv-2']);
  });
});

describe('evaluateGuardrail — llm-judge routing', () => {
  test('missing bindings on llm-judge returns judge-missing error', async () => {
    const registry = createCheckRegistry();
    // Register a stub llm-judge check so kind lookup passes.
    registry.register({
      id: 'test-judge',
      kind: 'llm-judge',
      evaluate: async () => ({ passed: true }),
    });
    const guardrail: Guardrail = {
      id: 'inv-j' as GuardrailId,
      kind: 'llm-judge',
      check: 'test-judge',
      config: { rubric: 'Is the output helpful?' },
      action: { 'on-violation': 'log-only' },
      judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
    };
    const outcome = await evaluateGuardrail(guardrail, registry, baseTrace(), {});
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') expect(outcome.error.code).toBe('judge-missing');
  });

  test('judgeProvider override invokes the judge and parses PASS/FAIL', async () => {
    const registry = createCheckRegistry();
    registry.register({
      id: 'test-judge-provider',
      kind: 'llm-judge',
      evaluate: async () => ({ passed: true }),
    });
    const guardrail: Guardrail = {
      id: 'inv-j2' as GuardrailId,
      kind: 'llm-judge',
      check: 'test-judge-provider',
      config: { rubric: 'Is the output helpful?' },
      action: { 'on-violation': 'log-only' },
      judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
    };
    const bindings: EvaluationBindings = {
      judgeProvider: {
        metadata: {
          id: 'test-provider',
          region: 'test',
          models: [
            {
              name: 'test-model',
              contextWindow: 8000,
              features: ['tool-use'],
              cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
            },
          ],
        },
        invoke: async () => ({
          message: { role: 'assistant', content: 'FAIL\nOutput was off-topic.' },
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 20 },
          costUsd: 0,
          durationMs: 50,
          provider: { id: 'test-provider', model: 'test-model' },
        }),
      },
    };
    const outcome = await evaluateGuardrail(guardrail, registry, baseTrace(), bindings);
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.value.result.passed).toBe(false);
    expect(outcome.value.result.reason).toContain('off-topic');
    expect(outcome.value.action).toBe('log-only');
  });
});

describe('evaluateGuardrail — a judge on a model that takes no temperature', () => {
  test("the judge's temperature goes to the provider, whose adapter decides; a sampling warning doesn't stop the verdict", async () => {
    const registry = createCheckRegistry();
    registry.register({
      id: 'judge-t',
      kind: 'llm-judge',
      evaluate: async () => ({ passed: true }),
    });
    const guardrail: Guardrail = {
      id: 'inv-j3' as GuardrailId,
      kind: 'llm-judge',
      check: 'judge-t',
      config: { rubric: 'Is the output helpful?', temperature: 0.2 },
      action: { 'on-violation': 'log-only' },
      judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
    };
    const seen: unknown[] = [];
    const bindings: EvaluationBindings = {
      judgeProvider: {
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
        invoke: async (input) => {
          seen.push(input.temperature);
          return {
            message: { role: 'assistant', content: 'PASS\nOn topic.' },
            finishReason: 'stop',
            usage: { promptTokens: 100, completionTokens: 20 },
            costUsd: 0,
            durationMs: 50,
            provider: { id: 'acme-llm', model: 'acme-large' },
            warnings: [
              { code: 'sampling-unsupported', message: 'acme-large takes no temperature' },
            ],
          };
        },
      },
    };
    const outcome = await evaluateGuardrail(guardrail, registry, baseTrace(), bindings);
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(seen).toEqual([0.2]);
    expect(outcome.value.result.passed).toBe(true);
  });
});

describe('evaluateGuardrail — llm-judge under the tenant policy', () => {
  function judgeGuardrail(): Guardrail {
    return {
      id: 'inv-judge-policy' as GuardrailId,
      kind: 'llm-judge',
      check: 'judge-policy',
      config: { rubric: 'Is the output helpful?' },
      action: { 'on-violation': 'log-only' },
      judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
    };
  }
  function judgeRegistry() {
    const registry = createCheckRegistry();
    registry.register({
      id: 'judge-policy',
      kind: 'llm-judge',
      evaluate: async () => ({ passed: true }),
    });
    return registry;
  }
  /** A judge provider in `region` that records whether it was called. */
  function judge(id: string, region: string, calls: string[]): ModelProvider {
    return {
      metadata: {
        id,
        region,
        models: [
          {
            name: `${id}-model`,
            contextWindow: 8000,
            features: ['tool-use'],
            cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
          },
        ],
      },
      invoke: async () => {
        calls.push(id);
        return {
          message: { role: 'assistant', content: 'PASS\nFine.' },
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
          costUsd: 0,
          durationMs: 1,
          provider: { id, model: `${id}-model` },
        };
      },
    };
  }
  const euOnly: TenantPolicy = { tenantId: TENANT, regionAllow: ['eu-west-1'] };

  test('routes the judge to a model the tenant policy allows', async () => {
    const calls: string[] = [];
    // Without the policy the router would pick `judge-1` (first in order).
    const { registry: providerRegistry } = createProviderRegistry([
      { tenantId: TENANT, provider: judge('judge-1', 'us-east-1', calls) },
      { tenantId: TENANT, provider: judge('judge-2', 'eu-west-1', calls) },
    ]);
    const outcome = await evaluateGuardrail(judgeGuardrail(), judgeRegistry(), baseTrace(), {
      providerRegistry,
      tenantPolicy: euOnly,
    });
    expect(outcome.kind).toBe('ok');
    expect(calls).toEqual(['judge-2']);
  });

  test('fails closed when no judge model is allowed', async () => {
    const calls: string[] = [];
    const { registry: providerRegistry } = createProviderRegistry([
      { tenantId: TENANT, provider: judge('us-judge', 'us-east-1', calls) },
    ]);
    const outcome = await evaluateGuardrail(judgeGuardrail(), judgeRegistry(), baseTrace(), {
      providerRegistry,
      tenantPolicy: euOnly,
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') expect(outcome.error.code).toBe('judge-routing-failed');
    expect(calls).toEqual([]);
  });

  test('an explicit judgeProvider outside the policy is refused', async () => {
    const calls: string[] = [];
    const outcome = await evaluateGuardrail(judgeGuardrail(), judgeRegistry(), baseTrace(), {
      judgeProvider: judge('us-judge', 'us-east-1', calls),
      tenantPolicy: euOnly,
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') expect(outcome.error.code).toBe('judge-routing-failed');
    expect(calls).toEqual([]);
  });

  test('without a tenant policy an explicit judgeProvider is used as before', async () => {
    const calls: string[] = [];
    const outcome = await evaluateGuardrail(judgeGuardrail(), judgeRegistry(), baseTrace(), {
      judgeProvider: judge('us-judge', 'us-east-1', calls),
    });
    expect(outcome.kind).toBe('ok');
    expect(calls).toEqual(['us-judge']);
  });
});

describe('evaluateGuardrail — llm-judge records its model calls', () => {
  const judgeMetadata = {
    id: 'test-provider',
    region: 'test',
    models: [
      {
        name: 'test-model',
        contextWindow: 8000,
        features: ['tool-use' as const],
        cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
      },
    ],
  };
  const guardrail: Guardrail = {
    id: 'acme.on-topic' as GuardrailId,
    kind: 'llm-judge',
    check: 'judge-usage',
    config: { rubric: 'Is the output on topic?' },
    action: { 'on-violation': 'log-only' },
    judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
  };
  const registry = createCheckRegistry();
  registry.register({
    id: 'judge-usage',
    kind: 'llm-judge',
    evaluate: async () => ({ passed: true }),
  });

  test("a judge call is recorded with the run's identity and the guardrail it judged", async () => {
    const recorded: ModelUsageRecord[] = [];
    const trace = baseTrace({
      agentId: 'acme.helper' as AgentId,
      conversationId: '00000000-0000-0000-0000-0000000000cc',
    });
    const outcome = await evaluateGuardrail(guardrail, registry, trace, {
      judgeProvider: {
        metadata: judgeMetadata,
        invoke: async () => ({
          message: { role: 'assistant', content: 'PASS\nOn topic.' },
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 20 },
          costUsd: 0.0001,
          durationMs: 50,
          provider: { id: 'test-provider', model: 'test-model' },
        }),
      },
      usage: { record: async (call) => void recorded.push(call) },
    });
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(recorded).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        runId: trace.runId,
        agentId: 'acme.helper',
        conversationId: '00000000-0000-0000-0000-0000000000cc',
        providerId: 'test-provider',
        model: 'test-model',
        purpose: 'guardrail-judge:acme.on-topic',
        status: 'ok',
        result: expect.objectContaining({ usage: { promptTokens: 100, completionTokens: 20 } }),
      }),
    ]);
  });

  test('a judge call that threw is recorded as failed, and throws its own error', async () => {
    const recorded: ModelUsageRecord[] = [];
    const providerError = new Error('429 slow down');
    const thrown = await evaluateGuardrail(guardrail, registry, baseTrace(), {
      judgeProvider: { metadata: judgeMetadata, invoke: () => Promise.reject(providerError) },
      usage: { record: async (call) => void recorded.push(call) },
    }).catch((e: unknown) => e);
    expect(thrown).toBe(providerError);
    expect(recorded).toEqual([
      expect.objectContaining({ status: 'failed', error: { message: '429 slow down' } }),
    ]);
  });

  test("a failed judge call that can't be recorded either still throws its own error", async () => {
    const providerError = new Error('429 slow down');
    const thrown = await evaluateGuardrail(guardrail, registry, baseTrace(), {
      judgeProvider: { metadata: judgeMetadata, invoke: () => Promise.reject(providerError) },
      usage: { record: () => Promise.reject(new Error('database unavailable')) },
    }).catch((e: unknown) => e);
    expect(thrown).toBe(providerError);
  });

  test("an answered judge call the sink can't record, retries included, is judge-usage-unrecorded", async () => {
    let tries = 0;
    const outcome = await evaluateGuardrail(guardrail, registry, baseTrace(), {
      judgeProvider: {
        metadata: judgeMetadata,
        invoke: async () => ({
          message: { role: 'assistant', content: 'PASS\nOn topic.' },
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 20 },
          costUsd: 0.0001,
          durationMs: 50,
          provider: { id: 'test-provider', model: 'test-model' },
        }),
      },
      usage: {
        record: () => {
          tries += 1;
          return Promise.reject(new Error('database unavailable'));
        },
      },
    });
    expect(tries).toBe(3);
    expect(outcome).toMatchObject({
      kind: 'err',
      error: {
        code: 'judge-usage-unrecorded',
        message: "The judge's model call couldn't be recorded: database unavailable",
      },
    });
  });
});

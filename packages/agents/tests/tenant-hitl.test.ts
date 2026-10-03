// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { HitlSpec } from '@kindgi/policy-contract';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { resolveTurnHitlPolicy } from '../src/handlers/turn-environment.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';

const HOUR = 60 * 60 * 1000;

function agent(conversationPolicy?: Record<string, unknown>): Agent {
  return {
    id: 'pack.agent',
    version: '1.0.0',
    ...(conversationPolicy !== undefined && { conversationPolicy }),
  } as unknown as Agent;
}

describe("resolveEffectiveHitlPolicy — the tenant's hitl policy", () => {
  test('shortens the timeout, never lengthens it', () => {
    const long = agent({ hitl: { timeoutMs: 48 * HOUR } });
    const short = agent({ hitl: { timeoutMs: 10 * 60 * 1000 } });
    const tenant: HitlSpec = { maxTimeoutMs: HOUR };
    expect(resolveEffectiveHitlPolicy({ tenant, agent: long }).timeoutMs).toBe(HOUR);
    expect(resolveEffectiveHitlPolicy({ tenant, agent: short }).timeoutMs).toBe(10 * 60 * 1000);
    // The framework's 24h default is capped too.
    expect(resolveEffectiveHitlPolicy({ tenant, agent: agent() }).timeoutMs).toBe(HOUR);
  });

  test('raises the reviewer role, never lowers it', () => {
    const senior = agent({ hitl: { defaultReviewerRole: 'senior' } });
    expect(
      resolveEffectiveHitlPolicy({ tenant: { minReviewerRole: 'standard' }, agent: senior })
        .defaultReviewerRole,
    ).toBe('senior');
    expect(
      resolveEffectiveHitlPolicy({ tenant: { minReviewerRole: 'admin' }, agent: senior })
        .defaultReviewerRole,
    ).toBe('admin');
  });

  test("keeps per-tool rules as floors, apart from the agent's own", () => {
    const resolved = resolveEffectiveHitlPolicy({
      tenant: { tools: { 'acme.pay': 'always_ask' } },
      agent: agent({ hitl: { tools: { overrides: { 'acme.pay': 'never_ask' } } } }),
    });
    expect(resolved.tools?.overrides.get('acme.pay')).toEqual({ mode: 'never_ask' });
    expect(resolved.toolFloors?.get('acme.pay')).toEqual({ mode: 'always_ask' });
  });

  test('without one, the agent and framework defaults stand', () => {
    expect(resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() })).toEqual({
      defaultReviewerRole: 'standard',
      timeoutMs: 24 * HOUR,
      onTimeout: 'escalate',
    });
  });
});

describe('resolveTurnHitlPolicy', () => {
  const turnCtx = (policyRegistry?: { evaluate: () => Promise<unknown> }) =>
    ({
      input: { tenantId: 't-1' as TenantId, conversationId: 'conv-1', agent: agent() },
      bindings: { ...(policyRegistry !== undefined && { policyRegistry }) },
    }) as unknown as TurnContext;

  test("applies the tenant's hitl policy", async () => {
    const resolved = await resolveTurnHitlPolicy(
      turnCtx({ evaluate: async () => ({ minReviewerRole: 'admin' }) }),
    );
    expect(resolved.defaultReviewerRole).toBe('admin');
  });

  test('without a registry, or with no hitl checker bound, the agent stands', async () => {
    expect((await resolveTurnHitlPolicy(turnCtx())).defaultReviewerRole).toBe('standard');
    expect(
      (await resolveTurnHitlPolicy(turnCtx({ evaluate: async () => undefined })))
        .defaultReviewerRole,
    ).toBe('standard');
  });

  test("fails the turn when the tenant's policy can't be evaluated", async () => {
    const failing = turnCtx({
      evaluate: async () => {
        throw new Error('policy store unreachable');
      },
    });
    const error = await resolveTurnHitlPolicy(failing).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AgentTurnFailure);
    expect((error as AgentTurnFailure).payload).toEqual({
      code: 'tenant-policy-unavailable',
      message: "The tenant's hitl policy could not be applied: policy store unreachable",
      policyKind: 'hitl',
    });
  });
});

// --- dispatch-tools under the tenant's rules ------------------------------

function lookupTool(ran: unknown[]): AnyTool {
  const defined = defineTool<{ q: string }, { ok: boolean }>({
    id: 'pack.lookup' as ToolId,
    description: 'Looks something up.',
    version: '1.0.0',
    input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    effects: [],
    handler: async (input) => {
      ran.push(input);
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

/** One `pack.lookup` call, under `tenant`'s rules; approvals are granted. */
async function dispatchUnder(tenant: HitlSpec | undefined, a: Agent = agent()) {
  const ran: unknown[] = [];
  const tool = lookupTool(ran);
  const enqueued: Record<string, unknown>[] = [];
  const waits: { readonly tokenId: string; readonly timeoutMs: number }[] = [];
  const ctx = {
    input: { tenantId: 't-1' as TenantId, conversationId: 'conv-1', agent: a },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => ({
          kind: 'ok',
          value: { id: 'msg-1', ...m },
        }),
      },
      hitl: {
        enqueue: async (input: Record<string, unknown>) => {
          enqueued.push(input);
        },
      },
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant, agent: a }),
  } as unknown as TurnContext;
  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'pack.lookup', arguments: { q: 'x' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [{ role: 'user', content: 'look it up' }] as readonly ModelMessage[],
    },
    {
      runId: 'run-1' as RunId,
      waitForToken: async (tokenId: string, options: { readonly timeoutMs: number }) => {
        waits.push({ tokenId, timeoutMs: options.timeoutMs });
        return { decided: 'approve' };
      },
    } as unknown as NodeContext,
  );
  return { ran, enqueued, waits };
}

describe("dispatch-tools — the tenant's per-tool rules", () => {
  test("gate a tool the agent doesn't, with the tenant's role and timeout", async () => {
    const { ran, enqueued, waits } = await dispatchUnder({
      maxTimeoutMs: HOUR,
      tools: { 'pack.lookup': { mode: 'always_ask', requiredRole: 'admin' } },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ subjectKind: 'tool-call:pending', requiredRole: 'admin' });
    expect(waits).toEqual([{ tokenId: expect.any(String), timeoutMs: HOUR }]);
    expect(ran).toEqual([{ q: 'x' }]);
  });

  test("can't loosen the agent's gate", async () => {
    const strict = agent({
      hitl: {
        tools: { overrides: { 'pack.lookup': { mode: 'always_ask', requiredRole: 'senior' } } },
      },
    });
    const { enqueued } = await dispatchUnder({ tools: { 'pack.lookup': 'never_ask' } }, strict);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ requiredRole: 'senior' });
  });

  test('a rule for another tool leaves this one ungated', async () => {
    const { ran, enqueued, waits } = await dispatchUnder({ tools: { 'acme.pay': 'always_ask' } });
    expect(enqueued).toEqual([]);
    expect(waits).toEqual([]);
    expect(ran).toEqual([{ q: 'x' }]);
  });

  test("the tenant's reviewer role applies to the agent's gated tools", async () => {
    const gated = agent({ hitl: { tools: { overrides: { 'pack.lookup': 'always_ask' } } } });
    const { enqueued } = await dispatchUnder({ minReviewerRole: 'senior' }, gated);
    expect(enqueued[0]).toMatchObject({ requiredRole: 'senior' });
  });
});

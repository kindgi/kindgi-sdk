// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { HitlSpec } from '@kindgi/policy-contract';
import { RUN_STARTED_BY, type RunStartedBy, runIsAttended } from '@kindgi/runtime';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';

import type { TurnContext } from '../src/handlers/context.js';
import {
  buildDispatchToolsHandler,
  resolveEffectiveToolHitl,
} from '../src/handlers/dispatch-tools.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

function agent(conversationPolicy?: Record<string, unknown>): Agent {
  return {
    id: 'pack.agent',
    version: '1.0.0',
    ...(conversationPolicy !== undefined && { conversationPolicy }),
  } as unknown as Agent;
}

function refundTool(ran: unknown[], declared: { needsApprovalWhenUnattended?: boolean }): AnyTool {
  const defined = defineTool<{ order: string }, { ok: boolean }>({
    id: 'pack.refund' as ToolId,
    description: 'Refunds an order.',
    version: '1.0.0',
    input: {
      type: 'object',
      properties: { order: { type: 'string' } },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    ...declared,
    handler: async (input) => {
      ran.push(input);
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

const DECLARED = { needsApprovalWhenUnattended: true } as const;
const UNATTENDED: readonly (RunStartedBy | undefined)[] = [
  'key',
  'schedule',
  'webhook',
  'event',
  undefined,
];

describe('runIsAttended', () => {
  test('only a person counts', () => {
    expect(RUN_STARTED_BY.filter((by) => runIsAttended(by))).toEqual(['person']);
    expect(runIsAttended(undefined)).toBe(false);
  });
});

describe("resolveEffectiveToolHitl — a tool that needs a person's yes when unattended", () => {
  const ran: unknown[] = [];

  test.each(UNATTENDED)('waits on every call in a run started by %s', (by) => {
    const gate = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
      refundTool(ran, DECLARED),
      runIsAttended(by),
    );
    expect(gate.mode).toBe('always_ask');
  });

  test("follows the agent's rules in a run a person started: with none, it never asks", () => {
    const gate = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
      refundTool(ran, DECLARED),
      true,
    );
    expect(gate.mode).toBe('never_ask');
  });

  test("an agent's override can't lift it", () => {
    const loose = agent({ hitl: { tools: { overrides: { 'pack.refund': 'never_ask' } } } });
    const unattended = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: loose }),
      refundTool(ran, DECLARED),
      false,
    );
    expect(unattended.mode).toBe('always_ask');
    const attended = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: loose }),
      refundTool(ran, DECLARED),
      true,
    );
    expect(attended.mode).toBe('never_ask');
  });

  test("a tenant's looser rule can't lift it either, and its reviewer role stands", () => {
    const tenant: HitlSpec = {
      tools: { 'pack.refund': { mode: 'never_ask', requiredRole: 'admin' } },
    };
    const gate = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant, agent: agent() }),
      refundTool(ran, DECLARED),
      false,
    );
    expect(gate).toEqual({ mode: 'always_ask', requiredRole: 'admin' });
  });

  test("a tool that doesn't declare it follows the agent's rules, attended or not", () => {
    for (const declared of [{}, { needsApprovalWhenUnattended: false }]) {
      const gate = resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
        refundTool(ran, declared),
        false,
      );
      expect(gate.mode).toBe('never_ask');
    }
  });
});

/** One `pack.refund` call in a turn that started as `startedBy` says. Approvals are granted. */
async function dispatchStartedBy(
  startedBy: RunStartedBy | undefined,
  declared: { needsApprovalWhenUnattended?: boolean },
) {
  const ran: unknown[] = [];
  const tool = refundTool(ran, declared);
  const enqueued: Record<string, unknown>[] = [];
  const waits: string[] = [];
  const a = agent();
  const ctx = {
    input: {
      tenantId: 't-1' as TenantId,
      projectId: 'p-1',
      conversationId: 'conv-1',
      agent: a,
      ...(startedBy !== undefined && { startedBy }),
    },
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
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent: a }),
  } as unknown as TurnContext;
  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'pack.refund', arguments: { order: '7' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [{ role: 'user', content: 'refund order 7' }] as readonly ModelMessage[],
    },
    testNodeContext({
      runId: 'run-1' as RunId,
      waitForToken: (async (tokenId: string) => {
        waits.push(tokenId);
        return { decided: 'approve' };
      }) as NodeContext['waitForToken'],
    }),
  );
  return { ran, enqueued, waits };
}

describe('dispatch-tools — a turn no person started', () => {
  test.each(UNATTENDED)(
    "a declared tool's call waits for a person's yes (started by %s)",
    async (by) => {
      const { ran, enqueued, waits } = await dispatchStartedBy(by, DECLARED);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ subjectKind: 'tool-call:pending' });
      expect(waits).toHaveLength(1);
      // Approved, so it runs.
      expect(ran).toEqual([{ order: '7' }]);
    },
  );

  test("in a turn a person started, a declared tool's call runs as the agent says: at once", async () => {
    const { ran, enqueued, waits } = await dispatchStartedBy('person', DECLARED);
    expect(enqueued).toEqual([]);
    expect(waits).toEqual([]);
    expect(ran).toEqual([{ order: '7' }]);
  });

  test("a tool that doesn't declare it runs at once in a webhook's turn", async () => {
    const { ran, enqueued, waits } = await dispatchStartedBy('webhook', {});
    expect(enqueued).toEqual([]);
    expect(waits).toEqual([]);
    expect(ran).toEqual([{ order: '7' }]);
  });
});

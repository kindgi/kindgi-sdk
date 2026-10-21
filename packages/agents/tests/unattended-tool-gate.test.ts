// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { HitlSpec } from '@kindgi/policy-contract';
import {
  RUN_STARTED_BY,
  type RunStartedBy,
  needsPersonsYesUnattended,
  runIsAttended,
} from '@kindgi/runtime';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';

import { turnInputFromSnapshot } from '../src/invoke.js';
import type { RunSnapshotRecord } from '../src/run-snapshot-binding.js';

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

describe('needsPersonsYesUnattended — the one rule the gate and the runtime share', () => {
  const declared = { id: 'pack.refund', needsApprovalWhenUnattended: true } as const;

  test('a declared tool in a run no person started, unless its trigger lists it', () => {
    for (const by of UNATTENDED) {
      expect(needsPersonsYesUnattended(declared, by, undefined)).toBe(true);
      expect(needsPersonsYesUnattended(declared, by, [])).toBe(true);
      expect(needsPersonsYesUnattended(declared, by, ['pack.other'])).toBe(true);
    }
    for (const by of ['webhook', 'schedule'] as const) {
      expect(needsPersonsYesUnattended(declared, by, ['pack.other', 'pack.refund'])).toBe(false);
    }
  });

  test("only a webhook's or a schedule's run has a list: on any other, one lifts nothing", () => {
    for (const by of ['key', 'event', undefined] as const) {
      expect(needsPersonsYesUnattended(declared, by, ['pack.refund'])).toBe(true);
    }
  });

  test('never in a run a person started, nor for a tool that declares nothing', () => {
    expect(needsPersonsYesUnattended(declared, 'person', undefined)).toBe(false);
    expect(needsPersonsYesUnattended({ id: 'pack.refund' }, 'webhook', undefined)).toBe(false);
    expect(
      needsPersonsYesUnattended(
        { id: 'pack.refund', needsApprovalWhenUnattended: false },
        'schedule',
        undefined,
      ),
    ).toBe(false);
  });

  test('an id that only looks like it is no match: no prefix, case or pattern', () => {
    for (const listed of [['pack.*'], ['pack'], ['PACK.REFUND'], ['pack.refund ']]) {
      expect(needsPersonsYesUnattended(declared, 'schedule', listed)).toBe(true);
    }
  });
});

describe("resolveEffectiveToolHitl — a tool that needs a person's yes when unattended", () => {
  const ran: unknown[] = [];

  test.each(UNATTENDED)('waits on every call in a run started by %s', (by) => {
    const gate = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
      refundTool(ran, DECLARED),
      by === undefined ? {} : { startedBy: by },
    );
    expect(gate.mode).toBe('always_ask');
  });

  test("follows the agent's rules in a run a person started: with none, it never asks", () => {
    const gate = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
      refundTool(ran, DECLARED),
      { startedBy: 'person' },
    );
    expect(gate.mode).toBe('never_ask');
  });

  test("an agent's override can't lift it", () => {
    const loose = agent({ hitl: { tools: { overrides: { 'pack.refund': 'never_ask' } } } });
    const unattended = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: loose }),
      refundTool(ran, DECLARED),
      {},
    );
    expect(unattended.mode).toBe('always_ask');
    const attended = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: loose }),
      refundTool(ran, DECLARED),
      { startedBy: 'person' },
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
      {},
    );
    expect(gate).toEqual({ mode: 'always_ask', requiredRole: 'admin' });
  });

  test("listed by the run's trigger: the agent's rules again, as in a run a person started", () => {
    for (const by of ['schedule', 'webhook'] as const) {
      const gate = resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
        refundTool(ran, DECLARED),
        { startedBy: by, toolsAllowedUnattended: ['pack.refund'] },
      );
      expect(gate.mode).toBe('never_ask');
    }
    const unlisted = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
      refundTool(ran, DECLARED),
      { startedBy: 'webhook', toolsAllowedUnattended: ['pack.other'] },
    );
    expect(unlisted.mode).toBe('always_ask');
  });

  test("listed: the tenant's and the agent's own rules still ask, with their reviewer role", () => {
    const listed = { startedBy: 'schedule', toolsAllowedUnattended: ['pack.refund'] } as const;
    const tenant: HitlSpec = {
      tools: { 'pack.refund': { mode: 'always_ask', requiredRole: 'admin' } },
    };
    expect(
      resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant, agent: agent() }),
        refundTool(ran, DECLARED),
        listed,
      ),
    ).toEqual({ mode: 'always_ask', requiredRole: 'admin' });
    const strict = agent({ hitl: { tools: { overrides: { 'pack.refund': 'always_ask' } } } });
    expect(
      resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant: undefined, agent: strict }),
        refundTool(ran, DECLARED),
        listed,
      ).mode,
    ).toBe('always_ask');
  });

  test("a tool that doesn't declare it follows the agent's rules, attended or not", () => {
    for (const declared of [{}, { needsApprovalWhenUnattended: false }]) {
      const gate = resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
        refundTool(ran, declared),
        {},
      );
      expect(gate.mode).toBe('never_ask');
    }
  });
});

/** One `pack.refund` call in a turn that started as `startedBy` says. Approvals are granted. */
async function dispatchStartedBy(
  startedBy: RunStartedBy | undefined,
  declared: { needsApprovalWhenUnattended?: boolean },
  toolsAllowedUnattended?: readonly string[],
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
      ...(toolsAllowedUnattended !== undefined && { toolsAllowedUnattended }),
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

  test("a declared tool the turn's trigger lists runs at once; one it doesn't list still waits", async () => {
    const listed = await dispatchStartedBy('schedule', DECLARED, ['pack.refund']);
    expect([listed.enqueued, listed.waits, listed.ran]).toEqual([[], [], [{ order: '7' }]]);
    const unlisted = await dispatchStartedBy('schedule', DECLARED, ['pack.other']);
    expect(unlisted.enqueued).toHaveLength(1);
    expect(unlisted.waits).toHaveLength(1);
  });
});

describe('a resumed turn', () => {
  const snapshot = (over: Record<string, unknown>) =>
    ({
      runId: 'run-1',
      tenantId: 't-1',
      projectId: 'p-1',
      agentId: 'pack.agent',
      agentVersion: '1.0.0',
      conversationId: 'conv-1',
      userMessage: 'go',
      dryRun: false,
      startedBy: 'webhook',
      ...over,
    }) as unknown as RunSnapshotRecord;

  test('gets the list its run started with, from the snapshot, never from whoever resumes it', () => {
    expect(
      turnInputFromSnapshot(snapshot({ toolsAllowedUnattended: ['pack.refund'] }), {
        agent: agent(),
      }).toolsAllowedUnattended,
    ).toEqual(['pack.refund']);
    for (const none of [{}, { toolsAllowedUnattended: null }]) {
      expect(turnInputFromSnapshot(snapshot(none), { agent: agent() })).not.toHaveProperty(
        'toolsAllowedUnattended',
      );
    }
  });
});

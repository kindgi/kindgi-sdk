// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `InvokeAgentBindings.authorizeToolCall`: asked before each of a turn's
 * tool calls, before any approval or replay decision, and again once an
 * approval comes back. A denied call runs nothing and its result tells
 * the model; an allowed one runs; each decision is recorded with the call,
 * so the step run again keeps it; a throw fails the step.
 */

import type { Principal } from '@kindgi/authz';
import type { NodeContext } from '@kindgi/handler';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import type { InvokeAgentBindings, ToolCallAuthorization } from '../src/handlers/public-types.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

type AuthorizeInput = Parameters<NonNullable<InvokeAgentBindings['authorizeToolCall']>>[0];

const PRINCIPAL = {
  actor: { kind: 'user', id: 'user-1', tenantId: 't-1' },
} as unknown as Principal;

interface Setup {
  readonly decide?: (input: AuthorizeInput) => Promise<ToolCallAuthorization>;
  /** The step's recorded decisions: pass the same map to run the step again. */
  readonly records?: Map<string, unknown>;
  /** The call waits for a reviewer (`always_ask`). */
  readonly gated?: boolean;
  /** The reviewer's answer (default: approve). It may throw, as a park does. */
  readonly answer?: () => Promise<unknown>;
  /** A replay turn, its replay binding counting what it's asked. */
  readonly replay?: boolean;
  /** Counts the tool's runs, readable when the step throws. */
  readonly runs?: { count: number };
}

/** One model tool call through dispatch-tools: whether the tool ran, what was appended, what was asked. */
async function dispatch(setup: Setup = {}) {
  const records = setup.records ?? new Map<string, unknown>();
  const runs = setup.runs ?? { count: 0 };
  const asked: AuthorizeInput[] = [];
  const appended: Record<string, unknown>[] = [];
  const enqueued: unknown[] = [];
  const waits: string[] = [];
  const replayAsked: unknown[] = [];
  const defined = defineTool<Record<string, unknown>, { ok: boolean }>({
    id: 'pack.refund' as ToolId,
    description: 'Refunds an order.',
    version: '1.0.0',
    input: { type: 'object', additionalProperties: true },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    effects: [],
    mutating: false,
    handler: async () => {
      runs.count += 1;
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  const tool = defined.value as unknown as AnyTool;

  let seq = 0;
  const agent = {
    id: 'pack.agent',
    version: '1.0.0',
    ...(setup.gated === true && {
      conversationPolicy: { hitl: { tools: { overrides: { 'pack.refund': 'always_ask' } } } },
    }),
  } as unknown as Agent;
  const decide = setup.decide;
  const ctx = {
    input: {
      tenantId: 't-1' as TenantId,
      projectId: 'project-1',
      conversationId: 'conv-1',
      agent,
      principal: PRINCIPAL,
      ...(setup.replay === true && { replay: { of: 'run-past', evalRunId: 'eval-1' } }),
    },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          appended.push(m);
          return { kind: 'ok', value: { id: `msg-${++seq}`, ...m } };
        },
      },
      hitl: {
        enqueue: async (input: unknown) => {
          enqueued.push(input);
        },
      },
      replay: {
        decideTool: async (input: unknown) => {
          replayAsked.push(input);
          return { kind: 'live' };
        },
      },
      ...(decide !== undefined && {
        authorizeToolCall: async (input: AuthorizeInput) => {
          asked.push(input);
          return decide(input);
        },
      }),
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
  } as unknown as TurnContext;

  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-9', name: 'pack.refund', arguments: { orderId: '1042' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [],
    },
    testNodeContext(
      {
        runId: 'run-42' as RunId,
        waitForToken: (async (tokenId: string) => {
          waits.push(tokenId);
          return setup.answer !== undefined ? setup.answer() : { decided: 'approve' };
        }) as NodeContext['waitForToken'],
      },
      records,
    ),
  );
  return { ran: () => runs.count, asked, appended, records, enqueued, waits, replayAsked };
}

/** Allowed the first time it's asked, denied after: access lost while the call waited. */
function lostAfterFirst(): (input: AuthorizeInput) => Promise<ToolCallAuthorization> {
  let n = 0;
  return async () =>
    ++n === 1 ? { allowed: true } : { allowed: false, reason: 'You no longer have this tool.' };
}

describe('authorizeToolCall', () => {
  test("is asked with the turn's tenant, project, principal and the tool", async () => {
    const { asked } = await dispatch({ decide: async () => ({ allowed: true }) });
    expect(asked).toEqual([
      { tenantId: 't-1', projectId: 'project-1', principal: PRINCIPAL, toolId: 'pack.refund' },
    ]);
  });

  test('a denied call runs nothing; its result tells the model why, and the turn goes on', async () => {
    const { ran, appended } = await dispatch({
      decide: async () => ({ allowed: false, reason: "You can't refund orders in this project." }),
    });
    expect(ran()).toBe(0);
    expect(appended).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: { status: 'denied', reason: "You can't refund orders in this project." },
      }),
    );
  });

  test('an allowed call runs', async () => {
    const { ran } = await dispatch({ decide: async () => ({ allowed: true }) });
    expect(ran()).toBe(1);
  });

  test('the decision is recorded with the call; the step run again reads it, not the binding', async () => {
    const records = new Map<string, unknown>();
    await dispatch({ decide: async () => ({ allowed: false, reason: 'not yet' }), records });
    // Outside the tool's own `ToolContext.record` keys (`tool-call:…`).
    expect([...records.keys()]).toEqual(['tool-authorize:call-9:pack.refund']);
    const again = await dispatch({ decide: async () => ({ allowed: true }), records });
    expect(again.asked).toEqual([]);
    expect(again.ran()).toBe(0);
  });

  test('absent: every call runs, and nothing is recorded for it', async () => {
    const { ran, records } = await dispatch();
    expect(ran()).toBe(1);
    expect([...records.keys()].some((k) => k.startsWith('tool-authorize:'))).toBe(false);
  });

  test('a denied call that would wait for a reviewer asks none: nothing enqueued, no wait', async () => {
    const denied = await dispatch({
      gated: true,
      decide: async () => ({ allowed: false, reason: 'No.' }),
    });
    expect(denied.ran()).toBe(0);
    expect(denied.enqueued).toEqual([]);
    expect(denied.waits).toEqual([]);
    // The same call, allowed, does wait for one.
    const allowed = await dispatch({ gated: true, decide: async () => ({ allowed: true }) });
    expect(allowed.enqueued).toHaveLength(1);
    expect(allowed.waits).toHaveLength(1);
  });

  test("a replay turn's denied call never reaches the replay binding", async () => {
    const denied = await dispatch({
      replay: true,
      decide: async () => ({ allowed: false, reason: 'No.' }),
    });
    expect(denied.ran()).toBe(0);
    expect(denied.replayAsked).toEqual([]);
    // Allowed, the replay binding decides it.
    const allowed = await dispatch({ replay: true, decide: async () => ({ allowed: true }) });
    expect(allowed.replayAsked).toHaveLength(1);
  });

  test('an authorizer that throws runs nothing, records nothing, and fails the step', async () => {
    const records = new Map<string, unknown>();
    const runs = { count: 0 };
    await expect(
      dispatch({
        records,
        runs,
        decide: async () => {
          throw new Error('authorization is unreachable');
        },
      }),
    ).rejects.toThrow('authorization is unreachable');
    expect(runs.count).toBe(0);
    expect([...records.keys()].some((k) => k.startsWith('tool-authorize:'))).toBe(false);
  });

  test('an approved call is asked again before it runs: still allowed, it runs once', async () => {
    const { ran, asked, waits, records } = await dispatch({
      gated: true,
      decide: async () => ({ allowed: true }),
    });
    expect(waits).toHaveLength(1);
    expect(asked).toHaveLength(2);
    expect(ran()).toBe(1);
    expect([...records.keys()]).toEqual(
      expect.arrayContaining([
        'tool-authorize:call-9:pack.refund',
        'tool-authorize:call-9:pack.refund:approved',
      ]),
    );
  });

  test('approved after access was lost: denied, nothing runs, the model is told', async () => {
    const { ran, asked, waits, appended } = await dispatch({
      gated: true,
      decide: lostAfterFirst(),
    });
    expect(waits).toHaveLength(1);
    expect(asked).toHaveLength(2);
    expect(ran()).toBe(0);
    expect(appended).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: {
          status: 'denied',
          reason:
            'Access changed while this call waited for its approval. You no longer have this tool.',
        },
      }),
    );
  });

  test('the step run again after the approval still asks the second time', async () => {
    const records = new Map<string, unknown>();
    // Parked for its reviewer: the first check is recorded, allowed.
    await expect(
      dispatch({
        records,
        gated: true,
        decide: async () => ({ allowed: true }),
        answer: async () => {
          throw new Error('parked');
        },
      }),
    ).rejects.toThrow('parked');
    expect([...records.keys()]).toContain('tool-authorize:call-9:pack.refund');

    // Approved while access was lost: the step runs again and asks.
    const resumed = await dispatch({
      records,
      gated: true,
      decide: async () => ({ allowed: false, reason: 'You no longer have this tool.' }),
    });
    expect(resumed.asked).toHaveLength(1);
    expect(resumed.ran()).toBe(0);
    expect(JSON.stringify(resumed.appended)).toContain(
      'Access changed while this call waited for its approval.',
    );
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { JournalEntry, RunBinding, RunFlowInput } from '@kindgi/runtime';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { ProjectId, RunId, TenantId, ToolId } from '@kindgi/types';

import type { InvokeAgentBindings } from '../src/handlers/context.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import {
  type ReplayBinding,
  type ReplayToolInput,
  followReplaySessionGate,
  isReadOnlyTool,
  rehydrateReplay,
  replayReport,
  replaySessionApproval,
  replayTag,
} from '../src/handlers/replay.js';
import { buildRunRetrievalsHandler } from '../src/handlers/run-retrievals.js';
import { writeRunSnapshot } from '../src/handlers/run-snapshot.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import { invokeAgent, turnInputFromSnapshot } from '../src/invoke.js';
import type { RunSnapshotRecord, RunSnapshotWriteInput } from '../src/run-snapshot-binding.js';
import type { TurnEvent } from '../src/streaming.js';
import type { Agent, ConversationId, RetrievedFact } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const REPLAY = { of: 'run-past' as RunId, evalRunId: 'eval-1' };

function lookupTool(declared: { mutating?: boolean; effects?: { kind: string }[] }): AnyTool {
  const defined = defineTool<Record<string, unknown>, { found: number }>({
    id: 'pack.lookup' as ToolId,
    description: 'Looks something up.',
    version: '1.0.0',
    input: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    output: { type: 'object', properties: { found: { type: 'number' } }, required: ['found'] },
    effects: [],
    handler: async () => ({ found: 3 }),
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return { ...(defined.value as unknown as AnyTool), ...declared } as AnyTool;
}

interface Dispatched {
  readonly ran: number;
  readonly asked: ReplayToolInput[];
  readonly stored: Record<string, unknown>[];
  readonly events: TurnEvent[];
  readonly waits: string[];
  readonly ctx: TurnContext;
}

/** Run one model tool call through dispatch-tools, as a replay turn unless `replay` is null. */
async function dispatch(options: {
  readonly tool: AnyTool;
  readonly binding?: ReplayBinding | ((input: ReplayToolInput) => ReplayBinding);
  readonly replay?: typeof REPLAY | null;
  readonly gated?: boolean;
  readonly records?: Map<string, unknown>;
}): Promise<Dispatched> {
  let ran = 0;
  const tool = {
    ...options.tool,
    handler: async (...args: unknown[]) => {
      ran += 1;
      return (options.tool as unknown as { handler: (...a: unknown[]) => unknown }).handler(
        ...args,
      );
    },
  } as unknown as AnyTool;
  const asked: ReplayToolInput[] = [];
  const stored: Record<string, unknown>[] = [];
  const events: TurnEvent[] = [];
  const waits: string[] = [];
  const binding: ReplayBinding | undefined =
    options.binding === undefined
      ? undefined
      : {
          decideTool: async (input) => {
            asked.push(input);
            const b =
              typeof options.binding === 'function' ? options.binding(input) : options.binding;
            return (b as ReplayBinding).decideTool(input);
          },
        };
  const agent = {
    id: 'pack.agent',
    version: '1.0.0',
    ...(options.gated === true && {
      conversationPolicy: { hitl: { tools: { overrides: { 'pack.lookup': 'always_ask' } } } },
    }),
  } as unknown as Agent;
  let seq = 0;
  const ctx = {
    input: {
      tenantId: 't-1' as TenantId,
      conversationId: 'conv-1',
      agent,
      ...(options.replay !== null && { replay: options.replay ?? REPLAY }),
    },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          stored.push(m);
          return { kind: 'ok', value: { id: `msg-${++seq}`, sequence: seq, ...m } };
        },
      },
      onEvent: (e: TurnEvent) => {
        events.push(e);
      },
      ...(binding !== undefined && { replay: binding }),
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
      step: 2,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'pack.lookup', arguments: { q: 'order 7' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [],
    },
    testNodeContext(
      {
        runId: 'run-replay' as RunId,
        waitForToken: async (tokenId: string) => {
          waits.push(tokenId);
          return { decided: 'approve' };
        },
      } as never,
      options.records,
    ),
  );
  return { ran, asked, stored, events, waits, ctx };
}

const toolResults = (d: Dispatched) => d.stored.filter((m) => m.role === 'tool');
const completed = (d: Dispatched) => d.events.filter((e) => e.kind === 'tool.completed');

describe('isReadOnlyTool', () => {
  test.each([
    [{ mutating: false }, true],
    [{ mutating: false, effects: [{ kind: 'reads' }, { kind: 'network' }] }, true],
    [{}, false],
    [{ mutating: true }, false],
    [{ mutating: false, effects: [{ kind: 'writes' }] }, false],
    [{ mutating: false, effects: ['external-side-effect'] }, false],
  ])('%j: %s', (tool, readOnly) => {
    expect(isReadOnlyTool(tool)).toBe(readOnly);
  });
});

describe('a replay turn decides each tool call', () => {
  test('with no replay binding, every call is refused and nothing runs', async () => {
    const d = await dispatch({ tool: lookupTool({ mutating: false }) });
    expect(d.ran).toBe(0);
    expect(toolResults(d)[0]?.content).toEqual({
      status: 'not-executed',
      reason: 'replay: no replay binding is wired, so no tool runs',
    });
    expect(completed(d)[0]).toMatchObject({ replay: 'refused' });
  });

  test("recorded: the past run's result, and the tool doesn't run", async () => {
    const d = await dispatch({
      tool: lookupTool({}),
      binding: { decideTool: async () => ({ kind: 'recorded', result: { found: 9 } }) },
    });
    expect(d.ran).toBe(0);
    expect(toolResults(d)[0]).toMatchObject({
      content: { found: 9 },
      toolCall: { toolId: 'pack.lookup', invocationId: 'call-1' },
    });
    expect(completed(d)[0]).toMatchObject({ output: { found: 9 }, replay: 'recorded' });
    expect(replayReport(d.ctx)?.tools).toEqual([
      {
        step: 2,
        callId: 'call-1',
        toolId: 'pack.lookup',
        toolVersion: '1.0.0',
        arguments: { q: 'order 7' },
        source: 'recorded',
      },
    ]);
  });

  test('the binding gets the tool as declared, the arguments and the turn', async () => {
    const d = await dispatch({
      tool: lookupTool({ mutating: false, effects: [{ kind: 'reads' }] }),
      binding: { decideTool: async () => ({ kind: 'live' }) },
    });
    expect(d.asked[0]).toEqual({
      tenantId: 't-1',
      runId: 'run-replay',
      replay: REPLAY,
      tool: { id: 'pack.lookup', version: '1.0.0', mutating: false, effects: ['reads'] },
      arguments: { q: 'order 7' },
      callId: 'call-1',
      gated: false,
    });
  });

  test('live: a read-only tool runs', async () => {
    const d = await dispatch({
      tool: lookupTool({ mutating: false }),
      binding: { decideTool: async () => ({ kind: 'live' }) },
    });
    expect(d.ran).toBe(1);
    expect(toolResults(d)[0]?.content).toEqual({ found: 3 });
    expect(completed(d)[0]).toMatchObject({ replay: 'live' });
    expect(replayReport(d.ctx)?.tools[0]?.source).toBe('live');
  });

  test('recomputed: a tool that reads from nowhere runs, marked recomputed (no divergence)', async () => {
    const d = await dispatch({
      tool: lookupTool({ mutating: false }),
      binding: { decideTool: async () => ({ kind: 'recomputed' }) },
    });
    expect(d.ran).toBe(1);
    expect(completed(d)[0]).toMatchObject({ replay: 'live' });
    expect(replayReport(d.ctx)?.tools[0]).toMatchObject({ source: 'live', recomputed: true });
  });

  test.each([
    ['reads', 'reads'],
    ['reaches the network', 'network'],
  ])(
    'recomputed for a tool that %s: runs as live (its re-run can see other data)',
    async (_name, kind) => {
      const d = await dispatch({
        tool: lookupTool({ mutating: false, effects: [{ kind }] }),
        binding: { decideTool: async () => ({ kind: 'recomputed' }) },
      });
      expect(d.ran).toBe(1);
      expect(replayReport(d.ctx)?.tools[0]?.source).toBe('live');
      expect(replayReport(d.ctx)?.tools[0]?.recomputed).toBeUndefined();
    },
  );

  test('recomputed for a tool that changes things: refused, like live', async () => {
    const d = await dispatch({
      tool: lookupTool({ mutating: true }),
      binding: { decideTool: async () => ({ kind: 'recomputed' }) },
    });
    expect(d.ran).toBe(0);
    expect(replayReport(d.ctx)?.tools[0]?.source).toBe('refused');
  });

  test("live with the past run's env: the tool reads it, the decision keeps it, the report doesn't show it", async () => {
    let seenEnv: unknown;
    const tool = {
      ...lookupTool({ mutating: false }),
      handler: async (_input: unknown, ctx: { readonly env?: unknown }) => {
        seenEnv = ctx.env;
        return { found: 3 };
      },
    } as unknown as AnyTool;
    const records = new Map<string, unknown>();
    const d = await dispatch({
      tool,
      binding: { decideTool: async () => ({ kind: 'live', env: { ORDERS_REGION: 'us' } }) },
      records,
    });
    expect(d.ran).toBe(1);
    expect(seenEnv).toEqual({ ORDERS_REGION: 'us' });
    expect(records.get('replay-tool:call-1')).toMatchObject({
      source: 'live',
      env: { ORDERS_REGION: 'us' },
    });
    expect(replayReport(d.ctx)?.tools[0]).not.toHaveProperty('env');
  });

  test('live without env: the tool gets no preset env (it resolves as usual)', async () => {
    let seenEnv: unknown = 'unset';
    const tool = {
      ...lookupTool({ mutating: false }),
      handler: async (_input: unknown, ctx: { readonly env?: unknown }) => {
        seenEnv = ctx.env;
        return { found: 3 };
      },
    } as unknown as AnyTool;
    await dispatch({ tool, binding: { decideTool: async () => ({ kind: 'live' }) } });
    expect(seenEnv).toBeUndefined();
  });

  test.each([
    ['undeclared (so it changes things)', {}],
    ['mutating', { mutating: true }],
    ['read-only but writing', { mutating: false, effects: [{ kind: 'writes' }] }],
  ])('live for a tool that is %s: refused anyway', async (_name, declared) => {
    const d = await dispatch({
      tool: lookupTool(declared),
      binding: { decideTool: async () => ({ kind: 'live' }) },
    });
    expect(d.ran).toBe(0);
    expect(toolResults(d)[0]?.content).toEqual({
      status: 'not-executed',
      reason: 'replay: this call changes things and has no recorded result',
    });
    expect(replayReport(d.ctx)?.tools[0]).toMatchObject({
      source: 'refused',
      arguments: { q: 'order 7' },
    });
  });

  test('live for a gated read-only tool: refused, never parked', async () => {
    const d = await dispatch({
      tool: lookupTool({ mutating: false }),
      gated: true,
      binding: { decideTool: async () => ({ kind: 'live' }) },
    });
    expect(d.asked[0]?.gated).toBe(true);
    expect(d.ran).toBe(0);
    expect(d.waits).toEqual([]);
    expect(toolResults(d)[0]?.content).toMatchObject({
      reason: 'replay: this call needs an approval and has no recorded result',
    });
  });

  test('a gated call with a recording uses it, and asks no one', async () => {
    const d = await dispatch({
      tool: lookupTool({}),
      gated: true,
      binding: { decideTool: async () => ({ kind: 'recorded', result: { status: 'rejected' } }) },
    });
    expect(d.waits).toEqual([]);
    expect(toolResults(d)[0]?.content).toEqual({ status: 'rejected' });
  });

  test("the binding's own refusal reaches the model as it gave it", async () => {
    const d = await dispatch({
      tool: lookupTool({}),
      binding: {
        decideTool: async () => ({
          kind: 'refused',
          result: { status: 'not-executed', reason: 'custom' },
          reason: 'custom',
        }),
      },
    });
    expect(toolResults(d)[0]?.content).toEqual({ status: 'not-executed', reason: 'custom' });
    expect(replayReport(d.ctx)?.tools[0]).toMatchObject({ source: 'refused', reason: 'custom' });
  });

  test('a decision is made once: the step run again reads it back', async () => {
    const records = new Map<string, unknown>();
    let calls = 0;
    const binding = {
      decideTool: async () => {
        calls += 1;
        return { kind: 'recorded' as const, result: { found: calls } };
      },
    };
    await dispatch({ tool: lookupTool({}), binding, records });
    const again = await dispatch({ tool: lookupTool({}), binding, records });
    expect(calls).toBe(1);
    expect(toolResults(again)[0]?.content).toEqual({ found: 1 });
  });

  test('a turn that is not a replay never asks the binding', async () => {
    const d = await dispatch({
      tool: lookupTool({}),
      replay: null,
      binding: { decideTool: async () => ({ kind: 'recorded', result: {} }) },
    });
    expect(d.asked).toEqual([]);
    expect(d.ran).toBe(1);
    expect(completed(d)[0]).not.toHaveProperty('replay');
    expect(replayReport(d.ctx)).toBeUndefined();
  });

  test('a string result reaches the model as it is', async () => {
    const d = await dispatch({
      tool: lookupTool({}),
      binding: { decideTool: async () => ({ kind: 'recorded', result: 'three found' }) },
    });
    expect(toolResults(d)[0]?.content).toBe('three found');
  });
});

describe('the session approval of a replay', () => {
  function turn(sessionApproval?: ReplayBinding['sessionApproval']): TurnContext {
    return {
      input: { tenantId: 't-1', replay: REPLAY },
      bindings: {
        replay: {
          decideTool: async () => ({ kind: 'live' }),
          ...(sessionApproval !== undefined && { sessionApproval }),
        },
      },
    } as unknown as TurnContext;
  }
  const kctx = () => testNodeContext({ runId: 'run-replay' as RunId });

  test("follows the past run's decision", async () => {
    const ctx = turn(async () => ({ approved: false, rationale: 'not now' }));
    expect(await replaySessionApproval(ctx, kctx())).toEqual({
      approved: false,
      rationale: 'not now',
    });
    expect(ctx.replayApproval).toBe('followed');
  });

  test('with none recorded, the gate is skipped', async () => {
    const ctx = turn(async () => undefined);
    expect(await replaySessionApproval(ctx, kctx())).toBeUndefined();
    expect(ctx.replayApproval).toBe('skipped');
    expect(replayReport(ctx)).toMatchObject({ approval: 'skipped', tools: [] });
  });

  test('a binding without sessionApproval skips it too', async () => {
    const ctx = turn();
    await replaySessionApproval(ctx, kctx());
    expect(ctx.replayApproval).toBe('skipped');
  });
});

describe('a resumed replay turn', () => {
  test('gets its trace and approval back from the journal', () => {
    const entry = (key: string, value: unknown) =>
      ({ kind: 'value.recorded', payload: { scope: 's', key, value } }) as unknown as JournalEntry;
    const ctx = { input: { replay: REPLAY } } as unknown as TurnContext;
    rehydrateReplay(ctx, [
      entry('replay-session-approval', { approval: { approved: true } }),
      entry('replay-tool:call-1', {
        step: 1,
        callId: 'call-1',
        toolId: 'pack.lookup',
        toolVersion: '1.0.0',
        arguments: { q: 'a' },
        source: 'refused',
        reason: 'r',
        result: { status: 'not-executed' },
      }),
      entry('session-hitl-gate', { waitTokenId: 'x' }),
    ]);
    expect(replayReport(ctx)).toEqual({
      ...REPLAY,
      approval: 'followed',
      tools: [
        {
          step: 1,
          callId: 'call-1',
          toolId: 'pack.lookup',
          toolVersion: '1.0.0',
          arguments: { q: 'a' },
          source: 'refused',
          reason: 'r',
        },
      ],
    });
  });

  test('a turn that is not a replay keeps nothing', () => {
    const ctx = { input: {} } as unknown as TurnContext;
    rehydrateReplay(ctx, [
      { kind: 'value.recorded', payload: { scope: 's', key: 'replay-tool:c', value: {} } },
    ] as unknown as JournalEntry[]);
    expect(ctx.replayTrace).toBeUndefined();
  });
});

describe('the replay marker is kept wherever the turn can be run again', () => {
  const tenantId = 't-1' as TenantId;
  const projectId = 'p-1' as ProjectId;
  const conversationId = 'conv-1' as ConversationId;
  const spec = { id: 'pack.agent', version: '1.0.0' } as unknown as Agent;

  test("invokeAgent records it on the turn's run", async () => {
    const seen: RunFlowInput[] = [];
    const runBinding = {
      runGraph: async (input: RunFlowInput) => {
        seen.push(input);
        return { kind: 'err', error: { code: 'journal-error', message: 'stop here', cause: null } };
      },
    } as unknown as RunBinding;
    await invokeAgent(
      { tenantId, projectId, agent: spec, conversationId, userMessage: 'go', replay: REPLAY },
      { runBinding } as unknown as InvokeAgentBindings,
    );
    expect(seen[0]?.replay).toEqual(REPLAY);
  });

  test('the run snapshot keeps it, and a resumed turn gets it back', async () => {
    const written: RunSnapshotWriteInput[] = [];
    const ctx = {
      input: {
        tenantId,
        projectId,
        agent: spec,
        conversationId,
        userMessage: 'go',
        replay: REPLAY,
      },
      bindings: {
        runSnapshotBinding: {
          write: async (w: RunSnapshotWriteInput) => {
            written.push(w);
            return { kind: 'ok', value: undefined };
          },
        },
      },
    } as unknown as TurnContext;
    await writeRunSnapshot(ctx, testNodeContext({ runId: 'run-replay' as RunId }));
    expect(written[0]?.replay).toEqual(REPLAY);
    const snapshot = { ...written[0], dryRun: false } as unknown as RunSnapshotRecord;
    expect(turnInputFromSnapshot(snapshot, { agent: spec }).replay).toEqual(REPLAY);
  });
});

describe('the gate of a replay at the session approval', () => {
  const ctxWith = (approval: { approved: boolean; rationale?: string } | undefined) =>
    ({
      input: { tenantId: 't-1', replay: REPLAY },
      bindings: {
        replay: {
          decideTool: async () => ({ kind: 'live' }),
          sessionApproval: async () => approval,
        },
      },
    }) as unknown as TurnContext;
  const kctx = () => testNodeContext({ runId: 'run-replay' as RunId });

  test('an approval recorded: the turn goes on', async () => {
    await expect(
      followReplaySessionGate(ctxWith({ approved: true }), kctx()),
    ).resolves.toBeUndefined();
  });

  test('none recorded: the turn goes on, and says it skipped the gate', async () => {
    const ctx = ctxWith(undefined);
    await followReplaySessionGate(ctx, kctx());
    expect(ctx.replayApproval).toBe('skipped');
  });

  test('a rejection recorded: the turn fails as the past run did', async () => {
    const failed = followReplaySessionGate(ctxWith({ approved: false, rationale: 'no' }), kctx());
    await expect(failed).rejects.toBeInstanceOf(AgentTurnFailure);
    await expect(failed).rejects.toMatchObject({
      payload: { code: 'hitl-rejected', rationale: 'no' },
    });
  });
});

describe('the retrievals of a replay', () => {
  const fact = {
    fact: { id: 'f-1', text: 'Order 7 shipped' },
    score: 1,
  } as unknown as RetrievedFact;
  async function retrieve(recorded: readonly RetrievedFact[] | undefined, replay = true) {
    let live = 0;
    const ctx = {
      input: {
        tenantId: 't-1',
        conversationId: 'conv-1',
        userMessage: 'where is order 7',
        agent: { id: 'pack.agent', version: '1.0.0', retrieval: [] },
        ...(replay && { replay: REPLAY }),
      },
      bindings: {
        memoryBinding: new Proxy(
          {},
          {
            get: () => async () => {
              live += 1;
              return { kind: 'ok', value: [] };
            },
          },
        ),
        replay: { decideTool: async () => ({ kind: 'live' }), retrievals: async () => recorded },
      },
      conversation: { id: 'conv-1', turnCount: 0 },
      userMessage: { sequence: 1, role: 'user', content: 'where is order 7' },
      appended: [],
    } as unknown as TurnContext;
    const out = (await buildRunRetrievalsHandler(ctx)(
      undefined,
      testNodeContext({ runId: 'run-replay' as RunId }),
    )) as { retrieved: readonly RetrievedFact[] };
    return { out, ctx, live };
  }

  test("uses the past run's, when the binding has them", async () => {
    const { out, ctx } = await retrieve([fact]);
    expect(out.retrieved).toEqual([fact]);
    expect(ctx.retrieved).toEqual([fact]);
  });

  test('retrieves live when the binding has none', async () => {
    const { out } = await retrieve(undefined);
    expect(out.retrieved).toEqual([]);
  });

  test('a turn that is not a replay never asks', async () => {
    const { out } = await retrieve([fact], false);
    expect(out.retrieved).toEqual([]);
  });
});

test("a replay's usage records carry the past run and the eval run", () => {
  expect(replayTag(REPLAY)).toEqual({ of: 'run-past', evalRunId: 'eval-1' });
});

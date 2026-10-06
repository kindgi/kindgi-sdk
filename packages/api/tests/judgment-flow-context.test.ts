// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { Flow } from '@kindgi/flow';
import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import type { TenantId } from '@kindgi/types';

import type { FlowRegistryBinding } from '../src/flow-binding.js';
import {
  MAX_JUDGED_FLOW_CALLS,
  captureFlowContext,
  turnToolCalls,
} from '../src/routes/judgment-flow-context.js';

const tenantId = 't-1' as TenantId;

/** A flow: `lookup` (a tool), `score` (a tool in a loop body), `write` (an agent step), `sub` (a sub-flow). */
const parentFlow = {
  id: 'acme.intake',
  version: '1.0.0',
  nodes: [
    { id: 'lookup', kind: 'tool', ref: 'acme.lookup' },
    {
      id: 'each',
      kind: 'loop',
      body: { nodes: [{ id: 'score', kind: 'tool', ref: 'acme.score' }] },
    },
    { id: 'draft', kind: 'agent', ref: 'acme.drafter' },
    { id: 'sub', kind: 'subgraph', flowRef: { flowId: 'acme.notify', version: '1.0.0' } },
  ],
} as unknown as Flow;
const childFlow = {
  id: 'acme.notify',
  version: '1.0.0',
  nodes: [{ id: 'send', kind: 'tool', ref: 'acme.send' }],
} as unknown as Flow;

const entry = (kind: string, nodeId: string, payload: Record<string, unknown>) => ({
  kind,
  nodeId,
  payload,
});

const journals: Record<string, unknown[]> = {
  'run-flow': [
    entry('step.started', 'lookup', { input: { q: 'order 7' } }),
    entry('step.completed', 'lookup', { output: { found: 2 } }),
    entry('step.started', 'score', { input: { item: 1 }, loopContext: { i: 0 } }),
    entry('step.started', 'score', { input: { item: 2 }, loopContext: { i: 1 } }),
    entry('step.completed', 'score', { output: { s: 0.9 }, loopContext: { i: 1 } }),
    entry('step.completed', 'score', { output: { s: 0.4 }, loopContext: { i: 0 } }),
    entry('step.started', 'draft', { input: {} }),
    entry('step.completed', 'draft', { output: { text: 'not a tool node' } }),
  ],
  'run-sub': [
    entry('step.started', 'send', { input: { to: 'desk' } }),
    entry('step.completed', 'send', { output: { sent: true } }),
  ],
};

const turnOutput = {
  appended: [
    { role: 'user', content: '{}' },
    {
      role: 'agent',
      content: { text: '', toolCalls: [{ id: 'c1', name: 'acme.lookup', arguments: { q: 'x' } }] },
    },
    {
      role: 'tool',
      content: { found: 1 },
      toolCall: { toolId: 'acme.lookup', invocationId: 'c1' },
    },
    { role: 'agent', content: 'Drafted.' },
  ],
  retrieved: [{ fact: { id: 'f-1' } }],
};

const children: Record<string, KernelRunRecord[]> = {
  'run-flow': [
    {
      runId: 'run-turn',
      flowId: 'agent.turn',
      flowVersion: '1.1.0',
      parentNodeId: 'draft',
      parentScope: '',
      agent: { id: 'acme.drafter', version: '0.2.0', conversationId: 'conv-1' },
      output: turnOutput,
    },
    { runId: 'run-sub', flowId: 'acme.notify', flowVersion: '1.0.0', parentNodeId: 'sub' },
  ] as unknown as KernelRunRecord[],
};

function bindings(options: { journal?: Record<string, unknown[]> } = {}) {
  const runBinding = {
    readJournal: async (_t: TenantId, runId: string) => ({
      kind: 'ok',
      value: (options.journal ?? journals)[runId] ?? [],
    }),
    listRuns: async (input: ListRunsInput) => ({
      data: children[input.parent?.runId as unknown as string] ?? [],
    }),
    getRun: async () => null,
  } as unknown as RunBinding;
  const flows = {
    getVersion: async ({ flowId }: { flowId: string }) =>
      flowId === 'acme.intake' ? parentFlow : flowId === 'acme.notify' ? childFlow : null,
  } as unknown as FlowRegistryBinding;
  return { runBinding, flows };
}

const capture = (b = bindings()) =>
  captureFlowContext({
    tenantId,
    run: { runId: 'run-flow', flowId: 'acme.intake', flowVersion: '1.0.0' },
    ...b,
  });

describe('what a judged flow run keeps', () => {
  test("each tool node's call with its input and result, per loop iteration", async () => {
    const ctx = await capture();
    const calls = ctx?.flow?.calls.filter((c) => c.runId === 'run-flow');
    expect(calls).toEqual([
      {
        runId: 'run-flow',
        nodeId: 'lookup',
        toolId: 'acme.lookup',
        arguments: { q: 'order 7' },
        result: { found: 2 },
      },
      {
        runId: 'run-flow',
        nodeId: 'score',
        scope: '{"i":1}',
        toolId: 'acme.score',
        arguments: { item: 2 },
        result: { s: 0.9 },
      },
      {
        runId: 'run-flow',
        nodeId: 'score',
        scope: '{"i":0}',
        toolId: 'acme.score',
        arguments: { item: 1 },
        result: { s: 0.4 },
      },
    ]);
  });

  test("an agent step's turn: its calls and what it retrieved", async () => {
    const ctx = await capture();
    expect(ctx?.flow?.steps).toEqual([
      {
        runId: 'run-turn',
        nodeId: 'draft',
        agentId: 'acme.drafter',
        agentVersion: '0.2.0',
        retrieved: [{ fact: { id: 'f-1' } }],
      },
    ]);
    expect(ctx?.flow?.calls.filter((c) => c.runId === 'run-turn')).toEqual([
      {
        runId: 'run-turn',
        nodeId: 'draft',
        toolId: 'acme.lookup',
        arguments: { q: 'x' },
        result: { found: 1 },
      },
    ]);
  });

  test("a sub-flow's tool calls too", async () => {
    const ctx = await capture();
    expect(ctx?.flow?.calls.filter((c) => c.runId === 'run-sub')).toEqual([
      {
        runId: 'run-sub',
        nodeId: 'send',
        toolId: 'acme.send',
        arguments: { to: 'desk' },
        result: { sent: true },
      },
    ]);
  });

  test('at most 500 calls, and it says it left some out', async () => {
    const many = Array.from({ length: MAX_JUDGED_FLOW_CALLS + 10 }, (_, i) => [
      entry('step.started', 'score', { input: { i }, loopContext: { i } }),
      entry('step.completed', 'score', { output: {}, loopContext: { i } }),
    ]).flat();
    const ctx = await capture(bindings({ journal: { 'run-flow': many } }));
    expect(ctx?.flow?.calls).toHaveLength(MAX_JUDGED_FLOW_CALLS);
    expect(ctx?.flow?.truncated).toBe(true);
  });

  test('a run with nothing to keep keeps nothing', async () => {
    const b = bindings({ journal: {} });
    const ctx = await captureFlowContext({
      tenantId,
      run: { runId: 'run-empty', flowId: 'acme.intake', flowVersion: '1.0.0' },
      ...b,
    });
    expect(ctx).toBeUndefined();
  });

  test("without the flow registry, the tool nodes can't be told apart, but the steps are kept", async () => {
    const { runBinding } = bindings();
    const ctx = await captureFlowContext({
      tenantId,
      run: { runId: 'run-flow', flowId: 'acme.intake', flowVersion: '1.0.0' },
      runBinding,
      flows: undefined,
    });
    expect(ctx?.flow?.calls.map((c) => c.runId)).toEqual(['run-turn']);
    expect(ctx?.flow?.steps).toHaveLength(1);
  });
});

test('a run binding that throws while listing children leaves the rest kept (best effort)', async () => {
  const { runBinding, flows } = bindings();
  const throwing = {
    ...runBinding,
    listRuns: () => {
      throw new Error('not here');
    },
  } as unknown as RunBinding;
  const ctx = await captureFlowContext({
    tenantId,
    run: { runId: 'run-flow', flowId: 'acme.intake', flowVersion: '1.0.0' },
    runBinding: throwing,
    flows,
  });
  expect(ctx?.flow?.calls.map((c) => c.nodeId)).toEqual(['lookup', 'score', 'score']);
  expect(ctx?.flow?.steps).toEqual([]);
});

test("turnToolCalls pairs a turn's tool calls with their results", () => {
  expect(turnToolCalls(turnOutput)).toEqual([
    { toolId: 'acme.lookup', arguments: { q: 'x' }, result: { found: 1 } },
  ]);
  expect(turnToolCalls('text')).toEqual([]);
});

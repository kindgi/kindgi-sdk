// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A turn's provenance is whole whether or not it parked: a turn resumed
 * after a tool-call approval adds the nodes of the steps that ran before
 * the park again, the step it parked in adds every call it holds, a
 * rejected call has its nodes like any other, and each model call is
 * `influenced-by` the tool results it read. A call that waited on an
 * approval shows it, and who decided it.
 */

import { describe, expect, test } from 'vitest';

import { createProviderRegistry } from '@kindgi/capabilities';
import type { ModelMessage, ModelProvider } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import { type Provenance, type ProvenanceBuilder, newBuilder } from '@kindgi/provenance';
import type { JournalEntry } from '@kindgi/runtime';
import { createToolRegistry, defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { ProvenanceId, RunId, Semver, TenantId, Timestamp, ToolId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { buildModelCallHandler } from '../src/handlers/model-call.js';
import { rehydrateTurnContext } from '../src/handlers/rehydrate.js';
import { addRetrievalNodes } from '../src/handlers/turn-provenance.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type {
  Agent,
  AgentId,
  ConversationMessage,
  RetrievalIntent,
  RetrievedFact,
} from '../src/types.js';
import { testNodeContext } from './node-context.js';

const tenantId = 't-1' as TenantId;
const runId = 'run-1' as RunId;
const AT = '2026-10-01T00:00:00Z' as Timestamp;

function builder(): ProvenanceBuilder {
  return newBuilder({ id: 'prov-1' as ProvenanceId, runId, tenantId });
}

function agent(gated = false): Agent {
  const r = defineAgent({
    id: 'pack.agent' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Agent',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [{ id: 'pack.lookup', version: '^1.0.0' }],
    retrieval: [],
    guardrails: [],
    ...(gated && { hitl: { tools: { overrides: { 'pack.lookup': 'always_ask' } } } }),
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

function lookupTool(): AnyTool {
  const defined = defineTool<{ q: string }, { found: string }>({
    id: 'pack.lookup' as ToolId,
    description: 'Looks something up.',
    version: '1.0.0',
    input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    output: {
      type: 'object',
      properties: { found: { type: 'string' } },
      required: ['found'],
      additionalProperties: false,
    },
    effects: [],
    handler: async (input) => ({ found: input.q }),
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

const message = (
  sequence: number,
  role: ConversationMessage['role'],
  extra: Record<string, unknown> = {},
): ConversationMessage =>
  ({ sequence, role, content: `${role} ${sequence}`, createdAt: AT, ...extra }) as never;
const toolCalls = (...ids: string[]) => ({
  content: { text: '', toolCalls: ids.map((id) => ({ id, name: 'pack.lookup', arguments: {} })) },
});
const resultOf = (id: string) => ({
  content: { found: id },
  toolCall: { toolId: 'pack.lookup', invocationId: id },
});

/**
 * This turn: its user message (3), the first iteration's call and its
 * result (4–5), then the second iteration's two calls (6), of which the
 * first ran (7) before the second parked on its approval.
 */
const stored = [
  message(3, 'user'),
  message(4, 'agent', toolCalls('c1')),
  message(5, 'tool', resultOf('c1')),
  message(6, 'agent', toolCalls('c2', 'c3')),
  message(7, 'tool', resultOf('c2')),
];

let sequence = 0;
const completed = (nodeId: string, output: unknown, iteration?: number): JournalEntry =>
  ({
    sequence: ++sequence,
    kind: 'step.completed',
    nodeId,
    payload: {
      output,
      ...(iteration !== undefined && {
        loopContext: {
          loopNodeId: 'agent-loop',
          iteration,
          path: [{ loopNodeId: 'agent-loop', iteration }],
        },
      }),
    },
    timestamp: AT,
  }) as JournalEntry;

const fact = {
  fact: { id: 'fact-1', type: 'note', contentHash: 'sha256:abc' },
  intent: { scope: 'tenant' },
  score: 0.9,
};

/** A turn parked on the approval of `c3` in its second iteration's dispatch-tools. */
const parkedJournal: readonly JournalEntry[] = [
  completed('setup', { turnNumber: 2, providerId: 'p', providerModel: 'p-model', toolCount: 1 }),
  completed('persist-user-message', { sequence: 3 }),
  completed('run-retrievals', { count: 1, retrieved: [fact] }),
  completed(
    'model-call',
    {
      step: 1,
      callId: 'call-1',
      finishReason: 'tool-use',
      provider: { id: 'p', model: 'p-model' },
    },
    0,
  ),
  completed('dispatch-tools', { step: 1, iterationAppended: [stored[1], stored[2]] }, 0),
  completed(
    'model-call',
    {
      step: 2,
      callId: 'call-2',
      finishReason: 'tool-use',
      provider: { id: 'p', model: 'p-model' },
    },
    1,
  ),
];

function provider(answer: () => Promise<unknown>): ModelProvider {
  return {
    metadata: {
      id: 'p',
      region: 'unspecified',
      models: [
        {
          name: 'p-model',
          contextWindow: 128_000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
        },
      ],
    },
    invoke: answer as ModelProvider['invoke'],
  };
}

/** The turn being resumed, with a provenance builder wired. */
function resumedTurn(a: Agent): TurnContext {
  const tool = lookupTool();
  return {
    input: { tenantId, conversationId: 'conv-1', agent: a },
    bindings: {
      conversationBinding: {
        getConversation: async () => ({
          kind: 'ok',
          value: { id: 'conv-1', agentId: a.id, agentVersion: a.version, turnCount: 1 },
        }),
        readMessages: async ({ sinceSequence }: { readonly sinceSequence: number }) => ({
          kind: 'ok',
          value: stored.filter((m) => m.sequence > sinceSequence),
        }),
        appendMessage: async (m: Record<string, unknown>) => ({
          kind: 'ok',
          value: { sequence: 8, createdAt: AT, ...m },
        }),
      },
      toolRegistry: createToolRegistry([tool]),
      providerRegistry: createProviderRegistry([{ tenantId, provider: provider(async () => ({})) }])
        .registry,
      provenance: { newBuilder: () => builder() },
    },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
  } as unknown as TurnContext;
}

/** Every edge's ends are nodes of the DAG. */
function danglingEdges(dag: Provenance): string[] {
  const ids = new Set(dag.nodes.map((n) => n.id));
  return dag.edges
    .filter((e) => !ids.has(e.from) || !ids.has(e.to))
    .map((e) => `${e.from} -${e.kind}-> ${e.to}`);
}

const edge = (from: string, kind: string, to: string) => ({ from, kind, to });

/** The second iteration's dispatch-tools step, run again after the park. */
async function rerunParkedStep(ctx: TurnContext, answer: unknown): Promise<void> {
  ctx.hitlPolicy = resolveEffectiveHitlPolicy({ tenant: undefined, agent: ctx.input.agent });
  await buildDispatchToolsHandler(ctx)(
    {
      step: 2,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c2', name: 'pack.lookup', arguments: { q: 'two' } },
          { id: 'c3', name: 'pack.lookup', arguments: { q: 'three' } },
        ],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'p-model' },
      nextMessages: [{ role: 'user', content: 'look them up' }] as readonly ModelMessage[],
    },
    testNodeContext({
      runId,
      waitForToken: (async () => answer) as NodeContext['waitForToken'],
    }),
  );
}

describe('a turn resumed after a tool-call approval', () => {
  test('rebuilds the provenance of the steps that ran before the park', async () => {
    const ctx = resumedTurn(agent(true));
    expect(await rehydrateTurnContext(ctx, runId, parkedJournal)).toBe(true);
    const dag = ctx.provenance?.snapshot() as Provenance;
    expect(dag.nodes.map((n) => n.id)).toEqual([
      'input:3',
      'retrieval:fact-1',
      'model-call:1',
      'tool-call:c1',
      'tool-result:c1',
      'model-call:2',
    ]);
    expect(dag.nodes.find((n) => n.id === 'model-call:2')).toMatchObject({
      kind: 'model-call',
      timestamp: AT,
      modelVersion: 'p/p-model',
      attributes: { step: 2, callId: 'call-2', providerId: 'p', model: 'p-model' },
    });
    expect(dag.nodes.find((n) => n.id === 'tool-call:c1')?.attributes).toEqual({
      toolId: 'pack.lookup',
      invocationId: 'c1',
      toolVersion: '1.0.0',
      toolVersionRange: '^1.0.0',
    });
    expect(dag.edges).toEqual([
      edge('retrieval:fact-1', 'influenced-by', 'input:3'),
      edge('model-call:1', 'caused-by', 'input:3'),
      edge('tool-call:c1', 'invoked', 'model-call:1'),
      edge('tool-result:c1', 'produced', 'tool-call:c1'),
      edge('model-call:2', 'caused-by', 'input:3'),
      // The second call read the first's tool result.
      edge('model-call:2', 'influenced-by', 'tool-result:c1'),
    ]);
    expect(danglingEdges(dag)).toEqual([]);
  });

  test("approved: the step it parked in adds every call's nodes, the one that ran before the park too", async () => {
    const ctx = resumedTurn(agent(true));
    await rehydrateTurnContext(ctx, runId, parkedJournal);
    await rerunParkedStep(ctx, { decided: 'approve' });
    const dag = ctx.provenance?.snapshot() as Provenance;
    for (const id of ['tool-call:c2', 'tool-result:c2', 'tool-call:c3', 'tool-result:c3']) {
      expect(dag.nodes.map((n) => n.id)).toContain(id);
    }
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        edge('tool-call:c2', 'invoked', 'model-call:2'),
        edge('tool-call:c3', 'invoked', 'model-call:2'),
      ]),
    );
    expect(danglingEdges(dag)).toEqual([]);
    expect(ctx.toolResultIds).toEqual(['c1', 'c2', 'c3']);
  });

  test("rejected: the rejected call has its nodes, its result the reviewer's answer", async () => {
    const ctx = resumedTurn(agent(true));
    await rehydrateTurnContext(ctx, runId, parkedJournal);
    await rerunParkedStep(ctx, { decided: 'reject', rationale: 'not this one' });
    const dag = ctx.provenance?.snapshot() as Provenance;
    expect(dag.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['tool-call:c3', 'tool-result:c3']),
    );
    expect(danglingEdges(dag)).toEqual([]);
  });
});

describe("a model call's provenance", () => {
  test("is influenced-by every tool result of the turn before it, and only this turn's", async () => {
    const provenance = builder();
    provenance.addNode({ id: 'input:3', kind: 'input', timestamp: AT });
    for (const id of ['c1', 'c2']) {
      provenance.addNode({ id: `tool-result:${id}`, kind: 'tool-result', timestamp: AT });
    }
    const ctx = {
      input: { tenantId, conversationId: 'conv-1', agent: agent() },
      bindings: {},
      turnAbort: new AbortController(),
      usage: { steps: 2, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
      provider: provider(async () => ({
        message: { role: 'assistant', content: 'done' },
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        costUsd: 0,
        durationMs: 1,
        provider: { id: 'p', model: 'p-model' },
      })),
      model: { name: 'p-model' },
      tools: { definitions: [], byName: new Map() },
      userMessage: stored[0],
      provenance,
      toolResultIds: ['c1', 'c2'],
    } as unknown as TurnContext;
    await buildModelCallHandler(ctx)(
      {
        // An earlier turn's tool result is in the history too: no edge to it.
        nextMessages: [{ role: 'tool', content: '{}', toolCallId: 'old-turn-call' }],
      },
      testNodeContext({ runId }),
    );
    const dag = provenance.snapshot();
    expect(dag.edges.filter((e) => e.from === 'model-call:3')).toEqual([
      edge('model-call:3', 'caused-by', 'input:3'),
      edge('model-call:3', 'influenced-by', 'tool-result:c1'),
      edge('model-call:3', 'influenced-by', 'tool-result:c2'),
    ]);
    expect(danglingEdges(dag)).toEqual([]);
  });
});

/** A tool call's approval as the journal holds it: its gate, the park, and the decision. */
function approvalEntries(
  invocationId: string,
  value: unknown,
  at: { readonly parked: string; readonly decided: string },
): JournalEntry[] {
  const tokenId = `wait-${invocationId}`;
  return [
    {
      sequence: ++sequence,
      kind: 'value.recorded',
      nodeId: 'dispatch-tools',
      payload: {
        scope: 'dispatch-tools',
        key: `tool-hitl-gate:${invocationId}`,
        value: { argsHash: 'h', waitTokenId: tokenId, requiredRole: 'standard', timeoutMs: 1 },
      },
      timestamp: at.parked,
    },
    {
      sequence: ++sequence,
      kind: 'wait.suspended',
      nodeId: 'dispatch-tools',
      payload: { tokenId },
      timestamp: at.parked,
    },
    {
      sequence: ++sequence,
      kind: 'wait.resumed',
      nodeId: 'dispatch-tools',
      payload: { tokenId, value },
      timestamp: at.decided,
    },
  ] as unknown as JournalEntry[];
}

describe("a tool call's approval in provenance", () => {
  test('each call that waited shows its approval and who decided it: in a completed step, before the park, and the one it parked on', async () => {
    const ctx = resumedTurn(agent(true));
    const journal = [
      ...parkedJournal,
      ...approvalEntries(
        'c1',
        { decided: 'approve', decidedBy: 'user:u-1', approvalId: 'appr-1' },
        { parked: '2026-10-01T00:00:01Z', decided: '2026-10-01T00:00:02Z' },
      ),
      ...approvalEntries(
        'c2',
        { decided: 'approve', decidedBy: 'user:u-2', approvalId: 'appr-2' },
        { parked: '2026-10-01T00:00:03Z', decided: '2026-10-01T00:00:04Z' },
      ),
      ...approvalEntries(
        'c3',
        {
          decided: 'reject',
          rationale: 'not this one',
          decidedBy: 'user:u-3',
          approvalId: 'appr-3',
        },
        { parked: '2026-10-01T00:00:05Z', decided: '2026-10-01T00:00:06Z' },
      ),
    ];
    await rehydrateTurnContext(ctx, runId, journal);
    await rerunParkedStep(ctx, {
      decided: 'reject',
      rationale: 'not this one',
      decidedBy: 'user:u-3',
      approvalId: 'appr-3',
    });
    const dag = ctx.provenance?.snapshot() as Provenance;

    for (const id of ['c1', 'c2', 'c3']) {
      expect(dag.edges).toEqual(
        expect.arrayContaining([
          edge(`tool-call:${id}`, 'waited-on', `tool-hitl-gate-wait:${id}`),
          edge(`tool-hitl-gate-wait:${id}`, 'resumed-from', `tool-hitl-gate-resume:${id}`),
          edge(`tool-result:${id}`, 'caused-by', `tool-hitl-gate-resume:${id}`),
        ]),
      );
    }
    expect(dag.nodes.find((n) => n.id === 'tool-hitl-gate-wait:c2')).toEqual({
      id: 'tool-hitl-gate-wait:c2',
      kind: 'wait',
      timestamp: '2026-10-01T00:00:03Z',
      actor: 'agent:pack.agent',
      attributes: { gate: 'tool-call', invocationId: 'c2', waitTokenId: 'wait-c2' },
    });
    expect(dag.nodes.find((n) => n.id === 'tool-hitl-gate-resume:c2')).toEqual({
      id: 'tool-hitl-gate-resume:c2',
      kind: 'resume',
      timestamp: '2026-10-01T00:00:04Z',
      actor: 'user:u-2',
      attributes: { gate: 'tool-call', decision: 'approve', approvalId: 'appr-2' },
    });
    expect(dag.nodes.find((n) => n.id === 'tool-hitl-gate-resume:c3')).toMatchObject({
      actor: 'user:u-3',
      attributes: {
        gate: 'tool-call',
        decision: 'reject',
        rationale: 'not this one',
        approvalId: 'appr-3',
      },
    });
    expect(danglingEdges(dag)).toEqual([]);
  });

  test('a decision recorded before it named the decider still shows; its resume node names no one', async () => {
    const ctx = resumedTurn(agent(true));
    const journal = [
      ...parkedJournal,
      ...approvalEntries(
        'c3',
        { decided: 'approve' },
        { parked: '2026-10-01T00:00:05Z', decided: '2026-10-01T00:00:06Z' },
      ),
    ];
    await rehydrateTurnContext(ctx, runId, journal);
    await rerunParkedStep(ctx, { decided: 'approve' });
    const dag = ctx.provenance?.snapshot() as Provenance;
    expect(dag.nodes.find((n) => n.id === 'tool-hitl-gate-resume:c3')).toEqual({
      id: 'tool-hitl-gate-resume:c3',
      kind: 'resume',
      timestamp: '2026-10-01T00:00:06Z',
      attributes: { gate: 'tool-call', decision: 'approve' },
    });
    expect(danglingEdges(dag)).toEqual([]);
  });

  test('a call that waited on no approval has none', async () => {
    const ctx = resumedTurn(agent(true));
    await rehydrateTurnContext(ctx, runId, parkedJournal);
    await rerunParkedStep(ctx, { decided: 'approve' });
    const dag = ctx.provenance?.snapshot() as Provenance;
    expect(dag.nodes.filter((n) => n.kind === 'wait' || n.kind === 'resume')).toEqual([]);
  });
});

describe('memory searches', () => {
  test('each intent is a search_memory node; each fact is retrieved-from its search, with its ranks', () => {
    const b = builder();
    const keyword: RetrievalIntent = { types: ['acme.policy'], scope: 'tenant', mode: 'both' };
    const listed: RetrievalIntent = { types: ['acme.note'], scope: 'same-conversation' };
    const input = { sequence: 3, createdAt: AT } as unknown as ConversationMessage;
    const found = {
      fact: { id: 'f-1', type: 'acme.policy', contentHash: 'h-1' },
      // Read back from the journal: an equal intent, not the same object.
      intent: { ...keyword },
      score: 0.03,
      ranks: { keyword: 2, semantic: 1 },
    } as unknown as RetrievedFact;
    addRetrievalNodes(b, [keyword, listed], [found], input);
    const dag = b.snapshot();
    expect(dag.nodes.filter((n) => n.kind === 'memory-read')).toEqual([
      expect.objectContaining({
        id: 'memory-read:search:3:0',
        attributes: {
          operation: 'search_memory',
          intent: 0,
          types: ['acme.policy'],
          scope: 'tenant',
          mode: 'both',
          factIds: ['f-1'],
        },
      }),
      expect.objectContaining({
        id: 'memory-read:search:3:1',
        attributes: expect.objectContaining({ intent: 1, mode: 'list', factIds: [] }),
      }),
    ]);
    expect(dag.nodes.find((n) => n.id === 'retrieval:f-1')?.attributes).toMatchObject({
      ranks: { keyword: 2, semantic: 1 },
    });
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        { from: 'memory-read:search:3:0', to: 'input:3', kind: 'caused-by' },
        { from: 'memory-read:search:3:1', to: 'input:3', kind: 'caused-by' },
        { from: 'retrieval:f-1', to: 'memory-read:search:3:0', kind: 'retrieved-from' },
        { from: 'retrieval:f-1', to: 'input:3', kind: 'influenced-by' },
      ]),
    );
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A turn in a person's own test project that parks on an approval and is
 * resumed keeps its fence. The caller resolves `projectIsTest` from the
 * project, as it does `orgId` (`ResumeAgentTurnInput.projectIsTest`), the
 * rebuilt input carries it, and the approved `remember` call keeps no
 * workspace-wide fact. A run elsewhere remembers it as before.
 */

import { describe, expect, test } from 'vitest';

import { createProviderRegistry } from '@kindgi/capabilities';
import type { ModelMessage, ModelProvider } from '@kindgi/capabilities';
import type { HandlerRegistry, NodeContext } from '@kindgi/handler';
import type { Fact, RememberFactInput, RememberFactResult } from '@kindgi/memory';
import type { JournalEntry } from '@kindgi/runtime';
import { createToolRegistry } from '@kindgi/tools';
import type { NodeId, ProjectId, RunId, Semver, TenantId, Timestamp } from '@kindgi/types';

import { DISPATCH_TOOLS_NODE } from '../src/agent-turn-flow.js';
import { defineAgent } from '../src/define.js';
import { resumeAgentTurn, turnInputFromSnapshot } from '../src/invoke.js';
import { REMEMBER_TOOL_ID } from '../src/remember.js';
import type { RunSnapshotRecord } from '../src/run-snapshot-binding.js';
import type { Agent, AgentId, ConversationMessage } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const tenantId = 't-1' as TenantId;
const projectId = 'p-test' as ProjectId;
const runId = 'run-1' as RunId;

const provider: ModelProvider = {
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
  invoke: async () => {
    throw new Error('not called');
  },
};

/** An agent that remembers for the whole workspace, each time after an approval. */
function agent(): Agent {
  const r = defineAgent({
    id: 'acme.desk' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Desk',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    preferredProvider: 'p',
    memory: { remember: { types: ['preference'], scope: 'tenant' } },
    conversationPolicy: { hitl: { tools: { overrides: { [REMEMBER_TOOL_ID]: 'always_ask' } } } },
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

const snapshotOf = (a: Agent) =>
  ({
    runId,
    tenantId,
    projectId,
    agentId: a.id,
    agentVersion: a.version,
    conversationId: 'conv-1',
    userMessage: 'I prefer email',
    dryRun: false,
    createdAt: '2026-11-07T00:00:00Z',
  }) as unknown as RunSnapshotRecord;

const rememberCall = {
  id: 'c1',
  name: REMEMBER_TOOL_ID,
  arguments: { type: 'preference', content: 'Prefers email' },
};

/** The turn's user message (1), and the model's call it parked on (2). */
const stored = [
  { sequence: 1, role: 'user', content: 'I prefer email' },
  { sequence: 2, role: 'agent', content: { text: '', toolCalls: [rememberCall] } },
].map((m) => ({ ...m, createdAt: '2026-11-07T00:00:00Z' }) as unknown as ConversationMessage);

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
    timestamp: '2026-11-07T00:00:00Z' as Timestamp,
  }) as JournalEntry;

const modelCall = {
  step: 1,
  finishReason: 'tool-use',
  message: { role: 'assistant', content: '', toolCalls: [rememberCall] },
  iterationUsage: { promptTokens: 10, completionTokens: 2 },
  provider: { id: 'p', model: 'p-model' },
  nextMessages: [
    { role: 'system', content: 'Help.' },
    { role: 'user', content: 'I prefer email' },
  ] as readonly ModelMessage[],
};

/** A turn parked in `dispatch-tools`, on the approval of its `remember` call. */
const parkedJournal: readonly JournalEntry[] = [
  completed('setup', { turnNumber: 1, providerId: 'p', providerModel: 'p-model', toolCount: 0 }),
  completed('render-prompt', {}),
  completed('persist-user-message', { sequence: 1 }),
  completed('run-retrievals', { count: 0, retrieved: [] }),
  completed('build-initial-messages', { nextMessages: modelCall.nextMessages }),
  completed('model-call', modelCall, 0),
];

/**
 * Resumes the parked turn with `resumeAgentTurn`, as the runtime does once
 * its approval is decided: the kernel's resume runs `dispatch-tools` again,
 * where the approval answers "approve".
 */
async function resumed(projectIsTest: boolean | undefined) {
  const a = agent();
  const writes: RememberFactInput[] = [];
  const waits: string[] = [];
  let dispatched: { readonly nextMessages: readonly ModelMessage[] } | undefined;
  const bindings = {
    conversationBinding: {
      getConversation: async () => ({
        kind: 'ok',
        value: { id: 'conv-1', tenantId, projectId, agentId: a.id, agentVersion: a.version },
      }),
      readMessages: async ({ sinceSequence }: { readonly sinceSequence: number }) => ({
        kind: 'ok',
        value: stored.filter((m) => m.sequence > sinceSequence),
      }),
      appendMessage: async (m: Record<string, unknown>) => ({
        kind: 'ok',
        value: { sequence: 3, createdAt: '2026-11-07T00:00:00Z', ...m },
      }),
    },
    toolRegistry: createToolRegistry([]),
    providerRegistry: createProviderRegistry([{ tenantId, provider }]).registry,
    hitl: { enqueue: async () => {} },
    memoryWriter: {
      remember: async (input: RememberFactInput) => {
        writes.push(input);
        const fact = {
          id: 'fact-1',
          version: 1,
          type: input.type,
          scope: input.scope,
          content: input.content,
          createdAt: '2026-11-07T00:00:00Z' as Timestamp,
        } as unknown as Fact<{ text: string }>;
        const result: RememberFactResult = { fact, outcome: 'created' };
        return { kind: 'ok', value: result };
      },
    },
    runSnapshotBinding: { read: async () => ({ kind: 'ok', value: snapshotOf(a) }) },
    runBinding: {
      readJournal: async () => ({ kind: 'ok', value: parkedJournal }),
      resumeRun: async ({ handlers }: { readonly handlers: HandlerRegistry }) => {
        const dispatch = handlers.get(DISPATCH_TOOLS_NODE as NodeId);
        if (dispatch === undefined) throw new Error('no dispatch-tools handler');
        dispatched = (await dispatch(
          modelCall,
          testNodeContext({
            runId,
            waitForToken: (async (tokenId: string) => {
              waits.push(tokenId);
              return { decided: 'approve' };
            }) as NodeContext['waitForToken'],
          }),
        )) as typeof dispatched;
        throw new Error('resumed through dispatch-tools');
      },
    },
  };
  await expect(
    resumeAgentTurn(
      {
        tenantId,
        runId,
        agent: a,
        ...(projectIsTest !== undefined && { projectIsTest }),
      },
      bindings as never,
    ),
  ).rejects.toThrow('resumed through dispatch-tools');
  const results = (dispatched?.nextMessages ?? []).filter((m) => m.role === 'tool');
  return {
    writes,
    waits,
    outputs: results.map((m) => JSON.parse(m.content as string) as Record<string, unknown>),
  };
}

describe("a test project's turn, resumed after its approval, keeps its fence", () => {
  test("the rebuilt input carries the caller's projectIsTest, and only when true", () => {
    const a = agent();
    expect(turnInputFromSnapshot(snapshotOf(a), { agent: a, projectIsTest: true })).toMatchObject({
      projectId,
      projectIsTest: true,
    });
    expect(turnInputFromSnapshot(snapshotOf(a), { agent: a })).not.toHaveProperty('projectIsTest');
    expect(
      turnInputFromSnapshot(snapshotOf(a), { agent: a, projectIsTest: false }),
    ).not.toHaveProperty('projectIsTest');
  });

  test('the approved remember call keeps no workspace-wide fact, and nothing is written', async () => {
    const turn = await resumed(true);
    expect(turn.waits).toHaveLength(1);
    expect(turn.writes).toEqual([]);
    expect(turn.outputs).toEqual([
      {
        status: 'not-remembered',
        reason: "Not remembered: a test project's runs remember only inside it.",
      },
    ]);
  });

  test.each([[undefined], [false]] as const)(
    'a run elsewhere (projectIsTest %s) remembers it for the workspace',
    async (projectIsTest) => {
      const turn = await resumed(projectIsTest);
      expect(turn.waits).toHaveLength(1);
      expect(turn.writes).toHaveLength(1);
      expect(turn.writes[0]?.scope).toEqual({ tenantId });
      expect(turn.outputs).toMatchObject([{ status: 'remembered', factId: 'fact-1' }]);
    },
  );
});

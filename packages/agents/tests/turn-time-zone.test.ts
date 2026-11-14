// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A turn reads the workspace's time zone once, from its `time-zone` fact,
 * and hands it to every tool call it makes (`ToolContext.timeZone`). It's
 * UTC when the workspace sets none, when the read fails and when the name
 * isn't a zone; a resumed turn keeps the zone its `setup` journaled.
 */

import { describe, expect, test } from 'vitest';

import { TenantBudgetError } from '@kindgi/bounds';
import { createProviderRegistry } from '@kindgi/capabilities';
import type { ModelProvider } from '@kindgi/capabilities';
import type { Fact, ListFactsInput } from '@kindgi/memory';
import type { JournalEntry } from '@kindgi/runtime';
import { createToolRegistry, defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, Semver, TenantId, Timestamp, ToolId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { rehydrateTurnContext } from '../src/handlers/rehydrate.js';
import { buildSetupHandler } from '../src/handlers/setup.js';
import {
  TIME_ZONE_FACT_TYPE,
  knownTimeZone,
  readWorkspaceTimeZone,
  resolveTurnTimeZone,
} from '../src/handlers/turn-time-zone.js';
import type { Agent, AgentId } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const tenantId = 't-1' as TenantId;
/** No memory budget exists today: a refusal of any budget is the turn's. */
const LIMIT = 'template-render-time' as const;
const AT = '2026-11-05T00:00:00Z' as Timestamp;

/** A workspace-wide `time-zone` fact, as the console writes it. */
function zoneFact(timeZone: unknown, extra: Partial<Fact<unknown>> = {}): Fact<unknown> {
  return {
    id: `fact-${String(timeZone)}`,
    type: TIME_ZONE_FACT_TYPE,
    scope: { tenantId },
    version: 1,
    createdAt: AT,
    content: { timeZone },
    attributedTo: { kind: 'user', id: 'admin-1' },
    ...extra,
  } as unknown as Fact<unknown>;
}

type ListFacts = (input: ListFactsInput) => Promise<unknown>;

/** The memory binding a turn reads with: `listFacts` answers as given, and each read is kept. */
function memory(listFacts: ListFacts) {
  const reads: ListFactsInput[] = [];
  return {
    reads,
    memoryBinding: {
      listFacts: async (input: ListFactsInput) => {
        reads.push(input);
        return listFacts(input);
      },
    },
  };
}

const facts =
  (...found: Fact<unknown>[]): ListFacts =>
  async () => ({ kind: 'ok', value: found });

const turnWith = (listFacts: ListFacts) => {
  const m = memory(listFacts);
  const ctx = { input: { tenantId }, bindings: { memoryBinding: m.memoryBinding } };
  return { ctx: ctx as unknown as TurnContext, reads: m.reads };
};

describe("the workspace's time zone, as a turn reads it", () => {
  test("one read, of the workspace's own facts of the type", async () => {
    const { ctx, reads } = turnWith(facts(zoneFact('America/Toronto')));
    await expect(readWorkspaceTimeZone(ctx)).resolves.toEqual({ timeZone: 'America/Toronto' });
    // No readers: the guard answers workspace-wide facts only.
    expect(reads).toEqual([{ tenantId, type: 'time-zone', limit: 20 }]);
  });

  test('none set: UTC, with no problem', async () => {
    const { ctx } = turnWith(facts());
    await expect(readWorkspaceTimeZone(ctx)).resolves.toEqual({ timeZone: 'UTC' });
  });

  test("the newest counts; an agent's fact and a narrower scope's are ignored", async () => {
    const { ctx } = turnWith(
      facts(
        zoneFact('Europe/Paris', { createdAt: '2026-11-01T00:00:00Z' as Timestamp }),
        zoneFact('Asia/Tokyo', {
          createdAt: '2026-10-01T00:00:00Z' as Timestamp,
          updatedAt: '2026-11-03T00:00:00Z' as Timestamp,
        }),
        zoneFact('America/Denver', {
          createdAt: '2026-11-04T00:00:00Z' as Timestamp,
          attributedTo: { kind: 'agent', id: 'pack.agent' },
        }),
        zoneFact('America/Halifax', {
          createdAt: '2026-11-04T00:00:00Z' as Timestamp,
          scope: { tenantId, userId: 'u-1' } as Fact<unknown>['scope'],
        }),
      ),
    );
    await expect(readWorkspaceTimeZone(ctx)).resolves.toEqual({ timeZone: 'Asia/Tokyo' });
  });

  test("a name that isn't a zone: UTC, and it says so", async () => {
    for (const bad of ['Mars/Olympus', '', 5, undefined]) {
      const { ctx } = turnWith(facts(zoneFact(bad)));
      await expect(readWorkspaceTimeZone(ctx)).resolves.toEqual({
        timeZone: 'UTC',
        problem: 'bad-name',
      });
    }
  });

  test('a read that fails, answered or thrown: UTC, and it says so; the turn goes on', async () => {
    const answered = turnWith(async () => ({
      kind: 'err',
      error: { code: 'storage-error', message: 'down' },
    }));
    await expect(readWorkspaceTimeZone(answered.ctx)).resolves.toEqual({
      timeZone: 'UTC',
      problem: 'read-failed',
    });
    const thrown = turnWith(async () => {
      throw new Error('connection reset');
    });
    await expect(readWorkspaceTimeZone(thrown.ctx)).resolves.toEqual({
      timeZone: 'UTC',
      problem: 'read-failed',
    });
  });

  test("a tenant budget's refusal is the turn's, as wherever its work hits one", async () => {
    const refusal = new TenantBudgetError('over budget', LIMIT, 1000, 500);
    const { ctx } = turnWith(async () => {
      throw refusal;
    });
    await expect(readWorkspaceTimeZone(ctx)).rejects.toBe(refusal);
  });

  test('a name counts when Intl takes it, an alias too, and is answered as Intl resolves it', () => {
    expect(knownTimeZone('America/Toronto')).toBe('America/Toronto');
    expect(knownTimeZone('utc')).toBe('UTC');
    expect(knownTimeZone('US/Eastern')).toBeTypeOf('string');
    expect(knownTimeZone('Mars/Olympus')).toBeUndefined();
    expect(knownTimeZone(' ')).toBeUndefined();
  });
});

describe("the turn's zone, set once", () => {
  const withTools = (count: number, listFacts: ListFacts) => {
    const turn = turnWith(listFacts);
    (turn.ctx as { tools?: unknown }).tools = { definitions: new Array(count).fill({}) };
    return turn;
  };

  test('a turn that offers a tool reads it, and keeps it for its calls', async () => {
    const { ctx, reads } = withTools(1, facts(zoneFact('America/Toronto')));
    await expect(resolveTurnTimeZone(ctx)).resolves.toEqual({ timeZone: 'America/Toronto' });
    expect(ctx.timeZone).toBe('America/Toronto');
    expect(reads).toHaveLength(1);
  });

  test("a turn that offers none doesn't read it", async () => {
    const { ctx, reads } = withTools(0, facts(zoneFact('America/Toronto')));
    await expect(resolveTurnTimeZone(ctx)).resolves.toBeUndefined();
    expect(ctx.timeZone).toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  test('a resumed turn keeps the one setup journaled, without a read', async () => {
    const { ctx, reads } = withTools(1, facts(zoneFact('Asia/Tokyo')));
    await resolveTurnTimeZone(ctx, 'America/Toronto');
    expect(ctx.timeZone).toBe('America/Toronto');
    expect(reads).toHaveLength(0);
  });
});

function lookup(): AnyTool {
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

function agent(): Agent {
  const r = defineAgent({
    id: 'pack.agent' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Agent',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [{ id: 'pack.lookup', version: '^1.0.0' }],
    retrieval: [],
    guardrails: [],
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

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
  invoke: (async () => ({})) as unknown as ModelProvider['invoke'],
};

/** A turn of an agent with one tool, whose workspace's facts `listFacts` answers. */
function turn(listFacts: ListFacts) {
  const a = agent();
  const m = memory(listFacts);
  const ctx = {
    input: { tenantId, projectId: 'p-1', conversationId: 'conv-1', agent: a },
    bindings: {
      runSnapshotBinding: { write: async () => ({ kind: 'ok', value: undefined }) },
      conversationBinding: {
        getConversation: async () => ({
          kind: 'ok',
          value: { id: 'conv-1', agentId: a.id, agentVersion: a.version, turnCount: 1 },
        }),
        readMessages: async () => ({ kind: 'ok', value: [] }),
      },
      toolRegistry: createToolRegistry([lookup()]),
      providerRegistry: createProviderRegistry([{ tenantId, provider }]).registry,
      memoryBinding: m.memoryBinding,
    },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
  } as unknown as TurnContext;
  return { ctx, reads: m.reads };
}

describe('setup reads the zone and journals it; a resumed turn keeps it', () => {
  test('setup sets it for the calls and journals it in its output', async () => {
    const { ctx, reads } = turn(facts(zoneFact('America/Toronto')));
    const output = await buildSetupHandler(ctx)({}, testNodeContext({ runId: 'run-1' as RunId }));
    expect(ctx.timeZone).toBe('America/Toronto');
    expect(output).toMatchObject({ timeZone: 'America/Toronto' });
    expect(output).not.toHaveProperty('timeZoneProblem');
    expect(reads).toHaveLength(1);
  });

  test('a fallback is journaled with why', async () => {
    const { ctx } = turn(facts(zoneFact('Mars/Olympus')));
    const output = await buildSetupHandler(ctx)({}, testNodeContext({ runId: 'run-1' as RunId }));
    expect(output).toMatchObject({ timeZone: 'UTC', timeZoneProblem: 'bad-name' });
  });

  const route = { turnNumber: 2, providerId: 'p', providerModel: 'p-model', toolCount: 1 };
  const journal = (setupOutput: Record<string, unknown>): readonly JournalEntry[] => [
    {
      sequence: 1,
      kind: 'step.completed',
      nodeId: 'setup',
      payload: { output: setupOutput },
      timestamp: AT,
    } as unknown as JournalEntry,
  ];

  test("a resumed turn keeps setup's zone, though the workspace changed it meanwhile", async () => {
    const { ctx, reads } = turn(facts(zoneFact('Asia/Tokyo')));
    await rehydrateTurnContext(ctx, 'run-1', journal({ ...route, timeZone: 'America/Toronto' }));
    expect(ctx.timeZone).toBe('America/Toronto');
    expect(reads).toHaveLength(0);
  });

  test('a journal from before setup recorded it reads the workspace now', async () => {
    const { ctx, reads } = turn(facts(zoneFact('Asia/Tokyo')));
    await rehydrateTurnContext(ctx, 'run-1', journal(route));
    expect(ctx.timeZone).toBe('Asia/Tokyo');
    expect(reads).toHaveLength(1);
  });
});

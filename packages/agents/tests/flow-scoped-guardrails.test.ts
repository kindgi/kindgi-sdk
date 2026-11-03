// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A guardrail scoped to flows (`scope.flows`) applies to the turns of
 * those flows' steps, and to no other turn: the gate gives the trace the
 * flow whose step started the turn, read from the turn's parent run, or
 * from the turn's own run once it has resumed; a replay takes the flow of
 * the turn it replays. A run that can't be read, or a replayed run that's
 * gone, fails the step, so the guardrail is never passed over unseen. A
 * turn with no guardrail scoped to flows reads no run.
 */

import { describe, expect, test } from 'vitest';

import type { Guardrail, RunTrace } from '@kindgi/guardrails';
import { createCheckRegistry } from '@kindgi/guardrails';
import type { RunBinding } from '@kindgi/runtime';
import type { GuardrailId, NodeId, RunId, TenantId } from '@kindgi/types';

import { AGENT_TURN_FLOW_ID } from '../src/agent-turn-flow.js';
import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildEvaluateGuardrailsHandler } from '../src/handlers/evaluate-guardrails.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { ConversationId } from '../src/types.js';

import { testNodeContext } from './node-context.js';
import { type TestRun, runsOf } from './turn-runs.js';

const tenantId = 'acme' as TenantId;
const TURN = 'run-turn-1';
const FLOW_RUN = 'run-flow-1';
/** A past turn that a replay replays. */
const PAST = 'run-turn-0';

/** Halts in the refunds flow's steps only. */
const REFUNDS_ONLY = {
  id: 'acme.refund-limit' as GuardrailId,
  kind: 'zero-llm',
  check: 'acme.over-limit',
  action: { 'on-violation': 'halt' },
  scope: { flows: ['acme.refunds'] },
} as unknown as Guardrail;

/** Logs on every turn: shows the gate ran. */
const EVERYWHERE = {
  id: 'acme.tone',
  kind: 'zero-llm',
  check: 'acme.tone-check',
  action: { 'on-violation': 'log-only' },
} as unknown as Guardrail;

interface Turn {
  readonly ctx: TurnContext;
  /** The traces each check saw, by check. */
  readonly seen: Record<string, RunTrace[]>;
  readonly reads: string[];
}

function turn(options: {
  /** The flow run that started the turn, as a started step's input names it. */
  readonly parent?: string;
  /** The past run the turn replays (`replay.of`). */
  readonly replay?: string;
  readonly runs?: Readonly<Record<string, TestRun>>;
  readonly runBinding?: RunBinding;
  /** The agent's guardrails; both by default. */
  readonly guardrails?: readonly Guardrail[];
}): Turn {
  const guardrails = options.guardrails ?? [REFUNDS_ONLY, EVERYWHERE];
  const agent = defineAgent({
    id: 'acme.refunds-agent',
    version: '1.0.0',
    name: 'Refunds',
    instructions: 'Decide the refund.',
    capabilities: [{ needs: [] }],
    tools: [],
    retrieval: [],
    guardrails: guardrails.map((g) => g.id),
  });
  if (agent.kind === 'err') throw new Error('agent spec invalid');
  const seen: Record<string, RunTrace[]> = { 'acme.over-limit': [], 'acme.tone-check': [] };
  const checks = createCheckRegistry();
  for (const id of Object.keys(seen)) {
    checks.register({
      id,
      kind: 'zero-llm',
      evaluate: async (_config, trace) => {
        seen[id]?.push(trace);
        return { passed: false, reason: 'refund of $900 is over the $500 limit' };
      },
    });
  }
  const { runBinding, reads } =
    options.runBinding !== undefined
      ? { runBinding: options.runBinding, reads: [] }
      : runsOf(tenantId, options.runs ?? {});
  const ctx = {
    input: {
      tenantId,
      projectId: 'p-1' as never,
      agent: agent.value,
      conversationId: 'c-1' as ConversationId,
      userMessage: '{ "order": "A-1042", "amount": 900 }',
      ...(options.parent !== undefined && {
        parent: { runId: options.parent as RunId, nodeId: 'decide' as NodeId, scope: '' },
      }),
      ...(options.replay !== undefined && {
        replay: { of: options.replay as RunId, testRunId: 'eval-1' },
      }),
    },
    bindings: { checks, runBinding } as unknown as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0 },
    abortReason: undefined,
    guardrails,
  } as unknown as TurnContext;
  return { ctx, seen, reads };
}

const loopOutput = {
  finalOutput: {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'Refund A-1042: $900, approved.' },
    iterationAppended: [],
    iterationUsage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
    provider: { id: 'echo', model: 'echo-1' },
    finishedTurn: true,
    nextMessages: [],
  },
  iterations: 1,
  stopReason: 'exit-condition',
};

const evaluate = (ctx: TurnContext): Promise<unknown> =>
  buildEvaluateGuardrailsHandler(ctx)(
    loopOutput,
    testNodeContext({ runId: TURN as RunId, nodeId: 'evaluate-guardrails' as NodeId }),
  ).catch((e: unknown) => e);

const outsideAnyFlow: TestRun = { flowId: AGENT_TURN_FLOW_ID };
const stepOf = (parentRunId: string): TestRun => ({ flowId: AGENT_TURN_FLOW_ID, parentRunId });

describe('a guardrail scoped to flows', () => {
  test("in a step of its flow, it runs: the turn's trace names the flow, and the halt fails the turn", async () => {
    const { ctx, seen, reads } = turn({
      parent: FLOW_RUN,
      runs: { [TURN]: stepOf(FLOW_RUN), [FLOW_RUN]: { flowId: 'acme.refunds' } },
    });
    const thrown = await evaluate(ctx);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'guardrail-violation',
      violations: [{ guardrailId: 'acme.refund-limit' }],
    });
    expect(seen['acme.over-limit']?.map((t) => t.flowId)).toEqual(['acme.refunds']);
    expect(seen['acme.tone-check']?.map((t) => t.flowId)).toEqual(['acme.refunds']);
    // A started step's input names its flow run: the turn's own run isn't read.
    expect(reads).toEqual([FLOW_RUN]);
  });

  test('in a step of another flow, it is skipped; the turn goes on', async () => {
    const { ctx, seen } = turn({
      parent: FLOW_RUN,
      runs: { [TURN]: stepOf(FLOW_RUN), [FLOW_RUN]: { flowId: 'acme.orders' } },
    });
    const output = await evaluate(ctx);
    expect(output).not.toBeInstanceOf(Error);
    expect(seen['acme.over-limit']).toEqual([]);
    expect(seen['acme.tone-check']?.map((t) => t.flowId)).toEqual(['acme.orders']);
  });

  test('outside any flow, it is skipped, and the trace names no flow', async () => {
    const { ctx, seen, reads } = turn({ runs: { [TURN]: outsideAnyFlow } });
    const output = await evaluate(ctx);
    expect(output).not.toBeInstanceOf(Error);
    expect(seen['acme.over-limit']).toEqual([]);
    expect(seen['acme.tone-check']?.map((t) => t.flowId)).toEqual([undefined]);
    expect(reads).toEqual([TURN]);
  });

  test("in a step's resumed turn, its own run names the flow run, and it runs", async () => {
    // A resumed turn's input is rebuilt from its snapshot, which keeps no parent.
    const { ctx, seen, reads } = turn({
      runs: { [TURN]: stepOf(FLOW_RUN), [FLOW_RUN]: { flowId: 'acme.refunds' } },
    });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({ code: 'guardrail-violation' });
    expect(seen['acme.over-limit']?.map((t) => t.flowId)).toEqual(['acme.refunds']);
    expect(reads).toEqual([TURN, FLOW_RUN]);
  });
});

describe('a replay takes the flow of the turn it replays', () => {
  /**
   * A chain of `hops` replays back from `replay-0` to a step's turn of
   * the refunds flow: `replay-0` replays `replay-1`, and so on, and
   * `replay-<hops>` is the step's turn.
   */
  const replayChain = (hops: number): Record<string, TestRun> => {
    const runs: Record<string, TestRun> = {
      [`replay-${hops}`]: stepOf(FLOW_RUN),
      [FLOW_RUN]: { flowId: 'acme.refunds' },
    };
    for (let i = 0; i < hops; i++) {
      runs[`replay-${i}`] = { flowId: AGENT_TURN_FLOW_ID, replayOf: `replay-${i + 1}` };
    }
    return runs;
  };

  test("a replay of a step's turn of its flow runs it, as the original turn did", async () => {
    // A replay starts with no parent: the turn it replays names the flow run.
    const { ctx, seen, reads } = turn({
      replay: PAST,
      runs: { [PAST]: stepOf(FLOW_RUN), [FLOW_RUN]: { flowId: 'acme.refunds' } },
    });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({ code: 'guardrail-violation' });
    expect(seen['acme.over-limit']?.map((t) => t.flowId)).toEqual(['acme.refunds']);
    expect(reads).toEqual([PAST, FLOW_RUN]);
  });

  test('a replay of a turn outside any flow skips it', async () => {
    const { ctx, seen, reads } = turn({ replay: PAST, runs: { [PAST]: outsideAnyFlow } });
    const output = await evaluate(ctx);
    expect(output).not.toBeInstanceOf(Error);
    expect(seen['acme.over-limit']).toEqual([]);
    expect(seen['acme.tone-check']?.map((t) => t.flowId)).toEqual([undefined]);
    expect(reads).toEqual([PAST]);
  });

  test("a replay of a replay of a step's turn of its flow runs it", async () => {
    const { ctx, seen, reads } = turn({
      replay: 'replay-0',
      runs: replayChain(1),
    });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({ code: 'guardrail-violation' });
    expect(seen['acme.over-limit']?.map((t) => t.flowId)).toEqual(['acme.refunds']);
    expect(reads).toEqual(['replay-0', 'replay-1', FLOW_RUN]);
  });

  test('a chain of 10 replays back to the step is followed to the end', async () => {
    const { ctx, seen } = turn({ replay: 'replay-0', runs: replayChain(10) });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({ code: 'guardrail-violation' });
    expect(seen['acme.over-limit']?.map((t) => t.flowId)).toEqual(['acme.refunds']);
  });

  test('a chain past 10 replays fails the step, as an unreadable run does', async () => {
    const { ctx, seen, reads } = turn({ replay: 'replay-0', runs: replayChain(11) });
    const thrown = await evaluate(ctx);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message: "Run replay-0's replay chain goes on past 10 replays, so the turn's flow is unknown",
    });
    expect(reads).toHaveLength(11);
    expect(seen['acme.over-limit']).toEqual([]);
    expect(seen['acme.tone-check']).toEqual([]);
  });

  test('a chain that comes back to a run fails the step', async () => {
    const { ctx, seen, reads } = turn({
      replay: 'replay-a',
      runs: {
        'replay-a': { flowId: AGENT_TURN_FLOW_ID, replayOf: 'replay-b' },
        'replay-b': { flowId: AGENT_TURN_FLOW_ID, replayOf: 'replay-a' },
      },
    });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message:
        "Run replay-a comes back in run replay-a's replay chain, so the turn's flow is unknown",
    });
    expect(reads).toEqual(['replay-a', 'replay-b']);
    expect(seen['acme.over-limit']).toEqual([]);
  });

  test('a replay whose past run is gone fails the step, saying so', async () => {
    // An eval case keeps its own input, so it can replay a run that retention has purged.
    const { ctx, seen, reads } = turn({ replay: PAST, runs: {} });
    const thrown = await evaluate(ctx);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message: `Run ${PAST}, which this turn replays, is gone, so the turn's flow is unknown`,
    });
    expect(reads).toEqual([PAST]);
    expect(seen['acme.over-limit']).toEqual([]);
    expect(seen['acme.tone-check']).toEqual([]);
  });

  test('a replay of a replay whose earlier run is gone fails the step the same way', async () => {
    const { ctx, reads } = turn({
      replay: 'replay-0',
      runs: { 'replay-0': { flowId: AGENT_TURN_FLOW_ID, replayOf: 'replay-1' } },
    });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message: "Run replay-1, which this turn replays, is gone, so the turn's flow is unknown",
    });
    expect(reads).toEqual(['replay-0', 'replay-1']);
  });

  test("a replay whose past turn's flow run is gone says that run wasn't found: it isn't the one replayed", async () => {
    const { ctx, seen, reads } = turn({ replay: PAST, runs: { [PAST]: stepOf(FLOW_RUN) } });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message: `Run ${FLOW_RUN} wasn't found, so the turn's flow is unknown`,
    });
    expect(reads).toEqual([PAST, FLOW_RUN]);
    expect(seen['acme.over-limit']).toEqual([]);
  });
});

describe("a run that can't be read fails the step; no guardrail is passed over", () => {
  test('a flow run that is not there', async () => {
    const { ctx, seen } = turn({ parent: FLOW_RUN, runs: { [TURN]: stepOf(FLOW_RUN) } });
    const thrown = await evaluate(ctx);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message: `Run ${FLOW_RUN} wasn't found, so the turn's flow is unknown`,
    });
    expect(seen['acme.over-limit']).toEqual([]);
    expect(seen['acme.tone-check']).toEqual([]);
  });

  test("a resumed turn's own run that is not there", async () => {
    const { ctx } = turn({ runs: {} });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message: `Run ${TURN} wasn't found, so the turn's flow is unknown`,
    });
  });

  test('a read that fails, saying why', async () => {
    const cause = new Error('connection reset');
    const { ctx, seen } = turn({
      parent: FLOW_RUN,
      runBinding: {
        getRun: () => Promise.reject(cause),
      } as unknown as RunBinding,
    });
    const thrown = await evaluate(ctx);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message: `Run ${FLOW_RUN} couldn't be read to find the turn's flow: connection reset`,
      cause,
    });
    expect(seen['acme.over-limit']).toEqual([]);
  });
});

describe('a turn with no guardrail scoped to flows reads no run, and never fails on one', () => {
  test('a turn with no guardrails', async () => {
    const { ctx, reads } = turn({ parent: FLOW_RUN, runs: {}, guardrails: [] });
    const output = await evaluate(ctx);
    expect(output).not.toBeInstanceOf(Error);
    expect(reads).toEqual([]);
  });

  test("a step's turn: its guardrails run, and the trace names no flow", async () => {
    const { ctx, seen, reads } = turn({
      parent: FLOW_RUN,
      runs: { [TURN]: stepOf(FLOW_RUN), [FLOW_RUN]: { flowId: 'acme.refunds' } },
      guardrails: [EVERYWHERE],
    });
    const output = await evaluate(ctx);
    expect(output).not.toBeInstanceOf(Error);
    expect(seen['acme.tone-check']?.map((t) => t.flowId)).toEqual([undefined]);
    expect(reads).toEqual([]);
  });

  test('a guardrail with an empty `flows` list applies to every turn, so it reads none', async () => {
    const anyFlow = { ...EVERYWHERE, scope: { flows: [] } } as unknown as Guardrail;
    const { ctx, seen, reads } = turn({ parent: FLOW_RUN, runs: {}, guardrails: [anyFlow] });
    const output = await evaluate(ctx);
    expect(output).not.toBeInstanceOf(Error);
    expect(seen['acme.tone-check']).toHaveLength(1);
    expect(reads).toEqual([]);
  });

  test('a replay whose past run is gone runs its guardrails', async () => {
    const { ctx, seen, reads } = turn({ replay: PAST, runs: {}, guardrails: [EVERYWHERE] });
    const output = await evaluate(ctx);
    expect(output).not.toBeInstanceOf(Error);
    expect(seen['acme.tone-check']).toHaveLength(1);
    expect(reads).toEqual([]);
  });

  test("a replay whose past run's flow run is gone runs its guardrails", async () => {
    const { ctx, seen, reads } = turn({
      replay: PAST,
      runs: { [PAST]: stepOf(FLOW_RUN) },
      guardrails: [EVERYWHERE],
    });
    const output = await evaluate(ctx);
    expect(output).not.toBeInstanceOf(Error);
    expect(seen['acme.tone-check']).toHaveLength(1);
    expect(reads).toEqual([]);
  });
});

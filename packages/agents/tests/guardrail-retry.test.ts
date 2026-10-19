// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A `retry` guardrail sends a failed answer back to the model, in the same
 * turn: the agent loop's `budget-check` judges each finished answer on the
 * turn's `halt` and `retry` guardrails, sends it back with a note while the
 * guardrail's attempts last, and fails the turn with `guardrail-violation`
 * after that. `evaluate-guardrails` then judges the answer the loop let
 * finish on the other guardrails only, and only when the loop's final
 * output is that answer; any other final output (a turn resumed in another
 * process) is judged on every guardrail there.
 */

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type {
  CheckRegistry,
  Guardrail,
  GuardrailOutcomeRecord,
  RunTrace,
} from '@kindgi/guardrails';
import { createCheckRegistry } from '@kindgi/guardrails';
import type { NodeContext } from '@kindgi/handler';
import { compileJsonSchema } from '@kindgi/schema';
import type { GuardrailId, NodeId, RunId, TenantId } from '@kindgi/types';

import {
  AGENT_TURN_FLOW,
  AGENT_TURN_FLOW_VERSION,
  AGENT_TURN_LOOP_MAX_ITERATIONS,
} from '../src/agent-turn-flow.js';
import { defineAgent } from '../src/define.js';
import { buildBudgetCheckHandler } from '../src/handlers/budget-check.js';
import { buildBuildInitialMessagesHandler } from '../src/handlers/build-initial-messages.js';
import type { AgentTurnIterationOutput, TurnContext } from '../src/handlers/context.js';
import { parseFailureMessage } from '../src/handlers/errors.js';
import { buildEvaluateGuardrailsHandler } from '../src/handlers/evaluate-guardrails.js';
import {
  DEFAULT_GUARDRAIL_ATTEMPTS,
  retryNote,
  retryNotes,
  sentBackSoFar,
  turnRetryNotes,
} from '../src/handlers/guardrail-retry.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { TurnEvent } from '../src/streaming.js';
import type { AgentOutputSpec, ConversationId, ConversationMessage } from '../src/types.js';

const tenantId = 'acme' as TenantId;
const runId = '00000000-0000-0000-0000-0000000000dd' as RunId;

/** A guardrail naming `check`, with `action`. */
const guardrail = (id: string, check: string, action: Record<string, unknown>): Guardrail =>
  ({ id: id as GuardrailId, kind: 'zero-llm', check, action }) as unknown as Guardrail;

const RETRY = (id: string, check: string, maxAttempts?: number) =>
  guardrail(id, check, {
    'on-violation': 'retry',
    ...(maxAttempts !== undefined && { retry: { maxAttempts } }),
  });
const HALT = (id: string, check: string) => guardrail(id, check, { 'on-violation': 'halt' });
const LOG = (id: string, check: string) => guardrail(id, check, { 'on-violation': 'log-only' });

interface Seen {
  readonly events: TurnEvent[];
  readonly recorded: GuardrailOutcomeRecord[];
  readonly nodes: { id: string; attributes?: Record<string, unknown> }[];
  /** Each check's calls, by check id. */
  readonly calls: Map<string, number>;
}

/**
 * Checks that fail an answer containing their word: `acme.no-<word>`
 * fails on `<word>`, with a reason naming it. The calls are counted.
 */
function checksFor(seen: Seen, words: readonly string[]): CheckRegistry {
  const checks = createCheckRegistry();
  for (const word of words) {
    const id = `acme.no-${word}`;
    checks.register({
      id,
      kind: 'zero-llm',
      evaluate: async (_config: unknown, trace: RunTrace) => {
        seen.calls.set(id, (seen.calls.get(id) ?? 0) + 1);
        return (trace.output ?? '').includes(word)
          ? { passed: false, reason: `the answer says "${word}"` }
          : { passed: true };
      },
    });
  }
  return checks;
}

const WORDS = ['secret', 'rude', 'vague', 'long'];

function turn(
  guardrails: readonly Guardrail[],
  options: { readonly maxSteps?: number; readonly output?: AgentOutputSpec } = {},
): { ctx: TurnContext; seen: Seen } {
  const agent = defineAgent({
    id: 'acme.helper',
    version: '1.0.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [] }],
    tools: [],
    retrieval: [],
    guardrails: guardrails.map((g) => g.id),
    ...(options.maxSteps !== undefined && { budget: { maxSteps: options.maxSteps } }),
    ...(options.output !== undefined && { output: options.output }),
  });
  if (agent.kind === 'err') throw new Error(JSON.stringify(agent.error));
  const seen: Seen = { events: [], recorded: [], nodes: [], calls: new Map() };
  const ctx = {
    input: {
      tenantId,
      projectId: 'p-1' as never,
      agent: agent.value,
      conversationId: 'c-1' as ConversationId,
      userMessage: 'Where is order A-1042?',
    },
    bindings: {
      checks: checksFor(seen, WORDS),
      guardrailOutcomes: {
        record: async (r: GuardrailOutcomeRecord) => void seen.recorded.push(r),
      },
      onEvent: (e: TurnEvent) => void seen.events.push(e),
    } as unknown as InvokeAgentBindings,
    provenance: {
      addNode: (n: { id: string; attributes?: Record<string, unknown> }) => void seen.nodes.push(n),
      addEdge: () => undefined,
    },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0 },
    abortReason: undefined,
    guardrails,
    // The loop starts with the person's message (`USER`).
    initialMessageCount: 1,
  } as unknown as TurnContext;
  return { ctx, seen };
}

/** The loop body's context at `iteration`, as the kernel gives it. */
const bodyStep = (iteration: number, dryRun = false) =>
  ({
    runId,
    dryRun,
    nodeId: 'budget-check' as NodeId,
    state: { $loop: { iteration } },
  }) as unknown as NodeContext;

const outerStep = (dryRun = false) =>
  ({ runId, dryRun, nodeId: 'evaluate-guardrails' as NodeId }) as unknown as NodeContext;

const USER: ModelMessage = { role: 'user', content: 'Where is order A-1042?' };

/** `budget-check`'s input for a finished answer, sent with `sent`. */
function answer(content: string, sent: readonly ModelMessage[] = [USER]) {
  return {
    step: 1,
    finishReason: 'stop',
    message: { role: 'assistant', content },
    iterationAppended: [],
    iterationUsage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    provider: { id: 'p', model: 'm' },
    nextMessages: sent,
    hasToolCalls: false,
  };
}

/** One iteration through `budget-check`, at `iteration`, with the model at `iteration + 1` calls. */
async function check(
  ctx: TurnContext,
  iteration: number,
  content: string,
  sent: readonly ModelMessage[] = [USER],
  dryRun = false,
): Promise<AgentTurnIterationOutput> {
  ctx.usage.steps = iteration + 1;
  return (await buildBudgetCheckHandler(ctx)(
    answer(content, sent),
    bodyStep(iteration, dryRun),
  )) as AgentTurnIterationOutput;
}

/** The loop's output ending on `last`, after `iterations`. */
const loopOutput = (last: AgentTurnIterationOutput, iterations: number) => ({
  finalOutput: last,
  iterations,
  stopReason: 'exit-condition',
});

async function failureOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (cause) {
    return parseFailureMessage((cause as Error).message) as unknown as Record<string, unknown>;
  }
  throw new Error('expected the handler to fail');
}

const outcomesOf = (seen: Seen) =>
  seen.recorded.map((r) => ({
    nodeId: r.nodeId,
    checks: r.checks.map((c) => `${c.guardrailId}:${c.outcome}`),
  }));

describe('the note that sends an answer back', () => {
  test('names the guardrails as a JSON array after the marker, with each reason, and is counted', () => {
    const note = retryNote([
      {
        guardrailId: 'acme.no, comma' as GuardrailId,
        result: { passed: false, reason: 'the answer says "secret"' },
      },
      { guardrailId: 'acme.quiet' as GuardrailId, result: { passed: false } },
    ] as never);
    expect(note.role).toBe('user');
    expect(String(note.content).split('\n')).toEqual([
      '[kindgi:guardrail-retry] ["acme.no, comma","acme.quiet"]',
      "Your answer wasn't sent: it didn't pass these guardrails.",
      '- acme.no, comma: the answer says "secret"',
      "- acme.quiet: the answer didn't pass it",
      'Write a new answer that meets them.',
    ]);
    const sent = [USER, { role: 'assistant', content: 'x' } as ModelMessage, note, note];
    expect(retryNotes(sent)).toEqual([
      ['acme.no, comma', 'acme.quiet'],
      ['acme.no, comma', 'acme.quiet'],
    ]);
    expect(sentBackSoFar(retryNotes(sent)).get('acme.quiet')).toBe(2);
  });

  test("a long reason is cut; a user's own message starting otherwise isn't a note", () => {
    const note = retryNote([
      { guardrailId: 'acme.g' as GuardrailId, result: { passed: false, reason: 'x'.repeat(900) } },
    ] as never);
    expect(String(note.content).split('\n')[2]).toBe(`- acme.g: ${'x'.repeat(500)}…`);
    expect(retryNotes([{ role: 'user', content: 'please [kindgi:guardrail-retry]' }])).toEqual([]);
    expect(DEFAULT_GUARDRAIL_ATTEMPTS).toBe(2);
  });
});

describe('budget-check with a retry guardrail', () => {
  test('a failed answer goes back with a note; the next one, passing, finishes the turn', async () => {
    const { ctx, seen } = turn([RETRY('acme.discreet', 'acme.no-secret', 3)]);
    const first = await check(ctx, 0, 'The secret is 42.');
    expect(first.finishedTurn).toBe(false);
    expect(first.nextMessages.slice(0, 2)).toEqual([
      USER,
      { role: 'assistant', content: 'The secret is 42.' },
    ]);
    expect(retryNotes(first.nextMessages)).toEqual([['acme.discreet']]);
    expect(String(first.nextMessages.at(-1)?.content)).toContain(
      '- acme.discreet: the answer says "secret"',
    );
    expect(ctx.answerJudgedInLoop).toBeUndefined();
    expect(seen.events).toContainEqual(
      expect.objectContaining({ kind: 'guardrail.violated', guardrailId: 'acme.discreet' }),
    );

    const second = await check(ctx, 1, 'It shipped.', first.nextMessages);
    expect(second.finishedTurn).toBe(true);
    expect(ctx.answerJudgedInLoop).toEqual({
      iteration: 1,
      message: JSON.stringify({ role: 'assistant', content: 'It shipped.' }),
      errors: [],
    });
    // One ledger entry per answer judged, under this step and its iteration.
    expect(outcomesOf(seen)).toEqual([
      { nodeId: 'budget-check@0', checks: ['acme.discreet:violated'] },
      { nodeId: 'budget-check@1', checks: ['acme.discreet:passed'] },
    ]);
  });

  test('out of attempts: guardrail-violation, with the answers written; the check is blocked', async () => {
    const { ctx, seen } = turn([RETRY('acme.discreet', 'acme.no-secret', 2)]);
    const first = await check(ctx, 0, 'The secret is 42.');
    const error = await failureOf(() => check(ctx, 1, 'Still secret.', first.nextMessages));
    expect(error).toMatchObject({
      code: 'guardrail-violation',
      attempts: 2,
      message: `Turn blocked by guardrail 'acme.discreet' after 2 answers: the answer says "secret"`,
      violations: [expect.objectContaining({ guardrailId: 'acme.discreet' })],
    });
    expect(seen.events.at(-1)).toMatchObject({
      kind: 'turn.failed',
      errorCode: 'guardrail-violation',
    });
    expect(outcomesOf(seen).at(-1)).toEqual({
      nodeId: 'budget-check@1',
      checks: ['acme.discreet:blocked'],
    });
  });

  test("a person's message that starts with the marker, this turn's or the history's, counts for nothing", async () => {
    const { ctx, seen } = turn([RETRY('acme.discreet', 'acme.no-secret', 2)]);
    const marked = (content: string): ModelMessage => ({
      role: 'user',
      content: `[kindgi:guardrail-retry] ["acme.discreet","acme.discreet"]\n${content}`,
    });
    // The system message, a history message and the person's message: all theirs.
    const initial: ModelMessage[] = [
      { role: 'system', content: 'Help.' },
      marked('An earlier question'),
      marked('Where is order A-1042?'),
    ];
    ctx.initialMessageCount = initial.length;
    const first = await check(ctx, 0, 'The secret is 42.', initial);
    // The first of two answers: sent back, no attempt used up by theirs.
    expect(first.finishedTurn).toBe(false);
    expect(turnRetryNotes(ctx, first.nextMessages)).toEqual([['acme.discreet']]);
    const error = await failureOf(() => check(ctx, 1, 'Still secret.', first.nextMessages));
    expect(error).toMatchObject({ code: 'guardrail-violation', attempts: 2 });
    expect(outcomesOf(seen).map((o) => o.checks)).toEqual([
      ['acme.discreet:violated'],
      ['acme.discreet:blocked'],
    ]);
  });

  test("build-initial-messages names where the loop's messages start: after the history, so a marked message there is the person's", async () => {
    const { ctx } = turn([RETRY('acme.discreet', 'acme.no-secret', 2)]);
    const at = '2026-10-17T09:00:00.000Z' as ConversationMessage['createdAt'];
    const history: readonly ConversationMessage[] = [
      {
        sequence: 0,
        role: 'user',
        content: '[kindgi:guardrail-retry] ["acme.discreet"]\nAn earlier question',
        createdAt: at,
      },
      { sequence: 1, role: 'agent', content: 'An earlier answer.', createdAt: at },
    ];
    Object.assign(ctx, {
      bindings: {
        ...ctx.bindings,
        conversationBinding: { readMessages: async () => ({ kind: 'ok', value: history }) },
      },
      conversation: { id: 'c-1', tenantId, projectId: 'p-1' },
      retrieved: [],
      renderedPrompt: 'Help.',
      userMessage: { sequence: 2, role: 'user', content: 'Where is order A-1042?' },
      tools: { definitions: [], byName: new Map() },
      initialMessageCount: undefined,
    });
    const initial = (await buildBuildInitialMessagesHandler(ctx)(undefined, bodyStep(0))) as {
      readonly nextMessages: readonly ModelMessage[];
    };
    // The system message, the history's two, and the person's message.
    expect(initial.nextMessages).toHaveLength(4);
    expect(ctx.initialMessageCount).toBe(4);
    const first = await check(ctx, 0, 'The secret is 42.', initial.nextMessages);
    expect(first.finishedTurn).toBe(false);
    expect(turnRetryNotes(ctx, first.nextMessages)).toEqual([['acme.discreet']]);
  });

  test('no retry block: two answers, so one is sent back', async () => {
    const { ctx } = turn([RETRY('acme.discreet', 'acme.no-secret')]);
    const first = await check(ctx, 0, 'The secret is 42.');
    expect(first.finishedTurn).toBe(false);
    const error = await failureOf(() => check(ctx, 1, 'Still secret.', first.nextMessages));
    expect(error).toMatchObject({ code: 'guardrail-violation', attempts: 2 });
  });

  test('maxAttempts 1: no answer is sent back', async () => {
    const { ctx } = turn([RETRY('acme.discreet', 'acme.no-secret', 1)]);
    const error = await failureOf(() => check(ctx, 0, 'The secret is 42.'));
    expect(error).toMatchObject({ code: 'guardrail-violation', attempts: 1 });
  });

  test('halt comes first: a halt and a retry guardrail fail the answer, and the turn fails at once', async () => {
    const { ctx, seen } = turn([
      RETRY('acme.discreet', 'acme.no-secret', 3),
      HALT('acme.polite', 'acme.no-rude'),
    ]);
    const error = await failureOf(() => check(ctx, 0, 'The secret is 42, rude one.'));
    expect(error).toMatchObject({
      code: 'guardrail-violation',
      message: `Turn blocked by guardrail 'acme.polite': the answer says "rude"`,
      violations: [expect.objectContaining({ guardrailId: 'acme.polite' })],
    });
    expect(error).not.toHaveProperty('attempts');
    expect(outcomesOf(seen)).toEqual([
      { nodeId: 'budget-check@0', checks: ['acme.discreet:violated', 'acme.polite:blocked'] },
    ]);
  });

  test("a turn it fails has the failing answer's checks in provenance, as a turn failed after the loop has", async () => {
    const ids = (seen: Seen) => seen.nodes.map((n) => n.id);
    // The same halt in a turn without a retry guardrail: the outer gate adds its node.
    const outer = turn([HALT('acme.polite', 'acme.no-rude')]);
    const last = await check(outer.ctx, 0, 'You rude one.');
    await failureOf(() =>
      buildEvaluateGuardrailsHandler(outer.ctx)(loopOutput(last, 1), outerStep()),
    );
    expect(ids(outer.seen)).toEqual(['model-output:1', 'guardrail-check:acme.polite']);
    // With a retry guardrail, budget-check fails the turn on it, and adds the same nodes.
    const halted = turn([
      RETRY('acme.discreet', 'acme.no-secret', 3),
      HALT('acme.polite', 'acme.no-rude'),
    ]);
    await failureOf(() => check(halted.ctx, 0, 'You rude one.'));
    expect(ids(halted.seen)).toEqual(ids(outer.seen));
    // A halt check that can't run: its node says so.
    const errored = turn([
      RETRY('acme.discreet', 'acme.no-secret', 3),
      HALT('acme.polite', 'acme.not-registered'),
    ]);
    await failureOf(() => check(errored.ctx, 0, 'It shipped.'));
    expect(errored.seen.nodes).toEqual([
      expect.objectContaining({ id: 'model-output:1' }),
      expect.objectContaining({
        id: 'guardrail-check:acme.polite',
        attributes: expect.objectContaining({ evaluated: false }),
      }),
    ]);
    // Out of attempts: the failed check, and the answer it sent back before.
    const retried = turn([RETRY('acme.discreet', 'acme.no-secret', 2)]);
    const first = await check(retried.ctx, 0, 'The secret is 42.');
    expect(ids(retried.seen)).toEqual([]);
    await failureOf(() => check(retried.ctx, 1, 'Still secret.', first.nextMessages));
    expect(ids(retried.seen)).toEqual([
      'model-output:2',
      'guardrail-check:acme.discreet',
      'guardrail-check:acme.discreet:sent-back:1',
    ]);
  });

  test("attempts are each guardrail's: one that fixes the first and breaks the second sends it back again", async () => {
    const { ctx } = turn([
      RETRY('acme.discreet', 'acme.no-secret', 2),
      RETRY('acme.specific', 'acme.no-vague', 2),
    ]);
    const first = await check(ctx, 0, 'The secret is 42.');
    const second = await check(ctx, 1, 'Something vague.', first.nextMessages);
    expect(second.finishedTurn).toBe(false);
    expect(retryNotes(second.nextMessages)).toEqual([['acme.discreet'], ['acme.specific']]);
    const third = await check(ctx, 2, 'Order A-1042 shipped on Tuesday.', second.nextMessages);
    expect(third.finishedTurn).toBe(true);
  });

  test('no steps left: guardrail-violation with the answers written, not budget-exceeded', async () => {
    const { ctx } = turn([RETRY('acme.discreet', 'acme.no-secret', 5)], { maxSteps: 2 });
    const first = await check(ctx, 0, 'The secret is 42.');
    expect(first.finishedTurn).toBe(false);
    const error = await failureOf(() => check(ctx, 1, 'Still secret.', first.nextMessages));
    expect(error).toMatchObject({ code: 'guardrail-violation', attempts: 2 });
  });

  test("the loop's last iteration: guardrail-violation, never an answer sent back for an iteration it hasn't", async () => {
    const last = AGENT_TURN_LOOP_MAX_ITERATIONS - 1;
    const { ctx } = turn([RETRY('acme.discreet', 'acme.no-secret', 5)], { maxSteps: 50 });
    const error = await failureOf(() => check(ctx, last, 'The secret is 42.'));
    expect(error).toMatchObject({ code: 'guardrail-violation', attempts: 1 });
    // One iteration earlier, it's sent back.
    const { ctx: earlier } = turn([RETRY('acme.discreet', 'acme.no-secret', 5)], { maxSteps: 50 });
    expect((await check(earlier, last - 1, 'The secret is 42.')).finishedTurn).toBe(false);
  });

  test("output repair first: an answer that isn't the typed output is repaired, never judged", async () => {
    const { ctx, seen } = turn([RETRY('acme.discreet', 'acme.no-secret', 3)], {
      output: {
        name: 'order',
        schema: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
      },
    });
    const out = await check(ctx, 0, 'secret, and not JSON');
    expect(out.finishedTurn).toBe(false);
    expect(retryNotes(out.nextMessages)).toEqual([]);
    expect(seen.calls.get('acme.no-secret')).toBeUndefined();
  });

  test("a retry guardrail whose check can't run doesn't send the answer back: errored, and the turn goes on", async () => {
    const { ctx, seen } = turn([RETRY('acme.discreet', 'acme.not-registered', 3)]);
    const out = await check(ctx, 0, 'The secret is 42.');
    expect(out.finishedTurn).toBe(true);
    expect(outcomesOf(seen)).toEqual([
      { nodeId: 'budget-check@0', checks: ['acme.discreet:errored'] },
    ]);
    expect(seen.events).toContainEqual(
      expect.objectContaining({ kind: 'guardrail.error', guardrailId: 'acme.discreet' }),
    );
  });

  test('a dry run, or a turn without a retry guardrail: budget-check judges nothing', async () => {
    const dry = turn([RETRY('acme.discreet', 'acme.no-secret', 3)]);
    expect((await check(dry.ctx, 0, 'secret', [USER], true)).finishedTurn).toBe(true);
    expect(dry.ctx.answerJudgedInLoop).toBeUndefined();
    const haltOnly = turn([HALT('acme.polite', 'acme.no-rude')]);
    expect((await check(haltOnly.ctx, 0, 'rude')).finishedTurn).toBe(true);
    expect(haltOnly.ctx.answerJudgedInLoop).toBeUndefined();
    expect([...dry.seen.calls, ...haltOnly.seen.calls]).toEqual([]);
    expect([...dry.seen.recorded, ...haltOnly.seen.recorded]).toEqual([]);
  });

  test('every output it gives fits the loop output schema of agent.turn 1.1.0, so an older runtime replays it', async () => {
    expect(AGENT_TURN_FLOW_VERSION).toBe('1.1.0');
    const loop = AGENT_TURN_FLOW.nodes.find((n) => n.id === 'agent-loop') as unknown as {
      readonly outputSchema: { readonly properties: Record<string, unknown> };
    };
    const allowed = Object.keys(loop.outputSchema.properties);
    const { ctx } = turn([RETRY('acme.discreet', 'acme.no-secret', 3)]);
    const sentBack = await check(ctx, 0, 'The secret is 42.');
    const finished = await check(ctx, 1, 'It shipped.', sentBack.nextMessages);
    // As the kernel checks each iteration's output, replays included: as journaled, against the schema.
    const validate = compileJsonSchema(loop.outputSchema, { dialects: ['2020-12'] });
    for (const out of [sentBack, finished]) {
      expect(Object.keys(out).filter((k) => !allowed.includes(k))).toEqual([]);
      const journaled: unknown = JSON.parse(JSON.stringify(out));
      expect(validate(journaled), JSON.stringify(validate.errors)).toBe(true);
    }
    // The note is a plain user message: an older runtime sends it to the model as one.
    expect(sentBack.nextMessages.at(-1)).toEqual({
      role: 'user',
      content: expect.any(String),
    });
  });
});

describe('evaluate-guardrails after the loop judged the answer', () => {
  const guardrails = () => [
    RETRY('acme.discreet', 'acme.no-secret', 3),
    HALT('acme.polite', 'acme.no-rude'),
    LOG('acme.brief', 'acme.no-long'),
  ];

  test("judges the loop's answer on the other guardrails only, once per answer in all", async () => {
    const { ctx, seen } = turn(guardrails());
    const first = await check(ctx, 0, 'The secret is long.');
    const last = await check(ctx, 1, 'It shipped, in a long way.', first.nextMessages);
    await buildEvaluateGuardrailsHandler(ctx)(loopOutput(last, 2), outerStep());
    expect(Object.fromEntries(seen.calls)).toEqual({
      'acme.no-secret': 2,
      'acme.no-rude': 2,
      'acme.no-long': 1,
    });
    expect(outcomesOf(seen)).toEqual([
      { nodeId: 'budget-check@0', checks: ['acme.discreet:violated', 'acme.polite:passed'] },
      { nodeId: 'budget-check@1', checks: ['acme.discreet:passed', 'acme.polite:passed'] },
      { nodeId: 'evaluate-guardrails', checks: ['acme.brief:violated'] },
    ]);
    expect(ctx.nonBlockingViolations?.map((v) => v.guardrailId)).toEqual(['acme.brief']);
    // The guardrail that sent the first answer back shaped the last one.
    expect(seen.nodes.map((n) => n.id)).toContain('guardrail-check:acme.discreet:sent-back:1');
  });

  test("a final output that isn't the answer the loop judged is judged on every guardrail", async () => {
    const { ctx, seen } = turn(guardrails());
    const last = await check(ctx, 0, 'It shipped.');
    const other = { ...last, message: { role: 'assistant' as const, content: 'Something else.' } };
    await buildEvaluateGuardrailsHandler(ctx)(loopOutput(other, 1), outerStep());
    expect(outcomesOf(seen).at(-1)).toEqual({
      nodeId: 'evaluate-guardrails',
      checks: ['acme.discreet:passed', 'acme.polite:passed', 'acme.brief:passed'],
    });
    // Nor at another iteration, or when the loop ran out of iterations.
    for (const loop of [
      loopOutput(last, 2),
      { ...loopOutput(last, 1), stopReason: 'max-iterations' },
    ]) {
      seen.recorded.length = 0;
      await buildEvaluateGuardrailsHandler(ctx)(loop, outerStep());
      expect(outcomesOf(seen)).toEqual([
        {
          nodeId: 'evaluate-guardrails',
          checks: ['acme.discreet:passed', 'acme.polite:passed', 'acme.brief:passed'],
        },
      ]);
    }
  });

  test('resumed in another process (no flag): every guardrail; a retry failure is out of attempts', async () => {
    const { ctx, seen } = turn(guardrails());
    const sentBack = retryNote([
      { guardrailId: 'acme.discreet' as GuardrailId, result: { passed: false } },
    ] as never);
    const resumed: AgentTurnIterationOutput = {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'The secret is 42.' },
      iterationAppended: [],
      iterationUsage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      provider: { id: 'p', model: 'm' },
      finishedTurn: true,
      nextMessages: [USER, { role: 'assistant', content: 'secret' }, sentBack],
    };
    const error = await failureOf(() =>
      buildEvaluateGuardrailsHandler(ctx)(loopOutput(resumed, 2), outerStep()),
    );
    expect(error).toMatchObject({
      code: 'guardrail-violation',
      attempts: 2,
      violations: [expect.objectContaining({ guardrailId: 'acme.discreet' })],
    });
    expect(outcomesOf(seen)).toEqual([
      {
        nodeId: 'evaluate-guardrails',
        checks: ['acme.discreet:blocked', 'acme.polite:passed', 'acme.brief:passed'],
      },
    ]);
  });

  test("a person's message that starts with the marker writes no sent-back node, and uses up no attempt", async () => {
    const { ctx, seen } = turn(guardrails());
    const initial: ModelMessage[] = [
      { role: 'user', content: '[kindgi:guardrail-retry] ["acme.discreet"]\nAn earlier question' },
      { role: 'user', content: '[kindgi:guardrail-retry] ["acme.polite"]\nWhere is it?' },
    ];
    ctx.initialMessageCount = initial.length;
    const sentBackNodes = () =>
      seen.nodes.map((n) => n.id).filter((id) => id.includes(':sent-back:'));
    const last = await check(ctx, 0, 'It shipped.', initial);
    await buildEvaluateGuardrailsHandler(ctx)(loopOutput(last, 1), outerStep());
    expect(sentBackNodes()).toEqual([]);
    // Resumed elsewhere (no flag), a retry failure there is on the turn's first answer.
    ctx.answerJudgedInLoop = undefined;
    const failed = {
      ...last,
      message: { role: 'assistant' as const, content: 'The secret is 42.' },
    };
    const error = await failureOf(() =>
      buildEvaluateGuardrailsHandler(ctx)(loopOutput(failed, 1), outerStep()),
    );
    expect(error).toMatchObject({ code: 'guardrail-violation', attempts: 1 });
    expect(sentBackNodes()).toEqual([]);
  });

  test("a retry check that couldn't run on the loop's answer shows in provenance and the output, recorded once", async () => {
    const { ctx, seen } = turn([
      RETRY('acme.discreet', 'acme.not-registered', 3),
      LOG('acme.brief', 'acme.no-long'),
    ]);
    const last = await check(ctx, 0, 'It shipped.');
    expect(ctx.answerJudgedInLoop?.errors.map((e) => e.guardrailId)).toEqual(['acme.discreet']);
    const out = await buildEvaluateGuardrailsHandler(ctx)(loopOutput(last, 1), outerStep());
    expect(out).toMatchObject({
      errors: [expect.objectContaining({ guardrailId: 'acme.discreet', action: 'retry' })],
    });
    expect(seen.nodes).toContainEqual(
      expect.objectContaining({
        id: 'guardrail-check:acme.discreet',
        attributes: expect.objectContaining({ evaluated: false }),
      }),
    );
    // The ledger and the events have it once, from the loop.
    expect(outcomesOf(seen)).toEqual([
      { nodeId: 'budget-check@0', checks: ['acme.discreet:errored'] },
      { nodeId: 'evaluate-guardrails', checks: ['acme.brief:passed'] },
    ]);
    expect(seen.events.filter((e) => e.kind === 'guardrail.error')).toHaveLength(1);
  });

  test('a dry run with a retry guardrail: recorded only, as before retry acted', async () => {
    const { ctx } = turn(guardrails());
    const last = await check(ctx, 0, 'The secret is 42.', [USER], true);
    const out = await buildEvaluateGuardrailsHandler(ctx)(loopOutput(last, 1), outerStep(true));
    expect(out).toMatchObject({ blocking: 0, other: 1 });
    expect(ctx.nonBlockingViolations?.map((v) => v.guardrailId)).toEqual(['acme.discreet']);
  });

  test('a halt-only turn: judged once, after the loop, as before', async () => {
    const { ctx, seen } = turn([HALT('acme.polite', 'acme.no-rude')]);
    const last = await check(ctx, 0, 'You rude one.');
    const error = await failureOf(() =>
      buildEvaluateGuardrailsHandler(ctx)(loopOutput(last, 1), outerStep()),
    );
    expect(error).toMatchObject({ code: 'guardrail-violation' });
    expect(error).not.toHaveProperty('attempts');
    expect(outcomesOf(seen)).toEqual([
      { nodeId: 'evaluate-guardrails', checks: ['acme.polite:blocked'] },
    ]);
    expect(seen.calls.get('acme.no-rude')).toBe(1);
  });
});

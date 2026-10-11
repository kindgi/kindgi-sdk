// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The guardrail gate records what each guardrail's check came to
 * (`bindings.guardrailOutcomes`): passes, violations, blocks and errors,
 * a blocked turn before it fails, with no content. A replay or a dry run
 * records nothing, and outcomes that couldn't be recorded fail the step.
 */

import { describe, expect, test } from 'vitest';

import type { CheckRegistry, Guardrail, GuardrailOutcomeRecord } from '@kindgi/guardrails';
import { createCheckRegistry } from '@kindgi/guardrails';
import type { NodeContext } from '@kindgi/handler';
import type { GuardrailId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildEvaluateGuardrailsHandler } from '../src/handlers/evaluate-guardrails.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { ConversationId } from '../src/types.js';

const tenantId = 'acme' as TenantId;

const guardrail = (id: string, check: string, action: string, extra = {}): Guardrail =>
  ({
    id: id as GuardrailId,
    kind: 'zero-llm',
    check,
    action: { 'on-violation': action },
    ...extra,
  }) as Guardrail;

const PASSES = guardrail('acme.polite', 'acme.passes', 'halt', { severity: 'warn' });
const LOGS = guardrail('acme.tone', 'acme.fails', 'log-only');
const ESCALATES = guardrail('acme.refund-limit', 'acme.fails', 'escalate', {
  severity: 'critical',
});
const HALTS = guardrail('acme.no-pii', 'acme.fails', 'halt');
const CANT_RUN = guardrail('acme.cite-or-halt', 'acme.not-registered', 'halt');
const CI_ONLY = guardrail('acme.ci-gate', 'acme.fails', 'halt', { scope: { when: 'ci-only' } });

function checks(): CheckRegistry {
  const registry = createCheckRegistry();
  registry.register({
    id: 'acme.passes',
    kind: 'zero-llm',
    evaluate: async () => ({ passed: true }),
  });
  registry.register({
    id: 'acme.fails',
    kind: 'zero-llm',
    evaluate: async () => ({ passed: false, reason: 'the answer says A-1042 belongs to Dana' }),
  });
  return registry;
}

function turn(
  guardrails: readonly Guardrail[],
  options: {
    readonly sink?: (record: GuardrailOutcomeRecord) => Promise<void>;
    readonly replay?: boolean;
  } = {},
): { ctx: TurnContext; recorded: GuardrailOutcomeRecord[]; order: string[] } {
  const agent = defineAgent({
    id: 'acme.helper',
    version: '1.4.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [] }],
    tools: [],
    retrieval: [],
    guardrails: guardrails.map((g) => g.id),
  });
  if (agent.kind === 'err') throw new Error('agent spec invalid');
  const recorded: GuardrailOutcomeRecord[] = [];
  const order: string[] = [];
  const ctx = {
    input: {
      tenantId,
      projectId: 'p-1' as never,
      agent: agent.value,
      conversationId: 'c-1' as ConversationId,
      userMessage: 'Where is order A-1042?',
      ...(options.replay === true && { replay: { of: 'r-0', evalRunId: 'er-1' } }),
    },
    bindings: {
      checks: checks(),
      onEvent: (e: { kind: string }) => void order.push(e.kind),
      guardrailOutcomes: {
        record: async (record: GuardrailOutcomeRecord) => {
          order.push('recorded');
          if (options.sink !== undefined) return options.sink(record);
          recorded.push(record);
        },
      },
    } as unknown as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0 },
    abortReason: undefined,
    guardrails,
  } as unknown as TurnContext;
  return { ctx, recorded, order };
}

const loopOutput = {
  finalOutput: {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'Order A-1042 has shipped.' },
    iterationAppended: [],
    iterationUsage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
    provider: { id: 'echo', model: 'echo-1' },
    finishedTurn: true,
    nextMessages: [],
  },
  iterations: 1,
  stopReason: 'exit-condition',
};

const step = (dryRun = false) =>
  ({ runId: 'run-7', nodeId: 'evaluate-guardrails', dryRun }) as unknown as NodeContext;

const run = (ctx: TurnContext, kctx = step()) =>
  buildEvaluateGuardrailsHandler(ctx)(loopOutput, kctx).catch((e: unknown) => e);

describe('the gate records every check it ran', () => {
  test('passes and violations, with the turn they were on', async () => {
    const { ctx, recorded } = turn([PASSES, LOGS, ESCALATES, CI_ONLY]);
    const out = await run(ctx);
    expect(out).not.toBeInstanceOf(AgentTurnFailure);
    expect(recorded).toEqual([
      {
        tenantId,
        projectId: 'p-1',
        runId: 'run-7',
        nodeId: 'evaluate-guardrails',
        agentId: 'acme.helper',
        agentVersion: '1.4.0',
        at: expect.any(String),
        checks: [
          // A pass took no action.
          { guardrailId: 'acme.polite', outcome: 'passed', severity: 'warn' },
          { guardrailId: 'acme.tone', outcome: 'violated', action: 'log-only', severity: 'error' },
          {
            guardrailId: 'acme.refund-limit',
            outcome: 'violated',
            action: 'escalate',
            severity: 'critical',
          },
          // `acme.ci-gate` is ci-only: not checked on a runtime turn, so no outcome.
        ],
      },
    ]);
  });

  test('no content: no check reason, no answer', async () => {
    const { ctx, recorded } = turn([LOGS, HALTS]);
    await run(ctx);
    const text = JSON.stringify(recorded);
    expect(text).not.toContain('Dana');
    expect(text).not.toContain('shipped');
  });

  test('a blocked turn is recorded before it fails', async () => {
    const { ctx, recorded, order } = turn([PASSES, HALTS]);
    const thrown = await run(ctx);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload.code).toBe('guardrail-violation');
    expect(recorded[0]?.checks).toEqual([
      expect.objectContaining({ guardrailId: 'acme.polite', outcome: 'passed' }),
      { guardrailId: 'acme.no-pii', outcome: 'blocked', action: 'halt', severity: 'error' },
    ]);
    // Recorded before the gate acted: before its events and its failure.
    expect(order[0]).toBe('recorded');
    expect(order).toContain('turn.failed');
  });

  test("a check that couldn't run is errored, with its code and not its message", async () => {
    const { ctx, recorded } = turn([CANT_RUN, PASSES]);
    const thrown = await run(ctx);
    // A halt guardrail's error fails the turn (it fails closed), and stays `errored`.
    expect((thrown as AgentTurnFailure).payload.code).toBe('guardrail-violation');
    expect(recorded[0]?.checks).toEqual([
      {
        guardrailId: 'acme.cite-or-halt',
        outcome: 'errored',
        action: 'halt',
        severity: 'error',
        errorCode: 'unknown-check',
      },
      expect.objectContaining({ guardrailId: 'acme.polite', outcome: 'passed' }),
    ]);
  });

  test('nothing to record when no guardrail was checked', async () => {
    const { ctx, order } = turn([CI_ONLY]);
    await run(ctx);
    expect(order).not.toContain('recorded');
  });
});

describe("what isn't recorded", () => {
  test('a replay', async () => {
    const { ctx, order } = turn([PASSES, HALTS], { replay: true });
    const thrown = await run(ctx);
    expect((thrown as AgentTurnFailure).payload.code).toBe('guardrail-violation');
    expect(order).not.toContain('recorded');
  });

  test('a dry run', async () => {
    const { ctx, order } = turn([PASSES, LOGS]);
    await run(ctx, step(true));
    expect(order).not.toContain('recorded');
  });
});

describe('outcomes that couldn’t be recorded fail the step', () => {
  test('a passing turn fails with persistence-error, saying why', async () => {
    const { ctx } = turn([PASSES], {
      sink: async () => {
        throw new Error('connection reset');
      },
    });
    const thrown = await run(ctx);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'persistence-error',
      message: "The guardrail outcomes couldn't be recorded: connection reset",
    });
  });

  test('a blocked turn fails with persistence-error too, before its violation', async () => {
    const { ctx, order } = turn([HALTS], {
      sink: async () => {
        throw new Error('connection reset');
      },
    });
    const thrown = await run(ctx);
    expect((thrown as AgentTurnFailure).payload.code).toBe('persistence-error');
    expect(order).toEqual(['recorded']);
  });
});

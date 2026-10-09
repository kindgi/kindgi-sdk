// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A guardrail whose check can't run (no such check, no check registry at all) is never a pass: a
 * `halt` guardrail's error fails the turn (it fails closed), and every error, whatever the action,
 * is a `guardrail.error` event, a provenance node and an entry in the step's output.
 */

import { describe, expect, test } from 'vitest';

import type { CheckRegistry, EvaluationOutcome, Guardrail } from '@kindgi/guardrails';
import { createCheckRegistry } from '@kindgi/guardrails';
import type { NodeContext } from '@kindgi/handler';
import type { GuardrailId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import { categorizeOutcomes, describeBlockingViolations } from '../src/guardrails-gate.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildEvaluateGuardrailsHandler } from '../src/handlers/evaluate-guardrails.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { TurnEvent } from '../src/streaming.js';
import type { ConversationId } from '../src/types.js';

const tenantId = 'acme' as TenantId;

/** A guardrail naming `check`, with `action`. */
const guardrail = (id: string, check: string, action: string): Guardrail =>
  ({
    id: id as GuardrailId,
    kind: 'zero-llm',
    check,
    action: { 'on-violation': action },
  }) as Guardrail;

// A check nothing registered (a built-in such as `must-cite` is in every `createCheckRegistry()`).
const CITE_OR_HALT = guardrail('acme.cite-or-halt', 'acme.cites-sources', 'halt');

interface Seen {
  readonly events: TurnEvent[];
  readonly nodes: { id: string; kind: string; attributes?: Record<string, unknown> }[];
}

function turn(
  guardrails: readonly Guardrail[],
  checks: CheckRegistry | undefined,
): {
  ctx: TurnContext;
  seen: Seen;
} {
  const agent = defineAgent({
    id: 'acme.helper',
    version: '1.0.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [] }],
    tools: [],
    retrieval: [],
    guardrails: guardrails.map((g) => g.id),
  });
  if (agent.kind === 'err') throw new Error('agent spec invalid');
  const seen: Seen = { events: [], nodes: [] };
  const ctx = {
    input: {
      tenantId,
      projectId: 'p-1' as never,
      agent: agent.value,
      conversationId: 'c-1' as ConversationId,
      userMessage: 'Where is order A-1042?',
    },
    bindings: {
      ...(checks !== undefined && { checks }),
      onEvent: (e: TurnEvent) => void seen.events.push(e),
    } as unknown as InvokeAgentBindings,
    provenance: {
      addNode: (n: { id: string; kind: string; attributes?: Record<string, unknown> }) =>
        void seen.nodes.push(n),
      addEdge: () => undefined,
    },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0 },
    abortReason: undefined,
    guardrails,
  } as unknown as TurnContext;
  return { ctx, seen };
}

/** The agent loop's output: an answer with no citation in it. */
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

const run = (ctx: TurnContext) =>
  buildEvaluateGuardrailsHandler(ctx)(loopOutput, {} as NodeContext).catch((e: unknown) => e);

const alwaysFails = (): CheckRegistry => {
  const checks = createCheckRegistry();
  checks.register({
    id: 'acme.always-fails',
    kind: 'zero-llm',
    evaluate: async () => ({ passed: false, reason: 'control: always fails' }),
  });
  return checks;
};

describe('a halt guardrail whose check can’t run fails the turn (fails closed)', () => {
  test('an unknown check: guardrail-violation, no violations, the evaluation error says why', async () => {
    const { ctx, seen } = turn([CITE_OR_HALT], createCheckRegistry());
    const thrown = await run(ctx);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    const payload = (thrown as AgentTurnFailure).payload;
    expect(payload).toMatchObject({
      code: 'guardrail-violation',
      violations: [],
      evaluationErrors: [
        expect.objectContaining({
          guardrailId: 'acme.cite-or-halt',
          code: 'unknown-check',
          action: 'halt',
        }),
      ],
    });
    expect(payload.message).toMatch(
      /^Turn blocked: guardrail 'acme\.cite-or-halt' couldn't run its check \(unknown-check: /,
    );
    expect(seen.events).toEqual([
      expect.objectContaining({
        kind: 'guardrail.error',
        guardrailId: 'acme.cite-or-halt',
        action: 'halt',
        code: 'unknown-check',
      }),
      expect.objectContaining({ kind: 'turn.failed', errorCode: 'guardrail-violation' }),
    ]);
    expect(seen.nodes).toContainEqual(
      expect.objectContaining({
        id: 'guardrail-check:acme.cite-or-halt',
        kind: 'guardrail-check',
        attributes: expect.objectContaining({
          evaluated: false,
          error: 'unknown-check',
          action: 'halt',
        }),
      }),
    );
  });

  test('no check registry bound at all: the same, never skipped', async () => {
    const { ctx, seen } = turn([CITE_OR_HALT], undefined);
    const thrown = await run(ctx);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload).toMatchObject({
      code: 'guardrail-violation',
      violations: [],
      evaluationErrors: [
        expect.objectContaining({
          guardrailId: 'acme.cite-or-halt',
          code: 'unknown-check',
          message: expect.stringContaining('no check registry is bound'),
        }),
      ],
    });
    expect(seen.events.map((e) => e.kind)).toEqual(['guardrail.error', 'turn.failed']);
  });

  test('a halt violation and a halt guardrail that couldn’t run: both named', async () => {
    const { ctx } = turn(
      [guardrail('acme.always-fails', 'acme.always-fails', 'halt'), CITE_OR_HALT],
      alwaysFails(),
    );
    const payload = ((await run(ctx)) as AgentTurnFailure).payload;
    expect(payload).toMatchObject({
      code: 'guardrail-violation',
      violations: [expect.objectContaining({ guardrailId: 'acme.always-fails' })],
      evaluationErrors: [expect.objectContaining({ guardrailId: 'acme.cite-or-halt' })],
    });
    expect(payload.message).toMatch(
      /^Turn blocked by 2 guardrails: 'acme\.always-fails' \(control: always fails\); 'acme\.cite-or-halt' couldn't run its check \(unknown-check: /,
    );
  });
});

describe('any other action: the turn goes on, and the error shows', () => {
  test('log-only: no failure; the event, the provenance node and the step’s output say so', async () => {
    const { ctx, seen } = turn(
      [guardrail('acme.cite-or-log', 'acme.cites-sources', 'log-only')],
      createCheckRegistry(),
    );
    const out = await run(ctx);
    expect(out).toEqual({
      blocking: 0,
      warnings: 0,
      other: 0,
      errors: [
        {
          guardrailId: 'acme.cite-or-log',
          action: 'log-only',
          code: 'unknown-check',
          message: expect.any(String),
        },
      ],
    });
    expect(seen.events).toEqual([
      expect.objectContaining({ kind: 'guardrail.error', action: 'log-only' }),
    ]);
    expect(seen.nodes.map((n) => n.id)).toContain('guardrail-check:acme.cite-or-log');
  });

  test('a check that ran and passed is no error', async () => {
    const checks = createCheckRegistry();
    checks.register({ id: 'acme.ok', kind: 'zero-llm', evaluate: async () => ({ passed: true }) });
    const { ctx, seen } = turn([guardrail('acme.ok', 'acme.ok', 'halt')], checks);
    expect(await run(ctx)).toEqual({ blocking: 0, warnings: 0, other: 0, errors: [] });
    expect(seen.events).toEqual([]);
  });
});

describe('categorizeOutcomes pairs each error with its guardrail', () => {
  const unnamed: EvaluationOutcome = {
    kind: 'err',
    error: { code: 'invalid-check-definition', message: 'no evaluate' },
  } as unknown as EvaluationOutcome;

  test('an error naming no guardrail takes the action of the guardrail in its place', () => {
    const c = categorizeOutcomes([unnamed], [CITE_OR_HALT]);
    expect(c.errors).toEqual([
      {
        guardrailId: 'acme.cite-or-halt',
        message: 'no evaluate',
        code: 'invalid-check-definition',
        action: 'halt',
        severity: 'error',
      },
    ]);
    expect(c.blockingErrors).toEqual(c.errors);
  });

  test('without its guardrail it is still an error, never blocking on a guess', () => {
    const c = categorizeOutcomes([unnamed]);
    expect(c.errors).toEqual([
      { guardrailId: '<unknown>', message: 'no evaluate', code: 'invalid-check-definition' },
    ]);
    expect(c.blockingErrors).toEqual([]);
  });

  test('describeBlockingViolations: an error alone, in plain words', () => {
    expect(
      describeBlockingViolations(
        [],
        [{ guardrailId: 'acme.x', code: 'unknown-check', message: 'not registered' }],
      ),
    ).toBe(
      "Turn blocked: guardrail 'acme.x' couldn't run its check (unknown-check: not registered)",
    );
  });
});

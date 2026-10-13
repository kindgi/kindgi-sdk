// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Work a turn needs, refused by a budget kept per tenant (a template
 * render, a schema compile), ends the turn as `rate-limit-exceeded` with
 * the budget and the wait: not as the model's failure, the template's or
 * a check's. The turn's handlers answer for it in one place, and the
 * run's failure reads back as that error.
 */

import { HOSTED_BOUNDS, type TenantInputBounds, runAsTenant } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import type { NodeContext } from '@kindgi/handler';
import type { RunResult } from '@kindgi/runtime';
import type { NodeId, ProjectId, RunId, TenantId } from '@kindgi/types';
import { afterEach, describe, expect, test } from 'vitest';

import { BUDGET_CHECK_NODE, RENDER_PROMPT_NODE } from '../src/agent-turn-flow.js';
import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildHandlers } from '../src/handlers/index.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { AgentTurnResult } from '../src/handlers/result-shape.js';
import { projectRunResult } from '../src/project-run-result.js';
import type { Agent, Conversation, ConversationId } from '../src/types.js';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const runId = '00000000-0000-0000-0000-0000000000dd' as RunId;

function agent(extra: Record<string, unknown> = {}): Agent {
  const made = defineAgent({
    id: 'acme.budget',
    version: '1.0.0',
    name: 'Budget',
    instructions: 'You help {{ customer }}.',
    parameters: [{ name: 'customer', type: 'string', required: true }],
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    ...extra,
  });
  if (made.kind === 'err') throw new Error(JSON.stringify(made.error.issues));
  return made.value;
}

function turnFor(a: Agent): TurnContext {
  return {
    input: {
      tenantId: 'tenant-a' as TenantId,
      projectId: '00000000-0000-0000-0000-0000000000aa' as ProjectId,
      agent: a,
      conversationId: '00000000-0000-0000-0000-0000000000cc' as ConversationId,
      userMessage: 'go',
      parameters: { customer: 'Acme' },
    },
    bindings: {} as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
    conversation: { turnCount: 0 } as Conversation,
  };
}

const kctx = { runId, dryRun: false, nodeId: 'n' as NodeId } as unknown as NodeContext;

function handlerOf(ctx: TurnContext, node: string) {
  const handler = buildHandlers(ctx).get(node as NodeId);
  if (handler === undefined) throw new Error(`no ${node} handler`);
  return handler;
}

async function turnFailure(run: () => Promise<unknown>): Promise<AgentTurnFailure> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof AgentTurnFailure) return cause;
    throw cause;
  }
  throw new Error('the handler did not fail');
}

/** A failed run whose failure message is `failure`'s, as the runtime records it. */
function failedRun(failure: AgentTurnFailure) {
  return {
    kind: 'ok',
    value: { runId, status: 'failed', failureMessage: failure.message },
  } as unknown as { kind: 'ok'; value: RunResult<AgentTurnResult> };
}

describe('a turn whose work a budget kept per tenant refuses', () => {
  test('a render: the turn fails rate-limit-exceeded, with the budget and the wait, and the run reads back as that', async () => {
    restore = overrideTenantInputBounds({ ...HOSTED_BOUNDS, templateRenderBudgetMs: 0.001 });
    const ctx = turnFor(agent());
    const renderPrompt = handlerOf(ctx, RENDER_PROMPT_NODE);
    expect(await runAsTenant('tenant-a', () => renderPrompt(undefined, kctx))).toEqual({
      rendered: 'You help Acme.',
    });

    const failure = await turnFailure(() =>
      runAsTenant('tenant-a', () => renderPrompt(undefined, kctx)),
    );
    expect(failure.payload).toEqual({
      code: 'rate-limit-exceeded',
      message: expect.stringMatching(/^Templates rendered for this tenant took its budget/),
      limit: 'template-render-time',
      budgetMs: 0.001,
      retryAfterMs: expect.any(Number),
    });
    expect(await projectRunResult(failedRun(failure), ctx)).toEqual({
      kind: 'err',
      error: failure.payload,
    });
  });

  test('a schema compile: the same failure, naming the compile budget', async () => {
    const output = {
      name: 'remedies',
      schema: {
        type: 'object',
        properties: { remedy: { type: 'array', items: { type: 'string' } } },
        required: ['remedy'],
      },
    };
    const budgetCheck = handlerOf(turnFor(agent({ output })), BUDGET_CHECK_NODE);
    // New bounds, so the turn compiles the output schema again, and none is free.
    const spent: TenantInputBounds = { ...HOSTED_BOUNDS, schemaCompileBudgetMs: 0 };
    restore = overrideTenantInputBounds(spent);
    const answer = {
      step: 1,
      finishReason: 'stop',
      message: { role: 'assistant', content: '{"remedy":[]}' },
      iterationAppended: [],
      iterationUsage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [],
      hasToolCalls: false,
    };
    const failure = await turnFailure(() =>
      runAsTenant('tenant-a', () => budgetCheck(answer, kctx), { compiles: 'all' }),
    );
    expect(failure.payload).toEqual({
      code: 'rate-limit-exceeded',
      message: expect.any(String),
      limit: 'schema-compile-time',
      budgetMs: 0,
      retryAfterMs: expect.any(Number),
    });
  });
});

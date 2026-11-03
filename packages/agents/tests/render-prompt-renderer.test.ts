// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The render-prompt step with a `templateRenderer` in the turn's
 * bindings: it awaits the renderer for the instructions, as the turn's
 * tenant, against the scope it would render in-process; a required
 * parameter missing fails the turn before the renderer is asked; the
 * renderer's failures fail the turn as an in-process render's would; and
 * a render the tenant's budget refuses ends the turn as
 * `rate-limit-exceeded`, as in `turn-budget-refusal.test.ts`. Rendering
 * in child processes is `render-worker.test.ts`'s.
 */

import { HOSTED_BOUNDS, runAsTenant } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import type { NodeContext } from '@kindgi/handler';
import type { NodeId, ProjectId, RunId, TenantId } from '@kindgi/types';
import { afterEach, describe, expect, test } from 'vitest';

import { RENDER_PROMPT_NODE } from '../src/agent-turn-flow.js';
import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildHandlers } from '../src/handlers/index.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import { admitRender } from '../src/render-budget.js';
import {
  TemplateRenderError,
  type TemplateRenderInput,
  type TemplateRenderer,
} from '../src/template-renderer.js';
import type { Agent, Conversation, ConversationId } from '../src/types.js';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const conversationId = '00000000-0000-0000-0000-0000000000cc' as ConversationId;

function agent(): Agent {
  const made = defineAgent({
    id: 'acme.renderer',
    version: '1.0.0',
    name: 'Renderer',
    instructions: 'You help {{ customer }}.',
    parameters: [{ name: 'customer', type: 'string', required: true }],
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  });
  if (made.kind === 'err') throw new Error(JSON.stringify(made.error.issues));
  return made.value;
}

/** A renderer that answers with `answer` and keeps what it was asked. */
function recording(answer: (input: TemplateRenderInput) => Promise<string>) {
  const asked: TemplateRenderInput[] = [];
  const renderer: TemplateRenderer = {
    render: (input) => {
      asked.push(input);
      return answer(input);
    },
  };
  return { renderer, asked };
}

function turnWith(
  renderer: TemplateRenderer,
  parameters: TurnContext['input']['parameters'] = { customer: 'Acme' },
): TurnContext {
  return {
    input: {
      tenantId: 'tenant-a' as TenantId,
      projectId: '00000000-0000-0000-0000-0000000000aa' as ProjectId,
      agent: agent(),
      conversationId,
      userMessage: 'go',
      parameters,
    },
    bindings: { templateRenderer: renderer } as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
    conversation: { turnCount: 0 } as Conversation,
  };
}

const kctx = {
  runId: '00000000-0000-0000-0000-0000000000dd' as RunId,
  dryRun: false,
  nodeId: 'n' as NodeId,
} as unknown as NodeContext;

function renderPromptOf(ctx: TurnContext) {
  const handler = buildHandlers(ctx).get(RENDER_PROMPT_NODE as NodeId);
  if (handler === undefined) throw new Error('no render-prompt handler');
  return () => handler(undefined, kctx);
}

async function turnFailure(run: () => Promise<unknown>): Promise<AgentTurnFailure> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof AgentTurnFailure) return cause;
    throw cause;
  }
  throw new Error('the step did not fail');
}

describe('the render-prompt step with a template renderer', () => {
  test('renders with it, as the turn’s tenant, against the parameters and the injected variables', async () => {
    // Not what an in-process render gives: the step uses the renderer's answer.
    const { renderer, asked } = recording(() => Promise.resolve('Rendered elsewhere.'));
    const ctx = turnWith(renderer);
    expect(await renderPromptOf(ctx)()).toEqual({ rendered: 'Rendered elsewhere.' });
    expect(ctx.renderedPrompt).toBe('Rendered elsewhere.');
    expect(asked).toEqual([
      {
        tenantId: 'tenant-a',
        template: 'You help {{ customer }}.',
        scope: expect.objectContaining({
          customer: 'Acme',
          agent: { id: 'acme.renderer', name: 'Renderer', version: '1.0.0' },
          conversation: { id: conversationId, turn: 1 },
          today: expect.any(String),
          now: expect.any(String),
        }),
      },
    ]);
  });

  test('a required parameter missing fails the turn before the renderer is asked', async () => {
    const { renderer, asked } = recording(() => Promise.resolve('unused'));
    const failure = await turnFailure(renderPromptOf(turnWith(renderer, {})));
    expect(failure.payload).toMatchObject({
      code: 'model-invocation-failed',
      message: 'Prompt render failed: Required parameter missing: customer',
      cause: { code: 'missing-parameter', parameterName: 'customer' },
    });
    expect(asked).toEqual([]);
  });

  test.each([
    [
      'missing-parameter',
      new TemplateRenderError({
        code: 'missing-parameter',
        message: 'Template references an unresolved variable: client',
        parameterName: 'client',
      }),
      {
        code: 'missing-parameter',
        message: 'Template references an unresolved variable: client',
        parameterName: 'client',
      },
    ],
    [
      'render-failure',
      new TemplateRenderError({
        code: 'render-failure',
        message: 'Template render failed: the render took over the limit of 200 ms',
      }),
      {
        code: 'render-failure',
        message: 'Template render failed: the render took over the limit of 200 ms',
      },
    ],
    [
      'any other rejection, named',
      new Error("The template's render worker stopped (exit code 1)."),
      {
        code: 'render-failure',
        message: "Template render failed: The template's render worker stopped (exit code 1).",
      },
    ],
  ])(
    'the renderer’s failure (%s) fails the turn as an in-process render’s would',
    async (_, rejection, cause) => {
      const { renderer } = recording(() => Promise.reject(rejection));
      const failure = await turnFailure(renderPromptOf(turnWith(renderer)));
      expect(failure.payload).toMatchObject({
        code: 'model-invocation-failed',
        message: `Prompt render failed: ${cause.message}`,
        cause,
      });
    },
  );

  test('a render the tenant’s budget refuses ends the turn rate-limit-exceeded, with the budget and the wait', async () => {
    restore = overrideTenantInputBounds({ ...HOSTED_BOUNDS, templateRenderBudgetMs: 0.001 });
    // Charged as a worker's render is: admitted, then timed from when it starts.
    const { renderer } = recording(async () => {
      const work = admitRender();
      work.start();
      await new Promise((resolve) => setTimeout(resolve, 2));
      work.end();
      return 'Rendered elsewhere.';
    });
    const ctx = turnWith(renderer);
    expect(await runAsTenant('tenant-a', renderPromptOf(ctx))).toEqual({
      rendered: 'Rendered elsewhere.',
    });
    const failure = await turnFailure(() => runAsTenant('tenant-a', renderPromptOf(ctx)));
    expect(failure.payload).toEqual({
      code: 'rate-limit-exceeded',
      message: expect.stringMatching(/^Templates rendered for this workspace took its budget/),
      limit: 'template-render-time',
      budgetMs: 0.001,
      retryAfterMs: expect.any(Number),
    });
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeHandler } from '@kindgi/handler';

import { type RenderContext, renderInstructions, renderInstructionsWith } from '../prompt.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Render the agent's instructions template with caller-supplied
 * parameters + framework auto-vars: with the bindings' `templateRenderer`
 * when there is one (in a child process, say), else in-process. Fails the
 * run with a `model-invocation-failed` (surfaced through
 * `AgentTurnFailure`) if required parameters are missing or the template
 * throws. A render the tenant's render budget refuses isn't the
 * template's failure: the refusal is thrown, and the turn answers for it
 * (`rate-limit-exceeded`, in `buildHandlers`).
 *
 * Setup must have run first — `ctx.conversation` is required.
 */
export function buildRenderPromptHandler(ctx: TurnContext): NodeHandler {
  return async () => {
    if (ctx.conversation === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'render-prompt invoked before setup completed',
        cause: null,
      });
    }
    const context: RenderContext = {
      parameters: ctx.input.parameters ?? {},
      ...(ctx.input.input !== undefined && { input: ctx.input.input }),
      conversation: {
        id: ctx.input.conversationId,
        turn: ctx.conversation.turnCount + 1,
      },
      ...(ctx.blocks !== undefined && { settings: ctx.blocks.settings }),
    };
    // The pinned prompt block, when the instructions come from one.
    const prompt = ctx.blocks?.prompt?.content;
    const renderer = ctx.bindings.templateRenderer;
    const rendered =
      renderer === undefined
        ? renderInstructions(ctx.input.agent, context, prompt)
        : await renderInstructionsWith(
            renderer,
            ctx.input.tenantId,
            ctx.input.agent,
            context,
            prompt,
          );
    if (!rendered.ok) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: `Prompt render failed: ${rendered.error.message}`,
        cause: rendered.error,
      });
    }
    ctx.renderedPrompt = rendered.value.rendered;
    return { rendered: rendered.value.rendered };
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeHandler } from '@kindgi/handler';

import { renderInstructions } from '../prompt.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Render the agent's instructions template with caller-supplied
 * parameters + framework auto-vars. Fails the run with a
 * `model-invocation-failed` (surfaced through `AgentTurnFailure`) if
 * required parameters are missing or the template throws.
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
    const rendered = renderInstructions(
      ctx.input.agent,
      {
        parameters: ctx.input.parameters ?? {},
        ...(ctx.input.input !== undefined && { input: ctx.input.input }),
        conversation: {
          id: ctx.input.conversationId,
          turn: ctx.conversation.turnCount + 1,
        },
        ...(ctx.blocks !== undefined && { settings: ctx.blocks.settings }),
      },
      // The pinned prompt block, when the instructions come from one.
      ctx.blocks?.prompt?.content,
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

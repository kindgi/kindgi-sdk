// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { HandlerRegistry, NodeHandler } from '@kindgi/handler';
import type { NodeId } from '@kindgi/types';

import {
  AGENT_LOOP_NODE,
  BUDGET_CHECK_NODE,
  BUILD_INITIAL_MESSAGES_NODE,
  COMPOSE_RESULT_NODE,
  DISPATCH_TOOLS_NODE,
  EVALUATE_GUARDRAILS_NODE,
  MODEL_CALL_NODE,
  PERSIST_FINAL_MESSAGE_NODE,
  PERSIST_PROVENANCE_NODE,
  PERSIST_USER_MESSAGE_NODE,
  RENDER_PROMPT_NODE,
  RUN_RETRIEVALS_NODE,
  SETUP_NODE,
} from '../agent-turn-flow.js';

import { buildBudgetCheckHandler } from './budget-check.js';
import { buildBuildInitialMessagesHandler } from './build-initial-messages.js';
import { buildComposeResultHandler } from './compose-result.js';
import type { TurnContext } from './context.js';
import { buildDispatchToolsHandler } from './dispatch-tools.js';
import { buildEvaluateGuardrailsHandler } from './evaluate-guardrails.js';
import { buildModelCallHandler } from './model-call.js';
import { buildPersistFinalMessageHandler } from './persist-final-message.js';
import { buildPersistProvenanceHandler } from './persist-provenance.js';
import { buildPersistUserMessageHandler } from './persist-user-message.js';
import { buildRenderPromptHandler } from './render-prompt.js';
import { buildRunRetrievalsHandler } from './run-retrievals.js';
import { buildSetupHandler } from './setup.js';

// `agent-loop` is a kernel loop node — the executor dispatches it
// internally; only body-node handlers are registered.
export function buildHandlers(ctx: TurnContext): HandlerRegistry {
  const entries: [NodeId, NodeHandler][] = [
    [SETUP_NODE as NodeId, buildSetupHandler(ctx)],
    [RENDER_PROMPT_NODE as NodeId, buildRenderPromptHandler(ctx)],
    [PERSIST_USER_MESSAGE_NODE as NodeId, buildPersistUserMessageHandler(ctx)],
    [RUN_RETRIEVALS_NODE as NodeId, buildRunRetrievalsHandler(ctx)],
    [BUILD_INITIAL_MESSAGES_NODE as NodeId, buildBuildInitialMessagesHandler(ctx)],
    [MODEL_CALL_NODE as NodeId, buildModelCallHandler(ctx)],
    [DISPATCH_TOOLS_NODE as NodeId, buildDispatchToolsHandler(ctx)],
    [BUDGET_CHECK_NODE as NodeId, buildBudgetCheckHandler(ctx)],
    [PERSIST_FINAL_MESSAGE_NODE as NodeId, buildPersistFinalMessageHandler(ctx)],
    [EVALUATE_GUARDRAILS_NODE as NodeId, buildEvaluateGuardrailsHandler(ctx)],
    [PERSIST_PROVENANCE_NODE as NodeId, buildPersistProvenanceHandler(ctx)],
    [COMPOSE_RESULT_NODE as NodeId, buildComposeResultHandler(ctx)],
  ];
  // Assert `agent-loop` isn't accidentally registered — the runtime's
  // flow executor rejects handlers for internal-dispatch nodes at load
  // time. Sanity check for regressions.
  if (entries.some(([id]) => id === (AGENT_LOOP_NODE as NodeId))) {
    throw new Error('agent-loop must not have a handler — it is dispatched by the kernel');
  }
  return new Map(entries);
}

export type { TurnContext };

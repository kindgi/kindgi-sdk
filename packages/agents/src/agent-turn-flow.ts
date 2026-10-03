// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Flow } from '@kindgi/flow';
import { loadFlow } from '@kindgi/flow';

/**
 * The versioned agent-turn flow. Every agent turn — regardless of which
 * concrete `Agent` is being invoked — executes as a run of this flow
 * against handlers that close over the specific agent + bindings + input.
 *
 * Shape (uses the kernel loop primitive for the model↔tool cycle):
 *
 * ```
 * $start → setup → render-prompt → persist-user-message → run-retrievals
 *        → build-initial-messages → agent-loop (kernel loop node)
 *        → evaluate-guardrails → persist-final-message → persist-provenance
 *        → compose-result → $end
 * ```
 *
 * Guardrails run on the final response before it is stored: a response
 * a blocking guardrail rejects never reaches the conversation.
 *
 * `agent-loop` is a `while+after` (do-while) loop; its body is
 * `$loop-start → model-call → dispatch-tools → budget-check → $loop-end`.
 * Exit condition: `iterationOutput.finishedTurn === true`.
 * `collectAllIterations: true` so post-loop nodes can aggregate every
 * iteration's per-iteration usage + appended messages.
 *
 * Version-locked so historical runs pin to this shape; any
 * change to the node set or body sub-flow bumps the version and
 * `resumeRun` refuses to resume old runs against a new flow.
 */
export const AGENT_TURN_FLOW_ID = 'agent.turn';
export const AGENT_TURN_FLOW_VERSION = '1.1.0';

/**
 * Safety cap for iterations. Per-agent `maxSteps` is enforced by the
 * `budget-check` body node — this constant only bounds catastrophic
 * runaway (model always requests a tool call, no budget-check, no
 * agent config). Set high enough that no real agent will hit it.
 */
export const AGENT_TURN_LOOP_MAX_ITERATIONS = 32;

// Outer node ids.
export const SETUP_NODE = 'setup';
export const RENDER_PROMPT_NODE = 'render-prompt';
export const PERSIST_USER_MESSAGE_NODE = 'persist-user-message';
export const RUN_RETRIEVALS_NODE = 'run-retrievals';
export const BUILD_INITIAL_MESSAGES_NODE = 'build-initial-messages';
export const AGENT_LOOP_NODE = 'agent-loop';
export const PERSIST_FINAL_MESSAGE_NODE = 'persist-final-message';
export const EVALUATE_GUARDRAILS_NODE = 'evaluate-guardrails';
export const PERSIST_PROVENANCE_NODE = 'persist-provenance';
export const COMPOSE_RESULT_NODE = 'compose-result';

// Loop body node ids.
export const MODEL_CALL_NODE = 'model-call';
export const DISPATCH_TOOLS_NODE = 'dispatch-tools';
export const BUDGET_CHECK_NODE = 'budget-check';

/**
 * JSON Schema (draft 2020-12) for each iteration's `$loop-end` output.
 * See `AgentTurnIterationOutput` in the handlers module for the TS
 * mirror.
 */
const iterationOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'finishReason',
    'message',
    'iterationAppended',
    'iterationUsage',
    'provider',
    'finishedTurn',
    'nextMessages',
  ],
  properties: {
    finishReason: {
      type: 'string',
      enum: ['stop', 'length', 'tool-use', 'content-filter', 'error'],
    },
    message: { type: 'object' },
    iterationAppended: { type: 'array' },
    iterationUsage: {
      type: 'object',
      additionalProperties: false,
      required: ['promptTokens', 'completionTokens', 'costUsd'],
      properties: {
        promptTokens: { type: 'integer', minimum: 0 },
        completionTokens: { type: 'integer', minimum: 0 },
        costUsd: { type: 'number', minimum: 0 },
      },
    },
    provider: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'model'],
      properties: {
        id: { type: 'string' },
        model: { type: 'string' },
      },
    },
    finishedTurn: { type: 'boolean' },
    nextMessages: { type: 'array' },
    /** Populated when finishReason='error' from budget-check or dispatch failure. */
    errorPayload: { type: 'object' },
  },
} as const;

const rawGraph = {
  id: AGENT_TURN_FLOW_ID,
  version: AGENT_TURN_FLOW_VERSION,
  name: 'Agent turn',
  description:
    'Framework-grade agent turn execution. One run per turn. Model↔tool cycle uses the kernel loop primitive.',
  nodes: [
    { id: SETUP_NODE, kind: 'tool', ref: 'inline' },
    { id: RENDER_PROMPT_NODE, kind: 'tool', ref: 'inline' },
    { id: PERSIST_USER_MESSAGE_NODE, kind: 'tool', ref: 'inline' },
    { id: RUN_RETRIEVALS_NODE, kind: 'tool', ref: 'inline' },
    { id: BUILD_INITIAL_MESSAGES_NODE, kind: 'tool', ref: 'inline' },
    {
      id: AGENT_LOOP_NODE,
      kind: 'loop',
      loopKind: 'while',
      evaluationTiming: 'after',
      maxIterations: AGENT_TURN_LOOP_MAX_ITERATIONS,
      exitCondition: {
        op: 'truthy',
        value: { path: 'iterationOutput.finishedTurn' },
      },
      outputSchema: iterationOutputSchema,
      collectAllIterations: true,
      body: {
        nodes: [
          { id: MODEL_CALL_NODE, kind: 'tool', ref: 'inline' },
          { id: DISPATCH_TOOLS_NODE, kind: 'tool', ref: 'inline' },
          { id: BUDGET_CHECK_NODE, kind: 'tool', ref: 'inline' },
        ],
        edges: [
          { id: 'body-e1', from: '$loop-start', to: MODEL_CALL_NODE },
          { id: 'body-e2', from: MODEL_CALL_NODE, to: DISPATCH_TOOLS_NODE },
          { id: 'body-e3', from: DISPATCH_TOOLS_NODE, to: BUDGET_CHECK_NODE },
          { id: 'body-e4', from: BUDGET_CHECK_NODE, to: '$loop-end' },
        ],
      },
    },
    { id: EVALUATE_GUARDRAILS_NODE, kind: 'tool', ref: 'inline' },
    { id: PERSIST_FINAL_MESSAGE_NODE, kind: 'tool', ref: 'inline' },
    { id: PERSIST_PROVENANCE_NODE, kind: 'tool', ref: 'inline' },
    { id: COMPOSE_RESULT_NODE, kind: 'tool', ref: 'inline' },
  ],
  edges: [
    { id: 'e0', from: '$start', to: SETUP_NODE },
    { id: 'e1', from: SETUP_NODE, to: RENDER_PROMPT_NODE },
    { id: 'e2', from: RENDER_PROMPT_NODE, to: PERSIST_USER_MESSAGE_NODE },
    { id: 'e3', from: PERSIST_USER_MESSAGE_NODE, to: RUN_RETRIEVALS_NODE },
    { id: 'e4', from: RUN_RETRIEVALS_NODE, to: BUILD_INITIAL_MESSAGES_NODE },
    { id: 'e5', from: BUILD_INITIAL_MESSAGES_NODE, to: AGENT_LOOP_NODE },
    { id: 'e6', from: AGENT_LOOP_NODE, to: EVALUATE_GUARDRAILS_NODE },
    { id: 'e7', from: EVALUATE_GUARDRAILS_NODE, to: PERSIST_FINAL_MESSAGE_NODE },
    { id: 'e8', from: PERSIST_FINAL_MESSAGE_NODE, to: PERSIST_PROVENANCE_NODE },
    { id: 'e9', from: PERSIST_PROVENANCE_NODE, to: COMPOSE_RESULT_NODE },
    { id: 'e10', from: COMPOSE_RESULT_NODE, to: '$end' },
  ],
} as const;

/**
 * The compiled + validated flow. Cached — the loader is called once
 * at module load. Throws on module load if the constant is malformed
 * (should be caught by tests immediately).
 */
export const AGENT_TURN_FLOW: Flow = (() => {
  const r = loadFlow(rawGraph);
  if (r.kind === 'err') {
    throw new Error(
      `AGENT_TURN_FLOW failed to load — this is a bug in agent-turn-flow.ts: ${JSON.stringify(r.error)}`,
    );
  }
  return r.value;
})();

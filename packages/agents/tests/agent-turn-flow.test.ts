// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { isLoopNode } from '@kindgi/flow';

import {
  AGENT_LOOP_NODE,
  AGENT_TURN_FLOW,
  AGENT_TURN_FLOW_ID,
  AGENT_TURN_FLOW_VERSION,
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
} from '../src/agent-turn-flow.js';

describe('AGENT_TURN_FLOW', () => {
  test('loads without error at module init', () => {
    expect(AGENT_TURN_FLOW.id).toBe(AGENT_TURN_FLOW_ID);
    expect(AGENT_TURN_FLOW.version).toBe(AGENT_TURN_FLOW_VERSION);
  });

  test('has the expected 10 outer nodes in canonical order', () => {
    const ids = AGENT_TURN_FLOW.nodes.map((n) => n.id);
    expect(ids).toEqual([
      SETUP_NODE,
      RENDER_PROMPT_NODE,
      PERSIST_USER_MESSAGE_NODE,
      RUN_RETRIEVALS_NODE,
      BUILD_INITIAL_MESSAGES_NODE,
      AGENT_LOOP_NODE,
      EVALUATE_GUARDRAILS_NODE,
      PERSIST_FINAL_MESSAGE_NODE,
      PERSIST_PROVENANCE_NODE,
      COMPOSE_RESULT_NODE,
    ]);
  });

  test('agent-loop is a while+after kernel loop node', () => {
    const loopNode = AGENT_TURN_FLOW.nodes.find((n) => n.id === AGENT_LOOP_NODE);
    expect(loopNode).toBeDefined();
    if (loopNode === undefined) return;
    expect(isLoopNode(loopNode)).toBe(true);
    if (!isLoopNode(loopNode)) return;
    expect(loopNode.loopKind).toBe('while');
    if (loopNode.loopKind !== 'while') return;
    expect(loopNode.evaluationTiming ?? 'after').toBe('after');
    expect(loopNode.collectAllIterations).toBe(true);
  });

  test('loop body has the expected 3 nodes (model-call, dispatch-tools, budget-check)', () => {
    const loopNode = AGENT_TURN_FLOW.nodes.find((n) => n.id === AGENT_LOOP_NODE);
    if (loopNode === undefined || !isLoopNode(loopNode)) throw new Error('loop node missing');
    const bodyIds = loopNode.body.nodes.map((n) => n.id);
    expect(bodyIds).toEqual([MODEL_CALL_NODE, DISPATCH_TOOLS_NODE, BUDGET_CHECK_NODE]);
  });

  test('loop body edges wire model-call → dispatch-tools → budget-check → $loop-end', () => {
    const loopNode = AGENT_TURN_FLOW.nodes.find((n) => n.id === AGENT_LOOP_NODE);
    if (loopNode === undefined || !isLoopNode(loopNode)) throw new Error('loop node missing');
    const froms = loopNode.body.edges.map((e) => e.from);
    const tos = loopNode.body.edges.map((e) => e.to);
    expect(froms).toEqual(['$loop-start', MODEL_CALL_NODE, DISPATCH_TOOLS_NODE, BUDGET_CHECK_NODE]);
    expect(tos).toEqual([MODEL_CALL_NODE, DISPATCH_TOOLS_NODE, BUDGET_CHECK_NODE, '$loop-end']);
  });

  test('outer edges form a linear chain $start → ... → $end', () => {
    const edges = AGENT_TURN_FLOW.edges;
    expect(edges[0]?.from).toBe('$start');
    expect(edges[0]?.to).toBe(SETUP_NODE);
    expect(edges[edges.length - 1]?.from).toBe(COMPOSE_RESULT_NODE);
    expect(edges[edges.length - 1]?.to).toBe('$end');
  });

  test('guardrails run on the final response before it is stored', () => {
    const next = new Map<string, string>(AGENT_TURN_FLOW.edges.map((e) => [e.from, e.to]));
    expect(next.get(AGENT_LOOP_NODE)).toBe(EVALUATE_GUARDRAILS_NODE);
    expect(next.get(EVALUATE_GUARDRAILS_NODE)).toBe(PERSIST_FINAL_MESSAGE_NODE);
  });
});

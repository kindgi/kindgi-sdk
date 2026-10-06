// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { canonicalize } from '@kindgi/schema';

import { type Flow, type FlowNode, isFanoutNode, isLoopNode } from './types.js';

/**
 * The exact version of each block a flow version runs: its lockfile.
 *
 * A flow names its tools by id (a tool node's `ref`, a fanout branch's
 * `handler`) and its agents by id, with an exact `config.version` or
 * none. When a version of the flow is published, the runtime pins each
 * tool, and each agent that names no version, to its latest version
 * then, and every run of that flow version uses those versions. So a
 * new tool or agent version reaches the flow only through a new flow
 * version.
 *
 * Set by the runtime at publish, never authored. A flow version
 * published before pins existed has none and binds the latest versions
 * per run.
 */
export interface FlowPins {
  /** Tool id → the exact version this flow version runs. */
  readonly tools: Readonly<Record<string, string>>;
  /** Agent id → the exact version its agent nodes that name none run. */
  readonly agents: Readonly<Record<string, string>>;
}

/**
 * `sha256:<hex>` of a flow version's pins' canonical JSON (keys sorted,
 * no whitespace), as `pinsDigest` in `@kindgi/agents` is for an agent's.
 */
export function flowPinsDigest(pins: FlowPins): string {
  const canonical = canonicalize({ tools: pins.tools, agents: pins.agents });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** The blocks a flow runs that its pins name: tool ids, and agent ids with no version. */
export interface FlowRefs {
  readonly tools: readonly string[];
  readonly agents: readonly string[];
}

/**
 * Every tool a flow runs (tool nodes and fanout branches, in loop bodies
 * too: what the runtime binds) and every agent it runs at no named
 * version, each id once, sorted.
 */
export function flowRefs(flow: Flow): FlowRefs {
  const tools = new Set<string>();
  const agents = new Set<string>();
  collectRefs(flow.nodes, tools, agents);
  return { tools: [...tools].sort(), agents: [...agents].sort() };
}

function collectRefs(nodes: readonly FlowNode[], tools: Set<string>, agents: Set<string>): void {
  for (const node of nodes) {
    if (isLoopNode(node)) collectRefs(node.body.nodes, tools, agents);
    else if (isFanoutNode(node)) for (const branch of node.branches) tools.add(branch.handler);
    else if (node.kind === 'tool') tools.add(node.ref);
    else if (node.kind === 'agent' && node.config?.version === undefined) agents.add(node.ref);
  }
}

/** Exact versions to run a flow version with, over its pins: the shape of a comparison's override. */
export interface FlowVersionOverrides {
  readonly tools?: Readonly<Record<string, string>>;
  readonly agents?: Readonly<Record<string, string>>;
}

/**
 * The flow version with some of its blocks run at other exact versions,
 * without publishing a new flow version: what a comparison or a replay
 * runs ("this flow, but `acme.scorer` at 0.4.0").
 *
 * One mechanism with the pins: the overrides go into `pins` (over the
 * version's own), and an agent node that names its own `config.version`
 * gets the override there too, since a node's own version wins over a
 * pin. `pinsDigest` is recomputed, so it names what runs. A flow version
 * published before pins gets pins of the overrides only; its other
 * blocks bind their latest versions, as before.
 */
export function withVersions(flow: Flow, overrides: FlowVersionOverrides): Flow {
  const pins: FlowPins = {
    tools: { ...(flow.pins?.tools ?? {}), ...(overrides.tools ?? {}) },
    agents: { ...(flow.pins?.agents ?? {}), ...(overrides.agents ?? {}) },
  };
  const agents = overrides.agents ?? {};
  return {
    ...flow,
    nodes: overrideNamedAgentVersions(flow.nodes, agents),
    pins,
    pinsDigest: flowPinsDigest(pins),
  };
}

function overrideNamedAgentVersions(
  nodes: readonly FlowNode[],
  agents: Readonly<Record<string, string>>,
): readonly FlowNode[] {
  return nodes.map((node) => {
    if (isLoopNode(node)) {
      return {
        ...node,
        body: { ...node.body, nodes: overrideNamedAgentVersions(node.body.nodes, agents) },
      };
    }
    const version = node.kind === 'agent' ? agents[node.ref] : undefined;
    if (node.kind !== 'agent' || version === undefined || node.config?.version === undefined) {
      return node;
    }
    return { ...node, config: { ...node.config, version } };
  });
}

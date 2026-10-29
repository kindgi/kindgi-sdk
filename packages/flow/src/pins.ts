// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { canonicalize } from '@kindgi/schema';

import {
  type Flow,
  type FlowNode,
  type SubflowNode,
  isFanoutNode,
  isLoopNode,
  isSubflowNode,
} from './types.js';

/**
 * The exact version of each block a flow version runs: its lockfile.
 *
 * A flow names its tools by id (a tool node's `ref`, a fanout branch's
 * `handler`), its agents by id, with an exact `config.version` or none,
 * and its sub-flows by id, with an exact `flowRef.version` or none. When
 * a version of the flow is published, the runtime pins each tool, each
 * agent that names no version and each sub-flow that names no version,
 * and every run of that flow version uses those versions. So a new tool,
 * agent or sub-flow version reaches the flow only through a new flow
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
  /**
   * Flow id → the exact version its sub-flow steps that name none run.
   * Absent when there are none, and on a version published before
   * sub-flows were pinned.
   */
  readonly flows?: Readonly<Record<string, string>>;
}

/**
 * `sha256:<hex>` of a flow version's pins' canonical JSON (keys sorted,
 * no whitespace), as `pinsDigest` in `@kindgi/agents` is for an agent's.
 * Pins with no sub-flow entries hash without the `flows` key, as they
 * did before sub-flows were pinned.
 */
export function flowPinsDigest(pins: FlowPins): string {
  const flows = pins.flows ?? {};
  const canonical = canonicalize({
    tools: pins.tools,
    agents: pins.agents,
    ...(Object.keys(flows).length > 0 && { flows }),
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * The blocks a flow runs that its pins name: tool ids, agent ids with no
 * version, and sub-flow ids with no version.
 */
export interface FlowRefs {
  readonly tools: readonly string[];
  readonly agents: readonly string[];
  readonly flows: readonly string[];
}

/**
 * Every tool a flow runs (tool nodes and fanout branches, in loop bodies
 * too: what the runtime binds), every agent it runs at no named version
 * and every sub-flow it runs at no named version, each id once, sorted.
 */
export function flowRefs(flow: Flow): FlowRefs {
  const found = collectedRefs(flow, false);
  return { tools: found.tools, agents: found.agents, flows: found.flows };
}

/** What a run's versions can override in a flow: tool ids and agent ids. */
export interface OverridableRefs {
  readonly tools: readonly string[];
  readonly agents: readonly string[];
}

/**
 * What `withVersions` can run at other versions: every tool the flow runs
 * and every agent, at a named version or not (an override replaces
 * either), each id once, sorted. A sub-flow's own blocks aren't in it:
 * see `overridableTreeRefs`.
 */
export function overridableRefs(flow: Flow): OverridableRefs {
  const found = collectedRefs(flow, true);
  return { tools: found.tools, agents: found.agents };
}

/**
 * Reads one version of a flow, for `overridableTreeRefs`: `null` when it
 * isn't there.
 */
export type SubflowReader = (ref: {
  readonly flowId: string;
  readonly version: string;
}) => Promise<Flow | null>;

/** How deep a run's sub-flows go by default (`RunOptions.maxSubflowDepth`). */
const SUBFLOW_DEPTH = 10;

/**
 * What a run's versions can override in a run of `flow` and its
 * sub-flows: `overridableRefs` over the flow and each sub-flow version
 * it runs (`subflowVersion`), at any depth a run reaches, since a run's
 * versions apply to every flow of the run. Each sub-flow version is read
 * once. One that isn't there, or a step with no version to run, adds
 * nothing: a run refuses it when it starts.
 */
export async function overridableTreeRefs(
  flow: Flow,
  read: SubflowReader,
): Promise<OverridableRefs> {
  const tools = new Set<string>();
  const agents = new Set<string>();
  const seen = new Set<string>([`${flow.id as unknown as string}@${flow.version}`]);
  let level: Flow[] = [flow];
  for (let depth = 0; level.length > 0; depth += 1) {
    const next: Flow[] = [];
    for (const each of level) {
      const found = collectedRefs(each, true);
      for (const id of found.tools) tools.add(id);
      for (const id of found.agents) agents.add(id);
      if (depth === SUBFLOW_DEPTH) continue;
      for (const step of found.subflows) {
        const version = subflowVersion(each, step);
        const key = `${step.flowRef.flowId}@${version}`;
        if (version === undefined || seen.has(key)) continue;
        seen.add(key);
        const child = await read({ flowId: step.flowRef.flowId, version });
        if (child !== null) next.push(child);
      }
    }
    level = next;
  }
  return { tools: [...tools].sort(), agents: [...agents].sort() };
}

/**
 * The child version a sub-flow step of `parent` runs: the one its
 * `flowRef` names, else the parent version's pin for the flow;
 * `undefined` when it has neither (a version published without pins).
 */
export function subflowVersion(parent: Flow, step: SubflowNode): string | undefined {
  return step.flowRef.version ?? parent.pins?.flows?.[step.flowRef.flowId];
}

interface CollectedRefs {
  readonly tools: string[];
  readonly agents: string[];
  /** Sub-flow ids the flow runs at no named version. */
  readonly flows: string[];
  /** Every sub-flow step, in loop bodies too. */
  readonly subflows: SubflowNode[];
}

function collectedRefs(flow: Flow, namedAgents: boolean): CollectedRefs {
  const tools = new Set<string>();
  const agents = new Set<string>();
  const subflows: SubflowNode[] = [];
  collectRefs(flow.nodes, tools, agents, subflows, namedAgents);
  const flows = new Set(
    subflows.filter((s) => s.flowRef.version === undefined).map((s) => s.flowRef.flowId),
  );
  return {
    tools: [...tools].sort(),
    agents: [...agents].sort(),
    flows: [...flows].sort(),
    subflows,
  };
}

function collectRefs(
  nodes: readonly FlowNode[],
  tools: Set<string>,
  agents: Set<string>,
  subflows: SubflowNode[],
  namedAgents: boolean,
): void {
  for (const node of nodes) {
    if (isLoopNode(node)) collectRefs(node.body.nodes, tools, agents, subflows, namedAgents);
    else if (isFanoutNode(node)) for (const branch of node.branches) tools.add(branch.handler);
    else if (isSubflowNode(node)) subflows.push(node);
    else if (node.kind === 'tool') tools.add(node.ref);
    else if (node.kind === 'agent' && (namedAgents || node.config?.version === undefined)) {
      agents.add(node.ref);
    }
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
    // A run's versions don't name sub-flows: each keeps its pin.
    ...(flow.pins?.flows !== undefined && { flows: flow.pins.flows }),
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

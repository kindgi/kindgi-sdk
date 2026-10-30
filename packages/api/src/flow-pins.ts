// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/agents';
import type { TupleEnqueueHook } from '@kindgi/authz';
import { type Flow, type FlowPins, flowPinsDigest, flowRefs } from '@kindgi/flow';
import { highestVersion } from '@kindgi/tools';
import type { Cursor, FlowId, ProjectId, TenantId, ToolId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { AgentPinBindings } from './agent-pin-binding.js';
import {
  type ToolPinLookup,
  type UnpinnableRef,
  activeToolVersions,
  pinnedToolVersion,
} from './agent-pins.js';
import { type DeployedVersionOutcome, deployVersion } from './deploy-versions.js';
import type { FlowRegistryBinding, FlowVersionRecord } from './flow-binding.js';
import { PublishRefused } from './publish-refused.js';
import type { ToolRegistryBinding } from './tool-binding.js';
import { whatRuns } from './what-runs.js';

export type FlowPinsOutcome =
  | { readonly kind: 'ok'; readonly pins: FlowPins }
  | { readonly kind: 'unpinnable'; readonly issues: readonly UnpinnableRef[] };

/**
 * Where a flow version is published, so its agent pins are what a run
 * there would get: what runs in the project (`whatRuns`).
 */
export interface FlowAgentPins {
  readonly bindings: Pick<AgentPinBindings, 'pinned' | 'latest'>;
  readonly projectId: ProjectId;
}

/**
 * Pin a flow version when it's published, to what a run would have bound
 * then, so every run of the version uses those: each tool it runs to its
 * version pinned for the flow's project, with `toolPins` (the project, then
 * its org, then the tenant), else its latest active version; and each
 * agent it runs at no named version to
 * the version a run that names none gets in the flow's project. That's
 * the agent's pinned version there (project, then its org, then the
 * tenant), else its Latest there, with `agentPins`; else its highest. A
 * gated agent's flow runs what its pins let through, not an unpinned
 * newer version; and an agent step under one of its release gates set on
 * a segment runs the version pinned there, not its pin (the runtime
 * decides that per run). A
 * tool or agent with no published version makes the flow unpinnable: the
 * caller refuses the publish, naming each, rather than store a partly
 * pinned version.
 */
export async function resolveFlowPins(
  tools: ToolRegistryBinding,
  agents: AgentRegistryBinding,
  tenantId: TenantId,
  flow: Flow,
  agentPins?: FlowAgentPins,
  toolPins?: ToolPinLookup,
): Promise<FlowPinsOutcome> {
  const refs = flowRefs(flow);
  const pinned: { tools: Record<string, string>; agents: Record<string, string> } = {
    tools: {},
    agents: {},
  };
  const issues: UnpinnableRef[] = [];
  for (const id of refs.tools) {
    const active = await activeToolVersions(tools, tenantId, id as ToolId);
    const version =
      (await pinnedToolVersion(toolPins, tenantId, id, active)) ?? highestVersion(active);
    if (version !== undefined) pinned.tools[id] = version;
    else
      issues.push({
        path: '/nodes',
        message: `tool "${id}" has no published version; publish the tool first`,
      });
  }
  for (const id of refs.agents) {
    const version = await implicitAgentVersion(agents, agentPins, tenantId, id);
    if (version !== undefined) pinned.agents[id] = version;
    else
      issues.push({
        path: '/nodes',
        message: `agent "${id}" has no published version; publish the agent first`,
      });
  }
  if (issues.length > 0) return { kind: 'unpinnable', issues };
  return { kind: 'ok', pins: pinned };
}

/**
 * The version a run of agent `id` that names none gets now in `agentPins`'s
 * project: the pin on the way up, else Latest (`whatRuns`); `undefined`
 * when no version runs there.
 */
async function implicitAgentVersion(
  agents: AgentRegistryBinding,
  agentPins: FlowAgentPins | undefined,
  tenantId: TenantId,
  id: string,
): Promise<string | undefined> {
  if (agentPins !== undefined) {
    const runs = await whatRuns(agentPins.bindings, {
      tenantId,
      agentId: id,
      projectId: agentPins.projectId,
    });
    return runs?.version as unknown as string | undefined;
  }
  // No pins or Latest wired (`createApp` without `agentReleases`): the highest version, as a run gets.
  const highest = await agents.get({ tenantId, agentId: id as AgentId });
  return highest === null ? undefined : (highest.version as unknown as string);
}

export interface PublishDeployedFlowInput {
  readonly flows: FlowRegistryBinding;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** The flow as the pack defines it, with no pins. */
  readonly flow: Flow;
  readonly pins: FlowPins;
  readonly enqueueTuples: TupleEnqueueHook;
}

/** Register a deployed flow with its pins, by the deploy rule (`deployVersion`). */
export async function publishDeployedFlow(
  input: PublishDeployedFlowInput,
): Promise<DeployedVersionOutcome> {
  const { flows, tenantId, projectId, flow, pins, enqueueTuples } = input;
  const existing = await allFlowVersions(flows, tenantId, flow.id);
  // A flow never moves, even by a deploy that writes nothing (an unchanged
  // or reused version): one of another project is refused. A registry
  // that doesn't record the project refuses only a write.
  const held = existing[0];
  if (held !== undefined) {
    const record = await flows.getVersion({ tenantId, flowId: flow.id, version: held.version });
    if (record?.projectId !== undefined && record.projectId !== projectId) {
      throw new PublishRefused('flow', `${flow.id}@${flow.version}`, {
        kind: 'project-mismatch',
        flowId: flow.id,
        version: flow.version,
        projectId: record.projectId,
      });
    }
  }
  return deployVersion<Flow>({
    label: `flow "${flow.id as unknown as string}"`,
    definition: flow,
    pins,
    pinsDigest: flowPinsDigest(pins),
    existing,
    publish: async (version) => {
      const outcome = await flows.publish({ tenantId, projectId, flow: version, enqueueTuples });
      if (outcome.kind === 'ok') return 'ok';
      if (outcome.kind === 'already-registered') return 'taken';
      throw new PublishRefused('flow', `${flow.id}@${version.version}`, outcome);
    },
  });
}

/** Page size for reading a flow's versions. */
const VERSIONS_PAGE = 200;

/** Every active version of a flow. */
async function allFlowVersions(
  flows: FlowRegistryBinding,
  tenantId: TenantId,
  flowId: FlowId,
): Promise<readonly FlowVersionRecord[]> {
  const versions: FlowVersionRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await flows.listVersions({
      tenantId,
      flowId,
      limit: VERSIONS_PAGE,
      ...(cursor !== undefined && { cursor }),
    });
    versions.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return versions;
}

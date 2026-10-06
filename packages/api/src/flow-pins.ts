// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/agents';
import type { TupleEnqueueHook } from '@kindgi/authz';
import { type Flow, type FlowPins, flowPinsDigest, flowRefs } from '@kindgi/flow';
import { latestVersion } from '@kindgi/tools';
import type { Cursor, FlowId, ProjectId, TenantId, ToolId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import { type UnpinnableRef, activeToolVersions } from './agent-pins.js';
import { type DeployedVersionOutcome, deployVersion } from './deploy-versions.js';
import type { FlowRegistryBinding } from './flow-binding.js';
import { PublishRefused } from './publish-refused.js';
import type { ToolRegistryBinding } from './tool-binding.js';

export type FlowPinsOutcome =
  | { readonly kind: 'ok'; readonly pins: FlowPins }
  | { readonly kind: 'unpinnable'; readonly issues: readonly UnpinnableRef[] };

/**
 * Pin a flow version when it's published: each tool it runs, and each
 * agent it runs at no named version, to its latest active version now
 * (what a run would have bound), so every run of the version uses those.
 * A tool or agent with no published version makes the flow unpinnable:
 * the caller refuses the publish, naming each, rather than store a
 * partly pinned version.
 */
export async function resolveFlowPins(
  tools: ToolRegistryBinding,
  agents: AgentRegistryBinding,
  tenantId: TenantId,
  flow: Flow,
): Promise<FlowPinsOutcome> {
  const refs = flowRefs(flow);
  const pinned: { tools: Record<string, string>; agents: Record<string, string> } = {
    tools: {},
    agents: {},
  };
  const issues: UnpinnableRef[] = [];
  for (const id of refs.tools) {
    const latest = latestVersion(await activeToolVersions(tools, tenantId, id as ToolId));
    if (latest !== undefined) pinned.tools[id] = latest;
    else
      issues.push({
        path: '/nodes',
        message: `tool "${id}" has no published version; publish the tool first`,
      });
  }
  for (const id of refs.agents) {
    const latest = await agents.get({ tenantId, agentId: id as AgentId });
    if (latest !== null) pinned.agents[id] = latest.version as unknown as string;
    else
      issues.push({
        path: '/nodes',
        message: `agent "${id}" has no published version; publish the agent first`,
      });
  }
  if (issues.length > 0) return { kind: 'unpinnable', issues };
  return { kind: 'ok', pins: pinned };
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
  return deployVersion<Flow>({
    label: `flow "${flow.id as unknown as string}"`,
    definition: flow,
    pins,
    pinsDigest: flowPinsDigest(pins),
    existing: await allFlowVersions(flows, tenantId, flow.id),
    publish: async (version) => {
      const outcome = await flows.publish({ tenantId, projectId, flow: version, enqueueTuples });
      if (outcome.kind === 'ok') return 'ok';
      if (outcome.kind === 'already-registered') return 'taken';
      throw new PublishRefused('flow', `${flow.id}@${version.version}`, outcome.kind);
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
): Promise<readonly Flow[]> {
  const versions: Flow[] = [];
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

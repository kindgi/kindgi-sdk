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
import type { FlowRegistryBinding, FlowVersionRecord } from './flow-binding.js';
import type { LiveVersionBinding } from './live-version-binding.js';
import { PublishRefused } from './publish-refused.js';
import type { ReferenceScopeBinding } from './reference-scope.js';
import type { ToolRegistryBinding } from './tool-binding.js';

export type FlowPinsOutcome =
  | { readonly kind: 'ok'; readonly pins: FlowPins }
  | { readonly kind: 'unpinnable'; readonly issues: readonly UnpinnableRef[] };

/**
 * Where a flow version is published, so its agent pins are what a run
 * there would get: the agents' live versions for the project.
 */
export interface FlowPinsLive {
  readonly binding: LiveVersionBinding;
  readonly projectId: ProjectId;
}

/**
 * Where a flow version is published, so a sub-flow step that names no
 * version locks what a run there may run: the flows, and the project's
 * reach (`referenceScope`; absent, every version reaches, as for a
 * deployment without projects).
 */
export interface FlowPinsSubflows {
  readonly flows: FlowRegistryBinding;
  readonly referenceScope?: ReferenceScopeBinding;
  readonly projectId: ProjectId;
  /**
   * Flows the caller pins itself, later: a deploy's own flows, pinned
   * once the deploy has registered them (`implicitSubflowVersion`).
   */
  readonly deferred?: ReadonlySet<string>;
}

/**
 * Pin a flow version when it's published, to what a run would have bound
 * then, so every run of the version uses those: each tool it runs to its
 * latest active version, and each agent it runs at no named version to
 * the version a run that names none gets in the flow's project. That's
 * the agent's live version there (project, then its org, then the
 * tenant), with `live`, else its latest. A gated agent's flow runs what
 * its promotions let go live, not an unpromoted newer version. Each
 * sub-flow it runs at no named version pins to the newest version of
 * that flow a run in the project reaches (`implicitSubflowVersion`).
 *
 * A tool or agent with no published version, a sub-flow with no version
 * the project reaches, or a sub-flow step that runs the flow itself at
 * no named version makes the flow unpinnable: the caller refuses the
 * publish, naming each, rather than store a partly pinned version.
 */
export async function resolveFlowPins(
  tools: ToolRegistryBinding,
  agents: AgentRegistryBinding,
  tenantId: TenantId,
  flow: Flow,
  live: FlowPinsLive | undefined,
  subflows: FlowPinsSubflows,
): Promise<FlowPinsOutcome> {
  const refs = flowRefs(flow);
  const pinned: {
    tools: Record<string, string>;
    agents: Record<string, string>;
    flows: Record<string, string>;
  } = { tools: {}, agents: {}, flows: {} };
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
    const version = await implicitAgentVersion(agents, live, tenantId, id);
    if (version !== undefined) pinned.agents[id] = version;
    else
      issues.push({
        path: '/nodes',
        message: `agent "${id}" has no published version; publish the agent first`,
      });
  }
  for (const id of refs.flows) {
    // Its lock would be an older version of itself, never this one.
    if (id === (flow.id as unknown as string)) {
      issues.push({
        path: '/nodes',
        message: `a sub-flow step runs flow "${id}", this flow, with no version; name the version it runs`,
      });
      continue;
    }
    if (subflows.deferred?.has(id) === true) continue;
    const version = await implicitSubflowVersion(subflows, tenantId, id);
    if (version !== undefined) pinned.flows[id] = version;
    else
      issues.push({
        path: '/nodes',
        message: `flow "${id}" has no published version this project runs; publish it first`,
      });
  }
  if (issues.length > 0) return { kind: 'unpinnable', issues };
  const { flows, ...rest } = pinned;
  return { kind: 'ok', pins: Object.keys(flows).length > 0 ? pinned : rest };
}

/**
 * What refuses a flow on a server that doesn't pin (no tool or agent
 * registry): each sub-flow it runs at no named version. Only a pin would
 * fix its child's version, so the publish is refused rather than store a
 * step whose child no version names.
 */
export function unnamedSubflowIssues(flow: Flow): UnpinnableRef[] {
  return flowRefs(flow).flows.map((id) => ({
    path: '/nodes',
    message: `a sub-flow step runs flow "${id}" with no version, and this server doesn't pin one; name the version it runs`,
  }));
}

/**
 * The version a sub-flow step that names none pins to: the newest active
 * version of flow `id` that a run in the parent's project reaches, by the
 * one rule for "latest" (`latestVersion`). `undefined` when it reaches
 * none: one answer for a flow that isn't there and one the project
 * doesn't reach. It asks the scope once per version, newest first, so a
 * flow the project reaches no version of costs one question per active
 * version; fine at a flow's version counts.
 */
export async function implicitSubflowVersion(
  subflows: FlowPinsSubflows,
  tenantId: TenantId,
  id: string,
): Promise<string | undefined> {
  const { referenceScope, projectId } = subflows;
  let left = (await allFlowVersions(subflows.flows, tenantId, id as FlowId)).map((v) => v.version);
  for (let version = latestVersion(left); version !== undefined; version = latestVersion(left)) {
    const reached =
      referenceScope === undefined ||
      (await referenceScope.reachable({
        tenantId,
        fromProjectId: projectId,
        ref: { kind: 'flow', id, version },
      }));
    if (reached) return version;
    const tried = version;
    left = left.filter((v) => v !== tried);
  }
  return undefined;
}

/**
 * The version a run of agent `id` that names none gets now: its live
 * version for `live`'s project when one is pinned on the way up, else its
 * latest; `undefined` when it has no published version.
 */
async function implicitAgentVersion(
  agents: AgentRegistryBinding,
  live: FlowPinsLive | undefined,
  tenantId: TenantId,
  id: string,
): Promise<string | undefined> {
  if (live !== undefined) {
    const resolved = await live.binding.resolve({
      tenantId,
      agentId: id,
      projectId: live.projectId,
    });
    if (resolved !== null) return resolved.version as unknown as string;
  }
  const latest = await agents.get({ tenantId, agentId: id as AgentId });
  return latest === null ? undefined : (latest.version as unknown as string);
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

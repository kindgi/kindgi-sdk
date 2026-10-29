// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Agent, type AgentId, type AgentPins, pinsDigest } from '@kindgi/agents';
import type { TupleEnqueueHook } from '@kindgi/authz';
import { pickVersion } from '@kindgi/tools';
import type { Cursor, ProjectId, TenantId, ToolId } from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from './agent-binding.js';
import type { BlockRegistryBinding } from './block-binding.js';
import { type BlockPins, resolveBlockPins } from './block-pins.js';
import { type DeployedVersionOutcome, deployVersion } from './deploy-versions.js';
import type { PinnedVersionBinding } from './pinned-version-binding.js';
import { PublishRefused } from './publish-refused.js';
import type { ToolRegistryBinding } from './tool-binding.js';

/** One block reference that matched no published version. */
export interface UnpinnableRef {
  /** JSON pointer into the definition, e.g. `/tools/<i>/version`. */
  readonly path: string;
  readonly message: string;
}

export type AgentPinsOutcome =
  | { readonly kind: 'ok'; readonly pins: AgentPins }
  | { readonly kind: 'unpinnable'; readonly issues: readonly UnpinnableRef[] };

/** Page size for reading a tool's versions. */
const VERSIONS_PAGE = 200;

/**
 * Resolve an agent's tool ranges to the exact versions a version of it
 * runs (its `pins`), when the version is published.
 *
 * Each range is picked by `pickVersion` over the tool's active versions,
 * the same versions and the same rule a run resolves against, so the pin
 * is the version a run would have picked at that moment. With `toolPins`,
 * a tool pinned for the project the version is made in takes its pinned
 * version instead, when that one is in the range. A range that matches
 * nothing (the tool isn't published, or no version is in range) makes
 * the agent unpinnable: the caller refuses the publish, naming each such
 * tool, rather than store a partly pinned version.
 *
 * Its data blocks pin by `resolveBlockPins`, unless the caller resolved
 * them already (`blockPins`): a deploy does, before it writes anything,
 * since checking model settings compiles a schema.
 */
export async function resolveAgentPins(
  tools: ToolRegistryBinding,
  tenantId: TenantId,
  agent: Agent,
  blocks?: BlockRegistryBinding,
  blockPins?: BlockPins,
  toolPins?: ToolPinLookup,
): Promise<AgentPinsOutcome> {
  const pinned: Record<string, string> = {};
  const issues: UnpinnableRef[] = [];
  const versionsOf = new Map<string, readonly string[]>();
  for (const [i, ref] of agent.tools.entries()) {
    let available = versionsOf.get(ref.id);
    if (available === undefined) {
      available = await activeToolVersions(tools, tenantId, ref.id as ToolId);
      versionsOf.set(ref.id, available);
    }
    const pin = await pinnedToolVersion(toolPins, tenantId, ref.id, available);
    const pick = pickLocked(available, ref.version, pin);
    if (pick.kind === 'ok') {
      pinned[ref.id] = pick.version;
      continue;
    }
    issues.push({
      path: `/tools/${i}/version`,
      message:
        available.length === 0
          ? `tool "${ref.id}" has no published version; publish the tool first`
          : `tool "${ref.id}" has no published version in "${ref.version}" (published: ${available.join(', ')}); publish one in range first, or change the range`,
    });
  }
  // The data blocks it references, by the same rule (`resolveBlockPins`).
  const blocksPinned = blockPins ?? (await resolveBlockPins(blocks, tenantId, agent));
  issues.push(...blocksPinned.issues);
  if (issues.length > 0) return { kind: 'unpinnable', issues };
  return {
    kind: 'ok',
    pins: { tools: pinned, prompts: blocksPinned.prompts, settings: blocksPinned.settings },
  };
}

/** A range's lock: the pinned version when it's in the range, else `pickVersion`'s pick. */
function pickLocked(available: readonly string[], range: string, pin: string | undefined) {
  if (pin !== undefined) {
    const held = pickVersion([pin], range);
    if (held.kind === 'ok') return held;
  }
  return pickVersion(available, range);
}

/**
 * Where an agent or flow version is made, so each tool it runs locks to
 * the version pinned there (the project, its org, then the tenant). A
 * deploy makes one for everything it registers, so each tool's pin is
 * looked up once (`toolPinLookup`).
 */
export interface ToolPinLookup {
  readonly binding: PinnedVersionBinding;
  /** The project the version is made in: never a later environment of an order. */
  readonly projectId: ProjectId;
  /** Each tool's pinned version, by tool id, once looked up. */
  readonly looked: Map<string, Promise<string | undefined>>;
}

/** The lookup for `projectId`; none without a binding or a project, so every tool takes its newest. */
export function toolPinLookup(
  binding: PinnedVersionBinding | undefined,
  projectId: ProjectId | undefined,
): ToolPinLookup | undefined {
  return binding === undefined || projectId === undefined
    ? undefined
    : { binding, projectId, looked: new Map() };
}

/**
 * The tool's version pinned for `lookup`'s project, when a pin covers it
 * and the version is among `active`; `undefined` otherwise, and without
 * `lookup`.
 */
export async function pinnedToolVersion(
  lookup: ToolPinLookup | undefined,
  tenantId: TenantId,
  toolId: string,
  active: readonly string[],
): Promise<string | undefined> {
  if (lookup === undefined) return undefined;
  let found = lookup.looked.get(toolId);
  if (found === undefined) {
    found = lookup.binding
      .resolve({ tenantId, kind: 'tool', itemId: toolId, projectId: lookup.projectId })
      .then((pin) => (pin === null ? undefined : (pin.version as unknown as string)));
    lookup.looked.set(toolId, found);
  }
  const version = await found;
  return version !== undefined && active.includes(version) ? version : undefined;
}

/** Every active version of a tool, newest first; none when it isn't published. */
export async function activeToolVersions(
  tools: ToolRegistryBinding,
  tenantId: TenantId,
  toolId: ToolId,
): Promise<readonly string[]> {
  const versions: string[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tools.listVersions({
      tenantId,
      toolId,
      limit: VERSIONS_PAGE,
      ...(cursor !== undefined && { cursor }),
    });
    for (const manifest of page.data) versions.push(manifest.version as unknown as string);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return versions;
}

export interface PublishDeployedAgentInput {
  readonly agents: AgentRegistryBinding;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** The agent as the pack defines it, with no pins. */
  readonly agent: Agent;
  readonly pins: AgentPins;
  readonly enqueueTuples: TupleEnqueueHook;
}

/** Register a deployed agent with its pins, by the deploy rule (`deployVersion`). */
export async function publishDeployedAgent(
  input: PublishDeployedAgentInput,
): Promise<DeployedVersionOutcome> {
  const { agents, tenantId, projectId, agent, pins, enqueueTuples } = input;
  const existing = await activeAgentVersions(agents, tenantId, agent.id);
  // An agent never moves, even by a deploy that writes nothing (an
  // unchanged or reused version): one of another project is refused. A
  // registry that doesn't record the project refuses only a write.
  const held = existing[0];
  if (held !== undefined) {
    const record = await agents.getVersion({ tenantId, agentId: agent.id, version: held.version });
    if (record?.projectId !== undefined && record.projectId !== projectId) {
      throw new PublishRefused('agent', `${agent.id}@${agent.version}`, {
        kind: 'project-mismatch',
        agentId: agent.id,
        version: agent.version,
        projectId: record.projectId,
      });
    }
  }
  return deployVersion<Agent>({
    label: `agent "${agent.id as unknown as string}"`,
    definition: agent,
    pins,
    pinsDigest: pinsDigest(pins),
    existing,
    publish: async (version) => {
      const outcome = await agents.publish({ tenantId, projectId, agent: version, enqueueTuples });
      if (outcome.kind === 'ok') return 'ok';
      if (outcome.kind === 'already-registered') return 'taken';
      throw new PublishRefused('agent', `${agent.id}@${version.version}`, outcome);
    },
  });
}

/** Every active version of an agent. */
export async function activeAgentVersions(
  agents: AgentRegistryBinding,
  tenantId: TenantId,
  agentId: AgentId,
): Promise<readonly AgentVersionRecord[]> {
  const versions: AgentVersionRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await agents.listVersions({
      tenantId,
      agentId,
      limit: VERSIONS_PAGE,
      ...(cursor !== undefined && { cursor }),
    });
    versions.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return versions;
}

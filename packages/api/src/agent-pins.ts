// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  type Agent,
  type AgentDerivationReason,
  type AgentId,
  type AgentPins,
  type PinChange,
  pinChanges,
  pinsDigest,
} from '@kindgi/agents';
import type { TupleEnqueueHook } from '@kindgi/authz';
import { canonicalize } from '@kindgi/schema';
import { nextVersion, pickVersion } from '@kindgi/tools';
import type { Cursor, ProjectId, Semver, TenantId, ToolId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { ToolRegistryBinding } from './tool-binding.js';

/** One tool range that matched no published version. */
export interface UnpinnableTool {
  /** JSON pointer into the agent: `/tools/<i>/version`. */
  readonly path: string;
  readonly message: string;
}

export type AgentPinsOutcome =
  | { readonly kind: 'ok'; readonly pins: AgentPins }
  | { readonly kind: 'unpinnable'; readonly issues: readonly UnpinnableTool[] };

/** Page size for reading a tool's versions. */
const VERSIONS_PAGE = 200;

/**
 * Resolve an agent's tool ranges to the exact versions a version of it
 * runs (its `pins`), when the version is published.
 *
 * Each range is picked by `pickVersion` over the tool's active versions,
 * the same versions and the same rule a run resolves against, so the pin
 * is the version a run would have picked at that moment. A range that
 * matches nothing (the tool isn't published, or no version is in range)
 * makes the agent unpinnable: the caller refuses the publish, naming
 * each such tool, rather than store a partly pinned version.
 */
export async function resolveAgentPins(
  tools: ToolRegistryBinding,
  tenantId: TenantId,
  agent: Agent,
): Promise<AgentPinsOutcome> {
  const pinned: Record<string, string> = {};
  const issues: UnpinnableTool[] = [];
  const versionsOf = new Map<string, readonly string[]>();
  for (const [i, ref] of agent.tools.entries()) {
    let available = versionsOf.get(ref.id);
    if (available === undefined) {
      available = await activeVersions(tools, tenantId, ref.id as ToolId);
      versionsOf.set(ref.id, available);
    }
    const pick = pickVersion(available, ref.version);
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
  if (issues.length > 0) return { kind: 'unpinnable', issues };
  return { kind: 'ok', pins: { tools: pinned, prompts: {}, settings: {} } };
}

/** Every active version of a tool, newest first; none when it isn't published. */
async function activeVersions(
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

/**
 * How a deploy registered one of its agents, given the agent's pins.
 * A deploy never keeps a version's old pins and never refuses a
 * routine deploy:
 *
 * - `registered`: the definition's version was free, and is now
 *   registered with these pins;
 * - `unchanged`: it's registered with the same definition and pins;
 * - `reused`: an earlier deploy already registered this definition and
 *   these pins under another number (`version`), so a redeploy changes
 *   nothing;
 * - `renumbered`: the definition's version is registered with other
 *   pins or other content, and versions never change, so this deploy
 *   registered the next free version in its line (`nextVersion`).
 */
export type DeployedAgentOutcome =
  | { readonly kind: 'registered' | 'unchanged'; readonly version: string }
  | {
      readonly kind: 'reused' | 'renumbered';
      readonly version: string;
      readonly reason: AgentDerivationReason;
      readonly pinChanges?: readonly PinChange[];
    };

export interface PublishDeployedAgentInput {
  readonly agents: AgentRegistryBinding;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** The agent as the pack defines it, with no pins. */
  readonly agent: Agent;
  readonly pins: AgentPins;
  readonly enqueueTuples: TupleEnqueueHook;
}

/** How many versions after the definition's a deploy tries before it gives up. */
const MAX_RENUMBER = 100;

/** Register a deployed agent with its pins (see `DeployedAgentOutcome`). */
export async function publishDeployedAgent(
  input: PublishDeployedAgentInput,
): Promise<DeployedAgentOutcome> {
  const { agents, tenantId, agent, pins } = input;
  const digest = pinsDigest(pins);
  const authored = agent.version as unknown as string;
  const existing = await allVersions(agents, tenantId, agent.id);
  const definition = definitionKey(agent);
  const same = (v: Agent) => definitionKey(v) === definition && v.pinsDigest === digest;

  const atAuthored = existing.find((v) => (v.version as unknown as string) === authored);
  if (atAuthored !== undefined && same(atAuthored)) return { kind: 'unchanged', version: authored };
  if (atAuthored === undefined) {
    const outcome = await agents.publish({
      ...input,
      agent: { ...agent, pins, pinsDigest: digest },
    });
    if (outcome.kind === 'ok') return { kind: 'registered', version: authored };
    // A deploy has always left a project it can't publish into as it is.
    if (outcome.kind === 'project-not-found') return { kind: 'unchanged', version: authored };
    // `already-registered` with no active version: an unregistered
    // version holds the number. Register the next one.
  }

  const reason = derivationReason(atAuthored, definition);
  const changes =
    reason === 'pins-changed' ? { pinChanges: pinChanges(atAuthored?.pins, pins) } : {};
  const earlier = existing.find(same);
  if (earlier !== undefined) {
    return {
      kind: 'reused',
      version: earlier.version as unknown as string,
      reason: earlier.derivedFrom?.reason ?? reason,
      ...changes,
    };
  }
  const taken = new Set(existing.map((v) => v.version as unknown as string));
  const version = await registerNextFree(input, digest, reason, taken);
  return version === undefined
    ? { kind: 'unchanged', version: authored }
    : { kind: 'renumbered', version, reason, ...changes };
}

/** Why the definition's version can't be registered as it is. */
function derivationReason(
  atAuthored: Agent | undefined,
  definition: string,
): AgentDerivationReason {
  if (atAuthored === undefined || definitionKey(atAuthored) !== definition) return 'version-taken';
  return atAuthored.pins === undefined ? 'unpinned' : 'pins-changed';
}

/**
 * Register the agent with its pins under the first free version after
 * its definition's (`nextVersion`), recording where it came from.
 * `undefined` when its project is gone (left as it is, as always).
 */
async function registerNextFree(
  input: PublishDeployedAgentInput,
  digest: string,
  reason: AgentDerivationReason,
  taken: ReadonlySet<string>,
): Promise<string | undefined> {
  const { agent, pins } = input;
  const authored = agent.version as unknown as string;
  let candidate = nextVersion(authored);
  for (let tries = 0; candidate !== undefined && tries < MAX_RENUMBER; tries++) {
    if (!taken.has(candidate)) {
      const outcome = await input.agents.publish({
        ...input,
        agent: {
          ...agent,
          version: candidate as unknown as Semver,
          pins,
          pinsDigest: digest,
          derivedFrom: { version: authored, reason },
        },
      });
      if (outcome.kind === 'ok') return candidate;
      if (outcome.kind === 'project-not-found') return undefined;
      // `already-registered`: an unregistered version holds this one too.
    }
    candidate = nextVersion(candidate);
  }
  throw new Error(
    `agent "${agent.id as unknown as string}": no free version after ${authored} to register its new pins under`,
  );
}

/** An agent's definition: everything but its version and what the runtime sets. */
function definitionKey(agent: Agent): string {
  const { version: _v, pins: _p, pinsDigest: _d, derivedFrom: _f, ...definition } = agent;
  return canonicalize(definition);
}

/** Every active version of an agent. */
async function allVersions(
  agents: AgentRegistryBinding,
  tenantId: TenantId,
  agentId: AgentId,
): Promise<readonly Agent[]> {
  const versions: Agent[] = [];
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

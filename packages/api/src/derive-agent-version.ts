// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  type Agent,
  type AgentId,
  type AgentPins,
  MODEL_SETTINGS_SCHEMA,
  pinsDigest,
  settingsSchemaIssues,
} from '@kindgi/agents';
import type { TupleEnqueueHook } from '@kindgi/authz';
import { latestVersion, nextVersion } from '@kindgi/tools';
import type { ProjectId, Semver, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from './agent-binding.js';
import { activeAgentVersions } from './agent-pins.js';
import type { BlockRegistryBinding } from './block-binding.js';
import { definitionKey } from './deploy-versions.js';

/** Which data-block pins to swap, by kind then block id → exact version. */
export interface PinSwaps {
  readonly prompts?: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, string>>;
}

export interface DeriveAgentVersionInput {
  readonly agents: AgentRegistryBinding;
  readonly blocks: BlockRegistryBinding | undefined;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  /** The version to derive from: it must be pinned. */
  readonly from: string;
  readonly swaps: PinSwaps;
  /** A short label for the new version. */
  readonly label?: string;
  /** Who derived it (`user:<id>`). */
  readonly by?: string;
  /** The project, when the store doesn't record one on the version. */
  readonly projectId?: ProjectId;
  /** The authorization tuples for the new version, in the project it lands in. */
  readonly tuplesFor: (projectId: ProjectId) => TupleEnqueueHook;
}

export interface SwapIssue {
  readonly path: string;
  readonly message: string;
}

export type DeriveAgentVersionOutcome =
  | { readonly kind: 'ok'; readonly agent: Agent }
  /** An active version already has this definition and these pins: that one, unchanged. */
  | { readonly kind: 'reused'; readonly agent: Agent }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unpinned' }
  | { readonly kind: 'invalid'; readonly issues: readonly SwapIssue[] }
  | { readonly kind: 'no-project' }
  | { readonly kind: 'project-not-found'; readonly projectId: ProjectId };

/** How many numbers after the highest a derive tries before it gives up. */
const MAX_TRIES = 100;

/**
 * Derive a new agent version from a pinned one with some data-block
 * pins swapped: an expert's edit (a new prompt or settings version)
 * reaching an agent without a code change. The new version is the old
 * one's bag with those pins swapped (`derivedFrom: { version, reason:
 * 'edited', label, by }`), numbered the next free patch after the
 * agent's highest version (versions never change). If an active version
 * already holds that definition and those pins (the same swap derived
 * before, or a deploy that registered it), that version is returned
 * unchanged (`reused`) rather than a duplicate.
 *
 * Only data-block pins swap: a swap must name a block the version
 * already references (adding one is a code change), at a published,
 * active version of the right kind (and, for the model-settings block,
 * model settings). Tool pins come from code.
 */
export async function deriveAgentVersion(
  input: DeriveAgentVersionInput,
): Promise<DeriveAgentVersionOutcome> {
  const { agents, tenantId, agentId } = input;
  const from = await agents.getVersion({ tenantId, agentId, version: input.from as Semver });
  if (from === null) return { kind: 'not-found' };
  if (from.pins === undefined) return { kind: 'unpinned' };

  const issues = await swapIssues(input, from, from.pins);
  if (issues.length > 0) return { kind: 'invalid', issues };
  const pins: AgentPins = {
    tools: from.pins.tools,
    prompts: { ...from.pins.prompts, ...(input.swaps.prompts ?? {}) },
    settings: { ...from.pins.settings, ...(input.swaps.settings ?? {}) },
  };
  const digest = pinsDigest(pins);
  if (digest === from.pinsDigest) {
    return { kind: 'invalid', issues: [{ path: '/pins', message: 'no pin changes' }] };
  }

  const projectId = from.projectId ?? input.projectId;
  if (projectId === undefined) return { kind: 'no-project' };
  const { unregisteredAt: _u, projectId: _p, derivedFrom: _d, ...definition } = from;
  return publishNextFree(input, projectId, {
    ...definition,
    pins,
    pinsDigest: digest,
    derivedFrom: {
      version: from.version,
      reason: 'edited',
      ...(input.label !== undefined && { label: input.label }),
      ...(input.by !== undefined && { by: input.by }),
    },
  });
}

/** Publish the derived version under the first free patch after the agent's highest. */
async function publishNextFree(
  input: DeriveAgentVersionInput,
  projectId: ProjectId,
  derived: Agent,
): Promise<DeriveAgentVersionOutcome> {
  const { agents, tenantId, agentId } = input;
  const active = await activeAgentVersions(agents, tenantId, agentId);
  // The same swap again (or a deploy that registered it) finds the
  // version that already holds it: versions are never duplicated.
  const key = definitionKey(derived);
  const same = active.find((a) => a.pinsDigest === derived.pinsDigest && definitionKey(a) === key);
  if (same !== undefined) return { kind: 'reused', agent: same };
  const highest =
    latestVersion(active.map((a) => a.version as unknown as string)) ??
    (derived.version as unknown as string);
  let candidate = nextVersion(highest);
  for (let tries = 0; candidate !== undefined && tries < MAX_TRIES; tries++) {
    const agent: Agent = { ...derived, version: candidate as Semver };
    const outcome = await agents.publish({
      tenantId,
      projectId,
      agent,
      enqueueTuples: input.tuplesFor(projectId),
    });
    if (outcome.kind === 'ok') return { kind: 'ok', agent };
    if (outcome.kind === 'project-not-found') return { kind: 'project-not-found', projectId };
    candidate = nextVersion(candidate);
  }
  throw new Error(`agent "${agentId as unknown as string}": no free version after ${highest}`);
}

/** What's wrong with the swaps, against the version's references and the block store. */
async function swapIssues(
  input: DeriveAgentVersionInput,
  from: AgentVersionRecord,
  pins: AgentPins,
): Promise<SwapIssue[]> {
  const issues: SwapIssue[] = [];
  const swaps = [
    ...Object.entries(input.swaps.prompts ?? {}).map(([id, v]) => ['prompts', id, v] as const),
    ...Object.entries(input.swaps.settings ?? {}).map(([id, v]) => ['settings', id, v] as const),
  ];
  if (swaps.length === 0)
    return [{ path: '/pins', message: 'name at least one prompt or settings pin to swap' }];
  for (const [kind, id, version] of swaps) {
    const path = `/pins/${kind}/${id}`;
    if (pins[kind][id] === undefined) {
      issues.push({
        path,
        message: `agent version ${from.version} doesn't reference ${kind === 'prompts' ? 'prompt' : 'settings'} block "${id}"; adding a block is a code change`,
      });
      continue;
    }
    const problem = await blockProblem(input, from, kind, id, version);
    if (problem !== undefined) issues.push({ path, message: problem });
  }
  return issues;
}

async function blockProblem(
  input: DeriveAgentVersionInput,
  from: AgentVersionRecord,
  kind: 'prompts' | 'settings',
  id: string,
  version: string,
): Promise<string | undefined> {
  if (input.blocks === undefined) return 'this runtime serves no data blocks';
  const block = await input.blocks.getVersion({ tenantId: input.tenantId, blockId: id, version });
  const what = `block "${id}" version ${version}`;
  if (block === null) return `${what} isn't published`;
  if (block.unregisteredAt !== undefined) return `${what} is unregistered`;
  const wanted = kind === 'prompts' ? 'prompt' : 'settings';
  if (block.kind !== wanted) return `${what} is a ${block.kind} block, not ${wanted}`;
  if (block.kind === 'settings' && from.modelSettings?.id === id) {
    const issues = settingsSchemaIssues(block.content.values, MODEL_SETTINGS_SCHEMA);
    if (issues.length > 0) {
      return `${what} isn't model settings: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`;
    }
  }
  return undefined;
}

/**
 * The first version after `after` that no version of the agent holds,
 * active or unregistered (versions never change): what a refused
 * publish of a taken number suggests, by the deploy rule's numbering.
 * `undefined` when none is free within the tries.
 */
export async function nextFreeAgentVersion(
  agents: AgentRegistryBinding,
  tenantId: TenantId,
  agentId: AgentId,
  after: string,
): Promise<string | undefined> {
  let candidate = nextVersion(after);
  for (let tries = 0; candidate !== undefined && tries < MAX_TRIES; tries++) {
    const held = await agents.getVersion({ tenantId, agentId, version: candidate as Semver });
    if (held === null) return candidate;
    candidate = nextVersion(candidate);
  }
  return undefined;
}

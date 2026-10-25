// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Agent, modelNamedTwice, modelSettingsIssues } from '@kindgi/agents';
import { pickVersion } from '@kindgi/tools';
import type { Cursor, TenantId } from '@kindgi/types';

import type { UnpinnableRef } from './agent-pins.js';
import type { BlockRegistryBinding } from './block-binding.js';

/** The data-block versions an agent version pins, and the references that matched none. */
export interface BlockPins {
  readonly prompts: Readonly<Record<string, string>>;
  readonly settings: Readonly<Record<string, string>>;
  readonly issues: readonly UnpinnableRef[];
}

export interface Ref {
  readonly path: string;
  readonly id: string;
  readonly range: string;
  readonly role: 'prompt' | 'settings' | 'model-settings';
}

/** The registry reads pinning needs: a deploy adds its pack's new versions (`withPackVersions`). */
export type BlockVersionReads = Pick<BlockRegistryBinding, 'listVersions' | 'getVersion'>;

/** Page size for reading a block's versions. */
const VERSIONS_PAGE = 200;

/**
 * Pin the data blocks an agent references (its prompt block, settings
 * blocks and model-settings block) when a version of it is published:
 * each range resolves by `pickVersion` over the block's active versions,
 * as a turn of an unpinned agent would. A block a deploy's pack brings
 * (`pack`: its id and version) pins the pack's version only, as the
 * pack's files are the agent: a newer version published on the runtime
 * isn't picked. A reference that matches no published version (or not
 * the pack's), names a block of the other kind, or names model settings
 * that aren't (`MODEL_SETTINGS_SCHEMA`), or that name the model the
 * agent names too (`modelNamedTwice`), is an issue: the caller refuses
 * the publish. So is any reference on a runtime with no block registry.
 */
export async function resolveBlockPins(
  blocks: BlockVersionReads | undefined,
  tenantId: TenantId,
  agent: Agent,
  pack?: ReadonlyMap<string, string>,
): Promise<BlockPins> {
  const prompts: Record<string, string> = {};
  const settings: Record<string, string> = {};
  const issues: UnpinnableRef[] = [];
  for (const ref of blockRefs(agent)) {
    if (blocks === undefined) {
      issues.push({
        path: ref.path,
        message: `${describe(ref)}: this runtime serves no data blocks`,
      });
      continue;
    }
    const packVersion = pack?.get(ref.id);
    const available =
      packVersion !== undefined
        ? [packVersion]
        : await activeBlockVersions(blocks, tenantId, ref.id);
    const pick = pickVersion(available, ref.range);
    if (pick.kind !== 'ok') {
      issues.push({ path: ref.path, message: missed(ref, available, packVersion) });
      continue;
    }
    const block = await blocks.getVersion({ tenantId, blockId: ref.id, version: pick.version });
    const problem =
      block === null
        ? `${describe(ref)} version ${pick.version} can't be read`
        : misfit(ref, block, agent);
    if (problem !== undefined) {
      issues.push({ path: ref.path, message: problem });
      continue;
    }
    (ref.role === 'prompt' ? prompts : settings)[ref.id] = pick.version;
  }
  return { prompts, settings, issues };
}

/** Each data block an agent references, at its path. */
export function blockRefs(agent: Agent): Ref[] {
  const refs: Ref[] = [];
  if (typeof agent.instructions === 'object') {
    refs.push({
      path: '/instructions/version',
      id: agent.instructions.prompt,
      range: agent.instructions.version,
      role: 'prompt',
    });
  }
  for (const [i, s] of (agent.settings ?? []).entries()) {
    refs.push({ path: `/settings/${i}/version`, id: s.id, range: s.version, role: 'settings' });
  }
  if (agent.modelSettings !== undefined) {
    refs.push({
      path: '/modelSettings/version',
      id: agent.modelSettings.id,
      range: agent.modelSettings.version,
      role: 'model-settings',
    });
  }
  return refs;
}

/** Why no version can serve a reference: none the runtime holds in range, or not the pack's. */
function missed(ref: Ref, available: readonly string[], packVersion: string | undefined): string {
  if (packVersion !== undefined) {
    return `${describe(ref)}: the pack brings version ${packVersion}, which "${ref.range}" doesn't take; change the agent's range or the block's version`;
  }
  return available.length === 0
    ? `${describe(ref)} has no published version; publish the block first`
    : `${describe(ref)} has no published version in "${ref.range}" (published: ${available.join(', ')})`;
}

/** Why a block version can't serve its reference; undefined when it can. */
function misfit(
  ref: Ref,
  block: { readonly kind: string; readonly version: string; readonly content: unknown },
  agent: Agent,
): string | undefined {
  const wanted = ref.role === 'prompt' ? 'prompt' : 'settings';
  if (block.kind !== wanted) return `${describe(ref)} is a ${block.kind} block`;
  if (ref.role !== 'model-settings') return undefined;
  const values = (block.content as { readonly values?: unknown }).values;
  const issues = modelSettingsIssues(values);
  if (issues.length > 0) {
    return `${describe(ref)} version ${block.version} isn't model settings: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`;
  }
  const twice = modelNamedTwice(agent, values);
  return twice === undefined ? undefined : `${describe(ref)} version ${block.version}: ${twice}`;
}

function describe(ref: Ref): string {
  const what =
    ref.role === 'prompt'
      ? 'prompt'
      : ref.role === 'model-settings'
        ? 'model-settings'
        : 'settings';
  return `${what} block "${ref.id}"`;
}

/** Every active version of a block, newest published first. */
async function activeBlockVersions(
  blocks: BlockVersionReads,
  tenantId: TenantId,
  blockId: string,
): Promise<readonly string[]> {
  const versions: string[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await blocks.listVersions({
      tenantId,
      blockId,
      limit: VERSIONS_PAGE,
      ...(cursor !== undefined && { cursor }),
    });
    versions.push(...page.data.map((b) => b.version));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return versions;
}

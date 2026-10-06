// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { pickVersion } from '@kindgi/tools';

import {
  type BlockDefinition,
  MODEL_SETTINGS_SCHEMA,
  type ModelSettings,
  type PromptBlockContent,
  settingsSchemaIssues,
} from '../blocks.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/** The block versions a turn runs, by kind then id, as `setup` journals them. */
export interface PinnedBlockVersions {
  readonly prompts: Readonly<Record<string, string>>;
  readonly settings: Readonly<Record<string, string>>;
}

/** The data blocks a turn runs with, loaded at its version. */
export interface TurnBlocks {
  /** The prompt block the instructions come from. */
  readonly prompt?: {
    readonly id: string;
    readonly version: string;
    readonly content: PromptBlockContent;
  };
  /** Each settings block's values, by block id (`ToolContext.settings`, `settings` in templates). */
  readonly settings: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The model-settings block's values, for the turn's model calls. */
  readonly modelSettings?: ModelSettings;
  readonly versions: PinnedBlockVersions;
}

interface Ref {
  readonly kind: 'prompts' | 'settings';
  readonly id: string;
  readonly range: string;
  readonly role: 'prompt' | 'settings' | 'model-settings';
}

/**
 * Load the data blocks the agent references, each at one exact version:
 * the resumed turn's own (`pinned`, from its `setup`), else the agent
 * version's pin (`agent.pins`), else its range resolved now by
 * `pickVersion` (an agent version published before pins). A pinned
 * version that's unregistered still loads; one that's gone, a range
 * nothing satisfies, or a runtime with no blocks fails the turn
 * (`block-unresolvable`). `undefined` when the agent references none.
 */
export async function resolveTurnBlocks(
  ctx: TurnContext,
  pinned?: PinnedBlockVersions,
): Promise<TurnBlocks | undefined> {
  const agent = ctx.input.agent;
  const refs = blockRefs(ctx);
  if (refs.length === 0) return undefined;
  const reader = ctx.bindings.blockReader;
  if (reader === undefined) {
    fail(
      refs[0] as Ref,
      `agent "${agent.id}" references data blocks, but this runtime serves none`,
    );
  }

  const versions = {
    prompts: {} as Record<string, string>,
    settings: {} as Record<string, string>,
  };
  const loaded = new Map<Ref, BlockDefinition>();
  for (const ref of refs) {
    const version =
      pinned?.[ref.kind][ref.id] ??
      agent.pins?.[ref.kind][ref.id] ??
      (await resolveRange(ctx, ref));
    const block = await reader.getVersion({
      tenantId: ctx.input.tenantId,
      blockId: ref.id,
      version,
    });
    if (block === null) {
      fail(ref, `${describe(ref)} runs version ${version}, which isn't published`);
    }
    if (block.kind !== (ref.role === 'prompt' ? 'prompt' : 'settings')) {
      fail(ref, `${describe(ref)} is a ${block.kind} block`);
    }
    versions[ref.kind][ref.id] = version;
    loaded.set(ref, block);
  }
  return turnBlocks(refs, loaded, versions);
}

function blockRefs(ctx: TurnContext): Ref[] {
  const agent = ctx.input.agent;
  const refs: Ref[] = [];
  if (typeof agent.instructions === 'object') {
    refs.push({
      kind: 'prompts',
      id: agent.instructions.prompt,
      range: agent.instructions.version,
      role: 'prompt',
    });
  }
  for (const s of agent.settings ?? []) {
    refs.push({ kind: 'settings', id: s.id, range: s.version, role: 'settings' });
  }
  if (agent.modelSettings !== undefined) {
    refs.push({
      kind: 'settings',
      id: agent.modelSettings.id,
      range: agent.modelSettings.version,
      role: 'model-settings',
    });
  }
  return refs;
}

/** An unpinned reference's range, resolved over the block's active versions. */
async function resolveRange(ctx: TurnContext, ref: Ref): Promise<string> {
  const available =
    (await ctx.bindings.blockReader?.activeVersions({
      tenantId: ctx.input.tenantId,
      blockId: ref.id,
    })) ?? [];
  const pick = pickVersion(available, ref.range);
  if (pick.kind === 'ok') return pick.version;
  return fail(
    ref,
    available.length === 0
      ? `${describe(ref)} has no published version`
      : `${describe(ref)} has no published version in "${ref.range}" (published: ${available.join(', ')})`,
  );
}

function turnBlocks(
  refs: readonly Ref[],
  loaded: ReadonlyMap<Ref, BlockDefinition>,
  versions: PinnedBlockVersions,
): TurnBlocks {
  const settings: Record<string, Readonly<Record<string, unknown>>> = {};
  let prompt: TurnBlocks['prompt'];
  let modelSettings: ModelSettings | undefined;
  for (const ref of refs) {
    const block = loaded.get(ref) as BlockDefinition;
    if (block.kind === 'prompt') {
      prompt = { id: block.id, version: block.version, content: block.content };
    } else if (ref.role === 'model-settings') {
      const issues = settingsSchemaIssues(block.content.values, MODEL_SETTINGS_SCHEMA);
      if (issues.length > 0) {
        fail(
          ref,
          `${describe(ref)} version ${block.version} isn't model settings: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
        );
      }
      modelSettings = block.content.values as ModelSettings;
    } else {
      settings[block.id] = block.content.values;
    }
  }
  return {
    ...(prompt !== undefined && { prompt }),
    settings,
    ...(modelSettings !== undefined && { modelSettings }),
    versions,
  };
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

function fail(ref: Ref, message: string): never {
  return throwAgentTurnFailure({
    code: 'block-unresolvable',
    message,
    blockId: ref.id,
    requestedRange: ref.range,
  });
}

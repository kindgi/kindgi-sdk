// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The data blocks a deploy's pack brings (the image index's `blocks`,
 * read from the pack's `blocks/` folder at build), published as
 * `POST /v1/blocks` publishes a version, into the deploy's project:
 *
 * - Before the first write, each is checked against the registry
 *   (`planPackBlocks`). A version the registry doesn't hold is new, and
 *   must follow the block's latest (`continuityIssues`). One it holds
 *   with the same content is kept. One it holds with other content is
 *   refused: a version never changes. One it holds unregistered is
 *   refused too, naming the command that reinstates it: the registry
 *   doesn't record who unregistered it, a person or a deploy that failed
 *   after publishing it (which rolls back what it published), so the
 *   deploy never reinstates one itself.
 * - An agent's reference to a block the pack brings pins the pack's
 *   version, and is refused when its range doesn't take it
 *   (`resolveBlockPins`). Its other ranges pin over the registry's
 *   versions and the pack's new ones (`withPackVersions`): the newest in
 *   range, as before.
 * - In the write phase, each is published (`publishPackBlocks`) before
 *   anything else, a new one with an unregister to roll it back. The
 *   registry answers a block whose versions live in another project
 *   `project-mismatch` before it looks at the version, so a kept one is
 *   refused there too, as an unchanged tool is.
 */

import type { BlockDefinition } from '@kindgi/agents';
import type { ProjectId, TenantId } from '@kindgi/types';

import type { BlockRecord, BlockRegistryBinding } from './block-binding.js';
import { type BlockPublishIssue, continuityIssues, withCarriedSchema } from './block-publish.js';
import { canonical } from './corrected-items.js';
import { PublishRefused } from './publish-refused.js';
import type { RollbackAction } from './routes/deployments.js';

/** A pack's block as the deploy publishes it, and whether the registry holds it already. */
export interface PlannedBlock {
  /** As published: a settings version without a schema keeps the latest's (`withCarriedSchema`). */
  readonly block: BlockDefinition;
  /** The registry doesn't hold this version yet. */
  readonly isNew: boolean;
}

/** A block issue at its place in the index's `blocks`. */
export interface PackBlockIssue extends BlockPublishIssue {
  readonly index: number;
  readonly id: string;
}

export type PackBlocksPlan =
  | { readonly kind: 'ok'; readonly planned: readonly PlannedBlock[] }
  | { readonly kind: 'invalid'; readonly issues: readonly PackBlockIssue[] }
  | { readonly kind: 'refused'; readonly refusal: PublishRefused };

/** Each of the pack's blocks against the registry, before the deploy writes anything. */
export async function planPackBlocks(
  blocks: BlockRegistryBinding,
  tenantId: TenantId,
  pack: readonly BlockDefinition[],
): Promise<PackBlocksPlan> {
  const planned: PlannedBlock[] = [];
  const issues: PackBlockIssue[] = [];
  const unregistered: BlockDefinition[] = [];
  for (const [index, block] of pack.entries()) {
    const stored = await blocks.getVersion({ tenantId, blockId: block.id, version: block.version });
    if (stored !== null) {
      if (stored.unregisteredAt !== undefined) {
        unregistered.push(block);
        continue;
      }
      const reason = whyNotKept(stored, block);
      if (reason !== undefined) return { kind: 'refused', refusal: refusedVersion(block, reason) };
      planned.push({ block, isNew: false });
      continue;
    }
    const latest = await blocks.get({ tenantId, blockId: block.id });
    const continuity = continuityIssues(latest, block);
    if (continuity.length > 0) {
      issues.push(...continuity.map((issue) => ({ index, id: block.id, ...issue })));
      continue;
    }
    planned.push({ block: withCarriedSchema(latest, block), isNew: true });
  }
  if (issues.length > 0) return { kind: 'invalid', issues };
  const [first, ...more] = unregistered;
  return first === undefined
    ? { kind: 'ok', planned }
    : { kind: 'refused', refusal: refusedVersion(first, whyUnregistered(first, more)) };
}

/**
 * The registry's versions of each block, with the pack's new ones as
 * though published into `projectId`: what the deploy's agents pin over
 * before the pack's blocks are written (`resolveBlockPins`).
 */
export function withPackVersions(
  blocks: BlockRegistryBinding,
  projectId: ProjectId,
  planned: readonly PlannedBlock[],
): Pick<BlockRegistryBinding, 'listVersions' | 'getVersion'> {
  const publishedAt = new Date().toISOString();
  const fresh: BlockRecord[] = planned
    .filter((p) => p.isNew)
    .map((p) => ({ ...p.block, projectId, publishedAt }));
  return {
    async listVersions(input) {
      const page = await blocks.listVersions(input);
      const pack = fresh.filter((b) => b.id === input.blockId);
      // Newest published first: the pack's, on the first page.
      return input.cursor !== undefined || pack.length === 0
        ? page
        : { ...page, data: [...pack, ...page.data] };
    },
    async getVersion(input) {
      const pack = fresh.find((b) => b.id === input.blockId && b.version === input.version);
      return pack ?? blocks.getVersion(input);
    },
  };
}

/**
 * Publish the pack's blocks into the deploy's project, each new one with
 * an unregister in `rolled`. Throws `PublishRefused` for one the registry
 * refuses, or one whose version was published with other content since
 * it was checked.
 */
export async function publishPackBlocks(input: {
  readonly blocks: BlockRegistryBinding;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly planned: readonly PlannedBlock[];
  readonly rolled: RollbackAction[];
}): Promise<void> {
  const { blocks, tenantId, projectId } = input;
  for (const { block, isNew } of input.planned) {
    const outcome = await blocks.publish({ tenantId, projectId, block });
    if (outcome.kind === 'ok') {
      input.rolled.push({
        primitive: 'block',
        id: `${block.id}@${block.version}`,
        undo: 'unregister',
        run: async () => {
          await blocks.unregister({ tenantId, blockId: block.id, version: block.version });
        },
      });
    } else if (outcome.kind === 'already-registered') {
      if (!isNew) continue;
      const stored = await blocks.getVersion({
        tenantId,
        blockId: block.id,
        version: block.version,
      });
      const reason =
        stored === null
          ? `version ${block.version} was taken meanwhile`
          : whyNotKept(stored, block);
      if (reason !== undefined) throw refusedVersion(block, reason);
    } else {
      throw new PublishRefused('block', `${block.id}@${block.version}`, outcome);
    }
  }
}

/** Why the pack's block can't keep the version the registry holds under its number; `undefined` when it can. */
function whyNotKept(stored: BlockRecord, block: BlockDefinition): string | undefined {
  if (stored.unregisteredAt !== undefined) return whyUnregistered(block, []);
  return sameDefinition(stored, block)
    ? undefined
    : `version ${block.version} is already published with other content; a version never changes, so give the pack's block a new version`;
}

/**
 * The pack's blocks whose versions the registry holds unregistered, each
 * with the command that reinstates it (`first`'s is the refusal's id).
 */
function whyUnregistered(first: BlockDefinition, more: readonly BlockDefinition[]): string {
  const reinstate = [first, ...more]
    .map((b) => `\`kindgi blocks reinstate ${b.id} --block-version=${b.version}\``)
    .join(', ');
  if (more.length === 0) {
    return `version ${first.version} is unregistered (by hand, or by a deploy that failed after publishing it): reinstate it (${reinstate}), or give the pack's block a new version`;
  }
  const others = more.map((b) => `${b.id}@${b.version}`).join(', ');
  return `version ${first.version} is unregistered, and so ${more.length === 1 ? 'is' : 'are'} ${others} (by hand, or by a deploy that failed after publishing them): reinstate each (${reinstate}), or give the pack's blocks new versions`;
}

/**
 * The stored version is the pack's block: the same kind, description
 * and content. A settings block that gives no schema keeps the one its
 * version was stored with, whichever it is (`withCarriedSchema`).
 */
function sameDefinition(stored: BlockRecord, block: BlockDefinition): boolean {
  const content =
    stored.kind === 'settings' && block.kind === 'settings' && block.content.schema === undefined
      ? { ...stored.content, schema: undefined }
      : stored.content;
  return (
    stored.kind === block.kind &&
    stored.description === block.description &&
    canonical(content) === canonical(block.content)
  );
}

function refusedVersion(block: BlockDefinition, reason: string): PublishRefused {
  return new PublishRefused('block', `${block.id}@${block.version}`, {
    code: 'block-already-registered',
    reason,
  });
}

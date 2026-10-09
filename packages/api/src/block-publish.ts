// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type BlockDefinition, settingsSchemaIssues, validateBlock } from '@kindgi/agents';
import { latestVersion, nextVersion } from '@kindgi/tools';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type { BlockRecord, BlockRegistryBinding } from './block-binding.js';

/** One thing wrong with a block version, as `validation-failed` lists them. */
export interface BlockPublishIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * A new version against the block's latest: the same kind, and a
 * settings version without a schema of its own satisfies the schema it
 * keeps (`carriedSchema`).
 */
export function continuityIssues(
  latest: BlockRecord | null,
  block: BlockDefinition,
): BlockPublishIssue[] {
  if (latest === null) return [];
  if (latest.kind !== block.kind) {
    return [
      {
        path: '/kind',
        message: `block "${block.id}" is a ${latest.kind} block; a version can't change its kind`,
      },
    ];
  }
  const carried = carriedSchema(latest, block);
  if (block.kind !== 'settings' || carried === undefined) return [];
  return settingsSchemaIssues(block.content.values, carried).map((i) => ({
    ...i,
    message: `${i.message} (the schema of version ${latest.version})`,
  }));
}

/**
 * The schema a settings version that gives none keeps: the latest
 * version's. A version that gives a schema replaces it (`{}` drops the
 * check on purpose).
 */
function carriedSchema(
  latest: BlockRecord | null,
  block: BlockDefinition,
): Readonly<Record<string, unknown>> | undefined {
  if (latest?.kind !== 'settings' || block.kind !== 'settings') return undefined;
  return block.content.schema === undefined ? latest.content.schema : undefined;
}

/** The version as stored: with the schema it keeps, if any. */
export function withCarriedSchema(
  latest: BlockRecord | null,
  block: BlockDefinition,
): BlockDefinition {
  const schema = carriedSchema(latest, block);
  if (schema === undefined || block.kind !== 'settings') return block;
  return { ...block, content: { ...block.content, schema } };
}

/** New content for a block: settings values, or a prompt template. */
export type BlockEdit =
  | { readonly kind: 'settings'; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'prompt'; readonly template: string };

export interface PublishBlockEditInput {
  readonly blocks: BlockRegistryBinding;
  readonly tenantId: TenantId;
  /** The version the edit starts from: its schema or parameters and description carry over. */
  readonly from: BlockRecord;
  readonly edit: BlockEdit;
}

export type PublishBlockEditOutcome =
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'invalid'; readonly issues: readonly BlockPublishIssue[] };

/** How many numbers after the highest a publish tries before it gives up. */
const MAX_TRIES = 100;

/** The block version an edit would publish, numbered `version`; issues when it isn't valid. */
export async function blockEditDefinition(
  input: PublishBlockEditInput,
  version: string,
): Promise<
  | { readonly kind: 'ok'; readonly block: BlockDefinition; readonly latest: BlockRecord | null }
  | { readonly kind: 'invalid'; readonly issues: readonly BlockPublishIssue[] }
> {
  const { from, edit } = input;
  if (from.kind !== edit.kind) {
    return {
      kind: 'invalid',
      issues: [
        { path: '/kind', message: `block "${from.id}" is a ${from.kind} block, not ${edit.kind}` },
      ],
    };
  }
  const content =
    from.kind === 'settings' && edit.kind === 'settings'
      ? {
          values: edit.values,
          ...(from.content.schema !== undefined && { schema: from.content.schema }),
        }
      : from.kind === 'prompt' && edit.kind === 'prompt'
        ? {
            template: edit.template,
            ...(from.content.parameters !== undefined && { parameters: from.content.parameters }),
          }
        : undefined;
  const validated = validateBlock({
    id: from.id,
    version,
    kind: from.kind,
    ...(from.description !== undefined && { description: from.description }),
    content,
  });
  if (validated.kind === 'err') return { kind: 'invalid', issues: validated.error.issues };
  const latest = await input.blocks.get({ tenantId: input.tenantId, blockId: from.id });
  const continuity = continuityIssues(latest, validated.value);
  if (continuity.length > 0) return { kind: 'invalid', issues: continuity };
  return { kind: 'ok', block: validated.value, latest };
}

/**
 * Publish an edit of a block as its next free version (the first patch
 * after its highest, unregistered versions included, since versions
 * never change), into the block's own project. The edit is checked as
 * `POST /v1/blocks` checks a version: it must be a valid block of the
 * same kind, and settings values must satisfy the schema they keep.
 */
export async function publishBlockEdit(
  input: PublishBlockEditInput,
): Promise<PublishBlockEditOutcome> {
  const { blocks, tenantId, from } = input;
  const versions = await allVersions(blocks, tenantId, from.id);
  const highest = latestVersion(versions) ?? from.version;
  let candidate = nextVersion(highest);
  for (let tries = 0; candidate !== undefined && tries < MAX_TRIES; tries++) {
    const checked = await blockEditDefinition(input, candidate);
    if (checked.kind === 'invalid') return checked;
    const outcome = await blocks.publish({
      tenantId,
      projectId: from.projectId,
      block: withCarriedSchema(checked.latest, checked.block),
    });
    if (outcome.kind === 'ok') return { kind: 'ok', version: outcome.version };
    if (outcome.kind !== 'already-registered') {
      throw new Error(
        `block "${from.id}": publishing into its own project ${from.projectId as ProjectId} failed (${outcome.kind})`,
      );
    }
    candidate = nextVersion(candidate);
  }
  throw new Error(`block "${from.id}": no free version after ${highest}`);
}

/** Every version number a block holds, unregistered ones included. */
async function allVersions(
  blocks: BlockRegistryBinding,
  tenantId: TenantId,
  blockId: string,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await blocks.listVersions({
      tenantId,
      blockId,
      limit: 100,
      includeTombstoned: true,
      ...(cursor !== undefined && { cursor }),
    });
    out.push(...page.data.map((b) => b.version));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

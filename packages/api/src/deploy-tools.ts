// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The tools a deploy's pack brings, checked against the registry before
 * the deploy writes anything (`planPackTools`), as its data blocks are
 * (`deploy-blocks.ts`). A tool's version numbers are single-use
 * (`POST /v1/tools` refuses a version again), and a version the registry
 * holds keeps its manifest: a pack's tool that changed under the same
 * version would run its new code under the old manifest's input,
 * approvals and connections. So a version the registry holds is the
 * pack's tool only with the same definition (`sameToolDefinition`, what
 * its author declares; a new image of it changes only what a deploy
 * derives):
 *
 * - A version the registry doesn't hold is new.
 * - One it holds in the deploy's project with the same definition is
 *   kept, active or unregistered, each its own state. The deploy then
 *   points it at this image (`refreshToolCode`).
 * - One it holds in the deploy's project with another definition is
 *   refused (`tool-already-registered`), naming the fields that differ,
 *   and whether it's active or unregistered.
 * - One it holds where its publish decides first, in another project or
 *   as an MCP endpoint's tool, is left to the publish, which refuses it
 *   (`tool-project-mismatch`, `tool-kind-mismatch`) as before. When it
 *   answers `already-registered` (from another project of the
 *   project's environment order), the write compares it
 *   (`keepPublishedTool`), as it does a new one published since the plan.
 */

import { type ToolManifest, changedToolFields } from '@kindgi/tools';
import type { Cursor, ProjectId, Semver, TenantId, ToolId } from '@kindgi/types';

import { PublishRefused } from './publish-refused.js';
import type { ToolRegistryBinding } from './tool-binding.js';

/** What the registry holds under a pack's tool's version, before the deploy writes anything. */
export type PlannedToolState =
  /** Nothing: the deploy publishes it. */
  | 'new'
  /** The pack's tool, active. */
  | 'kept'
  /** The pack's tool, unregistered: kept as an active one is. */
  | 'unregistered'
  /** A version in another project, or an MCP endpoint's: its publish decides. */
  | 'publish-decides';

/** A pack's tool as the deploy publishes it, and what the registry held under its version. */
export interface PlannedTool {
  readonly tool: ToolManifest;
  readonly state: PlannedToolState;
}

export type PackToolsPlan =
  | { readonly kind: 'ok'; readonly planned: readonly PlannedTool[] }
  | { readonly kind: 'refused'; readonly refusal: PublishRefused };

type ToolReads = Pick<ToolRegistryBinding, 'getVersion' | 'listVersions'>;

/** Each of the pack's tools against the registry, before the deploy writes anything. */
export async function planPackTools(
  registry: ToolReads,
  tenantId: TenantId,
  projectId: ProjectId,
  pack: readonly ToolManifest[],
): Promise<PackToolsPlan> {
  const planned: PlannedTool[] = [];
  for (const tool of pack) {
    const version = tool.version as unknown as Semver;
    const stored = await registry.getVersion({ tenantId, toolId: tool.id, version });
    if (stored === null) {
      planned.push({ tool, state: 'new' });
      continue;
    }
    const elsewhere = stored.projectId !== undefined && stored.projectId !== projectId;
    if (elsewhere || isEndpointsTool(stored) !== isEndpointsTool(tool)) {
      planned.push({ tool, state: 'publish-decides' });
      continue;
    }
    const unregistered = await listedUnregistered(registry, tenantId, tool.id, version);
    const fields = changedToolFields(stored, tool);
    if (fields.length > 0) {
      return { kind: 'refused', refusal: changedVersion(tool, fields, unregistered) };
    }
    planned.push({ tool, state: unregistered ? 'unregistered' : 'kept' });
  }
  return { kind: 'ok', planned };
}

/**
 * A pack's tool whose publish answered `already-registered` where the
 * plan didn't compare it: a new one published since, or one its publish
 * decided (`publish-decides`). Kept only with the pack's definition:
 * throws `PublishRefused` for another one, and the deploy rolls back what
 * it wrote. A registry that holds no such version leaves nothing to
 * compare, and the tool is kept as before.
 */
export async function keepPublishedTool(
  registry: ToolReads,
  tenantId: TenantId,
  tool: ToolManifest,
): Promise<void> {
  const version = tool.version as unknown as Semver;
  const stored = await registry.getVersion({ tenantId, toolId: tool.id, version });
  if (stored === null) return;
  const fields = changedToolFields(stored, tool);
  if (fields.length === 0) return;
  throw changedVersion(
    tool,
    fields,
    await listedUnregistered(registry, tenantId, tool.id, version),
  );
}

/** The refusal of a pack's tool whose version the registry holds with another definition. */
function changedVersion(
  tool: ToolManifest,
  fields: readonly string[],
  unregistered: boolean,
): PublishRefused {
  const held = unregistered ? 'already published (now unregistered)' : 'already published';
  return new PublishRefused('tool', `${tool.id}@${tool.version}`, {
    code: 'tool-already-registered',
    reason: `version ${tool.version} is ${held} with another definition (it differs in ${fields.join(', ')}); a version never changes, so give the pack's tool a new version`,
    fields,
  });
}

/**
 * An MCP endpoint's tool: served over MCP, with no code or spec of its
 * own (as the runtime's catalog reads one). A pack's tool always has one
 * or the other.
 */
function isEndpointsTool(tool: ToolManifest): boolean {
  return tool.transport === 'mcp' && tool.codeArtifactRef === undefined && tool.spec === undefined;
}

/**
 * Whether the registry lists `toolId@version` as unregistered.
 * `getVersion` reads an unregistered version without saying so; its
 * versions' list says (`unregisteredAt`).
 */
async function listedUnregistered(
  registry: ToolReads,
  tenantId: TenantId,
  toolId: ToolId,
  version: Semver,
): Promise<boolean> {
  let cursor: Cursor | undefined;
  do {
    const page = await registry.listVersions({
      tenantId,
      toolId,
      includeTombstoned: true,
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    const row = page.data.find((v) => (v.version as unknown as string) === version);
    if (row !== undefined) return row.unregisteredAt !== undefined;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return false;
}

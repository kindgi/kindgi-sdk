// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Agent, AgentPins } from '@kindgi/agents';
import { pickVersion } from '@kindgi/tools';
import type { Cursor, TenantId, ToolId } from '@kindgi/types';

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

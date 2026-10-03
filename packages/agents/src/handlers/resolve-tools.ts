// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelToolDefinition } from '@kindgi/capabilities';
import type { Tool, ToolRegistry } from '@kindgi/tools';

import type { Agent } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Resolve the agent's tool references against one tenant's registry
 * (`ToolRegistry.forTenant`). Throws the turn failure for an unknown
 * tool or an unsatisfiable version range.
 */
export function resolveTurnTools(
  registry: ToolRegistry,
  agent: Agent,
): NonNullable<TurnContext['tools']> {
  const definitions: ModelToolDefinition[] = [];
  const byName = new Map<
    string,
    { readonly tool: Tool; readonly resolvedVersion: string; readonly requestedRange: string }
  >();
  for (const ref of agent.tools) {
    // Agent references tools by (id, range).
    // Resolve at run start via `resolve` on the tenant-bound registry
    // (npm-compatible semver, backed by `maxSatisfying`); capture `resolvedVersion` in
    // the byName map so `dispatch-tools` can emit it in provenance +
    // telemetry — a replay can then pin against the same version.
    const resolved = registry.resolve(ref.id as never, ref.version);
    if (resolved.kind === 'err') {
      const err = resolved.error;
      if (err.code === 'tool-not-found') {
        throwAgentTurnFailure({
          code: 'unresolved-tool',
          message: `Tool "${ref.id}" declared by agent "${agent.id}" is not registered`,
          toolId: ref.id,
        });
      }
      if (err.code === 'invalid-version-range' || err.code === 'tool-version-unresolvable') {
        throwAgentTurnFailure({
          code: 'tool-version-unresolvable',
          message: err.message,
          toolId: ref.id,
          requestedRange: ref.version,
          ...(err.code === 'tool-version-unresolvable' && {
            availableVersions: err.availableVersions,
          }),
        });
      }
      throwAgentTurnFailure({
        code: 'unresolved-tool',
        message: err.message,
        toolId: ref.id,
      });
    }
    const { tool, resolvedVersion } = resolved.value;
    definitions.push({
      name: tool.id,
      description: tool.description,
      inputSchema: tool.input as Readonly<Record<string, unknown>>,
    });
    byName.set(tool.id, { tool, resolvedVersion, requestedRange: ref.version });
  }
  return { definitions, byName };
}

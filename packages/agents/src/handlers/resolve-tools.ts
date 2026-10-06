// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelToolDefinition } from '@kindgi/capabilities';
import type { Tool, ToolError, ToolRegistry } from '@kindgi/tools';

import type { Agent, ToolRef } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Resolve the agent's tool references against one tenant's registry
 * (`ToolRegistry.forTenant`). Throws the turn failure for an unknown
 * tool or an unsatisfiable version range. A tool in `pinned` (a resumed
 * turn's, from its `setup`) resolves to exactly that version, and so,
 * otherwise, does one in the agent version's own pins (`agent.pins`, set
 * when it was published): one that's gone fails the turn rather than
 * running another. Without either, the tool's range resolves.
 */
export function resolveTurnTools(
  registry: ToolRegistry,
  agent: Agent,
  pinned?: Readonly<Record<string, string>>,
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
    const turnPin = pinned?.[ref.id];
    const pin = turnPin ?? agent.pins?.tools[ref.id];
    const resolved = registry.resolve(ref.id as never, pin ?? ref.version);
    if (resolved.kind === 'err') {
      throwUnresolved(agent, ref, resolved.error, pin, turnPin !== undefined ? 'turn' : 'agent');
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

/**
 * Fail the turn for a tool that didn't resolve. A pinned version that's
 * gone names whose pin it was: the turn's own (it started with that
 * version) or the agent version's (it was published with it).
 */
function throwUnresolved(
  agent: Agent,
  ref: ToolRef,
  err: ToolError,
  pin: string | undefined,
  pinnedBy: 'turn' | 'agent',
): never {
  const available = err.code === 'tool-version-unresolvable' && {
    availableVersions: err.availableVersions,
  };
  if (pin !== undefined) {
    throwAgentTurnFailure({
      code: 'tool-version-unresolvable',
      message:
        pinnedBy === 'turn'
          ? `Tool "${ref.id}": this turn started with version ${pin}, which is no longer registered; it doesn't run another version mid-turn. ${err.message}`
          : `Tool "${ref.id}": agent "${agent.id}" version ${agent.version} runs version ${pin} (its pins), which isn't registered; it doesn't run another version. ${err.message}`,
      toolId: ref.id,
      requestedRange: ref.version,
      ...available,
    });
  }
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
      ...available,
    });
  }
  throwAgentTurnFailure({ code: 'unresolved-tool', message: err.message, toolId: ref.id });
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Action } from '@kindgi/authz';

/**
 * The scopes a chat app asks for at sign-in, and the actions each lets a
 * call through `/mcp` take. The person's own grants still decide: a scope
 * only narrows them (`Principal.scope.allowedActions`). None of them holds
 * `write`, `publish`, `admin` or `delete`, so from a chat app even an
 * editor acts only on their own runs and schedules.
 *
 * - `kindgi:read`: see agents, runs and their results, schedules and waits.
 * - `kindgi:run`: run agents and flows (`execute` on the item, `call` on the
 *   project it runs in), stop your own runs (`run`), and the run's own tool
 *   calls (`invoke`: the in-run check narrows by the run's principal).
 * - `kindgi:schedule`: create, pause and remove your own schedules.
 */
export const MCP_SCOPES = {
  'kindgi:read': ['read'],
  'kindgi:run': ['read', 'execute', 'call', 'invoke', 'run'],
  'kindgi:schedule': ['read', 'execute', 'call', 'run'],
} as const satisfies Record<string, readonly Action[]>;

export type McpScope = keyof typeof MCP_SCOPES;

export function isMcpScope(scope: string): scope is McpScope {
  return Object.hasOwn(MCP_SCOPES, scope);
}

/** The scopes among `granted` this endpoint knows; others are ignored. */
export function mcpScopesOf(granted: readonly string[] | undefined): readonly McpScope[] {
  return (granted ?? []).filter(isMcpScope);
}

/** The union of the actions `scopes` allow, in `MCP_SCOPES` order. */
export function allowedActionsOf(scopes: readonly McpScope[]): readonly Action[] {
  const actions = new Set<Action>();
  for (const scope of scopes) for (const action of MCP_SCOPES[scope]) actions.add(action);
  return [...actions];
}

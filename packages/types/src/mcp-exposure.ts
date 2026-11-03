// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whether an agent or a flow is a tool in a person's chat app, through the
 * API's MCP server (`/mcp`). Absent, or `expose: false`: it isn't one.
 *
 * An exposed agent's tool is named by its id, and a flow's by `flow.` and
 * its id. The chat app lists it only to people who can see it, and running
 * it asks the same rights as any other run.
 */
export interface McpExposure {
  /** Offer it as a tool to the people who can see it. */
  readonly expose: boolean;
  /**
   * Tells the chat app that a run changes nothing (the tool's
   * `readOnlyHint`). Absent: no hint, so the chat app applies the
   * protocol's default (it may change things).
   */
  readonly readOnly?: boolean;
  /**
   * Tells the chat app that a run may change or remove things in a way that
   * can't be undone (the tool's `destructiveHint`), so it asks before
   * running it. Absent: no hint, so the chat app applies the protocol's
   * default.
   */
  readonly destructive?: boolean;
}

/** The prefixes Kindgi keeps for its own tools' names and for flows' tools. */
export const MCP_RESERVED_PREFIXES = ['kindgi.', 'flow.'] as const;

/** The longest tool name, and the characters one may use (MCP's tool names). */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * What's wrong with an `mcp` value on the agent or flow `id`, as
 * `{ path, message }` issues under `/mcp`. The id is checked only when
 * `expose` is true: it becomes the tool's name, or its part after `flow.`.
 */
export function mcpExposureIssues(
  value: unknown,
  id: string,
  kind: 'agent' | 'flow',
): readonly { readonly path: string; readonly message: string }[] {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path: '/mcp', message: 'mcp must be an object' }];
  }
  const out: { path: string; message: string }[] = [];
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (key !== 'expose' && key !== 'readOnly' && key !== 'destructive') {
      out.push({ path: `/mcp/${key}`, message: 'mcp takes only expose, readOnly and destructive' });
    }
  }
  if (typeof fields.expose !== 'boolean') {
    out.push({ path: '/mcp/expose', message: 'mcp.expose must be true or false' });
  }
  for (const key of ['readOnly', 'destructive'] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== 'boolean') {
      out.push({ path: `/mcp/${key}`, message: `mcp.${key} must be true or false` });
    }
  }
  if (fields.expose === true) out.push(...toolNameIssues(id, kind));
  return out;
}

function toolNameIssues(id: string, kind: 'agent' | 'flow'): { path: string; message: string }[] {
  const name = kind === 'flow' ? `flow.${id}` : id;
  if (!TOOL_NAME.test(name)) {
    return [
      {
        path: '/mcp/expose',
        message: `${kind} id "${id}" can't be a tool's name: use letters, digits, "_", "-" and ".", at most ${kind === 'flow' ? 123 : 128} characters`,
      },
    ];
  }
  const reserved = MCP_RESERVED_PREFIXES.find((prefix) => id.startsWith(prefix));
  if (kind === 'agent' && reserved !== undefined) {
    return [
      {
        path: '/mcp/expose',
        message: `agent id "${id}" starts with "${reserved}", a prefix kept for ${reserved === 'flow.' ? "flows' tools" : "Kindgi's own tools"}`,
      },
    ];
  }
  return [];
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AnyTool, McpToolManifest, ToolManifest } from './types.js';

/**
 * Project a runtime `Tool` to its serialisable manifest — everything
 * declared in `@kindgi/specs/tool.schema.json` minus the `handler` binding.
 *
 * Use for wire transport, MCP exposure (via `toMcpManifest`), and
 * discovery endpoints. The result round-trips through JSON.
 */
export function toManifest(tool: AnyTool): ToolManifest {
  // Strip runtime-only bindings that never cross the wire: the handler
  // function itself, and the optional Zod authoring schemas preserved
  // for TS type inference on the runtime object.
  const { handler: _handler, inputZod: _inputZod, outputZod: _outputZod, ...manifest } = tool;
  return manifest;
}

/**
 * Project a `Tool` to the MCP `tools/list` shape:
 * `{ name, description, inputSchema, outputSchema? }`.
 *
 * MCP's tool discovery format is narrower than our own — no needs, no
 * effects, no transport hint. Those stay on the Kindgi side (used by
 * policy, capabilities, scheduling); the MCP client sees only what the
 * spec exposes.
 *
 * `outputSchema` is optional in MCP; we always emit it so clients that
 * read it get typed returns.
 */
export function toMcpManifest(tool: AnyTool): McpToolManifest {
  return {
    name: tool.id,
    description: tool.description,
    inputSchema: tool.input,
    outputSchema: tool.output,
  };
}

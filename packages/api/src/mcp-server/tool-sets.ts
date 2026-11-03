// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { McpToolSet } from './endpoint.js';
import { RUN_STATE_TOOLS, agentTools } from './run-tools.js';

/** The tools `/mcp` serves, each set under the scopes a token needs for it. */
export const MCP_TOOL_SETS: readonly McpToolSet[] = [RUN_STATE_TOOLS, agentTools()];

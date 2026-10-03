// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { renderJson } from '../output.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

/**
 * GET /health — public route, no auth required. Uses direct fetch
 * because the SDK has no `client.health()` method.
 */
export const healthCommand: LeafCommand = {
  kind: 'leaf',
  name: 'health',
  description: 'Ping the API server (GET /health).',
  usage: 'kindgi health',
  run: async (ctx): Promise<CommandResult> => {
    const base = ctx.apiUrl();
    const url = `${base.replace(/\/+$/, '')}/health`;
    try {
      const res = await ctx.fetch(url, { method: 'GET' });
      if (!res.ok) {
        return {
          kind: 'error',
          stderr: `Health check failed: HTTP ${res.status}\n`,
          exitCode: 1,
        };
      }
      const body = (await res.json().catch(() => ({}))) as unknown;
      return { kind: 'ok', rendered: renderJson(body, ctx.globals.format) };
    } catch (err) {
      return {
        kind: 'error',
        stderr: `Health check failed: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }
  },
};

export function healthLeaf(): Command {
  return healthCommand;
}

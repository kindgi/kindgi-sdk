// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { renderJson } from '../output.js';
import { CLI_VERSION, SDK_VERSION } from '../version-info.js';
import type { CommandResult, LeafCommand } from './types.js';

/**
 * Print CLI + SDK versions, plus (if the API is reachable) the server's
 * OpenAPI info block. Never requires an auth token — `/v1/openapi.json`
 * is public.
 */
export const versionCommand: LeafCommand = {
  kind: 'leaf',
  name: 'version',
  description: 'Print CLI + SDK versions (and API version if reachable).',
  usage: 'kindgi version',
  run: async (ctx): Promise<CommandResult> => {
    const info: {
      cli: string;
      sdk: string;
      apiUrl?: string;
      api?: { title?: string; version?: string };
      apiUnreachable?: string;
    } = {
      cli: CLI_VERSION,
      sdk: SDK_VERSION,
    };
    if (ctx.config.apiUrl !== undefined) {
      info.apiUrl = ctx.config.apiUrl;
      try {
        const url = `${ctx.config.apiUrl.replace(/\/+$/, '')}/v1/openapi.json`;
        const res = await ctx.fetch(url, { method: 'GET' });
        if (res.ok) {
          const body = (await res.json()) as { info?: { title?: string; version?: string } };
          if (body.info !== undefined) info.api = body.info;
        } else {
          info.apiUnreachable = `HTTP ${res.status}`;
        }
      } catch (err) {
        info.apiUnreachable = (err as Error).message;
      }
    }
    return { kind: 'ok', rendered: renderJson(info, ctx.globals.format) };
  },
};

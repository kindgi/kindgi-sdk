// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { saveHomeConfig } from '../config.js';
import { renderJson } from '../output.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

const login: LeafCommand = {
  kind: 'leaf',
  name: 'login',
  description: 'Persist an API URL + token to ~/.kindgi/config.json.',
  usage: 'kindgi auth login [--url=<url>] [--token=<token>]',
  optionSpec: {},
  run: async (ctx): Promise<CommandResult> => {
    const url = ctx.globals.url ?? ctx.config.apiUrl;
    const token = ctx.globals.token ?? ctx.config.token;
    if (typeof url !== 'string' || url === '') {
      return {
        kind: 'error',
        stderr: 'Missing --url=<api-url> (or KINDGI_API_URL / existing config).\n',
        exitCode: 1,
      };
    }
    if (typeof token !== 'string' || token === '') {
      return {
        kind: 'error',
        stderr: 'Missing --token=<api-token> (or KINDGI_API_TOKEN / existing config).\n',
        exitCode: 1,
      };
    }
    const path = await saveHomeConfig({ apiUrl: url, token }, ctx.home);
    return {
      kind: 'ok',
      rendered: renderJson({ ok: true, wrote: path, apiUrl: url }, ctx.globals.format),
    };
  },
};

const whoami: LeafCommand = {
  kind: 'leaf',
  name: 'whoami',
  description: 'Verify the configured token by hitting the API.',
  usage: 'kindgi auth whoami',
  run: async (ctx): Promise<CommandResult> => {
    const base = ctx.apiUrl();
    const token = ctx.token();
    // An authenticated route: a wrong or revoked token gets 401, not a pass.
    const url = `${base.replace(/\/+$/, '')}/v1/identity/whoami`;
    try {
      const res = await ctx.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const source = ctx.config.source;
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403
            ? ' (the token is wrong, revoked, or for another server)'
            : '';
        return {
          kind: 'error',
          stderr: `whoami failed: HTTP ${res.status}${hint}\n`,
          exitCode: 1,
        };
      }
      const identity = (await res.json()) as Record<string, unknown>;
      return {
        kind: 'ok',
        rendered: renderJson(
          {
            ok: true,
            apiUrl: base,
            tokenSource: source.token,
            apiUrlSource: source.apiUrl,
            identity,
          },
          ctx.globals.format,
        ),
      };
    } catch (err) {
      return {
        kind: 'error',
        stderr: `whoami failed: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }
  },
};

export const authCommand: Command = {
  kind: 'group',
  name: 'auth',
  description: 'Manage local auth configuration.',
  subcommands: [login, whoami],
};

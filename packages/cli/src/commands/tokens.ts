// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ApiToken, ApiTokenSpec } from '@kindgi/client';
import type { Page } from '@kindgi/types';

import { renderJson } from '../output.js';
import {
  type TableSpec,
  integerFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/** `tokens list --table`. */
const TOKENS_TABLE: TableSpec<Page<ApiToken>, ApiToken> = {
  rows: (page) => page.items,
  columns: [
    { header: 'ID', get: (t) => String(t.id) },
    { header: 'ROLE', get: (t) => t.role },
    { header: 'LABEL', get: (t) => t.label ?? '' },
    { header: 'CREATED', get: (t) => String(t.createdAt) },
    { header: 'REVOKED', get: (t) => (t.revokedAt !== undefined ? String(t.revokedAt) : '') },
  ],
};

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    'Create an API token. Its secret is printed once, here: store it now, nothing shows it again.',
  usage: 'kindgi tokens create [--spec=<json-or-@file>]',
  optionSpec: {
    spec: {
      type: 'string',
      description:
        'The token as inline JSON or `@<file>`, every field optional: `role` (`admin` or `member`, default `member`), `capabilities`, `label`, `expiresAt`, `projectId`.',
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'tokens create', async () => {
      const specText = stringFlag(ctx, 'spec');
      const spec =
        specText === undefined ? undefined : ((await readJsonInput(specText)) as ApiTokenSpec);
      const created = await ctx.client().tokens.create(spec);
      return {
        ...renderJson(created, ctx.globals.format),
        stderr: `⚠ The secret of token ${String(created.meta.id)} is shown once, above: store it now.\n`,
      };
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: "List the tenant's API tokens, newest first, revoked ones included. No secrets.",
  usage: 'kindgi tokens list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: { type: 'string', description: 'The most tokens to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'tokens list',
      async () => {
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().tokens.list({
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor: cursor as never }),
        });
      },
      TOKENS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'One API token, by id. No secret.',
  usage: 'kindgi tokens get <token-id>',
  run: (ctx) =>
    runSdk(ctx, 'tokens get', async () => {
      const id = requiredPositional(ctx, 0, 'token-id');
      return await ctx.client().tokens.get(id as never);
    }),
};

const revoke: LeafCommand = {
  kind: 'leaf',
  name: 'revoke',
  description: 'Revoke an API token: from its next request on, it is refused.',
  usage: 'kindgi tokens revoke <token-id>',
  run: (ctx) =>
    runSdk(ctx, 'tokens revoke', async () => {
      const id = requiredPositional(ctx, 0, 'token-id');
      await ctx.client().tokens.revoke(id as never);
      return { tokenId: id, revoked: true };
    }),
};

export const tokensCommand: Command = {
  kind: 'group',
  name: 'tokens',
  description: 'API tokens: create (its secret shown once), list, get, revoke.',
  subcommands: [create, list, get, revoke],
};

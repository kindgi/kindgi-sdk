// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ListPage, User } from '@kindgi/client';

import { renderJson } from '../output.js';
import {
  type TableSpec,
  integerFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi people`: the tenant's people. A tenant admin adds one (a
 * tenant member: they can read the tenant's settings), gives them a role
 * (a project or team membership, or tenant admin) and mints their first
 * key: `kindgi tokens create --for=user:<id>`.
 */

const TABLE: TableSpec<ListPage<User>, User> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (u) => String(u.userId) },
    { header: 'NAME', get: (u) => u.displayName ?? '' },
    { header: 'EMAIL', get: (u) => u.primaryEmail ?? '' },
    { header: 'ADDED', get: (u) => String(u.createdAt) },
  ],
};

const add: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    "Add a person to the tenant; prints their id. They can read the tenant's settings at once; give them a project role to work on its agents and runs, and their first key (`kindgi tokens create --for=user:<id>`). Tenant admins only.",
  usage: 'kindgi people add --name=<display-name> [--email=<email>]',
  optionSpec: {
    name: { type: 'string', description: 'Their name, as people see it.' },
    email: { type: 'string', description: "Their email; unique among the tenant's people." },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'people add', async () => {
      const displayName = stringFlag(ctx, 'name');
      if (displayName === undefined) throw new Error('--name is required');
      const email = stringFlag(ctx, 'email');
      const userId = await ctx.client().users.create({
        displayName,
        ...(email !== undefined && { email }),
      });
      const added = { userId, displayName, ...(email !== undefined && { email }) };
      return {
        stdout: renderJson(added, ctx.globals.format).stdout,
        stderr:
          ctx.globals.format === 'quiet'
            ? ''
            : `Added to the tenant: they can read its settings. Give them a project role to work on its agents and runs, then their first key: kindgi tokens create --for=user:${String(userId)}\n`,
      };
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: "List the tenant's people; `--query` matches the start of a name.",
  usage: 'kindgi people list [--query=<name-prefix>] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    query: { type: 'string', description: 'Only names starting with this.' },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'people list',
      async () => {
        const query = stringFlag(ctx, 'query');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().users.list({
          ...(query !== undefined && { query }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor: cursor as never }),
        });
      },
      TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'One person, by id.',
  usage: 'kindgi people get <user-id>',
  run: (ctx) =>
    runSdk(ctx, 'people get', async () =>
      ctx.client().users.get(requiredPositional(ctx, 0, 'user-id') as never),
    ),
};

export const peopleCommand: Command = {
  kind: 'group',
  name: 'people',
  description: "The tenant's people: add one (tenant admins), list, get.",
  subcommands: [add, list, get],
};

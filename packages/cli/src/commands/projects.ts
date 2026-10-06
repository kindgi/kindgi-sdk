// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi projects`: find the project ids the `--project=<id>` flags take
 * (blocks, eval suites and runs, judge classes, agents derive). Mirrors
 * the clients' `projects.list`, `projects.getDefault` and `projects.get`.
 */

import { integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: "List the tenant's projects.",
  usage: 'kindgi projects list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: { type: 'string', description: 'The most projects to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'projects list', async () => {
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().projects.list({
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

const getDefault: LeafCommand = {
  kind: 'leaf',
  name: 'get-default',
  description: "The tenant's Default project, the one used when none is named.",
  usage: 'kindgi projects get-default',
  run: (ctx) =>
    runSdk(ctx, 'projects get-default', async () => await ctx.client().projects.getDefault()),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'One project, by id.',
  usage: 'kindgi projects get <project-id>',
  run: (ctx) =>
    runSdk(ctx, 'projects get', async () => {
      const id = requiredPositional(ctx, 0, 'project-id');
      return await ctx.client().projects.get(id);
    }),
};

export const projectsCommand: Command = {
  kind: 'group',
  name: 'projects',
  description:
    'Find projects, for the commands that take `--project=<id>` (list / get-default / get).',
  subcommands: [list, getDefault, get],
};

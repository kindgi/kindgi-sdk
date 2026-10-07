// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ListPage, Tool } from '@kindgi/client';
import type { ToolId } from '@kindgi/types';

import {
  type TableSpec,
  projectIdFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
  truncateCell,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/** `tools list --table`. */
const TOOLS_TABLE: TableSpec<ListPage<Tool>, Tool> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (tool) => String(tool.id) },
    { header: 'VERSION', get: (tool) => tool.version ?? '' },
    { header: 'DESCRIPTION', get: (tool) => truncateCell(tool.description, 60) },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List registered tools.',
  usage: 'kindgi tools list [--name=<prefix>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    name: { type: 'string', description: 'Only the tools whose id starts with this prefix.' },
    limit: {
      type: 'string',
      description: 'The most tools to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'tools list',
      async () => {
        const name = stringFlag(ctx, 'name');
        const cursor = stringFlag(ctx, 'cursor');
        const limitStr = stringFlag(ctx, 'limit');
        const limit = limitStr !== undefined ? Number.parseInt(limitStr, 10) : undefined;
        if (limit !== undefined && Number.isNaN(limit)) {
          throw new Error(`--limit must be an integer, got "${limitStr}"`);
        }
        return await ctx.client().tools.list({
          ...(name !== undefined && { name }),
          ...(cursor !== undefined && { cursor: cursor as never }),
          ...(limit !== undefined && { limit }),
        });
      },
      TOOLS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch the latest active version of a tool.',
  usage: 'kindgi tools get <tool-id>',
  run: (ctx) =>
    runSdk(ctx, 'tools get', async () => {
      const toolId = requiredPositional(ctx, 0, 'tool-id');
      return await ctx.client().tools.get(toolId as ToolId);
    }),
};

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description:
    'Register a tool manifest at its version: the tool minus its handler, which the runtime must already have.',
  usage: 'kindgi tools publish --manifest=<json-or-@file> [--project=<project-id>]',
  optionSpec: {
    manifest: {
      type: 'string',
      description: 'The tool manifest as JSON, or `@<file>` to read it from a file. Required.',
    },
    project: {
      type: 'string',
      description:
        "The project to register the tool in, by id (default: the tenant's Default project).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'tools publish', async () => {
      const manifestText = stringFlag(ctx, 'manifest');
      if (manifestText === undefined) throw new Error('--manifest=<json-or-@file> is required');
      const manifest = (await readJsonInput(manifestText)) as Tool;
      const projectId = await projectIdFlag(ctx);
      return await ctx.client().tools.register(manifest, { projectId });
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description:
    'Unregister a specific tool version (semver); `kindgi tools reinstate` brings it back.',
  usage: 'kindgi tools unregister <tool-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'tools unregister', async () => {
      const toolId = requiredPositional(ctx, 0, 'tool-id');
      const version = requiredPositional(ctx, 1, 'version');
      return await ctx.client().tools.versions.unregister(toolId as ToolId, version);
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: 'List published versions of a tool (active + optionally tombstoned).',
  usage: 'kindgi tools versions <tool-id> [--include-tombstoned] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    'include-tombstoned': {
      type: 'boolean',
      description: 'Include unregistered versions too, each with its `unregisteredAt`.',
    },
    limit: {
      type: 'string',
      description: 'The most versions to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'tools versions', async () => {
      const toolId = requiredPositional(ctx, 0, 'tool-id');
      const cursor = stringFlag(ctx, 'cursor');
      const limitStr = stringFlag(ctx, 'limit');
      const limit = limitStr !== undefined ? Number.parseInt(limitStr, 10) : undefined;
      if (limit !== undefined && Number.isNaN(limit)) {
        throw new Error(`--limit must be an integer, got "${limitStr}"`);
      }
      const includeTombstoned = ctx.options['include-tombstoned'] === true;
      return await ctx.client().tools.versions.list(toolId as ToolId, {
        ...(cursor !== undefined && { cursor: cursor as never }),
        ...(limit !== undefined && { limit }),
        ...(includeTombstoned && { includeTombstoned: true }),
      });
    }),
};

const getVersion: LeafCommand = {
  kind: 'leaf',
  name: 'get-version',
  description: 'Fetch a specific tool version by exact semver.',
  usage: 'kindgi tools get-version <tool-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'tools get-version', async () => {
      const toolId = requiredPositional(ctx, 0, 'tool-id');
      const version = requiredPositional(ctx, 1, 'version');
      return await ctx.client().tools.versions.get(toolId as ToolId, version);
    }),
};

const reinstate: LeafCommand = {
  kind: 'leaf',
  name: 'reinstate',
  description: 'Bring back an unregistered tool version (semver).',
  usage: 'kindgi tools reinstate <tool-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'tools reinstate', async () => {
      const toolId = requiredPositional(ctx, 0, 'tool-id');
      const version = requiredPositional(ctx, 1, 'version');
      return await ctx.client().tools.versions.reinstate(toolId as ToolId, version);
    }),
};

export const toolsCommand: Command = {
  kind: 'group',
  name: 'tools',
  description: 'Manage tool registrations.',
  subcommands: [list, get, publish, unregister, versions, getVersion, reinstate],
};

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { FlowsClient } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import {
  type TableSpec,
  integerFlag,
  projectIdFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

/** A page of flows, a flow, and a flow definition, as `flows` takes and answers them. */
type FlowPage = Awaited<ReturnType<FlowsClient['list']>>;
type Flow = FlowPage['data'][number];
type FlowSpec = Parameters<FlowsClient['define']>[0];

const PAGE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
  cursor: {
    type: 'string',
    description: "Resume after this cursor, from the previous page's `nextCursor`.",
  },
};

function page(ctx: CommandContext): { limit?: number; cursor?: never } {
  const limit = integerFlag(ctx, 'limit');
  const cursor = stringFlag(ctx, 'cursor');
  return {
    ...(limit !== undefined && { limit }),
    ...(cursor !== undefined && { cursor: cursor as never }),
  };
}

const FLOWS_TABLE: TableSpec<FlowPage, Flow> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (f) => String(f.id) },
    { header: 'VERSION', get: (f) => f.version },
    { header: 'NAME', get: (f) => f.name ?? '' },
    { header: 'NODES', get: (f) => String(f.nodes.length) },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List registered flows (the latest version of each).',
  usage: 'kindgi flows list [--name=<prefix>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    name: { type: 'string', description: 'Only flows whose id starts with this.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'flows list',
      async () => {
        const name = stringFlag(ctx, 'name');
        return await ctx.client().flows.list({ ...page(ctx), ...(name !== undefined && { name }) });
      },
      FLOWS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a registered flow: its latest version, or the version given.',
  usage: 'kindgi flows get <flow-id> [<version>]',
  run: (ctx) =>
    runSdk(ctx, 'flows get', async () => {
      const flowId = requiredPositional(ctx, 0, 'flow-id') as never;
      const version = ctx.positionals[1];
      const flows = ctx.client().flows;
      return version === undefined
        ? await flows.get(flowId)
        : await flows.versions.get(flowId, version);
    }),
};

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description:
    'Register a flow definition at its version. The server checks it: no cycles, every node and edge resolves.',
  usage: 'kindgi flows publish --spec=<json-or-@file> [--project=<project-id>]',
  optionSpec: {
    spec: {
      type: 'string',
      description: 'The flow definition as JSON, or `@<file>` to read it from a file. Required.',
    },
    project: {
      type: 'string',
      description:
        "The project to register the flow in, by id (default: the tenant's Default project).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'flows publish', async () => {
      const specText = stringFlag(ctx, 'spec');
      if (specText === undefined) throw new UsageError('--spec=<json-or-@file> is required');
      const spec = (await readJsonInput(specText)) as FlowSpec;
      const projectId = await projectIdFlag(ctx);
      return await ctx.client().flows.define(spec, { projectId });
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description:
    'Unregister a specific flow version: new runs of it are refused; `kindgi flows reinstate` brings it back.',
  usage: 'kindgi flows unregister <flow-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'flows unregister', async () => {
      const flowId = requiredPositional(ctx, 0, 'flow-id') as never;
      const version = requiredPositional(ctx, 1, 'version');
      return await ctx.client().flows.versions.unregister(flowId, version);
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: 'List the registered versions of a flow.',
  usage: 'kindgi flows versions <flow-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'flows versions',
      async () => {
        const flowId = requiredPositional(ctx, 0, 'flow-id') as never;
        return await ctx.client().flows.versions.list(flowId, page(ctx));
      },
      FLOWS_TABLE,
    ),
};

const reinstate: LeafCommand = {
  kind: 'leaf',
  name: 'reinstate',
  description: 'Bring back an unregistered flow version.',
  usage: 'kindgi flows reinstate <flow-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'flows reinstate', async () => {
      const flowId = requiredPositional(ctx, 0, 'flow-id') as never;
      const version = requiredPositional(ctx, 1, 'version');
      return await ctx.client().flows.versions.reinstate(flowId, version);
    }),
};

export const flowsCommand: Command = {
  kind: 'group',
  name: 'flows',
  description: 'Manage flow registrations: publish, list, versions, unregister, reinstate.',
  subcommands: [list, get, publish, unregister, versions, reinstate],
};

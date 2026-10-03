// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  projectIdFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
  throwUnwired,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

// Re-declared locally to avoid pulling `@kindgi/agents` into the CLI's
// dep tree — the SDK re-exports the same shape when it fills the
// `agents.define` transport body.
type AgentDefinitionSpec = Parameters<import('@kindgi/client').KindgiClient['agents']['define']>[0];

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List registered agents.',
  usage: 'kindgi agents list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: { type: 'string', description: 'The most agents to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) => runSdk(ctx, 'agents list', async () => throwUnwired('agents.list')),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a registered agent by id.',
  usage: 'kindgi agents get <agent-id>',
  run: (ctx) =>
    runSdk(ctx, 'agents get', async () => {
      requiredPositional(ctx, 0, 'agent-id');
      throwUnwired('agents.get');
    }),
};

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description: 'Register an agent definition.',
  usage: 'kindgi agents publish --spec=<json-or-@file> [--project=<project-id>]',
  optionSpec: {
    spec: {
      type: 'string',
      description: 'The agent definition as JSON, or `@<file>` to read it from a file. Required.',
    },
    project: {
      type: 'string',
      description:
        "The project to register the agent in, by id (default: the tenant's Default project).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'agents publish', async () => {
      const specText = stringFlag(ctx, 'spec');
      if (specText === undefined) throw new Error('--spec=<json-or-@file> is required');
      const spec = (await readJsonInput(specText)) as AgentDefinitionSpec;
      const projectId = await projectIdFlag(ctx);
      const agentId = await ctx.client().agents.define(spec, { projectId });
      return { agentId };
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description: 'Unregister a specific agent version.',
  usage: 'kindgi agents unregister <agent-id> --version=<semver>',
  optionSpec: {
    version: { type: 'string', description: 'The agent version to unregister (semver).' },
  },
  run: (ctx) =>
    runSdk(ctx, 'agents unregister', async () => {
      requiredPositional(ctx, 0, 'agent-id');
      throwUnwired('agents.unregister');
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: 'List published versions of an agent.',
  usage: 'kindgi agents versions <agent-id>',
  run: (ctx) =>
    runSdk(ctx, 'agents versions', async () => {
      requiredPositional(ctx, 0, 'agent-id');
      throwUnwired('agents.versions');
    }),
};

export const agentsCommand: Command = {
  kind: 'group',
  name: 'agents',
  description: 'Manage agent registrations.',
  subcommands: [list, get, publish, unregister, versions],
};

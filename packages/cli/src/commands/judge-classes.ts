// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { JudgeClassScope } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const SCOPE_FLAGS = {
  tenant: { type: 'boolean', description: 'The whole tenant.' },
  project: {
    type: 'string',
    description: 'A project, by id. With `--agent`, the project the agent is in.',
  },
  agent: { type: 'string', description: 'One agent, by id. Needs `--project`.' },
} as const;

/** The scope the flags name; `undefined` when none is given and `required` is false. */
function scopeFromFlags(ctx: CommandContext, required: boolean): JudgeClassScope | undefined {
  const tenant = ctx.options.tenant === true;
  const projectId = stringFlag(ctx, 'project');
  const agentId = stringFlag(ctx, 'agent');
  if (tenant && (projectId !== undefined || agentId !== undefined)) {
    throw new Error('--tenant cannot be combined with --project or --agent');
  }
  if (tenant) return { kind: 'tenant' };
  if (agentId !== undefined) {
    if (projectId === undefined) throw new Error('--agent needs --project');
    return { kind: 'agent', projectId, agentId };
  }
  if (projectId !== undefined) return { kind: 'project', projectId };
  if (required)
    throw new Error('Give a scope: --tenant, --project=<id>, or --agent=<id> --project=<id>');
  return undefined;
}

function weightFlag(ctx: CommandContext): number | undefined {
  const raw = stringFlag(ctx, 'weight');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`--weight must be a number of 0 or more, got '${raw}'`);
  return n;
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List judge classes, newest first.',
  usage:
    'kindgi judge-classes list [--tenant | --project=<id> | --agent=<id> --project=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    ...SCOPE_FLAGS,
    limit: { type: 'string', description: 'The most classes to return (default 25, at most 100).' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'judge-classes list', async () => {
      const scope = scopeFromFlags(ctx, false);
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().judgeClasses.list({
        ...(scope !== undefined && { scope }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor: cursor as never }),
      });
    }),
};

const add: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    'Add a judge class: a named kind of judge with a weight, for the tenant, a project, or an agent.',
  usage:
    'kindgi judge-classes add --name=<name> --weight=<w> (--tenant | --project=<id> | --agent=<id> --project=<id>) [--description=<text>]',
  optionSpec: {
    name: { type: 'string', description: 'The class name, e.g. `expert`. Required.' },
    weight: {
      type: 'string',
      description: 'How much a judgment of this class counts, a number of 0 or more. Required.',
    },
    ...SCOPE_FLAGS,
    description: { type: 'string', description: 'What the class is for.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'judge-classes add', async () => {
      const name = stringFlag(ctx, 'name');
      if (name === undefined) throw new Error('--name=<name> is required');
      const weight = weightFlag(ctx);
      if (weight === undefined) throw new Error('--weight=<w> is required');
      const scope = scopeFromFlags(ctx, true) as JudgeClassScope;
      const description = stringFlag(ctx, 'description');
      return await ctx.client().judgeClasses.create({
        scope,
        name,
        weight,
        ...(description !== undefined && { description }),
      });
    }),
};

const set: LeafCommand = {
  kind: 'leaf',
  name: 'set',
  description: "Change a judge class's weight or description.",
  usage: 'kindgi judge-classes set <judge-class-id> [--weight=<w>] [--description=<text>]',
  optionSpec: {
    weight: { type: 'string', description: 'The new weight, a number of 0 or more.' },
    description: { type: 'string', description: 'The new description.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'judge-classes set', async () => {
      const id = requiredPositional(ctx, 0, 'judge-class-id');
      const weight = weightFlag(ctx);
      const description = stringFlag(ctx, 'description');
      if (weight === undefined && description === undefined) {
        throw new Error('Give --weight and/or --description');
      }
      return await ctx.client().judgeClasses.update(id, {
        ...(weight !== undefined && { weight }),
        ...(description !== undefined && { description }),
      });
    }),
};

const remove: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description: 'Retire a judge class: no new judgments may name it; existing ones keep it.',
  usage: 'kindgi judge-classes remove <judge-class-id>',
  run: (ctx) =>
    runSdk(ctx, 'judge-classes remove', async () => {
      const id = requiredPositional(ctx, 0, 'judge-class-id');
      await ctx.client().judgeClasses.unregister(id);
      return { judgeClassId: id, removed: true };
    }),
};

export const judgeClassesCommand: Command = {
  kind: 'group',
  name: 'judge-classes',
  description: 'Manage judge classes, the weighted kinds of judge (list / add / set / remove).',
  subcommands: [list, add, set, remove],
};

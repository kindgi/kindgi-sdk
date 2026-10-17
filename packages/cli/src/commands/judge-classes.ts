// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { JudgeClassAssertableBy, JudgeClassScope } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { integerFlag, listFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
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
    throw new UsageError('--tenant cannot be combined with --project or --agent');
  }
  if (tenant) return { kind: 'tenant' };
  if (agentId !== undefined) {
    if (projectId === undefined) throw new UsageError('--agent needs --project');
    return { kind: 'agent', projectId, agentId };
  }
  if (projectId !== undefined) return { kind: 'project', projectId };
  if (required)
    throw new UsageError('Give a scope: --tenant, --project=<id>, or --agent=<id> --project=<id>');
  return undefined;
}

const REVIEWER_ROLES = ['standard', 'senior', 'admin'] as const;
const PRINCIPAL_KINDS = ['user', 'service'] as const;
type ReviewerRole = (typeof REVIEWER_ROLES)[number];
type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

const ASSERTABLE_FLAGS = {
  'min-reviewer-role': {
    type: 'string',
    description: `Only reviewers of this role or above may assert the class: ${REVIEWER_ROLES.join(', ')}.`,
  },
  'principal-kind': {
    type: 'string',
    multiple: true,
    description:
      'Only people (`user`) or service tokens (`service`) may assert the class. Repeat the flag for both.',
  },
  'principal-id': {
    type: 'string',
    multiple: true,
    description: 'Only this user or token id may assert the class. Repeat the flag for several.',
  },
} as const;

const ASSERTABLE_USAGE =
  '[--min-reviewer-role=standard|senior|admin] [--principal-kind=user|service ...] [--principal-id=<id> ...]';

/** Who may assert a class, from the flags; `undefined` when none is given. */
function assertableByFromFlags(ctx: CommandContext): JudgeClassAssertableBy | undefined {
  const role = stringFlag(ctx, 'min-reviewer-role');
  if (role !== undefined && !(REVIEWER_ROLES as readonly string[]).includes(role)) {
    throw new UsageError(
      `--min-reviewer-role must be one of ${REVIEWER_ROLES.join(', ')}, got "${role}"`,
    );
  }
  const kinds = listFlag(ctx, 'principal-kind');
  for (const kind of kinds) {
    if (!(PRINCIPAL_KINDS as readonly string[]).includes(kind)) {
      throw new UsageError(`--principal-kind must be user or service, got "${kind}"`);
    }
  }
  const ids = listFlag(ctx, 'principal-id');
  if (role === undefined && kinds.length === 0 && ids.length === 0) return undefined;
  return {
    ...(role !== undefined && {
      minReviewerRole: role as ReviewerRole,
    }),
    ...(kinds.length > 0 && { principalKinds: kinds as PrincipalKind[] }),
    ...(ids.length > 0 && { principalIds: ids }),
  };
}

function weightFlag(ctx: CommandContext): number | undefined {
  const raw = stringFlag(ctx, 'weight');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new UsageError(`--weight must be a number of 0 or more, got '${raw}'`);
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
    'Add a judge class: a named kind of judge with a weight, for the tenant, a project, or an agent. The restriction flags limit who may assert it; without them, anyone who may judge the run may.',
  usage: `kindgi judge-classes add --name=<name> --weight=<w> (--tenant | --project=<id> | --agent=<id> --project=<id>) [--description=<text>] ${ASSERTABLE_USAGE}`,
  optionSpec: {
    name: { type: 'string', description: 'The class name, e.g. `expert`. Required.' },
    weight: {
      type: 'string',
      description: 'How much a judgment of this class counts, a number of 0 or more. Required.',
    },
    ...SCOPE_FLAGS,
    description: { type: 'string', description: 'What the class is for.' },
    ...ASSERTABLE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'judge-classes add', async () => {
      const name = stringFlag(ctx, 'name');
      if (name === undefined) throw new UsageError('--name=<name> is required');
      const weight = weightFlag(ctx);
      if (weight === undefined) throw new UsageError('--weight=<w> is required');
      const scope = scopeFromFlags(ctx, true) as JudgeClassScope;
      const description = stringFlag(ctx, 'description');
      const assertableBy = assertableByFromFlags(ctx);
      return await ctx.client().judgeClasses.create({
        scope,
        name,
        weight,
        ...(description !== undefined && { description }),
        ...(assertableBy !== undefined && { assertableBy }),
      });
    }),
};

const set: LeafCommand = {
  kind: 'leaf',
  name: 'set',
  description:
    "Change a judge class's weight, description, or who may assert it. The restriction flags replace the class's whole restriction; `--unrestricted` lifts it.",
  usage: `kindgi judge-classes set <judge-class-id> [--weight=<w>] [--description=<text>] [${ASSERTABLE_USAGE} | --unrestricted]`,
  optionSpec: {
    weight: { type: 'string', description: 'The new weight, a number of 0 or more.' },
    description: { type: 'string', description: 'The new description.' },
    ...ASSERTABLE_FLAGS,
    unrestricted: {
      type: 'boolean',
      description: 'Lift the restriction: anyone who may judge the run may assert the class.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'judge-classes set', async () => {
      const id = requiredPositional(ctx, 0, 'judge-class-id');
      const weight = weightFlag(ctx);
      const description = stringFlag(ctx, 'description');
      const restricted = assertableByFromFlags(ctx);
      const unrestricted = ctx.options.unrestricted === true;
      if (restricted !== undefined && unrestricted) {
        throw new UsageError('--unrestricted cannot be combined with the restriction flags');
      }
      const assertableBy = unrestricted ? null : restricted;
      if (weight === undefined && description === undefined && assertableBy === undefined) {
        throw new UsageError('Give --weight, --description, a restriction flag, or --unrestricted');
      }
      return await ctx.client().judgeClasses.update(id, {
        ...(weight !== undefined && { weight }),
        ...(description !== undefined && { description }),
        ...(assertableBy !== undefined && { assertableBy }),
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

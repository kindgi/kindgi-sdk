// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { CommandContext } from '../context.js';
import { integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const VERDICTS = ['yes', 'no'] as const;

/** The string flags given, under their request field names (`{ class: 'judgeClassId' }`). */
function givenFlags<F extends string>(
  ctx: CommandContext,
  fields: Readonly<Record<string, F>>,
): Partial<Record<F, string>> {
  const out: Partial<Record<F, string>> = {};
  for (const [flag, field] of Object.entries(fields)) {
    const value = stringFlag(ctx, flag);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

const add: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    "Judge one item of a finished run's output: yes or no, with an optional reason. Judging the same item again as the same caller replaces the earlier judgment.",
  usage:
    'kindgi judgments add --run=<run-id> --item=<key> [--pointer=<json-pointer>] [--rank=<n>] (--yes | --no) [--reason=<text>] [--class=<judge-class-id>] [--participant=<id>]',
  optionSpec: {
    run: { type: 'string', description: 'The run whose output is judged. Required.' },
    item: {
      type: 'string',
      description: 'Your stable id for the judged item, e.g. a matched case id. Required.',
    },
    pointer: {
      type: 'string',
      description:
        "Where the item is in the run's output, as a JSON Pointer such as `/matches/2`. Its value is kept with the judgment.",
    },
    rank: { type: 'string', description: "The item's position in a ranked list (0 = first)." },
    yes: { type: 'boolean', description: 'The verdict is yes. Give `--yes` or `--no`.' },
    no: { type: 'boolean', description: 'The verdict is no. Give `--yes` or `--no`.' },
    reason: { type: 'string', description: 'Why, recorded with the judgment.' },
    class: {
      type: 'string',
      description:
        'The judge class id to record the judgment under. Without one, the judgment is unclassified.',
    },
    participant: {
      type: 'string',
      description: 'Your opaque id for the end user who judged, when you judge on their behalf.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'judgments add', async () => {
      const runId = stringFlag(ctx, 'run');
      if (runId === undefined) throw new Error('--run=<run-id> is required');
      const key = stringFlag(ctx, 'item');
      if (key === undefined) throw new Error('--item=<key> is required');
      const yes = ctx.options.yes === true;
      const no = ctx.options.no === true;
      if (yes === no) throw new Error('Give exactly one of --yes or --no');
      const rank = integerFlag(ctx, 'rank');
      if (rank !== undefined && rank < 0) throw new Error('--rank must be 0 or more');
      const pointer = ctx.options.pointer;
      return await ctx.client().judgments.create({
        runId,
        item: {
          key,
          // An empty pointer is valid: the whole output.
          ...(typeof pointer === 'string' && { pointer }),
          ...(rank !== undefined && { rank }),
        },
        verdict: yes ? 'yes' : 'no',
        ...givenFlags(ctx, {
          reason: 'reason',
          class: 'judgeClassId',
          participant: 'participantId',
        }),
      });
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List judgments, newest first (replaced and removed ones are left out).',
  usage:
    'kindgi judgments list [--run=<run-id>] [--agent=<id> [--agent-version=<v>]] [--flow=<id>] [--verdict=yes|no] [--class=<judge-class-id>] [--participant=<id>] [--project=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    run: { type: 'string', description: 'Only judgments of this run.' },
    agent: { type: 'string', description: 'Only judgments of runs of this agent.' },
    'agent-version': {
      type: 'string',
      description: 'Only judgments of runs of this agent version. Needs `--agent`.',
    },
    flow: { type: 'string', description: 'Only judgments of runs of this flow.' },
    verdict: { type: 'string', description: 'Only this verdict: `yes` or `no`.' },
    class: { type: 'string', description: 'Only judgments under this judge class id.' },
    participant: {
      type: 'string',
      description: "Only judgments made for this end user's opaque id.",
    },
    project: { type: 'string', description: 'Only judgments in this project.' },
    limit: {
      type: 'string',
      description: 'The most judgments to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'judgments list', async () => {
      if (
        stringFlag(ctx, 'agent-version') !== undefined &&
        stringFlag(ctx, 'agent') === undefined
      ) {
        throw new Error('--agent-version needs --agent');
      }
      const verdict = stringFlag(ctx, 'verdict');
      if (verdict !== undefined && !(VERDICTS as readonly string[]).includes(verdict)) {
        throw new Error(`--verdict must be one of ${VERDICTS.join(', ')}, got "${verdict}"`);
      }
      const projectId = stringFlag(ctx, 'project');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().judgments.list({
        ...givenFlags(ctx, {
          run: 'runId',
          agent: 'agentId',
          'agent-version': 'agentVersion',
          flow: 'flowId',
          class: 'judgeClassId',
          participant: 'participantId',
        }),
        ...(verdict !== undefined && { verdict: verdict as (typeof VERDICTS)[number] }),
        ...(projectId !== undefined && { scope: { kind: 'project' as const, projectId } }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor: cursor as never }),
      });
    }),
};

const show: LeafCommand = {
  kind: 'leaf',
  name: 'show',
  description:
    "Show a judgment with the stored copies of the run's input and output, and the judged item's value.",
  usage: 'kindgi judgments show <judgment-id>',
  run: (ctx) =>
    runSdk(ctx, 'judgments show', async () => {
      const id = requiredPositional(ctx, 0, 'judgment-id');
      return await ctx.client().judgments.get(id);
    }),
};

const remove: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description: 'Remove a judgment.',
  usage: 'kindgi judgments remove <judgment-id>',
  run: (ctx) =>
    runSdk(ctx, 'judgments remove', async () => {
      const id = requiredPositional(ctx, 0, 'judgment-id');
      await ctx.client().judgments.unregister(id);
      return { judgmentId: id, removed: true };
    }),
};

export const judgmentsCommand: Command = {
  kind: 'group',
  name: 'judgments',
  description: "Judge items of a run's output, yes or no (add / list / show / remove).",
  subcommands: [add, list, show, remove],
};

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { JudgingQueueState } from '@kindgi/client';
import { UsageError } from '../errors.js';
import {
  integerFlag,
  projectIdFlag,
  requiredPositional,
  runSdk,
  stringFlag,
  timeFlag,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

/** Where a queued run stands, the values `--state` takes. */
const QUEUE_STATES = ['open', 'judged', 'dismissed', 'erased'] as const;

const PROJECT_OPTION: Readonly<Record<string, ParseArgsOption>> = {
  project: {
    type: 'string',
    description: "The project whose queue to act on. Without it, the tenant's Default project.",
  },
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List the runs in the project’s judging queue, oldest first.',
  usage:
    'kindgi judging-queue list [--project=<id>] [--state=open|judged|dismissed|erased] [--agent=<id>] [--rule=<id>] [--class=<id>] [--for-me] [--added-after=<time>] [--closed-after=<time>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    ...PROJECT_OPTION,
    state: {
      type: 'string',
      description: 'Only items in this state: `open`, `judged`, `dismissed` or `erased`.',
    },
    agent: { type: 'string', description: 'Only runs of this agent.' },
    rule: { type: 'string', description: 'Only runs a given rule queued.' },
    class: { type: 'string', description: 'Only items wanting this judge class.' },
    'for-me': {
      type: 'boolean',
      description:
        'Only items a judgment of mine would close (any judgment, or one of my classes).',
    },
    'added-after': {
      type: 'string',
      description: 'Only items queued after this time (an ISO 8601 time with a zone, or a date).',
    },
    'closed-after': {
      type: 'string',
      description: 'Only items closed after this time (an ISO 8601 time with a zone, or a date).',
    },
    limit: { type: 'string', description: 'The most items to return; `0` for the total alone.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'judging-queue list', async () => {
      const projectId = await projectIdFlag(ctx);
      const state = stringFlag(ctx, 'state');
      if (state !== undefined && !(QUEUE_STATES as readonly string[]).includes(state)) {
        throw new UsageError(`--state must be one of ${QUEUE_STATES.join(', ')}, got "${state}"`);
      }
      const agentId = stringFlag(ctx, 'agent');
      const ruleId = stringFlag(ctx, 'rule');
      const judgeClassId = stringFlag(ctx, 'class');
      const addedAfter = timeFlag(ctx, 'added-after');
      const closedAfter = timeFlag(ctx, 'closed-after');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().projects.judgingQueue.list(projectId, {
        ...(state !== undefined && { state: state as JudgingQueueState }),
        ...(agentId !== undefined && { agentId }),
        ...(ruleId !== undefined && { ruleId }),
        ...(judgeClassId !== undefined && { judgeClassId }),
        ...(ctx.options['for-me'] === true && { forMe: true }),
        ...(addedAfter !== undefined && { addedAfter }),
        ...(closedAfter !== undefined && { closedAfter }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

const dismiss: LeafCommand = {
  kind: 'leaf',
  name: 'dismiss',
  description: 'Dismiss a queued run so it needs no judgment; `reopen` undoes it.',
  usage: 'kindgi judging-queue dismiss <run-id> [--project=<id>] [--reason=<text>]',
  optionSpec: {
    ...PROJECT_OPTION,
    reason: { type: 'string', description: 'Why, recorded with the item.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'judging-queue dismiss', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id');
      const projectId = await projectIdFlag(ctx);
      const reason = stringFlag(ctx, 'reason');
      return await ctx.client().projects.judgingQueue.dismiss(projectId, runId, reason);
    }),
};

const reopen: LeafCommand = {
  kind: 'leaf',
  name: 'reopen',
  description: 'Reopen a dismissed item, so it waits for a judgment again.',
  usage: 'kindgi judging-queue reopen <run-id> [--project=<id>]',
  optionSpec: { ...PROJECT_OPTION },
  run: (ctx) =>
    runSdk(ctx, 'judging-queue reopen', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id');
      const projectId = await projectIdFlag(ctx);
      return await ctx.client().projects.judgingQueue.reopen(projectId, runId);
    }),
};

export const judgingQueueCommand: Command = {
  kind: 'group',
  name: 'judging-queue',
  description:
    "A project's judging queue — the runs a rule puts up for a person's judgment, open or closed (list / dismiss / reopen).",
  subcommands: [list, dismiss, reopen],
};

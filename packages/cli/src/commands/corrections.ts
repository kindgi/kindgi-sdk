// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { CorrectedItem, ExpectedDecisions } from '@kindgi/client';
import { CORRECTION_ITEM } from '@kindgi/types';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { integerFlag, readJsonInput, requiredPositional, runSdk, stringFlag } from './helpers.js';
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

/** The optional `--correction` flag, parsed from JSON or `@<file>`. */
async function expectedDecisionsFlag(ctx: CommandContext): Promise<ExpectedDecisions | undefined> {
  const text = stringFlag(ctx, 'correction');
  return text === undefined ? undefined : ((await readJsonInput(text)) as ExpectedDecisions);
}

/** The corrected item for an ordinary correction, from `--item`/`--pointer`/`--rank`. */
function ordinaryItem(ctx: CommandContext): CorrectedItem {
  const key = stringFlag(ctx, 'item');
  if (key === undefined) throw new UsageError('--item=<key> is required');
  const rank = integerFlag(ctx, 'rank');
  if (rank !== undefined && rank < 0) throw new UsageError('--rank must be 0 or more');
  const pointer = ctx.options.pointer;
  return {
    key,
    // An empty pointer is valid: the whole output.
    ...(typeof pointer === 'string' && { pointer }),
    ...(rank !== undefined && { rank }),
  };
}

/**
 * The one reserved item a correction rides on — the whole output — so it counts
 * once per run per expert. `--item`, `--pointer` or `--rank`, if given, may only
 * name that whole-output item; `--rank` never applies, so it is refused.
 */
function correctionItem(ctx: CommandContext): CorrectedItem {
  const key = stringFlag(ctx, 'item');
  if (key !== undefined && key !== CORRECTION_ITEM.key) {
    throw new UsageError(
      `--correction is recorded under --item=${CORRECTION_ITEM.key}; drop --item or set it to that`,
    );
  }
  const pointer = ctx.options.pointer;
  if (typeof pointer === 'string' && pointer !== CORRECTION_ITEM.pointer) {
    throw new UsageError('--correction covers the whole output; drop --pointer');
  }
  if (integerFlag(ctx, 'rank') !== undefined) {
    throw new UsageError('--correction covers the whole output; drop --rank');
  }
  return { key: CORRECTION_ITEM.key, pointer: CORRECTION_ITEM.pointer };
}

const add: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    "Correct one item of a finished run's output: mark the answer right (`--yes`) or wrong (`--no`), with an optional reason. Correcting the same item again as the same caller replaces the earlier correction.",
  usage:
    'kindgi corrections add --run=<run-id> --item=<key> [--pointer=<json-pointer>] [--rank=<n>] (--yes | --no) [--reason=<text>] [--correction=<json-or-@file>] [--class=<judge-class-id>] [--participant=<id>]',
  optionSpec: {
    run: { type: 'string', description: 'The run whose output is corrected. Required.' },
    item: {
      type: 'string',
      description: 'Your stable id for the corrected item, e.g. a matched case id. Required.',
    },
    pointer: {
      type: 'string',
      description:
        "Where the item is in the run's output, as a JSON Pointer such as `/matches/2`. Its value is kept with the correction.",
    },
    rank: { type: 'string', description: "The item's position in a ranked list (0 = first)." },
    yes: {
      type: 'boolean',
      description: 'Mark the item right (the verdict `yes`). Give `--yes` or `--no`.',
    },
    no: {
      type: 'boolean',
      description: 'Mark the item wrong (the verdict `no`). Give `--yes` or `--no`.',
    },
    reason: { type: 'string', description: 'Why, recorded with the correction.' },
    correction: {
      type: 'string',
      description:
        'What the agent should have done, as JSON or `@<file>`: `{ "calls": [{ "tool": "<tool-id>", "args": { … } }], "notCalled": ["<tool-id>"] }`. `args` are the partial top-level fields to compare (those left out are not compared); `notCalled` lists tools that should not have been called at all. Graded on a replay. Recorded against the whole output, so a later correction of the same run by the same caller replaces it; `--item`/`--pointer`/`--rank` aren\'t needed.',
    },
    class: {
      type: 'string',
      description:
        'The judge class id to record the correction under. Without one, the correction is unclassified.',
    },
    participant: {
      type: 'string',
      description:
        'Your opaque id for the end user who corrected, when you correct on their behalf.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'corrections add', async () => {
      const runId = stringFlag(ctx, 'run');
      if (runId === undefined) throw new UsageError('--run=<run-id> is required');
      const yes = ctx.options.yes === true;
      const no = ctx.options.no === true;
      if (yes === no) throw new UsageError('Give exactly one of --yes or --no');
      const correction = await expectedDecisionsFlag(ctx);
      const item = correction === undefined ? ordinaryItem(ctx) : correctionItem(ctx);
      return await ctx.client().corrections.create({
        runId,
        item,
        verdict: yes ? 'yes' : 'no',
        ...(correction !== undefined && { correction }),
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
  description: 'List corrections, newest first (replaced and removed ones are left out).',
  usage:
    'kindgi corrections list [--run=<run-id>] [--agent=<id> [--agent-version=<v>]] [--flow=<id>] [--verdict=yes|no] [--class=<judge-class-id>] [--participant=<id>] [--project=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    run: { type: 'string', description: 'Only corrections of this run.' },
    agent: { type: 'string', description: 'Only corrections of runs of this agent.' },
    'agent-version': {
      type: 'string',
      description: 'Only corrections of runs of this agent version. Needs `--agent`.',
    },
    flow: { type: 'string', description: 'Only corrections of runs of this flow.' },
    verdict: { type: 'string', description: 'Only this verdict: `yes` or `no`.' },
    class: { type: 'string', description: 'Only corrections under this judge class id.' },
    participant: {
      type: 'string',
      description: "Only corrections made for this end user's opaque id.",
    },
    project: { type: 'string', description: 'Only corrections in this project.' },
    limit: {
      type: 'string',
      description: 'The most corrections to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'corrections list', async () => {
      if (
        stringFlag(ctx, 'agent-version') !== undefined &&
        stringFlag(ctx, 'agent') === undefined
      ) {
        throw new UsageError('--agent-version needs --agent');
      }
      const verdict = stringFlag(ctx, 'verdict');
      if (verdict !== undefined && !(VERDICTS as readonly string[]).includes(verdict)) {
        throw new UsageError(`--verdict must be one of ${VERDICTS.join(', ')}, got "${verdict}"`);
      }
      const projectId = stringFlag(ctx, 'project');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().corrections.list({
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
    "Show a correction with the stored copies of the run's input and output, and the corrected item's value.",
  usage: 'kindgi corrections show <correction-id>',
  run: (ctx) =>
    runSdk(ctx, 'corrections show', async () => {
      const id = requiredPositional(ctx, 0, 'correction-id');
      return await ctx.client().corrections.get(id);
    }),
};

const remove: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description: 'Remove a correction.',
  usage: 'kindgi corrections remove <correction-id>',
  run: (ctx) =>
    runSdk(ctx, 'corrections remove', async () => {
      const id = requiredPositional(ctx, 0, 'correction-id');
      await ctx.client().corrections.remove(id);
      return { correctionId: id, removed: true };
    }),
};

export const correctionsCommand: Command = {
  kind: 'group',
  name: 'corrections',
  description:
    "Correct items of a run's output, marking them right or wrong (add / list / show / remove).",
  subcommands: [add, list, show, remove],
};

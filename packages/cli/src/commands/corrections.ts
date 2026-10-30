// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ChangeCorrectionInput,
  CorrectedAnswerItem,
  Correction,
  CorrectionSortedTo,
  CorrectionStatus,
  CreateCorrectionInput,
  ExpectedDecisions,
  Verdict,
} from '@kindgi/client';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import {
  givenFlag,
  integerFlag,
  listFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/** The statuses a change sets; `fixed` comes from a pin or a deploy, `removed` from `remove`. */
const CHANGE_STATUSES: readonly NonNullable<ChangeCorrectionInput['status']>[] = [
  'open',
  'being-fixed',
  'wont-fix',
];
const SORTED_TO: readonly CorrectionSortedTo[] = ['improve', 'developer', 'owner'];
/** What `list --status` takes: a status, or `not-fixed` for the three that aren't done. */
const LISTED_STATUSES: readonly (CorrectionStatus | 'not-fixed')[] = [
  'not-fixed',
  'open',
  'being-fixed',
  'with-owner',
  'fixed',
  'wont-fix',
  'removed',
];
const LISTED_SORTED_TO: readonly (CorrectionSortedTo | 'none')[] = ['none', ...SORTED_TO];

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return value as T;
}

/** A repeatable flag's values, each of which may also be comma-separated. */
function valuesOf<T extends string>(ctx: CommandContext, flag: string, allowed: readonly T[]): T[] {
  return listFlag(ctx, flag)
    .flatMap((raw) => raw.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => oneOf(flag, value, allowed));
}

/** The string flags given, under their request field names (`{ group: 'correctorGroupId' }`). */
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

/** The keys a run's answer goes by: an agent turn's `answer`, a flow run's whole `output`. */
const ANSWER_KEYS: readonly string[] = ['answer', 'output'];

/** What one call says: about the decisions, the answer, or one ranked item. */
type Piece =
  | { readonly kind: 'decisions'; readonly verdict: Verdict; readonly expected: ExpectedDecisions }
  | { readonly kind: 'answer'; readonly verdict: Verdict }
  | { readonly kind: 'item'; readonly item: CorrectedAnswerItem };

function pieceOf(ctx: CommandContext, verdict: Verdict, expected?: ExpectedDecisions): Piece {
  const key = stringFlag(ctx, 'item');
  const pointer = ctx.options.pointer;
  const rank = integerFlag(ctx, 'rank');
  if (expected !== undefined) {
    if (key !== undefined || typeof pointer === 'string' || rank !== undefined) {
      throw new UsageError(
        "--correction is about the run's decisions; drop --item, --pointer and --rank",
      );
    }
    return { kind: 'decisions', verdict, expected };
  }
  // An empty pointer is the whole output: the answer.
  if ((key !== undefined && ANSWER_KEYS.includes(key)) || pointer === '') {
    if (rank !== undefined)
      throw new UsageError("--rank is for a ranked list's items, not the answer");
    return { kind: 'answer', verdict };
  }
  if (key === undefined) throw new UsageError('--item=<key> is required');
  if (rank !== undefined && rank < 0) throw new UsageError('--rank must be 0 or more');
  return {
    kind: 'item',
    item: {
      key,
      ...(typeof pointer === 'string' && { pointer }),
      ...(rank !== undefined && { rank }),
      verdict,
    },
  };
}

/**
 * A call's piece folded into the caller's live correction on the run, if
 * there is one: a 0.4.0 correction is one per run and author, so posting
 * the piece alone would replace what earlier calls said.
 */
function foldPiece(
  live: Correction | undefined,
  piece: Piece,
  runId: string,
): CreateCorrectionInput {
  const base: CreateCorrectionInput = {
    runId,
    ...(live?.decisions !== undefined && { decisions: live.decisions }),
    ...(live?.shouldCall !== undefined && { shouldCall: live.shouldCall }),
    ...(live?.mustNotCall !== undefined && { mustNotCall: live.mustNotCall }),
    ...(live?.answer !== undefined && { answer: live.answer }),
    ...(live?.shouldSay !== undefined && { shouldSay: live.shouldSay }),
    ...(live?.why !== undefined && { why: live.why }),
    ...(live?.items !== undefined && { items: live.items }),
    ...(live?.correctorGroupId !== undefined && { correctorGroupId: live.correctorGroupId }),
  };
  if (piece.kind === 'answer') {
    // What it should have said goes with a wrong answer only.
    const { shouldSay, ...rest } = base;
    return {
      ...rest,
      answer: piece.verdict,
      ...(piece.verdict === 'wrong' && shouldSay !== undefined && { shouldSay }),
    };
  }
  if (piece.kind === 'decisions') {
    const { shouldCall: _calls, mustNotCall: _not, ...rest } = base;
    return {
      ...rest,
      decisions: piece.verdict,
      ...((piece.expected.calls ?? []).length > 0 && { shouldCall: piece.expected.calls }),
      ...((piece.expected.notCalled ?? []).length > 0 && {
        mustNotCall: piece.expected.notCalled,
      }),
    };
  }
  // A correction names each item once, by key, so a new pointer for it replaces the old one.
  const same = (i: CorrectedAnswerItem) => i.key === piece.item.key;
  return { ...base, items: [...(base.items ?? []).filter((i) => !same(i)), piece.item] };
}

const add: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    'Correct a finished run: say whether its decisions (`--correction`), its answer (`--item=answer`, or `output` for a flow) or an item of a ranked list was right (`--yes`) or wrong (`--no`). Each call adds to your correction of the run, replacing what you said before about the same piece.',
  usage:
    'kindgi corrections add --run=<run-id> (--item=<key> [--pointer=<json-pointer>] [--rank=<n>] | --correction=<json-or-@file>) (--yes | --no) [--reason=<text>] [--group=<corrector-group-id>] [--participant=<id>]',
  optionSpec: {
    run: { type: 'string', description: 'The run that is corrected. Required.' },
    item: {
      type: 'string',
      description:
        "What is corrected: `answer` (an agent turn's answer) or `output` (a flow run's whole output), or your stable id for an item of a ranked list, e.g. a matched case id.",
    },
    pointer: {
      type: 'string',
      description:
        "Where the item is in the run's output, as a JSON Pointer such as `/matches/2`. An empty pointer is the whole output: the answer.",
    },
    rank: { type: 'string', description: "The item's position in a ranked list (0 = first)." },
    yes: {
      type: 'boolean',
      description: 'It was right. Give `--yes` or `--no`.',
    },
    no: {
      type: 'boolean',
      description: 'It was wrong. Give `--yes` or `--no`.',
    },
    reason: {
      type: 'string',
      description: "Why, kept as the correction's `why`. A wrong answer needs one.",
    },
    correction: {
      type: 'string',
      description:
        'What the agent should have done, as JSON or `@<file>`: `{ "calls": [{ "tool": "<tool-id>", "args": { … } }], "notCalled": ["<tool-id>"] }`, with `--no`. `args` are the partial top-level fields to compare (those left out are not compared); `notCalled` lists tools that should not have been called at all. Graded on a replay.',
    },
    group: {
      type: 'string',
      description:
        'The corrector group id to record the correction under. Without one, it keeps the group it has, or is unclassified.',
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
      const piece = pieceOf(ctx, yes ? 'right' : 'wrong', await expectedDecisionsFlag(ctx));
      const participantId = stringFlag(ctx, 'participant');
      const client = ctx.client();
      // Your live correction of the run, for this end user if you name one.
      const mine = await client.corrections.list({
        runId,
        madeBy: 'me',
        ...(participantId !== undefined && { participantId }),
        limit: 100,
      });
      const live = mine.data.find((j) => j.participantId === participantId);
      const reason = stringFlag(ctx, 'reason');
      const correctorGroupId = stringFlag(ctx, 'group');
      return await client.corrections.create({
        ...foldPiece(live, piece, runId),
        ...(reason !== undefined && { why: reason }),
        ...(correctorGroupId !== undefined && { correctorGroupId }),
        ...(participantId !== undefined && { participantId }),
      });
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    'List corrections, newest first. Replaced ones are left out, and removed ones unless `--status` names `removed`.',
  usage:
    'kindgi corrections list [--run=<run-id>] [--agent=<id> [--agent-version=<v>]] [--flow=<id>] [--status=<status>]… [--sorted-to=<where>]… [--group=<corrector-group-id>] [--participant=<id>] [--project=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    run: { type: 'string', description: 'Only corrections of this run.' },
    agent: { type: 'string', description: 'Only corrections of runs of this agent.' },
    'agent-version': {
      type: 'string',
      description: 'Only corrections of runs of this agent version. Needs `--agent`.',
    },
    flow: { type: 'string', description: 'Only corrections of runs of this flow.' },
    status: {
      type: 'string',
      multiple: true,
      description:
        'Only corrections in these statuses (repeat, or comma-separate): `open`, `being-fixed`, `with-owner`, `fixed`, `wont-fix` or `removed`, or `not-fixed` for the first three.',
    },
    'sorted-to': {
      type: 'string',
      multiple: true,
      description:
        'Only corrections sorted to these (repeat, or comma-separate): `improve`, `developer` or `owner`, or `none` for unsorted ones.',
    },
    group: { type: 'string', description: 'Only corrections under this corrector group id.' },
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
      const status = valuesOf(ctx, 'status', LISTED_STATUSES);
      const sortedTo = valuesOf(ctx, 'sorted-to', LISTED_SORTED_TO);
      const projectId = stringFlag(ctx, 'project');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().corrections.list({
        ...givenFlags(ctx, {
          run: 'runId',
          agent: 'agentId',
          'agent-version': 'agentVersion',
          flow: 'flowId',
          group: 'correctorGroupId',
          participant: 'participantId',
        }),
        ...(status.length > 0 && { status }),
        ...(sortedTo.length > 0 && { sortedTo }),
        ...(projectId !== undefined && { scope: { kind: 'project' as const, projectId } }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor: cursor as never }),
      });
    }),
};

const show: LeafCommand = {
  kind: 'leaf',
  name: 'show',
  description: "Show a correction with the stored copy of the run's input and output.",
  usage: 'kindgi corrections show <correction-id>',
  run: (ctx) =>
    runSdk(ctx, 'corrections show', async () => {
      const id = requiredPositional(ctx, 0, 'correction-id');
      return await ctx.client().corrections.get(id);
    }),
};

const set: LeafCommand = {
  kind: 'leaf',
  name: 'set',
  description:
    'Re-sort a correction, change its status, or both (the re-sort first). Only a pin or a deploy makes one `fixed`, and only `kindgi corrections remove` makes one `removed`.',
  usage:
    'kindgi corrections set <correction-id> [--status=open|being-fixed|wont-fix] [--sorted-to=improve|developer|owner] [--link=<url|ir-…|sc-…>] [--reason=<text>]',
  optionSpec: {
    status: {
      type: 'string',
      description:
        '`being-fixed` (from `open` or `with-owner`, with `--link`), `open` (from `being-fixed` or `wont-fix`) or `wont-fix` (from anything but `removed`, with `--reason`).',
    },
    'sorted-to': {
      type: 'string',
      description:
        '`improve`, `developer` or `owner`, from `open`, `being-fixed` or `with-owner`. To `owner` makes it `with-owner`, and away from `owner`, `open`.',
    },
    link: {
      type: 'string',
      description:
        'With `--status=being-fixed`: what fixes it, a pull request URL, an Improve run (`ir-…`) or a suggested change (`sc-…`).',
    },
    reason: {
      type: 'string',
      description:
        "Why. `--status=wont-fix` needs one; with `--status=open`, it's why the correction went back; otherwise, it's the re-sort's reason.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'corrections set', async () => {
      const id = requiredPositional(ctx, 0, 'correction-id');
      const status = givenFlag(ctx, 'status');
      const sortedTo = givenFlag(ctx, 'sorted-to');
      if (status === undefined && sortedTo === undefined) {
        throw new UsageError('Give --status, --sorted-to, or both');
      }
      const link = givenFlag(ctx, 'link');
      const reason = givenFlag(ctx, 'reason');
      return await ctx.client().corrections.change(id, {
        ...(sortedTo !== undefined && { sortedTo: oneOf('sorted-to', sortedTo, SORTED_TO) }),
        ...(status !== undefined && { status: oneOf('status', status, CHANGE_STATUSES) }),
        ...(link !== undefined && { link }),
        ...(reason !== undefined && { reason }),
      });
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
    "Correct a run's decisions and answer, marking them right or wrong, and move each correction until it's fixed (add / list / show / set / remove).",
  subcommands: [add, list, show, set, remove],
};

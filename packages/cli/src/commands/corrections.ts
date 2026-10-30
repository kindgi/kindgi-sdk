// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ChangeCorrectionInput,
  CorrectedAnswerItem,
  Correction,
  CorrectionSortedTo,
  CorrectionStatus,
  CreateCorrectionInput,
  Verdict,
} from '@kindgi/client';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import {
  givenFlag,
  integerFlag,
  listFlag,
  requiredPositional,
  runSdk,
  stringFlag,
  timeFlag,
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
const FROM = ['experts', 'end-users', 'all'] as const;

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

const VERDICTS: readonly Verdict[] = ['right', 'wrong'];

/** The keys `--item` took for a run's answer before `--answer`: an agent turn's, a flow run's. */
const ANSWER_KEYS: readonly string[] = ['answer', 'output'];

type ShouldCall = NonNullable<CreateCorrectionInput['shouldCall']>[number];

/** `--should-call=<tool>[:<json-args>]`: a tool, and the arguments that matter as a JSON object. */
function shouldCallOf(raw: string): ShouldCall {
  // A tool id may hold a `:`; the arguments start at the `:{`.
  const at = raw.indexOf(':{');
  const tool = at === -1 ? raw : raw.slice(0, at);
  if (tool.length === 0) throw new UsageError(`--should-call needs a tool id, got "${raw}"`);
  if (at === -1) return { tool };
  try {
    return { tool, args: JSON.parse(raw.slice(at + 1)) as Record<string, unknown> };
  } catch {
    throw new UsageError(
      `--should-call's arguments must be a JSON object, as in <tool>:{"amount":25}; got "${raw}"`,
    );
  }
}

/** What one call says. Each part it gives replaces that part of your correction of the run. */
interface Said {
  readonly decisions?: Verdict;
  readonly shouldCall?: readonly ShouldCall[];
  readonly mustNotCall?: readonly string[];
  readonly answer?: Verdict;
  readonly shouldSay?: string;
  readonly why?: string;
  readonly item?: CorrectedAnswerItem;
}

function decisionsOf(ctx: CommandContext): Pick<Said, 'decisions' | 'shouldCall' | 'mustNotCall'> {
  const given = givenFlag(ctx, 'decisions');
  const shouldCall = listFlag(ctx, 'should-call').map(shouldCallOf);
  const mustNotCall = listFlag(ctx, 'must-not-call');
  const decisions = given === undefined ? undefined : oneOf('decisions', given, VERDICTS);
  if (decisions !== 'wrong' && (shouldCall.length > 0 || mustNotCall.length > 0)) {
    throw new UsageError('--should-call and --must-not-call go with --decisions=wrong');
  }
  return {
    ...(decisions !== undefined && { decisions }),
    ...(shouldCall.length > 0 && { shouldCall }),
    ...(mustNotCall.length > 0 && { mustNotCall }),
  };
}

function answerOf(ctx: CommandContext): Pick<Said, 'answer' | 'shouldSay'> {
  const given = givenFlag(ctx, 'answer');
  const shouldSay = givenFlag(ctx, 'should-say');
  const answer = given === undefined ? undefined : oneOf('answer', given, VERDICTS);
  if (answer !== 'wrong' && shouldSay !== undefined) {
    throw new UsageError('--should-say goes with --answer=wrong');
  }
  return { ...(answer !== undefined && { answer }), ...(shouldSay !== undefined && { shouldSay }) };
}

/** `--item=<key> [--pointer] [--rank] (--yes | --no)`: one item of a ranked list. */
function itemOf(ctx: CommandContext): CorrectedAnswerItem | undefined {
  const key = givenFlag(ctx, 'item');
  const pointer = ctx.options.pointer;
  const rank = integerFlag(ctx, 'rank');
  const yes = ctx.options.yes === true;
  const no = ctx.options.no === true;
  if (key === undefined) {
    if (pointer !== undefined || rank !== undefined || yes || no) {
      throw new UsageError('--pointer, --rank, --yes and --no go with --item=<key>');
    }
    return undefined;
  }
  // An empty pointer is the whole output: the answer, which --answer says.
  if (ANSWER_KEYS.includes(key) || pointer === '') {
    throw new UsageError(
      '--item is for an item of a ranked list; say whether the answer was right with --answer=right|wrong',
    );
  }
  if (yes === no) throw new UsageError('--item needs exactly one of --yes or --no');
  if (rank !== undefined && rank < 0) throw new UsageError('--rank must be 0 or more');
  return {
    key,
    ...(typeof pointer === 'string' && { pointer }),
    ...(rank !== undefined && { rank }),
    verdict: yes ? 'right' : 'wrong',
  };
}

/**
 * The call folded into the caller's live correction on the run, if there
 * is one: a correction is one per run and author, so posting what the call
 * says alone would replace what earlier calls said. A part said wrong
 * again keeps what should have happened unless the call says it anew; a
 * part said right drops it.
 */
function fold(live: Correction | undefined, said: Said, runId: string): CreateCorrectionInput {
  const decisions = said.decisions ?? live?.decisions;
  const keepDecisions = decisions === 'wrong';
  const shouldCall = said.shouldCall ?? (keepDecisions ? live?.shouldCall : undefined);
  const mustNotCall = said.mustNotCall ?? (keepDecisions ? live?.mustNotCall : undefined);
  const answer = said.answer ?? live?.answer;
  const shouldSay = said.shouldSay ?? (answer === 'wrong' ? live?.shouldSay : undefined);
  const why = said.why ?? live?.why;
  // A correction names each item once, by key, so an item said again replaces its entry.
  const items =
    said.item === undefined
      ? live?.items
      : [...(live?.items ?? []).filter((i) => i.key !== said.item?.key), said.item];
  return {
    runId,
    ...(decisions !== undefined && { decisions }),
    ...(shouldCall !== undefined && shouldCall.length > 0 && { shouldCall }),
    ...(mustNotCall !== undefined && mustNotCall.length > 0 && { mustNotCall }),
    ...(answer !== undefined && { answer }),
    ...(shouldSay !== undefined && { shouldSay }),
    ...(why !== undefined && { why }),
    ...(items !== undefined && { items }),
    ...(live?.correctorGroupId !== undefined && { correctorGroupId: live.correctorGroupId }),
  };
}

const add: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    'Correct a finished run: say whether its decisions (`--decisions`) and its answer (`--answer`) were right or wrong, and what should have happened, or mark an item of a ranked list (`--item` with `--yes` or `--no`). Each call adds to your correction of the run, replacing what you said before about the same part.',
  usage:
    'kindgi corrections add --run=<run-id> [--decisions=right|wrong] [--should-call=<tool>[:<json-args>]]… [--must-not-call=<tool>]… [--answer=right|wrong] [--should-say=<text>] [--why=<text>] [--item=<key> [--pointer=<json-pointer>] [--rank=<n>] (--yes | --no)] [--group=<corrector-group-id>] [--participant=<id>]',
  optionSpec: {
    run: { type: 'string', description: 'The run that is corrected. Required.' },
    decisions: {
      type: 'string',
      description:
        'Whether the tools the agent called, and the ones it left alone, were `right` or `wrong`. Wrong needs `--should-call` or `--must-not-call`, now or from before.',
    },
    'should-call': {
      type: 'string',
      multiple: true,
      description:
        'With `--decisions=wrong`: a tool the agent should have called, as `<tool-id>`, or `<tool-id>:<json-args>` with the arguments that matter (those left out are not compared), e.g. `acme.refund:{"amount":25}`. Repeat for several.',
    },
    'must-not-call': {
      type: 'string',
      multiple: true,
      description:
        'With `--decisions=wrong`: a tool the agent should not have called at all. Repeat for several.',
    },
    answer: {
      type: 'string',
      description:
        "Whether the run's answer (a flow run's whole output) was `right` or `wrong`. Wrong needs `--should-say` or `--why`, now or from before.",
    },
    'should-say': {
      type: 'string',
      description: 'With `--answer=wrong`: what the answer should have said.',
    },
    why: { type: 'string', description: 'Why, in your words.' },
    item: {
      type: 'string',
      description:
        'Your stable id for an item of a ranked list in the output, e.g. a matched case id, with `--yes` or `--no`.',
    },
    pointer: {
      type: 'string',
      description: "Where the item is in the run's output, as a JSON Pointer such as `/matches/2`.",
    },
    rank: { type: 'string', description: "The item's position in a ranked list (0 = first)." },
    yes: { type: 'boolean', description: 'The item was right. With `--item`.' },
    no: { type: 'boolean', description: 'The item was wrong. With `--item`.' },
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
      const why = givenFlag(ctx, 'why');
      const item = itemOf(ctx);
      const said: Said = {
        ...decisionsOf(ctx),
        ...answerOf(ctx),
        ...(why !== undefined && { why }),
        ...(item !== undefined && { item }),
      };
      if (
        said.decisions === undefined &&
        said.answer === undefined &&
        item === undefined &&
        why === undefined
      ) {
        throw new UsageError('Give --decisions, --answer or --item (with --yes or --no)');
      }
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
      const correctorGroupId = stringFlag(ctx, 'group');
      return await client.corrections.create({
        ...fold(live, said, runId),
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
    'kindgi corrections list [--run=<run-id>] [--agent=<id> [--agent-version=<v>]] [--flow=<id>] [--status=<status>]… [--sorted-to=<where>]… [--from=experts|end-users|all] [--since=<date>] [--group=<corrector-group-id>] [--participant=<id>] [--project=<id>] [--limit=<n>] [--cursor=<c>]',
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
    from: {
      type: 'string',
      description:
        "`experts` (made under a restricted corrector group), `end-users` (made for an app's end user, with a participant id) or `all`.",
    },
    since: {
      type: 'string',
      description:
        'Only corrections made at or after this time: an ISO 8601 time with a zone, or a date (the start of that day in UTC).',
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
      const from = stringFlag(ctx, 'from');
      const since = timeFlag(ctx, 'since');
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
        ...(from !== undefined && { from: oneOf('from', from, FROM) }),
        ...(since !== undefined && { since }),
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

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  CorrectedAnswerItem,
  Correction,
  CorrectionExportFilter,
  CreateCorrectionInput,
  ExpectedDecisions,
  Verdict,
} from '@kindgi/client';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { renderJson } from '../output.js';
import { exists, placeNew } from '../place-file.js';
import {
  integerFlag,
  listFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
  timeFlag,
} from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

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
  description: 'List corrections, newest first (replaced and removed ones are left out).',
  usage:
    'kindgi corrections list [--run=<run-id>] [--agent=<id> [--agent-version=<v>]] [--flow=<id>] [--group=<corrector-group-id>] [--participant=<id>] [--project=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    run: { type: 'string', description: 'Only corrections of this run.' },
    agent: { type: 'string', description: 'Only corrections of runs of this agent.' },
    'agent-version': {
      type: 'string',
      description: 'Only corrections of runs of this agent version. Needs `--agent`.',
    },
    flow: { type: 'string', description: 'Only corrections of runs of this flow.' },
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

const EXPORT_FORMATS = ['csv', 'jsonl'] as const;
const FROM = ['experts', 'end-users', 'all'] as const;

const exportCorrections: LeafCommand = {
  kind: 'leaf',
  name: 'export',
  description:
    "Export an agent's corrections, as CSV (the default) or JSON lines: to --out's file, which takes its name only once the whole export has arrived (an existing file is kept unless --force), or printed once it has all arrived. The run's own text isn't in it, only the run's id.",
  usage:
    'kindgi corrections export --agent=<id> [--project=<id>] [--format=csv|jsonl] [--status=<s>]… [--sorted-to=<s>]… [--from=experts|end-users|all] [--since=<time>] [--until=<time>] [--out=<file>] [--force]',
  optionSpec: {
    agent: { type: 'string', description: 'The agent whose corrections to export.' },
    project: { type: 'string', description: 'Only corrections in this project.' },
    format: {
      type: 'string',
      description:
        "`csv` (the default) or `jsonl`: one correction per line, as each one in `list`'s `data`.",
    },
    status: {
      type: 'string',
      multiple: true,
      description:
        'Only corrections in this status (repeatable): open, being-fixed, with-owner, fixed, wont-fix, removed, or not-fixed.',
    },
    'sorted-to': {
      type: 'string',
      multiple: true,
      description:
        'Only corrections sorted to this (repeatable): improve, developer, owner, or none.',
    },
    from: {
      type: 'string',
      description: 'Whose corrections: experts, end-users, or all (the default).',
    },
    since: {
      type: 'string',
      description: 'Only corrections made at or after this time (ISO 8601 with a zone) or date.',
    },
    until: {
      type: 'string',
      description: 'Only corrections made before this time (ISO 8601 with a zone) or date.',
    },
    out: { type: 'string', description: 'Write the export to this file.' },
    force: { type: 'boolean', description: "Replace --out's file if it exists." },
  },
  run: async (ctx) => {
    const stop = ctx.stopSignal;
    const result = await runSdkRendered(ctx, 'corrections export', async () => {
      const filter = exportFilter(ctx);
      const out = stringFlag(ctx, 'out');
      if (out === undefined) {
        const body = await ctx.client().corrections.export(filter);
        return { stdout: await wholeText(body, stop), stderr: '' };
      }
      const target = resolve(ctx.cwd, out);
      const force = ctx.options.force === true;
      // Before asking: every export is recorded, so one that can't be kept isn't made.
      if (!force && (await exists(target))) throw exportExists(target);
      const body = await ctx.client().corrections.export(filter);
      const bytes = await saveExport(body, target, force, stop);
      return renderJson(
        { agentId: filter.agentId, format: filter.format ?? 'csv', file: target, bytes },
        ctx.globals.format,
      );
    });
    // Ctrl+C (or SIGTERM): a stop, not a failure, as a download's is.
    return result.kind === 'error' && stop?.aborted === true ? STOPPED_EXPORT : result;
  },
};

/** The export's filters from the flags; a flag it can't read is a usage error, before any request. */
function exportFilter(ctx: CommandContext): CorrectionExportFilter {
  const agentId = stringFlag(ctx, 'agent');
  if (agentId === undefined) {
    throw new UsageError('--agent is required: the agent whose corrections to export');
  }
  const format = stringFlag(ctx, 'format');
  if (format !== undefined && !(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new UsageError(`--format must be csv or jsonl; got "${format}"`);
  }
  const from = stringFlag(ctx, 'from');
  if (from !== undefined && !(FROM as readonly string[]).includes(from)) {
    throw new UsageError(`--from must be experts, end-users or all; got "${from}"`);
  }
  const projectId = stringFlag(ctx, 'project');
  const status = listFlag(ctx, 'status');
  const sortedTo = listFlag(ctx, 'sorted-to');
  const since = timeFlag(ctx, 'since');
  const until = timeFlag(ctx, 'until');
  // A status or a sorting the API doesn't know comes back as its 400, as for `list`.
  return {
    agentId,
    ...(projectId !== undefined && { scope: { kind: 'project' as const, projectId } }),
    ...(status.length > 0 && { status: status as never }),
    ...(sortedTo.length > 0 && { sortedTo: sortedTo as never }),
    ...(from !== undefined && { from: from as (typeof FROM)[number] }),
    ...(since !== undefined && { since }),
    ...(until !== undefined && { until }),
    ...(format !== undefined && { format: format as (typeof EXPORT_FORMATS)[number] }),
  };
}

const exportExists = (target: string) =>
  new Error(`${target} exists: pass --force to overwrite it, or --out=<other file>`);

/** The whole body as text, for printing once it has all arrived; the stop (Ctrl+C) ends it. */
async function wholeText(
  body: ReadableStream<Uint8Array>,
  stop: AbortSignal | undefined,
): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) chunks.push(chunk);
      },
      { ...(stop !== undefined && { signal: stop }) },
    );
  } catch (err) {
    throw new Error(
      `the export stopped part way (${(err as Error).message}): nothing was printed`,
      { cause: err },
    );
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The export written to a new file beside `target`, which takes `target`'s
 * name only once the whole export has arrived, as `kindgi artifacts
 * download` writes one. With `force`, it is renamed over `target`; without,
 * it takes the name only while nothing has it (`placeNew`). Otherwise that
 * file is removed, and `target` is as it was: the stop (`stop`, a Ctrl+C)
 * ends the stream as a cut connection does. The file is readable by its
 * owner only, since it holds people's words. Returns the bytes written.
 */
async function saveExport(
  body: ReadableStream<Uint8Array>,
  target: string,
  force: boolean,
  stop: AbortSignal | undefined,
): Promise<number> {
  const partial = `${target}.${randomBytes(4).toString('hex')}.partial`;
  const file = await open(partial, 'wx', 0o600).catch(async (err: unknown) => {
    await body.cancel();
    throw err;
  });
  let bytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          yield chunk;
        }
      },
      file.createWriteStream(),
      { ...(stop !== undefined && { signal: stop }) },
    );
  } catch (err) {
    await rm(partial, { force: true });
    throw new Error(
      `the export stopped part way (${(err as Error).message}): ${target} wasn't written`,
      { cause: err },
    );
  }
  try {
    await (force ? rename(partial, target) : placeNew(partial, target, () => exportExists(target)));
  } finally {
    // Gone after a rename; after a link, its second name; after a failure, the file.
    await rm(partial, { force: true });
  }
  return bytes;
}

/** An export the stop ended: no file written, and the exit code says so. */
const STOPPED_EXPORT: CommandResult = {
  kind: 'error',
  stderr: 'kindgi corrections export stopped: no file was written.\n',
  exitCode: 130,
};

export const correctionsCommand: Command = {
  kind: 'group',
  name: 'corrections',
  description:
    "Correct a run's decisions and answer, marking them right or wrong (add / list / show / export / remove).",
  subcommands: [add, list, show, exportCorrections, remove],
};

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A deploy's blocks against what runs (`POST /v1/deployments/check`),
 * asked before an image is built: a deploy that would put back an older
 * version of a block than runs now, in any project of one of the pack's
 * agents, stops, unless `--replace` names the block, with `--reason`. The
 * server holds the same rule on the deploy itself, so this only makes a
 * stop fast. A runtime without the check (`404`, or `501
 * runs-in-unsupported`) deploys as before, and says so in one line.
 */

import { KindgiApiError } from '@kindgi/client';
import type { DeployCheckStop, KindgiClient } from '@kindgi/client';

import { blocksOf } from '../build/pack-blocks.js';

/** What the check compares, from a pack's index: its agents, and its blocks at their versions in the files. */
export interface RunsCheckInput {
  readonly packId: string | undefined;
  readonly agents: readonly string[];
  readonly blocks: readonly { readonly id: string; readonly version: string }[];
}

/** The agents and blocks of a pack's index: the local one a build writes, or the envelope's. */
export function runsCheckInputOf(index: unknown): RunsCheckInput {
  const { packId, agents } = (index ?? {}) as {
    readonly packId?: unknown;
    readonly agents?: unknown;
  };
  return {
    packId: typeof packId === 'string' ? packId : undefined,
    agents: Array.isArray(agents)
      ? agents
          .map((a) => (a as { readonly id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === 'string')
      : [],
    blocks: blocksOf(index).map(({ id, version }) => ({ id, version })),
  };
}

/** `--replace=<block>` (repeatable) with its `--reason=<text>`. */
export interface ReplaceFlags {
  readonly blocks: readonly string[];
  readonly reason: string | undefined;
}

/** `--replace` needs `--reason`, and `--reason` goes with `--replace`; `undefined` when they fit. */
export function replaceFlagsProblem(flags: ReplaceFlags): string | undefined {
  if (flags.blocks.length > 0 && flags.reason === undefined) {
    return '--replace puts back an older version on purpose: say why with --reason=<text>';
  }
  if (flags.blocks.length === 0 && flags.reason !== undefined) {
    return '--reason says why --replace puts a block back: it goes with --replace=<block>';
  }
  return undefined;
}

/** The body's `replace`: each named block with the one reason. */
export function replaceOf(flags: ReplaceFlags): { blockId: string; reason: string }[] | undefined {
  if (flags.blocks.length === 0 || flags.reason === undefined) return undefined;
  const reason = flags.reason;
  return flags.blocks.map((blockId) => ({ blockId, reason }));
}

export type RunsCheck =
  | {
      readonly kind: 'passed';
      readonly replaced: readonly { blockId: string; from: string; to: string }[];
      readonly notNeeded: readonly string[];
    }
  | { readonly kind: 'stopped'; readonly stops: readonly DeployCheckStop[] }
  /** A runtime before the check (`404`), or one that doesn't read pins and Latest (`501`). */
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'failed'; readonly message: string };

/** Ask the runtime what a deploy of these blocks would answer about them, writing nothing. */
export async function checkRuns(
  client: KindgiClient,
  input: RunsCheckInput,
  opts: { readonly projectId?: string; readonly replace?: ReplaceFlags },
): Promise<RunsCheck> {
  const replace = opts.replace !== undefined ? replaceOf(opts.replace) : undefined;
  try {
    const answer = await client.deployments.check({
      ...(opts.projectId !== undefined && { projectId: opts.projectId }),
      agents: [...input.agents],
      blocks: input.blocks.map(({ id, version }) => ({ id, version })),
      ...(replace !== undefined && { replace }),
    });
    return { kind: 'passed', replaced: answer.replaced, notNeeded: answer.notNeeded };
  } catch (err) {
    if (!(err instanceof KindgiApiError)) {
      return { kind: 'failed', message: (err as Error).message };
    }
    const e = err.error;
    const blocks = 'fields' in e ? e.fields?.blocks : undefined;
    const serverCode = 'serverCode' in e ? e.serverCode : undefined;
    if (serverCode === 'deploy-would-put-back-older-blocks' && Array.isArray(blocks)) {
      return { kind: 'stopped', stops: blocks as DeployCheckStop[] };
    }
    if (serverCode === 'runs-in-unsupported' || e.code === 'not-found') {
      return { kind: 'unchecked' };
    }
    return { kind: 'failed', message: `${serverCode ?? e.code}: ${e.message}` };
  }
}

/** The line a runtime without the check gets. */
export const UNCHECKED_LINE =
  "  This runtime doesn't check blocks against what runs: deploying as before.";

/** Where the checked blocks are, and what they're checked against: a deploy's files, or a promoted build. */
export interface CheckedWords {
  /** "your files", or "the build". */
  readonly ours: string;
  /** "what runs", or "what runs in prod". */
  readonly runs: string;
}

const DEPLOY_WORDS: CheckedWords = { ours: 'your files', runs: 'what runs' };

/** What a check that passed says: each block put back on purpose, and each `--replace` it didn't need. */
export function passedLines(
  check: Extract<RunsCheck, { kind: 'passed' }>,
  words: CheckedWords = DEPLOY_WORDS,
): string[] {
  const lines = check.replaced.map(
    (b) =>
      `  ${b.blockId}: ${b.from} runs now, ${b.to} in ${words.ours}; put back on purpose (--replace)`,
  );
  for (const blockId of check.notNeeded) {
    lines.push(`  ${blockId}: nothing newer runs; --replace not needed`);
  }
  if (lines.length === 0) lines.push(`  ✓ No block in ${words.ours} is older than ${words.runs}.`);
  return lines;
}

/** How a stop says where the blocks are, what was left undone, and the command that drops the newer versions. */
export interface StopWords {
  /** `deploy` or `promotion`. */
  readonly what: 'deploy' | 'promotion';
  /** Where the blocks' older versions are, for the table's header: "your files", or "the build". */
  readonly ours: string;
  /** "Nothing was deployed." */
  readonly nothingDone: string;
  /** What keeps the newer versions, after any pull requests. */
  readonly keep: string;
  /** The command that drops them on purpose, without its `--replace` flags. */
  readonly command: string;
}

/**
 * The table a stop prints: each block, its version in the files, and the
 * newer one that runs, where, by whom and when; then what keeps the newer
 * versions, and the command that drops them on purpose. A project the
 * caller can't read is named as that, with nothing else.
 */
export async function stoppedText(
  client: KindgiClient,
  stops: readonly DeployCheckStop[],
  words: StopWords,
): Promise<string> {
  const names = await projectNames(client, stops);
  const rows = stops.map((s) => [
    s.blockId,
    s.inFiles,
    `${s.runs.version}  ${whereText(s, names)}`,
  ]);
  const header = ['Block', `In ${words.ours}`, 'Runs now'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const row = (cells: readonly string[]) =>
    `  ${cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('   ')
      .trimEnd()}`;
  const prs = [...new Set(stops.flatMap((s) => (s.pr !== undefined ? [s.pr.url] : [])))];
  const keep = prs.length > 0 ? `merge ${prs.join(', ')}, or ${words.keep}` : words.keep;
  const replace = stops.map((s) => `--replace=${s.blockId}`).join(' ');
  return [
    `✗ Stopped: this ${words.what} would put back older blocks than run now.`,
    '',
    row(header),
    ...rows.map(row),
    '',
    `  ${words.nothingDone}`,
    `  To keep the newer versions:  ${keep}.`,
    `  To drop them on purpose:  ${words.command} ${replace} --reason=<why>`,
    '',
  ].join('\n');
}

/** Where the newer version runs: pinned (for a segment), or Latest, with who and when when the stop says. */
function whereText(stop: DeployCheckStop, names: ReadonlyMap<string, string>): string {
  const { runs } = stop;
  if (runs.projectId === undefined) return "in a project you can't read";
  const project = names.get(runs.projectId) ?? runs.projectId;
  const who = runs.by !== undefined ? (runs.by.name ?? runs.by.id) : undefined;
  const when = runs.at !== undefined ? runs.at.slice(5, 10) : undefined;
  if (runs.follows === 'latest') {
    const said = [who, when].filter((p) => p !== undefined).join(', ');
    return `latest in ${project}${said !== '' ? ` (${said})` : ''}`;
  }
  const segment =
    runs.segment !== undefined && runs.segment.length > 0
      ? ` for ${runs.segment.map(({ key, value }) => `${key}=${value}`).join(', ')}`
      : '';
  return `pinned${segment} in ${project}${who !== undefined ? ` by ${who}` : ''}${when !== undefined ? `, ${when}` : ''}`;
}

/** Each named project's name, read once; one that can't be read keeps its id. */
async function projectNames(
  client: KindgiClient,
  stops: readonly DeployCheckStop[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [
    ...new Set(stops.flatMap((s) => (s.runs.projectId !== undefined ? [s.runs.projectId] : []))),
  ];
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        names.set(id, (await client.projects.get(id)).name);
      } catch {
        // The id stands in.
      }
    }),
  );
  return names;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import {
  type Correction,
  KindgiApiError,
  type KindgiClient,
  type ListPage,
  type SuggestedChange,
  type SuggestedChangeContent,
  type SuggestedChangeStatus,
} from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { renderJson } from '../output.js';
import { askPinFiles, pinFilesStderr } from '../pin-files-warning.js';
import {
  type TableSpec,
  integerFlag,
  listFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import { followTestRun, oneOfFlag } from './test-runs.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi suggested-changes`: suggested changes. New content for one data
 * block in what a project runs: made and checked on the project's test
 * set, then pinned (through the project's gate) or added as the project's
 * Latest.
 */

const STATUSES: readonly SuggestedChangeStatus[] = [
  'checking',
  'check-failed',
  'ready',
  'waiting-for-second-person',
  'pinned',
  'added-as-latest',
  'withdrawn',
];
export const OBJECTIVES = ['passRate', 'weightedPrecisionAtK'] as const;

/** The status `check --wait` waits through. */
const CHECKING: ReadonlySet<string> = new Set(['checking']);

/** How its version did on the check, then how the version it's built on did: `25/27 (now 23/27)`. */
function checkCell(p: SuggestedChange): string {
  const { with: mine, now } = p.check;
  if (mine?.passing === undefined) return p.check.status;
  const its = `${mine.passing}/${mine.of}`;
  return now?.passing === undefined ? its : `${its} (now ${now.passing}/${now.of})`;
}

const TABLE: TableSpec<ListPage<SuggestedChange>, SuggestedChange> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (p) => p.id },
    { header: 'AGENT', get: (p) => `${p.agentId}@${p.builtOn.version}` },
    { header: 'PROJECT', get: (p) => p.projectId ?? '-' },
    {
      header: 'CHANGE',
      get: (p) =>
        p.changes
          .map((c) =>
            c.kind === 'block' ? `${c.blockId}@${c.from}` : `code (deploy ${c.deploymentId})`,
          )
          .join(', '),
    },
    { header: 'STATUS', get: (p) => p.status },
    { header: 'CHECK', get: checkCell },
    { header: 'CREATED', get: (p) => p.createdAt },
  ],
};

export const IDEMPOTENCY_FLAG = {
  'idempotency-key': {
    type: 'string',
    description: "A retry with the same key returns the first call's result.",
  },
} as const;

export function idempotency(ctx: CommandContext): { idempotencyKey?: string } {
  const key = stringFlag(ctx, 'idempotency-key');
  return key !== undefined ? { idempotencyKey: key } : {};
}

function reasonFlag(ctx: CommandContext): { reason?: string } {
  const reason = stringFlag(ctx, 'reason');
  return reason !== undefined ? { reason } : {};
}

export function required(ctx: CommandContext, flag: string): string {
  const value = stringFlag(ctx, flag);
  if (value === undefined) throw new UsageError(`--${flag} is required`);
  return value;
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    'List suggested changes, newest first: only those of agents you can read. A status filter is applied after the page is read, so a page can hold fewer than --limit.',
  usage:
    'kindgi suggested-changes list [--agent=<agent-id>] [--project=<project-id>] [--status=<status>] [--limit=<n>] [--cursor=<cursor>] [--table]',
  optionSpec: {
    agent: { type: 'string', description: "Only this agent's suggested changes." },
    project: { type: 'string', description: 'Only the suggested changes for this project.' },
    status: { type: 'string', description: `One of: ${STATUSES.join(', ')}.` },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'suggested-changes list',
      async () => {
        const agentId = stringFlag(ctx, 'agent');
        const projectId = stringFlag(ctx, 'project');
        const status = oneOfFlag(ctx, 'status', STATUSES);
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().suggestedChanges.list({
          ...(agentId !== undefined && { agentId }),
          ...(projectId !== undefined && { projectId }),
          ...(status !== undefined && { status }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
      },
      TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description:
    "Show a suggested change: its change (the block's content before and after), status, version, and its check: how its version and the version it's built on did on the project's test cases. A correction it fixes that its author has replaced since is named on stderr, with the live one that replaced it.",
  usage: 'kindgi suggested-changes get <suggested-change-id>',
  run: (ctx) =>
    runSdkRendered(ctx, 'suggested-changes get', async () => {
      const client = ctx.client();
      const suggested = await client.suggestedChanges.get(
        requiredPositional(ctx, 0, 'suggested-change-id'),
      );
      const rendered = renderJson(suggested, ctx.globals.format);
      if (ctx.globals.format === 'quiet') return rendered;
      return { ...rendered, stderr: await replacedFixes(client.corrections, suggested.fixes) };
    }),
};

/** How many of a suggested change's fixes are read at once. */
const FIXES_READ_AT_ONCE = 4;
/** The most replacements followed from a fixed correction to the live one. */
const REPLACEMENTS_FOLLOWED = 10;

/** A line for each fix that was replaced since, or couldn't be checked, in `fixes` order. */
async function replacedFixes(
  corrections: KindgiClient['corrections'],
  fixes: readonly string[],
): Promise<string> {
  let out = '';
  for (let start = 0; start < fixes.length; start += FIXES_READ_AT_ONCE) {
    const batch = fixes.slice(start, start + FIXES_READ_AT_ONCE);
    out += (await Promise.all(batch.map((id) => replacedFix(corrections, id)))).join('');
  }
  return out;
}

/**
 * A line for a correction the suggested change fixes that its author has
 * replaced since: `fixes` keeps the id it names, and this names the live
 * one, by following `supersededBy`. Empty for one not replaced, or not
 * found. When the runtime answers another error on the way, the line says
 * it couldn't be checked, and why.
 */
async function replacedFix(
  corrections: KindgiClient['corrections'],
  fixedId: string,
): Promise<string> {
  try {
    const fixed = await found(corrections, fixedId);
    if (fixed?.supersededBy === undefined) return '';
    let lastId = fixed.supersededBy;
    let last = await found(corrections, lastId);
    for (
      let followed = 1;
      last?.supersededBy !== undefined && followed < REPLACEMENTS_FOLLOWED;
      followed++
    ) {
      lastId = last.supersededBy;
      last = await found(corrections, lastId);
    }
    // Only a correction read and not replaced is named as the live one.
    return last === null || last.supersededBy !== undefined
      ? `${fixedId} (in fixes) was replaced by ${lastId}.\n`
      : `${fixedId} (in fixes) was replaced by ${lastId}, now ${last.status}.\n`;
  } catch (err) {
    if (!(err instanceof KindgiApiError)) throw err;
    return `${fixedId} (in fixes): couldn't check whether it was replaced: ${err.message}\n`;
  }
}

/** The correction, or `null` when the runtime has none by that id. */
async function found(
  corrections: KindgiClient['corrections'],
  correctionId: string,
): Promise<Correction | null> {
  try {
    return await corrections.get(correctionId);
  } catch (err) {
    if (err instanceof KindgiApiError && err.error.code === 'not-found') return null;
    throw err;
  }
}

/** `--values` (JSON, a settings block) or `--template` (text, a prompt block): exactly one. */
async function contentFrom(ctx: CommandContext): Promise<SuggestedChangeContent> {
  const values = stringFlag(ctx, 'values');
  const template = stringFlag(ctx, 'template');
  if (values !== undefined && template === undefined) {
    const parsed = await readJsonInput(values);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UsageError("--values must be a JSON object: the settings block's new values");
    }
    return { values: parsed as Readonly<Record<string, unknown>> };
  }
  if (template !== undefined && values === undefined) {
    const text = template.startsWith('@') ? await readFile(template.slice(1), 'utf8') : template;
    return { template: text };
  }
  throw new UsageError(
    "Give the new content, one of: --values=<json>|@<file> (a settings block) or --template=<text>|@<file> (the agent's instructions)",
  );
}

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    "Make a suggested change by hand: new content for one block in what the project runs (settings values, or the agent's instructions). Its block version and agent version are made, and it's checked on the project's test cases: it's `checking`. The same change on the same version for the same project returns the suggested change made before. Needs `publish` on the agent.",
  usage:
    'kindgi suggested-changes create --agent=<agent-id> --project=<project-id> --block=<block-id> (--values=<json>|@<file> | --template=<text>|@<file>) --why=<text> [--fixes=<correction-id>]…',
  optionSpec: {
    agent: { type: 'string', description: 'The agent.' },
    project: {
      type: 'string',
      description: "The project it's for: it's built on what the project runs.",
    },
    block: {
      type: 'string',
      description: "The data block to change; the project's version must pin it.",
    },
    values: {
      type: 'string',
      description: "A settings block's new values: a JSON object, inline or `@<file>`.",
    },
    template: {
      type: 'string',
      description: "The agent's instructions (a prompt block), new text: inline or `@<file>`.",
    },
    why: { type: 'string', description: 'What the change should fix, and why.' },
    fixes: {
      type: 'string',
      multiple: true,
      description: 'A correction the change fixes (repeatable).',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes create', async () => {
      const agentId = required(ctx, 'agent');
      const projectId = required(ctx, 'project');
      const block = required(ctx, 'block');
      const why = required(ctx, 'why');
      const content = await contentFrom(ctx);
      const fixes = listFlag(ctx, 'fixes');
      return await ctx.client().suggestedChanges.create({
        agentId,
        projectId,
        block,
        ...content,
        why,
        ...(fixes.length > 0 && { fixes }),
        ...idempotency(ctx),
      });
    }),
};

const check: LeafCommand = {
  kind: 'leaf',
  name: 'check',
  description:
    "Check a suggested change again on the project's test cases, frozen now, so new corrections count: its version and the version it's built on run the same cases. When the project now runs another version, it's rebuilt on that version first. The suggested change is `checking`, then `ready` (its check says how each did) or `check-failed`. Allowed when `ready` or `check-failed`. Needs `publish` on the agent.",
  usage: 'kindgi suggested-changes check <suggested-change-id> [--wait]',
  optionSpec: {
    wait: {
      type: 'boolean',
      description:
        'Wait until the check is done (at most 30 minutes), then print the suggested change.',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes check', async () => {
      const id = requiredPositional(ctx, 0, 'suggested-change-id');
      const suggestedChanges = ctx.client().suggestedChanges;
      const started = await suggestedChanges.check(id, { ...idempotency(ctx) });
      if (ctx.options.wait !== true) return started;
      return await followTestRun(id, {
        get: (suggestedChangeId) => suggestedChanges.get(suggestedChangeId),
        inProgress: CHECKING,
        showCommand: 'kindgi suggested-changes get',
      });
    }),
};

const pin: LeafCommand = {
  kind: 'leaf',
  name: 'pin',
  description:
    "Pin a suggested change's version for its project, through the project's release gate with its check. It prints the pin's answer: the pin, its test runs, the corrections a reused run marked `fixed` or reopened, and the suggested change under `suggestedChange`, `pinned` or `waiting-for-second-person` (a reviewer decides the approval: `kindgi approvals complete`). A refusal by the release gate lists every check, and leaves it `ready`. A project that follows Latest is refused (`409 pin-stops-latest`) unless --stop-following-latest; `kindgi suggested-changes add-as-latest` adds it as the project's Latest instead. Under `kindgi dev`, where a pin writes the version into the pack's files, it says on stderr which of the files it writes over that git hasn't committed, or that the pack isn't in git, from the pin check it asks first. Allowed when `ready`. Needs `pin` on the agent.",
  usage:
    'kindgi suggested-changes pin <suggested-change-id> [--reason=<text>] [--stop-following-latest]',
  optionSpec: {
    reason: { type: 'string', description: 'Why, kept on the request to pin it.' },
    'stop-following-latest': {
      type: 'boolean',
      description:
        'Pin even when it takes a project that follows Latest off it: that project then runs the pinned version, and no longer takes each new Latest. Without it, such a pin is refused (`409 pin-stops-latest`).',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'suggested-changes pin', async () => {
      const id = requiredPositional(ctx, 0, 'suggested-change-id');
      const client = ctx.client();
      const warned = await askPinFiles(() => pinCheck(client, id));
      const answer = await client.suggestedChanges.pin(id, {
        ...reasonFlag(ctx),
        ...(ctx.options['stop-following-latest'] === true && { stopFollowingLatest: true }),
        ...idempotency(ctx),
      });
      return {
        stdout: renderJson(answer, ctx.globals.format).stdout,
        stderr: pinFilesStderr(warned, ctx.globals.format),
      };
    }),
};

/**
 * The pin check for pinning suggested change `id`: its version, with the
 * test run its check ran it in, for the whole workspace. Under `kindgi
 * dev`, the one runtime whose check warns about the pack's files, a
 * suggested change is for the whole workspace.
 */
async function pinCheck(client: KindgiClient, id: string) {
  const suggested = await client.suggestedChanges.get(id);
  if (suggested.version === undefined) return {};
  const testRunId = suggested.check?.with?.testRunId;
  return client.agents.pinned.check(suggested.agentId, {
    version: suggested.version,
    scope: { kind: 'tenant' },
    ...(testRunId !== undefined && { testRunId }),
  });
}

const addAsLatest: LeafCommand = {
  kind: 'leaf',
  name: 'add-as-latest',
  description:
    "Add a suggested change's version as its project's Latest, for a project that runs its Latest: the project runs it from now on, with no release gate. The suggested change is `added-as-latest`. Allowed when `ready`. Needs `pin` on the agent.",
  usage: 'kindgi suggested-changes add-as-latest <suggested-change-id> [--reason=<text>]',
  optionSpec: {
    reason: { type: 'string', description: 'Why, kept on its `addedAsLatest`.' },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes add-as-latest', async () =>
      ctx.client().suggestedChanges.addAsLatest(requiredPositional(ctx, 0, 'suggested-change-id'), {
        ...reasonFlag(ctx),
        ...idempotency(ctx),
      }),
    ),
};

const withdraw: LeafCommand = {
  kind: 'leaf',
  name: 'withdraw',
  description:
    'Withdraw a suggested change: while `checking`, `check-failed` or `ready`, not while a second person decides its pin. Needs `publish` on the agent.',
  usage: 'kindgi suggested-changes withdraw <suggested-change-id> --reason=<text>',
  optionSpec: {
    reason: { type: 'string', description: 'Why, kept on the record (required).' },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes withdraw', async () =>
      ctx.client().suggestedChanges.withdraw(requiredPositional(ctx, 0, 'suggested-change-id'), {
        reason: required(ctx, 'reason'),
        ...idempotency(ctx),
      }),
    ),
};

export const suggestedChangesCommand: Command = {
  kind: 'group',
  name: 'suggested-changes',
  description:
    "Suggested changes: new content for a data block in what a project runs; checked on the project's test cases, then pinned through the project's release gate, or added as the project's Latest (list / get / create / check / pin / add-as-latest / withdraw).",
  subcommands: [list, get, create, check, pin, addAsLatest, withdraw],
};

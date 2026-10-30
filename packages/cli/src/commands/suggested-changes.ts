// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import type {
  ListPage,
  SuggestedChange,
  SuggestedChangeContent,
  SuggestedChangeStatus,
} from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import {
  type TableSpec,
  integerFlag,
  listFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
} from './helpers.js';
import { followTestRun, oneOfFlag } from './test-runs.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi suggested-changes`: suggested changes. New content for one data
 * block in what a project runs: drafted and checked on the project's test
 * set, then requested (a pin of its version through the project's gate).
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
export const OBJECTIVES = ['weightedYesShare', 'weightedPrecisionAtK'] as const;

/** The status `evaluate --wait` waits through. */
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
      header: 'BLOCK',
      get: (p) => p.changes.map((c) => `${c.blockId}@${c.from}`).join(', '),
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
    "Show a suggested change: its change (the block's content before and after), status, version, and its check: how its version and the version it's built on did on the project's test cases.",
  usage: 'kindgi suggested-changes get <suggested-change-id>',
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes get', async () =>
      ctx.client().suggestedChanges.get(requiredPositional(ctx, 0, 'suggested-change-id')),
    ),
};

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

const draft: LeafCommand = {
  kind: 'leaf',
  name: 'draft',
  description:
    "Draft a suggested change by hand: new content for one block in what the project runs (settings values, or the agent's instructions). Its block version and agent version are made, and it's checked on the project's test cases: it's `checking`. The same change on the same version for the same project returns the suggested change drafted before. Needs `publish` on the agent.",
  usage:
    'kindgi suggested-changes draft --agent=<agent-id> --project=<project-id> --block=<block-id> (--values=<json>|@<file> | --template=<text>|@<file>) --why=<text> [--correction=<correction-id>]…',
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
    correction: {
      type: 'string',
      multiple: true,
      description: 'A correction behind the change (repeatable): kept as evidence.',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes draft', async () => {
      const agentId = required(ctx, 'agent');
      const projectId = required(ctx, 'project');
      const block = required(ctx, 'block');
      const why = required(ctx, 'why');
      const content = await contentFrom(ctx);
      const fixes = listFlag(ctx, 'correction');
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

const evaluate: LeafCommand = {
  kind: 'leaf',
  name: 'evaluate',
  description:
    "Check a suggested change again on the project's test cases, frozen now, so new corrections count: its version and the version it's built on run the same cases. The suggested change is `checking`, then `ready` (its check says how each did) or `check-failed`. Allowed when `ready` or `check-failed`. Needs `publish` on the agent.",
  usage: 'kindgi suggested-changes evaluate <suggested-change-id> [--wait]',
  optionSpec: {
    wait: {
      type: 'boolean',
      description:
        'Wait until the check is done (at most 30 minutes), then print the suggested change.',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes evaluate', async () => {
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

const request: LeafCommand = {
  kind: 'leaf',
  name: 'request',
  description:
    "Ask to pin a suggested change's version for its project, through the project's release gate policy with its check. The suggested change is `pinned`, or `waiting-for-second-person` (a reviewer decides the approval: `kindgi approvals complete`); a refusal by the release gate policy lists every check, and leaves it `ready`. Allowed when `ready`, for a project that's pinned. Needs `promote` on the agent.",
  usage: 'kindgi suggested-changes request <suggested-change-id> [--reason=<text>]',
  optionSpec: {
    reason: { type: 'string', description: 'Why, kept on the request to make it live.' },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes request', async () =>
      ctx.client().suggestedChanges.pin(requiredPositional(ctx, 0, 'suggested-change-id'), {
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
    "Suggested changes: new content for a data block in what a project runs; checked on the project's test cases, then pinned through the project's release gate policy (list / get / draft / evaluate / request / withdraw).",
  subcommands: [list, get, draft, evaluate, request, withdraw],
};

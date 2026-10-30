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
import { SCOPE_FLAGS, SCOPE_USAGE, scopeCell, scopeFrom } from './agents.js';
import { GROUP_WEIGHTS, READS, followTestRun, oneOfFlag } from './test-runs.js';
import {
  type TableSpec,
  integerFlag,
  listFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi suggested-changes`: suggested changes. New content for one data
 * block an agent version pins, for one live scope: drafted, evaluated on
 * a test set, then requested (a pin of the candidate through the
 * scope's gate).
 */

const STATUSES: readonly SuggestedChangeStatus[] = [
  'draft',
  'evaluating',
  'evaluated',
  'not-better',
  'evaluation-failed',
  'in-review',
  'pinned',
  'refused',
  'rejected',
  'expired',
  'superseded',
  'rolled-back',
  'withdrawn',
];
const TIERS = ['settings-block', 'prompt-block'] as const;
export const OBJECTIVES = ['weightedYesShare', 'weightedPrecisionAtK'] as const;

/** The status `evaluate --wait` waits through. */
const EVALUATING: ReadonlySet<string> = new Set(['evaluating']);

/** A delta with its sign, `+0.120`; `-` before there is one. */
function deltaCell(p: SuggestedChange): string {
  const delta = p.evaluation?.delta;
  if (delta === undefined || delta === null) return '-';
  return `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`;
}

const TABLE: TableSpec<ListPage<SuggestedChange>, SuggestedChange> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (p) => p.id },
    { header: 'AGENT', get: (p) => `${p.agentId}@${p.fromVersion}` },
    { header: 'SCOPE', get: (p) => scopeCell(p.scope) },
    { header: 'BLOCK', get: (p) => `${p.change.blockId}@${p.change.fromVersion}` },
    { header: 'STATUS', get: (p) => p.status },
    { header: 'DELTA', get: deltaCell },
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
    'List suggested changes, newest first: only those of agents you can read. A scope flag keeps the suggested changes for exactly that scope. A status filter is applied after the page is read, so a page can hold fewer than --limit.',
  usage: `kindgi suggested-changes list [--agent=<agent-id>] [${SCOPE_USAGE}] [--tier=settings-block|prompt-block] [--status=<status>] [--limit=<n>] [--cursor=<cursor>] [--table]`,
  optionSpec: {
    agent: { type: 'string', description: "Only this agent's suggested changes." },
    ...SCOPE_FLAGS,
    tier: { type: 'string', description: '`settings-block` or `prompt-block`.' },
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
        const scope = scopeFrom(ctx, false);
        const tier = oneOfFlag(ctx, 'tier', TIERS);
        const status = oneOfFlag(ctx, 'status', STATUSES);
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().suggestedChanges.list({
          ...(agentId !== undefined && { agentId }),
          ...(scope !== undefined && { scope }),
          ...(tier !== undefined && { tier }),
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
    'Show a suggested change: its change, status, candidate versions, the run on the test cases it was evaluated on and its request to make it live.',
  usage: 'kindgi suggested-changes get <suggested-change-id>',
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes get', async () =>
      ctx.client().suggestedChanges.get(requiredPositional(ctx, 0, 'suggested-change-id')),
    ),
};

/** `--values` (JSON, a settings block) or `--template` (text, a prompt block): exactly one. */
async function contentFrom(
  ctx: CommandContext,
): Promise<{ tier: (typeof TIERS)[number]; content: SuggestedChangeContent }> {
  const values = stringFlag(ctx, 'values');
  const template = stringFlag(ctx, 'template');
  if (values !== undefined && template === undefined) {
    const parsed = await readJsonInput(values);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UsageError("--values must be a JSON object: the settings block's new values");
    }
    return {
      tier: 'settings-block',
      content: { values: parsed as Readonly<Record<string, unknown>> },
    };
  }
  if (template !== undefined && values === undefined) {
    const text = template.startsWith('@') ? await readFile(template.slice(1), 'utf8') : template;
    return { tier: 'prompt-block', content: { template: text } };
  }
  throw new UsageError(
    "Give the new content, one of: --values=<json>|@<file> (a settings block) or --template=<text>|@<file> (the agent's instructions)",
  );
}

const draft: LeafCommand = {
  kind: 'leaf',
  name: 'draft',
  description:
    "Draft a suggested change by hand: new content for one block the agent version pins (settings values, or the agent's instructions), for one scope. The same change from the same version for the same scope returns the suggested change drafted before. Needs `publish` on the agent.",
  usage: `kindgi suggested-changes draft --agent=<agent-id> --from-version=<semver> ${SCOPE_USAGE} --block=<block-id> (--values=<json>|@<file> | --template=<text>|@<file>) --hypothesis=<text> [--correction=<correction-id>]…`,
  optionSpec: {
    agent: { type: 'string', description: 'The agent.' },
    'from-version': {
      type: 'string',
      description: 'The agent version the change applies to.',
    },
    ...SCOPE_FLAGS,
    block: { type: 'string', description: 'The data block to change; the version must pin it.' },
    values: {
      type: 'string',
      description: "A settings block's new values: a JSON object, inline or `@<file>`.",
    },
    template: {
      type: 'string',
      description: "The agent's instructions (a prompt block), new text: inline or `@<file>`.",
    },
    hypothesis: { type: 'string', description: 'What the change should improve, and why.' },
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
      const fromVersion = required(ctx, 'from-version');
      const scope = scopeFrom(ctx, true);
      const blockId = required(ctx, 'block');
      const hypothesis = required(ctx, 'hypothesis');
      const { tier, content } = await contentFrom(ctx);
      const fixes = listFlag(ctx, 'correction');
      return await ctx.client().suggestedChanges.create({
        agentId,
        fromVersion,
        scope,
        tier,
        change: { blockId, content },
        hypothesis,
        ...(fixes.length > 0 && { evidence: { fixes } }),
        ...idempotency(ctx),
      });
    }),
};

const evaluate: LeafCommand = {
  kind: 'leaf',
  name: 'evaluate',
  description:
    'Evaluate a suggested change on the test cases: a run on the test cases that tries the candidate against the version it changes. The first evaluation publishes the block version and derives the agent version; they serve no scope until made live, so the agent needs a live version for the whole tenant (`kindgi agents promote <agent-id> <version> --tenant`). The suggested change is `evaluating`, then `evaluated` (better), `not-better` or `evaluation-failed`. With `--rescore`, after people corrected the new answers of its replay runs: the latest evaluation scored again, counting those corrections, on the same replays (no other flag). Needs `publish` on the agent.',
  usage:
    'kindgi suggested-changes evaluate <suggested-change-id> --test-set=<test-set-id> [--objective=weightedYesShare|weightedPrecisionAtK] [--reads=recorded|live] [--repetitions=<n>] [--k=<n>] [--group-weights=as-recorded|experts-only] [--wait]\n       kindgi suggested-changes evaluate <suggested-change-id> --rescore [--wait]',
  optionSpec: {
    'test-set': { type: 'string', description: 'The test cases: a corrections test set, by id.' },
    objective: {
      type: 'string',
      description:
        'The metric that says whether the candidate is better: `weightedYesShare` (the default) or `weightedPrecisionAtK`.',
    },
    reads: {
      type: 'string',
      description:
        "Whether replayed reads use the past run's results when it has them (`recorded`, the default) or run live.",
    },
    repetitions: {
      type: 'string',
      description:
        'Run each case this many times (1 to 10, default 1): a delta counts as better only above the spread.',
    },
    k: {
      type: 'string',
      description: 'How many ranked items weighted precision@k looks at (1 to 100, default 10).',
    },
    'group-weights': {
      type: 'string',
      description:
        '`as-recorded` (the default) or `experts-only`: only corrections in expert groups count.',
    },
    rescore: {
      type: 'boolean',
      description:
        "Score the latest evaluation's replays again, with what people corrected on them since: the same version of the test cases and settings, nothing replayed.",
    },
    wait: {
      type: 'boolean',
      description:
        'Wait until the evaluation is done (at most 30 minutes), then print the suggested change.',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'suggested-changes evaluate', async () => {
      const id = requiredPositional(ctx, 0, 'suggested-change-id');
      const suggestedChanges = ctx.client().suggestedChanges;
      const follow = () =>
        followTestRun(id, {
          get: (suggestedChangeId) => suggestedChanges.get(suggestedChangeId),
          inProgress: EVALUATING,
          showCommand: 'kindgi suggested-changes get',
        });
      if (ctx.options.rescore === true) {
        const set = COMPARISON_FLAGS.filter((flag) => ctx.options[flag] !== undefined);
        if (set.length > 0) {
          throw new UsageError(
            `--rescore cannot be combined with --${set[0]}: it reruns the latest evaluation's version of the test cases and settings`,
          );
        }
        const started = await suggestedChanges.rescore(id, { ...idempotency(ctx) });
        return ctx.options.wait === true ? await follow() : started;
      }
      const testSetId = required(ctx, 'test-set');
      const objective = oneOfFlag(ctx, 'objective', OBJECTIVES);
      const reads = oneOfFlag(ctx, 'reads', READS);
      const groupWeights = oneOfFlag(ctx, 'group-weights', GROUP_WEIGHTS);
      const repetitions = integerFlag(ctx, 'repetitions');
      const k = integerFlag(ctx, 'k');
      const started = await suggestedChanges.evaluate(id, {
        testSetId,
        ...(objective !== undefined && { objective }),
        ...(reads !== undefined && { reads }),
        ...(repetitions !== undefined && { repetitions }),
        ...(k !== undefined && { k }),
        ...(groupWeights !== undefined && { groupWeights }),
        ...idempotency(ctx),
      });
      return ctx.options.wait === true ? await follow() : started;
    }),
};

/** The evaluate flags a rescore takes from the evaluation it rescores. */
const COMPARISON_FLAGS = [
  'test-set',
  'objective',
  'reads',
  'repetitions',
  'k',
  'group-weights',
] as const;

const request: LeafCommand = {
  kind: 'leaf',
  name: 'request',
  description:
    "Ask to make a suggested change live: its candidate version, for its scope, through the scope's release gate policy with its evaluation. The suggested change is `pinned`, or `in-review` (a reviewer decides the approval to make it live: `kindgi approvals complete`); a refusal by the release gate policy lists every check. Allowed once evaluated, also when `not-better`: the release gate policy decides. Needs `promote` on the agent.",
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
    'Withdraw a suggested change before review, or after its request to make it live was refused, superseded or expired. Needs `publish` on the agent.',
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
    "Suggested changes: new content for a data block an agent pins, for one scope; evaluated on the test cases, then made live through the scope's release gate policy (list / get / draft / evaluate / request / withdraw).",
  subcommands: [list, get, draft, evaluate, request, withdraw],
};

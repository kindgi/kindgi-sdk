// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import type {
  FixProposal,
  FixProposalStatus,
  ImprovementPass,
  ListPage,
  ProposalContent,
} from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { SCOPE_FLAGS, SCOPE_USAGE, scopeCell, scopeFrom } from './agents.js';
import { CLASS_WEIGHTS, READS, followEvalRun, oneOfFlag } from './eval-runs.js';
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
 * `kindgi proposals`: improvement proposals. New content for one data
 * block an agent version pins, for one live scope: drafted, evaluated on
 * a test set, then requested (a promotion of the candidate through the
 * scope's gate), and rolled back if need be.
 */

const STATUSES: readonly FixProposalStatus[] = [
  'draft',
  'evaluating',
  'evaluated',
  'not-better',
  'evaluation-failed',
  'in-review',
  'promoted',
  'refused',
  'rejected',
  'expired',
  'superseded',
  'rolled-back',
  'withdrawn',
];
const TIERS = ['settings-block', 'prompt-block'] as const;
const OBJECTIVES = ['weightedYesShare', 'weightedPrecisionAtK'] as const;

/** The status `evaluate --wait` waits through. */
const EVALUATING: ReadonlySet<string> = new Set(['evaluating']);

/** A delta with its sign, `+0.120`; `-` before there is one. */
function deltaCell(p: FixProposal): string {
  const delta = p.evaluation?.delta;
  if (delta === undefined || delta === null) return '-';
  return `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`;
}

const TABLE: TableSpec<ListPage<FixProposal>, FixProposal> = {
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

const IDEMPOTENCY_FLAG = {
  'idempotency-key': {
    type: 'string',
    description: "A retry with the same key returns the first call's result.",
  },
} as const;

function idempotency(ctx: CommandContext): { idempotencyKey?: string } {
  const key = stringFlag(ctx, 'idempotency-key');
  return key !== undefined ? { idempotencyKey: key } : {};
}

function reasonFlag(ctx: CommandContext): { reason?: string } {
  const reason = stringFlag(ctx, 'reason');
  return reason !== undefined ? { reason } : {};
}

function required(ctx: CommandContext, flag: string): string {
  const value = stringFlag(ctx, flag);
  if (value === undefined) throw new UsageError(`--${flag} is required`);
  return value;
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    'List improvement proposals, newest first: only those of agents you can read. A scope flag keeps the proposals for exactly that scope. A status filter is applied after the page is read, so a page can hold fewer than --limit.',
  usage: `kindgi proposals list [--agent=<agent-id>] [${SCOPE_USAGE}] [--tier=settings-block|prompt-block] [--status=<status>] [--limit=<n>] [--cursor=<cursor>] [--table]`,
  optionSpec: {
    agent: { type: 'string', description: "Only this agent's proposals." },
    ...SCOPE_FLAGS,
    tier: { type: 'string', description: '`settings-block` or `prompt-block`.' },
    status: { type: 'string', description: `One of: ${STATUSES.join(', ')}.` },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'proposals list',
      async () => {
        const agentId = stringFlag(ctx, 'agent');
        const scope = scopeFrom(ctx, false);
        const tier = oneOfFlag(ctx, 'tier', TIERS);
        const status = oneOfFlag(ctx, 'status', STATUSES);
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().proposals.list({
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
    'Show a proposal: its change, status, candidate versions, the comparison it was evaluated on and its promotion.',
  usage: 'kindgi proposals get <proposal-id>',
  run: (ctx) =>
    runSdk(ctx, 'proposals get', async () =>
      ctx.client().proposals.get(requiredPositional(ctx, 0, 'proposal-id')),
    ),
};

/** `--values` (JSON, a settings block) or `--template` (text, a prompt block): exactly one. */
async function contentFrom(
  ctx: CommandContext,
): Promise<{ tier: (typeof TIERS)[number]; content: ProposalContent }> {
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
    'Give the new content, one of: --values=<json>|@<file> (a settings block) or --template=<text>|@<file> (a prompt block)',
  );
}

const draft: LeafCommand = {
  kind: 'leaf',
  name: 'draft',
  description:
    'Draft a proposal by hand: new content for one block the agent version pins (settings values, or a prompt template), for one scope. The same change from the same version for the same scope returns the proposal drafted before. Needs `publish` on the agent.',
  usage: `kindgi proposals draft --agent=<agent-id> --from-version=<semver> ${SCOPE_USAGE} --block=<block-id> (--values=<json>|@<file> | --template=<text>|@<file>) --hypothesis=<text> [--judgment=<judgment-id>]…`,
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
      description: "A prompt block's new template: text, inline or `@<file>`.",
    },
    hypothesis: { type: 'string', description: 'What the change should improve, and why.' },
    judgment: {
      type: 'string',
      multiple: true,
      description: 'A judgment behind the change (repeatable): kept as evidence.',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals draft', async () => {
      const agentId = required(ctx, 'agent');
      const fromVersion = required(ctx, 'from-version');
      const scope = scopeFrom(ctx, true);
      const blockId = required(ctx, 'block');
      const hypothesis = required(ctx, 'hypothesis');
      const { tier, content } = await contentFrom(ctx);
      const judgmentIds = listFlag(ctx, 'judgment');
      return await ctx.client().proposals.create({
        agentId,
        fromVersion,
        scope,
        tier,
        change: { blockId, content },
        hypothesis,
        ...(judgmentIds.length > 0 && { evidence: { judgmentIds } }),
        ...idempotency(ctx),
      });
    }),
};

const evaluate: LeafCommand = {
  kind: 'leaf',
  name: 'evaluate',
  description:
    'Evaluate a proposal on a test set: a comparison of the candidate with the version it changes. The first evaluation publishes the block version and derives the agent version; they serve no scope until promoted, so the agent needs a live version for the whole tenant (`kindgi agents promote <agent-id> <version> --tenant`). The proposal is `evaluating`, then `evaluated` (better), `not-better` or `evaluation-failed`. Needs `publish` on the agent.',
  usage:
    'kindgi proposals evaluate <proposal-id> --test-set=<suite-id> [--objective=weightedYesShare|weightedPrecisionAtK] [--reads=recorded|live] [--repetitions=<n>] [--k=<n>] [--class-weights=as-recorded|restricted-only] [--wait]',
  optionSpec: {
    'test-set': { type: 'string', description: 'The test set: a judged eval suite, by id.' },
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
    'class-weights': {
      type: 'string',
      description:
        '`as-recorded` (the default) or `restricted-only`: only judgments of restricted judge classes count.',
    },
    wait: {
      type: 'boolean',
      description:
        'Wait until the evaluation is done (at most 30 minutes), then print the proposal.',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals evaluate', async () => {
      const id = requiredPositional(ctx, 0, 'proposal-id');
      const suiteId = required(ctx, 'test-set');
      const objective = oneOfFlag(ctx, 'objective', OBJECTIVES);
      const reads = oneOfFlag(ctx, 'reads', READS);
      const classWeights = oneOfFlag(ctx, 'class-weights', CLASS_WEIGHTS);
      const repetitions = integerFlag(ctx, 'repetitions');
      const k = integerFlag(ctx, 'k');
      const proposals = ctx.client().proposals;
      const started = await proposals.evaluate(id, {
        suiteId,
        ...(objective !== undefined && { objective }),
        ...(reads !== undefined && { reads }),
        ...(repetitions !== undefined && { repetitions }),
        ...(k !== undefined && { k }),
        ...(classWeights !== undefined && { classWeights }),
        ...idempotency(ctx),
      });
      if (ctx.options.wait !== true) return started;
      return await followEvalRun(id, {
        get: (proposalId) => proposals.get(proposalId),
        inProgress: EVALUATING,
        showCommand: 'kindgi proposals get',
      });
    }),
};

const request: LeafCommand = {
  kind: 'leaf',
  name: 'request',
  description:
    "Request a proposal's promotion: its candidate version, for its scope, through the scope's gate with its evaluation. The proposal is `promoted`, or `in-review` (a reviewer decides the promotion's approval: `kindgi approvals complete`); a gate refusal lists every check. Allowed once evaluated, also when `not-better`: the gate decides. Needs `promote` on the agent.",
  usage: 'kindgi proposals request <proposal-id> [--reason=<text>]',
  optionSpec: {
    reason: { type: 'string', description: 'Why, kept on the promotion.' },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals request', async () =>
      ctx.client().proposals.request(requiredPositional(ctx, 0, 'proposal-id'), {
        ...reasonFlag(ctx),
        ...idempotency(ctx),
      }),
    ),
};

const rollback: LeafCommand = {
  kind: 'leaf',
  name: 'rollback',
  description:
    'Roll back a promoted proposal: its scope goes back to the version that served it before. The proposal and its versions stay, as history. Needs `promote` on the agent.',
  usage: 'kindgi proposals rollback <proposal-id> [--reason=<text>]',
  optionSpec: {
    reason: { type: 'string', description: 'Why, kept on the record.' },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals rollback', async () =>
      ctx.client().proposals.rollback(requiredPositional(ctx, 0, 'proposal-id'), {
        ...reasonFlag(ctx),
        ...idempotency(ctx),
      }),
    ),
};

const withdraw: LeafCommand = {
  kind: 'leaf',
  name: 'withdraw',
  description:
    'Withdraw a proposal before review, or after its promotion was refused, superseded or expired. Needs `publish` on the agent.',
  usage: 'kindgi proposals withdraw <proposal-id> --reason=<text>',
  optionSpec: {
    reason: { type: 'string', description: 'Why, kept on the record (required).' },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals withdraw', async () =>
      ctx.client().proposals.withdraw(requiredPositional(ctx, 0, 'proposal-id'), {
        reason: required(ctx, 'reason'),
        ...idempotency(ctx),
      }),
    ),
};

/** The statuses `improve --wait` waits through. */
const PASS_RUNNING: ReadonlySet<string> = new Set(['running']);

/** Dollars to the cent, as the console shows them: `$0.84`. */
function costCell(costUsd: string): string {
  const n = Number(costUsd);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${costUsd}`;
}

/** What a pass found, in a table cell. */
function outcomeCell(p: ImprovementPass): string {
  const o = p.outcome;
  if (o === undefined) return p.status === 'running' ? 'running' : '-';
  if (o.kind === 'proposed') return `proposed ${o.proposalId ?? ''}`.trim();
  if (o.kind === 'nothing-found') return 'nothing better';
  return 'failed';
}

const PASSES_TABLE: TableSpec<ListPage<ImprovementPass>, ImprovementPass> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (p) => p.id },
    { header: 'AGENT', get: (p) => `${p.agentId}@${p.fromVersion}` },
    { header: 'SCOPE', get: (p) => scopeCell(p.scope) },
    { header: 'STATUS', get: (p) => p.status },
    { header: 'CANDIDATES', get: (p) => String(p.candidatesEvaluated) },
    { header: 'COST', get: (p) => costCell(p.costUsd) },
    { header: 'OUTCOME', get: outcomeCell },
    { header: 'STARTED', get: (p) => p.createdAt },
  ],
};

/** A positive number flag; `undefined` when absent. */
function numberFlag(ctx: CommandContext, name: string): number | undefined {
  const raw = stringFlag(ctx, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new UsageError(`--${name} must be a positive number, got '${raw}'`);
  return n;
}

const improve: LeafCommand = {
  kind: 'leaf',
  name: 'improve',
  description:
    "Ask the runtime to look for better values for an agent version's tunable settings for a scope, within a budget. It searches on part of the test set and proves its best candidate on the rest; if that candidate is better, it writes a proposal, which a reviewer decides (`kindgi proposals request`). Answers at once with the pass; `--wait` waits for its outcome. Needs `publish` on the agent.",
  usage: `kindgi proposals improve --agent=<agent-id> ${SCOPE_USAGE} --test-set=<suite-id> [--from-version=<semver>] [--objective=weightedYesShare|weightedPrecisionAtK] [--max-cost=<usd>] [--max-candidates=<n>] [--wait]`,
  optionSpec: {
    agent: { type: 'string', description: 'The agent.' },
    ...SCOPE_FLAGS,
    'test-set': {
      type: 'string',
      description: 'The judged test set to search and prove on, by id.',
    },
    'from-version': {
      type: 'string',
      description: 'The version whose settings it tunes (default: the one serving the scope).',
    },
    objective: {
      type: 'string',
      description: 'What better means: `weightedYesShare` (the default) or `weightedPrecisionAtK`.',
    },
    'max-cost': {
      type: 'string',
      description: 'The most its comparisons may cost, in US dollars (default 5).',
    },
    'max-candidates': {
      type: 'string',
      description: 'The most candidates it compares (default 30).',
    },
    wait: {
      type: 'boolean',
      description: 'Wait until the pass is done (at most 30 minutes), then print it.',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals improve', async () => {
      const agentId = required(ctx, 'agent');
      const scope = scopeFrom(ctx, true);
      const suiteId = required(ctx, 'test-set');
      const fromVersion = stringFlag(ctx, 'from-version');
      const objective = oneOfFlag(ctx, 'objective', OBJECTIVES);
      const maxCostUsd = numberFlag(ctx, 'max-cost');
      const maxCandidates = integerFlag(ctx, 'max-candidates');
      const client = ctx.client();
      const pass = await client.proposals.improve({
        agentId,
        scope,
        suiteId,
        ...(fromVersion !== undefined && { fromVersion }),
        ...(objective !== undefined && { objective }),
        ...((maxCostUsd !== undefined || maxCandidates !== undefined) && {
          budget: {
            ...(maxCostUsd !== undefined && { maxCostUsd }),
            ...(maxCandidates !== undefined && { maxCandidates }),
          },
        }),
        ...idempotency(ctx),
      });
      if (ctx.options.wait !== true) return pass;
      return await followEvalRun(pass.id, {
        get: (id) => client.improvementPasses.get(id),
        inProgress: PASS_RUNNING,
        showCommand: 'kindgi proposals passes get',
      });
    }),
};

const passesList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List improvement passes, newest first: only those of agents you can read.',
  usage:
    'kindgi proposals passes list [--agent=<agent-id>] [--limit=<n>] [--cursor=<cursor>] [--table]',
  optionSpec: {
    agent: { type: 'string', description: "Only this agent's passes." },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'proposals passes list',
      async () => {
        const agentId = stringFlag(ctx, 'agent');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().improvementPasses.list({
          ...(agentId !== undefined && { agentId }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
      },
      PASSES_TABLE,
    ),
};

const passesGet: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description:
    'Show an improvement pass: how many candidates it compared, what that cost, and what it found (the proposal it wrote, or why nothing).',
  usage: 'kindgi proposals passes get <pass-id>',
  run: (ctx) =>
    runSdk(ctx, 'proposals passes get', async () =>
      ctx.client().improvementPasses.get(requiredPositional(ctx, 0, 'pass-id')),
    ),
};

const passesCancel: LeafCommand = {
  kind: 'leaf',
  name: 'cancel',
  description: 'Stop a running improvement pass: it ends `cancelled` and writes no proposal.',
  usage: 'kindgi proposals passes cancel <pass-id>',
  optionSpec: { ...IDEMPOTENCY_FLAG },
  run: (ctx) =>
    runSdk(ctx, 'proposals passes cancel', async () =>
      ctx
        .client()
        .improvementPasses.cancel(requiredPositional(ctx, 0, 'pass-id'), idempotency(ctx)),
    ),
};

const passes: Command = {
  kind: 'group',
  name: 'passes',
  description: 'Improvement passes: the runtime looking for better settings (list / get / cancel).',
  subcommands: [passesList, passesGet, passesCancel],
};

export const proposalsCommand: Command = {
  kind: 'group',
  name: 'proposals',
  description:
    "Improvement proposals: new content for a data block an agent pins, for one scope; evaluated on a test set, then promoted through the scope's gate (list / get / draft / evaluate / request / rollback / withdraw / improve / passes).",
  subcommands: [list, get, draft, evaluate, request, rollback, withdraw, improve, passes],
};

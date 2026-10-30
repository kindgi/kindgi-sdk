// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ImprovementPass, ListPage } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { SCOPE_FLAGS, SCOPE_USAGE, scopeCell, scopeFrom } from './agents.js';
import { GROUP_WEIGHTS, followTestRun, oneOfFlag } from './test-runs.js';
import { type TableSpec, integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import { IDEMPOTENCY_FLAG, OBJECTIVES, idempotency, required } from './suggested-changes.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi proposals`: what is left of the old group, the Improve verbs
 * (`improve`, `passes`), which move with the Improve runs.
 */

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
  // Cancelled for a reason (a suspended project), not by a person: the reason.
  if (o === undefined) return p.status === 'running' ? 'running' : (p.cancelReason ?? '-');
  if (o.kind === 'proposed') return `proposed ${o.suggestedChangeId ?? ''}`.trim();
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

/** The improvement tiers a pass can tune. The runtime takes exactly one. */
const IMPROVE_TIERS = ['settings', 'prompt'] as const;

/** The provider and model for a prompt pass (`--provider`/`--model`): both or neither. */
function improveModel(
  ctx: CommandContext,
): { readonly providerId: string; readonly model: string } | undefined {
  const providerId = stringFlag(ctx, 'provider');
  const model = stringFlag(ctx, 'model');
  if (providerId === undefined && model === undefined) return undefined;
  if (providerId === undefined || model === undefined)
    throw new UsageError('--provider and --model go together: give both or neither.');
  return { providerId, model };
}

function assertImproveTier(
  tier: string | undefined,
  model: { readonly providerId: string; readonly model: string } | undefined,
  candidates: number | undefined,
): void {
  if (tier === 'prompt' && model === undefined)
    throw new UsageError('--tier=prompt needs --provider and --model.');
  if (tier !== 'prompt' && (model !== undefined || candidates !== undefined))
    throw new UsageError('--provider, --model and --drafts are for --tier=prompt.');
}

const improve: LeafCommand = {
  kind: 'leaf',
  name: 'improve',
  description:
    "Ask the runtime to look for better values for the settings an agent version marks as what Improve may change — or, with `--tier=prompt`, have a model draft new instructions — for a scope, within a budget. It searches on part of the test cases and checks its best candidate on the cases it didn't learn from; if that candidate is better, it writes a suggested change, which a reviewer decides (`kindgi suggested-changes request`). The Improve run works in one project: the test cases must be ones that project reaches, and its test runs run there. With `--project`, it's that project; with `--tenant` or `--org`, `--pass-project`, else the agent version's. Answers at once with the Improve run; `--wait` waits for its outcome. Needs `publish` on the agent, and `write` on the Improve run's project when it isn't the version's.",
  usage: `kindgi proposals improve --agent=<agent-id> ${SCOPE_USAGE} --test-set=<test-set-id> [--pass-project=<project-id>] [--from-version=<semver>] [--tier=settings|prompt] [--objective=weightedYesShare|weightedPrecisionAtK] [--group-weights=as-recorded|experts-only] [--provider=<id> --model=<model>] [--drafts=<n>] [--max-cost=<usd>] [--max-candidates=<n>] [--wait]`,
  optionSpec: {
    agent: { type: 'string', description: 'The agent.' },
    ...SCOPE_FLAGS,
    'test-set': {
      type: 'string',
      description: 'The test cases (a corrections test set) to search and check on, by id.',
    },
    'pass-project': {
      type: 'string',
      description:
        "The project the Improve run works in, by id, for a tenant or org scope (default: the agent version's). With `--project`, it's that project, and another is refused.",
    },
    'from-version': {
      type: 'string',
      description:
        'The version whose settings Improve may change (default: the one serving the scope).',
    },
    tier: {
      type: 'string',
      description:
        'What to improve: `settings` (the default) — values for the settings keys the version marks as what Improve may change — or `prompt`, where a model drafts new instructions (needs `--provider` and `--model`, and a drafted suggested change always waits for a reviewer).',
    },
    objective: {
      type: 'string',
      description: 'What better means: `weightedYesShare` (the default) or `weightedPrecisionAtK`.',
    },
    'group-weights': {
      type: 'string',
      description:
        "Which corrections the Improve run learns from: `as-recorded` (all groups) or `experts-only` (expert groups only). Omitted, it counts everyone until the test cases' project, its tenant, or the agent improved there has an expert group, then only those.",
    },
    provider: {
      type: 'string',
      description:
        'With `--tier=prompt`: the provider whose model drafts the instructions (with `--model`).',
    },
    model: {
      type: 'string',
      description:
        'With `--tier=prompt`: the model that drafts the instructions (with `--provider`).',
    },
    drafts: {
      type: 'string',
      description:
        'With `--tier=prompt`: how many drafts of the instructions to write (1–5, default 3).',
    },
    'max-cost': {
      type: 'string',
      description: 'The most its runs on the test cases may cost, in US dollars (default 5).',
    },
    'max-candidates': {
      type: 'string',
      description: 'The most candidates it tries (default 30).',
    },
    wait: {
      type: 'boolean',
      description: 'Wait until the Improve run is done (at most 30 minutes), then print it.',
    },
    ...IDEMPOTENCY_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals improve', async () => {
      const agentId = required(ctx, 'agent');
      const scope = scopeFrom(ctx, true);
      const testSetId = required(ctx, 'test-set');
      const fromVersion = stringFlag(ctx, 'from-version');
      const passProject = stringFlag(ctx, 'pass-project');
      const tier = oneOfFlag(ctx, 'tier', IMPROVE_TIERS);
      const objective = oneOfFlag(ctx, 'objective', OBJECTIVES);
      const groupWeights = oneOfFlag(ctx, 'group-weights', GROUP_WEIGHTS);
      const model = improveModel(ctx);
      const candidates = integerFlag(ctx, 'drafts');
      const maxCostUsd = numberFlag(ctx, 'max-cost');
      const maxCandidates = integerFlag(ctx, 'max-candidates');
      assertImproveTier(tier, model, candidates);
      const client = ctx.client();
      const pass = await client.proposals.improve({
        agentId,
        scope,
        testSetId,
        ...(passProject !== undefined && { projectId: passProject }),
        ...(fromVersion !== undefined && { fromVersion }),
        ...(tier !== undefined && { tiers: [tier] }),
        ...(objective !== undefined && { objective }),
        ...(groupWeights !== undefined && { groupWeights }),
        ...(model !== undefined && { model }),
        ...(candidates !== undefined && { candidates }),
        ...((maxCostUsd !== undefined || maxCandidates !== undefined) && {
          budget: {
            ...(maxCostUsd !== undefined && { maxCostUsd }),
            ...(maxCandidates !== undefined && { maxCandidates }),
          },
        }),
        ...idempotency(ctx),
      });
      if (ctx.options.wait !== true) return pass;
      return await followTestRun(pass.id, {
        get: (id) => client.improvementPasses.get(id),
        inProgress: PASS_RUNNING,
        showCommand: 'kindgi proposals passes get',
      });
    }),
};

const passesList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List Improve runs, newest first: only those of agents you can read.',
  usage:
    'kindgi proposals passes list [--agent=<agent-id>] [--limit=<n>] [--cursor=<cursor>] [--table]',
  optionSpec: {
    agent: { type: 'string', description: "Only this agent's Improve runs." },
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
    'Show an Improve run: how many candidates it tried, what that cost, and what it found (the suggested change it wrote, or why nothing).',
  usage: 'kindgi proposals passes get <pass-id>',
  run: (ctx) =>
    runSdk(ctx, 'proposals passes get', async () =>
      ctx.client().improvementPasses.get(requiredPositional(ctx, 0, 'pass-id')),
    ),
};

const passesCancel: LeafCommand = {
  kind: 'leaf',
  name: 'cancel',
  description: 'Stop a running Improve run: it ends `cancelled` and writes no suggested change.',
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
  description: 'Improve runs: the runtime looking for better settings (list / get / cancel).',
  subcommands: [passesList, passesGet, passesCancel],
};

export const proposalsCommand: Command = {
  kind: 'group',
  name: 'proposals',
  description: 'Improve runs: the runtime looking for better settings (improve / passes).',
  subcommands: [improve, passes],
};

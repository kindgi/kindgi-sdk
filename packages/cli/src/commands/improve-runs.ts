// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ImproveRun, ListPage } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { SCOPE_FLAGS, SCOPE_USAGE, scopeCell, scopeFrom } from './agents.js';
import { type TableSpec, integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import { IDEMPOTENCY_FLAG, OBJECTIVES, idempotency, required } from './suggested-changes.js';
import { GROUP_WEIGHTS, followTestRun, oneOfFlag } from './test-runs.js';
import type { Command, LeafCommand } from './types.js';

/** `kindgi improve runs`: start, list, get and cancel Improve runs. */

/** The statuses `improve runs start --wait` waits through. */
const IMPROVE_RUN_RUNNING: ReadonlySet<string> = new Set(['running']);

/** Dollars to the cent, as the console shows them: `$0.84`. */
function costCell(costUsd: string): string {
  const n = Number(costUsd);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${costUsd}`;
}

/** what an Improve run found, in a table cell. */
function outcomeCell(p: ImproveRun): string {
  const o = p.outcome;
  // Cancelled for a reason (a suspended project), not by a person: the reason.
  if (o === undefined) return p.status === 'running' ? 'running' : (p.cancelReason ?? '-');
  if (o.kind === 'suggested') return `suggested ${o.suggestedChangeId ?? ''}`.trim();
  if (o.kind === 'nothing-found') return 'nothing better';
  return 'failed';
}

const IMPROVE_RUNS_TABLE: TableSpec<ListPage<ImproveRun>, ImproveRun> = {
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

/** The improvement tiers an Improve run can tune. The runtime takes exactly one. */
const IMPROVE_TIERS = ['settings', 'prompt'] as const;

/** The provider and model for an Improve run on the prompt (`--provider`/`--model`): both or neither. */
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

const start: LeafCommand = {
  kind: 'leaf',
  name: 'start',
  description:
    "Ask the runtime to look for better values for the settings an agent version marks as what Improve may change — or, with `--tier=prompt`, have a model draft new instructions — for a scope, within a budget. It searches on part of the test cases and checks its best candidate on the cases it didn't learn from; if that candidate is better, it writes a suggested change, which a reviewer decides (`kindgi suggested-changes request`). The Improve run works in one project: the test cases must be ones that project reaches, and its test runs run there. With `--project`, it's that project; with `--tenant` or `--org`, `--run-project`, else the agent version's. Answers at once with the Improve run; `--wait` waits for its outcome. Needs `publish` on the agent, and `write` on the Improve run's project when it isn't the version's.",
  usage: `kindgi improve runs start --agent=<agent-id> ${SCOPE_USAGE} --test-set=<test-set-id> [--run-project=<project-id>] [--from-version=<semver>] [--tier=settings|prompt] [--objective=passRate|weightedPrecisionAtK] [--group-weights=as-recorded|experts-only] [--provider=<id> --model=<model>] [--drafts=<n>] [--max-cost=<usd>] [--max-candidates=<n>] [--wait]`,
  optionSpec: {
    agent: { type: 'string', description: 'The agent.' },
    ...SCOPE_FLAGS,
    'test-set': {
      type: 'string',
      description: 'The test cases (a corrections test set) to search and check on, by id.',
    },
    'run-project': {
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
      description: 'What better means: `passRate` (the default) or `weightedPrecisionAtK`.',
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
    runSdk(ctx, 'improve runs start', async () => {
      const agentId = required(ctx, 'agent');
      const scope = scopeFrom(ctx, true);
      const testSetId = required(ctx, 'test-set');
      const fromVersion = stringFlag(ctx, 'from-version');
      const runProject = stringFlag(ctx, 'run-project');
      const tier = oneOfFlag(ctx, 'tier', IMPROVE_TIERS);
      const objective = oneOfFlag(ctx, 'objective', OBJECTIVES);
      const groupWeights = oneOfFlag(ctx, 'group-weights', GROUP_WEIGHTS);
      const model = improveModel(ctx);
      const candidates = integerFlag(ctx, 'drafts');
      const maxCostUsd = numberFlag(ctx, 'max-cost');
      const maxCandidates = integerFlag(ctx, 'max-candidates');
      assertImproveTier(tier, model, candidates);
      const client = ctx.client();
      const improveRun = await client.improveRuns.start({
        agentId,
        scope,
        testSetId,
        ...(runProject !== undefined && { projectId: runProject }),
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
      if (ctx.options.wait !== true) return improveRun;
      return await followTestRun(improveRun.id, {
        get: (id) => client.improveRuns.get(id),
        inProgress: IMPROVE_RUN_RUNNING,
        showCommand: 'kindgi improve runs get',
      });
    }),
};

const runsList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List Improve runs, newest first: only those of agents you can read.',
  usage:
    'kindgi improve runs list [--agent=<agent-id>] [--limit=<n>] [--cursor=<cursor>] [--table]',
  optionSpec: {
    agent: { type: 'string', description: "Only this agent's Improve runs." },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'improve runs list',
      async () => {
        const agentId = stringFlag(ctx, 'agent');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().improveRuns.list({
          ...(agentId !== undefined && { agentId }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
      },
      IMPROVE_RUNS_TABLE,
    ),
};

const runsGet: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description:
    'Show an Improve run: how many candidates it tried, what that cost, and what it found (the suggested change it wrote, or why nothing).',
  usage: 'kindgi improve runs get <improve-run-id>',
  run: (ctx) =>
    runSdk(ctx, 'improve runs get', async () =>
      ctx.client().improveRuns.get(requiredPositional(ctx, 0, 'improve-run-id')),
    ),
};

const runsCancel: LeafCommand = {
  kind: 'leaf',
  name: 'cancel',
  description: 'Stop a running Improve run: it ends `cancelled` and writes no suggested change.',
  usage: 'kindgi improve runs cancel <improve-run-id>',
  optionSpec: { ...IDEMPOTENCY_FLAG },
  run: (ctx) =>
    runSdk(ctx, 'improve runs cancel', async () =>
      ctx
        .client()
        .improveRuns.cancel(requiredPositional(ctx, 0, 'improve-run-id'), idempotency(ctx)),
    ),
};

const runs: Command = {
  kind: 'group',
  name: 'runs',
  description:
    'Improve runs: the runtime looking for better settings (start / list / get / cancel).',
  subcommands: [start, runsList, runsGet, runsCancel],
};

export const improveCommand: Command = {
  kind: 'group',
  name: 'improve',
  description: 'Improve: the runtime looking for better settings, in Improve runs.',
  subcommands: [runs],
};

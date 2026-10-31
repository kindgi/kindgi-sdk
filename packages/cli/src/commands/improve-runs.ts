// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ImproveReadinessItem, ImproveRun, ImproveRunCheck, ListPage } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError, readinessFixWords } from '../errors.js';
import { type Column, type Rendered, renderJson, renderTable } from '../output.js';
import {
  ANSWER_NO_EXIT_CODE,
  type TableSpec,
  integerFlag,
  listFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import { IDEMPOTENCY_FLAG, OBJECTIVES, idempotency, required } from './suggested-changes.js';
import { GROUP_WEIGHTS, followTestRun, oneOfFlag } from './test-runs.js';
import type { Command, LeafCommand } from './types.js';

/** `kindgi improve runs`: check, start, list, get and cancel Improve runs. */

/** The statuses `improve runs start --wait` waits through. */
const IMPROVE_RUN_RUNNING: ReadonlySet<string> = new Set(['running']);

/** An Improve run's statuses, for `improve runs list --status`. */
const IMPROVE_RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;

/** Dollars to the cent, as the console shows them: `$0.84`. */
function costCell(costUsd: string): string {
  const n = Number(costUsd);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${costUsd}`;
}

/** What an Improve run found, in a table cell. */
function outcomeCell(p: ImproveRun): string {
  const o = p.outcome;
  // Cancelled for a reason (a suspended project), not by a person: the reason.
  if (o === undefined) return p.status === 'running' ? 'running' : (p.cancelReason ?? '-');
  switch (o.kind) {
    case 'suggested':
      return `suggested ${o.suggestedChangeId}`;
    case 'nothing-better':
      return 'nothing better';
    case 'cost-cap':
      return `cost cap (${costCell(o.spentUsd)})`;
    case 'failed':
      return 'failed';
    default:
      // A kind a newer runtime added: as it came.
      return (o as { readonly kind: string }).kind;
  }
}

const IMPROVE_RUNS_TABLE: TableSpec<ListPage<ImproveRun>, ImproveRun> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (p) => p.id },
    { header: 'AGENT', get: (p) => `${p.agentId}@${p.startsFrom.version}` },
    { header: 'PROJECT', get: (p) => p.projectId ?? '-' },
    { header: 'STATUS', get: (p) => p.status },
    { header: 'TRIED', get: (p) => String(p.tried) },
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

/** What an Improve run can try: the prompt block's wording, and the settings Improve may tune. */
const IMPROVE_TIERS = ['prompt', 'settings'] as const;
type ImproveTier = (typeof IMPROVE_TIERS)[number];

/** `--tier`, repeatable: the tiers named, each once; `undefined` for every tier that's ready. */
function tiersFlag(ctx: CommandContext): ImproveTier[] | undefined {
  const named = listFlag(ctx, 'tier');
  if (named.length === 0) return undefined;
  for (const tier of named) {
    if (!(IMPROVE_TIERS as readonly string[]).includes(tier)) {
      throw new UsageError(`--tier must be one of ${IMPROVE_TIERS.join(', ')}, got "${tier}"`);
    }
  }
  if (new Set(named).size !== named.length) {
    throw new UsageError('--tier names each tier once.');
  }
  return named as ImproveTier[];
}

/** The provider and model that draft the wording (`--provider`/`--model`): both or neither. */
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

/** The drafting flags are for the prompt tier: refused when the tiers named leave it out. */
function assertPromptFlags(
  tiers: readonly ImproveTier[] | undefined,
  model: { readonly providerId: string; readonly model: string } | undefined,
  candidates: number | undefined,
): void {
  if (
    tiers !== undefined &&
    !tiers.includes('prompt') &&
    (model !== undefined || candidates !== undefined)
  )
    throw new UsageError(
      '--provider, --model and --drafts are for the prompt tier: add --tier=prompt, or leave out --tier.',
    );
}

/** The start body from the flags: what `start` sends, and `--check` asks about. */
function startBody(ctx: CommandContext) {
  const agentId = required(ctx, 'agent');
  const projectId = required(ctx, 'project');
  const tiers = tiersFlag(ctx);
  const objective = oneOfFlag(ctx, 'objective', OBJECTIVES);
  const groupWeights = oneOfFlag(ctx, 'group-weights', GROUP_WEIGHTS);
  const model = improveModel(ctx);
  const candidates = integerFlag(ctx, 'drafts');
  const maxCostUsd = numberFlag(ctx, 'max-cost');
  const maxCandidates = integerFlag(ctx, 'max-candidates');
  assertPromptFlags(tiers, model, candidates);
  return {
    agentId,
    projectId,
    ...(tiers !== undefined && { tiers }),
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
  };
}

const READINESS_COLUMNS: readonly Column<ImproveReadinessItem>[] = [
  {
    header: 'ITEM',
    get: (i) => (i.count !== undefined ? `${i.key} (${i.count})` : i.key),
  },
  { header: 'STATUS', get: (i) => (i.missing ? 'missing' : 'ok') },
  { header: 'FIX', get: (i) => (i.fix !== undefined ? readinessFixWords(i.fix) : '') },
];

/** `--check --table`: each item a row, then whether it's ready, where it starts, the estimate and the month. */
function checkTable(check: ImproveRunCheck): Rendered {
  const { estimate, startsFrom, month } = check;
  const lines = [
    `Ready: ${check.ready ? 'yes' : 'no'}`,
    `Starts from: ${
      startsFrom === undefined
        ? 'none (no version of the agent runs in the project)'
        : `${startsFrom.version} (${startsFrom.follows === 'pin' ? 'pinned in the project' : "the agent's latest"})`
    }`,
    `Estimate: ${
      estimate.costUsd !== undefined
        ? costCell(estimate.costUsd)
        : 'none (the version has no cost history)'
    }, at most ${costCell(estimate.maxCostUsd)} (${estimate.basis.replays} replays)`,
    ...(month !== undefined
      ? [
          `This month: ${costCell(month.spentUsd)} of the Improve schedule's ${costCell(month.capUsd)}`,
        ]
      : []),
  ];
  return {
    stdout: `${renderTable(check.items, READINESS_COLUMNS).stdout}\n${lines.join('\n')}\n`,
    stderr: '',
  };
}

const start: LeafCommand = {
  kind: 'leaf',
  name: 'start',
  description:
    "Start an Improve run for an agent in a project. From the version the project runs, it tries new wording for the agent's prompt block (the prompt tier), new values for the settings it may tune (the settings tier), or both, on the project's test set, within a budget, learning from the project's corrections sorted to Improve. It keeps a change only when, on every case of the test set, it passes more cases than that version and fails none that passed, and writes it as a suggested change, which a reviewer decides (`kindgi suggested-changes pin`). `--check` says whether it's ready and what it's estimated to cost, and starts nothing; it exits 3 when it isn't ready. A start that isn't ready is refused, listing every missing item with its fix. Answers at once with the Improve run; `--wait` waits for its outcome. Needs `publish` on the agent.",
  usage:
    'kindgi improve runs start --agent=<agent-id> --project=<project-id> [--check] [--tier=prompt|settings]… [--objective=passRate|weightedPrecisionAtK] [--group-weights=as-recorded|experts-only] [--provider=<id> --model=<model>] [--drafts=<n>] [--max-cost=<usd>] [--max-candidates=<n>] [--wait]',
  optionSpec: {
    agent: { type: 'string', description: 'The agent.' },
    project: {
      type: 'string',
      description:
        "The project the Improve run works in, by id: it starts from the version the project runs, and learns from and is proven on the project's test set.",
    },
    check: {
      type: 'boolean',
      description:
        "Whether it's ready, and what it's estimated to cost: every item it needs, each missing one with its fix, the estimate, and this month's spend against the Improve schedule's cap. Starts nothing. Exits 3 when it isn't ready.",
    },
    tier: {
      type: 'string',
      multiple: true,
      description:
        "What to try: `prompt`, new wording for the agent's prompt block (a drafted suggested change always waits for a reviewer), or `settings`, values for the settings it may tune. Repeat it for both. Left out, every tier that's ready.",
    },
    objective: {
      type: 'string',
      description:
        'How candidates that pass equally are ranked: `passRate` (the default) or `weightedPrecisionAtK`.',
    },
    'group-weights': {
      type: 'string',
      description:
        'Which corrections the Improve run learns from: `as-recorded` (all groups) or `experts-only` (expert groups only). Omitted, it counts everyone until the project, its tenant, or the agent in the project has an expert group, then only those.',
    },
    provider: {
      type: 'string',
      description:
        "For the prompt tier: the provider whose model drafts the wording (with `--model`). Left out, the provider and model the version's model-settings block names draft it; with neither, the prompt tier isn't ready.",
    },
    model: {
      type: 'string',
      description: 'For the prompt tier: the model that drafts the wording (with `--provider`).',
    },
    drafts: {
      type: 'string',
      description: 'For the prompt tier: how many drafts of the wording to write (1–5, default 3).',
    },
    'max-cost': {
      type: 'string',
      description:
        "The most its search may cost, in US dollars (default 5). The proof of its best change runs after the search and isn't capped by it.",
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
    runSdkRendered(ctx, 'improve runs start', async () => {
      const body = startBody(ctx);
      const client = ctx.client();
      const format = ctx.globals.format;
      if (ctx.options.check === true) {
        if (ctx.options.wait === true || stringFlag(ctx, 'idempotency-key') !== undefined) {
          throw new UsageError(
            '--check starts nothing: --wait and --idempotency-key go with a start.',
          );
        }
        const check = await client.improveRuns.check(body);
        return {
          ...(format === 'table' ? checkTable(check) : renderJson(check, format)),
          ...(!check.ready && { exitCode: ANSWER_NO_EXIT_CODE }),
        };
      }
      const improveRun = await client.improveRuns.start({ ...body, ...idempotency(ctx) });
      if (ctx.options.wait !== true) return renderJson(improveRun, format);
      const ended = await followTestRun(improveRun.id, {
        get: (id) => client.improveRuns.get(id),
        inProgress: IMPROVE_RUN_RUNNING,
        showCommand: 'kindgi improve runs get',
      });
      return renderJson(ended, format);
    }),
};

const runsList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "List Improve runs, newest first: only those of agents you can read. `--table` shows each one's agent and the version it started from, its project, status, the candidates it tried, its cost and what it found.",
  usage:
    'kindgi improve runs list [--agent=<agent-id>] [--project=<project-id>] [--status=running|completed|failed|cancelled] [--limit=<n>] [--cursor=<cursor>] [--table]',
  optionSpec: {
    agent: { type: 'string', description: "Only this agent's Improve runs." },
    project: { type: 'string', description: 'Only the Improve runs in this project, by id.' },
    status: {
      type: 'string',
      description:
        'Only the Improve runs with this status: `running`, `completed`, `failed` or `cancelled`.',
    },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'improve runs list',
      async () => {
        const agentId = stringFlag(ctx, 'agent');
        const projectId = stringFlag(ctx, 'project');
        const status = oneOfFlag(ctx, 'status', IMPROVE_RUN_STATUSES);
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().improveRuns.list({
          ...(agentId !== undefined && { agentId }),
          ...(projectId !== undefined && { projectId }),
          ...(status !== undefined && { status }),
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
    'Show an Improve run: the version it started from, how many candidates it tried, what that cost, the corrections it took, and what it found (the suggested change it wrote, or why none).',
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
    'Improve runs: the runtime looking for better wording or settings for an agent in a project (start / list / get / cancel).',
  subcommands: [start, runsList, runsGet, runsCancel],
};

export const improveCommand: Command = {
  kind: 'group',
  name: 'improve',
  description: 'Improve: the runtime looking for better wording or settings, in Improve runs.',
  subcommands: [runs],
};

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { SchedulesClient } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { scopeCell } from './agents.js';
import {
  type TableSpec,
  integerFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  segmentsFlag,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

type SchedulePage = Awaited<ReturnType<SchedulesClient['list']>>;
type Schedule = SchedulePage['data'][number];
type FirePage = Awaited<ReturnType<SchedulesClient['fires']>>;
type Fire = FirePage['data'][number];
type RegisterInput = Parameters<SchedulesClient['register']>[0];

const PAGE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
  cursor: {
    type: 'string',
    description: "Resume after this cursor, from the previous page's `nextCursor`.",
  },
};

function page(ctx: CommandContext): { limit?: number; cursor?: string } {
  const limit = integerFlag(ctx, 'limit');
  const cursor = stringFlag(ctx, 'cursor');
  return {
    ...(limit !== undefined && { limit }),
    ...(cursor !== undefined && { cursor }),
  };
}

/** What a schedule runs, as one cell: `agent acme.digest`, `flow acme.nightly@1.0.0`, or `improve acme.scorer (tenant)`. */
function runs(s: Schedule): string {
  if (s.improve !== undefined) {
    return `improve ${s.improve.agentId} (${scopeCell(s.improve.scope as Parameters<typeof scopeCell>[0])})`;
  }
  if (s.agentId !== undefined) {
    return `agent ${s.agentId}${s.agentVersion !== undefined ? `@${s.agentVersion}` : ''}`;
  }
  return `flow ${s.flowId ?? '?'}@${s.flowVersion ?? '?'}`;
}

const SCHEDULES_TABLE: TableSpec<SchedulePage, Schedule> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (s) => s.scheduleId },
    { header: 'RUNS', get: runs },
    { header: 'CRON', get: (s) => s.cronExpression },
    { header: 'TIMEZONE', get: (s) => s.timezone ?? 'UTC' },
    { header: 'STATUS', get: (s) => s.status },
    { header: 'OWNER', get: (s) => s.owner?.displayName ?? s.owner?.id ?? '' },
    { header: 'NEXT', get: (s) => s.nextFireAt ?? '' },
    { header: 'LABEL', get: (s) => s.label ?? '' },
  ],
};

const FIRES_TABLE: TableSpec<FirePage, Fire> = {
  rows: (p) => p.data,
  columns: [
    { header: 'FIRED', get: (f) => f.firedAt },
    { header: 'FOR', get: (f) => (f.manual === true ? 'run-now' : (f.scheduledFor ?? '')) },
    { header: 'OUTCOME', get: (f) => f.outcome },
    {
      header: 'STARTED',
      get: (f) => f.runId ?? (f.passId !== undefined ? `pass ${f.passId}` : ''),
    },
    {
      header: 'NOTE',
      get: (f) =>
        f.detail ?? (f.missedCount !== undefined ? `stood in for ${f.missedCount} missed` : ''),
    },
  ],
};

const TARGET_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  agent: { type: 'string', description: 'Run this agent (at its live version, else the latest).' },
  'agent-version': { type: 'string', description: 'With --agent: run this exact version.' },
  flow: { type: 'string', description: 'Run this flow (with --flow-version).' },
  'flow-version': { type: 'string', description: 'With --flow: the flow version to run.' },
  improve: {
    type: 'string',
    description:
      'Start improvement passes on this agent (instead of runs), when enough new trusted "no" judgments have come in: for the project (--project), or a segment of it (--segment). `--input` takes the pass options, `threshold` and `monthlyCapUsd`.',
  },
  segment: {
    type: 'string',
    multiple: true,
    description:
      'With --improve and --project: a segment of the project, `key:value`; repeat it in order, coarse to fine.',
  },
};

const WHEN_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  cron: {
    type: 'string',
    description: 'A cron expression: `0 7 * * 1-5` (07:00 on weekdays), `@daily`, …',
  },
  timezone: {
    type: 'string',
    description: 'An IANA timezone, such as America/Toronto (default UTC).',
  },
  input: {
    type: 'string',
    description:
      'The input each run gets, as JSON or `@<file>`. An agent needs `{"userMessage": "…"}`; a flow takes its own input (default `{}`); --improve takes its pass options (`{"tiers": ["settings"], "threshold": {"judgments": 5, "runs": 3, "judges": 2}, "monthlyCapUsd": 20}`, the defaults).',
  },
  'catch-up': {
    type: 'string',
    description:
      'After a gap (the runtime was down): `latest` runs once for the latest missed time (default); `skip` drops them.',
  },
  overlap: {
    type: 'string',
    description: 'While the previous run is still going: `skip` (default) or `allow` another run.',
  },
  'starting-deadline': {
    type: 'string',
    description: 'Seconds a run may start late and still count as on time (default 600).',
  },
  label: { type: 'string', description: 'A short label.' },
};

/**
 * `--improve`'s scope: `--project` with its `--segment`s. A pass learns
 * from one project's runs, so its scope is that project or a segment of it.
 */
function improveScope(ctx: CommandContext): NonNullable<RegisterInput['improve']>['scope'] {
  const project = stringFlag(ctx, 'project');
  const segments = segmentsFlag(ctx);
  if (project === undefined) {
    throw new Error(
      '--improve needs its scope: --project=<id> [--segment=<key:value>]… (a pass learns from one project; promote to the tenant by hand after review)',
    );
  }
  return segments.length > 0
    ? { kind: 'segment', projectId: project, path: [...segments] }
    : { kind: 'project', projectId: project };
}

/** The target flags as body fields, when any is given. */
function targetFields(ctx: CommandContext): Partial<RegisterInput> {
  const improve = stringFlag(ctx, 'improve');
  if (improve !== undefined) {
    if (
      ['agent', 'agent-version', 'flow', 'flow-version'].some((f) => ctx.options[f] !== undefined)
    ) {
      throw new Error('--improve starts improvement passes: not with --agent or --flow');
    }
    return { improve: { agentId: improve, scope: improveScope(ctx) } };
  }
  const agent = stringFlag(ctx, 'agent');
  const agentVersion = stringFlag(ctx, 'agent-version');
  const flow = stringFlag(ctx, 'flow');
  const flowVersion = stringFlag(ctx, 'flow-version');
  return {
    ...(agent !== undefined && { agentId: agent }),
    ...(agentVersion !== undefined && { agentVersion }),
    ...(flow !== undefined && { flowId: flow }),
    ...(flowVersion !== undefined && { flowVersion }),
  };
}

/** The policy and label flags as body fields, when given. */
function policyFields(ctx: CommandContext): Partial<RegisterInput> {
  const catchUp = stringFlag(ctx, 'catch-up');
  const overlap = stringFlag(ctx, 'overlap');
  const deadline = integerFlag(ctx, 'starting-deadline');
  const label = stringFlag(ctx, 'label');
  return {
    ...(catchUp !== undefined && { catchUp: catchUp as NonNullable<RegisterInput['catchUp']> }),
    ...(overlap !== undefined && { overlap: overlap as NonNullable<RegisterInput['overlap']> }),
    ...(deadline !== undefined && { startingDeadlineSeconds: deadline }),
    ...(label !== undefined && { label }),
  };
}

async function configFields(
  ctx: CommandContext,
): Promise<{ cronExpression?: string; timezone?: string; input?: unknown }> {
  const cron = stringFlag(ctx, 'cron');
  const timezone = stringFlag(ctx, 'timezone');
  const input = stringFlag(ctx, 'input');
  return {
    ...(cron !== undefined && { cronExpression: cron }),
    ...(timezone !== undefined && { timezone }),
    ...(input !== undefined && { input: await readJsonInput(input) }),
  };
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List schedules.',
  usage:
    'kindgi schedules list [--project=<project-id>] [--status=active|paused] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    project: { type: 'string', description: "Only this project's schedules." },
    status: { type: 'string', description: 'Only `active` or only `paused` schedules.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'schedules list',
      async () => {
        const status = stringFlag(ctx, 'status');
        if (status !== undefined && status !== 'active' && status !== 'paused') {
          throw new Error('--status must be `active` or `paused`');
        }
        const projectId = stringFlag(ctx, 'project');
        return await ctx.client().schedules.list({
          ...page(ctx),
          ...(status !== undefined && { status }),
          ...(projectId !== undefined && { projectId }),
        });
      },
      SCHEDULES_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a schedule, with its next occurrences when asked.',
  usage: 'kindgi schedules get <schedule-id> [--upcoming=<n>]',
  optionSpec: {
    upcoming: { type: 'string', description: 'Also show the next N times it runs (1 to 20).' },
  },
  run: (ctx) =>
    runSdk(ctx, 'schedules get', async () => {
      const id = requiredPositional(ctx, 0, 'schedule-id');
      const upcoming = integerFlag(ctx, 'upcoming');
      return await ctx
        .client()
        .schedules.get(id, upcoming !== undefined ? { upcoming } : undefined);
    }),
};

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    "Run an agent or a flow on a schedule, or start improvement passes on an agent (--improve). Its runs act as you, checked again at every run; they're in your project's runs, naming the schedule.",
  usage:
    'kindgi schedules create --cron=<expr> (--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v> | --improve=<agent-id> --project=<id> [--segment=<key:value>]…) [--timezone=<tz>] [--input=<json-or-@file>] [--project=<project-id>] [--catch-up=latest|skip] [--overlap=skip|allow] [--starting-deadline=<s>] [--label=<text>]',
  optionSpec: {
    ...TARGET_FLAGS,
    ...WHEN_FLAGS,
    project: {
      type: 'string',
      description: "The schedule's project, by id (default: the tenant's Default project).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'schedules create', async () => {
      const config = await configFields(ctx);
      if (config.cronExpression === undefined) throw new Error('--cron=<expression> is required');
      const project = stringFlag(ctx, 'project');
      return await ctx.client().schedules.register({
        ...targetFields(ctx),
        config: { ...config, cronExpression: config.cronExpression },
        ...(project !== undefined && { projectId: project }),
        ...policyFields(ctx),
      } as RegisterInput);
    }),
};

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description: 'Change a schedule: when it runs, what it runs, or its policies.',
  usage:
    'kindgi schedules update <schedule-id> [--cron=<expr>] [--timezone=<tz>] [--input=<json-or-@file>] [--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v> | --improve=<agent-id> --project=<id> [--segment=<key:value>]…] [--catch-up=…] [--overlap=…] [--starting-deadline=<s>] [--label=<text>]',
  optionSpec: {
    ...TARGET_FLAGS,
    ...WHEN_FLAGS,
    project: {
      type: 'string',
      description: "With --improve: the scope's project (the schedule's own).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'schedules update', async () => {
      const id = requiredPositional(ctx, 0, 'schedule-id');
      const config = await configFields(ctx);
      return await ctx.client().schedules.update(id, {
        ...targetFields(ctx),
        ...(Object.keys(config).length > 0 && { config }),
        ...policyFields(ctx),
      });
    }),
};

function byId(
  name: string,
  description: string,
  call: (client: SchedulesClient, id: string) => Promise<unknown>,
): LeafCommand {
  return {
    kind: 'leaf',
    name,
    description,
    usage: `kindgi schedules ${name} <schedule-id>`,
    run: (ctx) =>
      runSdk(ctx, `schedules ${name}`, async () =>
        call(ctx.client().schedules, requiredPositional(ctx, 0, 'schedule-id')),
      ),
  };
}

const fires: LeafCommand = {
  kind: 'leaf',
  name: 'fires',
  description:
    "A schedule's history, newest first: each time it fired, the run it started, or why it was skipped, refused or failed.",
  usage: 'kindgi schedules fires <schedule-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'schedules fires',
      async () =>
        await ctx.client().schedules.fires(requiredPositional(ctx, 0, 'schedule-id'), page(ctx)),
      FIRES_TABLE,
    ),
};

export const schedulesCommand: Command = {
  kind: 'group',
  name: 'schedules',
  description:
    'Run agents and flows on a schedule: create, list, get, update, pause, resume, run-now, fires, take-ownership, unregister.',
  subcommands: [
    list,
    get,
    create,
    update,
    byId('pause', 'Pause a schedule: it stops running until resumed.', (s, id) => s.pause(id)),
    byId(
      'resume',
      'Resume a paused schedule from its next occurrence (the paused ones are not run).',
      (s, id) => s.resume(id),
    ),
    byId(
      'run-now',
      'Run a schedule now, outside its schedule (its next occurrence is unchanged).',
      (s, id) => s.runNow(id),
    ),
    fires,
    byId(
      'take-ownership',
      "Become a schedule's owner, so its runs act as you (for a schedule whose owner left).",
      (s, id) => s.takeOwnership(id),
    ),
    byId('unregister', 'Remove a schedule: it stops running.', (s, id) => s.unregister(id)),
  ],
};

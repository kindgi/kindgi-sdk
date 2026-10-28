// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { SchedulesClient } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { type Rendered, renderJson } from '../output.js';
import { scopeCell } from './agents.js';
import {
  TRIGGER_VERSIONS_TABLE,
  type TableSpec,
  allowUnattendedField,
  integerFlag,
  readJsonInput,
  requiredPositional,
  runAsFields,
  runSdk,
  runSdkRendered,
  runsAsCell,
  segmentsFlag,
  stringFlag,
  triggerVersionPositional,
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
    { header: 'VERSION', get: (s) => (s.version !== undefined ? String(s.version) : '') },
    { header: 'RUNS', get: runs },
    { header: 'CRON', get: (s) => s.cronExpression },
    { header: 'TIMEZONE', get: (s) => s.timezone ?? 'UTC' },
    { header: 'STATUS', get: (s) => s.status },
    { header: 'RUNS AS', get: (s) => runsAsCell(s.owner) },
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
      'Start Improve runs on this agent (instead of running it), when enough new corrections marking answers wrong have come in: for the project (--project), or a segment of it (--segment). `--input` takes the Improve options, `threshold` and `monthlyCapUsd`.',
  },
  segment: {
    type: 'string',
    multiple: true,
    description:
      'With --improve and --project: a segment of the project, `key:value`; repeat it in order, coarse to fine.',
  },
};

const WHEN_FLAGS = {
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
      'The input each run gets, as JSON or `@<file>`. An agent needs `{"userMessage": "…"}`; a flow takes its own input (default `{}`); --improve takes its Improve options (`{"tiers": ["settings"], "threshold": {"judgments": 5, "runs": 3, "judges": 2}, "monthlyCapUsd": 20}`, the defaults).',
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
} satisfies Readonly<Record<string, ParseArgsOption>>;

/**
 * `update`'s: the same flags (its type holds it to `WHEN_FLAGS`' keys), with
 * no defaults. A flag left out keeps the schedule's value.
 */
const UPDATE_WHEN_FLAGS: Readonly<Record<keyof typeof WHEN_FLAGS, ParseArgsOption>> = {
  cron: {
    type: 'string',
    description: 'A new cron expression: `0 7 * * 1-5` (07:00 on weekdays), `@daily`, …',
  },
  timezone: { type: 'string', description: 'A new IANA timezone, such as America/Toronto.' },
  input: {
    type: 'string',
    description:
      'The input each run gets from now on, as JSON or `@<file>`. An agent needs `{"userMessage": "…"}`; a flow takes its own input; --improve takes its Improve options.',
  },
  'catch-up': {
    type: 'string',
    description:
      'After a gap (the runtime was down): `latest` runs once for the latest missed time; `skip` drops them.',
  },
  overlap: {
    type: 'string',
    description: 'While the previous run is still going: `skip` or `allow` another run.',
  },
  'starting-deadline': {
    type: 'string',
    description: 'Seconds a run may start late and still count as on time.',
  },
  label: { type: 'string', description: 'A new short label.' },
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
      '--improve needs its scope: --project=<id> [--segment=<key:value>]… (an Improve run learns from one project; make its suggested change live for the tenant by hand after review)',
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
      throw new Error('--improve starts Improve runs: not with --agent or --flow');
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
  description:
    'Fetch a schedule as it is now, with its next occurrences when asked, or the version given.',
  usage: 'kindgi schedules get <schedule-id> [<version>] [--upcoming=<n>]',
  optionSpec: {
    upcoming: { type: 'string', description: 'Also show the next N times it runs (1 to 20).' },
  },
  run: (ctx) =>
    runSdk(ctx, 'schedules get', async () => {
      const id = requiredPositional(ctx, 0, 'schedule-id');
      const version = triggerVersionPositional(ctx, 1);
      const upcoming = integerFlag(ctx, 'upcoming');
      if (version !== undefined && upcoming !== undefined) {
        throw new UsageError("--upcoming doesn't go with a <version>: it shows the schedule's next times as it is now");
      }
      const schedulesClient = ctx.client().schedules;
      return version === undefined
        ? await schedulesClient.get(id, upcoming !== undefined ? { upcoming } : undefined)
        : await schedulesClient.getVersion(id, version);
    }),
};

/**
 * `--run-as`: the schedule's runs act as this service account, or as its
 * project's own account (`project`), not you. Shared by `create` and
 * `take-ownership`.
 */
const RUN_AS_FLAG: Readonly<Record<string, ParseArgsOption>> = {
  'run-as': {
    type: 'string',
    description:
      "A service account, by id, or `project`: the schedule's owner, so its runs act as that account from the next run that starts (not as you). `project` runs it as the project's own account, made the first time, and takes `admin` on the project. The project's own account runs only what the project's editors can. A named account takes `act_as`, and needs a role that runs what the schedule runs (editor on the target's project). Omit it to own the schedule yourself.",
  },
};

/** `--allow-unattended`, as `create` and `update` each word it. */
function allowUnattendedFlag(on: 'register' | 'update'): Record<string, ParseArgsOption> {
  return {
    'allow-unattended': {
      type: 'string',
      multiple: true,
      description: `A tool, by id, whose calls in this schedule's runs needn't wait for a person's yes, though the tool asks for one when no person started the run (repeatable; only tools its agent or flow calls, no wildcard). Needs \`admin\` on the schedule's project. The tenant's and the agent's approval rules still apply.${on === 'update' ? ' Replaces the list; `none` clears it; left out, the list is kept, and a new --agent or --flow must name it again (or `none`).' : ''}`,
    },
  };
}

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    "Run an agent or a flow on a schedule, or start Improve runs on an agent (--improve). It's personal: its runs act as you, and only you or a project admin can change it. With `--run-as=project`, it's shared and acts as the project's own account; with `--run-as=<service-account-id>`, as that service account. Who it acts as is checked again at every run; its runs are in your project's runs, naming the schedule.",
  usage:
    'kindgi schedules create --cron=<expr> (--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v> | --improve=<agent-id> --project=<id> [--segment=<key:value>]…) [--timezone=<tz>] [--input=<json-or-@file>] [--project=<project-id>] [--catch-up=latest|skip] [--overlap=skip|allow] [--starting-deadline=<s>] [--label=<text>] [--run-as=<service-account-id>|project] [--allow-unattended=<tool-id>]…',
  optionSpec: {
    ...TARGET_FLAGS,
    ...WHEN_FLAGS,
    project: {
      type: 'string',
      description: "The schedule's project, by id (default: the tenant's Default project).",
    },
    ...RUN_AS_FLAG,
    ...allowUnattendedFlag('register'),
  },
  run: (ctx) =>
    runSdk(ctx, 'schedules create', async () => {
      const config = await configFields(ctx);
      if (config.cronExpression === undefined) throw new Error('--cron=<expression> is required');
      const project = stringFlag(ctx, 'project');
      const runAs = stringFlag(ctx, 'run-as');
      return await ctx.client().schedules.register({
        ...targetFields(ctx),
        config: { ...config, cronExpression: config.cronExpression },
        ...(project !== undefined && { projectId: project }),
        ...policyFields(ctx),
        ...runAsFields(runAs),
        ...allowUnattendedField(ctx, 'register'),
      } as RegisterInput);
    }),
};

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description:
    "Change a schedule: when it runs, what it runs, its policies, or the tools its runs may call unattended. A flag left out keeps the schedule's value.",
  usage:
    'kindgi schedules update <schedule-id> [--cron=<expr>] [--timezone=<tz>] [--input=<json-or-@file>] [--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v> | --improve=<agent-id> --project=<id> [--segment=<key:value>]…] [--catch-up=…] [--overlap=…] [--starting-deadline=<s>] [--label=<text>] [--allow-unattended=<tool-id>|none]…',
  optionSpec: {
    ...TARGET_FLAGS,
    ...UPDATE_WHEN_FLAGS,
    project: {
      type: 'string',
      description: "With --improve: the scope's project (the schedule's own).",
    },
    ...allowUnattendedFlag('update'),
  },
  run: (ctx) =>
    runSdk(ctx, 'schedules update', async () => {
      const id = requiredPositional(ctx, 0, 'schedule-id');
      const config = await configFields(ctx);
      return await ctx.client().schedules.update(id, {
        ...targetFields(ctx),
        ...(Object.keys(config).length > 0 && { config }),
        ...policyFields(ctx),
        ...allowUnattendedField(ctx, 'update'),
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

const takeOwnership: LeafCommand = {
  kind: 'leaf',
  name: 'take-ownership',
  description:
    "Become a schedule's owner, so its runs act as you from the next run that starts: for a schedule whose owner left, or to make it shared (--run-as=project, the project's own account becomes the owner; --run-as=<service-account-id>, that service account) or yours. Takes a project admin.",
  usage: 'kindgi schedules take-ownership <schedule-id> [--run-as=<service-account-id>|project]',
  optionSpec: { ...RUN_AS_FLAG },
  run: (ctx) =>
    runSdkRendered(ctx, 'schedules take-ownership', async (): Promise<Rendered> => {
      const id = requiredPositional(ctx, 0, 'schedule-id');
      const runAs = stringFlag(ctx, 'run-as');
      const schedulesClient = ctx.client().schedules;
      const schedule = await (runAs !== undefined
        ? schedulesClient.takeOwnership(id, runAsFields(runAs))
        : schedulesClient.takeOwnership(id));
      const rendered = renderJson(schedule, ctx.globals.format);
      const kept = schedule.toolsAllowedUnattended ?? [];
      return {
        stdout: rendered.stdout,
        stderr:
          kept.length > 0
            ? `\n  It keeps its tools allowed unattended (${kept.join(', ')}): their calls in its runs still don't wait for a person's yes just because no person started them, now as the new owner. \`kindgi schedules update ${schedule.scheduleId} --allow-unattended=none\` clears them.\n\n`
            : rendered.stderr,
      };
    }),
};

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

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description:
    "List a schedule's versions, newest first: when each was made, by whom, and why. `kindgi schedules get <schedule-id> <version>` shows one.",
  usage: 'kindgi schedules versions <schedule-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'schedules versions',
      async () =>
        await ctx.client().schedules.versions(requiredPositional(ctx, 0, 'schedule-id'), page(ctx)),
      TRIGGER_VERSIONS_TABLE,
    ),
};

export const schedulesCommand: Command = {
  kind: 'group',
  name: 'schedules',
  description:
    'Run agents and flows on a schedule: create, list, get, update, pause, resume, run-now, fires, versions, take-ownership, unregister.',
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
    versions,
    takeOwnership,
    byId('unregister', 'Remove a schedule: it stops running.', (s, id) => s.unregister(id)),
  ],
};

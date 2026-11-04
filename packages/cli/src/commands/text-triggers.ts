// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { KindgiClient, TextTriggersClient } from '@kindgi/client';

import {
  candidatesListed,
  listCandidateRows,
  namedBy,
  resolveConnectionRef,
} from '../connection-ref.js';
import type { CommandContext } from '../context.js';
import { UsageError, extractKindgiError } from '../errors.js';
import { type Rendered, renderJson } from '../output.js';
import {
  TRIGGER_VERSIONS_TABLE,
  type TableSpec,
  allowUnattendedField,
  clearableFlag,
  commandResultFromThrown,
  givenFlag,
  integerFlag,
  requiredPositional,
  runAsFields,
  runSdk,
  runSdkRendered,
  runsAsCell,
  stringFlag,
  triggerVersionPositional,
} from './helpers.js';
import type { Command, CommandResult, LeafCommand, ParseArgsOption } from './types.js';

type TextTriggerPage = Awaited<ReturnType<TextTriggersClient['list']>>;
type TextTrigger = TextTriggerPage['data'][number];
type FirePage = Awaited<ReturnType<TextTriggersClient['fires']>>;
type Fire = FirePage['data'][number];
type RegisterInput = Parameters<TextTriggersClient['register']>[0];
type UpdateInput = Parameters<TextTriggersClient['update']>[1];

/** The app of the company connection a text trigger answers: one per business number. */
const TEXTS_APP = 'texts';

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

/** What a trigger runs, as one cell: `agent acme.support`, `flow acme.triage@1.0.0`. */
function runs(t: TextTrigger): string {
  if (t.agentId !== undefined) {
    return `agent ${t.agentId}${t.agentVersion !== undefined ? `@${t.agentVersion}` : ''}`;
  }
  return `flow ${t.flowId ?? '?'}@${t.flowVersion ?? '?'}`;
}

/**
 * The names of the connections the triggers answer, read once per project
 * from its company connections of app `texts`. One it can't read stays
 * unnamed: the cell says its id.
 */
async function connectionNames(
  client: KindgiClient,
  triggers: readonly TextTrigger[],
  names: Map<string, string>,
): Promise<void> {
  const read = new Set<string>();
  for (const t of triggers) {
    if (read.has(t.projectId)) continue;
    read.add(t.projectId);
    const rows = await listCandidateRows(client, t.projectId, TEXTS_APP).catch(() => []);
    for (const r of rows) names.set(r.connectionId, r.name);
  }
}

const triggersTable = (
  names: ReadonlyMap<string, string>,
): TableSpec<TextTriggerPage, TextTrigger> => ({
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (t) => t.triggerId },
    { header: 'VERSION', get: (t) => (t.version !== undefined ? String(t.version) : '') },
    { header: 'RUNS', get: runs },
    { header: 'CONNECTION', get: (t) => names.get(t.connectionId) ?? t.connectionId },
    {
      header: 'PER HOUR',
      get: (t) => `${t.runsPerHour}, ${t.perSenderPerHour} a sender`,
    },
    {
      header: 'STATUS',
      get: (t) => (t.statusReason !== undefined ? `${t.status} (${t.statusReason})` : t.status),
    },
    { header: 'RUNS AS', get: (t) => runsAsCell(t.owner) },
    { header: 'LABEL', get: (t) => t.label ?? '' },
  ],
});

const FIRES_TABLE: TableSpec<FirePage, Fire> = {
  rows: (p) => p.data,
  columns: [
    { header: 'FIRED', get: (f) => f.firedAt },
    { header: 'OUTCOME', get: (f) => f.outcome },
    { header: 'RUN', get: (f) => f.runId ?? '' },
    { header: 'NOTE', get: (f) => f.detail ?? '' },
  ],
};

const TARGET_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  agent: {
    type: 'string',
    description: 'Run this agent (at its pinned version, else the latest).',
  },
  'agent-version': { type: 'string', description: 'With --agent: run this exact version.' },
  flow: { type: 'string', description: 'Run this flow (with --flow-version).' },
  'flow-version': { type: 'string', description: 'With --flow: the flow version to run.' },
};

/** The connection and limit flags, worded for `create` or `update`. */
function textFlags(on: 'register' | 'update'): Record<string, ParseArgsOption> {
  return {
    connection: {
      type: 'string',
      description: `The business number it answers: one of the project's company connections of app \`texts\`, by id or name${on === 'register' ? ' (required)' : ''}. One text trigger answers a connection.`,
    },
    'runs-per-hour': {
      type: 'string',
      description: `The most runs its texts start in an hour, 1 to 600${on === 'register' ? ' (default 60)' : ''}. Past it, a text is refused, and doesn't run later.`,
    },
    'per-sender-per-hour': {
      type: 'string',
      description: `The most runs one sender's texts start in an hour, 1 to 60${on === 'register' ? ' (default 10)' : ''}. Past it, that sender's text is refused, and doesn't run later.`,
    },
    label: {
      type: 'string',
      description:
        on === 'register' ? 'A short label.' : 'A new label (`--clear-label` takes it off).',
    },
  };
}

/** `--connection` as a connection id: a name is one of the project's company connections of app `texts`. */
async function textsConnection(
  ctx: CommandContext,
  ref: string,
  projectId: () => Promise<string>,
): Promise<string> {
  const { id } = await resolveConnectionRef(ref, {
    rows: async () => listCandidateRows(ctx.client(), await projectId(), TEXTS_APP),
    app: TEXTS_APP,
    appNarrows: false,
    listed: candidatesListed,
  });
  return id;
}

/**
 * A `trigger-connection-taken`'s next step: the trigger that answers the
 * connection, and how to see it.
 */
function heldBy(err: unknown): string {
  const wire = extractKindgiError(err);
  if (wire?.code !== 'conflict' || wire.serverCode !== 'trigger-connection-taken') return '';
  const holder = wire.fields?.heldBy;
  if (typeof holder !== 'string') return '';
  return `Text trigger ${holder} answers it, in this project or another of the workspace: \`kindgi text-triggers get ${holder}\` in its project shows it, and unregistering it frees the connection.\n`;
}

/**
 * A create or update, its trigger as JSON. A `connection-not-found` says it's
 * `--connection`'s; a `trigger-connection-taken` names the trigger that
 * answers the connection.
 */
async function sendTrigger(
  ctx: CommandContext,
  label: string,
  send: () => Promise<unknown>,
): Promise<CommandResult> {
  try {
    return { kind: 'ok', rendered: renderJson(await send(), ctx.globals.format) };
  } catch (err) {
    const named = ctx.options.connection !== undefined ? namedBy(err, 'connection') : err;
    const result = commandResultFromThrown(named, ctx, label);
    if (result.kind !== 'error') return result;
    return { ...result, stderr: `${result.stderr}${heldBy(err)}` };
  }
}

/** `--allow-unattended`, as `create` and `update` each word it. */
function allowUnattendedFlag(on: 'register' | 'update'): Record<string, ParseArgsOption> {
  return {
    'allow-unattended': {
      type: 'string',
      multiple: true,
      description: `A tool, by id, whose calls in this trigger's runs needn't wait for a person's yes (repeatable; only tools its agent or flow calls, no wildcard). In a run a text started, every call that changes something waits for one otherwise. Never \`texts.send\`: sending a text always waits. Needs \`admin\` on the trigger's project. The workspace's and the agent's approval rules still apply.${on === 'update' ? ' Replaces the list; `none` clears it; left out, the list is kept, and a new --agent, --flow or --connection must name it again (or `none`).' : ''}`,
    },
  };
}

/** The target flags as body fields, when any is given. */
function targetFields(ctx: CommandContext): Partial<RegisterInput> {
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

/** The limit flags as config fields, when given. */
function limitFields(ctx: CommandContext): { runsPerHour?: number; perSenderPerHour?: number } {
  const perHour = integerFlag(ctx, 'runs-per-hour');
  const perSender = integerFlag(ctx, 'per-sender-per-hour');
  return {
    ...(perHour !== undefined && { runsPerHour: perHour }),
    ...(perSender !== undefined && { perSenderPerHour: perSender }),
  };
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List text triggers.',
  usage:
    'kindgi text-triggers list [--project=<project-id>] [--status=active|paused] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    project: { type: 'string', description: "Only this project's text triggers." },
    status: { type: 'string', description: 'Only `active` or only `paused` text triggers.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) => {
    const names = new Map<string, string>();
    return runSdk(
      ctx,
      'text-triggers list',
      async () => {
        const status = stringFlag(ctx, 'status');
        if (status !== undefined && status !== 'active' && status !== 'paused') {
          throw new UsageError('--status must be `active` or `paused`');
        }
        const projectId = stringFlag(ctx, 'project');
        const client = ctx.client();
        const listed = await client.textTriggers.list({
          ...page(ctx),
          ...(status !== undefined && { status }),
          ...(projectId !== undefined && { projectId }),
        });
        if (ctx.globals.format === 'table') await connectionNames(client, listed.data, names);
        return listed;
      },
      triggersTable(names),
    );
  },
};

/**
 * `--run-as`: the trigger's owner is this service account, or the
 * project's own (`project`), not you, so it's shared. Shared by `create`
 * and `take-ownership`.
 */
const RUN_AS_FLAG: Readonly<Record<string, ParseArgsOption>> = {
  'run-as': {
    type: 'string',
    description:
      "A service account, by id, or `project`: the trigger's owner, so its runs act as that account (not as you). `project` runs it as the project's own account, made the first time. The project's own account runs only what the project's editors can. A named account takes `act_as`, and needs a role that runs what the trigger runs (runner or above on the target's project). Omit it to own the trigger yourself.",
  },
};

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    "Start a run of an agent or a flow for each text (SMS or WhatsApp) to a business number, with the text as its input. The number is the company's, so it takes `admin` on the project. Its runs act as you (or, with --run-as, a service account or the project's own), with your connections; in them, every call that changes something waits for a person's yes, and sending a text always does.",
  usage:
    'kindgi text-triggers create (--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v>) --connection=<connection> [--runs-per-hour=<n>] [--per-sender-per-hour=<n>] [--label=<text>] [--project=<project-id>] [--run-as=<service-account-id>|project] [--allow-unattended=<tool-id>]...',
  optionSpec: {
    ...TARGET_FLAGS,
    ...textFlags('register'),
    project: {
      type: 'string',
      description: "The trigger's project, by id (default: the workspace's default project).",
    },
    ...RUN_AS_FLAG,
    ...allowUnattendedFlag('register'),
  },
  run: (ctx) =>
    sendTrigger(ctx, 'text-triggers create', async () => {
      const connection = givenFlag(ctx, 'connection');
      if (connection === undefined) {
        throw new UsageError(
          "--connection=<connection> is required: the company's connection of app `texts` for the number",
        );
      }
      const project = stringFlag(ctx, 'project');
      const label = stringFlag(ctx, 'label');
      const limits = limitFields(ctx);
      const rest = {
        ...targetFields(ctx),
        ...(project !== undefined && { projectId: project }),
        ...(label !== undefined && { label }),
        ...runAsFields(stringFlag(ctx, 'run-as')),
        ...allowUnattendedField(ctx, 'register'),
      };
      const client = ctx.client();
      const connectionId = await textsConnection(
        ctx,
        connection,
        async () => project ?? (await client.projects.getDefault()).id,
      );
      return await client.textTriggers.register({
        ...rest,
        config: { connectionId, ...limits },
      });
    }),
};

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description:
    "Change a text trigger: what it runs, the number it answers, its limits or label, or the tools its runs may call unattended. A flag left out keeps the trigger's value, and its owner stays. It takes `admin` on the trigger's project.",
  usage:
    'kindgi text-triggers update <trigger-id> [--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v>] [--connection=<connection>] [--runs-per-hour=<n>] [--per-sender-per-hour=<n>] [--label=<text>|--clear-label] [--allow-unattended=<tool-id>|none]...',
  optionSpec: {
    ...TARGET_FLAGS,
    ...textFlags('update'),
    'clear-label': { type: 'boolean', description: 'Take the label off.' },
    ...allowUnattendedFlag('update'),
  },
  run: (ctx) =>
    sendTrigger(ctx, 'text-triggers update', async () => {
      const id = requiredPositional(ctx, 0, 'trigger-id');
      const label = clearableFlag(ctx, 'label');
      const connection = givenFlag(ctx, 'connection');
      const limits = limitFields(ctx);
      const rest = {
        ...targetFields(ctx),
        ...(label !== undefined && { label }),
        ...allowUnattendedField(ctx, 'update'),
      };
      const client = ctx.client().textTriggers;
      const config = {
        ...(connection !== undefined && {
          connectionId: await textsConnection(
            ctx,
            connection,
            async () => (await client.get(id)).projectId,
          ),
        }),
        ...limits,
      };
      const input: UpdateInput = {
        ...rest,
        ...(Object.keys(config).length > 0 && { config }),
      };
      return await client.update(id, input);
    }),
};

function byId(
  name: string,
  description: string,
  call: (client: TextTriggersClient, id: string) => Promise<unknown>,
): LeafCommand {
  return {
    kind: 'leaf',
    name,
    description,
    usage: `kindgi text-triggers ${name} <trigger-id>`,
    run: (ctx) =>
      runSdk(ctx, `text-triggers ${name}`, async () =>
        call(ctx.client().textTriggers, requiredPositional(ctx, 0, 'trigger-id')),
      ),
  };
}

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a text trigger as it is now, or the version given.',
  usage: 'kindgi text-triggers get <trigger-id> [<version>]',
  run: (ctx) =>
    runSdk(ctx, 'text-triggers get', async () => {
      const id = requiredPositional(ctx, 0, 'trigger-id');
      const version = triggerVersionPositional(ctx, 1);
      const client = ctx.client().textTriggers;
      return version === undefined ? await client.get(id) : await client.getVersion(id, version);
    }),
};

const takeOwnership: LeafCommand = {
  kind: 'leaf',
  name: 'take-ownership',
  description:
    "Become a text trigger's owner, so its runs act as you, with your connections, from the next text (for a trigger whose owner left). With --run-as, a service account, or with --run-as=project the project's own account, becomes the owner instead.",
  usage: 'kindgi text-triggers take-ownership <trigger-id> [--run-as=<service-account-id>|project]',
  optionSpec: { ...RUN_AS_FLAG },
  run: (ctx) =>
    runSdkRendered(ctx, 'text-triggers take-ownership', async (): Promise<Rendered> => {
      const id = requiredPositional(ctx, 0, 'trigger-id');
      const runAs = stringFlag(ctx, 'run-as');
      const client = ctx.client().textTriggers;
      const trigger = await (runAs !== undefined
        ? client.takeOwnership(id, runAsFields(runAs))
        : client.takeOwnership(id));
      const rendered = renderJson(trigger, ctx.globals.format);
      const kept = trigger.toolsAllowedUnattended ?? [];
      return {
        stdout: rendered.stdout,
        stderr:
          kept.length > 0
            ? `\n  It keeps its tools allowed unattended (${kept.join(', ')}): their calls in its runs still don't wait for a person's yes, now as the new owner. \`kindgi text-triggers update ${trigger.triggerId} --allow-unattended=none\` clears them.\n\n`
            : rendered.stderr,
      };
    }),
};

const fires: LeafCommand = {
  kind: 'leaf',
  name: 'fires',
  description:
    "A text trigger's texts, newest first: the run each started, or why it was skipped, refused (`over-limit:`, past `--runs-per-hour` or `--per-sender-per-hour`) or failed.",
  usage: 'kindgi text-triggers fires <trigger-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'text-triggers fires',
      async () =>
        await ctx.client().textTriggers.fires(requiredPositional(ctx, 0, 'trigger-id'), page(ctx)),
      FIRES_TABLE,
    ),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description:
    "List a text trigger's versions, newest first: when each was made, by whom, and why. `kindgi text-triggers get <trigger-id> <version>` shows one.",
  usage: 'kindgi text-triggers versions <trigger-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'text-triggers versions',
      async () =>
        await ctx
          .client()
          .textTriggers.versions(requiredPositional(ctx, 0, 'trigger-id'), page(ctx)),
      TRIGGER_VERSIONS_TABLE,
    ),
};

export const textTriggersCommand: Command = {
  kind: 'group',
  name: 'text-triggers',
  description:
    'Start runs of agents and flows from texts (SMS or WhatsApp) to a business number: create, list, get, update, pause, resume, fires, versions, take-ownership, unregister.',
  subcommands: [
    list,
    get,
    create,
    update,
    byId(
      'pause',
      "Pause a text trigger: it answers no texts, and one that comes in while it's paused never starts a run. It keeps its connection.",
      (m, id) => m.pause(id),
    ),
    byId(
      'resume',
      'Resume a paused text trigger: it answers the texts that come in from now on. Texts that came while it was paused never start runs.',
      (m, id) => m.resume(id),
    ),
    fires,
    versions,
    takeOwnership,
    byId(
      'unregister',
      'Remove a text trigger: it answers no more texts, and frees its connection.',
      (m, id) => m.unregister(id),
    ),
  ],
};

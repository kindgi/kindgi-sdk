// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MailTriggersClient } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { type Rendered, renderJson } from '../output.js';
import {
  TRIGGER_VERSIONS_TABLE,
  type TableSpec,
  allowUnattendedField,
  integerFlag,
  requiredPositional,
  runAsFields,
  runSdk,
  runSdkRendered,
  runsAsCell,
  stringFlag,
  triggerVersionPositional,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

type MailTriggerPage = Awaited<ReturnType<MailTriggersClient['list']>>;
type MailTrigger = MailTriggerPage['data'][number];
type FirePage = Awaited<ReturnType<MailTriggersClient['fires']>>;
type Fire = FirePage['data'][number];
type RegisterInput = Parameters<MailTriggersClient['register']>[0];
type UpdateInput = Parameters<MailTriggersClient['update']>[1];
type Mailbox = RegisterInput['config']['mailbox'];

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
function runs(t: MailTrigger): string {
  if (t.agentId !== undefined) {
    return `agent ${t.agentId}${t.agentVersion !== undefined ? `@${t.agentVersion}` : ''}`;
  }
  return `flow ${t.flowId ?? '?'}@${t.flowVersion ?? '?'}`;
}

const TRIGGERS_TABLE: TableSpec<MailTriggerPage, MailTrigger> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (t) => t.triggerId },
    { header: 'VERSION', get: (t) => (t.version !== undefined ? String(t.version) : '') },
    { header: 'RUNS', get: runs },
    { header: 'MAILBOX', get: (t) => `${t.mailbox.app} ${t.mailbox.as}` },
    { header: 'ACCOUNT', get: (t) => t.account?.label ?? '' },
    {
      header: 'STATUS',
      get: (t) => (t.statusReason !== undefined ? `${t.status} (${t.statusReason})` : t.status),
    },
    { header: 'RUNS AS', get: (t) => runsAsCell(t.owner) },
    { header: 'LABEL', get: (t) => t.label ?? '' },
  ],
};

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

/** The mailbox and pace flags, worded for `create` or `update`. */
function mailFlags(on: 'register' | 'update'): Record<string, ParseArgsOption> {
  const again = on === 'update' ? ' On update, give --mailbox and --as together.' : '';
  return {
    mailbox: {
      type: 'string',
      description: `The mailbox's app: \`google\` (Gmail) or \`microsoft\` (Outlook).${again}`,
    },
    as: {
      type: 'string',
      description: `Whose mailbox: \`person\`, your own, through your connection${on === 'register' ? ' (default)' : ''}; or \`company\`, the company's, through the company's connection, which takes \`admin\` on the project.${again}`,
    },
    folder: {
      type: 'string',
      description: `The Gmail label id, or the Outlook folder id or well-known name, to watch${on === 'register' ? ' (default: the inbox)' : ": `INBOX` on Gmail or `inbox` on Outlook to watch the inbox again. Left out, it keeps the trigger's folder, unless --mailbox and --as name another mailbox: then that mailbox's inbox. On a person's mailbox, only the trigger's owner changes it"}.`,
    },
    poll: {
      type: 'string',
      description: `How often to look for new mail, in seconds, 30 to 3600${on === 'register' ? ' (default 60)' : ''}.`,
    },
    'runs-per-hour': {
      type: 'string',
      description: `The most runs its mail starts in an hour, 1 to 600${on === 'register' ? ' (default 60)' : ''}. Past it, a mail is refused, and doesn't run later.`,
    },
    label: { type: 'string', description: on === 'register' ? 'A short label.' : 'A new label.' },
  };
}

/** `--allow-unattended`, as `create` and `update` each word it. */
function allowUnattendedFlag(on: 'register' | 'update'): Record<string, ParseArgsOption> {
  return {
    'allow-unattended': {
      type: 'string',
      multiple: true,
      description: `A tool, by id, whose calls in this trigger's runs needn't wait for a person's yes (repeatable; only tools its agent or flow calls, no wildcard). In a run a mail started, every call that changes something, or uses the run's own mailbox, waits for one otherwise. Needs \`admin\` on the trigger's project. The workspace's and the agent's approval rules still apply.${on === 'update' ? " Replaces the list; `none` clears it; left out, the list is kept, and a new --agent, --flow or mailbox must name it again (or `none`, which the owner of a person's trigger may give with their own change)." : ''}`,
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

/** `--mailbox` and `--as` as the wire's `{ app, as }`. */
function mailboxOf(app: string, as: string | undefined): Mailbox {
  if (app !== 'google' && app !== 'microsoft') {
    throw new UsageError('--mailbox must be `google` (Gmail) or `microsoft` (Outlook)');
  }
  if (as !== 'person' && as !== 'company') {
    throw new UsageError("--as must be `person` (your own mailbox) or `company` (the company's)");
  }
  return { app, as };
}

/** The folder and pace flags as config fields, when given. */
function paceFields(ctx: CommandContext): Partial<RegisterInput['config']> {
  const folder = stringFlag(ctx, 'folder');
  const poll = integerFlag(ctx, 'poll');
  const perHour = integerFlag(ctx, 'runs-per-hour');
  return {
    ...(folder !== undefined && { folder }),
    ...(poll !== undefined && { pollSeconds: poll }),
    ...(perHour !== undefined && { runsPerHour: perHour }),
  };
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List mail triggers.',
  usage:
    'kindgi mail-triggers list [--project=<project-id>] [--status=active|paused] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    project: { type: 'string', description: "Only this project's mail triggers." },
    status: { type: 'string', description: 'Only `active` or only `paused` mail triggers.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'mail-triggers list',
      async () => {
        const status = stringFlag(ctx, 'status');
        if (status !== undefined && status !== 'active' && status !== 'paused') {
          throw new UsageError('--status must be `active` or `paused`');
        }
        const projectId = stringFlag(ctx, 'project');
        return await ctx.client().mailTriggers.list({
          ...page(ctx),
          ...(status !== undefined && { status }),
          ...(projectId !== undefined && { projectId }),
        });
      },
      TRIGGERS_TABLE,
    ),
};

/**
 * `--run-as`: the trigger's owner is this service account, or the
 * project's own (`project`), not you, so it's shared. The company's mailbox
 * only. Shared by `create` and `take-ownership`.
 */
const RUN_AS_FLAG: Readonly<Record<string, ParseArgsOption>> = {
  'run-as': {
    type: 'string',
    description:
      "On the company's mailbox only: a service account, by id, or `project`: the trigger's owner, so its runs act as that account (not as you). `project` runs it as the project's own account, made the first time. The project's own account runs only what the project's editors can. A named account takes `act_as`, and needs a role that runs what the trigger runs (editor on the target's project). Omit it to own the trigger yourself.",
  },
};

/** A trigger on a person's mailbox is that person's: `--run-as` stops here, before the call. */
function runAsOnPersonMailbox(runAs: string | undefined, as: string | undefined): void {
  if (runAs !== undefined && as === 'person') {
    throw new UsageError(
      "--run-as goes with --as=company: a trigger on a person's mailbox reads its owner's own mail, so a person owns it",
    );
  }
}

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    "Start a run of an agent or a flow for each new mail in a mailbox, with the mail as its input. Its runs act as you (or, with --run-as, a service account or the project's own), with your connections; in them, every call that changes something, or uses the run's own mailbox, waits for a person's yes.",
  usage:
    'kindgi mail-triggers create (--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v>) --mailbox=google|microsoft [--as=person|company] [--folder=<label-or-folder>] [--poll=<seconds>] [--runs-per-hour=<n>] [--label=<text>] [--project=<project-id>] [--run-as=<service-account-id>|project] [--allow-unattended=<tool-id>]…',
  optionSpec: {
    ...TARGET_FLAGS,
    ...mailFlags('register'),
    project: {
      type: 'string',
      description: "The trigger's project, by id (default: the workspace's default project).",
    },
    ...RUN_AS_FLAG,
    ...allowUnattendedFlag('register'),
  },
  run: (ctx) =>
    runSdk(ctx, 'mail-triggers create', async () => {
      const app = stringFlag(ctx, 'mailbox');
      if (app === undefined) throw new UsageError('--mailbox=google|microsoft is required');
      const mailbox = mailboxOf(app, stringFlag(ctx, 'as') ?? 'person');
      const runAs = stringFlag(ctx, 'run-as');
      runAsOnPersonMailbox(runAs, mailbox.as);
      const project = stringFlag(ctx, 'project');
      const label = stringFlag(ctx, 'label');
      return await ctx.client().mailTriggers.register({
        ...targetFields(ctx),
        config: { mailbox, ...paceFields(ctx) },
        ...(project !== undefined && { projectId: project }),
        ...(label !== undefined && { label }),
        ...runAsFields(runAs),
        ...allowUnattendedField(ctx, 'register'),
      });
    }),
};

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description:
    "Change a mail trigger: what it runs, its mailbox, folder, pace or label, or the tools its runs may call unattended. A flag left out keeps the trigger's value, and its owner stays. On a person's mailbox, only the trigger's owner points it at another of their mailboxes or folders: a project admin can move it to the company's, or take it over to watch their own.",
  usage:
    'kindgi mail-triggers update <trigger-id> [--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v>] [--mailbox=google|microsoft --as=person|company] [--folder=<label-or-folder>] [--poll=<seconds>] [--runs-per-hour=<n>] [--label=<text>] [--allow-unattended=<tool-id>|none]…',
  optionSpec: {
    ...TARGET_FLAGS,
    ...mailFlags('update'),
    ...allowUnattendedFlag('update'),
  },
  run: (ctx) =>
    runSdk(ctx, 'mail-triggers update', async () => {
      const id = requiredPositional(ctx, 0, 'trigger-id');
      const app = stringFlag(ctx, 'mailbox');
      const as = stringFlag(ctx, 'as');
      if ((app === undefined) !== (as === undefined)) {
        throw new UsageError(
          '--mailbox and --as go together on update: the mailbox is replaced whole',
        );
      }
      const config = {
        ...(app !== undefined && { mailbox: mailboxOf(app, as) }),
        ...paceFields(ctx),
      };
      const label = stringFlag(ctx, 'label');
      const input: UpdateInput = {
        ...targetFields(ctx),
        ...(Object.keys(config).length > 0 && { config }),
        ...(label !== undefined && { label }),
        ...allowUnattendedField(ctx, 'update'),
      };
      return await ctx.client().mailTriggers.update(id, input);
    }),
};

function byId(
  name: string,
  description: string,
  call: (client: MailTriggersClient, id: string) => Promise<unknown>,
): LeafCommand {
  return {
    kind: 'leaf',
    name,
    description,
    usage: `kindgi mail-triggers ${name} <trigger-id>`,
    run: (ctx) =>
      runSdk(ctx, `mail-triggers ${name}`, async () =>
        call(ctx.client().mailTriggers, requiredPositional(ctx, 0, 'trigger-id')),
      ),
  };
}

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a mail trigger as it is now, or the version given.',
  usage: 'kindgi mail-triggers get <trigger-id> [<version>]',
  run: (ctx) =>
    runSdk(ctx, 'mail-triggers get', async () => {
      const id = requiredPositional(ctx, 0, 'trigger-id');
      const version = triggerVersionPositional(ctx, 1);
      const client = ctx.client().mailTriggers;
      return version === undefined ? await client.get(id) : await client.getVersion(id, version);
    }),
};

const takeOwnership: LeafCommand = {
  kind: 'leaf',
  name: 'take-ownership',
  description:
    "Become a mail trigger's owner, so its runs act as you, with your connections, from the next poll (for a trigger whose owner left). On a person's mailbox, the mailbox becomes your own. With --run-as, on the company's mailbox, a service account, or with --run-as=project the project's own account, becomes the owner instead.",
  usage: 'kindgi mail-triggers take-ownership <trigger-id> [--run-as=<service-account-id>|project]',
  optionSpec: { ...RUN_AS_FLAG },
  run: (ctx) =>
    runSdkRendered(ctx, 'mail-triggers take-ownership', async (): Promise<Rendered> => {
      const id = requiredPositional(ctx, 0, 'trigger-id');
      const runAs = stringFlag(ctx, 'run-as');
      const client = ctx.client().mailTriggers;
      const trigger = await (runAs !== undefined
        ? client.takeOwnership(id, runAsFields(runAs))
        : client.takeOwnership(id));
      const rendered = renderJson(trigger, ctx.globals.format);
      const kept = trigger.toolsAllowedUnattended ?? [];
      return {
        stdout: rendered.stdout,
        stderr:
          kept.length > 0
            ? `\n  It keeps its tools allowed unattended (${kept.join(', ')}): their calls in its runs still don't wait for a person's yes, now as the new owner. \`kindgi mail-triggers update ${trigger.triggerId} --allow-unattended=none\` clears them.\n\n`
            : rendered.stderr,
      };
    }),
};

const fires: LeafCommand = {
  kind: 'leaf',
  name: 'fires',
  description:
    "A mail trigger's mail, newest first: the run each started, why it waits (`thread-busy:`, behind an earlier mail of its thread), or why it was skipped, refused or failed.",
  usage: 'kindgi mail-triggers fires <trigger-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'mail-triggers fires',
      async () =>
        await ctx.client().mailTriggers.fires(requiredPositional(ctx, 0, 'trigger-id'), page(ctx)),
      FIRES_TABLE,
    ),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description:
    "List a mail trigger's versions, newest first: when each was made, by whom, and why. `kindgi mail-triggers get <trigger-id> <version>` shows one.",
  usage: 'kindgi mail-triggers versions <trigger-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'mail-triggers versions',
      async () =>
        await ctx
          .client()
          .mailTriggers.versions(requiredPositional(ctx, 0, 'trigger-id'), page(ctx)),
      TRIGGER_VERSIONS_TABLE,
    ),
};

export const mailTriggersCommand: Command = {
  kind: 'group',
  name: 'mail-triggers',
  description:
    'Start runs of agents and flows from new mail in a Gmail or Outlook mailbox: create, list, get, update, pause, resume, fires, versions, take-ownership, unregister.',
  subcommands: [
    list,
    get,
    create,
    update,
    byId('pause', 'Pause a mail trigger: it stops looking for new mail.', (m, id) => m.pause(id)),
    byId(
      'resume',
      "Resume a paused mail trigger. It starts afresh: mail that came while it was paused doesn't start runs.",
      (m, id) => m.resume(id),
    ),
    fires,
    versions,
    takeOwnership,
    byId('unregister', 'Remove a mail trigger: it stops looking for new mail.', (m, id) =>
      m.unregister(id),
    ),
  ],
};

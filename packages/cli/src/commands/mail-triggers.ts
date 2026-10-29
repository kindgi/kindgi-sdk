// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { KindgiClient, MailTriggersClient } from '@kindgi/client';

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
  type TableSpec,
  allowUnattendedField,
  commandResultFromThrown,
  givenFlag,
  integerFlag,
  requiredPositional,
  runAsFields,
  runSdk,
  runSdkRendered,
  runsAsCell,
  stringFlag,
} from './helpers.js';
import type { Command, CommandResult, LeafCommand, ParseArgsOption } from './types.js';

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

/**
 * The mailbox, as one cell: `google company`, and the name of the connection
 * it reads with when it names one (`google company support`).
 */
function mailboxCell(t: MailTrigger, names: ReadonlyMap<string, string>): string {
  const id = t.mailbox.connectionId;
  const named = id !== undefined ? ` ${names.get(id) ?? t.account?.label ?? id}` : '';
  return `${t.mailbox.app} ${t.mailbox.as}${named}`;
}

/**
 * The names of the connections the triggers' mailboxes name, read from each
 * project's candidates at the mailbox's app. One it can't read stays unnamed.
 */
async function connectionNames(
  client: KindgiClient,
  triggers: readonly MailTrigger[],
  names: Map<string, string>,
): Promise<void> {
  const read = new Set<string>();
  for (const t of triggers) {
    const key = `${t.projectId} ${t.mailbox.app}`;
    if (t.mailbox.connectionId === undefined || read.has(key)) continue;
    read.add(key);
    const rows = await listCandidateRows(client, t.projectId, t.mailbox.app).catch(() => []);
    for (const r of rows) names.set(r.connectionId, r.name);
  }
}

const triggersTable = (
  names: ReadonlyMap<string, string>,
): TableSpec<MailTriggerPage, MailTrigger> => ({
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (t) => t.triggerId },
    { header: 'RUNS', get: runs },
    { header: 'MAILBOX', get: (t) => mailboxCell(t, names) },
    { header: 'ACCOUNT', get: (t) => t.account?.label ?? '' },
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
  agent: { type: 'string', description: 'Run this agent (at its live version, else the latest).' },
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
    connection: {
      type: 'string',
      description: `With --as=company: the company connection it reads the mailbox with, by id or name, one of the project's at the mailbox's app. Needed when the project has several there; with one, that one is stored.${again}`,
    },
  };
}

/** The wire's words for `connectionId` on a person's mailbox, with the flag's name. */
const PERSON_CONNECTION =
  "A person's mailbox is read with its owner's own connection; --connection is for the company's (--as=company)";

/** `--connection` as a connection id: a name is one of the project's company connections at `app`. */
async function companyConnection(
  ctx: CommandContext,
  ref: string,
  app: string,
  projectId: () => Promise<string>,
): Promise<string> {
  const { id } = await resolveConnectionRef(ref, {
    rows: async () => listCandidateRows(ctx.client(), await projectId(), app),
    app,
    appNarrows: false,
    listed: candidatesListed,
  });
  return id;
}

/**
 * The mailbox with `--connection`'s id, once a name is looked up among the
 * project's company connections. A person's mailbox stops here, before any call.
 */
function withConnection(
  ctx: CommandContext,
  mailbox: Mailbox,
): (projectId: () => Promise<string>) => Promise<Mailbox> {
  const connection = givenFlag(ctx, 'connection');
  if (connection === undefined) return async () => mailbox;
  if (mailbox.as !== 'company') throw new UsageError(PERSON_CONNECTION);
  return async (projectId) => ({
    ...mailbox,
    connectionId: await companyConnection(ctx, connection, mailbox.app, projectId),
  });
}

/** A word as the shell reads it back: quoted unless it's plain. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The command as it was run, its own flags only, with `--connection` naming `connection`. */
function commandNaming(ctx: CommandContext, label: string, connection: string): string {
  const words = [`kindgi ${label}`, ...ctx.positionals.map(shellWord)];
  for (const [name, value] of Object.entries(ctx.options)) {
    if (name === 'connection') continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === true) words.push(`--${name}`);
      else if (typeof v === 'string') words.push(`--${name}=${shellWord(v)}`);
    }
  }
  words.push(`--connection=${shellWord(connection)}`);
  return words.join(' ');
}

/**
 * A `connection-not-chosen`'s next step: the project's company connections
 * by name, each with the command again naming it (by id when two share a name).
 */
function chooseOne(ctx: CommandContext, label: string, err: unknown): string {
  const wire = extractKindgiError(err);
  if (wire?.code !== 'conflict' || wire.serverCode !== 'connection-not-chosen') return '';
  const listed = wire.fields?.choices;
  const choices = (Array.isArray(listed) ? listed : []).filter(
    (c): c is { readonly connectionId: string; readonly name: string } =>
      typeof c?.connectionId === 'string' && typeof c?.name === 'string',
  );
  if (choices.length === 0) return '';
  const shared = (name: string): boolean => choices.filter((c) => c.name === name).length > 1;
  const again = choices.map(
    (c) => `  ${commandNaming(ctx, label, shared(c.name) ? c.connectionId : c.name)}`,
  );
  return `Its company connections there: ${choices.map((c) => c.name).join(', ')}. Name one:\n${again.join('\n')}\n`;
}

/**
 * A create or update, its trigger as JSON. A `connection-not-found` says it's
 * `--connection`'s; a `connection-not-chosen` says how to name one.
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
    return { ...result, stderr: `${result.stderr}${chooseOne(ctx, label, err)}` };
  }
}

/** `--allow-unattended`, as `create` and `update` each word it. */
function allowUnattendedFlag(on: 'register' | 'update'): Record<string, ParseArgsOption> {
  return {
    'allow-unattended': {
      type: 'string',
      multiple: true,
      description: `A tool, by id, whose calls in this trigger's runs needn't wait for a person's yes (repeatable; only tools its agent or flow calls, no wildcard). In a run a mail started, every call that changes something, or uses the run's own mailbox, waits for one otherwise. Needs \`admin\` on the trigger's project. The tenant's and the agent's approval rules still apply.${on === 'update' ? " Replaces the list; `none` clears it; left out, the list is kept, and a new --agent, --flow or mailbox must name it again (or `none`, which the owner of a person's trigger may give with their own change)." : ''}`,
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
  run: (ctx) => {
    const names = new Map<string, string>();
    return runSdk(
      ctx,
      'mail-triggers list',
      async () => {
        const status = stringFlag(ctx, 'status');
        if (status !== undefined && status !== 'active' && status !== 'paused') {
          throw new UsageError('--status must be `active` or `paused`');
        }
        const projectId = stringFlag(ctx, 'project');
        const client = ctx.client();
        const listed = await client.mailTriggers.list({
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
    'kindgi mail-triggers create (--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v>) --mailbox=google|microsoft [--as=person|company [--connection=<connection>]] [--folder=<label-or-folder>] [--poll=<seconds>] [--runs-per-hour=<n>] [--label=<text>] [--project=<project-id>] [--run-as=<service-account-id>|project] [--allow-unattended=<tool-id>]…',
  optionSpec: {
    ...TARGET_FLAGS,
    ...mailFlags('register'),
    project: {
      type: 'string',
      description: "The trigger's project, by id (default: the tenant's Default project).",
    },
    ...RUN_AS_FLAG,
    ...allowUnattendedFlag('register'),
  },
  run: (ctx) =>
    sendTrigger(ctx, 'mail-triggers create', async () => {
      const app = stringFlag(ctx, 'mailbox');
      if (app === undefined) throw new UsageError('--mailbox=google|microsoft is required');
      const mailbox = mailboxOf(app, stringFlag(ctx, 'as') ?? 'person');
      const runAs = stringFlag(ctx, 'run-as');
      runAsOnPersonMailbox(runAs, mailbox.as);
      const named = withConnection(ctx, mailbox);
      const project = stringFlag(ctx, 'project');
      const label = stringFlag(ctx, 'label');
      const pace = paceFields(ctx);
      const rest = {
        ...targetFields(ctx),
        ...(project !== undefined && { projectId: project }),
        ...(label !== undefined && { label }),
        ...runAsFields(runAs),
        ...allowUnattendedField(ctx, 'register'),
      };
      const client = ctx.client();
      const config = {
        mailbox: await named(async () => project ?? (await client.projects.getDefault()).id),
        ...pace,
      };
      return await client.mailTriggers.register({ ...rest, config });
    }),
};

/** `--mailbox` and `--as` on update, given together, and `--connection` only with them. */
function mailboxOnUpdate(ctx: CommandContext): Mailbox | undefined {
  const app = stringFlag(ctx, 'mailbox');
  const as = stringFlag(ctx, 'as');
  if ((app === undefined) !== (as === undefined)) {
    throw new UsageError('--mailbox and --as go together on update: the mailbox is replaced whole');
  }
  if (app === undefined) {
    if (ctx.options.connection !== undefined) {
      throw new UsageError(
        '--connection goes with --mailbox and --as on update: the mailbox is replaced whole',
      );
    }
    return undefined;
  }
  return mailboxOf(app, as);
}

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description:
    "Change a mail trigger: what it runs, its mailbox, folder, pace or label, or the tools its runs may call unattended. A flag left out keeps the trigger's value, and its owner stays. On a person's mailbox, only the trigger's owner points it at another of their mailboxes or folders: a project admin can move it to the company's, or take it over to watch their own.",
  usage:
    'kindgi mail-triggers update <trigger-id> [--agent=<id> [--agent-version=<v>] | --flow=<id> --flow-version=<v>] [--mailbox=google|microsoft --as=person|company [--connection=<connection>]] [--folder=<label-or-folder>] [--poll=<seconds>] [--runs-per-hour=<n>] [--label=<text>] [--allow-unattended=<tool-id>|none]…',
  optionSpec: {
    ...TARGET_FLAGS,
    ...mailFlags('update'),
    ...allowUnattendedFlag('update'),
  },
  run: (ctx) =>
    sendTrigger(ctx, 'mail-triggers update', async () => {
      const id = requiredPositional(ctx, 0, 'trigger-id');
      const mailbox = mailboxOnUpdate(ctx);
      const named = mailbox !== undefined ? withConnection(ctx, mailbox) : undefined;
      const pace = paceFields(ctx);
      const label = stringFlag(ctx, 'label');
      const rest = {
        ...targetFields(ctx),
        ...(label !== undefined && { label }),
        ...allowUnattendedField(ctx, 'update'),
      };
      const client = ctx.client().mailTriggers;
      const config = {
        ...(named !== undefined && {
          mailbox: await named(async () => (await client.get(id)).projectId),
        }),
        ...pace,
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

export const mailTriggersCommand: Command = {
  kind: 'group',
  name: 'mail-triggers',
  description:
    'Start runs of agents and flows from new mail in a Gmail or Outlook mailbox: create, list, get, update, pause, resume, fires, take-ownership, unregister.',
  subcommands: [
    list,
    byId('get', 'Fetch a mail trigger.', (m, id) => m.get(id)),
    create,
    update,
    byId('pause', 'Pause a mail trigger: it stops looking for new mail.', (m, id) => m.pause(id)),
    byId(
      'resume',
      "Resume a paused mail trigger. It starts afresh: mail that came while it was paused doesn't start runs.",
      (m, id) => m.resume(id),
    ),
    fires,
    takeOwnership,
    byId('unregister', 'Remove a mail trigger: it stops looking for new mail.', (m, id) =>
      m.unregister(id),
    ),
  ],
};

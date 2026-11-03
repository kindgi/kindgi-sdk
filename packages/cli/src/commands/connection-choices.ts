// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ConnectionChoice, ConnectionChoicePage, KindgiClient } from '@kindgi/client';

import {
  type ConnectionRow,
  candidatesListed,
  everyPage,
  listCandidateRows,
  ownCandidatesListed,
  resolveConnectionRef,
} from '../connection-ref.js';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { renderJson, successNote } from '../output.js';
import { confirmRemoval } from './connections.js';
import {
  type TableSpec,
  givenFlag,
  integerFlag,
  projectIdFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi connection-choices`: which of a project's connections at an app
 * an agent or a flow uses, or one of its tools: the company's, which a
 * project admin sets and unsets, or a person's own (`--mine`), for their
 * own runs, which only they set and unset. The project's members list them.
 */

type Target = { readonly agentId: string } | { readonly flowId: string };

/** `--agent` or `--flow`: exactly one. */
function targetOf(ctx: CommandContext): Target {
  const agentId = givenFlag(ctx, 'agent');
  const flowId = givenFlag(ctx, 'flow');
  if ((agentId === undefined) === (flowId === undefined)) {
    throw new UsageError('A choice is for one agent or one flow: give --agent=<id> or --flow=<id>');
  }
  return agentId !== undefined ? { agentId } : { flowId: flowId as string };
}

/** `--tool`, and `--need` only with it: a tool's own choice, ahead of its agent's or flow's. */
function toolOf(ctx: CommandContext): { readonly toolId?: string; readonly need?: string } {
  const toolId = givenFlag(ctx, 'tool');
  const need = givenFlag(ctx, 'need');
  if (need !== undefined && toolId === undefined) {
    throw new UsageError("--need is a tool's: give --tool=<tool-id>");
  }
  return { ...(toolId !== undefined && { toolId }), ...(need !== undefined && { need }) };
}

/**
 * The connections named: one, or a tool's set, which takes `--default`, the
 * one a call that names none uses.
 */
function connectionRefs(
  ctx: CommandContext,
  toolId: string | undefined,
): { readonly refs: readonly string[]; readonly byDefault?: string } {
  requiredPositional(ctx, 0, 'connection');
  const refs = ctx.positionals;
  const byDefault = givenFlag(ctx, 'default');
  if (refs.length === 1) {
    if (byDefault !== undefined) {
      throw new UsageError("--default is a set's: name two or more connections");
    }
    return { refs };
  }
  if (toolId === undefined) {
    throw new UsageError('A set of connections is for one tool: give --tool=<tool-id>');
  }
  if (byDefault === undefined) {
    throw new UsageError(
      'A set takes --default=<connection>, one of the set, which a call that names none uses',
    );
  }
  return { refs, byDefault };
}

/** The caller's own user id, for `--mine`: a choice of their own is theirs alone. */
async function callerId(client: KindgiClient): Promise<string> {
  const { userId } = await client.identity.whoami();
  if (userId === undefined || userId === '') {
    throw new UsageError('--mine is a choice of your own, and this token acts as no person');
  }
  return userId;
}

/** What a choice is for, in words: `agent acme.support`, `flow acme.triage`. */
function targetWords(c: Pick<ConnectionChoice, 'agentId' | 'flowId'>): string {
  return c.agentId !== undefined ? `agent ${c.agentId}` : `flow ${c.flowId ?? '?'}`;
}

/** A tool's choice in words, `tool acme.mail (inbox) of agent acme.support`; else its target's. */
function forWords(c: Pick<ConnectionChoice, 'agentId' | 'flowId' | 'toolId' | 'need'>): string {
  if (c.toolId === undefined) return targetWords(c);
  return `tool ${c.toolId}${c.need !== undefined ? ` (${c.need})` : ''} of ${targetWords(c)}`;
}

/** A choice's connection by name, else by id. */
function nameOf(rows: readonly ConnectionRow[], connectionId: string): string {
  return rows.find((r) => r.connectionId === connectionId)?.name ?? connectionId;
}

/** A choice's connections by name: `sales`, or a set's `support and sales`. */
function namesOf(
  rows: readonly ConnectionRow[],
  c: Pick<ConnectionChoice, 'connectionId' | 'connectionIds'>,
): string {
  const names = (c.connectionIds ?? [c.connectionId]).map((id) => nameOf(rows, id));
  const last = names.pop() ?? nameOf(rows, c.connectionId);
  return names.length > 0 ? `${names.join(', ')} and ${last}` : last;
}

/** What a set did: the choice, and the one it replaced, if any. */
function setWords(
  choice: ConnectionChoice,
  previous: ConnectionChoice | undefined,
  rows: readonly ConnectionRow[],
): string {
  const yours = choice.person !== undefined ? 'your ' : '';
  const chosen = `${yours}${namesOf(rows, choice)} at ${choice.app}`;
  const byDefault =
    choice.connectionIds !== undefined ? `, ${nameOf(rows, choice.connectionId)} by default` : '';
  if (previous?.choiceId === choice.choiceId) {
    return `${forWords(choice)} already uses ${chosen}${byDefault} (choice ${choice.choiceId}): nothing changed.\n`;
  }
  const replaced =
    previous !== undefined
      ? `, in place of ${namesOf(rows, previous)} (choice ${previous.choiceId})`
      : '';
  return `Chose ${chosen} for ${forWords(choice)}${byDefault} (choice ${choice.choiceId})${replaced}.\n`;
}

/** Whether two choices are for the same thing: the app, the tool and its need, and whose. */
function sameFor(a: ConnectionChoice, b: ConnectionChoice): boolean {
  return (
    a.app === b.app &&
    a.toolId === b.toolId &&
    a.need === b.need &&
    a.person?.userId === b.person?.userId
  );
}

const set: LeafCommand = {
  kind: 'leaf',
  name: 'set',
  description:
    "Choose the connection an agent or a flow of the project uses at the connection's app, or with --tool the one a tool of it uses, in place of the one chosen before. Several connections make a tool's set, when the tool can take one: a call names one of them, else uses --default. A company choice is a project admin's; --mine makes your own, for your own runs.",
  usage:
    'kindgi connection-choices set <connection>... (--agent=<id> | --flow=<id>) [--tool=<tool-id> [--need=<name>]] [--default=<connection>] [--mine] [--project=<project-id>] [--app=<app>]',
  optionSpec: {
    agent: { type: 'string', description: 'The agent it is for, by id.' },
    flow: { type: 'string', description: 'The flow it is for, by id.' },
    tool: {
      type: 'string',
      description:
        "One of the agent's or flow's tools, by id: the choice is that tool's own, ahead of the agent's or flow's.",
    },
    need: {
      type: 'string',
      description:
        "With --tool: the tool's name for the connection, when the tool uses the app more than once.",
    },
    default: {
      type: 'string',
      description:
        'With several connections: the one a call that names none uses, by id or name; one of them.',
    },
    mine: {
      type: 'boolean',
      description: 'Your own choice, of your own connections, for your own runs.',
    },
    project: {
      type: 'string',
      description: "The project, by id (default: the tenant's Default project).",
    },
    app: {
      type: 'string',
      description: 'With a name: only connections at this app, by its entry id (`google`).',
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'connection-choices set', async () => {
      const target = targetOf(ctx);
      const tool = toolOf(ctx);
      const { refs, byDefault } = connectionRefs(ctx, tool.toolId);
      const mine = ctx.options.mine === true;
      const app = givenFlag(ctx, 'app');
      const client = ctx.client();
      const projectId = await projectIdFlag(ctx);
      const me = mine ? await callerId(client) : undefined;
      const rows = await listCandidateRows(client, projectId, app, mine ? 'me' : undefined);
      const lookup = {
        rows: async () => rows,
        ...(app !== undefined && { app }),
        appNarrows: app === undefined,
        listed: mine ? ownCandidatesListed : candidatesListed,
      };
      const ids: string[] = [];
      for (const ref of refs) ids.push((await resolveConnectionRef(ref, lookup)).id);
      let connectionId = ids[0] as string;
      if (byDefault !== undefined) {
        const { id } = await resolveConnectionRef(byDefault, lookup);
        const inSet = ids.find((i) => i.toLowerCase() === id.toLowerCase());
        if (inSet === undefined) {
          throw new UsageError("--default must be one of the set's connections");
        }
        connectionId = inSet;
      }
      const before = await everyPage((cursor) =>
        client.connectionChoices.list({
          projectId,
          ...target,
          ...(tool.toolId !== undefined && { toolId: tool.toolId }),
          ...(mine && { owner: 'me' as const }),
          ...(cursor !== undefined && { cursor }),
        }),
      );
      const choice = await client.connectionChoices.set({
        projectId,
        ...target,
        ...tool,
        connectionId,
        ...(ids.length > 1 && { connectionIds: ids }),
        ...(me !== undefined && { person: { userId: me } }),
      });
      const previous = before.find((c) => sameFor(c, choice));
      return {
        stdout: renderJson(choice, ctx.globals.format).stdout,
        stderr: successNote(ctx.globals.format, setWords(choice, previous, rows)),
      };
    }),
};

/**
 * Whose choices the table names the connections of: the company's and the
 * caller's own. Another person's are only counted.
 */
interface Naming {
  /** The candidates, the company's and the caller's own, by name. */
  readonly rows: ConnectionRow[];
  /** `--mine`: every choice listed is the caller's own. */
  readonly mine: boolean;
  /**
   * The caller's user id, when a person's choice is listed; unknown, every
   * person's is another's.
   */
  me: string | undefined;
}

/**
 * A choice's connections by name, a set's default marked: `support
 * (default), sales`. Another person's are only counted: `3 connections`.
 */
function connectionsCell(naming: Naming, c: ConnectionChoice): string {
  const ids = c.connectionIds ?? [c.connectionId];
  if (c.person !== undefined && !naming.mine && c.person.userId !== naming.me) {
    return ids.length === 1 ? '1 connection' : `${ids.length} connections`;
  }
  if (c.connectionIds === undefined) return nameOf(naming.rows, c.connectionId);
  return ids
    .map((id) => `${nameOf(naming.rows, id)}${id === c.connectionId ? ' (default)' : ''}`)
    .join(', ');
}

/** The table's columns; `CONNECTIONS` by name, from the project's candidates. */
function choicesTable(
  naming: Naming,
  withRemoved: boolean,
): TableSpec<ConnectionChoicePage, ConnectionChoice> {
  return {
    rows: (page) => page.data,
    columns: [
      { header: 'AGENT/FLOW', get: targetWords },
      { header: 'TOOL', get: (c) => c.toolId ?? '' },
      { header: 'NEED', get: (c) => c.need ?? '' },
      { header: 'APP', get: (c) => c.app },
      { header: 'CONNECTIONS', get: (c) => connectionsCell(naming, c) },
      { header: 'CHOICE ID', get: (c) => c.choiceId },
      ...(withRemoved
        ? [
            {
              header: 'REMOVED',
              get: (c: ConnectionChoice) => (c.removedAt !== undefined ? String(c.removedAt) : ''),
            },
          ]
        : []),
    ],
  };
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "List the project's connection choices: the company's and your own, and every person's for a tenant admin. `--mine` keeps to your own. Removed ones are left out unless `--include-removed`.",
  usage:
    'kindgi connection-choices list [--project=<project-id>] [--agent=<id>] [--flow=<id>] [--tool=<tool-id>] [--app=<app>] [--mine] [--include-removed] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    project: {
      type: 'string',
      description: "The project, by id (default: the tenant's Default project).",
    },
    agent: { type: 'string', description: "Only this agent's." },
    flow: { type: 'string', description: "Only this flow's." },
    tool: { type: 'string', description: "Only this tool's own choices, by its id." },
    app: { type: 'string', description: "Only this app's, by its entry id (`google`)." },
    mine: { type: 'boolean', description: 'Only your own, even as a tenant admin.' },
    'include-removed': {
      type: 'boolean',
      description: 'Removed and replaced choices too, with when (`removedAt`).',
    },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) => {
    const withRemoved = ctx.options['include-removed'] === true;
    const mine = ctx.options.mine === true;
    const naming: Naming = { rows: [], mine, me: undefined };
    return runSdk(
      ctx,
      'connection-choices list',
      async () => {
        const agentId = givenFlag(ctx, 'agent');
        const flowId = givenFlag(ctx, 'flow');
        const toolId = givenFlag(ctx, 'tool');
        const app = givenFlag(ctx, 'app');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        const client = ctx.client();
        const projectId = await projectIdFlag(ctx);
        const page = await client.connectionChoices.list({
          projectId,
          ...(agentId !== undefined && { agentId }),
          ...(flowId !== undefined && { flowId }),
          ...(toolId !== undefined && { toolId }),
          ...(app !== undefined && { app }),
          ...(mine && { owner: 'me' as const }),
          ...(withRemoved && { includeRemoved: true }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
        if (ctx.globals.format === 'table' && page.data.length > 0) {
          // Names for the table; a connection no longer a candidate shows its id.
          const people = page.data.filter((c) => c.person !== undefined);
          if (!mine && people.length > 0) {
            // Unknown, every person's choice is counted as another's.
            naming.me = await client.identity.whoami().then(
              (w) => w.userId,
              () => undefined,
            );
          }
          if (page.data.some((c) => c.person === undefined)) {
            naming.rows.push(...(await listCandidateRows(client, projectId, app).catch(() => [])));
          }
          if (people.some((c) => mine || c.person?.userId === naming.me)) {
            const own = await listCandidateRows(client, projectId, app, 'me').catch(() => []);
            naming.rows.push(...own);
          }
        }
        return page;
      },
      choicesTable(naming, withRemoved),
    );
  },
};

const unset: LeafCommand = {
  kind: 'leaf',
  name: 'unset',
  description:
    "Remove a connection choice: the company's, a project admin's, or your own. A tool's choice gives way to its agent's or flow's. An agent's or flow's gives way to the project's only company connection at the app, and stops with `connection-not-chosen` when there are several; your own gives way to your main connection, else your only one. Asks first, unless --yes.",
  usage: 'kindgi connection-choices unset <choice-id> [--yes]',
  optionSpec: {
    yes: { type: 'boolean', description: "Don't ask first (for scripts)." },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'connection-choices unset', async () => {
      const choiceId = requiredPositional(ctx, 0, 'choice-id');
      const ok = await confirmRemoval(
        ctx,
        'connection-choices unset',
        async () =>
          `Remove connection choice ${choiceId}? A tool's choice gives way to its agent's or flow's. An agent's or flow's gives way to the project's only company connection at the app, or stops when there are several; your own gives way to your main connection, else your only one.`,
      );
      if (ok.kind === 'refused') return { stdout: '', stderr: ok.stderr, exitCode: 1 };
      const removed = await ctx.client().connectionChoices.remove(choiceId);
      if (ctx.globals.formatRequested) return renderJson(removed, ctx.globals.format);
      return { stdout: `Removed connection choice ${choiceId}.\n`, stderr: '' };
    }),
};

export const connectionChoicesCommand: Command = {
  kind: 'group',
  name: 'connection-choices',
  description:
    "Connection choices: which connection an agent or a flow, or one of its tools, uses at an app, the company's or your own (set / list / unset).",
  subcommands: [set, list, unset],
};

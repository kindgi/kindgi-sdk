// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ConnectionChoice, ConnectionChoicePage } from '@kindgi/client';

import {
  type ConnectionRow,
  candidatesListed,
  everyPage,
  listCandidateRows,
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
 * `kindgi connection-choices`: which of a project's company connections at
 * an app an agent or a flow uses, when the project has more than one there.
 * A project admin sets and unsets them; the project's members list them.
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

/** What a choice is for, in words: `agent acme.support`, `flow acme.triage`. */
function targetWords(c: Pick<ConnectionChoice, 'agentId' | 'flowId'>): string {
  return c.agentId !== undefined ? `agent ${c.agentId}` : `flow ${c.flowId ?? '?'}`;
}

/** A choice's connection by name, else by id. */
function nameOf(rows: readonly ConnectionRow[], connectionId: string): string {
  return rows.find((r) => r.connectionId === connectionId)?.name ?? connectionId;
}

/** What a set did: the choice, and the one it replaced, if any. */
function setWords(
  choice: ConnectionChoice,
  previous: ConnectionChoice | undefined,
  rows: readonly ConnectionRow[],
): string {
  const chosen = `${nameOf(rows, choice.connectionId)} at ${choice.app}`;
  if (previous?.choiceId === choice.choiceId) {
    return `${targetWords(choice)} already uses ${chosen} (choice ${choice.choiceId}): nothing changed.\n`;
  }
  const replaced =
    previous !== undefined
      ? `, in place of ${nameOf(rows, previous.connectionId)} (choice ${previous.choiceId})`
      : '';
  return `Chose ${chosen} for ${targetWords(choice)} (choice ${choice.choiceId})${replaced}.\n`;
}

const set: LeafCommand = {
  kind: 'leaf',
  name: 'set',
  description:
    "Choose the company connection an agent or a flow of the project uses at the connection's app, in place of the one chosen before. A project admin's.",
  usage:
    'kindgi connection-choices set <connection> (--agent=<id> | --flow=<id>) [--project=<project-id>] [--app=<app>]',
  optionSpec: {
    agent: { type: 'string', description: 'The agent it is for, by id.' },
    flow: { type: 'string', description: 'The flow it is for, by id.' },
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
      const ref = requiredPositional(ctx, 0, 'connection');
      const target = targetOf(ctx);
      const app = givenFlag(ctx, 'app');
      const client = ctx.client();
      const projectId = await projectIdFlag(ctx);
      const rows = await listCandidateRows(client, projectId, app);
      const { id } = await resolveConnectionRef(ref, {
        rows: async () => rows,
        ...(app !== undefined && { app }),
        appNarrows: app === undefined,
        listed: candidatesListed,
      });
      const before = await everyPage((cursor) =>
        client.connectionChoices.list({
          projectId,
          ...target,
          ...(cursor !== undefined && { cursor }),
        }),
      );
      const choice = await client.connectionChoices.set({ projectId, ...target, connectionId: id });
      const previous = before.find((c) => c.app === choice.app);
      return {
        stdout: renderJson(choice, ctx.globals.format).stdout,
        stderr: successNote(ctx.globals.format, setWords(choice, previous, rows)),
      };
    }),
};

/** The table's columns; `CONNECTION` by name, from the project's candidates. */
function choicesTable(
  rows: readonly ConnectionRow[],
  withRemoved: boolean,
): TableSpec<ConnectionChoicePage, ConnectionChoice> {
  return {
    rows: (page) => page.data,
    columns: [
      { header: 'AGENT/FLOW', get: targetWords },
      { header: 'APP', get: (c) => c.app },
      { header: 'CONNECTION', get: (c) => nameOf(rows, c.connectionId) },
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
    "List the project's connection choices. Removed ones are left out unless `--include-removed`.",
  usage:
    'kindgi connection-choices list [--project=<project-id>] [--agent=<id>] [--flow=<id>] [--app=<app>] [--include-removed] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    project: {
      type: 'string',
      description: "The project, by id (default: the tenant's Default project).",
    },
    agent: { type: 'string', description: "Only this agent's." },
    flow: { type: 'string', description: "Only this flow's." },
    app: { type: 'string', description: "Only this app's, by its entry id (`google`)." },
    'include-removed': {
      type: 'boolean',
      description: 'Removed and replaced choices too, with when (`removedAt`).',
    },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) => {
    const withRemoved = ctx.options['include-removed'] === true;
    const names: ConnectionRow[] = [];
    return runSdk(
      ctx,
      'connection-choices list',
      async () => {
        const agentId = givenFlag(ctx, 'agent');
        const flowId = givenFlag(ctx, 'flow');
        const app = givenFlag(ctx, 'app');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        const client = ctx.client();
        const projectId = await projectIdFlag(ctx);
        const page = await client.connectionChoices.list({
          projectId,
          ...(agentId !== undefined && { agentId }),
          ...(flowId !== undefined && { flowId }),
          ...(app !== undefined && { app }),
          ...(withRemoved && { includeRemoved: true }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
        if (ctx.globals.format === 'table' && page.data.length > 0) {
          // Names for the table; a connection no longer a candidate shows its id.
          names.push(...(await listCandidateRows(client, projectId, app).catch(() => [])));
        }
        return page;
      },
      choicesTable(names, withRemoved),
    );
  },
};

const unset: LeafCommand = {
  kind: 'leaf',
  name: 'unset',
  description:
    "Remove a connection choice: its agent or flow then uses the project's only company connection at the app, and stops with `connection-not-chosen` when there are several. Asks first, unless --yes. A project admin's.",
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
          `Remove connection choice ${choiceId}? Its agent or flow then uses the project's only company connection at the app, or stops when there are several.`,
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
    'Connection choices: which company connection an agent or a flow uses at an app, when its project has several (set / list / unset).',
  subcommands: [set, list, unset],
};

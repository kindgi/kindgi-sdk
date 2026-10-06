// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Observation } from '@kindgi/client';
import type { Page } from '@kindgi/types';

import { type TableSpec, integerFlag, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/** `observations list --table`. */
const OBSERVATIONS_TABLE: TableSpec<Page<Observation>, Observation> = {
  rows: (page) => page.items,
  columns: [
    { header: 'OBSERVED', get: (o) => String(o.observedAt) },
    { header: 'AGENT', get: (o) => `${String(o.agentId)}@${o.agentVersion}` },
    { header: 'TURN', get: (o) => String(o.turnNumber) },
    { header: 'STATUS', get: (o) => o.status },
    { header: 'MS', get: (o) => String(o.durationMs) },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    'List supervisor observations: one per agent turn, with how it went (status, failure, violations), newest first.',
  usage:
    'kindgi observations list [--status=<s>] [--agent=<agent-id>] [--agent-version=<v>] [--supervisor=<id>] [--conversation=<conversation-id>] [--since=<iso>] [--until=<iso>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    status: {
      type: 'string',
      description:
        'Only this status: `succeeded`, `guardrail-violation`, `guardrail-warning`, `tool-error`, `model-error`, `budget-exceeded`, `aborted` or `other`.',
    },
    agent: { type: 'string', description: 'Only the turns of this agent, by id.' },
    'agent-version': {
      type: 'string',
      description: 'Only the turns of this agent version (with `--agent`).',
    },
    supervisor: { type: 'string', description: 'Only what this supervisor recorded, by id.' },
    conversation: { type: 'string', description: 'Only the turns in this conversation.' },
    since: {
      type: 'string',
      description: 'Only the observations at or after this time (ISO 8601).',
    },
    until: {
      type: 'string',
      description: 'Only the observations at or before this time (ISO 8601).',
    },
    limit: {
      type: 'string',
      description: 'The most observations to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'observations list',
      async () => {
        const agentVersion = stringFlag(ctx, 'agent-version');
        const agent = stringFlag(ctx, 'agent');
        if (agentVersion !== undefined && agent === undefined) {
          throw new Error('--agent-version goes with --agent=<agent-id>');
        }
        const filter = {
          status: stringFlag(ctx, 'status'),
          agentId: agent,
          agentVersion,
          supervisorId: stringFlag(ctx, 'supervisor'),
          conversationId: stringFlag(ctx, 'conversation'),
          since: stringFlag(ctx, 'since'),
          until: stringFlag(ctx, 'until'),
          limit: integerFlag(ctx, 'limit'),
          cursor: stringFlag(ctx, 'cursor'),
        };
        return await ctx
          .client()
          .observations.query(
            Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)) as never,
          );
      },
      OBSERVATIONS_TABLE,
    ),
};

export const observationsCommand: Command = {
  kind: 'group',
  name: 'observations',
  description: 'Supervisor observations: how each agent turn went (list).',
  subcommands: [list],
};

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ListPage, ProvenanceRecordMetadata } from '@kindgi/client';

import { UsageError } from '../errors.js';
import { type TableSpec, integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/** `provenance list --table`. */
const PROVENANCE_TABLE: TableSpec<ListPage<ProvenanceRecordMetadata>, ProvenanceRecordMetadata> = {
  rows: (page) => page.data,
  columns: [
    { header: 'RUN', get: (p) => String(p.runId) },
    { header: 'CREATED', get: (p) => String(p.createdAt) },
    {
      header: 'FLOW',
      get: (p) => (p.flowRef !== undefined ? `${String(p.flowRef.id)}@${p.flowRef.version}` : ''),
    },
    { header: 'SIGNED', get: (p) => (p.signed ? 'yes' : 'no') },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List provenance records, one per run: what ran, in what order, with what.',
  usage:
    'kindgi provenance list [--run=<run-id>] [--agent=<agent-id>] [--created-after=<iso>] [--project=<project-id> | --org=<org-id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    run: { type: 'string', description: "Only this run's record." },
    agent: { type: 'string', description: "Only the records of this agent's runs." },
    'created-after': {
      type: 'string',
      description: 'Only the records created after this time (ISO 8601).',
    },
    project: { type: 'string', description: "Only this project's records." },
    org: { type: 'string', description: "Only the records of this org's projects." },
    limit: {
      type: 'string',
      description: 'The most provenance records to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'provenance list',
      async () => {
        const project = stringFlag(ctx, 'project');
        const org = stringFlag(ctx, 'org');
        if (project !== undefined && org !== undefined) {
          throw new UsageError('--project and --org are mutually exclusive');
        }
        const runId = stringFlag(ctx, 'run');
        const agentId = stringFlag(ctx, 'agent');
        const createdAfter = stringFlag(ctx, 'created-after');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().provenance.query({
          ...(project !== undefined && { scope: { kind: 'project', projectId: project } }),
          ...(org !== undefined && { scope: { kind: 'org', orgId: org } }),
          ...(runId !== undefined && { runId: runId as never }),
          ...(agentId !== undefined && { agentId: agentId as never }),
          ...(createdAfter !== undefined && { createdAfter: createdAfter as never }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor: cursor as never }),
        });
      },
      PROVENANCE_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: "A run's provenance record: its graph of what ran, in what order, with what.",
  usage: 'kindgi provenance get <run-id>',
  run: (ctx) =>
    runSdk(ctx, 'provenance get', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id');
      return await ctx.client().provenance.get(runId as never);
    }),
};

const exportCmd: LeafCommand = {
  kind: 'leaf',
  name: 'export',
  description:
    "Export a run's provenance, signed with the deployment's export key. Check it with kindgi exports verify.",
  usage:
    'kindgi provenance export <run-id> [--signing-key=<key-id>] [--include-messages] > provenance.json',
  optionSpec: {
    'signing-key': {
      type: 'string',
      description:
        "Sign with this key (one the runtime lists). Default: the deployment's active key.",
    },
    'include-messages': {
      type: 'boolean',
      description: "Add the run's conversation messages to the bundle.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'provenance export', async () => {
      const runId = requiredPositional(ctx, 0, 'run-id');
      const signingKeyId = stringFlag(ctx, 'signing-key');
      return await ctx.client().provenance.export({
        runId: runId as never,
        ...(signingKeyId !== undefined && { signingKeyId }),
        ...(ctx.options['include-messages'] === true && { includeMessages: true }),
      });
    }),
};

export const provenanceCommand: Command = {
  kind: 'group',
  name: 'provenance',
  description: "Provenance records: each run's graph of what ran (list / get / export, signed).",
  subcommands: [list, get, exportCmd],
};

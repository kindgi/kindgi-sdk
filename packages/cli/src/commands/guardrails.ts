// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { GuardrailId } from '@kindgi/types';

import { UsageError } from '../errors.js';
import { projectIdFlag, readJsonInput, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List registered guardrails.',
  usage: 'kindgi guardrails list [--name=<prefix>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    name: { type: 'string', description: 'Only the guardrails whose id starts with this prefix.' },
    limit: {
      type: 'string',
      description: 'The most guardrails to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'guardrails list', async () => {
      const name = stringFlag(ctx, 'name');
      const cursor = stringFlag(ctx, 'cursor');
      const limitStr = stringFlag(ctx, 'limit');
      const limit = limitStr !== undefined ? Number.parseInt(limitStr, 10) : undefined;
      if (limit !== undefined && Number.isNaN(limit)) {
        throw new UsageError(`--limit must be an integer, got "${limitStr}"`);
      }
      return await ctx.client().guardrails.list({
        ...(name !== undefined && { name }),
        ...(cursor !== undefined && { cursor: cursor as never }),
        ...(limit !== undefined && { limit }),
      });
    }),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a guardrail by id.',
  usage: 'kindgi guardrails get <guardrail-id>',
  run: (ctx) =>
    runSdk(ctx, 'guardrails get', async () => {
      const id = requiredPositional(ctx, 0, 'guardrail-id') as GuardrailId;
      return await ctx.client().guardrails.get(id);
    }),
};

const register: LeafCommand = {
  kind: 'leaf',
  name: 'register',
  description: 'Register a guardrail.',
  usage: 'kindgi guardrails register --spec=<json-or-@file> [--project=<project-id>]',
  optionSpec: {
    spec: {
      type: 'string',
      description:
        'The guardrail definition as JSON, or `@<file>` to read it from a file. Required.',
    },
    project: {
      type: 'string',
      description:
        "The project to register the guardrail in, by id (default: the tenant's Default project).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'guardrails register', async () => {
      const specText = stringFlag(ctx, 'spec');
      if (specText === undefined) throw new UsageError('--spec=<json-or-@file> is required');
      const spec = await readJsonInput(specText);
      const projectId = await projectIdFlag(ctx);
      return await ctx.client().guardrails.author(spec as never, { projectId });
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description: 'Unregister a guardrail.',
  usage: 'kindgi guardrails unregister <guardrail-id>',
  run: (ctx) =>
    runSdk(ctx, 'guardrails unregister', async () => {
      const id = requiredPositional(ctx, 0, 'guardrail-id') as GuardrailId;
      // SDK calls it `delete` — the api-server route is POST
      // /v1/guardrails/{id}/unregister (soft-tombstone semantics).
      // The CLI verb name matches the wire route + prod ops muscle
      // memory; the client mapping happens at the SDK boundary.
      return await ctx.client().guardrails.delete(id);
    }),
};

export const guardrailsCommand: Command = {
  kind: 'group',
  name: 'guardrails',
  description: 'Manage guardrail registrations.',
  subcommands: [list, get, register, unregister],
};

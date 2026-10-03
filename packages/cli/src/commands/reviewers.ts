// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReviewerSpec } from '@kindgi/client';
import type { ReviewerId, UserId } from '@kindgi/types';

import { integerFlag, readJsonInput, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List reviewers.',
  usage: 'kindgi reviewers list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: {
      type: 'string',
      description: 'The most reviewers to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'reviewers list', async () => {
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().approvals.reviewers.list({
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor: cursor as never }),
      });
    }),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a reviewer by id.',
  usage: 'kindgi reviewers get <reviewer-id>',
  run: (ctx) =>
    runSdk(ctx, 'reviewers get', async () => {
      const id = requiredPositional(ctx, 0, 'reviewer-id') as ReviewerId;
      return await ctx.client().approvals.reviewers.get(id);
    }),
};

const register: LeafCommand = {
  kind: 'leaf',
  name: 'register',
  description:
    'Register a reviewer — `{ userId?, role, displayName? }`; without `userId`, you. Registering again changes the role.',
  usage: 'kindgi reviewers register --spec=<json-or-@file>',
  optionSpec: {
    spec: {
      type: 'string',
      description:
        'The reviewer as inline JSON or `@<file>`: `role` (`standard`, `senior` or `admin`), plus optional `userId` (default: you) and `displayName`. Required.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'reviewers register', async () => {
      const raw = stringFlag(ctx, 'spec');
      if (raw === undefined) throw new Error('--spec=<json-or-@file> is required');
      const spec = (await readJsonInput(raw)) as Partial<ReviewerSpec> | null;
      if (spec === null || typeof spec !== 'object' || typeof spec.role !== 'string') {
        throw new Error('--spec must be an object with a `role` (standard, senior or admin)');
      }
      const client = ctx.client();
      const userId = spec.userId ?? ((await client.identity.whoami()).userId as UserId);
      return await client.approvals.reviewers.register({ ...spec, userId, role: spec.role });
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description: 'Unregister a reviewer: their decisions stay, no new approvals go to them.',
  usage: 'kindgi reviewers unregister <reviewer-id>',
  run: (ctx) =>
    runSdk(ctx, 'reviewers unregister', async () => {
      const id = requiredPositional(ctx, 0, 'reviewer-id') as ReviewerId;
      return await ctx.client().approvals.reviewers.deactivate(id);
    }),
};

export const reviewersCommand: Command = {
  kind: 'group',
  name: 'reviewers',
  description: 'Manage HITL reviewers.',
  subcommands: [list, get, register, unregister],
};

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { requiredPositional, runSdk, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List fix proposals.',
  usage: 'kindgi proposals list [--status=<status>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    status: {
      type: 'string',
      description:
        'Only proposals in this status: `draft`, `dry-running`, `dry-run-passed`, `dry-run-failed`, `proposed-for-review`, `approved`, `rejected`, `applied`, `rolled-back` or `withdrawn`.',
    },
    limit: {
      type: 'string',
      description: 'The most proposals to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals list', async () => throwUnwired('supervisor.proposals.list')),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a fix proposal by id.',
  usage: 'kindgi proposals get <proposal-id>',
  run: (ctx) =>
    runSdk(ctx, 'proposals get', async () => {
      requiredPositional(ctx, 0, 'proposal-id');
      throwUnwired('supervisor.proposals.get');
    }),
};

const draft: LeafCommand = {
  kind: 'leaf',
  name: 'draft',
  description: 'Draft fix proposals for an agent version.',
  usage: 'kindgi proposals draft --input=<json-or-@file>',
  optionSpec: {
    input: {
      type: 'string',
      description:
        'The proposal as inline JSON or `@<file>`: `agentId`, `agentVersion`, `tier`, `change`, `patternRefs`, `hypothesis` and `proposerRuleId`.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals draft', async () => throwUnwired('supervisor.proposals.draft')),
};

const dryRun: LeafCommand = {
  kind: 'leaf',
  name: 'dry-run',
  description: 'Dry-run a fix proposal against a dataset.',
  usage: 'kindgi proposals dry-run <proposal-id> --input=<json-or-@file>',
  optionSpec: {
    input: {
      type: 'string',
      description:
        'The dry run as inline JSON or `@<file>`: `datasetId`, `datasetVersion`, and a `criterion` of kind `min-pass-rate` or `strict-improvement`.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals dry-run', async () => {
      requiredPositional(ctx, 0, 'proposal-id');
      throwUnwired('supervisor.proposals.dryRun');
    }),
};

const submitReview: LeafCommand = {
  kind: 'leaf',
  name: 'submit-review',
  description: 'Submit a proposal for reviewer approval.',
  usage: 'kindgi proposals submit-review <proposal-id> [--input=<json-or-@file>]',
  optionSpec: {
    input: {
      type: 'string',
      description:
        'Review options as inline JSON or `@<file>`: `requiredRole`, and `expiresAt` for the approval deadline. Omit it to take the defaults.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'proposals submit-review', async () => {
      requiredPositional(ctx, 0, 'proposal-id');
      throwUnwired('supervisor.proposals.submitForReview');
    }),
};

const apply: LeafCommand = {
  kind: 'leaf',
  name: 'apply',
  description: 'Apply an approved proposal.',
  usage: 'kindgi proposals apply <proposal-id>',
  run: (ctx) =>
    runSdk(ctx, 'proposals apply', async () => {
      requiredPositional(ctx, 0, 'proposal-id');
      throwUnwired('supervisor.proposals.apply');
    }),
};

const rollback: LeafCommand = {
  kind: 'leaf',
  name: 'rollback',
  description: 'Roll back an applied proposal.',
  usage: 'kindgi proposals rollback <proposal-id>',
  run: (ctx) =>
    runSdk(ctx, 'proposals rollback', async () => {
      requiredPositional(ctx, 0, 'proposal-id');
      throwUnwired('supervisor.proposals.rollback');
    }),
};

const withdraw: LeafCommand = {
  kind: 'leaf',
  name: 'withdraw',
  description: 'Withdraw a pending proposal.',
  usage: 'kindgi proposals withdraw <proposal-id>',
  run: (ctx) =>
    runSdk(ctx, 'proposals withdraw', async () => {
      requiredPositional(ctx, 0, 'proposal-id');
      throwUnwired('supervisor.proposals.withdraw');
    }),
};

export const proposalsCommand: Command = {
  kind: 'group',
  name: 'proposals',
  description: 'Manage supervisor fix proposals.',
  subcommands: [list, get, draft, dryRun, submitReview, apply, rollback, withdraw],
};

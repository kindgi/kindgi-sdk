// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ApprovalDecision, ApprovalStatus } from '@kindgi/client';
import type { ApprovalId } from '@kindgi/types';

import { UsageError } from '../errors.js';
import { integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const STATUSES: readonly ApprovalStatus[] = [
  'pending',
  'assigned',
  'in_review',
  'approved',
  'rejected',
  'escalated',
  'expired',
  'withdrawn',
];
const DECISIONS: readonly ApprovalDecision[] = ['approve', 'reject', 'escalate', 'withdraw'];

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return value as T;
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List the approvals your reviewer role can see.',
  usage:
    'kindgi approvals list [--status=<status>[,<status>…]] [--assigned-to=me] [--order=asc|desc] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    status: {
      type: 'string',
      description:
        'Only approvals in these statuses, comma-separated (`pending,assigned,in_review` are the open ones): `pending`, `assigned`, `in_review`, `approved`, `rejected`, `escalated`, `expired` or `withdrawn`.',
    },
    'assigned-to': {
      type: 'string',
      description: '`me`: only the approvals assigned to you.',
    },
    order: {
      type: 'string',
      description: '`asc` (oldest first) or `desc` (newest first, the default).',
    },
    limit: {
      type: 'string',
      description: 'The most approvals to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'approvals list', async () => {
      const status = stringFlag(ctx, 'status');
      const assignedTo = stringFlag(ctx, 'assigned-to');
      const order = stringFlag(ctx, 'order');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().approvals.list({
        ...(status !== undefined && {
          status: status
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => oneOf('status', s, STATUSES)),
        }),
        ...(assignedTo !== undefined && {
          assignedTo: oneOf('assigned-to', assignedTo, ['me'] as const),
        }),
        ...(order !== undefined && { order: oneOf('order', order, ['asc', 'desc'] as const) }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor: cursor as never }),
      });
    }),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch an approval by id.',
  usage: 'kindgi approvals get <approval-id>',
  run: (ctx) =>
    runSdk(ctx, 'approvals get', async () => {
      const id = requiredPositional(ctx, 0, 'approval-id') as ApprovalId;
      return await ctx.client().approvals.get(id);
    }),
};

const complete: LeafCommand = {
  kind: 'leaf',
  name: 'complete',
  description:
    'Decide an approval. Approving or rejecting resumes the run that waits on it (and the flow it is a step of).',
  usage: `kindgi approvals complete <approval-id> --decision=${DECISIONS.join('|')} [--rationale=<text>]`,
  optionSpec: {
    decision: {
      type: 'string',
      description: 'The decision: `approve`, `reject`, `escalate` or `withdraw`. Required.',
    },
    rationale: { type: 'string', description: 'Why, recorded with the decision.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'approvals complete', async () => {
      const id = requiredPositional(ctx, 0, 'approval-id') as ApprovalId;
      const decision = stringFlag(ctx, 'decision');
      if (decision === undefined) {
        throw new UsageError(`--decision=${DECISIONS.join('|')} is required`);
      }
      const rationale = stringFlag(ctx, 'rationale');
      return await ctx.client().approvals.decide(id, {
        decision: oneOf('decision', decision, DECISIONS),
        ...(rationale !== undefined && { rationale }),
      });
    }),
};

const exportCmd: LeafCommand = {
  kind: 'leaf',
  name: 'export',
  description:
    "Export a decided approval's audit bundle, signed with the deployment's export key: who decided, when, why, and its evidence. Check it with kindgi exports verify.",
  usage:
    'kindgi approvals export <approval-id> [--signing-key=<key-id>] [--include-messages] > bundle.json',
  optionSpec: {
    'signing-key': {
      type: 'string',
      description:
        "Sign with this key (one the runtime lists). Default: the deployment's active key.",
    },
    'include-messages': {
      type: 'boolean',
      description: "Add the conversation messages of the approval's run.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'approvals export', async () => {
      const id = requiredPositional(ctx, 0, 'approval-id') as ApprovalId;
      const signingKeyId = stringFlag(ctx, 'signing-key');
      return await ctx.client().approvals.audit.export({
        approvalId: id,
        ...(signingKeyId !== undefined && { signingKeyId }),
        ...(ctx.options['include-messages'] === true && { includeMessages: true }),
      });
    }),
};

export const approvalsCommand: Command = {
  kind: 'group',
  name: 'approvals',
  description: 'Review HITL approvals, and export their signed audit bundles.',
  subcommands: [list, get, complete, exportCmd],
};

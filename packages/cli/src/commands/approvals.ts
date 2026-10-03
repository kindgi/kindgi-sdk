// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ApprovalDecision, ApprovalStatus } from '@kindgi/client';
import type { ApprovalId } from '@kindgi/types';

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
    throw new Error(`--${flag} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return value as T;
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List the approvals your reviewer role can see.',
  usage: `kindgi approvals list [--status=${STATUSES.join('|')}] [--limit=<n>] [--cursor=<c>]`,
  optionSpec: {
    status: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
  },
  run: (ctx) =>
    runSdk(ctx, 'approvals list', async () => {
      const status = stringFlag(ctx, 'status');
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().approvals.list({
        ...(status !== undefined && { status: oneOf('status', status, STATUSES) }),
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
  optionSpec: { decision: { type: 'string' }, rationale: { type: 'string' } },
  run: (ctx) =>
    runSdk(ctx, 'approvals complete', async () => {
      const id = requiredPositional(ctx, 0, 'approval-id') as ApprovalId;
      const decision = stringFlag(ctx, 'decision');
      if (decision === undefined) {
        throw new Error(`--decision=${DECISIONS.join('|')} is required`);
      }
      const rationale = stringFlag(ctx, 'rationale');
      return await ctx.client().approvals.decide(id, {
        decision: oneOf('decision', decision, DECISIONS),
        ...(rationale !== undefined && { rationale }),
      });
    }),
};

export const approvalsCommand: Command = {
  kind: 'group',
  name: 'approvals',
  description: 'Review HITL approvals.',
  subcommands: [list, get, complete],
};

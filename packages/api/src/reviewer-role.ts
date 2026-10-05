// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReviewerRole } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import type { Context } from 'hono';

import type { ReviewerBinding } from './reviewer-binding.js';
import type { AppEnv } from './types.js';

/**
 * The caller's reviewer role: the one its token carries, else the one the
 * roster gives its user (`ReviewerBinding.resolveReviewerRole`, when the
 * binding has it), kept on the request. `undefined` for a caller that
 * isn't a reviewer: a token with neither a role nor a user, or a user the
 * roster doesn't know.
 */
export async function callerReviewerRole(
  c: Context<AppEnv>,
  reviewerBinding: ReviewerBinding | undefined,
): Promise<ReviewerRole | undefined> {
  const carried = c.get('reviewerRole');
  if (carried !== undefined) return carried;
  const userId = c.get('userId') as UserId | undefined;
  if (userId === undefined || reviewerBinding?.resolveReviewerRole === undefined) {
    return undefined;
  }
  const role = await reviewerBinding.resolveReviewerRole({
    tenantId: c.get('tenantId') as TenantId,
    userId,
  });
  if (role === null) return undefined;
  c.set('reviewerRole', role);
  return role;
}

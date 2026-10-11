// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { type ReviewerRole, ref } from '@kindgi/authz';
import type { Cursor, ReviewerId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type {
  ReviewerBinding,
  ReviewerRecord,
  ReviewerRegistryBinding,
} from '../reviewer-binding.js';
import { callerReviewerRole } from '../reviewer-role.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';
import { clampLimit } from './pagination.js';

/**
 * Reviewer roster routes — sub-resource under
 * `/v1/approvals/reviewers`. Roster management is caller-plugged via
 * `ReviewerRegistryBinding`; the API package does NOT own persistence.
 *
 * The routes deliberately live OUTSIDE the reviewer-role gate applied
 * inside `approvalsRouter`: registering a reviewer is an admin surface
 * action, not a reviewer-only one, so requiring a `reviewerRole` on the
 * caller would be circular ("only reviewers can appoint reviewers").
 * With authorization enforced, registering or unregistering needs
 * `admin` on the tenant, and reading the roster (it names people) is for
 * those who decide approvals: a tenant admin, or a reviewer. Anyone else,
 * a project's viewer say, is refused, and the refusal recorded.
 *
 * Mounted BEFORE `approvalsRouter` on the parent `/v1` router so path
 * matching resolves `/v1/approvals/reviewers/*` here rather than being
 * captured by the `/:approvalId` param inside the approvals router.
 */
const ROLE_VALUES: ReadonlySet<ReviewerRole> = new Set(['standard', 'senior', 'admin']);

export function reviewersRouter(
  binding: ReviewerRegistryBinding,
  /**
   * When set, registering or unregistering a reviewer needs `admin` on
   * the tenant: a reviewer (an `admin` one above all) decides approvals.
   * Reading the roster needs `admin` on the tenant or a reviewer role.
   */
  authorizer?: Authorizer,
  /** Whether the caller is a reviewer, for reading the roster (`callerReviewerRole`). */
  reviewerBinding?: ReviewerBinding,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  if (authorizer !== undefined) {
    r.use('*', async (c, next) => {
      const tenant = ref('tenant', c.get('tenantId') as unknown as string);
      if (c.req.method !== 'GET') return authorizer.authorize('admin', () => tenant)(c, next);
      // The roster names people: only those who decide approvals read it.
      if (await authorizer.can(c, 'admin', tenant)) return next();
      if ((await callerReviewerRole(c, reviewerBinding)) !== undefined) return next();
      return refused(c, authorizer, {
        action: 'read',
        resource: tenant,
        message:
          'The reviewer roster is for tenant admins and reviewers: it names the people who decide approvals.',
        failing: 'actor',
      });
    });
  }

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const roleRaw = c.req.query('role');

    let roleFilter: ReviewerRole | undefined;
    if (roleRaw !== undefined && roleRaw.length > 0) {
      if (!ROLE_VALUES.has(roleRaw as ReviewerRole)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: `Unknown \`role\` value: ${roleRaw}` },
            requestId,
          ),
        );
      }
      roleFilter = roleRaw as ReviewerRole;
    }

    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(roleFilter !== undefined && { role: roleFilter }),
    });
    return c.json({
      data: page.data.map(serializeReviewer),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:reviewerId ----------
  r.get('/:reviewerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const reviewerId = c.req.param('reviewerId') as ReviewerId;

    const reviewer = await binding.get({ tenantId, reviewerId });
    if (reviewer === null) {
      c.status(statusFor('reviewer-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'reviewer-not-found',
            message: `No reviewer registered with id "${reviewerId as unknown as string}"`,
            reviewerId: reviewerId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeReviewer(reviewer));
  });

  // ---------- POST / (register) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    const parsed = parseRegisterBody(body);
    if (parsed.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsed.message }, requestId));
    }

    const outcome = await binding.register({
      tenantId,
      userId: parsed.value.userId,
      role: parsed.value.role,
      ...(parsed.value.displayName !== undefined && { displayName: parsed.value.displayName }),
    });
    c.status(201);
    return c.json(serializeReviewer(outcome.reviewer));
  });

  // ---------- POST /:reviewerId/unregister ----------
  r.post('/:reviewerId/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const reviewerId = c.req.param('reviewerId') as ReviewerId;

    const outcome = await binding.unregister({ tenantId, reviewerId });
    if (!outcome.unregistered) {
      c.status(statusFor('reviewer-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'reviewer-not-found',
            message: `No reviewer "${reviewerId as unknown as string}" to unregister`,
            reviewerId: reviewerId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json({
      reviewerId: reviewerId as unknown as string,
      unregistered: true,
    });
  });

  return r;
}

function serializeReviewer(r: ReviewerRecord): Record<string, unknown> {
  return {
    id: r.id as unknown as string,
    tenantId: r.tenantId as unknown as string,
    userId: r.userId as unknown as string,
    role: r.role,
    ...(r.displayName !== undefined && { displayName: r.displayName }),
    createdAt: r.createdAt as unknown as string,
    ...(r.deactivatedAt !== undefined && {
      deactivatedAt: r.deactivatedAt as unknown as string,
    }),
  };
}

type ParsedRegister = {
  readonly userId: UserId;
  readonly role: ReviewerRole;
  readonly displayName?: string;
};

function parseRegisterBody(
  body: unknown,
):
  | { readonly kind: 'ok'; readonly value: ParsedRegister }
  | { readonly kind: 'err'; readonly message: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', message: 'Request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const userId = b.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    return { kind: 'err', message: 'Field `userId` must be a non-empty string' };
  }
  const role = b.role;
  if (typeof role !== 'string' || !ROLE_VALUES.has(role as ReviewerRole)) {
    return { kind: 'err', message: 'Field `role` must be one of: standard, senior, admin' };
  }
  const displayNameRaw = b.displayName;
  let displayName: string | undefined;
  if (displayNameRaw !== undefined) {
    if (typeof displayNameRaw !== 'string' || displayNameRaw.length === 0) {
      return {
        kind: 'err',
        message: 'Field `displayName` must be a non-empty string when present',
      };
    }
    displayName = displayNameRaw;
  }
  return {
    kind: 'ok',
    value: {
      userId: userId as UserId,
      role: role as ReviewerRole,
      ...(displayName !== undefined && { displayName }),
    },
  };
}

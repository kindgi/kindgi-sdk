// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { Cursor, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { FrozenCaseStoreBinding } from '../frozen-case-binding.js';
import type { ItemRights } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * The cases of test sets built from corrections (`corrections` test sets):
 * `GET /v1/test-sets/:testSetId/versions/:version/cases`. Nothing builds
 * them any more, since an agent's corrections are its test set
 * (`agent-test-set.ts`); the ones built before are still read here.
 */
export function correctedTestSetsRouter(
  cases: FrozenCaseStoreBinding,
  authorizer?: Authorizer,
  /** Rights on a test set more than one project serves (`item-rights.ts`); absent → the test set's own. */
  itemRights?: ItemRights,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/:testSetId/versions/:version/cases', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const testSetId = c.req.param('testSetId');
    const version = c.req.param('version');
    // A test set more than one project serves was checked on those projects,
    // this version among them (`item-rights.ts`, the test sets' middleware).
    if (
      authorizer !== undefined &&
      (await itemRights?.multi(c, 'test_set', testSetId)) === undefined &&
      !(await authorizer.can(c, 'read', ref('test_set', testSetId)))
    ) {
      return fail(c, 'test-set-not-found', `No test set "${testSetId}".`);
    }
    const cursor = c.req.query('cursor');
    const page = await cases.listCases({
      tenantId,
      testSetId,
      version,
      limit: clampLimit(c.req.query('limit'), 25, 100),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    return c.json({
      data: page.data,
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  return r;
}

function fail(c: Context<AppEnv>, code: string, message: string): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message }, c.get('requestId')));
}

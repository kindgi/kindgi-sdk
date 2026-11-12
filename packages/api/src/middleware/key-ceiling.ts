// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import { ref } from '@kindgi/authz';

import { statusFor, toWireError } from '../errors.js';
import { refused } from '../routes/denied.js';
import type { AppEnv } from '../types.js';
import type { Authorizer } from './authorize.js';

/**
 * What an API key with a ceiling (`ApiTokenCeiling`) is refused at the
 * route, beside what the authorizer refuses it (`keyCeilingDeny`).
 */

/** The methods that only read. */
const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * On a schedule, event trigger, mail trigger or webhook trigger router:
 * a key with a ceiling registers, changes, pauses, resumes, runs now,
 * re-owns and unregisters none of them, and reads them as its grants
 * allow. A schedule or trigger outlives the key, and its runs act as
 * whoever registered it, or the owner it names, with all their roles;
 * running one now starts a run as its owner, not as the key. These
 * routes ask only `write` of the project (or the flow), which the key
 * keeps, so the refusal is made here, before the route reads the body.
 */
export function ceilingKeyChangesNoTrigger(
  authorizer: Authorizer | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ceiling = c.get('tokenCeiling');
    if (ceiling === undefined || READS.has(c.req.method)) return next();
    const keyProject = c.get('tokenProjectId');
    return refused(c, authorizer, {
      action: 'write',
      resource:
        keyProject !== undefined
          ? ref('project', keyProject)
          : ref('tenant', c.get('tenantId') as unknown as string),
      message: `An API key with the ${ceiling} ceiling registers and changes no schedule or trigger: it reads them only`,
      failing: 'scope',
      code: 'key-ceiling-refused',
    });
  };
}

/**
 * On a runtime with no authorizer: a key with a ceiling reaches nothing.
 * Its ceiling is held by the authorizer's checks, so with none to make
 * them, a request with such a key is refused whatever it asks.
 */
export function ceilingKeyNeedsAuthorizer(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ceiling = c.get('tokenCeiling');
    if (ceiling === undefined) return next();
    c.status(statusFor('key-ceiling-unsupported') as never);
    return c.json(
      toWireError(
        {
          code: 'key-ceiling-unsupported',
          message: `This runtime runs without authorization, so it can't hold an API key to its ${ceiling} ceiling: use a key without one`,
        },
        c.get('requestId'),
      ),
    );
  };
}

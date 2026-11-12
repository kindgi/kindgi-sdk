// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { UUID_RE } from '@kindgi/types';
import type { MiddlewareHandler } from 'hono';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/** The one check of a UUID id's shape, from `@kindgi/types`. */
export { UUID_RE };

/**
 * A path parameter that must be a UUID: one that isn't is a 400 naming
 * it, before it reaches a query (where Postgres's uuid cast would fail it
 * as a 500). `what` names the id, e.g. `a run id`.
 */
export function refuseMalformedUuidParam(param: string, what: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (UUID_RE.test(c.req.param(param) ?? '')) return next();
    c.status(statusFor('bad-input') as never);
    return c.json(
      toWireError(
        { code: 'bad-input', message: `\`${param}\` must be ${what} (a UUID)` },
        c.get('requestId'),
      ),
    );
  };
}

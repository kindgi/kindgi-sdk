// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import { runAsTenant } from '@kindgi/bounds';

import type { AppEnv } from '../types.js';

/**
 * Runs the rest of a request that publishes definitions as its tenant's
 * work, every schema it compiles counted against the tenant's compile
 * budget, first compiles included (`runAsTenant`, `compiles: 'all'`).
 * A publish route compiles each schema before its first write, so a
 * compile the budget refuses (`SchemaCompileBudgetError`, which the
 * app's error handler answers) leaves nothing stored.
 */
export function publishCompilesMiddleware(): MiddlewareHandler<AppEnv> {
  return (c, next) =>
    runAsTenant(c.get('tenantId') as unknown as string, () => next(), { compiles: 'all' });
}

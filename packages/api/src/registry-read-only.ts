// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import { statusFor, toWireError } from './errors.js';
import type { AppEnv } from './types.js';

/**
 * A registry that takes no writes: it serves its definitions from
 * somewhere else (under `kindgi dev`, the pack's files). A binding that
 * sets it has every write refused before the binding is called:
 * publish, unregister and reinstate (and, for agents, deriving a
 * version), and a deploy that would publish into it. The refusal is
 * `409 registry-read-only` with `reason` as its message.
 */
export interface RegistryReadOnly {
  /** Why, and what to do instead, in plain words: the refusal's message. */
  readonly reason: string;
}

/** The refusal of a write to a read-only registry. */
export function refuseReadOnly(c: Context<AppEnv>, readOnly: RegistryReadOnly) {
  c.status(statusFor('registry-read-only') as never);
  return c.json(
    toWireError({ code: 'registry-read-only', message: readOnly.reason }, c.get('requestId')),
  );
}

/**
 * A router's writes (every method but GET and HEAD) are refused while
 * its registry is read-only. Read at request time, so a binding can
 * become writable without a restart.
 */
export function refuseWritesWhenReadOnly(
  readOnly: () => RegistryReadOnly | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const marker = readOnly();
    if (marker === undefined || c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    return refuseReadOnly(c, marker);
  };
}

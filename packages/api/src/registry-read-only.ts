// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentPinScope } from '@kindgi/types';
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
  /**
   * Set (on an agent registry) when it still takes Improve's candidates:
   * an Improve run runs, an evaluation derives its candidate version (kept to be
   * evaluated, never served by range), and a pin makes one pinned by
   * writing it where the definitions come from (under `kindgi dev`, the
   * pack's files). Of the agents router's writes, only `POST …/pinned/pin`
   * and `…/pinned/check` get through. Unpinning stays
   * refused, a suggested change's roll back too, with `undoReason`: there's one
   * pinned version, and what undoes a change is where it was written. And
   * only the whole tenant is improved: a suggested change or its
   * evaluation for a narrower scope is refused with `scopeReason`, as
   * the binding refuses pinning a version there.
   */
  readonly takesCandidates?: {
    /** Why an unpin is refused, and what to do instead. */
    readonly undoReason: string;
    /** Why a scope narrower than the whole tenant is refused, and what to do instead. */
    readonly scopeReason: string;
  };
}

/** Whether a registry refuses Improve's candidates: read-only, and not taking them. */
export function refusesCandidates(readOnly: RegistryReadOnly | undefined): boolean {
  return readOnly !== undefined && readOnly.takesCandidates === undefined;
}

/**
 * Why a registry that takes Improve's candidates refuses `scope` (only the
 * whole tenant is improved there); `undefined` when it doesn't.
 */
export function refusesScope(
  readOnly: RegistryReadOnly | undefined,
  scope: AgentPinScope,
): string | undefined {
  const takes = readOnly?.takesCandidates;
  return takes !== undefined && scope.kind !== 'tenant' ? takes.scopeReason : undefined;
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

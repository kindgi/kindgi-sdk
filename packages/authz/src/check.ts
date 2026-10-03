// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// PDP Decision shape + pure `ref` constructor + AuthzCheckBinding
// interface.
//
// This package declares the contract only. An `AuthzCheckBinding`
// implementation resolves the tenant's FGA store and runs the relation
// checks; deployments supply one to the enforcement sites.
//

import type { Principal } from './principal.js';
import type { Action, ObjectType, ResourceRef } from './types.js';

export interface Decision {
  readonly allowed: boolean;
  readonly reason: string;
  /**
   * Which link in the (actor, onBehalfOf, scope) chain caused the deny.
   * Undefined when `allowed = true`.
   */
  readonly failing?: 'actor' | 'onBehalfOf' | 'scope' | 'unbootstrapped' | 'invalid-action';
  /**
   * Structured evidence for audit + debugging.
   */
  readonly evidence: {
    readonly action: Action;
    readonly relation: string;
    readonly resource: string;
    readonly actorSubject: string;
    readonly onBehalfOfSubject?: string;
    readonly storeId?: string;
  };
}

/**
 * Convenience constructor for a `ResourceRef`. The type parameter
 * checks `type` against `ObjectType` at the call site; the return type
 * is plain `ResourceRef` (it does not narrow to the given type).
 */
export function ref<T extends ObjectType>(type: T, id: string): ResourceRef {
  return { type, id };
}

/**
 * Per-call correlation context for `AuthzCheckBinding` methods.
 * Threaded so the emitted audit event carries the request-scoped
 * ids that let operators trace a deny back to the HTTP request or
 * run that produced it.
 */
export interface AuthzCheckContext {
  /**
   * Optional correlation id — e.g. the API request id from route
   * middleware, or a run-scoped id. Attached to emitted audit events.
   */
  readonly correlationId?: string;
  /**
   * Optional run id — attached to emitted audit events when the check
   * happens inside a run. Distinct from `correlationId` because the
   * run id survives across HTTP requests (streamed responses, replays).
   */
  readonly runId?: string;
}

/**
 * Policy Decision Point binding. Every enforcement site that wants
 * to check authz (for example the @kindgi/api middleware) goes
 * through this contract. The deployment supplies the implementation.
 */
export interface AuthzCheckBinding {
  /**
   * Applies the principal's downscope filter first (cheap, no FGA
   * round-trip), then calls FGA check for the actor and (if
   * delegated) the `onBehalfOf`. Returns a `Decision` — allowed
   * iff every check passes.
   */
  check(
    principal: Principal,
    action: Action,
    resource: ResourceRef,
    ctx?: AuthzCheckContext,
  ): Promise<Decision>;

  /**
   * List-filtering primitive. Given a set of resources, returns
   * `Decision`s in the same order — used by `filterByCan` at the
   * API layer to strip rows a caller can't read.
   */
  checkBatch(
    principal: Principal,
    action: Action,
    resources: readonly ResourceRef[],
    ctx?: AuthzCheckContext,
  ): Promise<readonly Decision[]>;
}

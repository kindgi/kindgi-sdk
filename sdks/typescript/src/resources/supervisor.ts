// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Filter, SupervisorId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { ListPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { Supervisor, SupervisorSpec } from '../types.js';

/**
 * Supervisor resource — observers that watch agents, suggest bounded
 * fixes on failure patterns, and route them through review.
 * Meta-fixes (fixes to a supervisor itself) route to the senior
 * reviewer class.
 *
 * Supervisors themselves have no API routes — `define` / `get` /
 * `list` / `versions` / `delete` throw `not-yet-wired`; a deployment
 * supplies supervisors through the `SupervisorBinding` it passes to the
 * API. Suggested changes are `client.suggestedChanges`.
 */
export interface SupervisorClient {
  /**
   * @unwired No `POST /v1/supervisors` route — supervisors are
   *   supplied by the deployment's `SupervisorBinding`.
   *
   * @example
   * ```ts excerpt
   * const supervisorId = await client.supervisor.define({
   *   id: 'acme.citation-supervisor',
   *   version: '1.0.0',
   *   name: 'Citation Supervisor',
   *   subscribedAgents: ['acme.citation-verifier'],
   *   triggerGuardrails: ['must-cite-source', 'no-fabricated-quotes'],
   *   proposerTiers: ['prompt', 'retrieval'],
   *   defaultCriterion: { kind: 'strict-improvement', baselinePassRate: 0.8, minDelta: 0.05 },
   * });
   * ```
   */
  define(spec: SupervisorSpec): Promise<SupervisorId>;

  /** @unwired No `GET /v1/supervisors/{id}` route. */
  get(id: SupervisorId): Promise<Supervisor>;

  /** @unwired No `GET /v1/supervisors` route. */
  list(filter?: Filter): Promise<ListPage<Supervisor>>;

  /** @unwired No `GET /v1/supervisors/{id}/versions` route. */
  versions(id: SupervisorId): Promise<ListPage<Supervisor>>;

  /** @unwired No `DELETE /v1/supervisors/{id}` route. */
  delete(id: SupervisorId): Promise<void>;
}

const REASON_NO_SUPERVISOR_CRUD =
  'no /v1/supervisors CRUD routes on the API — supervisor persistence is caller-plugged via SupervisorBinding at deployment boot (framework does NOT own supervisor storage; analogous to the identity-directory pattern for users)';

export function makeSupervisorClient(_transport: Transport): SupervisorClient {
  return {
    async define(_spec) {
      throw new KindgiApiError(notYetWired('supervisor.define', REASON_NO_SUPERVISOR_CRUD));
    },
    async get(_id) {
      throw new KindgiApiError(notYetWired('supervisor.get', REASON_NO_SUPERVISOR_CRUD));
    },
    async list(_filter) {
      throw new KindgiApiError(notYetWired('supervisor.list', REASON_NO_SUPERVISOR_CRUD));
    },
    async versions(_id) {
      throw new KindgiApiError(notYetWired('supervisor.versions', REASON_NO_SUPERVISOR_CRUD));
    },
    async delete(_id) {
      throw new KindgiApiError(notYetWired('supervisor.delete', REASON_NO_SUPERVISOR_CRUD));
    },
  };
}

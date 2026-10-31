// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor, SuggestedChangeId } from '@kindgi/types';

import type { PinAnswer } from '../generated/api.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  SuggestedChange,
  SuggestedChangeContent,
  SuggestedChangeMadeBy,
  SuggestedChangeStatus,
} from '../types.js';

/** A suggested change's pin: the pin as `agents.pinned.pin` answers it, and the suggested change it pinned. */
export type SuggestedChangePinAnswer = PinAnswer & { readonly suggestedChange: SuggestedChange };

/**
 * Suggested changes (`/v1/suggested-changes`): new content for one block
 * (settings values, or a prompt template) in what a project runs. Making
 * one publishes the block version, derives an agent version from what the
 * project runs, and checks both on the project's test set. Then it's
 * pinned for the project, through the project's gate. `status` is derived
 * by the server.
 *
 * ```ts
 * const s = await client.suggestedChanges.create({
 *   agentId: 'acme.scorer',
 *   projectId,
 *   block: 'acme.scoring-weights',
 *   values: { recency: 0.4, fit: 0.6 },
 *   why: 'Recent filings matter more for this company',
 * });
 * // …once `status` is `ready`, and `s.check` says how it did:
 * await client.suggestedChanges.pin(s.id);
 * ```
 */
export interface SuggestedChangesClient {
  /**
   * Newest first; only suggested changes of agents the caller can read.
   *
   * @wire `GET /v1/suggested-changes`
   */
  list(input?: SuggestedChangesListInput): Promise<ListPage<SuggestedChange>>;

  /** @wire `GET /v1/suggested-changes/{suggestedChangeId}` */
  get(id: SuggestedChangeId | string): Promise<SuggestedChange>;

  /**
   * A suggested change for a project, built on what the project runs and
   * checked on its test set: the suggested change, `checking`. The same
   * change on the same version for the same project returns the one made
   * before.
   *
   * @wire `POST /v1/suggested-changes`
   */
  create(input: CreateSuggestedChangeInput): Promise<SuggestedChange>;

  /**
   * Check it again on its project's test set, frozen now, so new
   * corrections count: the suggested change, `checking`.
   *
   * @wire `POST /v1/suggested-changes/{suggestedChangeId}/check`
   */
  check(
    id: SuggestedChangeId | string,
    input?: { readonly idempotencyKey?: string },
  ): Promise<SuggestedChange>;

  /**
   * A pin of its version for its project, through the project's gate: the
   * pin as `agents.pinned.pin` answers it, with the suggested change,
   * `pinned` or `waiting-for-second-person`. A gate refusal throws
   * (`gate-failed`, with the checks). A project on Latest throws
   * `pin-stops-latest` (409) unless `stopFollowingLatest` is set; it
   * takes the change as its Latest instead (`addAsLatest`).
   *
   * @wire `POST /v1/suggested-changes/{suggestedChangeId}/pin`
   */
  pin(
    id: SuggestedChangeId | string,
    input?: SuggestedChangePinInput,
  ): Promise<SuggestedChangePinAnswer>;

  /**
   * Its version made its project's Latest, now, for a project on Latest
   * (no gate): the suggested change, `added-as-latest`. A pinned project
   * takes a pin instead (`suggested-change-project-pinned`).
   *
   * @wire `POST /v1/suggested-changes/{suggestedChangeId}/add-as-latest`
   */
  addAsLatest(
    id: SuggestedChangeId | string,
    input?: SuggestedChangeReasonInput,
  ): Promise<SuggestedChange>;

  /** @wire `POST /v1/suggested-changes/{suggestedChangeId}/withdraw` */
  withdraw(id: SuggestedChangeId | string, input: WithdrawInput): Promise<SuggestedChange>;
}

export interface SuggestedChangesListInput {
  readonly limit?: number;
  readonly cursor?: Cursor | string;
  readonly agentId?: AgentId | string;
  /** Only suggested changes for this project. */
  readonly projectId?: string;
  /**
   * Statuses and makers are derived, so a page filtered by either can hold
   * fewer rows than `limit`.
   */
  readonly status?: SuggestedChangeStatus;
  readonly madeBy?: SuggestedChangeMadeBy['kind'];
}

export type CreateSuggestedChangeInput = {
  readonly agentId: AgentId | string;
  /** The project it's for: it's built on what the project runs. */
  readonly projectId: string;
  /** The block it changes: one the project's version of the agent pins. */
  readonly block: string;
  /** What the change should fix, and why. */
  readonly why: string;
  /** The corrections it fixes, by id. */
  readonly fixes?: readonly string[];
  readonly idempotencyKey?: string;
} & SuggestedChangeContent;

export interface SuggestedChangeReasonInput {
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export interface SuggestedChangePinInput extends SuggestedChangeReasonInput {
  /**
   * Pin even when its project follows Latest now: the project then runs
   * the pinned version, not each new Latest. Without it, that pin throws
   * `pin-stops-latest` (409).
   */
  readonly stopFollowingLatest?: boolean;
}

export interface WithdrawInput {
  readonly reason: string;
  readonly idempotencyKey?: string;
}

const seg = (id: SuggestedChangeId | string): string => encodeURIComponent(id as string);

export function makeSuggestedChangesClient(transport: Transport): SuggestedChangesClient {
  const post = (req: { path: string; body: object; idempotencyKey: string | undefined }) =>
    transport.request<SuggestedChange>({
      method: 'POST',
      path: req.path,
      body: req.body as Record<string, unknown>,
      ...(req.idempotencyKey !== undefined && { idempotencyKey: req.idempotencyKey }),
    });

  return {
    async list(input = {}) {
      const page = await transport.request<WirePage<SuggestedChange>>({
        method: 'GET',
        path: '/v1/suggested-changes',
        query: {
          ...(input.limit !== undefined && { limit: input.limit }),
          ...(input.cursor !== undefined && { cursor: input.cursor as string }),
          ...(input.agentId !== undefined && { agentId: input.agentId as string }),
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.madeBy !== undefined && { madeBy: input.madeBy }),
        },
      });
      return listPage(page);
    },

    async get(id) {
      return transport.request<SuggestedChange>({
        method: 'GET',
        path: `/v1/suggested-changes/${seg(id)}`,
      });
    },

    async create(input) {
      const { idempotencyKey, ...body } = input;
      return transport.request<SuggestedChange>({
        method: 'POST',
        path: '/v1/suggested-changes',
        body: body as unknown as Record<string, unknown>,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      });
    },

    async check(id, input = {}) {
      const { idempotencyKey } = input;
      return post({ path: `/v1/suggested-changes/${seg(id)}/check`, body: {}, idempotencyKey });
    },

    async pin(id, input = {}) {
      const { idempotencyKey, ...body } = input;
      return transport.request<SuggestedChangePinAnswer>({
        method: 'POST',
        path: `/v1/suggested-changes/${seg(id)}/pin`,
        body: body as Record<string, unknown>,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      });
    },

    async addAsLatest(id, input = {}) {
      const { idempotencyKey, ...body } = input;
      return post({
        path: `/v1/suggested-changes/${seg(id)}/add-as-latest`,
        body,
        idempotencyKey,
      });
    },

    async withdraw(id, input) {
      const { idempotencyKey, ...body } = input;
      return post({ path: `/v1/suggested-changes/${seg(id)}/withdraw`, body, idempotencyKey });
    },
  };
}

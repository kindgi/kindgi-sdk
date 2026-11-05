// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Text triggers: each text (SMS or WhatsApp) to a business phone number
 * starts a run of an agent or a flow, with the text as the run's input, as
 * the trigger's owner.
 *
 * @wire /v1/text-triggers/*  (packages/api/src/routes/text-triggers.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * A flow's input is `{ text, thread }`: `text` is the text that came in,
 * `{ from, channel, body, receivedAt }` (`channel` `sms` or `whatsapp`),
 * and `thread` the conversation it is part of,
 * `{ connectionId, channel, sender }`.
 *
 * `config.connectionId` names the number: one of the project's company
 * connections of app `texts`. One live text trigger answers a connection,
 * paused or not: registering another on it, or moving one onto it, fails
 * with a `conflict` whose `reason` is `trigger-connection-taken` and whose
 * `fields.heldBy` names the trigger that answers it, which can be in
 * another project of the workspace.
 *
 * The number is the company's, so registering and every update take a
 * project admin. A trigger is shared when a service account owns it
 * (`runAsServiceAccountId`, or `runAsProject` for the project's own
 * account), and personal when a person does. No edit moves the owner;
 * only `takeOwnership` does.
 *
 * In a run a text started, every call that changes something waits for a
 * person's yes unless the trigger lists it in `toolsAllowedUnattended`,
 * which a project admin sets. A text that isn't a reply
 * (`kindgi_send_text`) always waits: the list never names it.
 */

import type {
  PatchTextTriggerBody,
  RegisterTextTriggerBody,
  TakeTriggerOwnerBody,
  TextFire,
  TextFirePage,
  TextTriggerCollectionPage,
  TextTriggerRecord,
  TextTriggerVersion,
  TextTriggerVersionPage,
  WebhookTriggerUnregisterResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type TextTrigger = TextTriggerRecord;
export type TextTriggerPage = TextTriggerCollectionPage;
export type RegisterTextTriggerInput = RegisterTextTriggerBody;
export type UpdateTextTriggerInput = PatchTextTriggerBody;
export type UnregisterTextTriggerResult = WebhookTriggerUnregisterResult;
export type { TextFire, TextFirePage, TextTriggerVersion, TextTriggerVersionPage };

export interface ListTextTriggersFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: 'active' | 'paused';
  /** Only this project's triggers (needs `read` on it). */
  readonly projectId?: string;
}

export interface ListTextFiresFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListTextTriggerVersionsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TextTriggersClient {
  /** @wire POST /v1/text-triggers */
  register(input: RegisterTextTriggerInput, options?: MutationOptions): Promise<TextTrigger>;
  /** @wire GET /v1/text-triggers */
  list(filter?: ListTextTriggersFilter): Promise<TextTriggerPage>;
  /** @wire GET /v1/text-triggers/:triggerId */
  get(triggerId: string): Promise<TextTrigger>;
  /**
   * Changes what it runs, its connection, pace or label. The owner stays:
   * a project admin's change to a person's trigger goes on acting as that
   * person, and is audited.
   *
   * @wire PATCH /v1/text-triggers/:triggerId
   */
  update(
    triggerId: string,
    input: UpdateTextTriggerInput,
    options?: MutationOptions,
  ): Promise<TextTrigger>;
  /**
   * A paused trigger answers no texts: one that comes in while it's paused
   * never starts a run. It still holds its connection.
   *
   * @wire POST /v1/text-triggers/:triggerId/pause
   */
  pause(triggerId: string, options?: MutationOptions): Promise<TextTrigger>;
  /** @wire POST /v1/text-triggers/:triggerId/resume */
  resume(triggerId: string, options?: MutationOptions): Promise<TextTrigger>;
  /** @wire POST /v1/text-triggers/:triggerId/unregister (soft-delete) */
  unregister(triggerId: string, options?: MutationOptions): Promise<UnregisterTextTriggerResult>;
  /**
   * The trigger's texts, newest first: the run each started, or why it
   * was skipped or refused.
   *
   * @wire GET /v1/text-triggers/:triggerId/fires
   */
  fires(triggerId: string, filter?: ListTextFiresFilter): Promise<TextFirePage>;
  /**
   * The trigger's versions, newest first: what it was from each version's
   * `createdAt` on, who made it (`createdBy`) and why (`cause`). Each
   * change makes one; a change that alters nothing, pausing and resuming
   * make none. A text's run uses the newest when it starts, and keeps it
   * (its `trigger.version`).
   *
   * @wire GET /v1/text-triggers/:triggerId/versions
   */
  versions(
    triggerId: string,
    filter?: ListTextTriggerVersionsFilter,
  ): Promise<TextTriggerVersionPage>;
  /**
   * One version of the trigger, by its number (from 1). Returns 404
   * `trigger-version-not-found` for a number it never had.
   *
   * @wire GET /v1/text-triggers/:triggerId/versions/:version
   */
  getVersion(triggerId: string, version: number): Promise<TextTriggerVersion>;
  /**
   * The caller becomes the trigger's owner: its runs act as the caller,
   * with the caller's connections, from the next text. Pass
   * `{ runAsServiceAccountId }` to make a service account the owner
   * instead (needs `act_as` on the account), or `{ runAsProject: true }`
   * to make the project's own account the owner (made the first time).
   *
   * @wire POST /v1/text-triggers/:triggerId/owner
   */
  takeOwnership(
    triggerId: string,
    input?: TakeTriggerOwnerBody,
    options?: MutationOptions,
  ): Promise<TextTrigger>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export function makeTextTriggersClient(transport: Transport): TextTriggersClient {
  const key = (options: MutationOptions | undefined) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};
  return {
    async register(input, options) {
      return transport.request<TextTrigger>({
        method: 'POST',
        path: '/v1/text-triggers',
        body: input,
        ...key(options),
      });
    },
    async list(filter) {
      return transport.request<TextTriggerPage>({
        method: 'GET',
        path: '/v1/text-triggers',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.status !== undefined && { status: filter.status }),
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
        },
      });
    },
    async get(triggerId) {
      return transport.request<TextTrigger>({
        method: 'GET',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}`,
      });
    },
    async update(triggerId, input, options) {
      return transport.request<TextTrigger>({
        method: 'PATCH',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}`,
        body: input,
        ...key(options),
      });
    },
    async pause(triggerId, options) {
      return transport.request<TextTrigger>({
        method: 'POST',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}/pause`,
        ...key(options),
      });
    },
    async resume(triggerId, options) {
      return transport.request<TextTrigger>({
        method: 'POST',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}/resume`,
        ...key(options),
      });
    },
    async unregister(triggerId, options) {
      return transport.request<UnregisterTextTriggerResult>({
        method: 'POST',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}/unregister`,
        ...key(options),
      });
    },
    async fires(triggerId, filter) {
      return transport.request<TextFirePage>({
        method: 'GET',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}/fires`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async versions(triggerId, filter) {
      return transport.request<TextTriggerVersionPage>({
        method: 'GET',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}/versions`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async getVersion(triggerId, version) {
      return transport.request<TextTriggerVersion>({
        method: 'GET',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}/versions/${version}`,
      });
    },
    async takeOwnership(triggerId, input, options) {
      return transport.request<TextTrigger>({
        method: 'POST',
        path: `/v1/text-triggers/${encodeURIComponent(triggerId)}/owner`,
        ...(input !== undefined && { body: input }),
        ...key(options),
      });
    },
  };
}

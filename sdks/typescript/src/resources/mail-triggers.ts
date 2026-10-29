// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Mail triggers: each new mail in a mailbox's folder starts a run of an
 * agent or a flow, with the mail as the run's input, as the trigger's
 * owner.
 *
 * @wire /v1/mail-triggers/*  (packages/api/src/routes/mail-triggers.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * `config.mailbox` names the app (`google`: Gmail; `microsoft`: Outlook)
 * and whose mailbox it is: `person`, the owner's own, through their
 * connection; or `company`, the company's, through a company connection
 * of the app, which a project admin registers. `connectionId` names which
 * one (only with `company`); with none named, the project's only one is
 * stored, and with several the call fails with a `conflict` whose
 * `reason` is `connection-not-chosen` and whose `fields.choices` lists
 * them.
 *
 * A trigger is shared when a service account owns it (the company's
 * mailbox, with `runAsServiceAccountId`, or `runAsProject` for the
 * project's own account), and personal when a person does.
 * No edit moves the owner; only `takeOwnership` does. A personal
 * trigger's update, pause, resume and unregister are its owner's or a
 * project admin's, but only its owner points it at another of their
 * mailboxes or folders.
 *
 * In a run a mail started, every call that changes something, or uses the
 * run's own mailbox, waits for a person's yes unless the trigger lists it
 * in `toolsAllowedUnattended`, which a project admin sets.
 */

import type {
  MailFire,
  MailFirePage,
  MailTriggerCollectionPage,
  MailTriggerMailbox,
  MailTriggerRecord,
  PatchMailTriggerBody,
  RegisterMailTriggerBody,
  TakeTriggerOwnerBody,
  WebhookTriggerUnregisterResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type MailTrigger = MailTriggerRecord;
export type MailTriggerPage = MailTriggerCollectionPage;
export type RegisterMailTriggerInput = RegisterMailTriggerBody;
export type UpdateMailTriggerInput = PatchMailTriggerBody;
export type UnregisterMailTriggerResult = WebhookTriggerUnregisterResult;
export type { MailFire, MailFirePage, MailTriggerMailbox };

export interface ListMailTriggersFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: 'active' | 'paused';
  /** Only this project's triggers (needs `read` on it). */
  readonly projectId?: string;
}

export interface ListMailFiresFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface MailTriggersClient {
  /** @wire POST /v1/mail-triggers */
  register(input: RegisterMailTriggerInput, options?: MutationOptions): Promise<MailTrigger>;
  /** @wire GET /v1/mail-triggers */
  list(filter?: ListMailTriggersFilter): Promise<MailTriggerPage>;
  /** @wire GET /v1/mail-triggers/:triggerId */
  get(triggerId: string): Promise<MailTrigger>;
  /**
   * Changes what it runs, its mailbox, folder, pace or label. The owner
   * stays: a project admin's change to a person's trigger goes on acting as
   * that person, and is audited. Only a person's trigger's owner points it
   * at another of their mailboxes or folders; an admin may move it to the
   * company's mailbox.
   *
   * @wire PATCH /v1/mail-triggers/:triggerId
   */
  update(
    triggerId: string,
    input: UpdateMailTriggerInput,
    options?: MutationOptions,
  ): Promise<MailTrigger>;
  /**
   * A paused trigger doesn't poll. A resume starts afresh: mail that came
   * while it was paused doesn't start runs.
   *
   * @wire POST /v1/mail-triggers/:triggerId/pause
   */
  pause(triggerId: string, options?: MutationOptions): Promise<MailTrigger>;
  /** @wire POST /v1/mail-triggers/:triggerId/resume */
  resume(triggerId: string, options?: MutationOptions): Promise<MailTrigger>;
  /** @wire POST /v1/mail-triggers/:triggerId/unregister (soft-delete) */
  unregister(triggerId: string, options?: MutationOptions): Promise<UnregisterMailTriggerResult>;
  /**
   * The trigger's mail, newest first: the run each started, why it waits
   * (`thread-busy:`), or why it was skipped or refused.
   *
   * @wire GET /v1/mail-triggers/:triggerId/fires
   */
  fires(triggerId: string, filter?: ListMailFiresFilter): Promise<MailFirePage>;
  /**
   * The caller becomes the trigger's owner: its runs act as the caller,
   * with the caller's connections, from the next poll. On the company's
   * mailbox, pass `{ runAsServiceAccountId }` to make a service account
   * the owner instead (needs `act_as` on the account), or
   * `{ runAsProject: true }` to make the project's own account the owner
   * (made the first time).
   *
   * @wire POST /v1/mail-triggers/:triggerId/owner
   */
  takeOwnership(
    triggerId: string,
    input?: TakeTriggerOwnerBody,
    options?: MutationOptions,
  ): Promise<MailTrigger>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export function makeMailTriggersClient(transport: Transport): MailTriggersClient {
  const key = (options: MutationOptions | undefined) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};
  return {
    async register(input, options) {
      return transport.request<MailTrigger>({
        method: 'POST',
        path: '/v1/mail-triggers',
        body: input,
        ...key(options),
      });
    },
    async list(filter) {
      return transport.request<MailTriggerPage>({
        method: 'GET',
        path: '/v1/mail-triggers',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.status !== undefined && { status: filter.status }),
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
        },
      });
    },
    async get(triggerId) {
      return transport.request<MailTrigger>({
        method: 'GET',
        path: `/v1/mail-triggers/${encodeURIComponent(triggerId)}`,
      });
    },
    async update(triggerId, input, options) {
      return transport.request<MailTrigger>({
        method: 'PATCH',
        path: `/v1/mail-triggers/${encodeURIComponent(triggerId)}`,
        body: input,
        ...key(options),
      });
    },
    async pause(triggerId, options) {
      return transport.request<MailTrigger>({
        method: 'POST',
        path: `/v1/mail-triggers/${encodeURIComponent(triggerId)}/pause`,
        ...key(options),
      });
    },
    async resume(triggerId, options) {
      return transport.request<MailTrigger>({
        method: 'POST',
        path: `/v1/mail-triggers/${encodeURIComponent(triggerId)}/resume`,
        ...key(options),
      });
    },
    async unregister(triggerId, options) {
      return transport.request<UnregisterMailTriggerResult>({
        method: 'POST',
        path: `/v1/mail-triggers/${encodeURIComponent(triggerId)}/unregister`,
        ...key(options),
      });
    },
    async fires(triggerId, filter) {
      return transport.request<MailFirePage>({
        method: 'GET',
        path: `/v1/mail-triggers/${encodeURIComponent(triggerId)}/fires`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async takeOwnership(triggerId, input, options) {
      return transport.request<MailTrigger>({
        method: 'POST',
        path: `/v1/mail-triggers/${encodeURIComponent(triggerId)}/owner`,
        ...(input !== undefined && { body: input }),
        ...key(options),
      });
    },
  };
}

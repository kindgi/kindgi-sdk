// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Webhook triggers: a signed request to a trigger's `receiveUrl` starts a
 * run of its flow, as the trigger's owner.
 *
 * @wire /v1/webhooks/*  (packages/api/src/routes/webhooks.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * These are INBOUND triggers. Outbound webhooks (Kindgi calling your URLs
 * with signed events) are `client.webhookEndpoints`.
 *
 * The signing secret is never on the trigger: `hmacSecretName` names a
 * secret written first (`client.secrets`), never a model provider's key.
 * `signature` says how the sender signs (default: hex HMAC-SHA256 of the
 * raw body in `X-Kindgi-Signature`; WooCommerce: base64 in
 * `X-WC-Webhook-Signature`; GitHub and Drupal's Webhooks module: hex after
 * `sha256=` in `X-Hub-Signature-256`; or `standard-webhooks`).
 *
 * The sender posts to the trigger's `receiveUrl`
 * (`POST /v1/hooks/{tenantId}/{webhookId}`), which needs no sign-in: its
 * signature is what's checked. A paused trigger takes deliveries and starts
 * nothing; their events are dropped.
 */

import type {
  PatchWebhookTriggerBody,
  RegisterWebhookTriggerBody,
  WebhookFire,
  WebhookFirePage,
  WebhookSignature,
  WebhookTriggerCollectionPage,
  WebhookTriggerRecord,
  WebhookTriggerUnregisterResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type WebhookTrigger = WebhookTriggerRecord;
export type WebhookTriggerPage = WebhookTriggerCollectionPage;
export type RegisterWebhookTriggerInput = RegisterWebhookTriggerBody;
export type UpdateWebhookTriggerInput = PatchWebhookTriggerBody;
export type UnregisterWebhookTriggerResult = WebhookTriggerUnregisterResult;
export type { WebhookFire, WebhookFirePage, WebhookSignature };

export interface ListWebhookTriggersFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: 'active' | 'paused';
  /** Only this project's triggers (needs `read` on it). */
  readonly projectId?: string;
}

export interface ListWebhookFiresFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface WebhooksClient {
  /** @wire POST /v1/webhooks */
  register(input: RegisterWebhookTriggerInput, options?: MutationOptions): Promise<WebhookTrigger>;
  /** @wire GET /v1/webhooks */
  list(filter?: ListWebhookTriggersFilter): Promise<WebhookTriggerPage>;
  /** @wire GET /v1/webhooks/:triggerId */
  get(triggerId: string): Promise<WebhookTrigger>;
  /** @wire PATCH /v1/webhooks/:triggerId */
  update(
    triggerId: string,
    input: UpdateWebhookTriggerInput,
    options?: MutationOptions,
  ): Promise<WebhookTrigger>;
  /**
   * While paused, deliveries are taken and recorded as `skipped`, and no
   * run starts: their events are dropped (WooCommerce never resends).
   *
   * @wire POST /v1/webhooks/:triggerId/pause
   */
  pause(triggerId: string, options?: MutationOptions): Promise<WebhookTrigger>;
  /** @wire POST /v1/webhooks/:triggerId/resume */
  resume(triggerId: string, options?: MutationOptions): Promise<WebhookTrigger>;
  /** @wire POST /v1/webhooks/:triggerId/unregister (soft-delete) */
  unregister(triggerId: string, options?: MutationOptions): Promise<UnregisterWebhookTriggerResult>;
  /**
   * The trigger's deliveries, newest first: the run each started, or why
   * it was skipped or refused.
   *
   * @wire GET /v1/webhooks/:triggerId/fires
   */
  fires(triggerId: string, filter?: ListWebhookFiresFilter): Promise<WebhookFirePage>;
  /**
   * The caller becomes the trigger's owner: its runs act as the caller
   * from the next delivery.
   *
   * @wire POST /v1/webhooks/:triggerId/owner
   */
  takeOwnership(triggerId: string, options?: MutationOptions): Promise<WebhookTrigger>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export function makeWebhooksClient(transport: Transport): WebhooksClient {
  return {
    async register(input, options) {
      return transport.request<WebhookTrigger>({
        method: 'POST',
        path: '/v1/webhooks',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<WebhookTriggerPage>({
        method: 'GET',
        path: '/v1/webhooks',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.status !== undefined && { status: filter.status }),
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
        },
      });
    },
    async get(triggerId) {
      return transport.request<WebhookTrigger>({
        method: 'GET',
        path: `/v1/webhooks/${encodeURIComponent(triggerId)}`,
      });
    },
    async update(triggerId, input, options) {
      return transport.request<WebhookTrigger>({
        method: 'PATCH',
        path: `/v1/webhooks/${encodeURIComponent(triggerId)}`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async pause(triggerId, options) {
      return transport.request<WebhookTrigger>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(triggerId)}/pause`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async resume(triggerId, options) {
      return transport.request<WebhookTrigger>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(triggerId)}/resume`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async unregister(triggerId, options) {
      return transport.request<UnregisterWebhookTriggerResult>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(triggerId)}/unregister`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async fires(triggerId, filter) {
      return transport.request<WebhookFirePage>({
        method: 'GET',
        path: `/v1/webhooks/${encodeURIComponent(triggerId)}/fires`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async takeOwnership(triggerId, options) {
      return transport.request<WebhookTrigger>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(triggerId)}/owner`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}

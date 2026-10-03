// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Webhook triggers — fire a flow run when an external HMAC-signed
 * request arrives at the receiver URL.
 *
 * @wire /v1/webhooks/*  (packages/api/src/routes/webhooks.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * These are INBOUND triggers. Outbound webhooks (Kindgi calling your
 * URLs with signed events) are `client.webhookEndpoints`.
 *
 * The register body carries `hmacSecretName` — a handle into the
 * tenant secrets store. Caller writes plaintext to `/v1/secrets`
 * FIRST, then passes the resulting name here. Plaintext never touches
 * the trigger row. Rotation flows through
 * `POST /v1/secrets/:name/rotate`.
 *
 * The API does not include the external receiver endpoint itself
 * (`POST /v1/webhooks/:webhookId/receive`) — it would need
 * unauthenticated tenant resolution. Responses carry `webhookId`, the
 * identifier a receiver URL is built from.
 */

import type {
  PatchWebhookTriggerBody,
  RegisterWebhookTriggerBody,
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

export interface ListWebhookTriggersFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: 'active' | 'paused';
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
  /** @wire POST /v1/webhooks/:triggerId/pause */
  pause(triggerId: string, options?: MutationOptions): Promise<WebhookTrigger>;
  /** @wire POST /v1/webhooks/:triggerId/resume */
  resume(triggerId: string, options?: MutationOptions): Promise<WebhookTrigger>;
  /** @wire POST /v1/webhooks/:triggerId/unregister (soft-delete) */
  unregister(triggerId: string, options?: MutationOptions): Promise<UnregisterWebhookTriggerResult>;
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
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Outbound webhook endpoints: URLs Kindgi sends signed events to, such as
 * `run.finished` when a top-level run completes, fails or is cancelled.
 *
 * @wire /v1/webhook-endpoints/*  (packages/api/src/routes/webhook-endpoints.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * Not to be confused with `client.webhooks`, which manages inbound
 * webhook triggers.
 *
 * The signing secret is shared with your receiver, so it lives in your
 * secrets (`.env` in development, the secrets store in production): store
 * it first (`generateSecret()` makes a strong one), then register the
 * endpoint with `secretRef: { envName, name }`. Requests to the endpoint
 * are signed in the Standard Webhooks format and delivered at least once:
 * verify them with `verifyWebhook` from `@kindgi/crypto` (or any Standard
 * Webhooks library) and deduplicate on the `webhook-id` header.
 */

import type {
  CreateWebhookEndpointBody,
  GeneratedWebhookSecret as GeneratedWebhookSecretWire,
  PatchWebhookEndpointBody,
  RunFinishedEvent as RunFinishedEventWire,
  WebhookDeliveryCollectionPage,
  WebhookDeliveryStatus as WebhookDeliveryStatusWire,
  WebhookDelivery as WebhookDeliveryWire,
  WebhookEndpointCollectionPage,
  WebhookEndpointUnregisterResult,
  WebhookEndpoint as WebhookEndpointWire,
  WebhookEvent as WebhookEventWire,
  WebhookSecretRef as WebhookSecretRefWire,
  WebhookTestEvent as WebhookTestEventWire,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type WebhookEndpoint = WebhookEndpointWire;
export type WebhookSecretRef = WebhookSecretRefWire;
export type GeneratedWebhookSecret = GeneratedWebhookSecretWire;
export type WebhookEndpointPage = WebhookEndpointCollectionPage;
export type CreateWebhookEndpointInput = CreateWebhookEndpointBody;
export type UpdateWebhookEndpointInput = PatchWebhookEndpointBody;
export type UnregisterWebhookEndpointResult = WebhookEndpointUnregisterResult;
export type WebhookDelivery = WebhookDeliveryWire;
export type WebhookDeliveryPage = WebhookDeliveryCollectionPage;
export type WebhookDeliveryStatus = WebhookDeliveryStatusWire;
/** The JSON body of a webhook request. */
export type WebhookEvent = WebhookEventWire;
export type RunFinishedEvent = RunFinishedEventWire;
export type WebhookTestEvent = WebhookTestEventWire;

export interface ListWebhookEndpointsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListWebhookDeliveriesFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: WebhookDeliveryStatus;
}

export interface WebhookEndpointsClient {
  /** @wire POST /v1/webhook-endpoints — `secretRef` names a secret you stored first. */
  create(input: CreateWebhookEndpointInput, options?: MutationOptions): Promise<WebhookEndpoint>;
  /** @wire POST /v1/webhook-endpoints/generate-secret — a strong secret to store; nothing is kept. */
  generateSecret(): Promise<GeneratedWebhookSecret>;
  /** @wire GET /v1/webhook-endpoints */
  list(filter?: ListWebhookEndpointsFilter): Promise<WebhookEndpointPage>;
  /** @wire GET /v1/webhook-endpoints/:endpointId */
  get(endpointId: string): Promise<WebhookEndpoint>;
  /** @wire PATCH /v1/webhook-endpoints/:endpointId */
  update(
    endpointId: string,
    input: UpdateWebhookEndpointInput,
    options?: MutationOptions,
  ): Promise<WebhookEndpoint>;
  /** @wire POST /v1/webhook-endpoints/:endpointId/unregister (soft delete) */
  unregister(
    endpointId: string,
    options?: MutationOptions,
  ): Promise<UnregisterWebhookEndpointResult>;
  /** @wire GET /v1/webhook-endpoints/:endpointId/deliveries */
  listDeliveries(
    endpointId: string,
    filter?: ListWebhookDeliveriesFilter,
  ): Promise<WebhookDeliveryPage>;
  /** @wire POST /v1/webhook-endpoints/:endpointId/deliveries/:deliveryId/redeliver */
  redeliver(
    endpointId: string,
    deliveryId: string,
    options?: MutationOptions,
  ): Promise<WebhookDelivery>;
  /** @wire POST /v1/webhook-endpoints/:endpointId/test — queues a `webhook.test` event. */
  sendTest(endpointId: string, options?: MutationOptions): Promise<WebhookDelivery>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export function makeWebhookEndpointsClient(transport: Transport): WebhookEndpointsClient {
  const idempotency = (options?: MutationOptions) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};

  return {
    async create(input, options) {
      return transport.request<WebhookEndpoint>({
        method: 'POST',
        path: '/v1/webhook-endpoints',
        body: input,
        ...idempotency(options),
      });
    },
    async generateSecret() {
      return transport.request<GeneratedWebhookSecret>({
        method: 'POST',
        path: '/v1/webhook-endpoints/generate-secret',
      });
    },
    async list(filter) {
      return transport.request<WebhookEndpointPage>({
        method: 'GET',
        path: '/v1/webhook-endpoints',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async get(endpointId) {
      return transport.request<WebhookEndpoint>({
        method: 'GET',
        path: `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`,
      });
    },
    async update(endpointId, input, options) {
      return transport.request<WebhookEndpoint>({
        method: 'PATCH',
        path: `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`,
        body: input,
        ...idempotency(options),
      });
    },
    async unregister(endpointId, options) {
      return transport.request<UnregisterWebhookEndpointResult>({
        method: 'POST',
        path: `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/unregister`,
        ...idempotency(options),
      });
    },
    async listDeliveries(endpointId, filter) {
      return transport.request<WebhookDeliveryPage>({
        method: 'GET',
        path: `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/deliveries`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.status !== undefined && { status: filter.status }),
        },
      });
    },
    async redeliver(endpointId, deliveryId, options) {
      return transport.request<WebhookDelivery>({
        method: 'POST',
        path: `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
        ...idempotency(options),
      });
    },
    async sendTest(endpointId, options) {
      return transport.request<WebhookDelivery>({
        method: 'POST',
        path: `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/test`,
        ...idempotency(options),
      });
    },
  };
}

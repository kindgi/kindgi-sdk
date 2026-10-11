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

import type { ApprovalId, RunId } from '@kindgi/types';

import type {
  ApprovalRequestedEvent as ApprovalRequestedEventWire,
  CreateWebhookEndpointBody,
  FinishedRun as FinishedRunWire,
  GeneratedWebhookSecret as GeneratedWebhookSecretWire,
  ImprovementPassFinishedEvent as ImprovementPassFinishedEventWire,
  PatchWebhookEndpointBody,
  RequestedApproval as RequestedApprovalWire,
  RunFinishedEvent as RunFinishedEventWire,
  WebhookDeliveryCollectionPage,
  WebhookDeliveryStatus as WebhookDeliveryStatusWire,
  WebhookDelivery as WebhookDeliveryWire,
  WebhookEndpointCollectionPage,
  WebhookEndpointUnregisterResult,
  WebhookEndpoint as WebhookEndpointWire,
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
/**
 * A finished top-level run as a `run.finished` event carries it: its identity and outcome,
 * never its input or output. `id` is a `RunId`, so `client.runs.get(run.id)` fetches the rest.
 */
export type FinishedRun = Omit<FinishedRunWire, 'id'> & { readonly id: RunId };
/** A top-level run completed, failed or was cancelled. */
export type RunFinishedEvent = Omit<RunFinishedEventWire, 'data'> & {
  readonly data: { readonly run: FinishedRun };
};
/** An improvement pass ended; `data.pass` is as `client.improvementPasses.get` shows it. */
export type ImprovementPassFinishedEvent = ImprovementPassFinishedEventWire;
/**
 * The approval an `approval.requested` event names. `approvalId` is an `ApprovalId`, so
 * `client.approvals.get(approval.approvalId)` reads the rest (what it's about stays behind sign-in).
 */
export type RequestedApproval = Omit<RequestedApprovalWire, 'approvalId'> & {
  readonly approvalId: ApprovalId;
};
/** An approval was asked for: a reviewer's decision is waiting. */
export type ApprovalRequestedEvent = Omit<ApprovalRequestedEventWire, 'data'> & {
  readonly data: { readonly approval: RequestedApproval };
};
/** What `client.webhookEndpoints.sendTest(endpointId)` sends. */
export type WebhookTestEvent = WebhookTestEventWire;
/**
 * The JSON body of a webhook request, one of the events above by its `type`. Read one from a
 * verified request with `parseEvent` (`@kindgi/sdk/webhooks`).
 */
export type WebhookEvent =
  | RunFinishedEvent
  | ImprovementPassFinishedEvent
  | ApprovalRequestedEvent
  | WebhookTestEvent;

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

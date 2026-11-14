// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Destinations: where schedules send their results. An email to
 * workspace members, a Slack, Teams, Google Chat or Discord channel, or a
 * signed webhook.
 *
 * @wire /v1/destinations/*  (packages/api/src/routes/destinations.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * A destination's URL is write-only: give it as `url` (the runtime keeps
 * it in its secrets store) or name a stored one with `urlRef`. It is never
 * returned; `host` and `urlRef` say where it goes. A `webhook`
 * destination signs what it sends with a secret it names by reference
 * (`secretRef`), as a webhook endpoint does.
 *
 * A workspace admin's. A member who can run in a project lists the ones
 * its schedules may use with `list({ projectId })`, without their
 * `people`, `host`, `urlRef`, `secretRef` and `projects`. A runtime
 * before Kindgi 0.7.0 doesn't serve these routes.
 */

import type {
  CreateDestinationBody,
  DestinationCollectionPage,
  DestinationContent as DestinationContentWire,
  DestinationDeliveryCollectionPage,
  DestinationDeliveryEvent as DestinationDeliveryEventWire,
  DestinationDeliveryStatus as DestinationDeliveryStatusWire,
  DestinationDelivery as DestinationDeliveryWire,
  DestinationKind as DestinationKindWire,
  DestinationSecretRef as DestinationSecretRefWire,
  DestinationStatus as DestinationStatusWire,
  Destination as DestinationWire,
  UpdateDestinationBody,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type Destination = DestinationWire;
export type DestinationKind = DestinationKindWire;
export type DestinationContent = DestinationContentWire;
export type DestinationStatus = DestinationStatusWire;
export type DestinationSecretRef = DestinationSecretRefWire;
export type DestinationPage = DestinationCollectionPage;
export type CreateDestinationInput = CreateDestinationBody;
export type UpdateDestinationInput = UpdateDestinationBody;
export type DestinationDelivery = DestinationDeliveryWire;
export type DestinationDeliveryPage = DestinationDeliveryCollectionPage;
export type DestinationDeliveryStatus = DestinationDeliveryStatusWire;
export type DestinationDeliveryEvent = DestinationDeliveryEventWire;

export interface ListDestinationsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /** Only the destinations this project's schedules may use. */
  readonly projectId?: string;
}

export interface ListDestinationDeliveriesFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: DestinationDeliveryStatus;
}

export interface DestinationsClient {
  /** @wire POST /v1/destinations: `url` is kept in the secrets store and never returned. */
  create(input: CreateDestinationInput, options?: MutationOptions): Promise<Destination>;
  /** @wire GET /v1/destinations: with `projectId`, the ones that project's schedules may use. */
  list(filter?: ListDestinationsFilter): Promise<DestinationPage>;
  /** @wire GET /v1/destinations/:destinationId */
  get(destinationId: string): Promise<Destination>;
  /** @wire PATCH /v1/destinations/:destinationId: a new `url` rotates the stored one. */
  update(
    destinationId: string,
    input: UpdateDestinationInput,
    options?: MutationOptions,
  ): Promise<Destination>;
  /** @wire DELETE /v1/destinations/:destinationId (soft delete) */
  remove(destinationId: string, options?: MutationOptions): Promise<void>;
  /** @wire GET /v1/destinations/:destinationId/deliveries */
  listDeliveries(
    destinationId: string,
    filter?: ListDestinationDeliveriesFilter,
  ): Promise<DestinationDeliveryPage>;
  /** @wire POST /v1/destinations/:destinationId/deliveries/:deliveryId/redeliver */
  redeliver(
    destinationId: string,
    deliveryId: string,
    options?: MutationOptions,
  ): Promise<DestinationDelivery>;
  /**
   * @wire POST /v1/destinations/:destinationId/test: queues a `destination.test` message. A
   * `failing` destination is `active` again once one reaches it.
   */
  sendTest(destinationId: string, options?: MutationOptions): Promise<DestinationDelivery>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export function makeDestinationsClient(transport: Transport): DestinationsClient {
  const idempotency = (options?: MutationOptions) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};

  return {
    async create(input, options) {
      return transport.request<Destination>({
        method: 'POST',
        path: '/v1/destinations',
        body: input,
        ...idempotency(options),
      });
    },
    async list(filter) {
      return transport.request<DestinationPage>({
        method: 'GET',
        path: '/v1/destinations',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
        },
      });
    },
    async get(destinationId) {
      return transport.request<Destination>({
        method: 'GET',
        path: `/v1/destinations/${encodeURIComponent(destinationId)}`,
      });
    },
    async update(destinationId, input, options) {
      return transport.request<Destination>({
        method: 'PATCH',
        path: `/v1/destinations/${encodeURIComponent(destinationId)}`,
        body: input,
        ...idempotency(options),
      });
    },
    async remove(destinationId, options) {
      await transport.request<void>({
        method: 'DELETE',
        path: `/v1/destinations/${encodeURIComponent(destinationId)}`,
        discardResponse: true,
        ...idempotency(options),
      });
    },
    async listDeliveries(destinationId, filter) {
      return transport.request<DestinationDeliveryPage>({
        method: 'GET',
        path: `/v1/destinations/${encodeURIComponent(destinationId)}/deliveries`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.status !== undefined && { status: filter.status }),
        },
      });
    },
    async redeliver(destinationId, deliveryId, options) {
      return transport.request<DestinationDelivery>({
        method: 'POST',
        path: `/v1/destinations/${encodeURIComponent(destinationId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
        ...idempotency(options),
      });
    },
    async sendTest(destinationId, options) {
      return transport.request<DestinationDelivery>({
        method: 'POST',
        path: `/v1/destinations/${encodeURIComponent(destinationId)}/test`,
        ...idempotency(options),
      });
    },
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Event triggers — fire a flow run when a matching event arrives on
 * the framework event bus.
 *
 * @wire /v1/event-triggers/*  (packages/api/src/routes/event-triggers.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * Distinct from `client.events` (pub/sub — emit/subscribe/query,
 * which has no API routes). Registering an event trigger stores a
 * trigger of kind `event`; the runtime's event-trigger scheduler
 * subscribes on the deployment-wired event bus for the configured
 * `eventKind` and spawns runs on matches.
 */

import type {
  EventTriggerCollectionPage,
  EventTriggerRecord,
  EventTriggerUnregisterResult,
  PatchEventTriggerBody,
  RegisterEventTriggerBody,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type EventTrigger = EventTriggerRecord;
export type EventTriggerPage = EventTriggerCollectionPage;
export type RegisterEventTriggerInput = RegisterEventTriggerBody;
export type UpdateEventTriggerInput = PatchEventTriggerBody;
export type UnregisterEventTriggerResult = EventTriggerUnregisterResult;

export interface ListEventTriggersFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: 'active' | 'paused';
}

export interface EventTriggersClient {
  /** @wire POST /v1/event-triggers */
  register(input: RegisterEventTriggerInput, options?: MutationOptions): Promise<EventTrigger>;
  /** @wire GET /v1/event-triggers */
  list(filter?: ListEventTriggersFilter): Promise<EventTriggerPage>;
  /** @wire GET /v1/event-triggers/:triggerId */
  get(triggerId: string): Promise<EventTrigger>;
  /** @wire PATCH /v1/event-triggers/:triggerId */
  update(
    triggerId: string,
    input: UpdateEventTriggerInput,
    options?: MutationOptions,
  ): Promise<EventTrigger>;
  /** @wire POST /v1/event-triggers/:triggerId/pause */
  pause(triggerId: string, options?: MutationOptions): Promise<EventTrigger>;
  /** @wire POST /v1/event-triggers/:triggerId/resume */
  resume(triggerId: string, options?: MutationOptions): Promise<EventTrigger>;
  /** @wire POST /v1/event-triggers/:triggerId/unregister (soft-delete) */
  unregister(triggerId: string, options?: MutationOptions): Promise<UnregisterEventTriggerResult>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export function makeEventTriggersClient(transport: Transport): EventTriggersClient {
  return {
    async register(input, options) {
      return transport.request<EventTrigger>({
        method: 'POST',
        path: '/v1/event-triggers',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<EventTriggerPage>({
        method: 'GET',
        path: '/v1/event-triggers',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.status !== undefined && { status: filter.status }),
        },
      });
    },
    async get(triggerId) {
      return transport.request<EventTrigger>({
        method: 'GET',
        path: `/v1/event-triggers/${encodeURIComponent(triggerId)}`,
      });
    },
    async update(triggerId, input, options) {
      return transport.request<EventTrigger>({
        method: 'PATCH',
        path: `/v1/event-triggers/${encodeURIComponent(triggerId)}`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async pause(triggerId, options) {
      return transport.request<EventTrigger>({
        method: 'POST',
        path: `/v1/event-triggers/${encodeURIComponent(triggerId)}/pause`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async resume(triggerId, options) {
      return transport.request<EventTrigger>({
        method: 'POST',
        path: `/v1/event-triggers/${encodeURIComponent(triggerId)}/resume`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async unregister(triggerId, options) {
      return transport.request<UnregisterEventTriggerResult>({
        method: 'POST',
        path: `/v1/event-triggers/${encodeURIComponent(triggerId)}/unregister`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}

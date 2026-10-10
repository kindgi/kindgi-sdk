// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { RunAgentRef } from '@kindgi/runtime';
import type {
  Cursor,
  EnvName,
  ProjectId,
  RunId,
  TenantId,
  Timestamp,
  WebhookDeliveryId,
  WebhookEndpointId,
  WebhookEventId,
} from '@kindgi/types';
import type { CostTokenTotals } from './cost-binding.js';

/**
 * Outbound webhook endpoints: URLs the platform sends signed events to,
 * such as `run.finished` when a run completes, fails or is cancelled.
 * The inverse of `/v1/webhooks`, which are inbound triggers.
 *
 * Caller-plugged: the runtime owns storage, secrets, the delivery queue
 * and the HTTP sender. This package defines the contract and the wire
 * shapes, and mounts `/v1/webhook-endpoints` when a binding is supplied.
 *
 * **Secrets.** An endpoint's signing secret is shared with the receiver,
 * so it lives where the deployment's other secrets do: the endpoint holds
 * a reference (`secretRef`, like a provider's `secret_ref`), never the
 * value. The caller stores the secret first (its own `.env` in
 * development, the secrets store in production; `generate-secret` makes
 * a strong one) and registers the endpoint with its name. The binding
 * resolves it at tenant scope to sign each delivery, and checks on
 * create and update that it exists and is strong (`whsec_` + base64 of
 * at least 24 bytes, or the bare base64). Rotating is rotating that
 * secret; while a store keeps the previous version, deliveries carry a
 * signature for each version less than a day old. Deliveries are signed
 * per `@kindgi/crypto` `signWebhook`; receivers verify with
 * `verifyWebhook` or any Standard Webhooks library.
 *
 * **Delivery.** At least once: receivers deduplicate on the event id
 * (the `webhook-id` header). Every method is tenant-scoped.
 */
export interface WebhookEndpointBinding {
  /**
   * Register an endpoint. The route has checked the body's shape and
   * that `url` is an absolute http(s) URL; the binding applies the
   * deployment's URL policy (e.g. https only, no private addresses) and
   * answers `url-refused` with a reason, and checks the secret behind
   * `secretRef` (`secret-not-found`, `secret-too-weak`).
   */
  create(input: WebhookEndpointCreateInput): Promise<WebhookEndpointCreateOutcome>;
  list(input: WebhookEndpointListInput): Promise<WebhookEndpointPage>;
  /** `null` when unknown or unregistered; the route answers 404. */
  get(input: WebhookEndpointRef): Promise<WebhookEndpoint | null>;
  update(input: WebhookEndpointUpdateInput): Promise<WebhookEndpointUpdateOutcome>;
  /**
   * Soft delete: the endpoint stops receiving events and its pending
   * deliveries are abandoned. `{ unregistered: false }` when it was
   * unknown or already unregistered.
   */
  unregister(input: WebhookEndpointRef): Promise<{ readonly unregistered: boolean }>;
  /** The endpoint's deliveries, newest first. */
  listDeliveries(input: WebhookDeliveryListInput): Promise<WebhookDeliveryListOutcome>;
  /** Queue a delivery again now, whatever its status; attempts start over. */
  redeliver(input: WebhookDeliveryRef): Promise<WebhookDeliveryOutcome>;
  /** Queue a `webhook.test` event to the endpoint, to check the receiver end to end. */
  sendTest(input: WebhookEndpointRef): Promise<WebhookDeliveryOutcome>;
}

/** Event types an endpoint can subscribe to. */
export const WEBHOOK_EVENT_TYPES = [
  'run.finished',
  'improvement-pass.finished',
  'approval.requested',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/**
 * Which events reach the endpoint. Every field narrows; absent fields
 * don't. `run.finished` is sent for top-level runs only (never for a
 * child run, such as an agent step's turn). `projectId` narrows
 * `improvement-pass.finished` and `approval.requested` too (the pass's or
 * the approval's project); `flowIds` and `includeDryRuns` are about runs
 * only.
 */
export interface WebhookEndpointFilter {
  /** Only runs in this project. */
  readonly projectId?: ProjectId;
  /** Only runs of these flows (`flowId`, any version). */
  readonly flowIds?: readonly string[];
  /** Dry runs are left out unless this is `true`. */
  readonly includeDryRuns?: boolean;
}

export interface WebhookEndpoint {
  readonly endpointId: WebhookEndpointId;
  readonly url: string;
  readonly events: readonly WebhookEventType[];
  readonly filter: WebhookEndpointFilter;
  readonly description: string | null;
  /** Where the signing secret is kept; the value never leaves the store. */
  readonly secretRef: WebhookSecretRef;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * A secret by name in the deployment's secrets store, resolved at tenant
 * scope — the same shape as a provider's `secret_ref`.
 */
export interface WebhookSecretRef {
  readonly envName: EnvName;
  readonly name: string;
}

export interface WebhookEndpointRef {
  readonly tenantId: TenantId;
  readonly endpointId: WebhookEndpointId;
}

export interface WebhookEndpointCreateInput {
  readonly tenantId: TenantId;
  readonly url: string;
  readonly events: readonly WebhookEventType[];
  readonly filter: WebhookEndpointFilter;
  readonly secretRef: WebhookSecretRef;
  readonly description?: string;
}

export interface WebhookEndpointListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface WebhookEndpointPage {
  readonly data: readonly WebhookEndpoint[];
  readonly nextCursor?: Cursor;
}

/** Fields to change; absent fields are kept. `description: null` clears it. */
export interface WebhookEndpointUpdateInput extends WebhookEndpointRef {
  readonly url?: string;
  readonly events?: readonly WebhookEventType[];
  readonly filter?: WebhookEndpointFilter;
  readonly secretRef?: WebhookSecretRef;
  readonly description?: string | null;
}

/** Why an endpoint can't be saved as asked. */
export type WebhookEndpointRefusal =
  | { readonly kind: 'url-refused'; readonly reason: string }
  | { readonly kind: 'project-not-found'; readonly projectId: ProjectId }
  /** No secret by that name (at tenant scope) in the store. */
  | { readonly kind: 'secret-not-found'; readonly secretRef: WebhookSecretRef }
  /** The secret is not `whsec_` + base64 of at least 24 bytes (or that base64 alone). */
  | { readonly kind: 'secret-too-weak'; readonly secretRef: WebhookSecretRef };

export type WebhookEndpointCreateOutcome =
  | { readonly kind: 'ok'; readonly endpoint: WebhookEndpoint }
  | WebhookEndpointRefusal;

export type WebhookEndpointUpdateOutcome =
  | { readonly kind: 'ok'; readonly endpoint: WebhookEndpoint }
  | { readonly kind: 'not-found' }
  | WebhookEndpointRefusal;

// ---------- events (what endpoints receive) ----------

/**
 * A finished top-level run, as `run.finished` carries it: the run's
 * identity and outcome, never its input or output. Field names match
 * `GET /v1/runs/:runId`.
 */
export interface FinishedRun {
  readonly id: RunId;
  readonly projectId: ProjectId;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly dryRun: boolean;
  /** Why the run failed or was cancelled; `null` when it completed. */
  readonly failureMessage: string | null;
  readonly createdAt: Timestamp;
  readonly completedAt: Timestamp;
  /**
   * The model calls of the whole run tree (this run and every run it
   * started), from the cost ledger, summed when the run ended. Absent
   * when the runtime records no usage.
   */
  readonly usage?: {
    readonly calls: number;
    readonly costUsd: number;
    readonly tokens: CostTokenTotals;
  };
  /**
   * On an agent's run: the agent, the version that ran and the
   * conversation, as `GET /v1/runs/:runId` shows them (its `flowId` is
   * `agent.turn`). Absent on a flow's run, and from a runtime that doesn't
   * send it yet.
   */
  readonly agent?: RunAgentRef;
}

export interface RunFinishedEvent {
  readonly id: WebhookEventId;
  readonly type: 'run.finished';
  readonly createdAt: Timestamp;
  readonly data: { readonly run: FinishedRun };
}

/**
 * An improvement pass ended (`completed`, `failed` or `cancelled`), one a
 * person started or one an `improve` schedule did. `data.pass` is the pass
 * as `GET /v1/improvement-passes/{passId}` shows it: its outcome names the
 * proposal it wrote, if it wrote one.
 */
export interface ImprovementPassFinishedEvent {
  readonly id: WebhookEventId;
  readonly type: 'improvement-pass.finished';
  readonly createdAt: Timestamp;
  readonly data: { readonly pass: Readonly<Record<string, unknown>> };
}

/**
 * An approval was asked for: a reviewer's decision is waiting. What the
 * approval is about stays behind sign-in: no `context`, no tool call or
 * run input. `url` is its page in the console, when the runtime knows its
 * public address.
 */
export interface ApprovalRequestedEvent {
  readonly id: WebhookEventId;
  readonly type: 'approval.requested';
  readonly createdAt: Timestamp;
  readonly data: { readonly approval: RequestedApproval };
}

/** The approval an `approval.requested` event names, without its context. */
export interface RequestedApproval {
  readonly approvalId: string;
  readonly projectId?: string;
  /** The least reviewer role that may decide it. */
  readonly requiredRole: 'standard' | 'senior' | 'admin';
  readonly title?: string;
  /** The one reviewer it's assigned to, when it is. */
  readonly assignedTo?: string;
  readonly createdAt: Timestamp;
  readonly expiresAt?: Timestamp;
  readonly url?: string;
}

/** Sent only by `POST /v1/webhook-endpoints/:endpointId/test`. */
export interface WebhookTestEvent {
  readonly id: WebhookEventId;
  readonly type: 'webhook.test';
  readonly createdAt: Timestamp;
  readonly data: { readonly endpointId: WebhookEndpointId };
}

/** The JSON body of every webhook request. */
export type WebhookEvent =
  | RunFinishedEvent
  | ImprovementPassFinishedEvent
  | ApprovalRequestedEvent
  | WebhookTestEvent;

// ---------- deliveries ----------

/**
 * `pending`: waiting for its next attempt. `delivered`: the endpoint
 * answered 2xx. `failed`: every attempt failed, or the endpoint was
 * unregistered first; `redeliver` queues it again.
 */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export interface WebhookDelivery {
  readonly deliveryId: WebhookDeliveryId;
  readonly endpointId: WebhookEndpointId;
  readonly event: WebhookEvent;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  /** When the next attempt is due; `null` unless `pending`. */
  readonly nextAttemptAt: Timestamp | null;
  readonly lastAttemptAt: Timestamp | null;
  /** HTTP status of the last attempt; `null` when it got no response. */
  readonly lastResponseStatus: number | null;
  /** Why the last attempt failed (`timeout`, `connection-refused`, `url-refused`, …). */
  readonly lastError: string | null;
  readonly createdAt: Timestamp;
  readonly deliveredAt: Timestamp | null;
}

export interface WebhookDeliveryRef extends WebhookEndpointRef {
  readonly deliveryId: WebhookDeliveryId;
}

export interface WebhookDeliveryListInput extends WebhookEndpointRef {
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly status?: WebhookDeliveryStatus;
}

export type WebhookDeliveryListOutcome =
  | {
      readonly kind: 'ok';
      readonly data: readonly WebhookDelivery[];
      readonly nextCursor?: Cursor;
    }
  | { readonly kind: 'not-found' };

export type WebhookDeliveryOutcome =
  | { readonly kind: 'ok'; readonly delivery: WebhookDelivery }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'delivery-not-found' };

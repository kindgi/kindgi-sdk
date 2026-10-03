// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Public trigger-registry shape: binding interface, register/update/list
// input variants, record shapes, error shapes, TRIGGER_KINDS constant.
// The implementation is supplied by the Kindgi runtime.

import type { Cursor, Result, TenantId, TriggerId } from '@kindgi/types';

import type { CronTriggerConfig, EventTriggerConfig, WebhookTriggerConfig } from './types.js';

export interface TriggerRegistryBinding {
  register(input: RegisterTriggerInput): Promise<Result<TriggerRecord, RegisterTriggerError>>;

  update(input: UpdateTriggerInput): Promise<Result<TriggerRecord, UpdateTriggerError>>;

  list(input: ListTriggersInput): Promise<TriggerListPage>;

  get(input: GetTriggerInput): Promise<TriggerRecord | null>;

  pause(input: TriggerLifecycleInput): Promise<Result<TriggerRecord, TriggerLifecycleError>>;

  resume(input: TriggerLifecycleInput): Promise<Result<TriggerRecord, TriggerLifecycleError>>;

  unregister(
    input: TriggerLifecycleInput,
  ): Promise<{ readonly triggerId: TriggerId; readonly unregistered: boolean }>;

  /**
   * Webhook-receiver hot path. The receiver resolves the HMAC secret
   * named by `hmacSecretName` from the tenant's secrets (`SecretBinding`
   * in `@kindgi/api`) and verifies the request before spawning. Returns
   * null when webhookId is unknown, the trigger is tombstoned, or
   * `status !== 'active'`.
   */
  fetchActiveByWebhookId(input: {
    readonly tenantId: TenantId;
    readonly webhookId: string;
  }): Promise<WebhookTriggerRecord | null>;
}

// ---------- register (discriminated on kind) ----------

export type RegisterTriggerInput =
  | RegisterCronTriggerInput
  | RegisterEventTriggerInput
  | RegisterWebhookTriggerInput;

export interface RegisterCronTriggerInput {
  readonly kind: 'cron';
  readonly tenantId: TenantId;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly config: CronTriggerConfig;
  readonly label?: string;
}

export interface RegisterEventTriggerInput {
  readonly kind: 'event';
  readonly tenantId: TenantId;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly config: EventTriggerConfig;
  readonly label?: string;
}

export interface RegisterWebhookTriggerInput {
  readonly kind: 'webhook';
  readonly tenantId: TenantId;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly config: WebhookTriggerConfig;
  /** Caller-supplied (uuid). The routable id a webhook receiver looks the trigger up by. */
  readonly webhookId: string;
  /**
   * Name of the HMAC secret in the tenant's secrets store. The caller
   * writes the secret first (`POST /v1/secrets`); this row never holds it.
   */
  readonly hmacSecretName: string;
  readonly label?: string;
}

// ---------- update (discriminated on kind) ----------

export type UpdateTriggerInput =
  | UpdateCronTriggerInput
  | UpdateEventTriggerInput
  | UpdateWebhookTriggerInput;

interface UpdateBase {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
  /** `null` clears the label; omitted leaves it unchanged. */
  readonly label?: string | null;
  /** Pin the trigger to a different flow version. */
  readonly flowVersion?: string;
}

export interface UpdateCronTriggerInput extends UpdateBase {
  readonly kind: 'cron';
  readonly config?: Partial<CronTriggerConfig>;
}

export interface UpdateEventTriggerInput extends UpdateBase {
  readonly kind: 'event';
  readonly config?: Partial<EventTriggerConfig>;
}

export interface UpdateWebhookTriggerInput extends UpdateBase {
  readonly kind: 'webhook';
  readonly config?: Partial<WebhookTriggerConfig>;
  // HMAC secret rotation flows through /v1/secrets — not here.
}

// ---------- records (discriminated on kind) ----------

interface TriggerRecordBase {
  readonly triggerId: TriggerId;
  readonly tenantId: TenantId;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly status: 'active' | 'paused';
  readonly label: string | null;
  readonly lastFiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CronTriggerRecord extends TriggerRecordBase {
  readonly kind: 'cron';
  readonly config: CronTriggerConfig;
  readonly nextFireAt: string | null;
}

export interface EventTriggerRecord extends TriggerRecordBase {
  readonly kind: 'event';
  readonly config: EventTriggerConfig;
}

export interface WebhookTriggerRecord extends TriggerRecordBase {
  readonly kind: 'webhook';
  readonly config: WebhookTriggerConfig;
  readonly webhookId: string;
  readonly hmacSecretName: string;
}

export type TriggerRecord = CronTriggerRecord | EventTriggerRecord | WebhookTriggerRecord;

// ---------- list + get + lifecycle ----------

export interface ListTriggersInput {
  readonly tenantId: TenantId;
  readonly kind?: TriggerKind;
  readonly status?: 'active' | 'paused';
  readonly limit?: number;
  readonly cursor?: Cursor;
}

export interface TriggerListPage {
  readonly data: readonly TriggerRecord[];
  readonly nextCursor?: Cursor;
}

export interface GetTriggerInput {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
}

export interface TriggerLifecycleInput {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
}

// ---------- errors ----------

export interface RegisterTriggerError {
  readonly code:
    | 'trigger-invalid-config'
    | 'trigger-webhook-id-conflict'
    | 'trigger-register-failed';
  readonly message: string;
}

export interface UpdateTriggerError {
  readonly code: 'trigger-not-found' | 'trigger-invalid-config' | 'trigger-update-failed';
  readonly message: string;
  readonly triggerId: TriggerId;
}

export interface TriggerLifecycleError {
  readonly code: 'trigger-not-found' | 'trigger-already-in-state' | 'trigger-lifecycle-failed';
  readonly message: string;
  readonly triggerId: TriggerId;
}

export const TRIGGER_KINDS = ['cron', 'event', 'webhook'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

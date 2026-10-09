// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Public trigger-registry shape: binding interface, register/update/list
// input variants, record shapes, error shapes, TRIGGER_KINDS constant.
// The implementation is supplied by the Kindgi runtime.

import type { Cursor, ProjectId, Result, TenantId, TriggerId } from '@kindgi/types';

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

  /**
   * A trigger's fire history, newest first. Optional: without it, the
   * route answers `501`.
   */
  listFires?(input: ListTriggerFiresInput): Promise<TriggerFirePage>;

  /**
   * Fire a schedule now, outside its schedule (`run-now`): one fire, recorded
   * in its history with `manual: true`, starting one run as the schedule's
   * owner. Optional: without it, the route answers `501`.
   */
  fireNow?(input: TriggerLifecycleInput): Promise<Result<TriggerFire, TriggerLifecycleError>>;

  /**
   * Make `owner` the principal a schedule's runs act as (an admin re-owns
   * a schedule whose owner left). Optional: without it, the route answers
   * `501`.
   */
  setOwner?(
    input: TriggerLifecycleInput & { readonly owner: TriggerOwner },
  ): Promise<Result<TriggerRecord, TriggerLifecycleError>>;
}

// ---------- schedules: what they run, who as, and when ----------

/**
 * What a schedule runs: a flow at an exact version, or an agent. An agent
 * that names no version runs its live version for the schedule's project,
 * as a run that names none does.
 */
export type TriggerTarget =
  | { readonly kind: 'flow'; readonly flowId: string; readonly flowVersion: string }
  | { readonly kind: 'agent'; readonly agentId: string; readonly agentVersion?: string };

/**
 * The principal a trigger's runs act as: whoever registered it, until an
 * admin re-owns it. Checked again at every fire.
 */
export interface TriggerOwner {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

/**
 * What a schedule does after a gap (the runtime was down, or the schedule
 * was overdue past `startingDeadlineSeconds`): `latest` fires once, for
 * the latest missed occurrence, recording how many it missed; `skip` drops
 * the missed occurrences. Never every missed occurrence.
 */
export type ScheduleCatchUp = 'latest' | 'skip';

/** When an occurrence comes while the schedule's previous run is still running. */
export type ScheduleOverlap = 'skip' | 'allow';

export const SCHEDULE_DEFAULTS = {
  catchUp: 'latest',
  overlap: 'skip',
  startingDeadlineSeconds: 600,
} as const satisfies {
  readonly catchUp: ScheduleCatchUp;
  readonly overlap: ScheduleOverlap;
  readonly startingDeadlineSeconds: number;
};

// ---------- fires ----------

/**
 * One fire of a trigger: an occurrence of a schedule (or a `run-now`), and
 * what came of it. `pending` while its run is being started.
 */
export interface TriggerFire {
  readonly fireId: string;
  readonly triggerId: TriggerId;
  readonly kind: 'schedule' | 'event' | 'webhook';
  /** A schedule's fire: the occurrence it is for. */
  readonly scheduledFor?: string;
  readonly firedAt: string;
  /**
   * `skipped-erasure`: the person the fire acts for is being erased (the
   * run start answered `erasure-in-progress`). Skipped fires never count
   * toward the auto-pause; refused and failed ones do.
   */
  readonly outcome:
    | 'pending'
    | 'started'
    | 'skipped-overlap'
    | 'skipped-erasure'
    | 'refused'
    | 'failed';
  /** The run it started, when it started one. */
  readonly runId?: string;
  /** Why it was refused, skipped or failed. */
  readonly detail?: string;
  /** Occurrences this fire stood in for after a gap (`catchUp: 'latest'`). */
  readonly missedCount?: number;
  /** A `run-now` fire, outside the schedule. */
  readonly manual?: boolean;
}

export interface ListTriggerFiresInput {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
  readonly limit?: number;
  readonly cursor?: Cursor;
}

export interface TriggerFirePage {
  readonly data: readonly TriggerFire[];
  readonly nextCursor?: Cursor;
}

// ---------- register (discriminated on kind) ----------

export type RegisterTriggerInput =
  | RegisterCronTriggerInput
  | RegisterEventTriggerInput
  | RegisterWebhookTriggerInput;

export interface RegisterCronTriggerInput {
  readonly kind: 'cron';
  readonly tenantId: TenantId;
  readonly target: TriggerTarget;
  /** The schedule's project; absent → the tenant's default project. */
  readonly projectId?: ProjectId;
  /** Who its runs act as: the principal registering it. */
  readonly owner: TriggerOwner;
  readonly config: CronTriggerConfig;
  readonly catchUp?: ScheduleCatchUp;
  readonly overlap?: ScheduleOverlap;
  /** How late a fire may start and still count as on time; past it, `catchUp` applies. */
  readonly startingDeadlineSeconds?: number;
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

export interface UpdateCronTriggerInput extends Omit<UpdateBase, 'flowVersion'> {
  readonly kind: 'cron';
  readonly config?: Partial<CronTriggerConfig>;
  /** Run something else: another flow version, another agent version. */
  readonly target?: TriggerTarget;
  readonly catchUp?: ScheduleCatchUp;
  readonly overlap?: ScheduleOverlap;
  readonly startingDeadlineSeconds?: number;
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
  readonly status: 'active' | 'paused';
  readonly label: string | null;
  readonly lastFiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An event trigger or an inbound webhook starts a flow at an exact version. */
interface FlowTriggerRecordBase extends TriggerRecordBase {
  readonly flowId: string;
  readonly flowVersion: string;
}

export interface CronTriggerRecord extends TriggerRecordBase {
  readonly kind: 'cron';
  readonly target: TriggerTarget;
  readonly projectId: ProjectId;
  readonly owner: TriggerOwner;
  readonly config: CronTriggerConfig;
  readonly catchUp: ScheduleCatchUp;
  readonly overlap: ScheduleOverlap;
  readonly startingDeadlineSeconds: number;
  readonly nextFireAt: string | null;
  /** Why the runtime paused it (repeated refused or failed fires; skipped ones never count), when it did. */
  readonly statusReason?: string;
  /** The next occurrences, when the read asked for them (`GetTriggerInput.upcoming`). */
  readonly upcoming?: readonly string[];
}

export interface EventTriggerRecord extends FlowTriggerRecordBase {
  readonly kind: 'event';
  readonly config: EventTriggerConfig;
}

export interface WebhookTriggerRecord extends FlowTriggerRecordBase {
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
  /** A schedule: include its next N occurrences (`CronTriggerRecord.upcoming`), at most 20. */
  readonly upcoming?: number;
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

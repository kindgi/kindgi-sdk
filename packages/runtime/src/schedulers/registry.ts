// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Public trigger-registry shape: binding interface, register/update/list
// input variants, record shapes, error shapes, TRIGGER_KINDS constant.
// The implementation is supplied by the Kindgi runtime.

import type {
  Cursor,
  LiveScope,
  ProjectId,
  Result,
  TenantId,
  TriggerId,
  WebhookSignatureScheme,
} from '@kindgi/types';

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
   * The receiver's lookup: the webhook trigger with this routable id,
   * paused or unregistered too (`unregistered`), so the receiver verifies
   * a request with the trigger's own secret before it answers that the
   * trigger is gone. `null` when the tenant has none. Optional: without
   * it, `POST /v1/hooks/…` answers every request as an unknown trigger.
   */
  findWebhook?(input: {
    readonly tenantId: TenantId;
    readonly webhookId: string;
  }): Promise<FoundWebhookTrigger | null>;

  /**
   * A verified delivery to an active webhook trigger: record its fire,
   * deduped on `(trigger, dedupeKey)`, and start its run as the trigger's
   * owner with the idempotency key `fire:<fireId>`, after the fire is
   * committed and without waiting for the run. A delivery whose key a fire
   * already holds starts nothing: `duplicate`, with that fire's id (its
   * `duplicates` count goes up). An owner who lost access is the fire's own
   * outcome (`refused`), not an error here.
   */
  fireWebhook?(input: FireWebhookInput): Promise<Result<WebhookFire, TriggerLifecycleError>>;

  /**
   * A delivery the receiver turned away (or took without starting
   * anything, a paused trigger's `skipped`): recorded on the trigger's
   * history, and, when `audit`, in the access audit as the sender's
   * refusal. Coalesced per trigger: past the first
   * {@link WEBHOOK_REFUSALS_RECORDED_PER_MINUTE} a minute, a refusal only
   * counts (`WebhookTriggerRecord.suppressedRefusals`). Refusals never count
   * toward, nor reset, the trigger's auto-pause.
   */
  recordWebhookRefusal?(input: WebhookRefusalInput): Promise<void>;

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
 * as a run that names none does. `improve` starts an improvement pass on
 * an agent for a live scope when enough new trusted "no" judgments have
 * come in (its input says how many, and the pass's options); otherwise
 * its fire is `skipped`.
 */
export type TriggerTarget =
  | { readonly kind: 'flow'; readonly flowId: string; readonly flowVersion: string }
  | { readonly kind: 'agent'; readonly agentId: string; readonly agentVersion?: string }
  | { readonly kind: 'improve'; readonly agentId: string; readonly scope: LiveScope };

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

// ---------- webhook triggers: what they start, how they're signed ----------

/**
 * A webhook trigger with no `signature` set: a hex HMAC-SHA256 of the raw
 * body in `X-Kindgi-Signature`.
 */
export const DEFAULT_WEBHOOK_SIGNATURE: WebhookSignatureScheme = {
  kind: 'hmac-sha256',
  encoding: 'hex',
  header: 'X-Kindgi-Signature',
};

export const WEBHOOK_BODY_LIMITS = {
  /** A trigger's body cap when it sets none. */
  defaultBytes: 256 * 1024,
  /** The most a trigger may set: the receiver reads no more, whatever the trigger. */
  maxBytes: 1024 * 1024,
} as const;

/**
 * Accepted deliveries a minute a webhook trigger takes: `defaultPerMinute`
 * when it sets none; a deployment caps what a trigger may set
 * (`maxPerMinute` unless it says otherwise).
 */
export const WEBHOOK_RATE_LIMITS = {
  defaultPerMinute: 600,
  maxPerMinute: 6000,
} as const;

/** How many refusals a minute a webhook trigger's history records; the rest only count. */
export const WEBHOOK_REFUSALS_RECORDED_PER_MINUTE = 20;

/** The webhook trigger the receiver found: active, paused, or unregistered. */
export interface FoundWebhookTrigger extends WebhookTriggerRecord {
  readonly unregistered: boolean;
}

export interface FireWebhookInput {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
  /**
   * The delivery's dedupe key: `delivery:<sha256 hex>` of the delivery id
   * and the raw body, or a fresh `delivery:<uuid>` when the trigger names
   * no delivery-id header.
   */
  readonly dedupeKey: string;
  /** The parsed body: JSON for a JSON content type, else the text. */
  readonly event: unknown;
}

export interface WebhookFire {
  readonly fireId: string;
  /** A fire already held this delivery's key: nothing new was started. */
  readonly duplicate: boolean;
}

/**
 * Why the receiver turned a delivery away, or (`paused`) took it without
 * starting anything.
 */
export type WebhookRefusalReason =
  | 'signature-missing'
  | 'signature-invalid'
  | 'stale'
  | 'secret-unavailable'
  | 'unregistered'
  | 'paused'
  | 'rate-limited'
  | 'body-too-large'
  | 'body-not-json';

export interface WebhookRefusalInput {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
  /** `skipped` for a paused trigger's delivery; `refused` for every other reason. */
  readonly outcome: 'refused' | 'skipped';
  readonly reason: WebhookRefusalReason;
  /** Also write an access-audit record: a request that failed to prove its sender. */
  readonly audit: boolean;
  /** Where the request came from, for the audit record (personal data, classified there). */
  readonly clientAddress?: string;
}

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
   * `skipped`: what the target waits for wasn't there (an `improve`
   * schedule's threshold, or its monthly cap), as `detail` says.
   */
  readonly outcome:
    | 'pending'
    | 'started'
    | 'skipped-overlap'
    | 'skipped-erasure'
    | 'skipped'
    | 'refused'
    | 'failed';
  /** The run it started, when it started one. */
  readonly runId?: string;
  /** The improvement pass it started, for an `improve` schedule. */
  readonly passId?: string;
  /** Why it was refused, skipped or failed. */
  readonly detail?: string;
  /** Occurrences this fire stood in for after a gap (`catchUp: 'latest'`). */
  readonly missedCount?: number;
  /** A `run-now` fire, outside the schedule. */
  readonly manual?: boolean;
  /** A webhook fire: deliveries with the same dedupe key that came after it and started nothing. */
  readonly duplicates?: number;
  /** When the last of those came. */
  readonly lastDuplicateAt?: string;
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
  /** The flow it starts, at an exact version. */
  readonly flowId: string;
  readonly flowVersion: string;
  /** The trigger's project; absent → the tenant's default project. */
  readonly projectId?: ProjectId;
  /** Who its runs act as: the principal registering it. */
  readonly owner: TriggerOwner;
  readonly config: WebhookTriggerConfig;
  /** Caller-supplied (uuid). The routable id a webhook receiver looks the trigger up by. */
  readonly webhookId: string;
  /**
   * Name of the signing secret in the secrets store, resolved at the
   * trigger's project. The caller writes the secret first
   * (`POST /v1/secrets`); this row never holds it.
   */
  readonly hmacSecretName: string;
  /** How its sender signs; absent → {@link DEFAULT_WEBHOOK_SIGNATURE}. */
  readonly signature?: WebhookSignatureScheme;
  /** The request header whose value, with the body, dedupes deliveries; absent → no dedupe. */
  readonly deliveryIdHeader?: string;
  /** The largest body it takes; absent → {@link WEBHOOK_BODY_LIMITS}`.defaultBytes`. */
  readonly bodyLimitBytes?: number;
  /** Accepted deliveries a minute; absent → {@link WEBHOOK_RATE_LIMITS}`.defaultPerMinute`. */
  readonly rateLimitPerMinute?: number;
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
  /** Another secret, by name. Rotating a secret's value goes through `/v1/secrets`. */
  readonly hmacSecretName?: string;
  readonly signature?: WebhookSignatureScheme;
  /** `null` stops deduping. */
  readonly deliveryIdHeader?: string | null;
  /** `null` goes back to the default. */
  readonly bodyLimitBytes?: number | null;
  /** `null` goes back to the default. */
  readonly rateLimitPerMinute?: number | null;
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
  readonly projectId: ProjectId;
  readonly owner: TriggerOwner;
  readonly config: WebhookTriggerConfig;
  readonly webhookId: string;
  readonly hmacSecretName: string;
  /** How its sender signs ({@link DEFAULT_WEBHOOK_SIGNATURE} when it set none). */
  readonly signature: WebhookSignatureScheme;
  readonly deliveryIdHeader?: string;
  readonly bodyLimitBytes: number;
  readonly rateLimitPerMinute: number;
  /** Why the runtime paused it (repeated refused or failed fires), when it did. */
  readonly statusReason?: string;
  /** Refusals and skipped deliveries this minute past the recorded ones, which only counted. */
  readonly suppressedRefusals?: { readonly since: string; readonly count: number };
}

export type TriggerRecord = CronTriggerRecord | EventTriggerRecord | WebhookTriggerRecord;

// ---------- list + get + lifecycle ----------

export interface ListTriggersInput {
  readonly tenantId: TenantId;
  readonly kind?: TriggerKind;
  readonly status?: 'active' | 'paused';
  /**
   * Only the triggers in this project: schedules and webhook triggers,
   * which each have one (event triggers never match). A registry that
   * ignores it lists more: the routes keep only these.
   */
  readonly projectId?: ProjectId;
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

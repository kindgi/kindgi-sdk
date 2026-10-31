// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Public trigger-registry shape: binding interface, register/update/list
// input variants, record shapes, error shapes, TRIGGER_KINDS constant.
// The implementation is supplied by the Kindgi runtime.

import type {
  AgentPinScope,
  Cursor,
  ProjectId,
  RecordedSecretScope,
  Result,
  TenantId,
  TriggerId,
  WebhookSignatureScheme,
} from '@kindgi/types';

import type {
  CronTriggerConfig,
  EventTriggerConfig,
  MailTriggerConfig,
  WebhookTriggerConfig,
} from './types.js';

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
   * A trigger's versions, newest first: one for each definition it has
   * had ({@link TriggerVersionRecord}). Empty for a trigger with none yet
   * (registered before versions, until its first edit or fire), and for
   * an id the tenant has no trigger with.
   */
  listVersions(input: ListTriggerVersionsInput): Promise<TriggerVersionPage>;

  /** One of a trigger's versions; `null` when the tenant's trigger has no such version. */
  getVersion(input: GetTriggerVersionInput): Promise<TriggerVersionRecord | null>;

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
   * a schedule whose owner left). A new owner makes the trigger's next
   * version (cause `owner`); the owner it already has makes none.
   * Optional: without it, the route answers `501`.
   */
  setOwner?(
    input: TriggerLifecycleInput & {
      readonly owner: TriggerOwner;
      /** Who made the change, as `UpdateBase.by`. */
      readonly by: string;
    },
  ): Promise<Result<TriggerRecord, TriggerLifecycleError>>;
}

// ---------- schedules: what they run, who as, and when ----------

/**
 * What a schedule runs: a flow at an exact version, or an agent. An agent
 * that names no version runs its pinned version for the schedule's project,
 * as a run that names none does. `improve` starts an Improve run on an
 * agent for a pin scope when enough answers have been marked wrong since
 * its last one (its input says how many, and the Improve options);
 * otherwise its fire is `skipped`.
 */
export type TriggerTarget =
  | { readonly kind: 'flow'; readonly flowId: string; readonly flowVersion: string }
  | { readonly kind: 'agent'; readonly agentId: string; readonly agentVersion?: string }
  | { readonly kind: 'improve'; readonly agentId: string; readonly scope: AgentPinScope };

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

// ---------- mail triggers: a mailbox's new mail starts runs ----------

/** What a mail trigger runs: an agent, or a flow at an exact version. */
export type MailTriggerTarget = Extract<TriggerTarget, { readonly kind: 'agent' | 'flow' }>;

/** A mail trigger's poll and run pace: the default when it sets none, and the range it may set. */
export const MAIL_TRIGGER_LIMITS = {
  pollSeconds: { default: 60, min: 30, max: 3600 },
  runsPerHour: { default: 60, min: 1, max: 600 },
} as const;

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
  | 'body-not-json'
  | 'body-too-deep';

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
  /**
   * `mail`: a mail trigger's row. Its mail's fires, and a `cursor-reset`
   * (`skipped`, `detail` starting `cursor-reset:`) when it couldn't read
   * on from where it was and started again.
   */
  readonly kind: 'schedule' | 'event' | 'webhook' | 'mail';
  /** A schedule's fire: the occurrence it is for. */
  readonly scheduledFor?: string;
  readonly firedAt: string;
  /**
   * `skipped-erasure`: the person the fire acts for is being erased (the
   * run start answered `erasure-in-progress`). Skipped fires never count
   * toward the auto-pause; refused and failed ones do.
   * `skipped`, as `detail` says: a webhook trigger was paused; what the
   * target waits for wasn't there (an `improve` schedule's threshold, or its
   * monthly cap); its project is suspended (`project-suspended`); its run or
   * Improve run hadn't started when its tenant was suspended, and the restore
   * concluded it (`tenant-suspended`); or its tenant was suspended or closing
   * as its run started (`tenant-suspended`, `tenant-closing`). A skip for a
   * suspension or a close doesn't reset the count of refusals and failures
   * in a row either. A mail trigger's mail is `skipped` when it's from the
   * mailbox's own address (`own-address`), an automatic reply
   * (`auto-submitted`), received before the trigger began watching
   * (`before-since`), found in a mailbox that changed account before it
   * was read (`mailbox-changed`), or gone from the mailbox by the time it
   * was read (`not-found`). It's `refused` over the trigger's `runsPerHour`
   * (`detail` starts `over-limit:`) and when the mailbox's connection is
   * missing, lapsed or lacks a scope (`connection-missing:` and why), and it
   * doesn't run later. It's `refused` with `no-thread-id` when the app gives
   * its mail no thread. A thread's mail runs one at a time: a mail fire is
   * `pending` while an earlier mail of its thread waits or that mail's run
   * hasn't finished (`detail` starts `thread-busy:`), and starts once its
   * thread is free. It's `skipped` with `mail-already-given:` when an
   * earlier run of its thread already had its mail.
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
  /**
   * The trigger's version its start used: the newest when it started.
   * Absent until it starts, and on a fire from before versions.
   */
  readonly version?: number;
  /** The Improve run it started, for an `improve` schedule. */
  readonly improveRunId?: string;
  /** Why it was refused, skipped or failed, or why a `pending` mail fire waits (`thread-busy:`). */
  readonly detail?: string;
  /**
   * Whether it counted toward the trigger's auto-pause (5 in a row by
   * default). `false` for a refusal for a limit, such as the tenant's runs
   * pending (`detail` starts `rate-limited:`), or a mail trigger's
   * `runsPerHour` (`over-limit:`): the limit passes, and the
   * trigger isn't at fault. `false` too for a mail trigger's
   * `connection-missing:`, which the trigger's `statusReason` says and
   * connecting again ends, and for its `no-thread-id`, a mail the app gave
   * no thread. Absent from a runtime that doesn't say: then
   * refused and failed fires counted, and the others didn't.
   */
  readonly countsTowardPause?: boolean;
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
  | RegisterWebhookTriggerInput
  | RegisterMailTriggerInput;

export interface RegisterCronTriggerInput {
  readonly kind: 'cron';
  readonly tenantId: TenantId;
  /**
   * Who registers it: the authenticated caller, as audit records name an
   * actor (`user:<id>`, `service_account:<id>`, …). Its version 1 names
   * them (`TriggerVersionRecord.createdBy`). The route sets it, never a body.
   */
  readonly by: string;
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
  /**
   * Tools, by id, whose calls in its runs don't wait for a person's yes
   * though no person started them (the tool's `needsApprovalWhenUnattended`):
   * copied to each run when it starts (`RunFlowInput.toolsAllowedUnattended`).
   * A project admin's to set, and each id one the target can call (the
   * route checks both). Absent: none.
   */
  readonly toolsAllowedUnattended?: readonly string[];
}

export interface RegisterEventTriggerInput {
  readonly kind: 'event';
  readonly tenantId: TenantId;
  /** As `RegisterCronTriggerInput.by`. */
  readonly by: string;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly config: EventTriggerConfig;
  readonly label?: string;
}

export interface RegisterWebhookTriggerInput {
  readonly kind: 'webhook';
  readonly tenantId: TenantId;
  /** As `RegisterCronTriggerInput.by`. */
  readonly by: string;
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
   * Name of the signing secret in the secrets store; this row never holds
   * it. Read at `hmacSecretScope` only.
   */
  readonly hmacSecretName: string;
  /**
   * Where the signing secret is read: recorded by the API when the trigger
   * is registered (the scope the registrant may read it at; see
   * `@kindgi/api`'s `secret-scope.ts`). `null`: none usable, so no delivery
   * verifies until an admin names its secret again (an update). Absent: not
   * recorded (a caller from before it was), and the receiver reads it as it
   * did.
   */
  readonly hmacSecretScope?: RecordedSecretScope | null;
  /** How its sender signs; absent → {@link DEFAULT_WEBHOOK_SIGNATURE}. */
  readonly signature?: WebhookSignatureScheme;
  /** The request header whose value, with the body, dedupes deliveries; absent → no dedupe. */
  readonly deliveryIdHeader?: string;
  /** The largest body it takes; absent → {@link WEBHOOK_BODY_LIMITS}`.defaultBytes`. */
  readonly bodyLimitBytes?: number;
  /** Accepted deliveries a minute; absent → {@link WEBHOOK_RATE_LIMITS}`.defaultPerMinute`. */
  readonly rateLimitPerMinute?: number;
  readonly label?: string;
  /** As `RegisterCronTriggerInput.toolsAllowedUnattended`. */
  readonly toolsAllowedUnattended?: readonly string[];
}

/**
 * A mail trigger: each new mail in its mailbox's folder starts a run of its
 * target, with the mail as the run's input. In a mail-started run, every
 * call that changes something, or reads the run's own mailbox, waits for a
 * person's yes, unless `toolsAllowedUnattended` lists its tool.
 */
export interface RegisterMailTriggerInput {
  readonly kind: 'mail';
  readonly tenantId: TenantId;
  /** As `RegisterCronTriggerInput.by`. */
  readonly by: string;
  readonly target: MailTriggerTarget;
  /** The trigger's project; absent → the tenant's default project. */
  readonly projectId?: ProjectId;
  /**
   * Who its runs act as: the principal registering it, or a service
   * account the route allowed. A `person` mailbox's owner is a person.
   */
  readonly owner: TriggerOwner;
  readonly config: MailTriggerConfig;
  readonly label?: string;
  /**
   * As `RegisterCronTriggerInput.toolsAllowedUnattended`: a listed tool's
   * calls run without a person's yes in its runs. Anyone who can write to
   * the mailbox writes those runs' input. Absent: none.
   */
  readonly toolsAllowedUnattended?: readonly string[];
}

// ---------- update (discriminated on kind) ----------

export type UpdateTriggerInput =
  | UpdateCronTriggerInput
  | UpdateEventTriggerInput
  | UpdateWebhookTriggerInput
  | UpdateMailTriggerInput;

/**
 * An update that changes the trigger's definition makes its next version
 * (cause `edit`); one that changes nothing makes none.
 */
interface UpdateBase {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
  /** Who made the change, as `RegisterCronTriggerInput.by`: the version it makes names them. */
  readonly by: string;
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
  /** The `toolsAllowedUnattended`, replaced: `[]` clears it. Absent: kept as it is. */
  readonly toolsAllowedUnattended?: readonly string[];
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
  /** Where `hmacSecretName` is read, recorded with it (as at registration). */
  readonly hmacSecretScope?: RecordedSecretScope | null;
  readonly signature?: WebhookSignatureScheme;
  /** `null` stops deduping. */
  readonly deliveryIdHeader?: string | null;
  /** `null` goes back to the default. */
  readonly bodyLimitBytes?: number | null;
  /** `null` goes back to the default. */
  readonly rateLimitPerMinute?: number | null;
  /** As `UpdateCronTriggerInput.toolsAllowedUnattended`. */
  readonly toolsAllowedUnattended?: readonly string[];
}

export interface UpdateMailTriggerInput extends Omit<UpdateBase, 'flowVersion'> {
  readonly kind: 'mail';
  /**
   * The fields given replace the trigger's; `mailbox` is replaced whole.
   * Another mailbox (the other app, or the other `as`) with no `folder`
   * drops the trigger's folder, so it watches the new mailbox's inbox.
   */
  readonly config?: Partial<MailTriggerConfig>;
  /** Run something else: another agent or agent version, another flow version. */
  readonly target?: MailTriggerTarget;
  /** As `UpdateCronTriggerInput.toolsAllowedUnattended`. */
  readonly toolsAllowedUnattended?: readonly string[];
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
  /**
   * Its current version: the newest of its {@link TriggerVersionRecord}s,
   * whose definition is this record's. Absent until its first (a trigger
   * registered before versions has none until its first edit or fire).
   */
  readonly version?: number;
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
  /**
   * Tools its runs may call without a person's yes
   * (`RegisterCronTriggerInput.toolsAllowedUnattended`). Absent: none.
   */
  readonly toolsAllowedUnattended?: readonly string[];
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
  /** Where the signing secret is read (`RegisterWebhookTriggerInput.hmacSecretScope`), when recorded. */
  readonly hmacSecretScope?: RecordedSecretScope | null;
  /** How its sender signs ({@link DEFAULT_WEBHOOK_SIGNATURE} when it set none). */
  readonly signature: WebhookSignatureScheme;
  readonly deliveryIdHeader?: string;
  readonly bodyLimitBytes: number;
  readonly rateLimitPerMinute: number;
  /** Why the runtime paused it (repeated refused or failed fires), when it did. */
  readonly statusReason?: string;
  /** Refusals and skipped deliveries this minute past the recorded ones, which only counted. */
  readonly suppressedRefusals?: { readonly since: string; readonly count: number };
  /** As `CronTriggerRecord.toolsAllowedUnattended`. */
  readonly toolsAllowedUnattended?: readonly string[];
}

export interface MailTriggerRecord extends TriggerRecordBase {
  readonly kind: 'mail';
  readonly target: MailTriggerTarget;
  readonly projectId: ProjectId;
  readonly owner: TriggerOwner;
  /** As registered, with `pollSeconds` and `runsPerHour` filled in from {@link MAIL_TRIGGER_LIMITS}. */
  readonly config: MailTriggerConfig & {
    readonly pollSeconds: number;
    readonly runsPerHour: number;
  };
  /** When it polls next; `null` while paused. */
  readonly nextFireAt: string | null;
  /**
   * Why it isn't polling as it should: `connection-missing` (the mailbox's
   * connection is gone or lapsed; polls go on, and work again once it's
   * back), `owner-refused` (its owner was removed or may no longer run the
   * target; polls go on and read nothing until that changes or an admin
   * takes it over), or why the runtime paused it.
   */
  readonly statusReason?: string;
  /** The mailbox's account at its last poll. Absent before its first. */
  readonly account?: { readonly id: string; readonly label: string };
  /** When it last polled the mailbox and got an answer. */
  readonly lastPolledAt?: string;
  /** As `CronTriggerRecord.toolsAllowedUnattended`. */
  readonly toolsAllowedUnattended?: readonly string[];
}

export type TriggerRecord =
  | CronTriggerRecord
  | EventTriggerRecord
  | WebhookTriggerRecord
  | MailTriggerRecord;

// ---------- list + get + lifecycle ----------

export interface ListTriggersInput {
  readonly tenantId: TenantId;
  readonly kind?: TriggerKind;
  readonly status?: 'active' | 'paused';
  /**
   * Only the triggers in this project: schedules, webhook triggers and
   * mail triggers, which each have one (event triggers never match). A registry that
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

// ---------- versions (discriminated on kind) ----------

/**
 * What made a version: `register` (version 1), `edit` (an update that
 * changed the definition), `owner` (a take-ownership to another owner),
 * `first-fire` (a trigger registered before versions, at its first fire or
 * poll: its definition as it was), `unversioned-edit` (at a fire or poll,
 * or just before an edit or take-ownership, a definition its newest version
 * doesn't hold, as when a release from before versions changed it during
 * an upgrade: the definition as it is), or `pin` (the runtime pinned a
 * company mailbox to its only connection).
 */
export const TRIGGER_VERSION_CAUSES = [
  'register',
  'edit',
  'owner',
  'first-fire',
  'unversioned-edit',
  'pin',
] as const;
export type TriggerVersionCause = (typeof TRIGGER_VERSION_CAUSES)[number];

/**
 * A schedule's definition: the fields whose change makes a new version.
 * Never its state (status, claims, next and last fire, counters).
 */
export type CronTriggerDefinition = Pick<
  CronTriggerRecord,
  | 'target'
  | 'projectId'
  | 'owner'
  | 'config'
  | 'catchUp'
  | 'overlap'
  | 'startingDeadlineSeconds'
  | 'label'
  | 'toolsAllowedUnattended'
>;

/** An event trigger's definition, as {@link CronTriggerDefinition}. */
export type EventTriggerDefinition = Pick<
  EventTriggerRecord,
  'flowId' | 'flowVersion' | 'config' | 'label'
>;

/**
 * A webhook trigger's definition, as {@link CronTriggerDefinition}: its
 * secret by name only. Its `webhookId` is who it is, never edited.
 */
export type WebhookTriggerDefinition = Pick<
  WebhookTriggerRecord,
  | 'flowId'
  | 'flowVersion'
  | 'projectId'
  | 'owner'
  | 'config'
  | 'hmacSecretName'
  | 'hmacSecretScope'
  | 'signature'
  | 'deliveryIdHeader'
  | 'bodyLimitBytes'
  | 'rateLimitPerMinute'
  | 'label'
  | 'toolsAllowedUnattended'
>;

/** A mail trigger's definition, as {@link CronTriggerDefinition}. */
export type MailTriggerDefinition = Pick<
  MailTriggerRecord,
  'target' | 'projectId' | 'owner' | 'config' | 'label' | 'toolsAllowedUnattended'
>;

interface TriggerVersionBase {
  readonly triggerId: TriggerId;
  /** From 1, one more for each version of the trigger. */
  readonly version: number;
  readonly createdAt: string;
  /**
   * Who made it: the `by` of the register, update or take-ownership.
   * Absent only when the runtime made it (`first-fire`, `unversioned-edit`, `pin`).
   */
  readonly createdBy?: string;
  readonly cause: TriggerVersionCause;
}

export interface CronTriggerVersionRecord extends TriggerVersionBase {
  readonly kind: 'cron';
  readonly definition: CronTriggerDefinition;
}

export interface EventTriggerVersionRecord extends TriggerVersionBase {
  readonly kind: 'event';
  readonly definition: EventTriggerDefinition;
}

export interface WebhookTriggerVersionRecord extends TriggerVersionBase {
  readonly kind: 'webhook';
  readonly definition: WebhookTriggerDefinition;
}

export interface MailTriggerVersionRecord extends TriggerVersionBase {
  readonly kind: 'mail';
  readonly definition: MailTriggerDefinition;
}

/**
 * One version of a trigger: its definition as it was, who made it and
 * why. Never changed once made, and kept with every input it had. A
 * fire's start uses the newest (`TriggerFire.version`), and its run keeps
 * that one (`RunTriggerRef.version`).
 */
export type TriggerVersionRecord =
  | CronTriggerVersionRecord
  | EventTriggerVersionRecord
  | WebhookTriggerVersionRecord
  | MailTriggerVersionRecord;

export interface ListTriggerVersionsInput {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
  readonly limit?: number;
  readonly cursor?: Cursor;
}

export interface TriggerVersionPage {
  readonly data: readonly TriggerVersionRecord[];
  readonly nextCursor?: Cursor;
}

export interface GetTriggerVersionInput {
  readonly tenantId: TenantId;
  readonly triggerId: TriggerId;
  readonly version: number;
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

export const TRIGGER_KINDS = ['cron', 'event', 'webhook', 'mail'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

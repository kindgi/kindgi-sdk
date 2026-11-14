// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ApprovalId,
  Cursor,
  DestinationDeliveryId,
  DestinationId,
  EnvName,
  ProjectId,
  RunId,
  TenantId,
  Timestamp,
  TriggerId,
  UserId,
} from '@kindgi/types';

/**
 * Destinations: named places outside Kindgi that a schedule's results go
 * to, such as a Slack channel's incoming webhook, a Teams or Google Chat
 * space, a Discord channel, a signed webhook, or workspace members' email.
 * A schedule names them in `sendResultsTo`, beside `me` (its owner's own
 * email), and says on which of its runs' ends, or waits, to send.
 *
 * They are workspace records that admins make, change and remove, the same
 * bar as webhook endpoints: what they send carries project data out of
 * Kindgi. Anyone who may change a schedule may point it at a destination
 * its project may use (`projects`).
 *
 * Caller-plugged: the runtime owns storage, the URLs in its secrets store,
 * the delivery queue and the senders. This package defines the contract and
 * the wire shapes, and mounts `/v1/destinations` when a binding is supplied.
 *
 * **URLs are credentials.** A chat webhook URL lets anyone who has it post
 * to that channel, so `url` is write-only. The binding writes it to the
 * tenant's secrets store under `destinationUrlSecretName(destinationId)`,
 * which is under the reserved `kindgi.` prefix, so no caller of
 * `/v1/secrets` can read or write over it. An update with a new `url`
 * rotates it, and `remove` revokes it: a removed destination's URL is still
 * a live credential. An operator who keeps secrets elsewhere passes
 * `urlRef` instead. No response, delivery, log line or `lastError` holds a
 * URL, its path or its query: the API shows its `host`.
 *
 * **Delivery.** At least once. The `webhook` kind sends the same signed
 * envelopes as webhook endpoints, with a `webhook-id` that is the same on
 * every attempt; chat kinds have no such key, so a retry after a lost
 * answer can post twice. A failed delivery never fails, pauses or slows the
 * run or its schedule. Every method is tenant-scoped.
 */
export interface DestinationBinding {
  /**
   * Make a destination. The route has checked the body's shape: the kind's
   * own fields, an absolute https `url` (or a `urlRef`), and that `content:
   * "answer"` names `projects`. The binding checks the rest: the kind's host
   * (`url-refused`), the people (`person-not-found`), the projects
   * (`project-not-found`), the secrets behind `urlRef` and `secretRef`, and
   * that the deployment has what the kind needs (`kind-off`).
   */
  create(input: DestinationCreateInput): Promise<DestinationCreateOutcome>;
  list(input: DestinationListInput): Promise<DestinationPage>;
  /** `null` when unknown or removed; the route answers 404. */
  get(input: DestinationRef): Promise<Destination | null>;
  update(input: DestinationUpdateInput): Promise<DestinationUpdateOutcome>;
  /**
   * Soft delete, and its stored URL is revoked. Schedules that still name it
   * send it nothing: each of their messages is recorded `skipped` with the
   * reason `destination-removed`. `{ removed: false }` when it was unknown or
   * already removed.
   */
  remove(input: DestinationRef): Promise<{ readonly removed: boolean }>;
  /** The destination's deliveries, newest first. */
  listDeliveries(input: DestinationDeliveryListInput): Promise<DestinationDeliveryListOutcome>;
  /**
   * Queue a delivery again now, whatever its status: attempts start over,
   * and so does its retry window. It's checked again as when it was queued
   * (`destination-removed`, `not-for-this-project`) and as when it's sent
   * (`no-access`), so a delivery skipped for one of those is skipped again
   * with that reason. One skipped for `rate-cap` goes.
   */
  redeliver(input: DestinationDeliveryRef): Promise<DestinationDeliveryOutcome>;
  /**
   * Send a test message to the destination, to check it end to end. A
   * failing destination that the test reaches goes back to `active`, and
   * its held deliveries still inside their retry window go out, oldest
   * first.
   */
  sendTest(input: DestinationRef): Promise<DestinationDeliveryOutcome>;
  /**
   * One schedule's deliveries, to its destinations and to `me`, newest
   * first: what its page shows under "Send results to".
   */
  listScheduleDeliveries(input: ScheduleDeliveryListInput): Promise<DestinationDeliveryListOutcome>;
}

/**
 * Where a destination sends. `email` goes to workspace members, each
 * checked when a message is sent; the others post to a URL.
 */
export const DESTINATION_KINDS = [
  'email',
  'slack',
  'teams',
  'google-chat',
  'discord',
  'webhook',
] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

/**
 * What a message carries. `link`: the run's status and its console link.
 * `answer`: also the run's answer, up to its first 1,000 characters; only
 * on a destination that names `projects`, and never on the `webhook` kind,
 * whose receiver reads the run with its own key.
 */
export const DESTINATION_CONTENTS = ['link', 'answer'] as const;
export type DestinationContent = (typeof DESTINATION_CONTENTS)[number];

/**
 * `failing`: its last delivery got an answer that won't change on a retry
 * (such as a removed webhook's 404 or 410). Later messages for it are kept
 * but held until a `sendTest` reaches it.
 */
export const DESTINATION_STATUSES = ['active', 'failing'] as const;
export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

/** The name under the reserved `kindgi.` prefix where a destination's URL is kept. */
export function destinationUrlSecretName(destinationId: DestinationId): string {
  return `kindgi.destination.${destinationId}`;
}

/**
 * A secret by name in the deployment's secrets store, resolved at tenant
 * scope: the same shape as a webhook endpoint's `secretRef`.
 */
export interface DestinationSecretRef {
  readonly envName: EnvName;
  readonly name: string;
}

export interface Destination {
  readonly destinationId: DestinationId;
  readonly name: string;
  readonly kind: DestinationKind;
  /** `email`: the workspace members it goes to. Absent on the other kinds. */
  readonly people?: readonly UserId[];
  /** The URL's host, on every kind but `email`. The URL itself is never returned. */
  readonly host?: string;
  /** Where its URL is kept, on every kind but `email`. */
  readonly urlRef?: DestinationSecretRef;
  /** `webhook`: its signing secret, by reference, as a webhook endpoint's. */
  readonly secretRef?: DestinationSecretRef;
  /** The projects whose schedules may use it. Absent: every project's may. */
  readonly projects?: readonly ProjectId[];
  readonly content: DestinationContent;
  readonly status: DestinationStatus;
  /** Why it is `failing`, as a fixed reason that never holds the URL; `null` when it is `active`. */
  readonly lastError: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface DestinationRef {
  readonly tenantId: TenantId;
  readonly destinationId: DestinationId;
}

/**
 * A new destination. `url` (write-only) or `urlRef` on every kind but
 * `email`, which takes `people`; `secretRef` on `webhook` only.
 */
export interface DestinationCreateInput {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly kind: DestinationKind;
  readonly people?: readonly UserId[];
  readonly url?: string;
  readonly urlRef?: DestinationSecretRef;
  readonly secretRef?: DestinationSecretRef;
  readonly projects?: readonly ProjectId[];
  readonly content: DestinationContent;
}

export interface DestinationListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Only the destinations this project's schedules may use. */
  readonly projectId?: ProjectId;
}

export interface DestinationPage {
  readonly data: readonly Destination[];
  readonly nextCursor?: Cursor;
}

/**
 * Fields to change; absent fields are kept and `kind` never changes. A new
 * `url` rotates the stored one; `urlRef` replaces it. `projects: null`
 * lets every project's schedules use it again.
 */
export interface DestinationUpdateInput extends DestinationRef {
  readonly name?: string;
  readonly people?: readonly UserId[];
  readonly url?: string;
  readonly urlRef?: DestinationSecretRef;
  readonly secretRef?: DestinationSecretRef;
  readonly projects?: readonly ProjectId[] | null;
  readonly content?: DestinationContent;
}

/** Why a destination can't be saved as asked. */
export type DestinationRefusal =
  /** The URL is not the kind's (a `slack` URL must be on `hooks.slack.com`), or the deployment's URL policy refuses it. */
  | { readonly kind: 'url-refused'; readonly reason: string }
  /** The deployment lacks what this kind needs: `setting` names it. */
  | {
      readonly kind: 'kind-off';
      readonly destinationKind: DestinationKind;
      readonly setting: string;
    }
  | { readonly kind: 'project-not-found'; readonly projectId: ProjectId }
  /** No live member of the workspace with this id. */
  | { readonly kind: 'person-not-found'; readonly userId: UserId }
  /** No secret by that name (at tenant scope) in the store. */
  | { readonly kind: 'secret-not-found'; readonly secretRef: DestinationSecretRef }
  /** A `webhook` destination's signing secret is not `whsec_` + base64 of at least 24 bytes (or that base64 alone). */
  | { readonly kind: 'secret-too-weak'; readonly secretRef: DestinationSecretRef };

export type DestinationCreateOutcome =
  | { readonly kind: 'ok'; readonly destination: Destination }
  | DestinationRefusal;

export type DestinationUpdateOutcome =
  | { readonly kind: 'ok'; readonly destination: Destination }
  | { readonly kind: 'not-found' }
  | DestinationRefusal;

/**
 * Whether this deployment can send a schedule's results to `me`, its
 * owner's own email: on, or off with the setting it needs (a save that
 * names `me` is refused naming it, as `kind-off` names an `email`
 * destination's).
 */
export type ResultEmail = { readonly on: true } | { readonly on: false; readonly setting: string };

// ---------- deliveries ----------

/**
 * `pending`: waiting for its next attempt, or held while its destination
 * is `failing`. `delivered`: the destination took it. `failed`: it can't
 * be sent (see `reason`). `skipped`: it was never sent (see `reason`).
 */
export const DESTINATION_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'skipped'] as const;
export type DestinationDeliveryStatus = (typeof DESTINATION_DELIVERY_STATUSES)[number];

/**
 * Why a delivery was `skipped` or `failed`.
 *
 * Skipped: `rate-cap` (more than 30 messages from one schedule to one
 * place in an hour; one closing message says how many were left out),
 * `no-access` (the person is no longer a member, or can't read the run's
 * project), `destination-removed`, `not-for-this-project` (the
 * destination's `projects` no longer has the schedule's project).
 *
 * Failed: `destination-failing` (held until its retry window ended),
 * `window-ended` (not delivered within about a day of being queued), or
 * the destination's answer: `refused` (a 4xx that a retry won't change),
 * and the send errors webhook deliveries name (`url-refused`, `timeout`,
 * `connection-refused` and the rest).
 */
export type DestinationDeliveryReason = string;

/**
 * What a delivery tells: a run that ended, an approval that waits on a
 * person, a test, or, at the end of an hour whose cap (`rate-cap`) left
 * messages out, how many.
 */
export const DESTINATION_DELIVERY_EVENTS = [
  'run.finished',
  'approval.requested',
  'destination.test',
  'rate-cap.summary',
] as const;
export type DestinationDeliveryEvent = (typeof DESTINATION_DELIVERY_EVENTS)[number];

export interface DestinationDelivery {
  readonly deliveryId: DestinationDeliveryId;
  /** The destination, or `me`: the schedule owner's own email. */
  readonly to: DestinationId | 'me';
  readonly event: DestinationDeliveryEvent;
  /** The schedule that sent it; `null` for a test. */
  readonly scheduleId: TriggerId | null;
  /** The run it is about; `null` for a test or a `rate-cap.summary`. */
  readonly runId: RunId | null;
  /** `approval.requested`: the approval that waits. */
  readonly approvalId: ApprovalId | null;
  readonly status: DestinationDeliveryStatus;
  /** Why it was `skipped` or `failed`; `null` otherwise. */
  readonly reason: DestinationDeliveryReason | null;
  readonly attempts: number;
  /** When the next attempt is due; `null` unless `pending` and not held. */
  readonly nextAttemptAt: Timestamp | null;
  readonly lastAttemptAt: Timestamp | null;
  /** The HTTP status (or SMTP reply code) of the last attempt; `null` when it got none. */
  readonly lastResponseStatus: number | null;
  /** Why the last attempt failed, as a fixed reason that never holds the URL. */
  readonly lastError: string | null;
  readonly createdAt: Timestamp;
  readonly deliveredAt: Timestamp | null;
}

export interface DestinationDeliveryRef extends DestinationRef {
  readonly deliveryId: DestinationDeliveryId;
}

export interface DestinationDeliveryListInput extends DestinationRef {
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly status?: DestinationDeliveryStatus;
}

export interface ScheduleDeliveryListInput {
  readonly tenantId: TenantId;
  readonly scheduleId: TriggerId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly status?: DestinationDeliveryStatus;
}

export type DestinationDeliveryListOutcome =
  | {
      readonly kind: 'ok';
      readonly data: readonly DestinationDelivery[];
      readonly nextCursor?: Cursor;
    }
  | { readonly kind: 'not-found' };

export type DestinationDeliveryOutcome =
  | { readonly kind: 'ok'; readonly delivery: DestinationDelivery }
  /** No such destination, or it was removed. */
  | { readonly kind: 'not-found' }
  /** `redeliver`: the destination has no delivery with that id. */
  | { readonly kind: 'delivery-not-found' };

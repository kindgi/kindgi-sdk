// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EventId, Result, RunId, TenantId, TriggerId } from '@kindgi/types';

/**
 * What the trigger runtime hands to a caller-supplied `RunFlowBinding`.
 *
 * The kernel doesn't own a flow registry — resolving `flowId + flowVersion`
 * to a concrete `Flow + HandlerRegistry` is deployment-specific (packs
 * register at boot, dev consumers pass in inline maps, etc.). The binding
 * shape lets any of those wire in without the kernel choosing for them.
 */
export interface TriggerFireContext {
  readonly tenantId: TenantId;
  readonly flowId: string;
  readonly flowVersion: string;
  /**
   * Input to hand to `runGraph`. Shape is trigger-kind-specific:
   *   - cron:    `config.input ?? {}` (the caller pre-shapes at register time).
   *   - event:   the entire `Event` object — handler decides which fields
   *              it cares about.
   *   - webhook: parsed request body — the receiver route decides whether
   *              to JSON.parse or hand raw bytes to the binding.
   */
  readonly input: unknown;
  readonly source: TriggerSource;
}

/** Discriminated origin of the run spawn, useful for provenance / audit. */
export type TriggerSource =
  | { readonly kind: 'cron'; readonly triggerId: TriggerId }
  | {
      readonly kind: 'event';
      readonly triggerId: TriggerId;
      readonly eventId: EventId;
      readonly eventKind: string;
    }
  | { readonly kind: 'webhook'; readonly triggerId: TriggerId; readonly webhookId: string };

/**
 * The caller-supplied hook that turns a trigger fire into a real run. The
 * kernel calls this for every due tick, every matching event, every valid
 * webhook receive. Deployments wire it to their own flow+handler lookup
 * (packs manifest, in-process registry, etc.) and then call `runGraph`.
 */
export type RunFlowBinding = (
  ctx: TriggerFireContext,
) => Promise<Result<{ readonly runId: RunId }, TriggerBindingError>>;

/** Errors the caller-supplied binding is allowed to surface. */
export interface TriggerBindingError {
  readonly code: 'flow-not-found' | 'handler-missing' | 'run-spawn-failed';
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Union of every error the trigger runtime primitives can return. The
 * kind-specific shapes are declared below.
 */
export type TriggerError = WebhookTriggerError | CronTriggerError | EventTriggerError;

export interface WebhookTriggerError {
  readonly code:
    | 'webhook-not-found'
    | 'webhook-signature-invalid'
    | 'webhook-inactive'
    | 'webhook-flow-not-found';
  readonly message: string;
  readonly webhookId: string;
}

export interface CronTriggerError {
  readonly code: 'cron-config-invalid' | 'cron-flow-not-found';
  readonly message: string;
  readonly triggerId: TriggerId;
}

export interface EventTriggerError {
  readonly code: 'event-config-invalid' | 'event-flow-not-found';
  readonly message: string;
  readonly triggerId: TriggerId;
}

/** Trigger-kind-specific config shapes, stored as each trigger's `config`. */
export interface CronTriggerConfig {
  /** 5- or 6-field cron expression (croner-compatible). 6-field enables second precision. */
  readonly cronExpression: string;
  /** IANA timezone (e.g. 'UTC', 'America/New_York'). Defaults to 'UTC'. */
  readonly timezone?: string;
  /** Static input handed to the flow on every fire. Absent → `{}`. */
  readonly input?: unknown;
}

export interface EventTriggerConfig {
  /** Event type filter (matched against `event.type`). */
  readonly eventKind: string;
  /**
   * Optional input override. When absent, the entire `Event` object is
   * passed as the flow input.
   */
  readonly input?: unknown;
}

export interface WebhookTriggerConfig {
  /**
   * Optional input override. When absent, the parsed request body (as
   * passed to `fireByWebhookId`) is used as the flow input.
   */
  readonly input?: unknown;
}

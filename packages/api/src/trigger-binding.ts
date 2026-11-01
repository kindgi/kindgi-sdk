// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Trigger registry — API-layer view of the runtime-owned CRUD contract.
 *
 * The interface lives in `@kindgi/runtime` (public wire vocabulary);
 * the Kindgi runtime provides an implementation. The API layer
 * re-exports the contract here for parity with the other caller-plugged
 * bindings (`AdapterRegistryBinding`, `ProviderRegistryBinding`, etc.) —
 * routes import from this file, deployments plug in a satisfying impl
 * (their own, if they want bespoke persistence).
 */

export type {
  CronTriggerDefinition,
  CronTriggerRecord,
  CronTriggerVersionRecord,
  EventTriggerDefinition,
  EventTriggerRecord,
  EventTriggerVersionRecord,
  FireWebhookInput,
  FoundWebhookTrigger,
  GetTriggerInput,
  GetTriggerVersionInput,
  ListTriggerFiresInput,
  ListTriggersInput,
  ListTriggerVersionsInput,
  MailTriggerDefinition,
  MailTriggerConfig,
  MailTriggerMailbox,
  MailTriggerRecord,
  MailTriggerTarget,
  MailTriggerVersionRecord,
  RegisterCronTriggerInput,
  RegisterEventTriggerInput,
  RegisterMailTriggerInput,
  RegisterTriggerError,
  RegisterTriggerInput,
  RegisterWebhookTriggerInput,
  ScheduleCatchUp,
  ScheduleOverlap,
  TriggerFire,
  TriggerFirePage,
  TriggerKind,
  TriggerLifecycleError,
  TriggerLifecycleInput,
  TriggerListPage,
  TriggerRecord,
  TriggerOwner,
  TriggerRegistryBinding,
  TriggerTarget,
  TriggerVersionCause,
  TriggerVersionPage,
  TriggerVersionRecord,
  UpdateCronTriggerInput,
  UpdateEventTriggerInput,
  UpdateMailTriggerInput,
  UpdateTriggerError,
  UpdateTriggerInput,
  UpdateWebhookTriggerInput,
  WebhookFire,
  WebhookRefusalInput,
  WebhookRefusalReason,
  WebhookTriggerDefinition,
  WebhookTriggerRecord,
  WebhookTriggerVersionRecord,
} from '@kindgi/runtime';
export {
  DEFAULT_WEBHOOK_SIGNATURE,
  MAIL_TRIGGER_LIMITS,
  SCHEDULE_DEFAULTS,
  TRIGGER_KINDS,
  TRIGGER_VERSION_CAUSES,
  WEBHOOK_BODY_LIMITS,
  WEBHOOK_RATE_LIMITS,
  WEBHOOK_REFUSALS_RECORDED_PER_MINUTE,
} from '@kindgi/runtime';

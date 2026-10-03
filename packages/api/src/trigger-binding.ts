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
  CronTriggerRecord,
  EventTriggerRecord,
  GetTriggerInput,
  ListTriggersInput,
  RegisterCronTriggerInput,
  RegisterEventTriggerInput,
  RegisterTriggerError,
  RegisterTriggerInput,
  RegisterWebhookTriggerInput,
  TriggerKind,
  TriggerLifecycleError,
  TriggerLifecycleInput,
  TriggerListPage,
  TriggerRecord,
  TriggerRegistryBinding,
  UpdateCronTriggerInput,
  UpdateEventTriggerInput,
  UpdateTriggerError,
  UpdateTriggerInput,
  UpdateWebhookTriggerInput,
  WebhookTriggerRecord,
} from '@kindgi/runtime';
export { TRIGGER_KINDS } from '@kindgi/runtime';

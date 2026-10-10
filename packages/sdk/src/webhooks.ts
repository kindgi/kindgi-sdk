// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/sdk/webhooks` — receiving Kindgi's webhooks. Server only: it
 * uses `node:crypto`, so it stays out of `/client` (browser-safe) and the
 * flat barrel.
 *
 * Re-exports the Standard Webhooks helpers from `@kindgi/crypto`:
 * `verifyWebhook` for a receiver, `generateWebhookSecret` for the secret an
 * app registers by name, and `signWebhook` / `webhookHeaders` to test a
 * receiver. `parseEvent` reads the typed event from a verified body
 * (`WebhookEvent`; a run's id is a `RunId`, for `client.runs.get`).
 *
 * @module @kindgi/sdk/webhooks
 */

export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  generateWebhookSecret,
  isStrongWebhookSecret,
  signWebhook,
  verifyWebhook,
  WEBHOOK_HEADERS,
  WEBHOOK_SECRET_MIN_BYTES,
  WEBHOOK_SECRET_PREFIX,
  webhookHeaders,
} from '@kindgi/crypto';
export type {
  SignWebhookInput,
  VerifyWebhookFailure,
  VerifyWebhookInput,
  VerifyWebhookResult,
  WebhookRequestHeaders,
} from '@kindgi/crypto';
export type {
  ApprovalRequestedEvent,
  FinishedRun,
  ImprovementPassFinishedEvent,
  RequestedApproval,
  RunFinishedEvent,
  WebhookEvent,
  WebhookTestEvent,
} from '@kindgi/client';
export {
  type ParseWebhookEventFailure,
  type ParseWebhookEventResult,
  parseEvent,
} from './webhook-events.js';

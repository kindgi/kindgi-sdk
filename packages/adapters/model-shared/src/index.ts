// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Shared plumbing for Kindgi's model adapters, in Kindgi's terms. The engine that sends the
 * requests (today the AI SDK's provider packages) is behind `@kindgi/adapter-model-shared/ai-sdk`.
 */
export {
  type FailedResponse,
  ModelProviderError,
  type ModelProviderErrorKind,
  kindOf,
  modelProviderError,
} from './errors.js';
export { backoffMs, type RetryPolicy, type RetryableFailure, withRetries } from './retries.js';
